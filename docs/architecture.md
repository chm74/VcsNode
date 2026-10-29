# vcsNode 架构设计

> 2026-10-26 · 简明版
>
> 只管两件事：**把 98 改过的文件同步到另外三台**、**远程关闭/启动这些机器上的服务**。
>
> 配套文档：事实底账 `components.md` · 接口契约 `protocol.md` · 运维 `runbook.md` ·
> 界面 `ui.md` · 完整论证与被否决方案 `archive/architecture-2026-10-26-full.md`

---

## 0. 一句话

98 是唯一的修改源。改完代码点一下，**只把变化的文件**推到另外三台；需要重启的组件在
1~3 秒内完成换版，其余时间只做看状态和启停。

```
        ┌───────────────────────────────┐
        │  98  172.16.2.98              │
        │  vcs-master                   │
        │  · 管理界面 / 判定 / 编排      │
        │  · 管本机 6 个组件             │
        └──────────────┬────────────────┘
                       │ 成员主动出站长连接（SSE）
        ┌──────────────┼────────────────┐
        │              │                │
   ┌────▼────┐   ┌─────▼─────┐   ┌──────▼────┐
   │  207    │   │   145     │   │   149     │
   │ vcs-agent│  │ vcs-agent │   │ vcs-agent │
   └────┬────┘   └─────┬─────┘   └─────┬─────┘
        └──────────────┴───────────────┘
                       │  SMB 只读（已验证三台均可读）
              \\172.16.2.98\Tools\_vcs
```

| 机器 | 承载组件 |
| --- | --- |
| `98` | web · webapi · generateclient · generatetool · workerhost · mcpserver · tools · shp_* |
| `207` | web · webapi · mcpserver |
| `145` | generateclient · generatetool · workerhost · tools |
| `149` | 全套 |

**只有四个进程**：98 上 `vcs-master`（内含本机 agent），三台成员各一个 `vcs-agent`。
零外部依赖（只用 Node 内置模块），无数据库。

---

## 1. 三条约束决定了整个设计

| 约束 | 决定 |
| --- | --- |
| 98 → 成员 47821 入站被防火墙拦 | 成员**主动出站**建一条常驻连接，98 沿它下发 |
| 组件是源码直跑（`dotnet xxx.dll` / `npm run dev`），不是镜像 | 同步的是**文件**，构建在**本机**做 |
| 生成任务不能打断 | 停之前**必须查忙**；换版分**两阶段**，把停机压到 1~3 秒 |

---

## 2. 控制面：常驻连接 + 序号

```
成员 145                                              98
   ├── GET /api/agent/stream?since=41 ──────────────▶│  建立后不返回
   │◀──────── event: task {seq:42, stop webapi} ─────┤  沿已有连接推
   ├── POST /api/agent/report {ack 42} ─────────────▶│
   └── 断线后 GET /stream?since=42 ─────────────────▶│  从断点续上
```

- 下发延迟 = 一个 RTT；空闲每 15s 一个 `ping`
- **`since` 游标必须有**：没有它，断线期间的指令会静默丢失
- 连接兼任心跳：**连接断了 = 节点离线**，不用超时推断
- 指令**至少一次**投递，靠幂等去重

细节见 `protocol.md`。

---

## 3. 文件同步

### 3.1 检测改动：从 98 到变更清单

这一步**独立于同步**，可以随时点「扫描」——纯只读，不动进程、不写共享。

#### 基线：跟谁比

| 比法 | 得到 | 用途 |
| --- | --- | --- |
| 与**上一版已同步 manifest** 比 | 「还没发出去的改动」 | 决定这次传什么（同步基线） |
| 与**上次扫描快照** 比 | 「自上次扫描以来又改了什么」 | 看增量用，不影响同步内容 |
| 与 git 工作区比 | 未提交的改动 | **不用** —— 已确认 98 改的是部署目录，不是 git 仓库 |

第一次没有「上一版」，所以第一次是**基线扫描**：把白名单目录全量 hash 一遍存成
`baseline.json`，然后整目录同步一次（几万文件、几 GB，只发生这一次）。之后永远只传差异。

#### 扫描产物：manifest

每个组件每版一份：

```json
{
  "releaseId": "vcs-20261026-01",
  "component": "generateclient",
  "base":      "vcs-20261025-03",        // 上一版，成员据此复用未变文件
  "files": [
    { "path": "Program.cs",    "sha256": "9f2c…", "size": 1204, "action": "modified" },
    { "path": "Utils/New.cs",  "sha256": "31aa…", "size": 880,  "action": "added"    },
    { "path": "Old/Dead.cs",                        "action": "deleted"  }
  ],
  "localOnly": ["appsettings.json", "nlog.config"],   // 各机独立，不参与同步
  "sig": "hmac-sha256:…"
}
```

扫描范围由**白名单**决定（`sources.*.include`）：`Tools` 共享根里有 35 项，
只有仓库映射的那 11 个目录算数；ComfyUI、CesiumLab 这类第三方既不扫也不同步。

