# vcsNode 运维手册

> 版本：2026-10-26 · 状态：**骨架**，随实现进度补齐
>
> 标 `【待实现】` 的部分依赖尚未编写的代码；标 `【待确认】` 的依赖现场信息。
> 设计依据见 `docs/architecture.md`，接口见 `docs/protocol.md`。

---

## 1. 适用范围

四台机器：

| 机器 | 角色 | 跑什么 |
| --- | --- | --- |
| `172.16.2.98` | 主节点 + 同步源 | `vcs-master`（含本机 agent）+ 全套业务组件 |
| `172.16.1.207` | 成员 | `vcs-agent` + web / webapi |
| `172.16.1.145` | 成员 | `vcs-agent` + generateclient / generatetool / tools |
| `172.16.1.149` | 成员 | `vcs-agent` + 全套业务组件 |

> 业务组件本身的安装（.NET 运行时、Python、`.venv`、UE/QGIS）不在本手册范围内，
> 沿用现有《试运行运维交接手册》。

---

## 2. 部署前检查

在任何机器上装 agent 之前，先过一遍这张表。**任一项不通过就先解决，不要往下走。**

| # | 检查 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 成员能出站连 98:47821 | `Test-NetConnection 172.16.2.98 -Port 47821` | `TcpTestSucceeded: True` |
| 2 | 成员能读共享 | `powershell -File tools\smb-probe.ps1` | `RESULT: OK` |
| 3 | Node 已安装且 ≥ 18 | `node -v` | `v18.x` 或更高（207 现在是 v18，其余 v20+，都以 18 为基线） |
| 4 | 业务目录存在 | `Test-Path D:\SceneAutomationV3` | `True` |
| 5 | 时间与 98 一致 | `w32tm /stripchart /computer:172.16.2.98 /samples:1` | 偏差 < 60s |
| 6 | 445 已放行（跨网段） | 见第 2 项 | 同上 |

`tools\smb-probe.ps1` 的各项含义：

```
[OK]   tcp 445 open                    跨网段 445 已放行
[OK]   share reachable                \\172.16.2.98\... 可达
[WARN] sub dir does not exist yet     _vcs 尚未创建（首次部署正常）
[OK]   read xxx in 0.4s = 3.0 MB/s    真实吞吐，首次全量传输按这个估时间
[WARN] running as LocalSystem         agent 用机器账号访问 SMB，大概率被拒
```

---

## 3. 目录规划

```
98:  D:\SceneAutomationV3\            业务部署根
     D:\SceneAutomationV3\Tools\      ← 共享出去（`\\172.16.2.98\Tools`），作为分发源
     D:\SceneAutomationV3\_config\    各组件本机配置（不参与同步）
     D:\SceneAutomationV3\releases\   版本目录，junction 指向
     C:\vcsNode\                      vcsNode 自身
       ├── bin\ config\ src\ ui\
       └── state\ logs\

成员: <该机的部署根>\                 结构同上，**盘符/路径各机不同**
     C:\vcsNode\
```

`releases\` 与业务目录的关系：

```
<部署根>\webapi          → junction →  releases\webapi\vcs-20261026-01
<部署根>\GenerateClient  → junction →  releases\generateclient\vcs-20261026-01
```

用 junction（`mklink /J`），**不要用符号链接**（需要管理员权限或开发者模式）。

> ⚠ **四台布局不统一**（已确认）：
>
> | 机器 | Tools 目录 |
> | --- | --- |
> | 98 | `D:\SceneAutomationV3\Tools`（推断，待本机 agent 核对） |
> | 207 | **`D:\Digihail\SceneAutoApply\Tools`** |
> | 145 | `D:\SceneAutomationV3\Tools` |
> | 149 | `D:\SceneAutomationV3\Tools` |
>
> 各组件子目录（web / webapi / GenerateClient / GenerateTool）未逐台核实 ——
> 第 1 步采样会输出每个进程的 cwd 与可执行路径，用真实值回填即可。
> 填错的表现是「配置保存成功，但那台机器上什么都没发生」。

---

## 4. 共享与账号准备（在 98 上做一次）

| 步骤 | 操作 | 说明 |
| --- | --- | --- |
| 1 | 建两个本地账号：`vcsnode-ro`、`vcsnode-rw` | ro 给成员，rw 给 98 |
| 2 | 共享 `Tools`，授予 `vcsnode-ro` 读取、`vcsnode-rw` 完全控制 | 共享名已确认是 `Tools`（`\\172.16.2.98\Tools`） |
| 3 | NTFS 权限同步收紧 | 共享权限与 NTFS 权限都要收，只改一个没用 |
| 4 | 确认成员不能写 | 在成员上跑 `smb-probe.ps1 -TestWrite`，应输出 `write denied as expected` |

> 现状（2026-10-26，207 实测）：98 的共享对**本地账号**（`DESKTOP-AUN3GPT\digihail`，
> 非域账号）即可读取，说明共享对 Everyone / 匿名开放；此前也实测过可写。
>
> 读开放可以接受（现场方便），但**写必须收紧**，否则任何一台机器都能往分发源里塞文件。
> 收紧时注意：成员 agent 若以 LocalSystem 运行，用的是机器账号 `COMPUTERNAME$`，
> 收紧后可能立刻读不到 —— 先确认 agent 运行身份（`architecture.md` §7 待定 #9）。

> 现状：实测该共享当前可写且权限过宽。**这一步不做，「一键同步」就等于给四台机器开了互通写权限。**

---

## 5. 安装主节点（98）

```powershell
# 1. 拷贝 vcsNode 到 C:\vcsNode
# 2. 填配置
notepad C:\vcsNode\config\vcsnode.yaml      # cluster.secret 换成随机长串

# 3. 生成密钥（两个地方要一致）
#    - 98:  config\vcsnode.yaml  → cluster.secret
#    - 成员: agent.bootstrap.json → secret

# 4. 启动（前台，先看日志）
node C:\vcsNode\bin\master.mjs

