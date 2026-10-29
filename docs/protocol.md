# vcsNode 控制面协议

> 版本：`protocol: 1` · 2026-10-26 · 状态：待实现
>
> 配套：`docs/architecture.md`（设计与理由）、`docs/components.md`（事实底账）
>
> 这份文档定死「两端之间到底传什么」。**改字段必须改这里**，否则联调时会各写各的。

---

## 1. 总则

| 项 | 约定 |
| --- | --- |
| 传输 | HTTP/1.1。主节点 `172.16.2.98:47821` 监听，成员只出站 |
| 编码 | UTF-8，`application/json`；时间一律 ISO 8601 带时区，或 Unix 毫秒（见字段说明） |
| 鉴权 | 每个请求带 `X-VCS-Node`、`X-VCS-Ts`、`X-VCS-Nonce`、`X-VCS-Sign` |
| 方向 | 只允许 成员 → 主节点 建连；主节点不主动连成员 |
| 幂等 | 所有写操作必须幂等，可安全重试（网络失败后由发送方重发） |
| 版本 | 请求头 `X-VCS-Proto: 1`；不匹配时主节点回 `426` 并说明支持范围 |

### 1.1 签名

```
sign = HMAC-SHA256(secret, nodeId + "\n" + ts + "\n" + nonce + "\n" + method + "\n" + path + "\n" + sha256(body))
```

- `secret` 来自各机 `agent.bootstrap.json` 与主节点 `config/vcsnode.yaml` 的 `cluster.secret`
- `ts` 为 Unix 毫秒；与主节点时间差超过 **±5 分钟** 拒绝（`401 clock_skew`）
- `nonce` 为 UUID；主节点保留 10 分钟内的 nonce，重复即拒（`401 replay`）
- **GET 请求也对 path 签名**（含 query），防止伪造轮询

---

## 2. 端点

| 方法 | 路径 | 用途 | 连接 |
| --- | --- | --- | --- |
| `GET` | `/api/agent/stream?since=<seq>` | 事件流（SSE） | 常驻 |
| `POST` | `/api/agent/report` | 上报状态、执行结果、探测结果 | 短连接 |
| `GET` | `/api/ui/<…>` | 管理端查询 | 短连接 |
| `POST` | `/api/ui/<…>` | 管理端操作（启停、同步、改配置） | 短连接 |
| `GET` | `/healthz` | 主节点自身存活 | 短连接 |

成员只实现前两个的客户端；管理端只走 `/api/ui/*`。

---

## 3. 事件流 `GET /api/agent/stream`

### 3.1 请求

```
GET /api/agent/stream?since=41&node=node-145
Accept: text/event-stream
```

| 参数 | 说明 |
| --- | --- |
| `since` | 本机已处理到的最大 `seq`。首次连接填 `0` |
| `node` | 节点 id，必须与签名中的 `X-VCS-Node` 一致 |

