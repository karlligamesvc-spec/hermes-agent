# hc-1083 多助手第一期验收记录（M7）

状态：**Mac 部分进行中**（2026-10-28），Windows 等机器。本记录随验收更新。清单见同目录 `README.md`。

## 1. 版本、环境和一次隔离失效

| 项 | 值 |
|---|---|
| 版本 | Desktop 0.17.66 正式包：2026-10-28 05:32Z 发布，fork run 40635434353，引擎钉 `aa8e554e`（v2026.10.27-fork.aa8e554e）。Mac DMG 的 sha512 和 feed `latest-mac.yml` 一致 |
| 机器 | Mac Studio（Mac16,9，Apple M4 Max，128 GB，macOS 27.0.1），computer use 驱动 |
| 账号 | Flash 测试账号（免费档），Kael 本人登录 |
| 线上开关 | 开测时是 v5（06:14Z 起 `multi_bot: true`），09:50Z 起是 v6（加 `multi_bot_max: 4`） |
| 时间 | 08:06Z–10:10Z（UTC） |
| 证据 | 截图在 `screenshots/`；watch 记录、`report` 输出、快照在 `runs-mac-2026-10-28/`（测试目录路径已换成 `<test-dir>`，不含密钥） |

**隔离失效（06:07Z–06:53Z，第 A 组原计划的 0.17.65 对照副本）**：

- 06:07:29 副本在测试目录启动，HERMES_HOME、userData 都在测试目录。
- 06:08:34–06:12:59 它自己下载 0.17.66，放进共用缓存 `~/Library/Caches/hermes-updater/pending`。
- 06:34:53 Kael 在副本里登录。
- 06:50:44 副本判断自己空闲，执行 `quitAndInstall`。
- 06:50:50–52 ShipIt 把副本换成 0.17.66，再经 LaunchServices 拉起它，**不带测试目录的环境变量**。
- 06:50:53–06:53:06 副本用本机真实的 `~/.apexnodes` 和真实 userData 跑了约 2 分钟。期间它：
  - 装了引擎 `versions/aa8e554e3878` 和 63 个平台技能；
  - config-guard 改了 `config.yaml` 的 model 块；
  - 把没改过的上游 `SOUL.md` 换成了 APEX 默认版。
- 托管 key、`.env`、`active-profile.json`、`profiles/` 都没动：真实 key 指纹 `8c07f46d7be3`，和两个测试副本都不同。
- 06:53:14 起来的是 Kael 自己的 `/Applications/APEX`（当时是 0.17.62）。它在共用缓存里找到已下载的 0.17.66，07:02:52 自己装上重启。
- 处理：
  - 规定只跑线上最新版，两个脚本的 `prepare` 加了版本闸；
  - `fresh-env-mac.sh isolation` 每次启动后核对隔离；
  - 第 A 组改用 0.17.66 加 `APEXNODES_MULTI_BOT=0`；
  - 「关掉测试副本的自更新」：协调会话批的第一个办法（改副本的 app-update.yml，把 url 指向 127.0.0.1:9）在这台 Mac 上行不通，见下。
- 关自更新试过的办法（2026-10-28 12:4x–12:53Z）：
  - 改 `app-update.yml`：已经启动过的副本，macOS 的「App 管理」保护不让改（沙箱外也是 Operation not permitted）。没启动过的新副本能改，但签名封印失效，启动后卡在 `_dyld_start` 不动，macOS 首启检查不放行。那份副本已挪到测试目录的 `APEX-blocked-stuck.app`，不再用，测完删。
  - 启动参数 `--proxy-pac-url`（file:// PAC，只把 COS feed 指向死代理）、`--host-resolver-rules`（feed 域名 `~NOTFOUND`）：都挡不住，照样读到「Update for version 0.17.66 is not available」。
  - 现在的办法（等协调会话确认）：
    - 只跑线上最新版，`prepare`、`launch` 都读 feed 核对；
    - `launch` 同时起看门狗，日志一出现「[shell-update] Found version / update available」就结束副本，只看这次启动之后写的行；
    - `isolation` 核对引擎 HERMES_HOME、真实 desktop.log、共用更新缓存 `~/Library/Caches/hermes-updater`、看门狗记录。
- 另：副本登录前日志有 `provision-key unavailable (MANAGED_DEVICE_LIMIT_REACHED)`，每个全新副本都算一台新设备。已请协调会话查账号设备数。

后面的 A 组到 N 组都在一个 0.17.66 测试家目录里跑：先用 A 组的 `--multi-bot-off`，再按 B 组切到开，后面一直用它，这样少一次人工登录。这个家目录是空目录起的，没有预置状态。