扫描的是 **98 的部署目录**（已确认）。其中 `bin/`、`obj/`、`node_modules/` 一律排除：
只同步源码与配置，编译在成员的 STAGE 阶段做。

#### 判定规则（已实现，`src/scan.mjs`）

| 结果 | 条件 |
| --- | --- |
| 新增 `A` | 基线里没有这个路径 |
| 修改 `M` | 基线里有，但 sha256 不同 |
| 删除 `D` | 基线里有、这次目录里没有，**且它仍在纳管范围内** |
| 未变 | sha256 相同 —— 即使 mtime 变了也**不进清单** |

`mtime` 只用于显示，不参与判定。构建、拷贝、解压都会刷新 mtime，按它判的话每次
`dotnet build` 之后都会冒出几百条假变更，人就会开始习惯性点全选，这个界面也就废了。

必须处理的边角：

- **改名** = 删除 + 新增。不做相似度检测，两条都摆出来，代价可接受
- **改了排除规则**：被移出纳管范围的文件不算「删除」，否则调一次 `exclude` 就冒出上百条 D
- **扫描期间有人在写**：哈希前后各 stat 一次，size/mtime 变了就重算（最多 3 次）
- **junction / 符号链接**：不跟随，记一条 warning。跟随会绕成环，也可能指到范围外
- **大小写**：Windows 不敏感，比对用全小写键，显示保留原样

扫描**每次都全量重算 sha256**，没做 mtime 缓存 —— 先保证判对，再谈快。
一万文件量级约几十秒，可以接受。将来提速是在这里加缓存，而不是把判据换成 mtime。

产物两个文件，都是原子写（临时文件 + rename，写到一半被杀不会留下半个 JSON）：

| 文件 | 内容 |
| --- | --- |
| `state/baseline.json` | 基线：组件 → 路径 → `{sha256, size, mtimeMs}` |
| `state/pending.json` | 最近一次扫描的清单（草稿，带 id 和时间） |

首次运行没有基线 → 自动建基线，并产出一份**空清单**，
不会把几万个文件当成「新增」推出去。

#### 界面上列出的清单

先按组件汇总，展开才是文件：

| 组件 | 新增 | 修改 | 删除 | 体积 |
| --- | --- | --- | --- | --- |
| webapi | 3 | 38 | 1 | 1.2 MB |
| web | 12 | 43 | 0 | 3.4 MB |
| tools | 0 | 22 | 2 | 0.8 MB |

文件级每行：`状态 · 路径 · sha256 前 8 位 · 大小 · 修改时间 · 归因组件`。

三个细节：

- **二进制文件**（dll、zip、图片）标 `binary`，不显示文本 diff
- **`sha256` 前 8 位**用来识别「mtime 变了但内容没变」—— 这类不该占用一次同步
- **归因冲突**：一个源文件落到两个部署位置（1→N 映射）时要合并成一行显示，不能算两条

#### 待同步区（界面上就叫这个）

> 术语统一：这块区域**叫「待同步区」**，不用「整改区」等别名。界面文案、文档、接口名
> 一律以此为准，避免联调时两边叫法对不上。

扫描结果落成 `state/pending.json`，**是草稿不是命令**，人可以改：

| 动作 | 说明 |
| --- | --- |
| 逐文件勾选 / 取消 | 默认全选 |
| 按目录折叠、整目录勾选 | 首次上万条时必需 |
| 「本次不同步」 | 进 `skipList`，下次扫描仍出现但**不默认勾选** |
| 删除项默认**不勾** | 见下 |

为什么必须能筛：自动化系统里总有一些本机专用文件，一刀切同步会把别人机器上的东西
覆盖掉。人工确认这一眼很便宜，事后回滚很贵。

**删除是唯一不可逆的动作**。新增和覆盖都能回滚（有备份），删除会真的从目标机抹掉文件。
所以删除项默认不勾选、需要单独确认，执行前先进成员本地的 `backup\<relId>\<组件>\`。删除要
显式勾 `includeDeletes`，只勾删除项不勾这个确认 → `400 empty_selection`。

#### 同步前复核

从扫描到点同步之间，98 上可能又改了文件。COMMIT 前对被勾选文件重新 hash 一次：

- 一致 → 继续
- 不一致 → 标黄提示「扫描后又有改动」，让人重扫

不自动重扫 —— 否则清单会跳变，人刚确认的内容就变成了别的东西。

### 3.2 两种落地方式

由「改了之后要不要重启才生效」决定，不是按组件喜好：

| | `in-place` | `release-switch` |
| --- | --- | --- |
| 适用 | `tools` `web` | `webapi` `generateclient` `generatetool` `workerhost` `mcpserver` `shp_*` |
| 做法 | 写 `.vcsnew` → 校验 → 原子替换 → 备份原件 | 建新目录 → 切 junction → 重启 |
| 停机 | 0 | 1~3 秒 |
| 回滚 | 按 manifest 从成员本地 `backup\<relId>\<组件>\` 还原 | 切回上一版目录 + 重启 |

`in-place` 的原子替换用 `MoveFileEx(REPLACE_EXISTING)`：在 SMB 上由服务端执行 rename，
**对正在读的进程是原子的**，不会读到半个文件 —— 这是「不重启也能换」成立的前提。

> M2 只实现了 `in-place` 的一半：文件确实以「临时文件 + rename」写进 `localRoot`，
> 但**没有** `release-switch` 的建目录 / 切 junction，也没有原地不改服务就生效的保证 ——
> 服务必须先停（见 §3.3.1）。所以 M2 对**所有**组件都按 in-place 落地，
> 上面的 `release-switch` 一列是 M3 的目标形态。

### 3.3 两阶段：STAGE / COMMIT

```
[STAGE] 服务照常运行，业务无感        （占整个耗时的 95%）
  98 写变化文件 + manifest + 签名 → \\…\Tools\_vcs\releases\<组件>\<relId>\
  成员：读 manifest → 只拉自己缺的文件 → 组装 → 构建 → 回填本机配置 → 校验 → ack staged

