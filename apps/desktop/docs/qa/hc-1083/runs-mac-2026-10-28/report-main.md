## 冷启动（秒）

| 助手 | pid | 排队等槽 | 引擎就绪 | 就绪依据 | 前一个标记 | 标记→就绪 |
|---|---|---|---|---|---|---|
| default | 94672 |  | 2.3 | READY |  |  |
| default | 95560 |  | 2.5 | READY |  |  |
| default | 95913 |  | 2.4 | READY |  |  |
| apex-bot-2 | 96454 |  | 2.3 | READY | C1 点+ 新建剪辑助手 | 24.0 |
| apex-bot-3 | 98191 |  | 2.4 | READY |  |  |
| apex-bot-4 | 98851 | 0.5 | 3.0 | READY |  |  |
| apex-bot-5 | 2335 | 31.4 | 33.6 | READY | E1 点重试 第4个 | 63.9 |
| default | 3814 |  | 2.2 | READY |  |  |
| apex-bot-2 | 4168 |  | 2.2 | READY | D1 点剪辑助手 | 2.7 |
| apex-bot-3 | 4357 |  | 2.2 | READY | D1 点选题助手 | 2.7 |
| apex-bot-4 | 4499 | 0.4 | 2.7 | READY | D1 点带货脚本 | 2.7 |
| apex-bot-5 | 8225 |  | 2.2 | READY | E1b 再点第4个(剪辑助手已超4分钟) | 2.8 |
| apex-bot-2 | 13076 |  | 2.2 | READY | F2 点剪辑助手、发长任务 | 2.9 |
| apex-bot-2 | 13791 |  |  | 没就绪 | F2 点剪辑助手、发长任务 |  |
| default | 17509 |  |  | 没就绪 |  |  |

## 内存（MB）

| 助手 | pid | 就绪 30 秒后 RSS | USS | 连子进程峰值 |
|---|---|---|---|---|
| default | 94672 | 346 |  | 346 |
| default | 95560 | 345 |  | 345 |
| default | 95913 | 325 |  | 363 |
| apex-bot-2 | 96454 | 286 |  | 352 |
| apex-bot-3 | 98191 | 286 |  | 324 |
| apex-bot-4 | 98851 | 288 |  | 327 |
| apex-bot-5 | 2335 | 219 |  | 323 |
| default | 3814 | 351 |  | 435 |
| apex-bot-2 | 4168 | 340 |  | 340 |
| apex-bot-3 | 4357 | 289 |  | 354 |
| apex-bot-4 | 4499 | 288 |  | 353 |
| apex-bot-5 | 8225 | 363 |  | 366 |
| apex-bot-2 | 13076 | 356 |  | 362 |

测试家目录下全部进程 RSS 峰值 2359 MB；同时在跑的引擎最多 4 个。

## 池事件和引擎退出