## 2. 每一步的结果

| 组 | 结果 | 说明 / 证据 |
|---|---|---|
| A1 | 通过 | 一行 APEX，没有「+」，没有「管理APEX」，设置标题「设置」；「你好，今天几号？」回答对（`a1-flag-off-date-reply.jpg`） |
| A2 | 通过 | 没有 `profiles/`；只有主引擎；`APEXNODES_MULTI_BOT=0`、`APEX_SINGLE_THREAD_ACTIVE=1`，没有 `APEX_MULTI_BOT_ACTIVE`（`snap-A2.json`）；`check` 没有 FAIL |
| A3 | 通过 | 开发者模式是上游侧栏（开始、沉浸式分析、会话列表），没有多助手元素 |
| B1 | 通过 | 打开后第一行 APEX、原主线和历史都在、出现「+」、没有多出助手；引擎 `APEX_MULTI_BOT_ACTIVE=1`（`snap-B1.json`） |
| B2 | 通过 | 关回去还是一行 APEX，主线在 |
| C1 | 通过 | 面板预览实时变、6 形状 6 颜色没有紫色、「紫色圆是 APEX 的，留给它。」；建好直接进对话、问候和三问对。「跟 APEX 一样」只在 APEX 自己答过平台时才出现（`bot-intake.tsx` `optionsFor`），本家目录没答过，所以没有，属预期（`c1-*.jpg`） |
| C2 | 通过 | 「剪辑助手 记下了：管剪辑出片 · 简短直接 · 抖音 · 撤销」；SOUL 有「## 分工」；`shared` 不变。回答用新名字和分工。日期对，但模型自己加了一句「北京时间已经是 29 号了」，是错的：提示里只有日期没有钟点，模型猜错了，不是多助手的问题 |
| C3 | 通过（换了个助手做） | 发过消息后三问卡片和「撤销」就不在对话里了，所以在第 2 个助手上、发第一句之前撤销：「已撤销，这三条不记」，`intake_status` undone，「## 分工」删掉，SOUL 回到 490 字（`c3-intake-undone.jpg`）。清单已改顺序 |
| C4 | 通过 | 13 字「最多 12 个字」、重名「已经有助手叫这个名字了」都拦住；emoji 名、12 字名可建，长名字省略显示（`c4-*.jpg`）。**建第 4 个时撞上问题 1** |
| C5 | 通过 | 「+」的无障碍名含「先删掉」；面板「已经有 4 个了，先删掉一个再建」，「建好了」灰掉（`c5-full-panel.jpg`）。当时是 v5，上限 5 |
| C6 | 通过 | APEX 的「···」只有「改名」（`c6-apex-menu-rename-only.jpg`） |
| C7 | 通过 | C1、C3–C5、C7–C9 PASS；C2 只差 `.apex-manifest` 同步戳，是工具的问题，已修；C6 见 G 组 |
| C8 | 没做 | 等关自更新的办法批了再测 |
| C9（有 4 个助手的人） | 没做 | v6 生效后测 |
| D1 | 通过 | 冷启动引擎就绪约 2.2–2.5 秒，点击到能输入约 2.7–4 秒（见第 3 节）；「正在唤醒 <名字>」写的是助手名字。第 4 个见问题 1 |
| D2 | 通过 | 4 个助手各一句，都用自己的名字回答，日期对 |
| D3 | 通过 | 来回切 10 次，没有新的引擎进程 |
| E1 | **不通过** | 问题 1 |
| E2 | 没做 | 侧栏切换里 `makeRoomInPool` 从没跑过（问题 1），「都在做事」那条路走不到；hc-1093 修好后在 0.17.67 上测 |
| E3 | 通过 | 09:34:04Z、09:44:04Z 闲置的池引擎「Reaping idle profile backend … (idle > 600s): committed」，主引擎不受影响 |
| E4 | 通过 | 被挤掉 / 回收过的助手点回去，历史在、能回复 |
| E5 | 已记 | 见第 3 节 |
| F0 | 通过 | Mac Studio 上 20 秒素材：slow 2.9 秒、veryslow 6.8 秒、placebo 28.1 秒 |
| F2 | 通过 | 剪辑助手转码 qa-20min 前 10 分钟（placebo）。09:15:20Z–09:32:18Z 跑了约 17 分钟（另有一个转码同时在跑，CPU 互相抢）；输出 600.0 秒；最后的回答 09:34:10Z 送达（assistant / stop）；期间剪辑助手的引擎没被挤也没被回收 |
| F3 | 部分 | F2 期间切到另外两个助手，剪辑助手没被挤；第 4 个没点成（系统弹窗打断） |
| F4 | 做不了 | 有回合在跑时主窗口关不掉（问题 6） |
| F1、F5、F6 | 没做 | F5 要有人在机器前；F6 只在 Windows |
| G1 / G5 | 通过 | 在「抖音爆款标题文案专家小王」上改名「小王」，形状 水滴→圆、颜色 金→绿：`diff` 只动它的 `ui_meta.apex`（name、shape、color）和 SOUL 第一行，目录名、`origin`、`shared` 都没变（`g1-g5-*.jpg`）。剪辑助手当时切不过去（问题 2），所以换了助手 |
| G2 | 通过 | 「以后你叫小题」：`ran.apex_rename` +1（模型发的调用记在分发器 `tool_call` 下）；`apex_memory` 没增加；侧栏、头部、输入框、「小题 记下了」都跟着变；SOUL 第一行变成 `You are 小题, …`；`shared` 不变。下一轮「我叫小题，是你刚给我改的名。」（`g2-rename-by-sentence.jpg`） |
| G2b | 通过 | 「你改叫小货吧」：同上四处，下一轮自称小货 |
| G3 | 通过 | APEX（G4 后叫小橙）答「我叫小橙，以后就这么叫我吧。」；各助手名字不串 |
| G4 | 通过 | APEX 改名面板只有名字；改成小橙后仍是紫色圆、第一行；「在微信里找 小橙」、「给 小橙 发消息」都变；重启后保持 |
| H1–H3 | 没做 | 等关自更新的办法批了 |
| I1–I3 | 没做 | 已点「重新登录」，等人登录时暂停。重新登录的界面和首启登录界面不一样（问题 8） |
| J1 / J2 | 部分 | 新助手一建好就有全套 246 个平台技能文件，和根目录一致、版本一样；和服务端版本的对照没做 |
| K1 | 通过 | 小题里「记住：我的账号叫小橙子测评，主做美妆」：「小题 记下了：账号叫「小橙子测评」，主要美妆内容」，`apex_memory` 跑了 1 次，共用镜像变了；剪辑助手的设置 ›「它记得什么」里也看得到 |
| K2 | **不通过** | 问题 3 |
| S1 | 通过 | 「剪辑助手 的设置」、「小橙 的设置」；开关关时是「设置」 |
| S2 | 通过 | 剪辑助手 设置 › 对话 关「推理过程块」：`diff` 只动 `homes.apex-bot-2.config.sections.display`，根目录 `show_reasoning` 还是 true；之后改回 |
| S3 | 通过 | 「档位所有助手共用，这里改的是账户的(跟 小橙 一样)。别的设置是这个助手自己的。」（`s3-shared-tier-note.jpg`）。见问题 5 |
| S4 | 没做 | Flash 账号；没试换档 |
| S5 | 通过 | APEX 上的模型页没有那句共用说明 |
| L1 | 部分 | 重启后顺序、名字、样子都保持；APEX 第一行。F4 那一轮被重启打断，对话里没说被打断（问题 7） |
| L2 | 部分 | App 和引擎都退了，但引擎起的 ffmpeg 变孤儿继续跑（问题 7）；`stop` 已改成按工作目录也能找到 |
| L3、N1、N3 | 没做 | |
| N2 | **不通过** | 问题 4 |
| P1 | 通过 | 全新目录、不设任何 install env：首启时没有缓存的配置，主进程三个开关都没设，引擎没有 `APEX_SINGLE_THREAD_ACTIVE` / `APEX_MULTI_BOT_ACTIVE`；同一次启动 12:50:44Z 存下 v6（`client-config stored platform config v6 (boot)`） |
| P2 | 部分 | 首启的界面（登录页后面）也是上游样子（「开始 ⌘N」「沉浸式分析」「网关 检查中」），不是单线也不是多助手，和引擎一致，没看到不一致。登录后不重启会不会翻：要登录，占一个设备名额，没做 |
| P3 | 通过 | 第二次启动：`APEX_SINGLE_THREAD_ACTIVE=1`、`APEX_HYPIHUB_ACTIVE=1`、`APEX_MULTI_BOT_ACTIVE=1`，引擎带 `APEX_MULTI_BOT_ACTIVE=1` |