[COMMIT] 每台 1~3 秒                 （占 5%，不可逆）
  查忙 → expectedStop → stop → 切指针 → start → 探活 → ack
```

```
98                共享 _vcs                 成员
 │ 扫描差异           │                        │
 ├── manifest+文件 ──▶│                        │
 │                   │◀─── 读 manifest ───────┤
 │                   │──── 只拉差异文件 ──────▶│
 │                   │                        ├─ 按 base manifest 建硬链接
 │                   │                        ├─ dotnet build -o bin
 │                   │                        ├─ 回填 appsettings / nlog
 │                   │                        ├─ 全量 sha256 校验
 │                   │◀──────── ack staged ───┤
 │                                              │
 │  ★ 全部成员 staged 之后，才进入 COMMIT ★     │
 │                                              │
 ├── commit ─────────────────────────────────▶ ├─ 查忙 → stop
 │                   │                        ├─ 切 junction
 │                   │                        ├─ start + 探活
 │                   │◀──────── ack commit ───┤
```

**为什么必须两阶段**：传输和构建又慢又容易失败，把它们放在服务运行期；
真正不可逆的切换只占 1~3 秒。传输失败时服务完全没被碰过，代价为零。

### 3.3.1 M2 实际实现：就地覆盖（只做 STAGE 的前半段）

M2 交付的是「**把 98 上改后的文件落到成员本机**」，也就是上图的「manifest + 文件 → 成员」这一段。
没有 build、没有 junction、没有 `commit` 指令 —— 一次 `stage` 就把文件写进 `localRoot`，
然后由人手工停/起（M3 才把这三步合成一键）。

```
98（master）                                    成员（agent）
 待同步区勾选
   │
   ├─ 逐文件复制到 <sharedRoot>\_vcs\releases\<relId>\files\<组件>\<相对路径>
   │   边复制边算 sha256（不信任扫描时的 8 位短哈希）
   ├─ 写 manifest.json（路径 / 大小 / sha256 / sourceMtime）
   │
   ├── stage{releaseId, share, components} ──SSE──▶ 读 <share>\manifest.json
   │                                               ├─ 逐文件：备份 → 校验 sha256 → 写 .vcsnew → rename
   │                                               ├─ 删除项：备份 → unlink（仅在 includeDeletes 时）
   │◀────────────── ack{landed, deleted, bytes, ms} ┤
   │
   ├─ 全绿：推进基线 + 从待同步区移除 + 写 state\releases\<relId>.json
   └─ 有失败：记录 partial，待同步区原样保留（重发幂等）
```

和「两阶段」的差别，说白了就一句：**`in-place` 组件的文件写入本身就是生效点**，
所以 M2 把 STAGE 和 COMMIT 合并了，靠「必须先把服务停掉」这条硬闸门兜底。
`release-switch` 组件的真正两阶段（build → 切指针）留到 M3。

落地时的硬约束（都在代码里，绕不过去）：

| 约束 | 不满足 |
| --- | --- |
| `sources.<组件>` 必须 = 98 的 `localRoot`（同一个目录） | `layout_mismatch`，连共享都不写 |
| 目标组件不能是 `running` / `degraded` | `not_stopped`（除非显式 `force`） |
| 所有目标机必须在线 | `node_offline`，一台都不发 |
| `path` 只能是组件根下的相对路径，不许 `..` / 盘符 / 绝对路径 | `bad_path`，那个文件不落 |
| 共享上的 blob sha256 必须等于 manifest | `sha_mismatch`，目标文件保持原样 |
| 先备份再覆盖，写临时文件再 rename | 覆盖失败时旧文件还在 `backup\<relId>\` |

> 为什么 `sources` 这个约束这么死：扫描源必须是 98 **正在运行**的那份文件。以前 `sources.webapi`
> 指向 `D:\SceneAutomationV3\SceneAutoApply`（源码），而 98 跑的是 `E:\SceneAutomationBuild\SceneAutoApply`
> （同步产物）—— 把 `.cs` 铺进同步目录，服务下次启动直接起不来。现在六个组件的 `sources` 已经
> 改到产物目录（`components.md` §5.1），10 个组件里 9 个可以直接就地同步。
> 宁可 409 让人去改配置，也不能「看起来同步成功了」。

### 3.4 成员侧怎么组装（关键细节）

```
本地 releases\generateclient\vcs-20261026-01\
├── (未变的文件)  ← 硬链接到上一版，不传输、不占空间
├── (变化的文件)  ← 从共享拷来
├── bin\          ← 本机 dotnet build 生成，永不从别处拷
└── appsettings.json ← 从 _config\generateclient\ 回填

