> ⚠ **已归档**（2026-10-26）。本文是详细版论证；简明版见 `docs/architecture.md`。
> 两者冲突时以简明版为准，被否决方案的完整理由仍以本文第 12 节为准。

# vcsNode 整体架构设计

> 版本：v3 · 2026-10-26
> 状态：设计定稿，未开始编码
>
> 本文是**唯一权威**的架构文档。此前的 `design.md`、`architecture.md`、`plan.md`
> 已归档到 `docs/archive/`，不再维护；其中与本文冲突的内容一律以本文为准。
>
> 事实依据（三级标注，全文沿用）：
> - **【实测】** 在本机或现场机器上跑过命令，有输出证据
> - **【代码】** 从 `SceneAutomation` @ `a076978` 源码/配置中读出
> - **【推断】** 尚未验证，按现有信息做的合理判断，见第 13 节「模糊点」

---

## 0. 一页纸

**一句话**：主节点 98 管住四台机器上的「自动生成系统」—— 看得到每个组件的状态、
点得动启停、改完代码一键把变化文件推到另外三台。

**形态**：

```
        ┌──────────────────────────────┐
        │  98  172.16.2.98             │
        │  vcs-master（唯一入站端口）   │
        │  ─ 管理界面 / API / 判定 / 编排│
        │  ─ 同时管自己本机的 6 个组件   │
        └──────────────┬───────────────┘
                       │  成员主动出站长连接（SSE），98 沿它下发
        ┌──────────────┼───────────────┐
        │              │               │
   ┌────▼────┐   ┌─────▼─────┐   ┌─────▼─────┐
   │207      │   │145        │   │149        │
   │vcs-agent│   │vcs-agent  │   │vcs-agent  │
   └────┬────┘   └─────┬─────┘   └─────┬─────┘
        │              │               │
        └──────────────┴───────────────┘
                       │  SMB 只读
              \\172.16.2.98\…\Tools\_vcs
```

**四条硬约束**（后面所有设计都由它们推出来）：

| # | 约束 | 来源 |
| --- | --- | --- |
| 1 | 98 → 成员 47820 入站被防火墙拦，反向通 | 【实测】 |
| 2 | 各机跑的是源码 + `dotnet xxx.dll`，不是发布产物 | 【实测】 |
| 3 | 成员上可能正在跑生成任务，任何重启前必须确认空闲 | 【代码】+ 运维手册 |
| 4 | 轻量：3~4 个 Node 进程，不用数据库 | 需求 |

**四个进程**：98 上 `vcs-master`（内含本机 agent），207 / 145 / 149 各一个 `vcs-agent`。
没有数据库、没有消息队列、没有反向隧道、没有外部 npm 依赖。

---

## 1. 定位与边界

### 1.1 管理单元

不是「进程」，也不是「文件」，而是：

```
服务实例 = 节点(Node) + 组件(Component) + 版本(Release) + 进程(Process)
```

把版本和进程绑在一起，才有可能做到真正的原子发布：
**同步到新目录 → 停旧进程 → 切指针 → 起新进程 → 失败回滚**。
只管进程不管版本，回滚就只能靠人手工拷贝；只管文件不管进程，改了也不生效。

### 1.2 与现有工具的边界

| 工具 | 进程守护 | 多机集中控制 | 文件下发 | 版本化回滚 |
| --- | --- | --- | --- | --- |
| PM2 / supervisord / systemd | ✅ | ❌ 单机 | ❌ | ❌ |
| Ansible / Salt | ❌ 退出即失管 | ✅ | ✅ 一次性 | ❌ |
| rsync / Syncthing | ❌ | 部分 | ✅ | ❌ |
| Capistrano / Deployer | ❌ | ✅ 推送式 | ✅ | ✅ |
| k8s / Nomad | ✅ | ✅ | 需镜像 | ✅ |
| **vcsNode** | ✅ | ✅ 长连接 + 持久状态 | ✅ 只传变化 | ✅ |

差异点只有两个，但要守住：

1. **长连接 + 节点侧持久状态** —— 能回答「现在到底跑没跑」，而不是「刚才命令发出去了」
2. **零基础设施** —— 目标机只要有 Node，不要 Docker、不要 SSH 免密、不要开入站端口

### 1.3 明确不做

| 不做 | 原因 |
| --- | --- |
| 容器化 | 现场是 Windows + UE/CityEngine/QGIS 原生环境，容器化不现实 |
| 通用部署平台 | 只服务这一套系统、这四台机器，通用性会立刻变成复杂度 |
| 数据库 | 状态量小、写频率低；引入 DB 只增加现场部署成本 |
| 远程 Shell | 不是要一个 WebSSH；能启停指定组件就够了 |
| 接管业务数据库 | 98 上那套 PostgreSQL 是业务库，vcsNode 不耦合它 |
| 管理系统依赖（UE/QGIS/CE/PostgreSQL） | 外部安装软件，只同步脚本，不管它们的进程 |

### 1.4 管理范围 = 声明过的组件

这条是**不变量**，不是建议：

> 只有出现在 `components` / `sources` / `nodes` 里的东西，才会被扫描、同步、监控、探测、启停。
> 其余一律不感知 —— 不遍历、不哈希、不列进程、不报警。

落到具体动作：

| 动作 | 范围 |
| --- | --- |
| 扫描差异 | 只走 `sources.*.include` 声明的目录；`Tools` 下 35 项里只认那 11 个 |
| 生成 manifest | 只含上述目录内的文件 |
| 进程采样 | 只按各组件的 `identify` 指纹匹配，**不是**把所有 `node.exe` / `dotnet.exe` 都列出来 |
| 健康检查 | 只查配置里的端口 / URL / 连接 |
| 告警 | 只为声明的组件报警；第三方软件挂了与本系统无关 |