## 3. 冷启动和内存（Mac，`report` 原样）

冷启动（秒）。「标记→就绪」含 computer use 的操作时间；C1 那一格（24.0）包括在新建面板里打字的时间：

| 助手 | 排队等槽 | 引擎就绪 | 就绪依据 | 前一个标记 | 标记→就绪 |
|---|---|---|---|---|---|
| default（主引擎，三次启动） |  | 2.3 / 2.5 / 2.4 | READY |  |  |
| apex-bot-2（新建） |  | 2.3 | READY | C1 点+ 新建剪辑助手 | 24.0 |
| apex-bot-4（新建） | 0.5 | 3.0 | READY |  |  |
| apex-bot-5（新建，第 4 个） | **31.4** | **33.6** | READY | E1 点重试 第4个 | 63.9 |
| apex-bot-2（重启后第一次点开） |  | 2.2 | READY | D1 点剪辑助手 | 2.7 |
| apex-bot-3 |  | 2.2 | READY | D1 点选题助手 | 2.7 |
| apex-bot-4 | 0.4 | 2.7 | READY | D1 点带货脚本 | 2.7 |
| apex-bot-5（剪辑助手满 4 分钟后再点） |  | 2.2 | READY | E1b 再点第4个 | 2.8 |

内存（MB；macOS 读不到别的进程的 USS）：主引擎就绪 30 秒后 RSS 325–351，连子进程峰值 363–435；池引擎 RSS 219–363，连子进程峰值 323–366。主 1 + 池 3 都在跑、外加两个 placebo 转码时，测试目录下全部进程 RSS 峰值 2359 MB。

