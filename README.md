# VcsNode

内网多机 **文件差异同步 + 进程启停管控** 工具。

98（`172.16.2.98`）是唯一修改源，改完代码点一下，只把**变化的文件**推到另外三台；
需要换文件的组件在人工停止后 1~3 秒内完成覆盖，其余时间只做状态监控和启停。

- 零外部依赖：只用 Node.js 内置模块，无数据库、无构建步骤
- 零入站端口：成员主动出站连 98（SSE 常驻连接），防火墙不用为成员开任何口
- 源码直跑：同步的是**文件**，需要编译的组件在成员本机构建（M3）

> 运行环境：Windows + Node.js **≥ 18**（207 为 v18，其余 v20+，以 18 为基线）

---

## 1. 拓扑

```
        ┌───────────────────────────────┐
        │  98  172.16.2.98              │
        │  vcs-master（内含本机 agent）  │
        │  · 管理界面 / 判定 / 编排      │
        │  · 管本机 9 个组件             │
        └──────────────┬────────────────┘
                       │ 成员主动出站常驻连接（SSE）+ HMAC 签名
        ┌──────────────┼────────────────┐
        │              │                │
   ┌────▼────┐   ┌─────▼─────┐   ┌──────▼────┐
   │  207    │   │   145     │   │   149     │
   │ vcs-agent│  │ vcs-agent │   │ vcs-agent │
   └────┬────┘   └─────┬─────┘   └─────┬─────┘
        └──────────────┴───────────────┘
                       │  SMB 只读
              \\172.16.2.98\Tools\_vcs
```

| 机器 | 承载组件 |
| --- | --- |
| `98` | web · webapi · generateclient · generatetool · workerhost · mcpserver · tools · shp_plants · shp_buildings |
| `207` | web · webapi · mcpserver · tools（tools 暂不纳管） |
| `145` | generateclient · generatetool · workerhost · tools · shp_* |
| `149` | 全套 |

四个进程：98 上一个 `vcs-master`，三台成员各一个 `vcs-agent`。

事务边界（`sets`）：`set-a = 207 + 145`、`set-b = 98`、`set-c = 149`。
同一 set 内必须同版本，跨 set 相互独立。

---

## 2. 能做什么

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 节点观测 | 进程 / 端口 / 到 3601 的连接采样，判定 `running` / `stopped` / `crashed` / `orphan` / `degraded` / `node-offline` / `unknown` | ✅ M0 |
| 扫描变更清单 | 扫描 98 部署目录，按 sha256 比对基线，产出 `state/pending.json`（待同步区） | ✅ |
| 配置页 | 逐格编辑节点 × 组件路径/端口，保存前 diff、行级补丁、写前结构校验、自动备份 | ✅ |
| 启停 | `start` / `stop` / `restart`，按指纹认领真实 pid，`taskkill /T /F`，等端口就绪 | ✅ M1 |
| 更新文件（预同步） | 98 打包到共享 → 成员备份 + sha256 校验 + 临时文件 rename 就地覆盖 | ✅ M2 |
| 同步记录 | 每次落地的文件级明细（逐文件 sha256、各节点落地时间） | ✅ M2 |
| 事件 / 启停流水 | 最近 30 天，落盘 JSONL，界面可分页查询 | ✅ |
| 切换上线 COMMIT | 停 → 覆盖 → 起一键完成 | ⬜ M3 |
| release-switch | 建版本目录 + 构建 + 切 junction + 重启 | ⬜ M3 |
| 一键回退 / `probe` 指令 / 配置下发 / `secondaryMappings` | — | ⬜ |

**M2 的硬闸门**：目标服务必须先是 `stopped`（否则 `409 not_stopped`）；
`sources.<组件>` 必须与 98 的 `localRoot` 逐字相同（否则 `409 layout_mismatch`）；
所有目标机必须在线；覆盖前先备份，写入走临时文件 + rename。

---

## 3. 快速开始

### 3.1 主节点（98）

```powershell
# 1. 拷贝本仓库到 C:\vcsNode
# 2. 改配置：cluster.secret 换成随机长串
notepad C:\vcsNode\config\vcsnode.yaml

# 3. 前台启动（先看日志）
node C:\vcsNode\bin\master.mjs

# 4. 打开管理界面
#    http://172.16.2.98:47821/
```

主节点参数：