这样做有三个直接好处：

1. **不会被别人的东西干扰** —— 同事在 98 上装了 ComfyUI，它的进程挂了不会报我们 `crashed`
2. **首扫不会失控** —— CesiumLab、ComfyUI、CE_assets 这类几 GB 的目录根本不在遍历范围里
3. **边界清晰** —— 谁的东西谁负责，出问题先看是不是在管理范围内

**唯一要守的约束**：`sources` 必须指向具体组件目录，不能指向部署根。
校验时会拒绝 `D:\SceneAutomationV3\` 这种输入，否则 `ProjectFolder` / `TaskFolder` /
`P4Workspace` 这些几十 GB 的运行期数据会被卷进来。

---

## 2. 环境事实

### 2.1 四台机器，三套系统

| 机器 | 网段 | 角色 | 承载组件 | set |
| --- | --- | --- | --- | --- |
| `172.16.2.98` | 172.16.2.0/24 | 主节点 + 修改源 | web · webapi · generateclient · generatetool · tools · shp_* | set-b（全套） |
| `172.16.1.207` | 172.16.1.0/24 | 成员 | web · webapi | set-a 前半 |
| `172.16.1.145` | 172.16.1.0/24 | 成员 | generateclient · generatetool · tools | set-a 后半（**无 webapi**） |
| `172.16.1.149` | 172.16.1.0/24 | 成员 | 全套 | set-c（全套） |

**set 是事务边界**：set-a 里 webapi 在 207、客户端在 145，一条依赖边跨两台机器，
所以 set-a 的发布必须整体推进，不能两台各自为政。

### 2.2 组件清单

| id | kind | 端口 | 部署机器 | 更新方式 |
| --- | --- | --- | --- | --- |
| `web` | service | 98/149: 3333，207: 3071 | 98 149 207 | `in-place`（vite dev 热更新，通常不重启） |
| `webapi` | service | 3601 | 98 149 207 | `release-switch` + 重启 |
| `generateclient` | service | 无入站 | 98 149 145 | `release-switch` + 重启 |
| `generatetool` | service | 无入站 | 98 149 145 | `release-switch` + 重启 |
| `shp_plants` | service | 4000 | 98 149 145 | `in-place` + 重启 |
| `shp_buildings` | service | 4001 | 98 149 145 | `in-place` + 重启 |
| `tools` | asset | - | 98 149 145 | `in-place`，不重启 |
| `ue_templates` | asset | - | 98 149 145 | `in-place`，不重启 |
| `workerhost` | service（可选） | 无入站 | 待确认 | 同 generateclient |
| `aigenerate` | service（可选） | 5231 | 待确认 | `release-switch` + 重启 |

### 2.3 从代码读出来的硬事实

这些事实决定了部署布局，不能凭直觉：

| 事实 | 证据 | 后果 |
| --- | --- | --- |
| `shp_plants(4000)` / `shp_buildings(4001)` 是 **Node express**，不是 UE | `Tools\ShapefileTool.*\index.js` 【代码】 | 配置里的 `UEPlantServerBaseUrl` 名字有误导性，别按 UE 处理 |
| `pm2.config.cjs` 里 `autorestart: false` | 同上 【代码】 | 挂了不会自愈，必须由 vcsNode 兜住 |
| `generateclient` / `generatetool` 无入站端口 | 无监听代码 【代码】 | **不能靠端口判活**，要查 ESTABLISHED 连接 |
| 配置按**当前工作目录**解析 | `ConfigHelper.cs:43` `SetBasePath(Directory.GetCurrentDirectory())`，且 `optional: false` 【代码】 | cwd 错了就读错配置或直接起不来 |
| `launchSettings.json` 对 `dotnet xxx.dll` 不生效 | webapi `applicationUrl: http://*:3601` 只在 `dotnet run` 时用 【代码】 | 必须显式给 `ASPNETCORE_URLS` |
| `dotnet build` 会用仓库版覆盖本机配置 | csproj `CopyToOutputDirectory=PreserveNewest` 【代码】 | 本机配置必须与构建产物物理隔离，见 5.7 |
| 每个 Python 工具目录必须有 `.venv\Scripts\python.exe` | 后端硬编码路径 【代码】 | `.venv` 不可跨机复制，每台自己 `uv sync` |
| `TP_TuguanStreaming*.zip` 是功能依赖 | `UEProjectTemplateHelper` 会解压它们 【代码】 | 排除规则不能一刀切 `*.zip` |
| 一个仓库文件可能对应**两个**部署位置 | `Tools\update_changed_tools_to_v3.ps1` 的 secondary 映射 【代码】 | 同步模型必须支持 1→N |
| `Tools` 共享根里混着大量非仓库内容 | 207 实测 35 项 vs 仓库 `Tools/` 11 个目录 【实测】 | 扫描必须用**白名单**，不能按整个目录走，否则几十 GB 第三方被当增量 |

### 2.4 已实测结论

| 项 | 结果 |
| --- | --- |
| `98 → 207:47820` | ❌ 被拦 |
| `207 → 98:47820` | ✅ 通 |
| `98 → 207` ICMP | ✅ 通 |
| `\\172.16.2.98\Tools` 读写 | ✅ 成功（权限过宽，需收紧） |
| `207 → 98:445` 跨网段 SMB | ✅ 通，可读共享，35 个根条目 |
| `.NET 8 SDK` | ✅ 三台成员机都有 |
| `.NET 启动形态` | ✅ `dotnet xxx.dll`（先构建，再跑 DLL） |
| `web 启动形态` | ✅ `npm run dev`（vite 源码直跑） |
| `149 → 98:445` 跨网段 SMB | ✅ 通，可读共享 |
| `145 → 98:445` 跨网段 SMB | ✅ 通，可读共享 |
| `Node 版本` | 207 = **18**；98 / 149 / 145 = 20+ |
| 部署根 | ⚠️ **四台不统一**：207 的 Tools 在 `D:\Digihail\SceneAutoApply\Tools`，其余在 `D:\SceneAutomationV3\Tools`；207 的 web/webapi 目录未确认 |