## 4. 池满：预期和实际

| 场景 | 清单第 4 节的预期（按代码读） | 实际（0.17.66 Mac） |
|---|---|---|
| 4 分钟内点开第 4 个 | `makeRoomInPool` 挤掉最久没用的空闲引擎，不排队 | 等空槽 30 秒后「暂时打不开「X」，稍后再试。」；整个过程没有一条 `evict_room`；要等最久没用的那个满 4 分钟，后台补连走老路「Evicting idle profile backend … (LRU cap 3)」，它才起得来，用户还得再点一次 |
| 新建第 4 个后直接进对话 | 同上 | 同上：08:55:23Z 排队，08:55:53Z 超时，08:57:25Z 点「重试」又超时，08:57:58Z 才起来 |
| 只有池槽那么多个助手 | 不排队 | 第 3 个也出现「有空槽还排队」（`2/3 busy, 1 queued`），当场就拿到了槽，没有用户可见的等待 |
| 闲置 10 分钟 | 先问引擎再回收 | 符合：`(idle > 600s): committed` |

推断（没改代码验证）：
- 侧栏点击走 `openBot`，它在 `ensureGatewayProfile` 之前先 `pinNewChatProfile` + `requestFreshSession`。壳随即去查这个助手的主线，这一次不带 foreground 拨了那个 profile，成了 `backendDialClaims` 的认领方。
- 挤不挤谁按 background 定，只走 4 分钟保鲜的老路。随后的 foreground 拨号只给排队升级，不补跑 `makeRoomInPool`。
- 修复票 hc-1093（fork #509）已合进 main，随 0.17.67 发；在那之前 v6 把上限降到 APEX + 3。

## 5. 花费

`tokens`（各助手会话库，不含缓存读取的 token）：模型调用 50 次，输入 102,187、输出 12,339 token，按 Flash 标价约 $0.02。没有生图、没有生成视频。ChinaAPI 扣费回读由协调会话做（`paid-calls.md`）。批准额度：模型 ¥40、生图 3 张、不生成视频。

另：G3 第一次切回 APEX 没切过去，同一句改名又发给了小货一次，多花了 1 轮。之后每次发送前先确认输入框写的是谁。

## 6. 发现的问题