```powershell
node bin/master.mjs                            # 默认读 config/vcsnode.yaml，监听 0.0.0.0:47821
node bin/master.mjs --port 47830
node bin/master.mjs --config E:\tmp\vcsnode.yaml
node bin/master.mjs --state  E:\tmp\state --log-dir E:\tmp\logs
node bin/master.mjs --remap D:\SceneAutomationV3=E:\tmp\deploy   # 开发机试跑
node bin/master.mjs --no-local-sample            # 开发机上不采样本机进程
node bin/master.mjs --sample-interval 15000 --offline-ms 45000
```

自检：`(Invoke-WebRequest http://172.16.2.98:47821/healthz).StatusCode` → 期望 `200`。

### 3.2 成员 agent（207 / 145 / 149）

成员**只需要 8 个程序文件**，不要整目录拷：

```
C:\vcsNode\
  bin\agent.mjs
  src\probe.mjs  src\proc.mjs  src\sync.mjs  src\agent-auth.mjs  src\state.mjs
  src\event-log.mjs  src\win-console.mjs
  agent.bootstrap.json      ← 本机唯一手写的文件
  state\                    ← 运行时自动建
  logs\                     ← 服务 stdout/stderr，每组件一个 <组件>.log
  backup\                   ← 覆盖/删除前的旧文件（<relId>\<组件>\<相对路径>）
```

```powershell
robocopy \\172.16.2.98\Tools\_vcs\dist\vcsNode C:\vcsNode `
  bin\agent.mjs src\probe.mjs src\proc.mjs src\sync.mjs src\agent-auth.mjs src\state.mjs src\event-log.mjs src\win-console.mjs `
  /R:2 /W:2

copy C:\vcsNode\config\agent.bootstrap.example.json C:\vcsNode\agent.bootstrap.json
notepad C:\vcsNode\agent.bootstrap.json
```

引导配置（第 ③ 层，永不被主节点下发覆盖）：

```json
{
  "master": "172.16.2.98:47821",
  "nodeId": "node-145",
  "secret": "与主节点 cluster.secret 一致",
  "cacheDir": "C:\\vcsNode\\state",
  "allowControl": false,
  "logDir": "C:\\vcsNode\\logs",
  "backupDir": "C:\\vcsNode\\backup"
}
```

- `allowControl: false`（或不写）= **只读**：收到 `task` 一律回 `nack control_disabled`，不动进程、不写文件
- 要启停/更新文件才改成 `true`，并确认 agent 用的是 `vcsnode` 账号且是本地管理员组成员
- 改这个文件需重启 agent 生效

agent 命令：

```powershell
node C:\vcsNode\bin\agent.mjs                     # 常驻：SSE + 周期采样上报
node C:\vcsNode\bin\agent.mjs --once              # 采样一次，打印 JSON 后退出
node C:\vcsNode\bin\agent.mjs --inventory         # 只列本机进程/端口（不需要主节点）
node C:\vcsNode\bin\agent.mjs --inventory --filter dotnet
node C:\vcsNode\bin\agent.mjs --bootstrap C:\vcsNode\agent.bootstrap.json
node C:\vcsNode\bin\agent.mjs --interval 15000
node C:\vcsNode\bin\agent.mjs --remap D:\Deploy=E:\tmp\fake
```

> 第一次上机先跑 `--inventory`，用真实的 `cwd` / `ExecutablePath` 回填配置页的 `localRoot` / `port`。

**Windows .NET 启动兼容（agent 0.1.4-m2）**：`dotnet` 组件通过隐藏控制台启动，
避免 GenerateClient / GenerateTool 设置 `Console.OutputEncoding` 时因没有控制台而立即退出。
工作目录仍取 `localRoot + start.cwd`，日志仍写 `logs\<组件>.log`，启停和退出审计使用真实业务 PID。
不需要修改或重新编译业务程序；WorkerHost、McpServer 等 `dotnet` 组件也使用该启动路径。