> 207 的探测输出（2026-10-26）：身份 `DESKTOP-AUN3GPT\digihail`（本地账号，
> 非域账号）即可读取共享，说明 98 侧共享对 Everyone / 匿名开放。
> 读没问题，但**写权限必须单独收紧** —— 见第 10 节。

---

## 3. 总体结构

### 3.1 三层

```
┌─────────────────────────────────────────────────────────────┐
│ 控制层（只传指令，几 KB）                                     │
│   98 vcs-master  ──SSE 长连接──▶  207 / 145 / 149 vcs-agent  │
│                  ◀──POST report──                            │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 数据层（只传文件差异）                                        │
│   98 写一次 ▶ \\172.16.2.98\…\Tools\_vcs                     │
│   成员只读拉取 ▶ 本地 releases\<组件>\<relId>                 │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 执行层（各机自治）                                            │
│   每个 agent 在本地：采样进程 · 启停组件 · 组装 release        │
│   主节点挂掉时，成员仍能用最后一份配置维持现状                  │
└─────────────────────────────────────────────────────────────┘
```

三条原则：

1. **控制与数据分离** —— 一条链路卡住不影响另一条；指令几十字节，文件几十 MB
2. **判定集中、采集分散** —— 改判定规则不用重发 agent
3. **成员自治** —— 主节点失联时成员不瘫痪，能按 `config.last-good.json` 继续管本机

### 3.2 为什么是「成员出站」

防火墙实测只允许成员连 98。所以：

- 98 永远不主动连成员，**不需要在成员上开任何入站端口**
- 成员主动建立一条常驻连接，98 沿这条**已经建立**的连接下发

方向没得选，但「来了就问」和「来了就一直握着」是两回事 —— 见第 4 节。

---

## 4. 控制面

### 4.1 形态

```
成员 145                                             98
   │                                                  │
   ├── GET /api/agent/stream?since=41 ───────────────▶│  建立后不返回
   │                                                  │
   │                                                  │  运维点了「停止 webapi」
   │◀────────── event: task { seq:42, stop } ─────────┤  沿这条连接推
   │                                                  │
   ├── POST /api/agent/report { done } ──────────────▶│
   │                                                  │
   ├── GET /api/agent/stream?since=42 ───────────────▶│  重新挂上
```

下发延迟 = 一个 RTT（<10ms）。空闲时只有 15s 一个 `ping`。

### 4.2 为什么不是定时轮询

| | 2s 轮询 | 常驻连接 |
| --- | --- | --- |
| 下发延迟 | 0~2s，平均 1s | 一个 RTT |
| 空闲开销 | 3 台 × 43,200 次/天 | 3 次连接 + 心跳 |
| 失联发现 | 心跳超时 ≈6s | 连接断开即知 |
| **丢指令** | **有窗口** | 无（序号游标） |

最后一行才是真理由。`GET /api/tasks` 返回「当前队列状态」，两次请求之间存在窗口；
成员正在执行长任务或刚好在重连时，这期间的指令会被静默吞掉 —— 不报错，
只是在某天发现某台机器没停干净。

### 4.3 序号游标（必须有）

`since` 是协议的核心，不是可选优化。成员重启、断线重连、98 重启，都从记住的 `seq`
续上，**不丢不重**。详细格式见 `docs/protocol.md`。

### 4.4 断线与重连

```
退避：1s → 2s → 5s → 10s → 30s（封顶），叠加 0~30% 抖动
```

- 抖动是必需的：98 重启时三台会同毫秒断开、同毫秒重连，没有抖动就是一次小型雪崩
- 客户端 45s 收不到任何字节（含 ping）就主动重连 —— 防中间设备把死连接静默黑洞
- 98 侧：连接断开 → 立刻把该节点标 `node-offline`，不用等任何超时

### 4.5 界面三态

`dispatched`（已下发）→ `executing`（执行中）→ `confirmed`（已确认）。
**不显示「已停止」直到收到 ack** —— 否则界面会骗人。

---

## 5. 数据面：文件同步

### 5.1 原则

1. **只传变化的文件**（sha256 比对），从不传整个目录
2. **两条落地策略**，由「改了之后是否需要重启才生效」决定：

| 判据 | 策略 | 适用 |
| --- | --- | --- |
| 下次读取即生效 | `in-place`：临时文件 + 原子替换 + 备份 | `tools`、`ue_templates`、`web` |
| 必须重启才生效 | `release-switch`：新目录 + 切指针 + 重启 | `webapi`、`generateclient`、`generatetool`、`shp_*` |

3. `in-place` 的原子替换：

```
写 <name>.vcsnew → 校验 sha256 → 备份原件到 _vcs\backup\<relId>\
→ MoveFileEx(REPLACE_EXISTING) → 记入 manifest
```

`MoveFileEx` 在 SMB 上由服务端执行 rename，**对读者是原子的** ——
不会读到半个文件。这是 `in-place` 能成立的前提。

4. `release-switch` 的新目录用**硬链接**复用上一版未变的文件：
网络只走差异，磁盘几乎不增长，每个 release 都是完整可运行目录。

### 5.2 组装必须按 manifest，不能走目录树

这是一个容易写错、且后果很脏的点。

