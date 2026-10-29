# 组件清单（从代码推导）

> **定位**：本文件是「事实底账」—— 只记录从仓库代码/配置里能读到、或现场实测过的客观事实。
> 设计与决策不在这里，见 `docs/architecture.md`。
>
> 依据：`E:\vcsNode\project`，`main` @ `a076978`（2026-10-25 23:59，2026-10-26 拉取）。
> 本文只做「代码/配置里能读到的事实」与「明确标注的推断」，不含未核验的运行状态。

## 1. 环境与机器对应（来自 `docs/部署配置/试运行运维交接手册.md`）

| 环境 | 机器 | 前端端口 | 后端端口 | 数据库 | 职责 |
| --- | --- | --- | --- | --- | --- |
| 测试环境 | `172.16.2.98` | 3333 | 3601 | 本机 PostgreSQL | 全套集中部署 |
| 生产-网站服务器 | `172.16.1.207` | 3071 | 3601 | 本机 PostgreSQL | 前端 + 后端 + 库 |
| 生产-生成服务器 | `172.16.1.145` | 不对外开放 | 不对外开放 | 不承载主库 | 生成客户端、工具链、UE/CE/QGIS |

与既有拓扑一致：

- set-b = 98（全套）
- set-a = 207（web + webapi）+ 145（generateclient + generatetool）
- set-c = 149（全套，IP 为 `172.16.1.149`，与 207/145 同网段）

## 2. 组件表

| id | 名称 | kind | 工程入口 | 端口 | 部署机器 |
| --- | --- | --- | --- | --- | --- |
| `web` | Web 前端 | service | `WEB前端/scene-generation-client`（Vue3 + Vite5，产物 `dist/`） | 98:3333 / 207:3071 | 98, 149, 207 |
| `webapi` | 主后端 SceneAutoApply | service | `WEB后端/SceneAutoApply/SceneAutoApply`（.NET 8 ASP.NET Core） | 3601 | 98, 149, 207 |
| `generateclient` | 生成客户端 | service | `WEB后端/SceneAutoApply/GenerateClient`（.NET 8 控制台 + SignalR） | 无入站 | 98, 149, 145 |
| `generatetool` | 辅助工具客户端 | service | `WEB后端/SceneAutoApply/GenerateTool`（.NET 8 控制台 + SignalR） | 无入站 | 98, 149, 145 |
| `workerhost` | 统一 Worker 宿主 | service | `WEB后端/SceneAutoApply/SceneAutomation.WorkerHost`（控制台宿主） | 无入站 | 98, 149, 145 |
| `mcpserver` | MCP Server（Agent 工具入口） | service | `WEB后端/SceneAutoApply/SceneAutoApply.McpServer` | 7077 | 98, 149, 207 |
| `aigenerate` | AI 生成服务 | service（可选） | `AI生成/AIGenerate/AIGenerate`（.NET 8 + Python） | 5231 | 待确认 |
| `tools` | 工具链 | asset | `Tools/*`、`Unreal脚本/AutomationUE5.3`、`CityEngine脚本/SceneAutomationGeneration` | - | 98, 149, 145 |
| `revit` | Revit 插件 | asset（客户端侧） | `Revit插件/RevitVersion` | - | 不在这四台 |

### 明确排除在同步/监控之外

- **PostgreSQL（5432）**：系统依赖，但不属于「自动生成系统」同步单元，重启策略也不同。
- **UE / CityEngine / QGIS / CesiumLab 本体**：外部安装软件，只同步脚本，不管理其进程。
- **`Revit插件`**：装在设计人员客户端上，不在服务端。
- **`SceneAutoApply.StateMigration`**：一次性迁移工具（只有一个 `Program.cs`），非常驻进程，不做同步/监控。

## 3. 启动顺序（手册第 7.1 节）

```text
数据库 → webapi(3601) → web(3333/3071) → generatetool → generateclient → workerhost → mcpserver → aigenerate
```