升级已有成员时，覆盖 `bin\agent.mjs`、`src\proc.mjs`，并新增 `src\win-console.mjs`，
然后重启该机 vcsNode agent。只更新主节点不会改变成员的启动方式。现场验收与检查见
[`docs/runbook.md` §10.3](docs/runbook.md#103-windows-net-后台启动立即退出)。

### 3.3 命令行扫描

```powershell
node bin/scan.mjs                     # 比对基线，写 state/pending.json
node bin/scan.mjs --init-baseline     # 把当前状态记为基线（不产生清单）
node bin/scan.mjs --json              # 只输出 JSON
node bin/scan.mjs --max-files 200000
node bin/scan.mjs --remap D:\SceneAutomationV3=E:\tmp\deploy
```

首次运行没有基线 → 自动建基线并产出**空清单**，不会把几万个文件当成「新增」。

### 3.4 注册自启

推荐 Windows **计划任务**（零外部文件）；NSSM 需额外带一个 exe；
不能用 `sc create` 直接跑 node（会报 1053）。账号用专用账号，不要 LocalSystem
（否则 SMB 走机器账号 `COMPUTERNAME$`，收紧共享权限后立刻读不到）。
细节见 `docs/runbook.md` §7。

---

## 4. 一次发版的流程（M2 现状）

```
98 上改代码
  │
  ├─ 扫描            → 待同步区（按组件汇总 + 文件级明细，默认全选，删除项默认不勾）
  ├─ 勾选/跳过/确认   → 是否含删除（includeDeletes）、是否含数据库变更（人工闸门）
  ├─ 复核            → 对勾选文件重新 hash，扫描后又被改过的标黄提示重扫
  │
  ├─ 先停目标组件     → 抽屉「停止」；不停 → 409 not_stopped
  ├─ 预同步          → 98 复制到共享 + manifest → 成员备份/校验/就地覆盖 → ack
  └─ 全绿            → 推进基线、清空待同步区、写同步记录
  │
  └─ 人工起服务 + 业务自检（起不来：看 logs\<组件>.log，或从 backup\<relId>\ 拷回）
```

删除是唯一不可逆的动作：默认不勾，必须显式勾 `includeDeletes`，且执行前先进成员本地
`backup\<relId>\<组件>\`。

失败的语义：单台失败 → `status: partial`，待同步区**原样保留**（不推进基线），
修好后重发即可，已落地的文件会被幂等重写。

---

## 5. 配置

### 5.1 三层配置

| 层 | 内容 | 存哪 |
| --- | --- | --- |
| ① 组件默认 | 有哪些组件、怎么启停、怎么判活、默认端口 | `config/vcsnode.yaml` → `components` |
| ② 节点覆盖 | 该机 `localRoot` / `port` / `enabled` / `sharedRoot` / `health` | `config/vcsnode.yaml` → `nodes` |
| ③ 本机引导 | 主节点地址、`nodeId`、`secret`、`allowControl`、日志/备份目录 | 各机本地 `agent.bootstrap.json`，**永不下发** |

第 ③ 层不能远程改：agent 必须先知道连哪台主节点才能收到配置；
这层若可下发，一次手误就是四台全部失联。

配置页保存只替换目标行，**注释和对齐原样保留**；写前重新解析做结构自检，
对不上就一个字节都不动；落盘前备份到 `config/backup/vcsnode-<时间>.yaml`（保留 10 份）。

### 5.2 扫描源与排除

`sources.*` 指向 **98 上正在运行的那份部署目录**（不是 git 仓库）。
`bin/` `obj/` `node_modules/` `.venv/` `*.log` `*.zip`（UE 模板除外）一律排除；
本机配置 `appsettings.json` / `nlog.config` / `public/config.js` 不同步覆盖。

`tools` 是共享根，混着大量第三方内容（ComfyUI、CesiumLab 等），所以用 `include` **白名单**，
只扫那 11 个目录 + 两个 UE 模板 zip。

### 5.3 关键约束

| 约束 | 不满足 |
| --- | --- |
| `sources.<组件>` = 98 的 `localRoot`（逐字相同） | `layout_mismatch`，连共享都不写 |
| 目标组件不能是 `running` / `degraded` | `not_stopped`（除非显式 `force`） |
| 所有目标机必须在线 | `node_offline`，一台都不发 |
| 路径只能是组件根下的相对路径，不许 `..` / 盘符 / 绝对路径 | `bad_path` |
| 共享上的 blob sha256 必须等于 manifest | `sha_mismatch`，目标文件保持原样 |

---

## 6. 目录结构

```
vcsNode/
├── bin/
│   ├── master.mjs          主节点：静态 UI + /api/ui/* + /api/agent/{stream,report} + 本机采样
│   ├── agent.mjs           成员：出站 SSE + 周期采样上报 + 执行 start/stop/restart/stage
│   └── scan.mjs            命令行扫描器
├── src/
│   ├── yaml.mjs            配置解析 + 行级定位
│   ├── config-edit.mjs     行级补丁、写前结构校验、备份、revision
│   ├── ignore.mjs          排除规则（gitignore 语法）
│   ├── scan.mjs            遍历 / sha256 / 与基线比对 / 归因
│   ├── release.mjs         98 侧打包：复制 + 算 sha256 + manifest + 基线推进 + 记录
│   ├── sync.mjs            成员侧落地：路径校验 + 备份 + 校验 + rename + 删除
│   ├── probe.mjs           进程表 / 端口 / 连接采样，按 identify 认进程，探活
│   ├── node-state.mjs      观测 → 结论（running / stopped / crashed / orphan / degraded …）
│   ├── nodes.mjs           节点注册表 + SSE 通道 + 落盘 + sendTask
│   ├── proc.mjs            认 pid、taskkill /T /F、spawn detached、等就绪、重启
│   ├── win-console.mjs     Windows dotnet 隐藏控制台启动、真实 PID 和退出回传
│   ├── agent-auth.mjs      两端共用 HMAC-SHA256（时间窗 + nonce 防重放）
│   ├── event-log.mjs       事件流水（JSONL，保留 30 天）
│   └── state.mjs           原子写 JSON（临时文件 + rename）
├── ui/
│   ├── index.html          单页管理界面（总览 / 待同步区 / 同步记录 / 启停记录 / 配置 / 事件）
│   ├── app.js
│   └── app.css
├── config/
│   ├── vcsnode.yaml        四台机器的组件/路径/端口/事务 set
│   ├── agent.bootstrap.example.json
│   └── backup/             配置保存前的自动备份
├── docs/
│   ├── architecture.md     架构设计（先看这个）
│   ├── components.md       组件清单、目录契约、关键配置
│   ├── protocol.md         控制面协议与 /api/ui/* 契约
│   ├── runbook.md          部署、验收、日常操作、故障处置
│   ├── ui.md               界面说明
│   └── archive/            完整论证与被否决方案
├── state/                  运行时：baseline.json / pending.json / landed.json /
│                            nodes.json / config-revision.json / releases/ / actions/
├── logs/                   master 事件流水 events-*.jsonl + 各组件服务日志
├── tools/                  辅助脚本（smb-probe.ps1、serve-ui.mjs 等）
├── clone.log
└── README.md
```

---

## 7. 状态与接口

### 7.1 运行时状态文件

| 文件 | 内容 |
| --- | --- |
| `state/baseline.json` | 基线：组件 → 路径 → `{ sha256, size, mtimeMs }` |
| `state/pending.json` | 最近一次扫描的变更清单（草稿，带 id 和时间） |
| `state/landed.json` | 哪台机器上已经是哪份内容（按文件） |
| `state/nodes.json` | 节点注册表与最近观测 |
| `state/config-revision.json` | 配置 revision |
| `state/releases/` | 同步记录（摘要 + 文件级 manifest） |
| `state/actions/` | 启停台账（保留 30 天） |
| `logs/events-*.jsonl` | 事件流水（保留 30 天） |

### 7.2 HTTP 接口

**控制面（成员 ↔ 主节点，HMAC 签名）**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/agent/stream?since=<seq>` | 成员常驻 SSE；`since` 用于断线续传 |
| `POST` | `/api/agent/report` | `hello` / `snapshot` / `ack` / `nack` / `probe` |

**管理端（98 本机界面调用；写接口只接受回环与 `cluster.allowedPeers`）**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/healthz` | 自检：pid、端口、扫描源数量 |
| `POST` | `/api/ui/scan` | 现场扫描一次（没有基线先建基线） |
| `GET` | `/api/ui/pending` | 最近一次变更清单 |
| `POST` | `/api/ui/stage` | 打包到共享并让成员就地覆盖（M2） |
| `GET` | `/api/ui/releases` | 同步记录列表（最多 50 条） |
| `GET` | `/api/ui/releases/{relId}` | 单次同步的文件级明细 |
| `POST` | `/api/ui/task` | 下发 `start` / `stop` / `restart` |
| `GET` | `/api/ui/nodes` | 各节点实时状态 |
| `GET` / `POST` | `/api/ui/config` | 读配置 / 保存配置（行级补丁 + 校验） |
| `POST` | `/api/ui/config/probe` | 探测主节点本机路径是否存在 |
| `GET` | `/api/ui/events` | 事件流水分页 |
| `GET` | `/api/ui/actions` | 启停记录分页 |

字段形状、错误码与超时语义见 `docs/protocol.md` §4 / §8。

### 7.3 节点状态判定

| 状态 | 依据 | 处置 |
| --- | --- | --- |
| `node-offline` | 超过 `offlineMs`（默认 45s）没有任何上报 | 只告警，不重启 |
| `crashed` | 连接正常，进程不在（非人为停止） | 可拉起（M3 自愈） |
| `orphan` | 进程不在但端口被别人占 | 不重启，先查占用 |
| `degraded` | 进程在，但探活没过（到 3601 的连接断了 / 端口没监听） | 重启该客户端 |
| `stopped` | 进程不在，端口也没人占 | 如实显示 |
| `unknown` | `localRoot` 不存在 / 还没收到观测 / 观测过期 | 先修配置或看 agent 日志 |

`degraded` 最容易被漏：进程活着、窗口正常、端口也在，但没连上 webapi
（典型原因：`appsettings.json` 里的 `SignalRUrl` 指错了机器）。
所以连接型判活**必须按 pid 过滤**，并核对远端地址。

---

## 8. 里程碑

| 步骤 | 交付 | 状态 |
| --- | --- | --- |
| 1 | agent 骨架 + 进程采样 + 上报；98 显示四台进程清单 | ✅ 2026-10-28 |
| 2 | 主节点 API + SSE + 状态页 + 配置页 | ✅ |
| 3 | 扫描 + 变更清单（待同步区） | ✅ |
| 4 | supervisor 启停 + 查忙保护 | ✅ 启停已通；跨组件查忙待 M3 |
| 5a | 更新文件（M2）：打包到共享 + 成员备份/校验/就地覆盖 + 同步记录 | ✅ 2026-10-28 |
| 5 | STAGE / COMMIT + 一键同步 + release-switch + 一键回退 | ⬜ M3 |

尚未实现：`commit` / `probe` 指令、`release-switch` 的构建与切 junction、一键回退、
待同步区勾选落盘（现在勾选只存在界面内存里）、配置回退、`secondaryMappings`。

---

## 9. 安全

- 两端 HMAC-SHA256 签名，含时间戳窗口与 nonce 防重放；四台机器要求 NTP 同步
- 写接口只接受回环地址与 `cluster.allowedPeers`（`172.16.1.0/24`、`172.16.2.0/24`），其余 `403`
- 只能对**配置里存在的组件**执行 `start/stop/restart`，不接受任意命令行
- 路径必须落在组件根之下（`realpath` 二次校验，防 `../` 逃逸）
- SMB 共享对成员**只读**，`vcsnode-rw` 只给 98；收紧共享权限时注意 agent 运行身份
- 全程审计到事件流水；agent 侧另写 `logs/actions-*.jsonl`

---

## 10. 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | **先看这个**：整体设计、三条约束、同步与启停的取舍 |
| [`docs/components.md`](docs/components.md) | 组件清单、仓库→部署路径映射、关键配置、待确认项 |
| [`docs/protocol.md`](docs/protocol.md) | SSE 事件、上报格式、序号/租约、错误码、管理端接口 |
| [`docs/runbook.md`](docs/runbook.md) | 部署前检查、安装、M0/M1/M2 验收、日常操作、故障处置 |
| [`docs/ui.md`](docs/ui.md) | 页面结构、各视图要点、交互约定 |
| [`docs/archive/`](docs/archive/) | 完整论证与被否决方案 |

### 术语（界面文案 ↔ 内部）

| 界面文案 | 内部 | 含义 |
| --- | --- | --- |
| 待同步区 | `state/pending.json` | 扫描结果落成的可编辑草稿 |
| 变更清单 | diff list | 待同步区里的文件级明细 |
| 本次跳过 | `skipList` | 不进这次同步；下次扫描仍出现但不默认勾选 |
| 扫描 | scan | 只读比对，产出变更清单 |
| 预同步 | STAGE / 就地覆盖（M2） | 98 打包到共享 → 成员备份 + 校验 + 写进 `localRoot`；服务必须先停 |
| 切换上线 | COMMIT | 停 → 覆盖 → 起（M3） |
| 回退 | rollback | M2 从成员 `backup\<relId>\` 拷回；M3 做一键 |
| 认领 | adopt | 认领现有人工启动的进程，不改变启动方式 |
| 一套 | set | 事务边界，如 `set-a = 207 + 145` |
| 假活 | `degraded` | 进程在，但没连上 webapi（SignalR 断） |
| 忙 | `busy` | 正在跑生成任务，此时禁止停/重启/切换 |

## 11. 启动回归验证

Windows 上安装可构建 .NET 8 的 SDK 和 .NET 8 运行时后，运行 `node --test`。
测试使用独立的临时 .NET 程序复现控制台编码异常，验证隐藏窗口、参数/目录/环境/日志、
真实 PID 停止与重启、端口释放，以及 agent 退出后业务进程继续运行。不会启动实际生成服务；
测试结束后清理模拟进程及临时文件。