| # | 严重 | 问题 | 复现和证据 | 归属 |
|---|---|---|---|---|
| 1 | 严重 | 第 4 个助手打不开（等 30 秒后「暂时打不开」，要等最久没用的那个满 4 分钟） | 见第 4 节；复现 3 次；`e1-fourth-bot-cannot-open.jpg`；desktop.log 摘录在协调会话笔记 `hc-1083-pool-evidence-desktop-log.txt` | hc-1093（#509，随 0.17.67）；线上 v6 先降上限 |
| 2 | 中 | 切换卡住：点某个助手，侧栏有反应、对话不换，之后一直切不过去，别的助手正常 | ①约 09:12:40Z：在小货上（刚用一句话改过名），点 APEX（小橙）切不过去，后发的消息进了小货；重启后好了。②约 10:07Z：重启后在 APEX 上点剪辑助手切不过去；剪辑助手上一轮（F4 转码）被重启打断。打包版拿不到渲染端 console（`issue2-switch-stuck-apex.jpg`） | 协调会话开票 |
| 3 | 中 | 共用记忆不是实时的：A 助手记下的，已经开着的 B 助手答「底账是空的」 | B 的会话 09:07:38Z 开始，系统提示里「关于你」段是那时的；09:09:30Z A 写入后，B 问「我的账号叫什么？」，没调记忆工具，直接答空（`k2-shared-memory-not-live.jpg`） | 协调会话开票 |
| 4 | 中 | ⌘K 选「和 小题 的对话」：小题没切到前台，而是以只读「这是更早的对话，只能看」打开，还冒出写着「APEX 主线」/「+ NEW SESSION」的标签条，重启后还在 | `n2-*.jpg` | hc-1085（#508）应已收掉，0.17.67 上复验 |
| 5 | 中 | 设置页顶上的「应用于」行显示 profile 目录名 default / apex-bot-2…5，点别的 chip 能改到别的助手；剪辑助手上档位页写「改的是账户的」，chip 却选着 apex-bot-2 | `s-model-page-scope-chips-profile-dirs.jpg`、`s3-shared-tier-note.jpg` | 协调会话开票 |
| 6 | 低 | Mac 上有回合在跑时主窗口关不掉（⌘W、红点、File › Close 都没反应），清单 F4 做不了 | 10:01Z，剪辑助手转码中 | 协调会话开票 |
| 7 | 低 | 引擎用后台进程起的 ffmpeg 在 App 退出后变孤儿继续跑（ppid 1）；对话里也不会说那一轮被打断了 | 10:04:49Z 停 App 后 pid 41208 还在，命令只带相对路径，工作目录是测试目录 | 协调会话开票 |
| 8 | 低 | 「重新登录」进的登录界面（邮箱 + 密码、「用 Google 登录」、「用 APEX 登录」、「使用我自己的提供方」）和首启登录界面（「登录 APEX 账户」等三个按钮）不一样 | `relogin-screen.jpg`；Kael 10-28 问「登录界面怎么变了」 | 协调会话定要不要开票 |

## 7. 工具在实跑中暴露、已修的

| 问题 | 修法 | 守它的测试 |
|---|---|---|
| C2 把 hc-1081 的同步戳 `.apex-manifest` 当成多出来的技能文件 | 只记录 `stamp`，不比 | `test_skills_stamp_is_recorded_not_compared`、健康家目录全 PASS |
| C6 把「改名前建的会话提示还是旧名字」判成 FAIL | 判 WARN，以下一轮回复为准；新助手提示里没有名字仍是 FAIL | `test_rename_after_the_session_started_is_a_warning`（2 条）、`wrong-name` |
| `watch` 在进程退出时被 psutil 的 `SystemError` 打崩（09:33Z 那次） | 不让 `process_iter` 预取属性，逐个读并接住 | `test_watcher_survives_a_process_that_fails_mid_exit` |
| `stop` 认不出只带相对路径的孤儿进程 | 也按工作目录找；不算 watch 和脚本自己 | 本机用假孤儿演练过 |
| 旧版副本会自更新、丢隔离 | `prepare` 读 feed 最新版，旧了就拒；`isolation` 核对 | 本机用 0.17.65 演练过：被拒，副本删掉 |

## 8. 还没做的

- I 组（重新登录 key 轮换），H 组（删除），C8、C9，L3、N1，F1、F5，P2 登录后那一段，J1 的服务端版本对照。
- 前提：协调会话确认看门狗的办法。
- 设备名额：每个全新副本登录都占这个账号一个名额（上限 8，到上限新设备被拒 409，不会挤掉别的设备的 key；判断在 `desktop_provisioning.py`）。测完要在副本里退出登录还回名额：a65 副本（06:34 登录）还占着，要起来退出登录；a66 点过「重新登录」，停在登录页。
- 0.17.67 上复验：E1（「设置 › 高级」把池上限调成 2）、N2（⌘K 不该再有会话和标签栏入口）。
- Windows（高配 win-5090 和低配）整套。

## 9. 清理

- a65 副本：没有进程，已从 LaunchServices 注销；测试目录还在 scratchpad。
- a66 副本：已 `stop`，0 个进程（`isolation` PASS）；家目录留着，接着做 I、H 等组。
- 孤儿 ffmpeg 已清。
- Kael 的 `/Applications/APEX` 是他自己的（0.17.66），验收期间按他的同意退出过。