如果按「遍历上一版目录 → 硬链接所有文件」来组装，会把 `bin/`、`obj/` 一起链进去。
新 release 里 `dotnet build` 写 `bin/` 时，**写入的是与旧 release 共享的同一个 inode**，
旧 release 当场被污染 —— 回滚就回不去了。

所以规则是：**只按上一版 manifest 里记录的文件清单建立硬链接**，
`bin/`、`obj/`、`node_modules/`、`.venv/` 一律不参与，构建时在本机重新生成。

### 5.3 两阶段：STAGE / COMMIT

```
[STAGE]  服务照常运行，业务无感
  98 写变化文件到 \\…\_vcs\releases\<组件>\<relId>\（manifest + 签名）
  成员收到指令 → 拉到本地 releases\<组件>\<relId>\
              → 组装（按 manifest 硬链接未变文件）
              → 构建（dotnet build -o bin / npm 依赖检查）
              → 回填本机配置（见 5.7）
              → 逐文件校验 sha256 → 回报 staged

[COMMIT] 每台 1~3 秒
  查忙 → expectedStop → stop → 切 junction → start → 探活 → 回报
```

**为什么必须两阶段**：把「慢且易失败」的传输和构建放在服务运行期，
「快但不可逆」的切换只占 1~3 秒。传输失败时服务完全没被触碰，代价为零。

**为什么构建必须在 STAGE**：`dotnet xxx.dll` 前要先编译，`dotnet build` 10~30s。
放进 COMMIT 会把停机窗口撑大一个数量级。

### 5.4 1→N 映射

一个仓库文件可能落到两个部署位置。已确认的：

| 源 | 目标 1 | 目标 2（额外） |
| --- | --- | --- |
| `CityEngine脚本/…/CEScripts/startup.py` | `Tools\SceneAutomationGeneration\CEScripts\startup.py` | `Tools\CE_Template\startup.py` |
| `…/CEScripts/AutoCE.py` | 同上相对路径 | `Tools\CE_Template\CETemplate\scripts\AutoCE.py` |

同步模型必须支持一对多，二级目标写入后要额外做一次 hash 校验（现有脚本就是这么做的）。

注意 `CE_Template\` 整个目录**只有这两个文件是纳管的**，其余内容是本地资产，
所以它不能进扫描白名单 —— 白名单只到目录级，二级映射单独表达。

### 5.5 回滚

| 策略 | 动作 |
| --- | --- |
| `release-switch` | 切回上一 release 指针 + 重启，零传输 |
| `in-place` | 按 manifest 从 `_vcs\backup\<relId>\` 逐文件还原 |

保留最近 5 个 release（可配），超出的按时间清理。

### 5.6 成员怎么读共享：UNC 直连

```powershell
# 对
Copy-Item '\\172.16.2.98\…\Tools\_vcs\releases\webapi\…\app.js' -Destination …
# 不要
net use Z: \\172.16.2.98\Tools
```

盘符属于「登录会话」：`net use` 只对当前交互用户有效，**服务/计划任务身份看不到那个 Z 盘**。
UNC 没有挂载生命周期，权限直接按访问者凭据算。

三个现实问题：

| 问题 | 说明 | 处置 |
| --- | --- | --- |
| 进程身份 | agent 以 LocalSystem 跑时 SMB 用机器账号 `COMPUTERNAME$`，通常被拒。表现是「命令行能读、装成服务读不到」 | 用专用账号运行 agent，或 `cmdkey /add` 存凭据 |
| 主机名解析 | 跨网段 NetBIOS/WINS 不可靠 | 一律写 IP |
| 权限过宽 | 实测该共享可写，成员只该读 | 建 `-ro` / `-rw` 两个账号；只开 445 不开 139 |

验证工具：`tools/smb-probe.ps1`（默认只读，`-TestWrite` 才试写）。

**备选（暂不采用）**：既然成员本来就要连 `98:47820`，把文件分发也做成同端口的 HTTP 下载，
只需开一个端口、复用 HMAC 鉴权、绕开 SMB ACL 与身份问题。代价是要自己实现断点续传与缓存，
且运维不能再用资源管理器直接翻共享目录。→ 若 445 跨网段确实放不开，切这个。

### 5.7 本机配置与构建产物必须物理隔离

这是本系统最隐蔽的一个坑。

```xml
<!-- GenerateClient.csproj / GenerateTool.csproj -->
<Content Include="appsettings.json">
  <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
</Content>
```

每次 `dotnet build` 都会把仓库里的 `appsettings.json` 复制到输出目录。
145 上手工改对的 `SignalRUrl` 会被悄悄改回 `http://172.16.1.145:3601` ——
而 145 上根本没有 webapi。服务照样能起、日志也不报错，只是连不上后端。

**布局**：

```
<release>/
├── appsettings.json       ← 本机配置，从 <deployRoot>\_config\<组件>\ 回填
├── nlog.config            ← 同上
└── bin/                   ← 编译产物全部集中在这里，构建永远碰不到上面两个
```

配套动作：

- 构建参数固定 `-o bin`，不产生 `bin/Debug/net8.0` 这种路径
- 回填发生在**构建之后、start 之前**
- 仓库版本仍然会传过来，但改名存为 `appsettings.repo.json`；
  STAGE 阶段对比键集，提示「仓库多了 X 个键，请手工合入本机配置」

既不会丢新配置项，也不会写坏目标机。

### 5.8 文件之外的变更

`a076978` 新增了 3 个 DbSet（`PreviewBlockSnapshots` / `PreviewBlockCollections` /
`PreviewBlockSaveReceipts`），但仓库里既没有 `Migrations/`，也没有建表 SQL。

→ **有些版本不只是文件变更**。发布流程里必须留一道人工闸门，
不能「点一下就把四台机器全部同步完」。