# 5. 打开界面
#    http://172.16.2.98:47821/
```

【待实现】`bin/master.mjs` 与界面。

检查：

```powershell
Get-NetTCPConnection -LocalPort 47821 -State Listen
(Invoke-WebRequest http://172.16.2.98:47821/healthz).StatusCode   # 期望 200
```

---

## 6. 安装成员 agent（207 / 145 / 149）

每台机器做同样的事，只有 `nodeId` 不同。

### 6.1 agent 只需要 8 个程序文件

M0 的 agent 是纯只读的，**不需要整目录**。M1 加了启停（`src\proc.mjs`），
M2 加了「更新文件」（`src\sync.mjs`），再加上事件流水及 Windows .NET 启动桥，程序部分一共 8 个文件：

```
C:\vcsNode\
  bin\agent.mjs          27.5 KB   ← SSE 常驻 + 采样上报 + 执行启停 / 更新文件
  src\probe.mjs          17.4 KB   ← 读进程表 / 端口 / 连接，按 identify 认进程
  src\proc.mjs           14.6 KB   ← 认真实 pid、taskkill /T /F、start（cwd + 日志 + 等就绪）、重启
  src\win-console.mjs                ← Windows dotnet 隐藏控制台启动桥
  src\event-log.mjs                  ← 本机事件 / 启停流水
  src\sync.mjs            8.3 KB   ← M2：按 manifest 备份 + 校验 sha256 + 就地覆盖/删除
  src\agent-auth.mjs      4.1 KB   ← HMAC 签名（与主节点同一份实现）
  src\state.mjs           1.1 KB   ← 原子写 JSON
  agent.bootstrap.json              ← 本机唯一需要手写的文件
  state\                            ← 运行时自动建（node-config.json / agent.json）
  logs\                             ← 服务的 stdout/stderr（<组件>.log）
  backup\                           ← 更新文件前备份的旧文件（<relId>\<组件>\<相对路径>）
```

**文件必须照放**（`agent.mjs` 顶部就 import 了 `proc.mjs` 和 `sync.mjs`，缺了直接起不来）。
想保持只读就把 `agent.bootstrap.json` 里的 `allowControl` 去掉或写 `false` ——
那样任何 task 一律回 `nack control_disabled`，一个进程都不会动、一个文件都不会写。

**不要往成员上放**：`config\vcsnode.yaml`（配置只在 98 上有一份）、`ui\`、
`bin\master.mjs`、`bin\scan.mjs`、`src\scan.mjs`、`src\ignore.mjs`、`src\config-edit.mjs`、
`src\release.mjs`（同步包只在 98 上做）。
成员不需要 YAML 解析器，也不需要打包逻辑 —— 组件定义由主节点在 `hello` 里下发（协议 §3.3），
文件清单由共享上的 `manifest.json` 给（协议 §4.2）。

从 98 拉取（98 上把 vcsNode 放到 `\\172.16.2.98\Tools\_vcs\dist\vcsNode\`）。
**只拷这 8 个程序文件**，别整目录拷 —— 否则 `ui\`、`bin\master.mjs` 也会落到成员上：

```powershell
robocopy \\172.16.2.98\Tools\_vcs\dist\vcsNode C:\vcsNode `
  bin\agent.mjs src\probe.mjs src\proc.mjs src\sync.mjs src\agent-auth.mjs src\state.mjs src\event-log.mjs src\win-console.mjs `
  /R:2 /W:2
```

升级老 agent 也是这一条命令（覆盖同名文件即可，`state\` 里的缓存不用清）。

```powershell
# 1. 写引导配置（这一份永不被主节点覆盖）
copy C:\vcsNode\config\agent.bootstrap.example.json C:\vcsNode\agent.bootstrap.json
notepad C:\vcsNode\agent.bootstrap.json
#   master       : "172.16.2.98:47821"
#   nodeId       : "node-145"        ← 每台不同
#   secret       : 与主节点 cluster.secret 一致
#   cacheDir     : "C:\\vcsNode\\state"
#   allowControl : true              ← 不加就是只读，启停与更新文件一律 nack
#   logDir       : "C:\\vcsNode\\logs"     ← 可选，默认是 cacheDir 的上一级 + logs
#   backupDir    : "C:\\vcsNode\\backup"   ← 可选，更新文件前的旧文件备份
```

> `agent.bootstrap.json` 用记事本另存成「UTF-8 带 BOM」也能用（agent 会先去掉 BOM）；
> 但不要加注释、不要留结尾逗号，解析失败会直接报出是哪一行不合法。

### 6.2 先跑 `--inventory`（不需要主节点）

第一次上机先看清单，这是填配置页 `localRoot` / `port` 的事实来源：

```powershell
node C:\vcsNode\bin\agent.mjs --inventory
node C:\vcsNode\bin\agent.mjs --inventory --filter dotnet
node C:\vcsNode\bin\agent.mjs --inventory --json > C:\vcsNode\logs\inventory.json
```

输出三段：进程（名字 / pid / 启动时间 / 可执行文件 / **命令行**）、监听端口（谁在听）、
ESTABLISHED（按远端地址归并）。**认进程靠命令行，不靠进程名** ——
一台机器上十几个 `dotnet.exe`，只看名字必然杀错。

> 非管理员也能跑，但读不到别的用户的 `CommandLine`；那种情况下组件会显示
> `matchBy=port`（靠端口认）或直接「未观测」。要完整信息就用 `vcsnode` 账号跑。

### 6.3 前台试跑

```powershell
node C:\vcsNode\bin\agent.mjs                 # 常驻
node C:\vcsNode\bin\agent.mjs --once          # 采样一次，打印 JSON 就退出
chcp 65001                                    # 中文乱码时先切 UTF-8 代码页
```

正常输出：

```
10:12:05 [agent] vcsNode agent 0.1.4-m2  node=node-149  master=172.16.2.98:47821  pid=5320
10:12:05 [agent] 采样间隔 10000ms · 心跳 30000ms · 缓存 C:\vcsNode\state
10:12:05 [agent] 服务日志 C:\vcsNode\logs\<组件>.log
10:12:05 [agent] 旧文件备份 C:\vcsNode\backup\<relId>\<组件>\<相对路径>
10:12:05 [agent] 控制模式：可执行启停与更新文件（allowControl: true）
10:12:05 [agent] 连接 172.16.2.98:47821 since=0
10:12:06 [agent] 已连接 172.16.2.98:47821 node=node-149 configRevision=0
10:12:07 [agent] 配置 rev=0 组件 9 个：web, webapi, generateclient, ...
10:12:08 [agent] 上报 · web —→stopped · shp_plants —→running · webapi —→orphan ...
```

日志一律写 stderr，stdout 只留给 `--once` 的 JSON（可以安全地 `> out.json`）。

异常对照：

| 输出 | 原因 | 处置 |
| --- | --- | --- |
| `ECONNREFUSED` / `connect ECONNREFUSED` | 98 未启动或端口不通 | 查第 2 节第 1 项 |
| `SSE 握手失败 HTTP 401 bad_signature` | secret / nodeId 不一致 | 对齐两侧配置 |
| `SSE 握手失败 HTTP 401 clock_skew` | 时钟偏差 > 5 分钟 | 校时 |
| `SSE 握手失败 HTTP 426 proto_mismatch` | 版本不一致 | 升级 agent |
| `SSE 握手失败 HTTP 403 not_configured` | `config/vcsnode.yaml` 里没有这个节点 | 先在配置页加节点 |
| `读取进程清单失败` | PowerShell 被策略限制 | 放开 `Get-CimInstance` / `Get-NetTCPConnection`，或退回 netstat 兜底 |
| `缓存配置 ... 组件 0 个` | 该节点在配置里一个组件都没启用 | 查配置页 |

### 6.4 只读验收（M0）

```powershell
# 98 上
curl http://127.0.0.1:47821/api/ui/nodes
```

判据：

1. 页面右上角出现 `节点数据 · 实时`（不是「演示」）
2. 节点卡片里该机器 `在线`，且有 `运行 / 异常 / 已停` 计数
3. 给它点开任意组件，PID 与 `--inventory` 里看到的一致
4. **故意停掉 agent**（Ctrl-C），5 秒内页面变成 `离线`
5. 页面上**没有**任何动作能真正执行 —— 只读模式（没写 `allowControl: true`）下点停止会报
   `control_disabled`，不会动进程；要能停见 §6.5

第 3 条是 M0 唯一真正重要的验收：**认对了进程**。
如果某个组件显示 `未观测` / `orphan`，先看 `notes` 里写的原因，
通常是 `localRoot` 写错、端口配错、或者进程确实没起。

### 6.5 启停验收（M1）

先确认 `agent.bootstrap.json` 里有 `"allowControl": true`，重启 agent，日志里应出现：

```
控制模式：可执行启停与更新文件（allowControl: true）
服务日志 C:\vcsNode\logs\<组件>.log
旧文件备份 C:\vcsNode\backup\<relId>\<组件>\<相对路径>
```

**选一个不影响业务的组件**（149 上建议 `shp_buildings`，4001 端口，只有人手工点按钮时才用），
按顺序：

1. 页面上点该组件格子 → 抽屉 → **停止** → 再点一次「再点一次确认停止」
2. 预期：按钮变「停止中…」，几秒后 toast 报 `已停止 …（pid 1234 · 4.2s · 端口已释放）`
3. **立刻**看矩阵：格子变「已停止」，PID 变 `—`，端口不再监听（不用等 5 秒轮询）
4. 事件页应有三条：`task stop <组件>` → `ack` → `state running→stopped`
5. 命令行复核（在该机器上）：

```powershell
Get-NetTCPConnection -LocalPort 4001 -State Listen    # 应该没有输出
Get-Process -Id <刚才的 pid>                          # 应该报「找不到」
```

6. 再点一次停止 → 应报 `not_running`（没找到进程），**不是**报成功
7. 点 **启动**（一下就发）→ toast 报 `已启动 …（pid 5678 · 4.5s · 端口在监听）`，
   矩阵变「运行中」，`logs\shp_buildings.log` 里能看到服务的启动输出
8. 再点一次启动 → 报「本来就在跑（pid 5678），没有重复启动」，pid 不变
9. 点 **重启** → 再点一次确认 → 预期 `pid` **变了**，旧进程没了，新进程在监听；
   重启过程中矩阵会短暂显示「已停止」，这是真的（成员在如实上报）
10. 服务日志：该组件自己的 stdout/stderr 在 `C:\vcsNode\logs\<组件>.log`（bootstrap 里
    `logDir` 可改）。agent 重启不会带走业务进程 —— 进程是 detached 的。

反面用例（都要**拒绝**，不能动手）：

| 操作 | 预期 |
| --- | --- |
| 启停 98 那一列 | 按钮是灰的；直接调接口也是 `manual_node` |
| 停一个端口被别的程序占着的组件 | `not_ours`，并写明占用者 `名称 pid` |
| 停一个端口配错（指到同机另一个组件）的组件 | `identify_mismatch`，并打印对方的命令行 |
| 停一个本来就没在跑的组件 | `not_running` |
| 启动一个 `localRoot` 写错 / 目录不存在的组件 | `bad_cwd`，不会在别处乱起 |
| 启动一个端口已被占用（孤儿端口）的组件 | `port_busy` |
| 启动一个配置里没有 `start.cmd` 的组件 | 主节点直接 `400 no_start` |
| 启动后进程立刻退出（dll 不存在、配置错） | `exited`，`message` 里带日志尾巴 |
| agent 里没写 `allowControl` | `control_disabled` |
| agent 没连上 | `node_offline`（不会排队等着） |

> **149 上先修一个配置错误再试点**：`nodes.172.16.1.149.components.webapi.port` 现在是 `7080`，
> 而 7080 是同一台上 `mcpserver` 的端口。停 `webapi` 时会命中 `identify_mismatch`（不会误杀），
> 但这说明配置本身是错的 —— `generate*` / `workerhost` 的 health、`web` 的 `VITE_API_TARGET`
> 全都指向 3601，所以这里应该改回 **3601**（配置页改，保存后成员自动收到 hello）。

### 6.6 更新文件验收（M2）

三个前置，缺一个就别往下走：

| 前置 | 怎么确认 | 不满足会怎样 |
| --- | --- | --- |
| 成员能读共享 | 在成员上用 agent 账号 `dir \\172.16.2.98\Tools\_vcs\releases` | 成员 `nack manifest_missing`，记录 `partial` |
| **`sources.<组件>` = 98 实际运行目录** | 和 98 那列的 `localRoot` 逐字比对 | 409 `layout_mismatch`，一个文件都不发 |
| 目标组件已停止 | 矩阵里是「已停止」 | 409 `not_stopped` |

> **扫描源 = 98 实际运行目录（2026-10-28 已对齐）**：六个 dotnet/web 组件的 `sources` 已从源码目录
> 改到 98 的 build 产物（`E:\SceneAutomationBuild\…`、`E:\nginx\html\dist`），和 98 的 `localRoot`
> 逐字相同，所以 10 个组件里 9 个都能就地同步（`aigenerate` 没配 `sources`，不参与扫描）。
>
> **改完 `sources` 必须重建一次基线**：`node C:\vcsNode\bin\scan.mjs --init-baseline`。
> 不重建的话，第一次扫描会把整份产物当「新增」，待同步区会冒出几千个文件。
> 基线重建后第一次扫描也会慢一些（全量 sha256 一遍产物目录）。

试点步骤（149 + `shp_buildings`，4001 端口）：

1. 抽屉里**停止** `shp_buildings`，等矩阵变「已停止」
2. 98 上改一处文件 —— 拿 `D:\SceneAutomationV3\Tools\ShapefileTool.Buildings.20230905\` 里
   任意一个文件加一行注释最省事
3. 页面 → 待同步区 → **重新扫描** → 看到这个文件 → 勾上 → 勾「本次不含数据库结构变更」→ **预同步**
4. 预期 toast：`更新完成：1 个文件 · 12 B · 1/1 台已落地（0.1s），可以启动了`
5. 成员上复核：

```powershell
Get-Content D:\SceneAutomationV3\Tools\ShapefileTool.Buildings.20230905\<改的文件> | Select-String 你的注释
Get-ChildItem C:\vcsNode\backup\<relId>\ -Recurse | Select-Object FullName    # 旧文件在
Get-ChildItem D:\SceneAutomationV3\Tools\ShapefileTool.Buildings.20230905\ -Recurse |
  Where-Object LastWriteTime -gt (Get-Date).AddHours(-1)                      # 只该有改过的那个
```

6. 抽屉里**启动** → 矩阵变「运行中」，业务功能点一下确认没坏
7. 同步记录页多一条 → 详情：三个时间点分开显示（98 改于 / 落地 / 发起 + 用时）+ 逐文件 sha256

反面用例（都要**拒绝**或明确失败，不能悄悄改一半）：

| 操作 | 预期 |
| --- | --- |
| 组件还在跑就点预同步 | `409 not_stopped`，文件不动 |
| `sources` 和 98 的 `localRoot` 不一致 | `409 layout_mismatch`，连共享都不写 |
| 有目标机离线 | `409 node_offline`，一台都不发（不允许半套） |
| 只勾删除项、没勾「我已确认删除项」 | `400 empty_selection` |
| 共享没挂上 / 没读权限 | 成员 `nack manifest_missing` → 记录 `partial`，待同步区保留 |
| 共享上的 blob 被改过 | 成员 `sha_mismatch`，**不落地**，目标文件保持原样 |
| 落地时文件被占用（服务又被起起来了） | `partial`，已落地的保留，重发会重写（幂等） |

回退：把 `C:\vcsNode\backup\<relId>\<组件>\<相对路径>` 拷回 `localRoot` 下的同一位置
（删除项同理，就是拷回去），再按 §9.2 启停。备份**不会自动清理** —— 确认没问题后手工删掉旧的
`relId` 目录，或者等运维按容量统一清。

---

## 7. 注册自启

不自启的话，机器断电重启后要人肉登录才能恢复 —— 集中管理名存实亡。

### 7.1 运行账号（先定这个，再选自启方式）

agent 这个账号要同时满足两件事：

| 要求 | 原因 | 不满足的后果 |
| --- | --- | --- |
| **不是 LocalSystem / 不是 SYSTEM** | 那两个身份访问 SMB 用的是机器账号 `COMPUTERNAME$` | 「命令行能读，服务读不到」 |
| **本地管理员组成员** | 阶段一要 `taskkill` 掉**别人启动的**业务进程 | `taskkill` 报拒绝访问，停不掉 |

> 第二条容易漏。阶段一是「认领现有人工启动的进程」，那些进程可能是用别的管理员账号
> 或直接在桌面上起的。普通账号对它们没有 `PROCESS_TERMINATE` 权限。
>
> 建议：建一个本地账号 `vcsnode`，加入 `Administrators`，用它跑 agent。
> 共享当前对 Everyone 开放，所以它能直接读；将来收紧为专用 `-ro` 账号时，
> 再给 `vcsnode` 授权（或用 `cmdkey` 存凭据）。

### 7.2 自启方式

**现场无外网，所以优先用系统自带的能力，不引入额外 exe。**

#### 方案 A：计划任务（推荐，零外部文件）

```powershell
schtasks /Create /TN vcsNodeAgent /SC ONSTART /DELAY 0000:30 ^
  /RU ".\vcsnode" /RP "密码" /RL HIGHEST ^
  /TR "\"C:\Program Files\nodejs\node.exe\" C:\vcsNode\bin\agent.mjs"
```

- `/SC ONSTART`：开机即起，不等人登录
- `/DELAY 0000:30`：等网络栈和 98 就绪，避免开局连不上就退避
- `/RL HIGHEST`：以最高权限运行（配合 7.1 的管理员组）
- `/RU` **必须**是能访问共享、能杀进程的账号；`SYSTEM` 不行

验证：

```powershell
schtasks /Run /TN vcsNodeAgent
schtasks /Query /TN vcsNodeAgent /V /FO LIST | Select-String "Status|Last Result"
```

#### 方案 B：NSSM（需要额外带一个 exe）

如果现场允许带 `nssm.exe`（单文件，约 300KB，拷过去即可），服务形态更规整：

```powershell
nssm install vcsNodeAgent "C:\Program Files\nodejs\node.exe" "C:\vcsNode\bin\agent.mjs"
nssm set vcsNodeAgent AppDirectory C:\vcsNode
nssm set vcsNodeAgent Start SERVICE_AUTO_START
nssm set vcsNodeAgent ObjectName ".\vcsnode" "密码"
nssm start vcsNodeAgent
```

#### 不能用 `sc create` 直接跑 node

```powershell
# ✗ 会报 1053「服务没有及时响应启动或控制请求」
sc create vcsNodeAgent binPath= "C:\Program Files\nodejs\node.exe C:\vcsNode\bin\agent.mjs"
```

`node.exe` 不是 Windows 服务程序，不会向 SCM 报告 `SERVICE_STATUS`。
要绕开，就得再引入一个 wrapper（NSSM 或 WinSW），等于又多了个外部依赖。

### 7.3 vcsNode 自身怎么升级 / 回滚

**不做自升级** —— agent 升级自己会把自己杀掉，中间失败就没有人能救它。

手工三步，停机约 30 秒：

```powershell
# 1. 停服务（业务进程不受影响，见 12 节）
schtasks /End /TN vcsNodeAgent

# 2. 覆盖程序，但保留配置与状态
#    master(98)：bin\ src\ ui\ tools\
#    agent(成员)：只覆盖 §6.1 那 8 个程序文件（整目录拷会把 master 的代码带上去）
#    不能动：config\  state\  logs\  backup\
robocopy C:\vcsNode-new C:\vcsNode /E /XD config state logs backup

# 3. 起服务
schtasks /Run /TN vcsNodeAgent
```

回滚：升级前把 `bin\ src\ ui\` 复制成 `bin.old\` 等，出问题换回来再启动。

> 升级顺序：**先全部 agent，再 master**。反过来的话，新 master 可能下发旧 agent
> 看不懂的字段 —— 虽然协议要求两端忽略未知字段，但版本落后的那一端会缺功能。

---

## 8. 首次接入验收

在 98 界面上逐台确认：

| 检查 | 期望 |
| --- | --- |
| 四台都显示在线 | 连接状态绿 |
| 每台的组件数与自己认知一致 | 98：9；149：9；207：3（web/webapi/mcpserver）；145：6（含 shp_*） |
| 组件状态与实际一致 | 现场开着窗口的组件应为 `running` |
| 点击「探测」，全部通过 | 路径、共享、`.venv`、端口 |
| 手动停一个不重要的组件，再启动 | 一个采样周期内（默认 10s）状态跟上 |
| 断开 207 的网线 10s | 45s 内变 `node-offline`（主节点靠「有没有上报」判，不靠 socket） |

**验收不通过就不要进第 4 步（同步）。** 状态都看不准，同步更不可控。

---

## 9. 日常操作

### 9.1 看状态

界面首页。右上角两个徽标要看清楚：

- `节点数据 · 实时` = 正在从各机 agent 取实时状态；`演示` = 没连上主节点接口（或主节点没起来）
- `实时数据` / `未扫描` = **变更清单**的状态，与节点状态无关，别混

命令行等价：

```powershell
curl http://127.0.0.1:47821/api/ui/nodes      # 界面上的节点卡片 + 组件矩阵
curl http://127.0.0.1:47821/api/ui/pending    # 变更清单
```

状态含义与处置（**结论由主节点算，成员只报观测**）：

| 状态 | 含义 | 该做什么 |
| --- | --- | --- |
| `running` | 进程在，探活通过（无探活的组件=进程在） | 无 |
| `degraded` | 进程在，但探活没过（连不上 webapi / 端口没监听） | 重启该客户端；查 `SignalRUrl` 是否指向**别的机器** |
| `stopped` | 配置里该有它，但进程不在 | 确认是不是有人手动停了；M1 起可以一键启动 |
| `orphan` | 进程不在但端口被**别人的**进程占着 | 查 `portOwner` 里的 pid，别急着重启 |
| `unknown` | `localRoot` 不存在 / 还没收到观测 / 观测过期 | 先修配置页路径，或看 agent 日志 |
| `offline` | 整台机器 45s 没上报 | 先查网络/机器/agent 进程，不是查业务服务 |

`crashed` 目前不会出现：它需要「期望运行」这个状态，M1 才有启停/期望态的概念。
现在「配置里 enabled 但没在跑」如实显示 `stopped`，不猜。

### 9.2 启停单个组件

界面上：点组件格子 → 抽屉 → **启动 / 停止 / 重启**。停止和重启用两段式确认（第一下只是上膛，
6 秒内再点才下发）；启动一下就发。一次只能跑一条指令，成员正忙时回 `busy`。

- 启动成功 = 进程被 `identify` 认出来 **且** 端口在监听（配了端口的组件）。
- 还在跑的时候点启动 → 「本来就在跑」，不会起第二个。
- 重启 = 先停再起；停不下来就不起（避免两个实例抢端口）。
- 服务自己的输出在成员上 `<logDir>\<组件>.log`（默认 `C:\vcsNode\logs`）。

命令行等价（本机调试用，`--once` 之外没有独立的 ctl 工具）：

```powershell
# 在主节点上直接调接口（PowerShell 5.1）
Invoke-RestMethod -Method Post http://172.16.2.98:47821/api/ui/task `
  -ContentType 'application/json' -Body '{"node":"149","component":"webapi","action":"restart"}'
```

**手动应急**（没有 vcsNode 时）：

```powershell
# 查 PID（按命令行匹配，不要按进程名）
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*SceneAutoApply.dll*' } |
  Select-Object ProcessId, CreationDate

# 停（/T 不可省，否则留下 python 子进程继续写 Task.json）
taskkill /PID <pid> /T /F

# 起：工作目录必须是同步目录（dotnet .\X.dll 按 cwd 读 appsettings.json）
Set-Location D:\SceneAutomationWorker\Releases\main-test\webapi
dotnet .\SceneAutoApply.dll
```

### 9.3 扫描（变更清单，只读）

界面上点「待同步区 → 重新扫描」，等价于：

```powershell
node C:\vcsNode\bin\scan.mjs            # 比对基线，写 state\pending.json
node C:\vcsNode\bin\scan.mjs --list     # 顺带把变动的文件打到屏幕上
node C:\vcsNode\bin\scan.mjs --json     # 只输出 JSON，给脚本用
```

第一次运行会自动建基线：把当前状态记成起点，清单为空。
**这一步只读 —— 不传文件、不碰进程、不写共享。**

重建基线（把「现在」认作新起点）：

```powershell
node C:\vcsNode\bin\scan.mjs --init-baseline
```

重建之后清单会变空，已同步的差异就此「认账」。慎用。
耗时：一万个文件约几十秒（每次都全量 sha256）。扫描期间被占用的文件记一条失败，
不影响其余文件。

**什么时候必须重建**：改了 `sources`（扫描根）或 `include` / `exclude`（纳管范围）之后。
否则新纳入范围内的文件全都会被算成「新增」，清单会一次冒出几千条，而且原来那些
「删除了」的条目其实是换根造成的假差异。重建之后再改真文件，清单才是可信的。

开发机上没有 `D:\SceneAutomationV3` / `E:\SceneAutomationBuild` / `E:\nginx` 时，用假目录把全流程跑通
（`--remap` 可以重复给，按前缀替换）：

```powershell
node bin\master.mjs --port 47830 `
  --remap "D:\SceneAutomationV3=E:\tmp\deploy" `
  --remap "E:\SceneAutomationBuild=E:\tmp\build" `
  --remap "E:\nginx\html\dist=E:\tmp\webdist" `
  --state E:\tmp\state
```

### 9.4 发一次版（M2：停 → 更新文件 → 起）

M2 只做「把改后的文件覆盖到成员」，不自动停/起（那是 M3 的「切换上线」）。
所以一次同步是手工三段，每段都能单独确认：

```
1. 98 上改东西（就地改 98 正在用的目录，不要再手工拷到别的机器）
2. 界面 → 待同步区 → 重新扫描
     结果按组件汇总 + 文件级明细（路径、sha256、大小、归因组件）
3. 勾选要发的文件
     · 默认只勾新增/修改，删除项要单独勾 + 勾「我已确认 N 个删除项」
     · 勾「本次不含数据库结构变更」（vcsNode 不执行建表，必须人工确认）
     · 右侧「目标节点」按需取消勾选 —— 只发一台是允许的，见 §9.4.1
4. 先停止目标组件（组件抽屉 → 停止 → 再点一次确认）
     · 不停也能点，但服务端会 409 not_stopped —— 对着正在跑的服务覆盖 dll 只会得到半新半旧
5. 待同步区 → 预同步
     · 98 把勾选的文件复制到 \\172.16.2.98\Tools\_vcs\releases\<relId>\ 并写 manifest.json
     · 只发给勾选的目标机：它们从共享只读拉取 → 备份旧文件到 D:\vcsNode\backup\<relId>\ → 校验 sha256 → 就地覆盖
     · 全部勾选的机器都成功：提示里写「N/N 台已落地」
     · 有任何一台失败：记录标 partial，待同步区原样保留，修好重发（幂等）
     · 文件从待同步区消失的条件是**所有声明了该组件的节点**都落地了这份内容（见 §9.4.1）
6. 组件抽屉 → 启动 → 矩阵变「运行中」
7. 同步记录 → 详情：逐文件明细 + 三个时间点（98 改于 / 落地 / 发起 + 用时）+「下发范围」
```

> 2~3 步只读；第 5 步写共享 + 写成员文件；第 4、6 步才动进程。
> 预同步**不会**帮你停服务，也不会帮你起 —— 顺序错了会立刻 409，不会硬来。

#### 9.4.1 只发一部分节点（灰度 / 先发 149）

目标节点由配置推导：`nodes.<ip>.components.<组件>.localRoot` 填了，才算这台机器的目标。
界面「待同步区 → 目标节点」把候选机器列出来，**默认全选**，取消勾选的就是这次不发。

```
☑ 149  已停止          ← 只留这台
☐ 145  运行中 · 要先停  ← 取消勾选 → 本次不发
```

规则（服务端强制的，不是界面约束）：

| 行为 | 说明 |
|---|---|
| 前置检查 | 只检查**勾选的**机器：必须在线、组件必须已停 |
| 下发 | 只给勾选的机器发 `stage`，没勾的连指令都收不到 |
| 基线 | **不提前推进**：只有「配置里声明的全部目标节点都落地了同一份内容」才写进基线、才从待同步区移除 |
| 待同步区 | 没发齐的文件留着，组标题显示 `已发 149 · 待发 145`；补齐后自动消失 |
| 记录 | 每批一个 `relId`，详情里「下发范围」写清 `requested / skipped` |

落地进度存在 `state\landed.json`（按 `组件/相对路径 → 内容哈希 → 已落地的节点`）。
**不放进 `pending.json`**：每次扫描会整体重写 pending，进度会丢；而且内容一变（哈希变）旧进度必须作废。

```powershell
# 命令行等价：只发 149
$body = @{ components=@('shp_buildings'); nodes=@('149'); includeDeletes=$false } | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:47821/api/ui/stage -Method POST -ContentType 'application/json' -Body $body
```

> 只发 149、不再发 145 会怎样？那批文件就**一直留在待同步区**（基线没推进）。
> 这正是想要的效果 —— 不会出现「145 悄悄落后、扫描还看不出来」。
> 真的决定永不发 145，就把该机 `localRoot` 置空（改成 `null`），它就不再是目标。

### 9.5 回退（M2 人工）

M2 没有一键回退（M3 才有）。现在回退 = 从成员本地备份拷回去，再启动：

```powershell
# 在目标机上（relId 从同步记录详情里抄）
$rel = 'rel-20261028-152954-ppzg'
$root = 'D:\SceneAutomationV3\Tools\ShapefileTool.Buildings.20230905'
robocopy "C:\vcsNode\backup\$rel\shp_buildings" $root /E /R:1 /W:1
```

- 备份目录结构和 `localRoot` 一致（`<relId>\<组件>\<相对路径>`），整目录拷回去就还原了；
  同步时删掉的文件，备份里有，拷回去等于恢复
- 拷回去之后按 §9.2 启停
- **拷完再启动**：文件被运行中的进程占着时拷不进去（`partial` 也不会硬写）

### 9.6 改配置（配置页）

```
界面 → 配置 → 改格子 → 保存配置 → 确认 diff
```

能改的只有四类：

| 字段 | 说明 |
| --- | --- |
| `localRoot` | 该组件在这台机器上的部署目录（必须绝对路径或 UNC） |
| `port` | 端口覆盖；不填就用组件默认值 |
| `enabled` | 是否启用；没有 `localRoot` 的组件，开关是禁用的 |
| `sharedRoot` | 节点级共享目录（**传输通道，不是部署路径**：成员从这里只读拉取 `_vcs\releases`，再拷到本地 `localRoot`）；不填沿用全局 |

保存时服务端会：校验 → 只改对应那几行（注释保留）→ 重新解析比对 → 备份 → 原子写。
**校验不过就整个放弃，原文件不会动**，界面上会直接显示原因（端口越界、路径不合法、组件没部署等）。

备份文件名是 `vcsnode-<YYYYMMDD-HHmmss>.yaml`；同一秒内连存多次会依次加 `-2`、`-3` 后缀，
不会互相覆盖（只保留最近 10 份）。

保存成功后配置立即在内存里生效（不用重启 master），**并且会向已连上的成员重发一次 hello**：
成员拿到新的 `localRoot` / `port` / `start` 后写进本地 `node-config.json`，下一轮采样就按新配置认进程。
刚改完的那几秒，矩阵里可能还是旧状态（成员还没上报），等一个采样周期（10s）即可。
**连不上的成员不会补发** —— 它下次重连时在 hello 回复里自然拿到最新配置。

手工改也一样可行，改完必须重启 master 才会读到：

```powershell
# 配置改错了，从备份恢复
Get-ChildItem C:\vcsNode\config\backup\            # 按时间倒序挑一个
Copy-Item C:\vcsNode\config\backup\vcsnode-20261026-142255.yaml C:\vcsNode\config\vcsnode.yaml
Restart-ScheduledTask -TaskName vcsNode-master     # 或手工重启进程
```

配置页上的「探测全部节点」现在只能检查**主节点本机**的路径是否真的存在；
其余三台要等 agent 接上才探得了。看到「其余 3 台未探测」是正常的，不是失败。

### 9.7 事件页（最近 30 天）

记的是**控制面事件**（不是业务日志），由主节点产生，7 种动作：

| 动作 | 什么时候出现 |
| --- | --- |
| `connect` / `disconnect` | 成员连上 / 心跳超时或连接断开 |
| `state` | 组件状态变化（`webapi running→stopped`）；到 `degraded/crashed/orphan` 记警告 |
| `task` | 98 往成员推指令（`start webapi` / `stage rel-…`） |
| `ack` / `nack` | 成员执行完回执 / 拒绝（`not_stopped`、`busy`…） |
| `probe` | 配置页点「探针」的汇总 |

```powershell
# 分页查（每页 15 条，按时间倒序）
curl "http://127.0.0.1:47821/api/ui/events?page=1&size=15"
curl "http://127.0.0.1:47821/api/ui/events?node=149&action=nack&page=1&size=15"
```

| 项 | 规则 |
| --- | --- |
| 落盘位置 | `C:\vcsNode\logs\events-YYYYMMDD.jsonl`（98 本地日期切天，用 `--log-dir` 可改） |
| 保留 | 最近 **30 天**；启动时 + 跨天各清一次过期文件 |
| 内存 | 启动时读回 30 天记录（上限 5 万条），查询/分页在内存里做 |
| 界面 | 每页 15 条，可按节点、动作筛选；时间带日期（`10-29 10:06:33`） |
| 重启 master | 事件**不会丢**（这一点和「同步记录」不同：同步记录在 `state\`，事件在 `logs\`） |

> 事件只记「动作」，不记文件明细。要知道某次同步动了哪些文件，看 `state\releases\<relId>.json`。

### 9.8 启停记录（最近 30 天）

事件页记的是「控制面在干什么」，启停记录记的是**每台机器上真的执行了什么**：

| 动作 | 什么时候出现 |
| --- | --- |
| `start` / `stop` / `restart` | 界面上点启动 / 停止 / 重启（成功或失败都记） |
| `stage` | 成员把一批文件落到本地（写入 / 删除 / 跳过 / 字节数） |
| `exit` | **不是我们停的**，进程自己没了（崩溃、被人从任务管理器杀掉），带退出码 |
| `lost` | 预留（成员整体失联时补记），目前不产生 |

```powershell
# 分页（每页 15 条，倒序，附带顶部统计卡）
curl "http://127.0.0.1:47821/api/ui/actions?page=1&size=15"
curl "http://127.0.0.1:47821/api/ui/actions?node=149&component=shp_buildings&action=stop&result=fail"
```

| 项 | 规则 |
| --- | --- |
| 谁写 | **成员自己写**：本机 `logs\actions-YYYYMMDD.jsonl`（98 连不上时也有痕迹）+ 逐条上报 98 |
| 98 落盘 | `state\actions\YYYYMMDD.jsonl`：按天切分、append-only、保留最近 30 天 |
| 去重 | 每条带 `id`，成员重发同一条时 98 直接丢弃（`duplicate: true`），不会多一行 |
| 上报失败 | 留在 agent 内存队列里，每轮采样重试（最多 500 条），不会因为一次网络抖动丢记录 |
| 主动停止 | 我们杀的进程不算 `exit`：停之前先按 pid 记下来，那颗进程的退出事件直接忽略 |
| 统计卡 | 今日启停次数 / 近 30 天失败数 / 最近一次失败 / 最近一次操作 |
| 重启 master | 记录**不会丢**（和事件一样在盘上，启动时读回） |

> 98 自己不记：主节点由人工操作，不归 vcsNode 管（`selfManage: false`），所以页面上只有 149 / 207 / 145 三台。

---

## 10. 故障处置

| 现象 | 先查 | 常见原因 |
| --- | --- | --- |
| 界面上某台一直 `node-offline` | 该机 `node -v`、`Get-Service` 里 agent 是否在跑、`Test-NetConnection 98 -Port 47821` | agent 没起来；账号密码改过导致服务启动失败；网络 |
| 所有机器都离线 | 98 的 47821 是否在听 | master 崩了 / 端口被占 |
| `stage` 一直卡住 | 共享可达性、吞吐 | 445 不通；大文件在慢链路上 |
| `stage` 报 `manifest_missing` | 成员上 `dir \\172.16.2.98\Tools\_vcs\releases` | 共享没挂上 / agent 账号读不到 / 同步包已被滚动删掉 |
| `stage` 报 `sha_mismatch` | 共享上的 blob 是否被人手工改过 | 有人在共享目录里直接编辑文件 |
| `stage` 报 `layout_mismatch` | `sources.<组件>` 与 98 的 `localRoot` 是否同一个目录 | 扫描源指向源码目录，M2 不允许把源码铺进同步目录 |
| `stage` 报 `partial` 且错误是 `EPERM`/`EBUSY` | 目标组件是不是又被起起来了 | 先停服务再发；已落地的文件不用重做 |
| 组件起不来，日志报找不到配置 | 启动 cwd | `appsettings.json` 不在 cwd；见 `architecture.md` §3.5 |
| GenerateClient / GenerateTool 立即退出，栈在 `SetConsoleOutputEncoding` | 成员 agent 是否已升级到 0.1.4-m2，`src\win-console.mjs` 是否就位 | 旧版 detached 启动没有有效控制台；见 §10.3 |
| 组件起来了但客户端不在线 | `SignalRUrl` | 指向了不存在的 webapi（145 指向自己就是典型） |
| 启停报「30000ms 内没等到…就绪（端口 X 还没监听）」，但应用日志已 `Application started` | 应用日志里的 `Now listening on` | 配置 `port` ≠ 应用真实端口（被 `Kestrel:Endpoints` 改的），见 §10.2 |
| 端口被占 | `Get-NetTCPConnection -LocalPort <port>` | 上次没杀干净，标 `orphan` |
| 同步后功能异常 | 本次 commit 是否含数据库变更 | 表没建（如 `PreviewBlock*` 三张表） |

### 10.1 常用排查命令

```powershell
# 端口占用
Get-NetTCPConnection -LocalPort 3601 -State Listen |
  Select-Object OwningProcess | ForEach-Object { Get-Process -Id $_.OwningProcess }

# 进程清单（含命令行）
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -in 'dotnet.exe','node.exe' } |
  Select-Object ProcessId, Name, CommandLine