D:\SceneAutomationV3\GenerateClient → junction → 上面这个目录
```

两条规则：

1. **只按上一版 manifest 的文件清单建硬链接**，绝不遍历目录树。
   否则会把 `bin/`、`obj/` 一起链进去 —— 新版本构建时写的是与旧版本**同一个 inode**，
   旧版本当场被污染，回滚就失效了。
2. 目录指针用 **junction**（`mklink /J`，免管理员），不用符号链接（要管理员或开发者模式）。

### 3.5 本机配置必须与构建产物隔离

`GenerateClient.csproj` 里 `appsettings.json` 带 `CopyToOutputDirectory=PreserveNewest`，
**每次 `dotnet build` 都会用仓库版本覆盖本机配置**。

145 上手工改对的 `SignalRUrl`（指向 207）会被悄悄改回指向自己，而 145 上没有 webapi。
服务照常启动、日志不报错，只是客户端注册不上 —— 这类故障很难查。

所以：

```
<release>\
├── appsettings.json    ← 本机配置，构建后从 _config\<组件>\ 回填
├── nlog.config         ← 同上
└── bin\                ← 构建产物全在这里，构建碰不到上面两个文件
```

仓库版本仍然会传过来，但改名存为 `appsettings.repo.json`，STAGE 阶段对比键集，
提示「仓库多了 X 个键，请手工合入本机配置」。

### 3.6 回滚

| 策略 | 动作 | 耗时 |
| --- | --- | --- |
| `release-switch` | 切回上一版 junction + 重启 | 秒级 |
| `in-place` | 按 manifest 从备份逐文件还原 | 视文件数 |

**回滚同样要查忙**，逻辑与 COMMIT 一致。保留最近 5 个版本（可配）。

> M2 现状：没有自动回退。文件都在成员本地 `backup\<relId>\<组件>\<相对路径>`，
> 回退 = 停止服务 → 把备份目录整棵拷回 `localRoot` → 启动（`runbook.md` §9.5）。
> 自动回退需要知道「这一版当时覆盖了哪些文件」，manifest 里已经有，M3 直接拿来用。

### 3.7 边界：有些变更不在文件同步范围内

`a076978` 新增了 3 个 DbSet（`PreviewBlock*`），但仓库里既没有 `Migrations/`
也没有建表 SQL。**纯文件同步不足以上线**，所以同步流程里有一道人工闸门：

> 「本次是否含数据库变更？」必须人工确认，vcsNode 只提示，不执行。

---

## 4. 进程启停

### 4.1 先能认出「哪个是我们的进程」

```
指纹 = pid + 进程创建时间 + 命令行 sha256
```

- 只用 pid 不行：pid 会复用，杀错进程
- 只用进程名不行：一台机器上好几个 `dotnet.exe`
- 加创建时间和命令行哈希，才能确定「这就是我上次启动的那个」

状态机：

```
stopped → starting → running → stopping → stopped
                        ↓
                    crashed / orphan
```

**阶段一用 `adopt`**：按指纹认领现有人工启动的进程，只做监控和手动停启，
不改变现场启动方式。稳定后再转为自己 spawn。

### 4.2 启动

```
1. 已在 running → no-op（幂等，重复下发不会起两份）
2. 检查 dependsOn 健康（webapi 没起来就别起 client）
3. spawn：detached + windowsHide，stdout/stderr 重定向到 logs\<组件>\<日期>.log
4. 记指纹，状态 → starting
5. 等就绪：HTTP 200 / 端口 Listen / 到 3601 的 ESTABLISHED
6. 超时 → failed，不无限等
```

> `dotnet xxx.dll` **不读** `launchSettings.json`，必须显式给
> `ASPNETCORE_URLS=http://0.0.0.0:3601`，否则只监听 `localhost:5000`。

> **M1 与这里的差距**：第 2 步（`dependsOn` 健康检查）还没做 —— 现在完全信任操作顺序；
> 第 5 步只等「端口在监听」，不等 `health`（探活结果由下一轮采样如实上报，假活照样会变 `degraded`）。
> 实际实现见 §4.3.1。

### 4.3 停止（顺序不能变）

```
1. expectedStop = true          ← 否则自愈逻辑会立刻把进程拉回来
2. 查忙                          ← 见 4.4，忙则拒绝停止
3. taskkill /PID <pid>          ← 先礼，不带 /F
4. 等 5s
5. taskkill /PID <pid> /T /F    ← /T 不可省
6. 验证端口已释放                否则标 orphan，禁止自动重启
7. 状态 → stopped
```

