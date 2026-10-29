# state/ —— 运行时状态目录

本目录下的文件**全部由程序在运行时自动创建和改写**，不是源代码，已通过
`.gitignore` 排除在版本控制之外（本文件除外）。

不要手工编辑、不要提交、不要跨机器拷贝。各机器、各次运行的数值都不同，
提交进仓库只会产生「每一秒都变」的假 diff。

## master（98）写入的文件

| 文件 | 内容 |
| --- | --- |
| `nodes.json` | 节点注册表与最近一次观测（`lastSeenAt` / pid / 组件状态 / agent 版本） |
| `baseline.json` | 上一版基线：路径 → sha256，扫描时据此算「改了什么」 |
| `pending.json` | 扫描产出的待同步清单，界面「待同步区」的数据源 |
| `landed.json` | 落地台账：哪个文件已经落到哪台机（按内容哈希记） |
| `config-revision.json` | 配置保存的递增版本号与最后一次改动摘要 |
| `releases.json` | 同步记录索引 |
| `releases\<relId>.json` | 单次同步的明细（逐文件 sha256、各节点落地时间） |
| `actions\YYYYMMDD.jsonl` | 成员上报的启停台账汇总，按天切分，保留 30 天 |

日志不在这个目录：默认写到 `<stateDir 的上一级>\logs\`（`--log-dir` 可改）。

## agent（成员机）写入的文件

成员机的缓存目录由 `agent.bootstrap.json` 的 `cacheDir` 指定，默认是 agent
自身目录下的 `state\`：

| 文件 | 内容 |
| --- | --- |
| `node-config.json` | 上一次从主节点拿到的组件配置缓存，断网时也能继续判活 |
| `agent.json` | 本机节点身份与上报进度（如上次 `seq`） |

成员的启停台账另写 `<cacheDir 的上一级>\logs\actions-YYYYMMDD.jsonl`。

## 缺失是正常的

所有读取都按「读不到就用默认值」处理：

- `src/nodes.mjs:89` —— `readJson(this.stateFile, null)`，没有就重新累积
- `src/config-edit.mjs:317` —— `readJson(file, { revision: 0 })`，没有就从 1 开始

因此停服后清理本目录是安全的（会丢掉历史观测、待同步清单和落地台账，
界面上的「上次同步到哪台」会清空，需要重新扫描一次）。

## 写入方式

全部走「临时文件 + rename」原子替换，见 `src/state.mjs`；master 被杀在写一半
不会留下半个 JSON。`nodes.json` 是防抖 1 秒的整体快照（`src/nodes.mjs:109`）。

字段定义与示例见 [`docs/runbook.md` §11](../docs/runbook.md)。