停止顺序相反，且必须先确认没有正在跑的生成任务。

### 3.1 各组件的实际启动形态（2026-10-26 现场确认）

| 组件 | 启动命令 | 工作目录要求 | 配置文件从哪读 | 更新方式 |
| --- | --- | --- | --- | --- |
| `web` | `npm run dev`（= `vite`） | 项目根 | `public/config.js`（浏览器侧）、`vite.config.ts` | 就地覆盖，HMR 不重启 |
| `webapi` | `dotnet .\SceneAutoApply.dll` | 含 `appsettings.json` 的目录 | `Directory.GetCurrentDirectory()`（默认 Builder 的 ContentRoot） | 新目录 + 重启 |
| `generateclient` | `dotnet .\GenerateClient.dll` | 同上 | `ConfigHelper` 显式 `SetBasePath(GetCurrentDirectory())`，`optional: false` | 新目录 + 重启 |
| `generatetool` | `dotnet .\GenerateTool.dll` | 同上 | 同上 | 新目录 + 重启 |
| `shp_plants` | `node index.js` | 组件根 | 目录内配置 | 就地覆盖 + 重启 |
| `shp_buildings` | `node index.js` | 组件根 | 同上 | 就地覆盖 + 重启 |
| `workerhost` | `dotnet .\SceneAutomation.WorkerHost.dll` | 含 `appsettings.json` 的目录 | 同上（`ContentRootPath = AppContext.BaseDirectory`，注意与 cwd 的双重约束） | 新目录 + 重启 |
| `mcpserver` | `dotnet .\SceneAutoApply.McpServer.dll --transport http --port {port}`（98=7077、149 覆盖成 7080） | 含 `appsettings.json` 的同步目录 | 目录内 `appsettings.json` + `Mcp__*` 环境变量 | 新目录 + 重启 |

三条由此推出的硬约束：

1. **`dotnet xxx.dll` 不读 `launchSettings.json`**，webapi 的 `applicationUrl: http://*:3601`
   只在 `dotnet run` 时生效。必须显式设置 `ASPNETCORE_URLS`，否则默认只监听 `localhost:5000`。
2. **配置按 cwd 解析**，不是按 DLL 目录。`appsettings.json` 必须和启动时的工作目录一致。
   因此部署布局固定为：**同步目录 = `localRoot`，DLL 与 `appsettings.json` 同级平铺**
   （`dotnet publish -o <同步目录>`），启动写 `dotnet .\X.dll`。
3. **`start.cwd` 一律相对 `localRoot`**（`.` 或缺省 = `localRoot` 本身）。四台机器路径不同，
   在配置里写绝对路径只可能对一台有效。成员执行时的解析规则：
   `cwd = localRoot`（先做 `--remap` 后的实际路径）→ `cmd` 若含路径分隔符且是相对路径，按 `cwd` 解析 →
   `args` 里的相对路径同样按 `cwd` 解析。**98 由人工操作**，不参与启停；启停只在成员机执行。
4. **启动成功 = 认出来的 pid + 端口在监听**（不是 spawn 返回值）。所以 `identify` / `port` 配错时，
   启动会停在 `start_timeout` 而不是假装成功 —— 这也是「配置先过只读阶段」的价值。
5. `start.timeoutMs`（可选，默认 30000）：等就绪的上限。dotnet 冷启动慢、或 EDR 拖慢的机器上可调大。
6. 服务进程是 **detached** 的，输出落到成员本地 `<logDir>\<组件>.log`：agent 重启不会带走业务进程，
   但**也意味着机器重启后不会自己起来**（M1 不打算常驻守护，靠界面/人工）。