**M1 实际实现**（`src/proc.mjs` 的 `stopComponent`）：跳过第 1、2、3 步 —— 现在没有自愈、
也没有查忙，直接 `taskkill /PID <pid> /T /F` → 每 200ms 轮询 pid 直到真的没了（上限约 6s）
→ 复查端口（`portFree`）。识别不到「自己的」进程就什么都不做：`not_running` /
`not_ours` / `identify_mismatch` 一律拒绝。

**`/T` 为什么不能省**：后端用 `cmd.exe /c .venv\Scripts\python.exe main.py` 拉起工具脚本，
杀掉 `cmd.exe` 而不杀进程树，python 会变成孤儿继续跑、继续写 `Task.json`，
下一个任务立刻撞上状态冲突。

> 已知缺陷：`generateclient` / `generatetool` 有 Ctrl+C 清理钩子，但外部无法可靠投递
> `CTRL_C_EVENT`，实际会退化为硬杀。要真正优雅停，需要在它们内部加本机停机信号。

### 4.3.1 启动（M1 实际实现）

```
1. locate() 已经认出来 → 直接成功（alreadyRunning），绝不起第二个
2. 端口被别人占着（foreign）→ port_busy，不动
3. cwd = localRoot + start.cwd（再做 --remap），目录不存在 → bad_cwd，绝不在错目录里起
4. resolveCommand(cmd)（.cmd/.bat → 经 cmd.exe /d /s /c）+ args 相对路径按 cwd 解析
5. spawn(detached, stdio → <logDir>\<组件>.log)
6. 有端口的先廉价探端口（TCP connect，250ms 一次）；起来了读一次进程表
7. locate() 认出来 + 端口在监听 → ok；进程提前退出 → exited（带日志尾巴）；
   超时（start.timeoutMs，默认 30s）→ start_timeout
```

要点：

- **成功 = 认出来的 pid + 端口在监听**，不是「spawn 没报错」。`identify` 配错时宁可超时也不假装成功。
- 进程是 **detached** 的：agent 重启/升级不会带走业务进程；代价是机器重启后不会自动起来。
- `.cmd`（`npm`）那条路的 spawn pid 是 `cmd.exe`，真实 pid 仍以 `locate()` 为准。
- 只读一次进程表是有意的：`readInventory` 约 1.5s，轮询它会把启动等待拖成十几秒。

### 4.4 忙碌保护（最重要的一条）

生成任务跑着的时候重启客户端 = 把正在做的项目弄坏。所以 `stop` / `restart` / 同步
COMMIT 前必须确认空闲：

| 方案 | 是否要改业务代码 | 可靠性 | 采用 |
| --- | --- | --- | --- |
| A. webapi 提供 `/api/clients/state` | 要 | 高 | 推荐，作为独立需求提 |
| B. 观察任务目录最近写入时间 | 不用 | 中 | **先上这个** |
| C. 查数据库队列 | 不用但耦合 | 中 | 不用 |

忙的时候**排队等待**，不是强行停止。

### 4.5 顺序与并发

```
启动：webapi → (shp_plants, shp_buildings, generatetool, workerhost) → generateclient → mcpserver → web
停止：反序
```

- set 内串行，跨 set 并行
- 组件级互斥锁，避免两条指令打架
- 所有动作**幂等**，崩溃重启后可安全重放队列

### 4.6 状态判定（四态必须分开）

| 状态 | 依据 | 处置 |
| --- | --- | --- |
| `node-offline` | 超过 `offlineMs`（45s）没有任何上报 | 只告警，**不重启**（指令没人接） |
| `crashed` | 连接正常，进程不在（**需要「期望运行」，M1 才有**） | 拉起 |
| `orphan` | 进程不在但端口被别的进程占 | 不重启，先查占用 |
| `degraded` | 进程在，但探活没过（到 3601 的连接断了 / 端口没监听） | 重启该客户端 |
| `stopped` | 进程不在，端口也没人占 | 如实显示，不猜「是不是崩了」 |
| `unknown` | `localRoot` 不存在 / 还没收到观测 / 观测过期 | 先修配置页路径，或看 agent 日志 |

`degraded` 最容易被漏：进程活着、窗口正常、端口也在，但没连上 webapi
（典型原因就是 §3.5 里那个被覆盖的 `SignalRUrl`）。

所以判活不能只看端口：

| 组件 | 判活方式 |
| --- | --- |
| `web` | TCP 端口 + HTTP GET `/` |
| `webapi` | TCP 3601 + `/swagger/index.html` |
| `generateclient` / `generatetool` / `workerhost` | 进程存活 + **该 pid 到 3601 的 ESTABLISHED** |
| `mcpserver` | TCP 7077（Streamable HTTP 在 `/mcp`） |
| `shp_plants` / `shp_buildings` | TCP 4000 / 4001 |
| `tools` | 不判活（纯文件） |

**连接型判活必须按 pid 过滤**：同一台机器上 `generateclient` 和 `generatetool`
可能都连着 3601，只看「有没有到 3601 的连接」会把断了的那一个也判成健康 ——
那正是假活漏判的根源。`src/probe.mjs` 的 `checkConn()` 只认「该 pid 名下」的连接，
并且会核对远端地址：连上了但不是配置里那台（`SignalRUrl` 指向 145 而不是 207）
判 `ok:false`，note 里写清「实际连的是谁」。

