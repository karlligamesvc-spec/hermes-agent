## 冷启动（秒）

| 助手 | pid | 排队等槽 | 引擎就绪 | 就绪依据 | 前一个标记 | 标记→就绪 |
|---|---|---|---|---|---|---|
| default | 45259 |  | 19.8 | listen |  |  |
| apex-bot-2 | 45266 |  | 19.8 | listen |  |  |
| apex-bot-3 | 46266 |  | 2.5 | READY |  |  |
| apex-bot-5 | 49693 | 0.7 | 4.5 | READY |  |  |

## 内存（MB）

| 助手 | pid | 就绪 30 秒后 RSS | USS | 连子进程峰值 |
|---|---|---|---|---|
| default | 45259 | 314 |  | 374 |
| apex-bot-2 | 45266 | 378 |  | 401 |
| apex-bot-3 | 46266 | 291 |  | 325 |
| apex-bot-5 | 49693 | 327 |  | 344 |

测试家目录下全部进程 RSS 峰值 2285 MB；同时在跑的引擎最多 4 个。

## 池事件和引擎退出

- 2026-10-28T10:08:50.818Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (2/3 busy, 1 queued)
- 2026-10-28T10:19:19.205Z reap apex-bot-3 — Reaping idle profile backend "apex-bot-3" (idle > 600s): committed
- 2026-10-28T10:19:19.352Z exit apex-bot-3 — Hermes backend for profile "apex-bot-3" exited (SIGTERM)
- 2026-10-28T10:20:19.208Z reap default — Reaping idle profile backend "default" (idle > 600s): committed
- 2026-10-28T10:20:19.380Z exit default — Hermes backend for profile "default" exited (SIGTERM)
- 2026-10-28T10:19:19.813Z 引擎进程退出 apex-bot-3（pid 46266）
- 2026-10-28T10:20:19.573Z 引擎进程退出 default（pid 45259）

## 其他

- 含 401 的日志行：0
- 标记 2026-10-28T10:09:40.699Z I1 退出登录前