---

## 6. 进程管理

### 6.1 持有方式

```
指纹 = pid + 进程创建时间 + 命令行哈希      （防 PID 复用杀错进程）
状态机：stopped → starting → running → stopping → stopped | crashed | orphan
```

**阶段一用 `adopt`**：按指纹认领现有人工启动的进程，只做监控和手动停启。
稳定后再切到 supervisor 自己 spawn。这样上线第一天不会打断现场作业。

### 6.2 启动

```
1. 已在 running → no-op（幂等）
2. 检查 dependsOn 健康
3. spawn（detached + windowsHide + stdout/stderr 重定向到 logs\<组件>\<日期>.log）
4. 记指纹，状态 → starting
5. 等就绪：HTTP 200 / 端口 Listen / ESTABLISHED 连接建立
6. 超时 → failed（不无限等）
```

### 6.3 停止

```
1. expectedStop = true                       （否则自愈会立刻拉起旧进程）
2. 检查是否忙                                  （见 6.4）
3. taskkill /PID <pid>                       （先礼，不带 /F）
4. 等待 N 秒
5. taskkill /PID <pid> /T /F                 （/T 不可省，否则留下 python/UE 孤儿）
6. 验证端口释放；未释放 → 标 orphan，禁止自动重启
7. 状态 → stopped
```

> 已知缺陷：`generateclient` / `generatetool` 虽有 `Ctrl+C` 清理钩子，但外部无法可靠
> 投递 `CTRL_C_EVENT`，实际会退化为硬杀。要真优雅停，需给它们加本机停机信号。

### 6.4 忙碌保护（最重要的一条）

运维手册明确：停止生成必须走系统停止入口，否则状态不一致。
`generateclient` 会向 webapi 推送 `SendStateToServer(isBusy)`。

`stop` / `restart` / 发布 COMMIT 前必须确认空闲：

| 方案 | 改代码 | 可靠性 | 备注 |
| --- | --- | --- | --- |
| A. webapi 加只读接口 `/api/clients/state` | 要 | 高 | 推荐，但要动业务代码 |
| B. 观察任务目录最近写入时间 | 不用 | 中 | 过渡方案，先上这个 |
| C. 查数据库队列 | 不用但耦合 | 中 | 不推荐 |

**忙的时候不重启**：宁可让发布排队等待，也不把正在生成的项目弄坏。

### 6.5 顺序与并发

```
启动：webapi → (shp_plants, shp_buildings, generatetool) → generateclient → web
停止：反序
```

- set 内串行，跨 set 并行
- 组件级互斥锁，避免两条指令打架
- 所有动作**幂等**（崩溃重启后可安全重放队列）

### 6.6 自愈

| 情况 | 处置 |
| --- | --- |
| 崩溃（退出码 ≠ 0） | `on-failure` 拉起，5 次 / 10 分钟，退避 2s |
| 人工停止 / 发版停止 | `expectedStop` 期间不拉起 |
| 进程没了但端口被占 | 标 `orphan`，禁止自动重启，先列出占用者 |
| 超过重试上限 | 停止自愈 + 告警 |

---

## 7. 监控与判定

### 7.1 分工

| | 98 | 成员 agent |
| --- | --- | --- |
| 采样 | 只采本机 | 采本机全部组件 |
| 判定 | **全部判定在 98**（规则集中） | 只上报原始观测 |
| 处置 | 决定并下发指令 | 执行指令 |

### 7.2 节奏

| 项 | 间隔 | 说明 |
| --- | --- | --- |
| 控制面连接 | 常驻 | SSE 长连接 + 15s ping，**它同时就是心跳** |
| 状态上报 | 变化时 + 30s | 没变化就只报时间戳 |
| 进程采样 | ≥5s | 宿 PowerShell 执行 `Get-CimInstance Win32_Process` 一次 200~500ms，一次采样覆盖全部组件 |

连接兼任心跳后，少了一路独立心跳，也少了一套超时推断 ——
**连接断开 = 节点失联**，判定依据从「时间推断」变成「事实」。

### 7.3 四种状态必须分开

| 状态 | 依据 | 处置 |
| --- | --- | --- |
| `node-offline` | 控制面连接不存在 | 只告警，**不重启**（指令没人接） |
| `crashed` | 连接正常，进程不在 | 拉起 |
| `orphan` | 进程不在但端口被占 | 不重启，先查占用 |
| `degraded` | 进程在，SignalR 连接断 | 重启客户端 |

`degraded` 是最容易被漏掉的一种：进程活着、窗口正常、端口也在，
但没连上 webapi（典型原因就是 5.7 里那个被覆盖的 `SignalRUrl`）。
之前只能靠翻后端日志发现 `RegisterToolNotExist`。

### 7.4 各组件怎么判活

| 组件 | 判活 |
| --- | --- |
| `web` | TCP 端口 + HTTP GET `/` 200 |
| `webapi` | TCP 3601 + HTTP GET `/swagger/index.html` 200 |
| `generateclient` | 进程存活 + **到 3601 的 ESTABLISHED 连接** |
| `generatetool` | 同上 |
| `shp_plants` / `shp_buildings` | TCP 4000 / 4001 |
| `aigenerate` | TCP 5231 + HTTP GET `/swagger/index.html` |
| `tools` / `ue_templates` | 不判活（纯文件） |

---

## 8. 一次发布的端到端流程