**「在线」的唯一依据是成员还在上报，不是 socket 还开着。**
拔网线时 TCP 那头没有任何反应（没有 FIN/RST），主节点往半开连接写 ping 也会成功，
所以判定只看「超过 `offlineMs`（默认 45s）没收到任何上报」。
主节点**不会**因为判离线就主动断掉那条 SSE —— 曾经这么做过，结果把一个
上报间隔比阈值长的活 agent 反复踢下线。成员侧对应的是 45s 读超时 + 退避重连。

`restartOn` 的语义（决定「改哪些文件之后必须重启」）：

| 配置 | 含义 |
| --- | --- |
| 没写 `restartOn` | 任何改动都要重启（`shp_*` 这种纯 Node 脚本就是这类，模块有缓存） |
| `restartOn: []` | 从不重启（纯静态资源、`in-place` 且能热加载的） |
| `restartOn: [...]` | 只有命中这些文件名才重启（`web`：只有依赖/构建配置变了才重启） |
| `kind: asset` | 不重启（没有进程） |

自愈：崩溃按 `on-failure` 拉起（5 次/10 分钟，退避 2s）；`expectedStop` 期间不动；
超过上限停止自愈并告警。

---

## 5. 一次同步：端到端

| # | 发生什么 | 失败会怎样 |
| --- | --- | --- |
| 1 | 98 上改代码 | — |
| 2 | **扫描** → 变更清单（按组件汇总 + 文件级明细） | 无影响，随时可重扫 |
| 3 | 在待同步区勾选 / 排除，确认是否含数据库变更、是否含删除 | 停下来人工处理 |
| 4 | **复核**：对被勾选文件再 hash 一次 | 标黄提示重扫 |
| 5 | **STAGE**：写共享 → 成员拉取/组装/构建/校验 | 中止，服务未受影响 |
| 6 | 等各成员 `staged` 全绿 | 不进入 COMMIT |
| 7 | **COMMIT**：逐台查忙 → 停 → 切 → 起 → 探活 | 该 set 整体回滚 |
| 8 | 记录版本，清理旧 release | 不影响运行 |

> 第 2~4 步都是**只读**的：扫描、列清单、复核都不碰进程，也不写共享。
> 也就是说「看 98 上改了什么」这个能力，可以完全独立于同步功能先上线。

M2 落地后，第 5~8 步实际是这样（没有构建、没有 junction，也没有自动停/起）：