> 另：`web` 的 `cmd: npm` 在 Windows 上其实是 `npm.cmd`，直接 CreateProcess 起不来。
> M1 已在 `src/proc.mjs` 里处理：命令解析到 `.cmd` / `.bat` 时自动经 `cmd.exe /d /s /c` 起，
> 所以现在的配置**不用改**也能启动；代价是那种组件的 spawn pid 是 `cmd.exe`，
> 真实 pid 仍以 `locate()` 认出来的为准（停止也按真实 pid 杀整棵树）。
> 若想少一层壳，可改成 `node node_modules\vite\bin\vite.js --port {port}`。

## 4. 依赖 DAG（决定 COMMIT 阶段的切换/重启顺序）

```text
                     ┌──────────────┐
                     │  postgres    │  (不管理)
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │   webapi     │  3601  /chatHub (SignalR)
                     └──┬───┬───┬───┘
             ┌──────────┘   │   └──────────┐
      ┌──────▼─────┐  ┌─────▼──────┐  ┌────▼─────────┐
      │    web     │  │generatetool│  │generateclient│
      └────────────┘  └────────────┘  └──────────────┘
                            │
                     ┌──────▼───────┐
                     │  aigenerate  │ (可选)
                     └──────────────┘

      tools (asset) 不参与 DAG，纯文件，切换即可，无需重启
```

**跨节点注意**：set-a 里 `webapi` 在 207、客户端在 145。依赖边跨机器，事务必须按 set 整体推进，不能按节点各自为政。

## 5. 目录契约

### 5.1 仓库路径 → 部署路径

> 下表是 **98 的**路径。四台的部署根不统一（已确认），其余机器以配置页的
> `nodes.<ip>.components.*.localRoot` 为准。

| 仓库路径 | 部署路径（98） | 依据 |
| --- | --- | --- |
| `WEB前端/scene-generation-client`（build 产物） | 待确认（前端站点根） | 手册 14.1 标「待确认」 |
| `WEB后端/SceneAutoApply/SceneAutoApply`（publish） | 待确认 | 同上 |
| `WEB后端/SceneAutoApply/GenerateClient`（publish） | 待确认 | 同上 |
| `WEB后端/SceneAutoApply/GenerateTool`（publish） | 待确认 | 同上 |
| `Tools/*` | `D:\SceneAutomationV3\Tools\*` | 手册 5.2 + 207 探测确认共享根即 `Tools` |
| `Unreal脚本/AutomationUE5.3` | `D:\SceneAutomationV3\Tools\AutomationUE5.3` | 同上，探测中确认该目录在共享根下 |
| `CityEngine脚本/SceneAutomationGeneration` | `D:\SceneAutomationV3\Tools\SceneAutomationGeneration` | 手册 5.2 |

**M2 的硬约束：`sources.<组件>` 必须和 98 的 `localRoot` 逐字相同。**

预同步是「就地覆盖」，`rel` 路径按组件根拼到成员自己的 `localRoot` 上。所以扫描源必须是
98 **正在运行**的那份文件，而不是仓库里的源码 —— 否则会把 `.cs` 覆盖进 publish 目录，
服务下次启动直接起不来。代码里用 `layout_mismatch` 拦住，不是靠人记得。

98 上这六个 dotnet/web 组件跑的就是 **build 后的产物**，所以 `sources` 直接指产物目录
（2026-10-28 已改）：

| 组件 | `sources` = 98 `localRoot` |
| --- | --- |
| `web` | `E:\nginx\html\dist` |
| `webapi` | `E:\SceneAutomationBuild\SceneAutoApply` |
| `generateclient` | `E:\SceneAutomationBuild\GenerateClient` |
| `generatetool` | `E:\SceneAutomationBuild\GenerateTool` |
| `workerhost` | `E:\SceneAutomationBuild\SceneAutomation.WorkerHost` |
| `mcpserver` | `E:\SceneAutomationBuild\SceneAutoApply.McpServer` |
| `tools` | `D:\SceneAutomationV3\Tools`（带 `include` 白名单） |
| `shp_plants` | `D:\SceneAutomationV3\Tools\ShapefileTool.Plants.20230905` |
| `shp_buildings` | `D:\SceneAutomationV3\Tools\ShapefileTool.Buildings.20230905` |