# 到 3601 的已建立连接（判断客户端是否真的连上了）
Get-NetTCPConnection -RemotePort 3601 -State Established

# 查看 agent 日志
Get-Content C:\vcsNode\logs\agent.log -Tail 50
```

### 10.2 端口口径：`port` 必须等于「应用真实监听端口」

vcsNode 的 `components.<c>.port` / `nodes.<ip>.components.<c>.port` **只是探针期望值**
（启动就绪判据 + 端口归属认进程 + 健康探测），它**不会**改变应用的监听端口。

应用的监听端口由它自己决定，按优先级：

1. `appsettings.json` 里的 `Kestrel:Endpoints`（最高，**会盖掉** `ASPNETCORE_URLS`）
2. 代码里的 `UseUrls(...)`
3. `ASPNETCORE_URLS` / `--urls`（我们 `start.env` 里给的就是这个，只在 1、2 都没写时生效）

所以**判断端口的依据只有一条：启动日志里那行 `Now listening on:`**：

```
Now listening on: http://127.0.0.1:7080     ← 配置里 port 就写 7080
```

典型症状与处理：

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 启停报 `30000ms 内没等到 <组件> 就绪（端口 X 还没监听）`，但日志显示 `Application started` 且端口是 Y | 配置的 port 和应用实际端口不一致 | 把 port 改成 Y（**改配置，不要去改应用**） |
| 改了 `ASPNETCORE_URLS` 但端口没变 | 本机 `appsettings.json` 里有 `Kestrel:Endpoints` | 同上；`appsettings.json` 属于 `localConfig`，各机独立、永不同步 |
| 组件显示「运行中」但健康检查失败 | `health.type: connection` 的 `remoteHost` 写错 | 应用只绑 `127.0.0.1` 时，客户端可能走 `127.0.0.1` 或 `::1` → 把 `remoteHost` 置 `null`，只按 `remotePort` 认 |

> 判定小抄：`netstat -ano | findstr :<端口>` 看谁在听；`Get-NetTCPConnection -LocalPort <端口> -State Listen` 看绑定地址
> （`127.0.0.1` = 只有本机连得上，`0.0.0.0` = 全网可达）。
> 排查顺序：**日志里的 `Now listening on` → 配置里的 `port` → 两者对齐**，不要去猜。

---

### 10.3 Windows .NET 后台启动立即退出

日志出现 `System.IO.IOException → SetConsoleOutputEncoding → Program.Main`，且退出码为
`3762504530` 时，先确认成员 agent 的版本。旧版直接使用 `detached: true` 启动 `dotnet`，
Windows 的 `DETACHED_PROCESS` 会使业务进程没有可用控制台；GenerateClient / GenerateTool
入口的编码设置因此失败。这发生在业务配置读取和 SignalR 连接之前。

从 agent **0.1.4-m2** 起，Windows `dotnet` 进程由 `src\win-console.mjs` 用
`CREATE_NEW_CONSOLE + SW_HIDE` 启动：有有效控制台，窗口隐藏，标准输出和错误直接写原组件日志。
启动桥返回真实业务 PID 并转交退出码；停止仍按真实 PID 执行 `taskkill /T /F`，
重启仍先停后起。agent 退出后业务进程继续运行。

升级已有 149 成员时，在停止该机 **vcsNode agent** 后，从本次修复包定点覆盖三个文件：

```powershell
$packageRoot = '\\172.16.2.98\Tools\_vcs\dist\vcsNode'  # 放有本次修复文件的目录
$agentRoot = 'C:\vcsNode'                              # 改成该成员的实际 vcsNode 目录
foreach ($relativePath in @('bin\agent.mjs', 'src\proc.mjs', 'src\win-console.mjs')) {
  Copy-Item -LiteralPath (Join-Path $packageRoot $relativePath) -Destination (Join-Path $agentRoot $relativePath) -Force
}
```

再按该机原来的计划任务或服务方式启动 agent。页面应显示 `agent 0.1.4-m2`；
依次启动 GenerateClient / GenerateTool，检查 PID、组件日志及到 webapi 的连接。
无需覆盖业务 DLL、源码、`appsettings.json` 或 `agent.bootstrap.json`。

本次同时核对了业务仓库中的入口：WorkerHost 未主动设置控制台编码；McpServer 使用标准
日志及 HTTP 宿主，未发现同样的编码设置。二者的 `dotnet` 启动也自动使用兼容路径。
若仍退出，应按实际日志判断：WorkerHost 检查模块启用及其配置；McpServer 检查
`--transport http`、端口（149 配置为 7081）和 HTTP 鉴权配置，不应把其他启动异常归为编码问题。

## 11. 文件位置

| 内容 | 路径 |
| --- | --- |
| vcsNode 程序 | `C:\vcsNode\` |
| 主节点配置 | `C:\vcsNode\config\vcsnode.yaml` |
| 成员引导配置 | `C:\vcsNode\agent.bootstrap.json` |
| 运行时状态 | `C:\vcsNode\state\{pending,baseline,landed,nodes,config-revision}.json`、`state\releases.json`（最近 50 条摘要）、`state\releases\<relId>.json`（单次明细） |
| 落地台账 | `C:\vcsNode\state\landed.json`：`组件/相对路径 → {marker, nodes}`，记录哪台机器上已经是哪份内容（只发部分节点时靠它判断「发齐了没有」） |
| agent 本地缓存 | `C:\vcsNode\state\node-config.json`（主节点下发的组件定义）、`agent.json`（lastSeq） |
| 成员本地备份 | `C:\vcsNode\backup\<relId>\<组件>\<相对路径>`（**不在共享上** —— 共享对成员只读；bootstrap 的 `backupDir` 可改） |
| 事件（控制面） | `C:\vcsNode\logs\events-YYYYMMDD.jsonl`：按天切分、append-only，**保留最近 30 天**（启动时和跨天自动清过期文件）。master 启动时把 30 天内的记录读回内存，界面每页 15 条。要追溯「哪批文件发给了谁」，仍看 `state\releases\<relId>.json`（同步记录，含逐文件明细与三个时间点） |
| agent 日志 | `C:\vcsNode\logs\agent.log` |
| 启停台账 | 98：`state\actions\YYYYMMDD.jsonl`（成员上报汇总，保留 30 天）；成员：`logs\actions-YYYYMMDD.jsonl`（本机一份，`logDir` 可改） |
| 成员上的服务日志 | `C:\vcsNode\logs\<组件>.log`（每个组件一个，append；bootstrap 的 `logDir` 可改） |
| 共享分发区 | `\\172.16.2.98\Tools\_vcs\releases\<relId>\{manifest.json,files\…}`（98 写，成员只读；按 `storage.keepReleases` 滚动删） |
| 备份（98 自己那份） | M2 不做 —— 98 是同步源，人工操作，不归 vcsNode 管 |

### 11.1 `state\nodes.json`（M0）

主节点每 1s 最多落盘一次，重启后用于显示「最后一次看到它是什么时候」：

```json
{
  "format": 1,
  "updatedAt": "2026-10-28T02:18:23.254Z",
  "nodes": {
    "node-149": {
      "ip": "172.16.1.149",
      "role": "target",
      "lastSeenAt": 1793153899124,
      "connectedAt": 1793153800000,
      "hostname": "SCENE-149",
      "agentVersion": "0.1.0-m0",
      "uptimeSec": 98,
      "configRevision": 7,
      "lastSeq": 12,
      "components": { "shp_plants": { "state": "running", "pid": 19684, "observedAt": 1793153899000 } }
    }
  }
}
```

> 这是**观测缓存**，不是事实来源。删掉它只会让界面少显示一段历史，不影响任何业务。
> 在线状态每次启动都重新建立（`load()` 一律置 `online: false`）。

---

## 12. 停用 vcsNode（回到人工运维）

vcsNode 必须能「随时拔掉」而不影响业务，这是设计约束之一。

```
1. 停 agent 服务（不要在业务繁忙时停）
2. 停 master
3. 业务组件不受影响：它们由 vcsNode 启动的部分会随 agent 停止？
   → 不会。agent 停止不杀业务进程（detached 启动），业务继续跑