```
1. 98 改代码（98 上服务不运行，无并发写入竞争）
2. 点「发布」
3. 扫描 → 差异 → 组件归因 → 影响面
     web +5198/-194    → 组件 web
     webapi +3109      → 组件 webapi
     GenerateClient/*  → 组件 generateclient
     AutomationUE5.3/* → 组件 tools（asset）
4. 人工闸门：提示本次是否含数据库变更（如需要建 PreviewBlock* 三张表）
5. STAGE：写共享 → 成员拉取 + 构建 + 校验 → 回报 staged
     任一成员 failed → 中止，服务未受影响
6. COMMIT（按依赖序）：generateclient → webapi → web
     每台：查忙 → expectedStop → stop → 切 → start → 探活
7. 收敛：全绿则记版本、GC 旧 release；任一失败 → 受影响 set 整体回滚
```

---

## 9. 配置模型

### 9.1 三层

现场四台机器的共享目录、盘符、目录布局都可能不同，所以路径不能是全局常量。

| 层 | 内容 | 谁维护 |
| --- | --- | --- |
| ① 组件默认 | 有哪些组件、怎么启停、怎么判活、默认端口 | 98 配置页 |
| ② 节点覆盖 | 该节点的 `localRoot` / `port` / 启用与否 / **该节点看到的 `sharedRoot`** | 98 配置页 |
| ③ 本机引导 | `master` 地址、`nodeId`、`secret`、缓存目录 | **各机本地文件，永不下发** |

```yaml
storage:
  sharedRoot: '\\172.16.2.98\Tools'          # ① 默认

nodes:
  172.16.1.145:
    storage:
      sharedRoot: '\\172.16.2.98\sense_automation_v3\tools'   # ② 这台不一样
    components:
      generateclient:
        localRoot: 'E:\SceneAutomationV3\GenerateClient'      # 例如盘符不同
```

### 9.2 第 ③ 层为什么不能远程改

agent 得先知道「连哪台主节点」才能收到配置。这一层要是能被下发，
一次手误就是四台全失联，而且没有第二条路回来。

```json
{ "master": "172.16.2.98:47820", "nodeId": "node-145", "secret": "…", "cacheDir": "C:\\vcsNode\\state" }
```

模板：`config/agent.bootstrap.example.json`。其余一切由主节点下发。

### 9.3 配置页

矩阵：行 = 组件，列 = 机器，格子 = `启用 / localRoot / port`。

```
            98          207         145            149
web         ●3333       ●3071       –              ●3333
webapi      ●3601       ●3601       –              ●3601
generateclient ●        –           ●              ●
generatetool   ●        –           ●              ●
shp_plants  ●4000       –           ●4000          ●4000
tools       ●           –           ●              ●
        ────────────────────────────────────────────────
共享目录    D:\…\Tools  \\…\Tools   \\…\v3\tools    \\…\Tools
```

必须有五个动作，少一个「统一配置」就会变成「统一配错」：

| 动作 | 作用 |
| --- | --- |
| 逐格编辑 + **整列复制** | 145/149 配置相近，复制后只改两处盘符 |
| **探测**（每节点一个） | 在该机上真实执行：路径是否存在、共享是否可读、`.venv` 在不在、端口是否被占 |
| **保存前 diff** | 逐条列出将改哪些机器的哪些字段 |
| **下发并等 ack** | 逐台确认；超时的标黄，不阻塞其他机器 |
| **漂移提示** | agent 上报 `configRevision`，与主节点不一致就高亮 |

探测是最容易跳过、也最致命的一项：配置页最常见的故障是「保存成功，
但那台机器上根本没这个路径」—— 错误要等到下一次发布才炸，而那时人正站在停机窗口里。

### 9.4 版本、回退与失败保护

```
主节点保存 → revision+1 → 原子写 state/config.json
          → 沿 SSE 下发 event: config { revision, payload, hmac }
          → agent 校验签名 → 写 config.<rev>.json
          → 自检（路径存在 / 共享可读）
          → 全通过 → 生效 + ack
          → 任一失败 → 保留旧配置继续跑 + nack 原因
```

三条保护：

1. **fail-safe**：配置下发失败不影响运行，agent 始终保留 `config.last-good.json`
2. **可回退**：保留最近 10 个 revision，页面一键回退
3. **拒绝破坏性配置**：`localRoot` 指向不存在的路径、或两个组件指向同一目录
   （会让变更归因错乱），保存时直接拦下

---

## 10. 安全

这个 agent 能启停任意进程、能读写任意路径。签名泄露就等于全盘接管，所以不能只做一个 HMAC。

| 项 | 方案 |
| --- | --- |
| 鉴权 | 预共享密钥 + HMAC-SHA256，带时间戳与 nonce；窗口 ±5 分钟，nonce 去重防重放 |
| 传输 | 当前在局域网内用 HTTP；若跨网段暴露，必须上 TLS（自签 + 私有 CA） |
| 路径约束 | 所有路径 `path.resolve` 后必须落在配置的 `localRoot` 之下；符号链接 `realpath` 二次校验，防 `../` 逃逸 |
| 指令白名单 | 只能对**配置里存在的组件**执行 `start/stop/restart/commit/rollback`，不接受任意命令行 |
| 共享权限 | 成员只读（`-ro` 账号）；写入限制在 `_vcs`；manifest 带签名，防止共享被篡改后分发 |
| 运行身份 | agent 用专用账号，不用 LocalSystem（否则 SMB 走机器账号，见 5.6） |
| 审计 | 所有指令记 `who / when / node / action / params / result` 到 `events-*.jsonl` |
| 启动参数 | 不接受来自网络的任意命令；`start` 的 cmd/args 只能取自配置，且配置变更需签名 |

---

## 11. 代码结构与实现顺序

### 11.1 四个进程，两个入口，零依赖