| # | 发生什么 | 失败会怎样 |
| --- | --- | --- |
| 5 | 人工先停掉要换文件的组件（抽屉 → 停止） | 不停 → 409 `not_stopped` |
| 6 | **预同步**：98 复制勾选文件到共享并写 manifest → 成员备份 + 校验 + 就地覆盖 | 单台失败 → `partial`，待同步区保留 |
| 7 | 全绿 → 推进基线、清待同步区、写同步记录（含逐文件 sha256 与各节点落地时间） | — |
| 8 | 人工起服务，业务自检 | 起不来 → 看 `<logDir>\<组件>.log`，必要时从 `backup\<relId>\` 拷回 |

归因示例：

```
web/…        +5198 / -194   → 组件 web
SceneAutoApply/…  +3109     → 组件 webapi
GenerateClient/…            → 组件 generateclient
AutomationUE5.3/…           → 组件 tools（纯文件，不重启）
```

---

## 6. 配置与安全

**配置三层**（路径四台不统一，所以必须分层）：

| 层 | 内容 | 存哪 |
| --- | --- | --- |
| ① 组件默认 | 有哪些组件、怎么启停、怎么判活 | 98 配置页 |
| ② 节点覆盖 | 该机的 `localRoot` / 端口 / 是否启用 / 共享路径 | 98 配置页 |
| ③ 本机引导 | 主节点地址、`nodeId`、`secret` | **各机本地文件，永不下发** |

第③层不能远程改：agent 得先知道连哪台主节点才能收到配置；这层若可下发，
一次手误就是四台全失联，没有第二条路回来。

配置页五个必备动作：逐格编辑 + 整列复制 · **探测**（路径/共享/端口是否真存在）·
保存前 diff · 下发并等 ack · 漂移高亮。少了「探测」，「统一配置」就会变成「统一配错」。

> 当前已实现：逐格编辑、保存前 diff、本机路径探测、保存到磁盘。
> 未实现：下发（要等 agent）、整列复制、漂移高亮（要等各机上报 revision）、
> 远程探测（只有主节点本机的路径能真的 stat）。

### 6.1 配置保存怎么落地（已实现）

界面上的编辑只产生一组 `{ 节点, 组件, 字段, 新值 }`，服务端四步处理：

1. **校验** —— 字段白名单（组件的 `localRoot` / `port` / `enabled`，节点的 `sharedRoot`）、
   该组件必须已在这个节点部署、端口 1~65535、路径必须是绝对路径或 UNC。
2. **按行打补丁** —— 解析时记录每个键的真实行号，只替换目标值：
   inline 写法（`web: { localRoot: …, port: 3071 }`）改 flow map 内部；
   block 写法改对应子行；字段不存在就按同级缩进插一行。**注释和对齐原样保留。**
3. **写前自检** —— 把改完的文本重新解析，与「原结构 + 预期改动」逐字段比对；
   有一处对不上就放弃保存，原文件一个字节都不动。
4. **落盘** —— 备份到 `config/backup/vcsnode-<时间>.yaml`（保留最近 10 份），
   临时文件 + rename 原子替换，`state/config-revision.json` 的 revision +1。

为什么不用「解析成对象再整个重新生成」：这份 YAML 的注释是唯一的配置说明，
重新生成会把注释、顺序、对齐全部洗掉，之后没人敢改。

写接口只接受回环地址和 `cluster.allowedPeers` 内的来源，其余 403 ——
配置页能把四台的路径改错，这个口子不能对内网全开。

**安全**：HMAC-SHA256 + 时间戳 + nonce（防重放）；路径必须落在 `localRoot` 之下
（`realpath` 二次校验防 `../` 逃逸）；只接受对**配置里存在的组件**执行
`start/stop/restart/commit/rollback`，不接受任意命令行；全程审计到 `events-*.jsonl`。

---

## 7. 待定

| # | 事项 | 不确认时的默认做法 |
| --- | --- | --- |
| 1 | 207 的 web / webapi 目录、98 自身部署根 | 留 `null`，第 1 步采样（cwd + 可执行路径）自动填 |
| 2 | ✅ 98 扫描源 = **部署目录**（已确认） | 不需要 preBuild；`bin/` `obj/` 排除，编译在成员 STAGE 做 |
| 3 | 207 前端端口 3071 / 3333 | 显式 `--port 3071 --strictPort` |
| 4 | .NET 跑 Release 还是 Debug（207/149 已确认是**编译后启动**） | 不猜：第 1 步采样看 dll 路径是 `bin\Release\net8.0\` 还是 `bin\Debug\` |
| 5 | 98 部署目录里是否含 `.csproj` / `.cs` 源码 | 若只有 dll，"成员各自构建"不成立，要改成同步编译产物 |
| 6 | 忙检测 A / B | 先上 B（看任务目录 mtime） |
| 7 | 207 的 `Tools` 要不要同步 | `enabled: false` |
| 8 | ~~`workerhost`~~ / `aigenerate` 是否纳管 | workerhost = 98/149/145，mcpserver = 98/149/207；aigenerate 仍 `enabled: false` |
| 9 | 145 是否也跑 `shp_plants` / `shp_buildings` | 先按「有」配 |
| 10 | agent 以什么身份常驻 | 专用账号，不用 LocalSystem（否则 SMB 走机器账号） |
| 11 | 数据库变更由谁执行 | 人工闸门，vcsNode 只提示 |
| 12 | agent 如何自启 | NSSM 注册为服务 |
| 13 | 四台是否 NTP 同步 | 要求同步；否则 HMAC 时间窗放宽到 ±10 分钟 |

---

## 8. 实现顺序

| 步骤 | 交付 | 风险 |
| --- | --- | --- |
| 1 ✅ | agent 骨架 + 进程采样 + 上报；98 显示四台进程清单 | 纯只读 |
| 2 ✅ | 主节点 API + SSE + 状态页 + 配置页 | 仍只读 |
| 3 ✅ | **扫描 + 变更清单（待同步区）**：能看到 98 上改了哪些文件、归到哪些组件 | 只读，不动共享不动进程 |
| 4 ✅ | supervisor 启停 + 查忙保护 | 第一次动进程 |
| 5 | STAGE / COMMIT + 一键同步 | 最大块，唯一会改别人机器的部分 |
| 5a ✅ | **更新文件（M2）**：98 打包到共享 + 成员备份/校验/就地覆盖 + 同步记录（文件级明细） | 会写成员文件，但只在服务停止、sha 校验通过时写 |

> **第 4 步已完成（2026-10-28）：启动 / 停止 / 重启都通了**。
> `src/proc.mjs`（停：认真实 pid → `taskkill /PID /T /F` → 轮询确认退出 → 复查端口；
> 起：按 `start.cwd` 起 detached 进程 → 廉价探端口 → 读一次进程表认领真实 pid → 落 `<logDir>\<组件>.log`；
> 重启：先停再起，停不下来就不起）、
> `bin/agent.mjs` 的 `task` 分支（`allowControl` 开关 + 忙保护 + **先推快照再回 ack**）、
> `NodeRegistry.sendTask()`（taskId ↔ ack/nack 配对、按指令 30s/60s 超时）、`POST /api/ui/task`、
> 抽屉里的两段式确认（停止 / 重启）与一下即发的启动。查忙保护（4.4）还没做 —— 现在只有
> 「一次一条指令」的成员侧忙保护，跨组件的互斥要等 M3 的 `commit`（只有它知道整台机器在做什么）。
>
> **第 5 步的第一半（M2 更新文件）已完成（2026-10-28）**：
> `src/release.mjs`（98 侧打包：逐文件复制 + 边复制边算 sha256 + manifest + 滚动清理 + 基线推进 + 同步记录）、
> `src/sync.mjs`（成员侧落地：路径校验 + 备份 + sha256 校验 + 临时文件 rename + 删除项）、
> `POST /api/ui/stage` + `GET /api/ui/releases[/{relId}]`、
> 待同步区的「预同步」按钮接真实接口、同步记录页与详情抽屉渲染真实 manifest。
> 剩下的：`release-switch` 的构建/切指针、`commit`（停→覆盖→起一键）、一键回退、`probe` 指令。

第 3 步只读，但价值很高：**先让人相信「清单是对的」，再让它去改机器**。
如果扫描范围、归因、白名单配错了，在只读阶段发现，代价是零；等接上 COMMIT 才发现，
代价就是一次错误的停机。

第 1 步同样是只读的：现在没人知道别台机器的进程到底活没活，
尤其 `degraded`（进程在、SignalR 断）这种只能靠翻后端日志发现的状态。

> **进度（2026-10-28）**：
> 第 1 步的**只读 agent + 节点观测**已落地 ——
> `src/probe.mjs`（进程表 / 端口 / 连接采样 + 按端口或命令行认进程 + 探活）、
> `src/agent-auth.mjs`（两端共用 HMAC 签名，含时钟窗与 nonce 防重放）、
> `src/node-state.mjs`（观测 → 结论的判定规则）、`src/nodes.mjs`（节点注册表 + SSE 通道 + 落盘）、
> `bin/agent.mjs`（出站常驻 SSE + 周期采样上报 + 退避重连 + `--inventory` / `--once`）、
> `bin/master.mjs`（`GET /api/agent/stream`、`POST /api/agent/report`、`GET /api/ui/nodes`、本机采样）；
> 界面「总览」已接真实状态（节点卡片 + 组件矩阵 + 抽屉里的 pid/端口/连接/依据）。
>
> 第 3 步的**扫描与变更清单**已落地 ——
> `src/yaml.mjs`（配置解析 + 行级定位）、`src/ignore.mjs`（排除规则）、`src/scan.mjs`（遍历/哈希/比对）、
> `bin/scan.mjs`（命令行）、`bin/master.mjs`（静态页 + `/api/ui/pending` + `/api/ui/scan`），
> 页面「待同步区」已接真实数据。
>
> 第 2 步的**配置页**也提前落地了（见 §6.1）：`src/config-edit.mjs` 负责行级补丁、写前结构校验、
> 备份与 revision；`GET/POST /api/ui/config`、`POST /api/ui/config/probe`；界面可编辑、可 diff、可保存。
>
> 尚未实现：`commit` / `probe` 指令、`release-switch` 的构建与切指针、一键回退、
> 清单的勾选落盘（`PATCH`，现在勾选只存在界面内存里）、配置回退（`config/rollback`）、
> `secondaryMappings`（一个源文件写到第二处）。
> 控制权限由成员自己的 `allowControl` 决定（`observe` / `stage` / `full`）：权限不足时收到 `task`
> 会明确回 `nack(control_disabled)`，不静默丢弃 —— 否则界面会一直等 ack。主节点在发指令前也会先挡一道。

---

## 9. 术语

界面文案与内部术语的对应关系，**写代码和写文档都以此为准**，避免同一件事三种叫法。

| 界面文案 | 内部 / 文档 | 含义 |
| --- | --- | --- |
| **待同步区** | `state/pending.json` | 扫描结果落成的可编辑草稿；勾选、跳过、删除确认都在这里 |
| 变更清单 | diff list | 待同步区里的文件级明细 |
| 本次跳过 | `skipList` | 不进这次同步；下次扫描仍出现，但不默认勾选 |
| 扫描 | scan | 只读比对，产出变更清单 |
| **预同步** | STAGE（M2 先做「就地覆盖」） | 98 打包到共享 → 成员备份 + 校验 sha256 + 写进 `localRoot`；**服务必须先停**；不构建、不切指针 |
| **切换上线** | COMMIT | 停 → 覆盖 → 起（M3；现在是一次手工的停止 / 预同步 / 启动） |
| 回退 | rollback | M2：从成员 `backup\<relId>\` 拷回再启动；M3 做一键 |
| 认领 | adopt | 阶段一：认领现有人工启动的进程，不改变启动方式 |
| 组件 | component | web / webapi / generateclient / … |
| 节点 | node | 四台机器之一 |
| 一套 | set | 事务边界；set-a = 207 + 145 |
| 离线 | `node-offline` | 控制面连接不存在，只告警不重启 |
| 异常退出 | `crashed` | 连接正常但进程不在（非人为停止），可拉起 |
| 孤儿 | `orphan` | 进程不在但端口被占，先查占用 |
| 假活 | `degraded` | 进程在，但没连上 webapi（SignalR 断） |
| 忙 | `busy` | 正在跑生成任务，此时禁止停/重启/切换 |