4. 恢复人工启停：按《试运行运维交接手册》操作
5. 目录指针仍在 releases\<relId>，业务照常运行；要还原成普通目录，
   删掉 junction 后把目标目录移回去即可
```

> 【待实现】第 3 条需要在实现时确保：`agent` 退出不连带杀掉受管进程（`detached: true`）。

---

## 13. 待补

| # | 内容 | 依赖 |
| --- | --- | --- |
| 1 | 四个具体路径与端口核对 | 现场实测 |
| 2 | 共享名与账号落地 | 运维执行 |
| 3 | 首次全量同步的耗时与带宽评估 | 第 4 步实现后 |
| 4 | 数据库变更的人工闸门清单 | 与开发约定 |
| 5 | ~~跨网段 SMB 实测~~ | ✅ 已完成：207 / 145 / 149 均可读 `\\172.16.2.98\Tools` |
| 6 | 五个组件的 `sources` 改到实际运行目录（web / webapi / generateclient / generatetool / workerhost / mcpserver） | 现场核对 98 的同步目录；改完才能用 M2 更新它们 |
| 7 | `secondaryMappings`（`CE_Template\startup.py`、`AutoCE.py`）在 M2 没有实现 | 下一版；现在这两个文件只在扫描里出现，同步不会写到第二处 |
| 8 | 成员备份的保留策略（现在不自动清，`backup\<relId>\` 会一直涨） | 运维定容量；或 M3 按 `keepReleases` 一起滚 |
| 9 | 一键「切换上线」（停 → 更新 → 起）与一键回退 | M3 |
| 10 | 逐文件 `landedAt`（现在是节点级完成时刻） | M3 连 commit 一起细化 |