三个必须知道的前提：

1. **改完 `sources` 要重建基线**：`node bin\scan.mjs --init-baseline`。否则第一次扫描会把
   整份产物目录当成「新增 N 个文件」，待同步区直接失控。
2. **`aigenerate` 没有 `sources`**：组件定义里有它（5231 端口），但没有任何 `sources` 条目，
   所以它不参与扫描 —— 想让它能发，得先补一条 `sources.aigenerate`。
3. **全局 `exclude` 对产物目录同样生效**：`appsettings.json`、`nlog.config`、
   `public/config.js`、`*.pdb`、`*.log`、`bin/`、`obj/` 都不会进清单。
   也就是说 98 上改连接串/日志级别**不会**被同步 —— 这是刻意的（每台机器的配置各自维护，
   见 `storage.localConfigRoot`），别指望它。

### 5.2 运行期数据目录（**不参与同步**）

```text
D:\SceneAutomationV3\ProjectFolder    项目与资源
D:\SceneAutomationV3\TaskFolder       任务产物与模块日志
D:\SceneAutomationV3\Task             GenerateClient 的 Task.json
D:\SceneAutomationV3\MapDownload      建筑 AI 瓦片缓存
D:\SceneAutomationV3\P4Workspace      P4 工作区
```

这三类必须从同步与扫描中排除，否则会把几十 GB 任务产物当作增量。

## 6. 关键配置项（已核实的实际值）

### 6.1 webapi

```text
监听             http://*:3601        (launchSettings)
Swagger          /swagger
SignalR Hub      /chatHub
数据库           PostgreSQL 本机
DistributedGeneration.Enabled = false   ← 当前未启用分布式
ProjectFolder    D:\SceneAutomationV3\ProjectFolder
TaskFolder       D:\SceneAutomationV3\TaskFolder
GenerateTaskDir  D:\SceneAutomationV3\Task
SharedFolder     \\172.16.1.207\ShareFolder
```

### 6.2 generateclient

```text
SignalRUrl       http://172.16.1.145:3601/chatHub
ToolFolder       D:\SceneAutomationV3\Tools
PyQgisBat        C:\Program Files\QGIS 3.34.8\bin\python-qgis-ltr.bat
UE 植物服务      http://172.16.1.145:4000
UE 建筑服务      http://172.16.1.145:4001
MapServer        \\172.16.0.116\TMSMapServer\2025\AutoGenerate
BuildingServer   \\172.16.0.116\BuildingData\AutoGenerte
```

### 6.3 generatetool

```text
SignalRUrl       http://172.16.1.145:3601/chatHub?clientId=RegisterTool
```

### 6.4 aigenerate

```text
Server.HttpPort  5231
SceneAutoApply   http://223.223.200.250:3086
Storage          App_Data/{Tasks,GeoJsonTasks,Logs}
```

### 6.5 web

```text
dev/preview 端口  3333
build            node bin/build.js  → dist/
API 代理目标      VITE_API_TARGET，默认 http://223.223.200.250:3087
```

## 7. 配置冲突（部署前必须现场核对）

### 7.1 SignalR 地址指向自己 —— 已定性为「仓库配置错误」

手册 4.1 / 6.3 明确：`GenerateClient` 与 `GenerateTool` 的 `SignalRUrl` 应指向**网站服务器**（`172.16.1.207:3601`）。

但仓库里的配置写的是 `172.16.1.145:3601`——也就是生成服务器自己。

**已确认（2026-10-26）**：145 上只有 `generateclient` + `generatetool`（+ tools），**没有 webapi**。

因此仓库里的这个值是错的：原样部署到 145，客户端会去连一个不存在的后端，
表现为「进程活着、端口正常、但永远注册不上」（即 `degraded`：进程在、SignalR 断）。