```
vcsNode/
├── src/
│   ├── core/      配置解析（三层合并）· 哈希 · manifest · 原子写 · 锁 · 日志 · HMAC
│   ├── agent/     supervisor（启停/指纹/查忙）· 采样（PowerShell）· 指令执行
│   ├── master/    http api · sse · 队列 · 判定 · 发布编排 · 静态 UI
│   └── proto/     信封格式 · 序号 · 错误码
├── bin/
│   ├── master.mjs     只在 98 跑
│   └── agent.mjs      三台成员跑
├── ui/            单页，无构建步骤
└── config/        vcsnode.yaml · agent.bootstrap.example.json
```

**零外部依赖**是有意的：现场机器未必能连外网 `npm install`。
只用 `node:http` / `node:fs` / `node:crypto` / `node:child_process`；
SSE 是普通 HTTP，不需要 `ws`。部署方式 = 拷贝目录 + `node bin/agent.mjs`。

**运行基线是 Node 18**，因为 207 现在装的就是 18（其余三台 20+）。
不要求升级现场环境 —— 代价只是不能用 20+ 才有的 API：

| 不能用 | 用替代 |
| --- | --- |
| `node:sqlite`（22+） | 本来就不用数据库 |
| `fs.glob`（22+） | 自己实现通配匹配，或 `fs.readdir({recursive:true})`（18.17+） |
| `Promise.withResolvers`（22+） | `new Promise(r => …)` |
| `--env-file`（20.6+） | 读 JSON 配置即可 |
| `import.meta.dirname`（20.11+） | `fileURLToPath(new URL('.', import.meta.url))` |
| 内置 `WebSocket` 客户端（22+） | 不用 WebSocket |

SSE 客户端不要用 `fetch` 的流式响应（18 里是实验特性，行为在不同小版本间有差异），
直接用 `node:http` 的 `request` + `'data'` 事件，这样也能精确控制读超时与 abort。

### 11.2 没有数据库，状态怎么存

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 各机组件状态 | 内存 Map | 唯一真相在内存 |
| 待执行指令 + 序号 | `state/queue.json` | 原子写，重启续号 |
| 已确认指令 | 同上，滚动保留最近 500 条 | 够排查即可 |
| 配置 | `state/config.json` + `config.<rev>.json` | 保留 10 个版本 |
| 发布记录 | `state/releases.json` | releaseId → 各机落地状态 |
| 事件流水 | `logs/events-YYYYMMDD.jsonl` | 追加写，一天一个，便于 grep |

写入是分钟级、几 KB 量级，JSON + 原子 rename 完全够。代价是没有事务，
所以要求所有指令幂等（才能在崩溃重启后安全重放队列）。

### 11.3 四步实现，每步可独立验收

| 步骤 | 交付 | 现场价值 | 风险 |
| --- | --- | --- | --- |
| 1 | agent 骨架 + 进程采样 + 上报；98 显示四台机器的进程清单（配置读静态 YAML） | 先看清现状，包括「进程在但 SignalR 断」 | 纯只读 |
| 2 | 主节点 API + SSE + 状态页 + **配置页** | 实时状态；一次把四台路径配齐 | 仍只读 |
| 3 | supervisor 启停 + 查忙保护 | 远程停启，且不打断生成任务 | 第一次动进程 |
| 4 | 扫描 + manifest + STAGE/COMMIT + 一键发布 | 「改完一键同步」 | 最大块 |

第 1 步读静态配置，第 2 步的配置页只是给同一份 schema 套编辑器 ——
**配置模型与 UI 解耦**，避免第一步就被 UI 绑住。

---

## 12. 被否决的方案（决策记录）

留档是为了避免以后有人「顺手加回来」。

| 方案 | 否决原因 | 什么条件下重新考虑 |
| --- | --- | --- |
| 2s 定时轮询 | 丢指令窗口 + 平均 1s 延迟 | 现场链路对长连接极不友好时，降级为长轮询（接口不变） |
| WebSocket | 我们只需单向下发 + 单向上报，双工和帧协议是白付的复杂度 | 需要双向实时交互（如远程终端）时 |
| FileSystemWatcher 监听共享 | SMB `CHANGE_NOTIFY` 会丢事件、缓冲区溢出，漏了就是静默失效 | 永不 |
| 反向隧道（SSH/RDP） | 等于在防火墙上凿洞，运维负担不对等 | 永不 |
| 数据库（sqlite/PG） | 状态量小、写频率低，只增加部署成本 | 需要多主或历史查询时 |
| 外部 npm 依赖（Fastify/ws/zod/sqlite/chokidar…） | 现场可能无外网；依赖越少越能「拷过去就能跑」 | 确认现场可稳定访问 npm 源时 |
| 整目录同步 | 187 MB 前端里大部分不常变，全量推一次要几分钟 | 初次部署（此时确实需要全量，但走单独路径） |
| 目录指针用符号链接 | Windows 符号链接需要管理员权限或开发者模式 | 永不用；用 junction（`mklink /J`，免管理员） |
| 依赖 pm2 自愈 | `autorestart: false`，且 pm2 不管其他组件 | 永不 |
| 在 98 上 publish 产物再分发 | 三台都有 SDK，本地构建更简单，也避免产物与源码不一致 | 某台机器缺 SDK 时 |

---

## 13. 模糊点（待澄清）

按「不回答会阻塞什么」排序。每条都给了**默认做法**，所以不会卡住开发 ——
但默认值是推断，上线前必须核对。标 ✅ 的是已澄清项，留在表里是因为它们解释了后面的设计前提。