### 3.2 响应

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store
X-Accel-Buffering: no
```

之后按 SSE 格式持续输出。**每条事件必须带 `id:`**，值为 `seq`（供 `Last-Event-ID` 兜底）。

```
id: 42
event: task
data: {"seq":42,"kind":"stop","component":"webapi","timeoutMs":30000}
```

### 3.3 事件类型

| event | 方向 | 说明 |
| --- | --- | --- |
| `hello` | 主 → 成员 | 建连成功后第一条，告知当前 revision 与服务端时间 |
| `task` | 主 → 成员 | 一条指令 |
| `config` | 主 → 成员 | 配置变更下发 |
| `ping` | 主 → 成员 | 15s 一次保活，`data` 为空 |
| `bye` | 主 → 成员 | 主节点准备重启/升级，成员立刻按退避重连 |

> **M0 实现**：配置保存成功后，主节点会向所有已连上的成员**重发一次 `hello`**（载荷与建连时相同，`seq` 仍为 0）。
> 成员据此刷新 `<cacheDir>\node-config.json` 并立即重采样，`localRoot` / `port` / `enabled` 的改动不用重启 agent 就生效。
> 此时 `config` 事件尚未启用（保留给 M1 带 hmac 的强制下发）。

#### hello

```json
{
  "seq": 0,
  "serverTime": 1761450000000,
  "configRevision": 7,
  "proto": 1,
  "node": {
    "id": "node-149",
    "ip": "172.16.1.149",
    "hostname": "SCENE-149",
    "components": {
      "shp_plants": {
        "kind": "service",
        "localRoot": "D:\\SceneAutomationV3\\Tools\\ShapefileTool.Plants.20230905",
        "port": 4000,
        "updateMode": "in-place",
        "identify": { "name": "node.exe", "cmdlineIncludes": ["ShapefileTool.Plants"] },
        "health": { "type": "tcp", "port": 4000, "timeoutMs": 3000 },
        "restartOn": null,
        "start": { "cmd": "node", "args": ["index.js"], "cwd": "." }
      }
    }
  }
}
```

**`node.components` 是 M0 起新增的**：主节点把「这台机器实际该管哪些组件、装在哪」直接算好下发，
成员不需要解析 `vcsnode.yaml`（也就不会出现两边配置不一致）。
成员收到后写 `<cacheDir>\node-config.json`，主节点临时不可达也能继续采样。

`components` 的折算规则（主节点侧 `componentSpecs()`）：

- 节点没声明的组件不出现；`enabled:false` 不出现；`localRoot` 为 `null`（未确认）不出现
- 节点级覆盖 `localRoot` / `port` / `health` 优先于组件级
- `{port}` / `{webapiHost}` 占位符在主节点就替换掉，成员只认最终值

成员收到后：若本地缓存的 `configRevision` 落后，直接用新配置覆盖缓存并立刻重采样一次。

#### task

```json
{
  "seq": 42,
  "id": "t-20261026-0001",
  "kind": "stop",
  "component": "webapi",
  "issuedAt": 1761450000000,
  "by": "172.16.2.98"
}
```

| kind | params | 语义 | 状态 |
| --- | --- | --- | --- |
| `start` | `{}` | 启动组件：按配置的 `start.cmd` + 工作目录起进程，等它被认出来才算成功；已在跑则直接成功（`alreadyRunning`） | **已实现** |
| `stop` | `{}` | 停止组件（含子进程），停完确认进程真的没了 | **已实现** |
| `restart` | `{}` | 先停再起；停不下来就不起（避免两个实例抢端口） | **已实现** |
| `stage` | `{releaseId, share, components:[…], includeDeletes}` | 按共享上的 `manifest.json` **就地覆盖**本机文件（先备份、再校验 sha256、再写），不碰进程 | **已实现（M2）** |
| `commit` | `{releaseId, components:[…]}` | 切指针 + 重启（含查忙） | 未实现 |
| `rollback` | `{releaseId\|previous:true}` | 回退到指定/上一版本 | 未实现 |
| `probe` | `{targets:[…]}` | 只读探测：路径、共享、端口、`.venv` | 未实现 |
| `config_apply` | `{revision, payload, hmac}` | 应用新配置（等价于 `config` 事件 + 强制 ack） | 未实现 |

**约束**：

- 能不能执行由**成员自己的** `agent.bootstrap.json → allowControl` 决定，三档：`observe`（只采样上报，`start`/`stop`/`restart`/`stage` 全拒）、`stage`（只收文件，启停仍拒）、`full`（全放开）；老写法 `true`/`false` 等价 `full`/`observe`。执行闸在成员侧，主节点只是提前挡一道。
- `kind` 与 `component` 必须存在于该节点的配置里，否则回 `nack`（`not_configured`）。
- 主节点不接受成员上报的自由命令；同步源（`role: source`，即 98）一律 `400 manual_node`，不通过控制面启停。
- `id` 由主节点生成，成员必须原样带在 `ack` / `nack` 的 `taskId` 里 —— 主节点靠它把回执对上在等的那次请求。
- 一次只跑一条：成员正在执行上一条时回 `nack busy`（不排队）。
- **启动的工作目录只认配置**：`localRoot` + `start.cwd`（相对路径按 `localRoot` 解析），解析结果不存在就 `bad_cwd`，
  绝不「在 agent 当前目录里凑合起一个」—— `dotnet .\X.dll` 在错目录里跑会读错 `appsettings.json`。
- `start.cmd` 里的相对路径（含 `args`）按工作目录解析；`.cmd` / `.bat`（`npm` 这类）经 `cmd.exe /d /s /c` 起，
  所以那种组件的 **spawn pid 是 cmd.exe**，真正的 pid 仍以 `locate()` 认出来的为准。
- 服务进程是 detached 的：agent 重启/升级不会带走业务进程。stdout/stderr 落到成员本地
  `<logDir>\<组件>.log`（默认 `C:\vcsNode\logs`）。
- **先推快照、再回执**：执行完先 `snapshot` 一帧（`force`），再发 `ack`。这样主节点一收到 ack，矩阵里已经是终态，
  界面刷新不会先看到「运行中 → 假活 → 已停止」的中间态。
- `stage` 不改进程状态，所以**不发 snapshot**（省一次 1.4s 的进程表读取）。
- `stage` 的 `components` 只用于过滤（同一台上只落这台配了的组件）；真正的文件清单只认
  `<share>\manifest.json`，不接受主节点在指令里另传路径。
- `stage` 落地的每一步都有硬约束：相对路径不许越出 `localRoot`、共享上的文件 sha256 必须与 manifest 一致、
  旧文件先备份到 `<backupDir>\<relId>\<组件>\<相对路径>\`、写临时文件再改名覆盖。
  任何一个文件失败 → 整条任务回 `nack partial`（已落地的文件保留并备份，主节点据此不推进基线）。

#### config

```json
{
  "revision": 8,
  "payload": { "...": "该节点的完整生效配置" },
  "hmac": "…"
}
```

`hmac` 用于防止 SSE 通道被中间人篡改；成员校验失败直接 `nack`。

#### bye

```json
{"reason":"restart","retryAfterMs":3000}
```

---

## 4. 上报 `POST /api/agent/report`

单端点、多用途，靠 `type` 区分。

```json
{
  "node": "node-145",
  "type": "snapshot",
  "sentAt": 1761450000000,
  "payload": {}
}
```

| type | 何时发 | 内容 |
| --- | --- | --- |
| `hello` | 建连后立即一次 | 版本、启动时间、当前 `configRevision`、最后处理的 `seq` |
| `snapshot` | 状态变化时 + 每 30s 一次 | 各组件观测值（进程、端口、连接、退出码） |
| `ack` | 收到 task / config 后 | `seq` 或 `revision` + 结果 |
| `nack` | 拒绝执行 | `seq` + 错误码 + 原因 |
| `probe` | 探测完成 | 每项的布尔结果与细节 |
| `log` | 可选 | 关键事件摘录（不必传全量日志） |

### 4.1 snapshot

```json
{
  "node": "node-145",
  "type": "snapshot",
  "sentAt": 1761450000000,
  "payload": {
    "uptimeSec": 3600,
    "configRevision": 7,
    "lastSeq": 41,
    "control": "stage",
    "components": [
      {
        "id": "generateclient",
        "state": "running",
        "pid": 5521,
        "createdAt": "2026-10-26T09:12:03+08:00",
        "cmdHash": "sha256:9f2c…",
        "cwd": "D:\\SceneAutomationV3\\GenerateClient",
        "port": null,
        "conn": { "remote": "172.16.1.207:3601", "established": true },
        "health": { "ok": true, "checkedAt": 1761449998000 }
      }
    ]
  }
}
```

**成员只报观测，不报结论。** 不传 `crashed` / `degraded` 这类判定 ——
那是主节点的职责（改规则不用重发 agent）。成员允许出现的 `state` 只有：

```
running | starting | stopping | stopped | unknown
```

主节点据此推导 `node-offline / crashed / orphan / degraded`。

`control` 是这台成员自己的控制权限（`observe` / `stage` / `full`），主节点原样转给界面：
`GET /api/ui/nodes` 每个节点多两个字段 `control` / `controlLabel`，界面据此决定启停按钮能不能按。

#### 4.1.1 M0 实际字段（比上面多出来的部分）

上例是最小集。M0 的 agent 还会带这几项，**都是可选字段，收方必须忽略不认识的**：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `kind` | `service` \| `asset` | `asset` 没有进程，只看目录在不在 |
| `exe` | string | 进程可执行文件路径（诊断用） |
| `cmdline` | string | 截断 400 字符，用于人工核对「认对了进程没有」 |
| `listening` | boolean | 该组件端口是否有人在监听 |
| `portOwner` | object \| null | 端口被**别的程序**占用时，占用者 `{pid,name,exe,started}` |
| `matchBy` | `port` \| `cmdline` \| null | 这个 pid 是怎么认出来的 |
| `notes` | string[] | 观测时发现的问题，原样展示给运维 |
| `health.status` | number | HTTP 探活的实际状态码（0 = 连不上） |

**认进程的顺序**（`src/probe.mjs` 的 `locate()`）：端口归属优先，其次「进程名 + 命令行关键字」。

- 有端口的组件用监听者 pid ——`shp_*` 是 `node index.js`，命令行里根本没有目录名，只能按端口认
- 没有端口的（`generateclient` / `generatetool` / `workerhost`）必须靠命令行里的 `xxx.dll`
- 端口被非受管进程占着时，`pid` 报 `null`、`portOwner` 填占用者、`state` 报 `stopped` ——
  主节点据此判 `orphan`（孤儿端口），**不自动重启**

**连接型判活（`health.type: connection`）必须按 pid 过滤**：同一台机器上
`generateclient` 和 `generatetool` 可能都连 3601，不按 pid 过滤的话「A 连着」会让 B 也显示健康，
那正是假活漏判的根源。

### 4.2 ack

```json
{
  "node": "node-145",
  "type": "ack",
  "sentAt": 1761450031000,
  "payload": {
    "seq": 42,
    "taskId": "t-20261026-0001",
    "status": "ok",
    "kind": "stop",
    "component": "webapi",
    "pid": 12880,
    "matchBy": "port",
    "durationMs": 2870,
    "portFree": true,
    "message": "已停止"
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `pid` | **实际被停掉 / 刚启动的**真实进程号（识别出来的，不是 spawn 返回值） |
| `matchBy` | `port` / `cmdline`，说明这个 pid 是怎么认出来的 |
| `durationMs` | 从收到指令到终态确认的耗时 |
| `portFree` | 停止后端口是否已释放；`null` = 该组件没有端口或没复查 |
| `listening` | 启动后端口是否在监听（启动类指令才有） |
| `alreadyRunning` | `start` 时发现本来就在跑（没有重复起） |
| `wasRunning` | `restart` 之前是否真的在跑；`false` 表示只是补启动 |
| `logFile` | 该组件的输出日志（启动类指令才有） |
| `releaseId` | `stage` 的同步包 id，原样回带 |
| `landed` / `deleted` / `skipped` | `stage`：写入、删除、跳过的文件数 |
| `bytes` | `stage`：实际写盘字节数 |

`stage` 的 ack 形状：

```json
{ "seq": 43, "taskId": "t-mvrv…", "status": "ok", "kind": "stage", "component": null,
  "releaseId": "rel-20261028-152704-xxx8",
  "landed": 2, "deleted": 1, "skipped": 0, "bytes": 39, "durationMs": 27,
  "message": "写入 2 · 删除 1 · 跳过 0 · 0.0 KB" }
```

### 4.3 nack

```json
{
  "node": "node-145",
  "type": "nack",
  "sentAt": 1761450031000,
  "payload": { "seq": 42, "taskId": "t-…", "code": "busy", "message": "上一条指令还在执行，稍后重试" }
}
```

| code | 含义 | 还能做什么 |
| --- | --- | --- |
| `control_disabled` | 本机 `allowControl` 是 `observe`（不收文件）或 `stage`（不收启停指令） | 改 bootstrap 后重启 agent |
| `busy` | 上一条指令还在跑 | 稍后重试 |
| `not_configured` | 本机配置里没有这个组件 | 主节点保存配置 → 重发 hello |
| `unsupported` | `kind` 不认识 / 纯文件组件 | 只能人工处理 |
| `not_running` | 没找到该组件的进程 | 已经停了，不用再停 |
| `not_ours` | 端口被**别的程序**占着 | 人工确认；控制面绝不误杀 |
| `identify_mismatch` | 端口上的进程命令行对不上（多半是端口配错了，指到了邻居身上） | 先修 `port`，别硬停 |
| `still_alive` | 杀了但超时仍没退出 | 人工看进程（可能要 `/F` 之外的手段） |
| `no_start` | 配置里没有 `start.cmd` | 补配置，或人工启动 |
| `bad_cwd` | 工作目录不存在 / 不是目录 | 修 `localRoot` 或 `start.cwd`，别硬起 |
| `port_busy` | 启动前发现端口已被别的进程占用 | 先处理占用者（可能是孤儿端口） |
| `exited` | 进程起来了但立刻退出（`message` 里带日志尾巴） | 看 `logFile` 的内容 |
| `start_timeout` | 等不到进程就绪 / 端口没监听 | 看 `logFile`；慢启动的调大 `start.timeoutMs` |
| `spawn_failed` | 命令找不到或起不来 | 检查 `start.cmd` 与 PATH |
| `log_failed` | 日志目录不可写 | 修 `logDir` 权限 |
| `manifest_missing` | 共享上读不到 `<share>\manifest.json`（共享没挂上 / 权限 / 同步包被清了） | 在 98 上确认共享与同步包目录，重发 |
| `partial` | `stage` 有文件没落成（`message` 里带第一条原因，`errors` 最多 5 条） | 修权限/占用后重发；已落地的文件不重复写 |
| `sha_mismatch` | 共享上的文件与 manifest 的 sha256 对不上（复制坏了 / 被改过） | 重新打包，别绕过校验 |
| `bad_path` | manifest 里的路径越界或含非法字符 | 说明同步包有问题，查 98 侧打包 |
| `no_local_root` | 该组件在本机没有 `localRoot` | 补配置后重发 hello |
| `not_configured` | 本机配置里没有这个组件 | 主节点保存配置 → 重发 hello |
| `inventory_failed` | 读进程表失败 | 看 agent 日志 |
| `error` | 其他异常 | 看 `message` |

### 4.4 probe

```json
{
  "node": "node-145",
  "type": "probe",
  "sentAt": 1761450031000,
  "payload": {
    "requestId": "p-0007",
    "items": [
      { "key": "component.generateclient.localRoot", "ok": true,  "detail": "exists, 342 files" },
      { "key": "storage.sharedRoot",                 "ok": false, "detail": "unreachable: 0x80070035" },
      { "key": "component.tools.venv",               "ok": true,  "detail": ".venv\\Scripts\\python.exe" },
      { "key": "port.4000",                          "ok": true,  "detail": "listening by pid 8812" }
    ]
  }
}
```

### 4.5 action（启停台账）

成员每次真执行了启动 / 停止 / 重启 / 落文件，都会**主动上报一条**（不是主节点问）：
主节点按 `id` 去重后落 `state\actions\YYYYMMDD.jsonl`，界面「启停记录」读它。
成员本机同时写一份 `logs\actions-YYYYMMDD.jsonl`。

```json
{
  "node": "node-149",
  "type": "action",
  "sentAt": 1761450031000,
  "payload": {
    "record": {
      "id": "node-149-1761450031000-a1b2c3",
      "at": 1761450031000,
      "node": "node-149",
      "component": "shp_buildings",
      "action": "start",
      "result": "ok",
      "code": null,
      "pid": 8812,
      "durationMs": 4529,
      "message": "已启动",
      "taskId": "t-0007"
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `action` | `start` / `stop` / `restart` / `stage` / `exit` / `lost`（`lost` 预留，暂不产生） |
| `result` | `ok` / `fail`（失败时 `code` 带原因，如 `exit_1`、`still_alive`、`timeout`） |
| `id` | 幂等键；成员重发同一条时主节点返回 `{ok:true, duplicate:true}` 并不写盘 |
| `pid` | 执行后的进程 pid（`stop` 是刚被杀掉的 pid，`stage` 为 `null`） |
| `durationMs` | 这条动作花了多久（`stop` 含等待退出，`start` 含等端口/认进程） |

> `exit` 是**进程自己退出**（崩溃、被人从任务管理器杀掉）。我们主动停的进程不算 ——
> 停之前成员先把 pid 记进抑制表，那颗进程的 exit 直接忽略，所以正常停止不会留假告警。

---

## 5. 序号与抵达语义

```
成员维护 lastSeq（持久化到 state/agent.json）
主节点维护每个节点的 deliveredSeq / ackedSeq

投递：至少一次（at-least-once）
去重：成员按 seq 幂等 —— 重复执行必须得到相同结果
顺序：同一节点的任务串行执行，不并发
```

- **至少一次**而不是「恰好一次」：网络失败时无法确认对方是否收到，
  只能重发，然后靠幂等去重
- 成员执行完一条任务才请求下一条（`stream?since=<lastSeq>` 重连即可），
  所以天然串行，不需要锁排队
- 主节点重启后从 `state/queue.json` 恢复未 ack 的任务，`seq` 继续递增，不回绕

### 5.1 任务租约

`taskLeaseMs`（默认 120s）：成员收到任务后必须在租约内 ack/nack，
否则主节点认为投递失败并重新入队。执行时间可能超过租约的（如 `stage` 构建），
成员需在 50%/80% 处上报一次 `ack{status:"progress"}` 续租。

---

## 6. 超时与重连

| 项 | 值 | 说明 |
| --- | --- | --- |
| 服务端 `ping` | 15s | 空闲时也发 |
| 客户端读超时 | 45s | 连续 45s 无任何字节 → 判链路死，主动断开重连 |
| 重连退避 | 1s → 2s → 5s → 10s → 30s | 封顶 30s，叠加 0~30% 抖动 |
| 首次连接 | 立即 | 不等待 |
| `bye` 后重连 | 3s（取 `retryAfterMs`） | 主节点重启场景 |
| 单条任务默认超时 | 30s（`stop`/`start`）；600s（`stage` 构建） | 由 `timeoutMs` 指定 |

**为什么客户端要自己判死**：中间设备可能静默丢弃连接（没有 FIN/RST），
TCP 那头以为还连着。只有「N 秒没收到任何字节」才能发现。

---

## 7. 错误码

| code | HTTP | 含义 | 成员处置 |
| --- | --- | --- | --- |
| `unauthorized` | 401 | 签名不对 / 未知节点 | 检查 `secret` 与 `nodeId`，不重试 |
| `clock_skew` | 401 | 时间差超窗 | 检查 NTP，10s 后重试 |
| `replay` | 401 | nonce 重复 | 换 nonce 重试 |
| `proto_mismatch` | 426 | 协议版本不符 | 停止重试，提示升级 |
| `not_configured` | 403 | 组件不在该节点配置里 | 不回退，报告给主节点 |
| `busy` | 409 | 组件正在执行任务 | 由主节点决定排队还是放弃 |
| `path_denied` | 403 | 路径逃出 `localRoot` | 不重试，安全事件 |
| `path_missing` | 422 | 配置的路径不存在 | 提示走配置页 |
| `hash_mismatch` | 422 | 落地文件校验失败 | 丢弃该 release，重新 `stage` |
| `timeout` | 504 | 执行超时 | 上报实际状态（可能已部分完成） |
| `internal` | 500 | 未分类 | 附 stack 摘要，最多重试 3 次 |

---

## 8. 管理端接口（`/api/ui/*`）

只列形状，字段以实现为准；这些接口只由 98 自己的界面调用。

### 8.1 已实现

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/healthz` | 自检：pid、端口、扫描源数量 |
| `POST` | `/api/ui/scan` | 现场扫描一次；没有基线时先建基线并写一份空清单 |
| `GET` | `/api/ui/pending` | 最近一次变更清单；从未扫过返回 `404 {empty:true}` |
| `GET` | `/api/ui/config` | 节点 × 组件的当前配置（含 revision、共享目录是否继承全局） |
| `POST` | `/api/ui/config` | 保存配置，body `{ changes: [{ ip, component?, field, value }] }` |
| `POST` | `/api/ui/config/probe` | 只在主节点本机 stat 路径；其它机器返回「未探测」 |
| `GET` | `/api/ui/nodes` | 各节点实时状态（M0）：由成员上报的观测推导，见 §4.1 |
| `POST` | `/api/ui/task` | 下发指令（`start` / `stop` / `restart`），见下 |
| `POST` | `/api/ui/stage` | 做同步包并让成员就地覆盖文件（M2），见下 |
| `GET` | `/api/ui/releases` | 同步记录列表（摘要，最多 50 条） |
| `GET` | `/api/ui/releases/{relId}` | 单次同步的**文件级明细**（见 §8.3） |
| `GET` | `/api/ui/actions` | 启停记录（分页 + 筛选 + 顶部统计，见下） |
| `GET` | `/api/agent/stream` | 成员常驻 SSE（M0：只发 `hello` / `ping`） |
| `POST` | `/api/agent/report` | 成员上报（`hello` / `snapshot` / `ack` / `nack` / `probe` / `action`） |

#### `GET /api/ui/actions`

```powershell
curl "http://127.0.0.1:47821/api/ui/actions?page=1&size=15&node=149&component=shp_buildings&action=stop&result=fail"
```

```json
{
  "ok": true, "days": 30,
  "total": 19, "page": 1, "size": 15, "pages": 2,
  "stats": {
    "today": 14, "fail": 1,
    "lastFail": { "ts": "2026-10-29T10:40:35+08:00", "node": "node-149", "component": "demo", "action": "exit", "code": "exit_1", "message": "进程自己退出 code=1" },
    "last":     { "ts": "2026-10-29T10:48:38+08:00", "node": "node-149", "component": "demo", "action": "start" }
  },
  "items": [ { "id": "node-149-…", "at": 1761450031000, "ts": "2026-10-29T10:47:43+08:00", "node": "node-149",
               "component": "demo", "action": "start", "result": "ok", "code": null, "pid": 26616,
               "durationMs": 4746, "message": "已启动", "taskId": "t-0007" } ]
}
```

`size` 默认 15、上限 200；`page` 越界会被夹到 `1..pages`；`node` 认 `149` 和 `node-149` 两种写法
（写 `149` 也能查到，筛选不会因为前缀不同而空掉）。

#### `POST /api/ui/task`

```json
{ "node": "149", "component": "webapi", "action": "stop" }
```

`action` 只接受 `start` / `stop` / `restart`；`node` 认 `149` / `node-149` / `172.16.1.149` 三种写法。成功：

```json
{ "ok": true, "taskId": "t-mvrr7yt9-u429s", "node": "node-149", "action": "restart", "component": "svcA",
  "pid": 31640, "matchBy": "port", "durationMs": 10101, "listening": true, "portFree": null,
  "alreadyRunning": false, "wasRunning": true, "logFile": "C:\\vcsNode\\logs\\svcA.log", "message": "已启动" }
```

`start` 的 `alreadyRunning: true` 表示本来就在跑（没有重复起，`pid` 是那个现成的进程）；
`restart` 的 `wasRunning: false` 表示它之前本来就没跑，这次实际只做了启动。

失败直接透传成员的 `code`（`409` 起步，`504` 是成员没回执）：

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `bad_request` | 缺 `action` / `component` |
| 400 | `bad_action` | `action` 不是 start/stop/restart |
| 400 | `manual_node` | 目标是同步源（98），只能人工操作 |
| 400 | `no_process` | `kind: asset` 的纯文件组件 |
| 400 | `no_start` | 配置里没有 `start.cmd`（启动/重启） |
| 404 | `unknown_node` / `not_configured` | 节点或组件不在配置里 |
| 409 | `node_offline` | 成员没有常驻 SSE，指令发不出去 |
| 409 | 成员的 `nack` code | `not_running` / `not_ours` / `identify_mismatch` / `bad_cwd` / `port_busy` / `exited` / `busy` / `control_disabled` …（见 §4.3） |
| 504 | `task_timeout` | 成员没回 ack/nack：`stop` 30s，`start` / `restart` 60s |

超时只是「主节点没等到回执」，指令可能已经在成员上执行了 —— 先看矩阵和事件流水再重试。

#### `POST /api/ui/stage`

把待同步区里勾选的文件复制到共享、写 `manifest.json`，再让每台目标机就地覆盖。**不启停进程。**

```json
{
  "components": ["shp_buildings"],
  "paths": { "shp_buildings": ["index.js", "lib/new.js", "old.js"] },
  "includeDeletes": true,
  "nodes": ["149"],
  "force": false,
  "note": "可选备注"
}
```

- `paths` 省略 = 该组件在清单里的全部文件；`includeDeletes: false` 时清单里的 `D` 项一律不发
  （删除必须显式确认，界面上的「含删除」勾选框就是它）。
- `nodes` 省略 = 所有部署了这些组件的成员。
- `force: true` 才能覆盖「组件还在跑」的目标（默认 409 `not_stopped`；正在被读的文件覆盖成半新半旧没有意义）。

成功（`200 { ok:true, status:"landed" }`）：

```json
{ "ok": true, "releaseId": "rel-20261028-152704-xxx8", "status": "landed",
  "dir": "\\\\172.16.2.98\\Tools\\_vcs\\releases\\rel-20261028-152704-xxx8",
  "stats": { "files": 2, "deletes": 1, "added": 1, "modified": 1, "bytes": 39, "components": ["shp_buildings"] },
  "nodes": { "149": { "ok": true, "landed": 2, "deleted": 1, "skipped": 0, "bytes": 39, "ms": 27,
                      "landedAt": "2026-10-28T15:27:04+08:00" } },
  "durationMs": 512 }
```

有节点失败时仍是 `200`，但 `ok:false`、`status` 为 `partial` / `failed`，`nodes.<id>.error` 给原因；
**这批文件不会从待同步区移除**（不推进基线），修好后原样重发，已落地的文件会被重写一遍（幂等）。

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `bad_request` / `not_in_pending` | 没选组件 / 组件不在清单里 |
| 400 | `no_target` | 这些组件没有任何已部署的成员（成员 `localRoot` 都没填） |
| 400 | `empty_selection` | 勾选和清单对不上，或只勾了删除项但没 `includeDeletes` |
| 409 | `no_pending` | 待同步区是空的 |
| 409 | `busy` | 上一次更新还没走完 |
| 409 | `node_offline` | 有目标机不在线（不允许只发一半） |
| 409 | `not_stopped` | 目标组件还在 `running` / `degraded` |
| 409 | `layout_mismatch` | 扫描源 ≠ 98 实际运行目录，**就地覆盖会出错，必须先改 `sources`** |
| 500 | `share_not_configured` / `share_not_writable` / `copy_failed` | 共享没配 / 写不进去 / 源文件在扫描后消失 |

#### `POST /api/ui/config` 成功返回：

```json
{ "ok": true, "changed": 3, "revision": 8,
  "updatedAt": "2026-10-26T14:22:55+08:00",
  "backup": "config/backup/vcsnode-20261026-142255.yaml" }
```

失败一律 `400 { ok:false, error }`，错误原文直接显示在界面上：
字段不支持、该节点没部署这个组件、端口越界、路径不是绝对路径或 UNC、写前结构校验不通过。
**出错时原文件一个字节都不动。**

写接口（所有 `POST`）只接受回环地址与 `cluster.allowedPeers` 内的来源；其余返回 `403`。
读接口不开这个限制——内网只读本来就是这个系统的前提。

### 8.2 设计稿（未实现）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/ui/config/rollback` | 回退到指定 revision |
| `GET` | `/api/ui/release/pending/{id}` | 取草稿（含每个文件的勾选状态） |
| `PATCH` | `/api/ui/release/pending/{id}` | 改勾选 / 加 `skipList` / 整目录操作 |
| `POST` | `/api/ui/release/publish` | 复核 + 触发 STAGE（可只选部分 set） |
| `POST` | `/api/ui/release/commit` | 触发 COMMIT |
| `POST` | `/api/ui/release/rollback` | 回退某 set |
| `GET` | `/api/ui/events?since=` | 审计流水 |

### 8.3 同步记录：文件级明细（M2 已实现）

「同步记录 → 详情」要回答两个问题：**这一版更新了哪些文件**、**什么时候落到每一台**。
所以 manifest 必须按文件记录时间，事后不重新扫描（重扫只能得到「现在」，得不到「当时」）。

同步包在共享上（`manifest.json` 与 `GET /api/ui/releases/{relId}` 返回同一份内容）：

```json
{
  "format": 1,
  "relId": "rel-20261028-152704-xxx8",
  "createdAt": "2026-10-28T15:27:04+08:00",
  "by": "172.16.2.98",
  "note": "",
  "storeDir": "_vcs",
  "components": ["shp_buildings"],
  "files": [
    {
      "component": "shp_buildings",
      "path": "index.js",
      "action": "M",
      "blob": "files/shp_buildings/index.js",
      "sha256": "ab65ef1c…（完整 64 位）",
      "size": 19,
      "mtimeMs": 1761636412000,
      "sourceMtime": "2026-10-28T15:26:52+08:00"
    }
  ],
  "deletes": [
    { "component": "shp_buildings", "path": "old.js", "size": 7 }
  ]
}
```

同步记录（`state/releases/<relId>.json`）在 manifest 之外多出执行结果：

```json
{
  "relId": "rel-20261028-152704-xxx8",
  "status": "landed",
  "counts": { "A": 1, "M": 1, "D": 1 },
  "bytes": 39,
  "durationMs": 512,
  "dir": "\\\\172.16.2.98\\Tools\\_vcs\\releases\\rel-20261028-152704-xxx8",
  "nodes": {
    "149": { "ok": true, "landed": 2, "deleted": 1, "skipped": 0,
             "bytes": 39, "ms": 27, "landedAt": "2026-10-28T15:27:05+08:00" }
  }
}
```

三个时间点**不能混**，界面上一律分开显示：

| 字段 | 含义 | 从哪来 |
| --- | --- | --- |
| `sourceMtime` | 源文件在 98 上的最后修改时间 | 打包时 stat 源文件 |
| `landedAt` | 这批文件在该节点写盘完成的时间 | 成员回执时刻（主节点记） |
| `createdAt` + `durationMs` | 发起时刻与总用时 | 主节点 |

两点已知粗略，别当成精确值：

- `landedAt` 是**节点级**的（一次 `stage` 落一批文件，回执只有一个完成时刻）。逐文件时间要成员逐个回报，
  M3 连 `commit` 一起细化。
- 没有逐文件 `detectedAt`：清单里只有整次扫描的 `createdAt`（`pending.createdAt` / `id`）。

**状态**：`landed`（所有目标机都成功）/ `partial`（有的成有的败）/ `failed`（全败）。
只有 `landed` 才推进基线、把文件从待同步区移除；`partial`/`failed` 原样保留，修好重发。

保留策略：`state/releases.json` 只留最近 50 条摘要，明细在 `state/releases/<relId>.json`；
共享上的同步包按 `storage.keepReleases`（默认 5）滚动删除，删包不删记录（记录里的 `dir` 会指向已删目录）。

---

## 9. 兼容与演进

- `proto` 整数，只在**破坏性变更**时 +1；加字段不算破坏（两端都必须忽略未知字段）
- 主节点同时支持 `proto: 1`；收到更高版本回 `426` 并带上支持范围，
  成员据此提示「agent 需升级」，不崩溃
- 破坏性升级步骤：先升级全部 agent → 再升主节点 → 最后切 `proto`

---

## 10. 待定（协议层面）

| # | 问题 | 当前做法 |
| --- | --- | --- |
| 1 | `stage` 的 manifest 是随事件内联还是单独 URL | 走 URL（成员用普通 HTTP 或 SMB 取，取决于现场），manifest 本身很小 |
| 2 | 配置文件是否也走共享目录而非 SSE 内联 | 现在 SSE 内联（几 KB）；若配置变大（组件多、路径多）再改 URL |
| 3 | 是否需要「取消任务」 | 暂不提供。任务幂等 + 短超时，取消的价值低于复杂度 |
| 4 | 主节点高可用 | 不做。98 单点，成员靠 `last-good` 自治 |