**处置**：`GenerateClient/appsettings.json`、`GenerateTool/appsettings.json` 一律列入同步排除，
各机独立维护；145 上必须写成 `http://172.16.1.207:3601/chatHub`。

这条也是「配置文件不能跟着代码走」最直接的证据。

### 7.2 生产前端端口 3071 没有出处

仓库里只体现 3333（vite）。3071 只出现在运维手册里。需要确认 207 上用什么承载（`vite preview` / Nginx / IIS / 静态服务），否则没法生成正确的 `start` 命令。

### 7.3 `DistributedGeneration.Enabled = false`

仓库默认是关的，但现场已确认在跑并纳入管理（98 / 149 / 145）；它挂了，所在节点的生成任务就没人消费。

## 8. 监控判定建议

| 组件 | 判定方式 | 理由 |
| --- | --- | --- |
| `web` | TCP 端口 + HTTP GET `/` 返回 200 | 静态站点，端口监听即基本可用 |
| `webapi` | TCP 3601 + HTTP GET `/swagger` 200 | Swagger 开了说明 DI/路由装配完成 |
| `generateclient` | 进程存活 + **到 3601 的 ESTABLISHED 连接** | 「进程在但没连上」是最常见的假活状态 |
| `generatetool` | 同上 | 断线会导致后端报 `RegisterToolNotExist` |
| `workerhost` | 进程存活 + 到 `/generationWorkerHub` 的连接 | 同上 |
| `aigenerate` | TCP 5231 + HTTP GET `/swagger` | 与 webapi 同理 |
| `tools` | 不判活 | 纯文件 |

**关键结论**：`generateclient` / `generatetool` 没有入站端口，**不能靠端口判活**。只看进程会漏掉「进程在、SignalR 断了」这种最常见的故障，必须叠加「到后端 3601 的连接是否存在」这一条。

### 8.1 怎么认出「我们的那个进程」（M0 已实现）

| 依据 | 用在哪 | 注意 |
| --- | --- | --- |
| **端口归属** | `web` 3333/3071、`webapi` 3601、`mcpserver` 7077（149 覆盖 7080）、`shp_plants` 4000、`shp_buildings` 4001 | 最硬的证据。端口被**别人的**进程占着时不认领，报 `orphan` |
| **进程名 + 命令行关键字** | `generateclient` / `generatetool` / `workerhost`（认 `xxx.dll`）；`mcpserver` 允许 `dotnet.exe` 与 `X.exe` 两种形态 | 一台机器十几个 `dotnet.exe`，只看进程名必然认错/杀错 |

`shp_plants` 的启动命令是 `node index.js`，**命令行里根本没有目录名**，
所以 `identify.cmdlineIncludes: ["ShapefileTool.Plants"]` 实际匹配不上 ——
它能被认出来纯粹是因为端口 4000 归它。改配置时别把端口删了，
否则这两个组件会退化成「认不出进程」。

读不到命令行（非管理员读别的用户的进程）时，只有带端口的组件还能认；其余的报
`matchBy=null` + `notes`，界面上显示「未观测」。要完整信息就用专用账号跑 agent。

## 9. Tools 明细（已实测）