| # | 模糊点 | 为什么重要 | 不确认时的默认做法 | 阻塞到 |
| --- | --- | --- | --- | --- |
| 1 | ✅ 共享根路径 | 已澄清 | `\\172.16.2.98\Tools`（207、145、149 实测可读） | 已澄清 |
| 2 | **四台各组件的 `localRoot`**（布局不统一已确认） | `localRoot` 错则扫描/启停全部落空 | `Tools` 已确认：207 = `D:\Digihail\SceneAutoApply\Tools`，其余 = `D:\SceneAutomationV3\Tools`；207 的 web / webapi 留 `null`，第 1 步采样（cwd + ExecutablePath）自动填充 | 第 1 步 |
| 3 | 98 上改的是 git 仓库，还是 `D:\SceneAutomationV3` 下的部署目录？ | 决定扫描器扫哪里；扫错会同步出「仓库有但没部署」或反之 | 认定**部署目录即扫描源**（所见即所跑） | 第 4 步 |
| 4 | 207 上前端真实端口是 3071 还是 3333？`vite.config.ts` 是否被本地改过？ | 端口错则健康检查永远失败；若文件被改过还要进 `localConfig` | 启动时显式 `--port 3071 --strictPort`；用 `Get-NetTCPConnection` 实测 | 第 1 步 |
| 5 | .NET 组件现场跑的是 `Release` 还是 `Debug` 构建？ | 若一直跑 Debug，切 Release 可能改变行为（断言、条件编译） | 按 `Release` 写；若现场是 Debug 则改回，不擅自引入行为变更 | 第 3 步 |
| 6 | 忙碌检测走 A（改 webapi 加接口）还是 B（看任务目录 mtime）？ | 判定错会把正在生成的项目弄坏 | 先上 B；A 作为业务代码的独立需求提 | 第 3 步 |
| 7 | `workerhost` / `aigenerate` 是否在运行？ | 纳管了却没部署会天天报 `crashed`；没纳管则真挂了没人知道 | 默认 `enabled: false`，第 1 步采样到再说 | 第 1 步 |
| 8 | 145 上是否也跑 `shp_plants` / `shp_buildings`？ | 影响 145 的组件表与端口占用判断 | 按「有」配（tools 在 145 上，两个 Node 服务通常随 tools 部署） | 第 2 步 |
| 9 | ✅ Node 版本 | 已澄清 | 207 = **18**；98 / 149 / 145 = 20+ | 已澄清 |
| 10 | agent 以什么身份常驻？LocalSystem 还是专用账号？ | 决定能不能读 SMB；LocalSystem 读不了共享是本节最常见的坑 | 默认专用账号；若只能 LocalSystem 则必须 `cmdkey` 存凭据 | 第 4 步 |
| 11 | 数据库结构变更（如 PreviewBlock 三张表）由谁执行、怎么记录？ | 纯文件同步不足以上线 | 发布流程加人工闸门，vcsNode 只提示不执行 | 第 4 步 |
| 12 | 98 是否也跑业务服务，还是只当发布源？ | 若只当源，98 上 6 个组件都不必纳管，规模减半 | 按「全套运行」处理（此前信息如此） | 第 1 步 |
| 13 | 成员机重启后 agent 怎么自启？Windows 服务（NSSM）还是计划任务？ | 不自启则断电后需要人肉登录，集中管理名存实亡 | 默认 NSSM 注册为服务 | 第 1 步 |
| 14 | 四台机器时间是否同步（NTP）？ | HMAC 时间窗 ±5 分钟依赖时钟；时钟漂移会导致全部请求被拒 | 默认要求 NTP；若无法保证则把窗口放宽到 ±10 分钟 | 第 2 步 |
| 15 | ✅ 三台成员能否读 98 的共享 | 已澄清 | 207、145、149 全部可读（跨网段 445 通） | 已澄清 |
| 16 | agent 的 Node 基线：兼容 18，还是给 207 装 20？ | 决定能否用 20+ 的 API；207 现在是 18，其余 20+ | **按 Node 18 写**（不动现场环境）：只用 18 已稳定的 API，禁用 `node:sqlite`、`fs.glob`、`Promise.withResolvers` | 第 1 步 |
| 17 | 207 的 `Tools` 要不要纳入同步？ | 决定 207 是否也是同步目标，影响组件矩阵 | 默认 `enabled: false`（207 只跑 web+webapi）；若该机 webapi 会本地调 Tools 脚本则改 `true` | 第 2 步 |

---

## 14. 已知风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| 1 | 98 单点：挂了没人判定、成员无处上报 | agent 独立托管；成员用 `config.last-good.json` 维持现状；本地判定兜底 |
| 2 | agent 自身无人守护 | 注册为 Windows 服务（自举问题，不能靠 vcsNode 自己解决） |
| 3 | 控制面连接断开时指令送不到 | 队列持久化 + 序号游标，重连补发；界面三态不撒谎 |
| 4 | 数据库变更不在文件同步范围内 | 人工闸门 + 发布清单 |
| 5 | 共享权限过宽（实测可写） | 成员只读账号 + manifest 签名 |
| 6 | 四台路径/端口不一致，配置易配错 | 三层配置 + 探测 + 保存前 diff + 漂移高亮 |
| 7 | 现场无人值守时发布到一半断电 | STAGE 可重入、COMMIT 幂等；重启后按队列恢复 |

---

## 附录 A 文档地图

| 文档 | 作用 | 什么时候看 |
| --- | --- | --- |
| `docs/architecture.md`（本文） | 唯一权威架构设计 | 先看这个 |
| `docs/components.md` | 事实底账：端口、启动方式、配置项、冲突 | 要确认「到底是什么」时 |
| `docs/protocol.md` | 控制面接口契约：事件、字段、错误码 | 写代码、联调时 |
| `docs/runbook.md` | 安装、启停、发版、回滚、排障 | 上线与日常运维 |
| `docs/archive/` | 早期稿，仅供追溯 | 想知道「为什么当时那么写」 |