- 2026-10-28T08:54:47.208Z slot_wait apex-bot-4 — Profile backend "apex-bot-4" waiting for a free local slot (2/3 busy, 1 queued)
- 2026-10-28T08:55:23.852Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)
- 2026-10-28T08:55:53.858Z slot_timeout apex-bot-5 — Hermes backend for profile "apex-bot-5" failed to start: Local backend start for "apex-bot-5" timed out while waiting for a free slot.
- 2026-10-28T08:55:54.147Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)
- 2026-10-28T08:56:24.626Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)
- 2026-10-28T08:56:55.095Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)
- 2026-10-28T08:57:25.100Z slot_timeout apex-bot-5 — Hermes backend for profile "apex-bot-5" failed to start: Local backend start for "apex-bot-5" timed out while waiting for a free slot.
- 2026-10-28T08:57:25.229Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)
- 2026-10-28T08:57:56.042Z evict apex-bot-2 — Evicting idle profile backend "apex-bot-2" (LRU cap 3)
- 2026-10-28T08:57:56.208Z exit apex-bot-2 — Hermes backend for profile "apex-bot-2" exited (SIGTERM)
- 2026-10-28T08:59:34.874Z exit apex-bot-4 — Hermes backend for profile "apex-bot-4" exited (SIGTERM)
- 2026-10-28T08:59:34.892Z exit apex-bot-3 — Hermes backend for profile "apex-bot-3" exited (SIGTERM)
- 2026-10-28T08:59:34.942Z exit apex-bot-5 — Hermes backend for profile "apex-bot-5" exited (SIGTERM)
- 2026-10-28T09:00:35.379Z slot_wait apex-bot-4 — Profile backend "apex-bot-4" waiting for a free local slot (2/3 busy, 1 queued)
- 2026-10-28T09:00:48.795Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)
- 2026-10-28T09:01:18.796Z slot_timeout apex-bot-5 — Hermes backend for profile "apex-bot-5" failed to start: Local backend start for "apex-bot-5" timed out while waiting for a free slot.
- 2026-10-28T09:01:19.089Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)
- 2026-10-28T09:01:49.637Z slot_wait apex-bot-5 — Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)
- 2026-10-28T09:06:43.763Z evict apex-bot-2 — Evicting idle profile backend "apex-bot-2" (LRU cap 3)
- 2026-10-28T09:06:43.915Z exit apex-bot-2 — Hermes backend for profile "apex-bot-2" exited (SIGTERM)
- 2026-10-28T09:14:42.796Z evict apex-bot-5 — Evicting idle profile backend "apex-bot-5" (LRU cap 3)
- 2026-10-28T09:14:42.937Z exit apex-bot-5 — Hermes backend for profile "apex-bot-5" exited (SIGTERM)
- 2026-10-28T08:49:49.235Z 引擎进程退出 default（pid 94672）
- 2026-10-28T08:50:10.514Z 引擎进程退出 default（pid 95560）
- 2026-10-28T08:57:56.528Z 引擎进程退出 apex-bot-2（pid 96454）
- 2026-10-28T08:59:35.077Z 引擎进程退出 apex-bot-4（pid 98851）
- 2026-10-28T08:59:35.077Z 引擎进程退出 default（pid 95913）
- 2026-10-28T08:59:35.077Z 引擎进程退出 apex-bot-3（pid 98191）
- 2026-10-28T08:59:35.077Z 引擎进程退出 apex-bot-5（pid 2335）
- 2026-10-28T09:06:44.269Z 引擎进程退出 apex-bot-2（pid 4168）
- 2026-10-28T09:14:43.102Z 引擎进程退出 apex-bot-5（pid 8225）
- 2026-10-28T09:15:30.411Z 引擎进程退出 apex-bot-2（pid 13791）
- 2026-10-28T09:23:43.456Z 引擎进程退出 default（pid 17509）

## 其他

- 含 401 的日志行：0
- 标记 2026-10-28T08:50:38.921Z C1 点+ 新建剪辑助手
- 标记 2026-10-28T08:55:21.678Z C4 建第4个(12字)
- 标记 2026-10-28T08:56:55.006Z E1 点重试 第4个
- 标记 2026-10-28T09:00:04.581Z D1 点剪辑助手
- 标记 2026-10-28T09:00:21.888Z D1 点选题助手
- 标记 2026-10-28T09:00:35.324Z D1 点带货脚本
- 标记 2026-10-28T09:00:48.741Z D1/E1 点第4个 抖音爆款
- 标记 2026-10-28T09:06:43.710Z E1b 再点第4个(剪辑助手已超4分钟)
- 标记 2026-10-28T09:08:41.877Z D3 热切换开始
- 标记 2026-10-28T09:14:42.650Z F2 点剪辑助手、发长任务
- 标记 2026-10-28T09:51:48.460Z F4 发长任务
- 标记 2026-10-28T10:01:11.528Z F4 已发长任务
- 标记 2026-10-28T10:04:49.422Z L1 停止(F4 转码进行中)