| 目录 | 做什么 | 端口 | 启动方式 |
| --- | --- | --- | --- |
| `AssetPipelineTool` | 资产管线：智能植被 / 精概街块 / OSM 路网 / 建筑 / 建筑智能识别 / 地图下载 / 地图缓存 | 无 | CLI：`.venv\Scripts\python.exe main.py <子命令>`；街块还走 `-m modules.street_block_20260423.prepare_geometry` |
| `DemProcessTool` | DEM 地形：高程提取 / 修改 / 压平 / 切片 / 合成 / 解压 | 无 | CLI：`main.py {extract,modify,flatten,tiler,compose-terrain,unzip}` |
| `GisFileTools` | GIS 文件：坐标系校验、SHP/TIF 切分裁剪合并、DEM 取高、PCG | 无 | CLI：`main.py <子命令>` |
| `GlbDatasmithTool` | 场景 JSON + GLB → UE Datasmith 资产 | 无 | .NET 控制台 exe，一次性 |
| `PyQgisTools` | SHP 数据体检：NaN / 字段 / 几何有效性 | 无 | `C:\Program Files\QGIS 3.34.8\bin\python-qgis-ltr.bat` |
| `RevitTools` / `2020` / `2024` | Revit 插件（DLL） | 无 | Revit 进程内加载，客户端侧 |
| `ShapefileTool.Buildings.20230905` | 建筑 SHP 处理 HTTP 服务 | **4001** | `node index.js` 或 `pm2 start pm2.config.cjs`（进程名 `building`） |
| `ShapefileTool.Plants.20230905` | 植被 SHP 处理 HTTP 服务 | **4000** | `node index.js` 或 `pm2 start pm2.config.cjs`（进程名 `plant`） |
| `TaskJson` | Task.json 模板与契约 | 无 | 数据文件 |

**关键纠正**：`GenerateClient` 配置里的 `UEPlantServerBaseUrl(:4000)` / `UEBuildingServerBaseUrl(:4001)` 名字带 UE，实际是上面两个 **Node express 服务**，与 Unreal 无关。

除 4000/4001 外，Tools 下**没有任何监听端口**，其余全部是短命 CLI 子进程。

### 9.1 `cmd.exe` 有两种语义，监控必须区分

| 类型 | 形态 | 生命周期 | 该不该监控 |
| --- | --- | --- | --- |
| 常驻宿主 | `cmd.exe` → `dotnet GenerateClient.dll` | 长期 | **该监控** |
| 瞬时工具 | `cmd.exe /c .venv\Scripts\python.exe main.py ...` | 秒~小时 | 不该，会误判 |

后端用 `ExternalProgramHelper.ExeProcess()` 以 `cmd.exe /c <命令>` 方式拉起工具，每个生成任务都会产生多次。因此身份识别必须是 `dotnet.exe` + 命令行含 `GenerateClient.dll`，不能按 `cmd.exe` 计数。

### 9.2 `.venv` 是硬依赖，且不可跨机复制

所有 Python 工具都通过 `<工具目录>\.venv\Scripts\python.exe` 调用。`.venv` 内含绝对路径，跨机器复制会失效，因此：

- 同步必须**排除 `.venv`**
- 每台机器首次部署时自行 `uv sync`（`uv.lock` 已在仓库中）
- 监控不覆盖 `.venv` 的存在性，初始化属于一次性人工步骤

### 9.3 UE 模板 zip 是功能依赖，不能按 `*.zip` 一刀切

`UEProjectTemplateHelper` 会读取 `<Tools>\TP_TuguanStreaming.zip`（V4）与 `TP_TuguanStreamingV5.zip`（V5）自动解压生成 UE 模板工程。

因此排除规则不能笼统写 `*.zip`，必须显式放行这两个文件；其余大包按 `asset` + 手动同步处理。

## 10. 待确认清单

**已确认：**

| 项 | 结论 |
| --- | --- |
| 145 上有没有 webapi | **没有**（见 7.1） |
| 149 的地址 | `172.16.1.149` |
| .NET 启动形态 | `dotnet xxx.dll`（先构建） |
| web 启动形态 | `npm run dev` |
| 成员机 .NET SDK | 三台都有 |

**仍待确认（组件层面）：**

1. ~~98 上被修改的是 git 仓库源码，还是部署目录~~ → **已确认：部署目录**
2. 98 / 207 的部署目录里是否含 `.csproj` / `.cs` 源码（还是只有编译产物）？
3. 前端在生产（207:3071）用什么承载？实际监听 3071 还是 3333？
4. `aigenerate` 是否在运行？（`workerhost` 已确认纳管）
5. 145 上是否也跑 `shp_plants` / `shp_buildings`？

> 完整的待定清单（含默认做法）见 `docs/architecture.md` 第 7 节。
