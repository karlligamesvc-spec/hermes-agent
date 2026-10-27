# hc-1083 多助手第一期验收清单（M7）

状态：**准备好了，还没开始验收。** 等 M1–M6（hc-1077 到 hc-1082）合并、B 波那一版打出 Mac arm64 + Windows x64 安装包后，在打包产物上照本清单走一遍，结果写进同目录的 `qa-report.md`（验收时新建）。

本目录：

| 文件 | 做什么 |
|---|---|
| `README.md` | 本清单 |
| `paid-calls.md` | 验收要花钱的调用和预估；Kael 在 hc-1083 会话里亲口批了才跑 |
| `rollout-request-draft.md` | 验收后给 Kael 的「发一版客户端配置给所有人打开 multi_bot」申请草稿（只起草，不写库） |
| `multi_bot_qa.py` | 只读的测量和核对工具：快照、核对 C1–C7、冷启动、内存、池事件 |
| `fresh-env-mac.sh` | Mac 上起一份隔离的打包产物（全新空环境） |
| `fresh-env-win.ps1` | Windows 上同样的事 |

边界：多助手侧栏的 golden 和身份守卫（「APEX 永远第一行、紫色圆、不能删」）是 M1（hc-1077）的；这里只在打包产物上看它们真的成立，不另录 golden。

## 0. 开始前要齐的东西

- [ ] **版本**：B 波那一版的候选或正式安装包（`desktop-release.yml` 的 run，Mac arm64 DMG + Windows x64 exe）。记下 run id、版本号、引擎钉的 commit。对照版：0.17.65 的安装包（第 A 组用）。
- [ ] **M1–M6 都在这一版里**：bump 分支包含 hc-1077、hc-1078、hc-1079、hc-1080、hc-1081、hc-1082 的合并提交（PR 号验收时填）。
- [ ] **服务端客户端配置里 `multi_bot` 还是关的**：读 `GET /api/v1/desktop/client-config`，`desktop_features` 里没有 `multi_bot: true`。内测只靠本机 `APEXNODES_MULTI_BOT=1`（`--multi-bot` / `-MultiBot`）。
- [ ] **测试账号**：Flash 档（档位跟账户走，K3），额度够跑完 `paid-calls.md`。**登录由人来做**（密码不经 Claude 的手）；Claude 只点到登录页。
- [ ] **付费批准**：Kael 在 hc-1083 会话里亲口批了 `paid-calls.md` 的额度。没批之前只做标「免费」的步骤。
- [ ] **机器**：
  - Mac：本机 Mac Studio（arm64），computer use 驱动；`/Applications/APEX.app` 先退出（两个窗口都叫 APEX、bundle id 一样，computer use 分不清）。
  - Windows 高配：`win-5090`（Windows 11 专业版、Ryzen 9 9950X3D、128 GB）。界面操作经 ToDesk（Mac 上有 ToDesk.app，测试机上 ToDesk 在跑）或人在机器前；SSH 只用于准备、停止、只读核对。
  - **Windows 低配：还没有机器。** 方案要求在低配 Windows 上量冷启动和内存。待定：借一台 ≤16 GB 内存、4–6 核的机器，或在 win-5090 上开一台 8 GB / 4 核的 Hyper-V 虚拟机（要先开 Hyper-V，是系统改动，得机器主人同意）。

## 1. 全新环境（硬规则 11：不拿预置好的状态自证）

每个场景组都从**新的空目录**开始，除非下面写明要接着上一组的状态。

**Mac**（测试目录放在本会话 scratchpad 或 `~/apex-qa/`）：

```bash
Q=apps/desktop/docs/qa/hc-1083
$Q/fresh-env-mac.sh prepare ~/Downloads/APEX-x.y.z-mac-arm64.dmg ~/apex-qa/hc1083-mac-1
$Q/fresh-env-mac.sh launch ~/apex-qa/hc1083-mac-1 --multi-bot     # 等到「bundled-engine activated」
PY=$($Q/fresh-env-mac.sh python ~/apex-qa/hc1083-mac-1)          # 引擎自带 python（带 psutil、ruamel.yaml）
$Q/fresh-env-mac.sh stop ~/apex-qa/hc1083-mac-1                   # SIGTERM，应报「测试目录下 0 个进程」
$Q/fresh-env-mac.sh cleanup ~/apex-qa/hc1083-mac-1 --delete       # 从 LaunchServices 注销再删
```

- 直接起二进制，不用 `open`；`--use-mock-keychain`；HERMES_HOME、userData、工作目录都在测试目录里。
- 本机 `~/.local/bin/hermes` 是开发版 CLI。0.17.59 起打包版只用自带引擎（hc-924），首启日志应是 `[bundled-engine] activated …`，不是采用了 PATH 上的 hermes。
- 自动更新 60 秒后首查。B 波那一版就是最新版时不会更新；**对照版 0.17.65 会去下载新版并在退出时装上**，所以对照版每个目录只起一次，测完就删。

**Windows**（`C:\apex-qa\hc-1083\<run>`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 prepare -Root C:\apex-qa\hc-1083\win-1 -Installer C:\apex-qa\APEX-x.y.z-win-x64.exe
powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 scripts -Root C:\apex-qa\hc-1083\win-1 -MultiBot
# 把 multi_bot_qa.py 拷到 C:\apex-qa\hc-1083\win-1\，然后在测试机桌面上双击 launch-apex.cmd（不要用计划任务起）
powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 stop -Root C:\apex-qa\hc-1083\win-1
powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 cleanup -Root C:\apex-qa\hc-1083\win-1 -Delete
```

- 计划任务默认优先级 7 是低 I/O、低内存优先级，冷启动会慢 2 倍多（hc-923 实测），所以 App 只从桌面双击起。
- `watch` 要读进程环境变量来认出测试目录的进程。SSH 会话读不到时，在桌面上双击 `watch.cmd <场景>` 跑。

## 2. 测量和核对工具

都用引擎自带的 python 跑，加 `-I`。工具只读，不改文件、不发网络请求；密钥只输出 sha256 前 12 位。

| 命令 | 用途 |
|---|---|
| `$PY -I multi_bot_qa.py watch --home <家目录> --out runs/watch-<场景>.jsonl --uss` | 一直开着：盯 desktop.log 和本测试目录的进程，记冷启动、内存、池事件。Ctrl-C 停 |
| `$PY -I multi_bot_qa.py mark --out runs/watch-<场景>.jsonl "点剪辑助手"` | 点之前打一个时间点，报告里出「标记→就绪」 |
| `$PY -I multi_bot_qa.py report runs/watch-<场景>.jsonl` | 出冷启动、内存、池事件三张表（Markdown，直接贴进 QA 记录） |
| `$PY -I multi_bot_qa.py snapshot --home <家目录> --live --out runs/snap-<步骤>.json` | 快照：每个助手的 key 指纹、插件表、平台技能、SOUL、主线会话、在跑引擎的开关环境变量 |
| `$PY -I multi_bot_qa.py check --home <家目录>` | 跑 C1–C7，有 FAIL 退出码 1 |
| `$PY -I multi_bot_qa.py diff runs/snap-a.json runs/snap-b.json` | 两份快照差在哪（改名、删除、重新登录前后） |
| `$PY -I multi_bot_qa.py tokens --home <家目录> --since <开始时间>` | 各助手会话库里的 token 合计，按标价折美元（算实际花费） |
| `$PY -I multi_bot_qa.py fixture --home <家目录> --out <文件>.mp4 --minutes 20 --calibrate slow` | 用自带 ffmpeg 生成后台剪片用的测试视频，并估这台机器转码要多久 |

核对项（`check`）：

| 编号 | 查什么 | 失败说明什么 |
|---|---|---|
| C1 | 每个用托管中转的家目录里，所有指向中转地址的 `api_key` 都和根目录一样；产品模式建的助手必须走托管中转 | M4 没把 key 同步到这个助手，它会 401 |
| C2 | 各助手 `skills/apexnodes/` 下的文件和根目录逐个哈希一致 | M5 没把平台技能装到这个助手 |
| C3 | 各助手的 `plugins.enabled` 包含根目录的全部插件 | 这个助手缺 apex-overlay 或生成工具 |
| C4 | APEX 和产品模式建的助手没有标题为「Bot Chat」的会话 | 走成了上游 Bot 模式的对话（K5） |
| C5 | 产品模式建的助手的 profile.yaml 不带 `ui_meta.hermes-bots` | 引擎会把它当上游 Bot 模式管理的 profile |
| C6 | 每个「APEX 主线」最新一段的系统提示：有「Conversation started:」日期行、没有「## Messaging other agents」、有这个助手的名字 | 日期丢了、混进互发协议、或新助手还说自己叫 APEX（M6） |
| C7 | 助手（有 SOUL.md 的 profile）不超过 4 个 | 上限没守住（K2） |

这些核对是自己读文件判断的，没有复用产品的写入逻辑（硬规则 12「验证器不要复用被验证者的逻辑」）。工具本身的反向验证见 `tests/scripts/test_multi_bot_qa.py` 和 PR 描述：18 处注入全部变红。

## 3. 验收步骤

「付费」一栏：— 不调模型；**F** 要发消息（Flash）；**G** 要生成。每一步都留证据：截图放 `screenshots/`，`runs/` 里的 watch 记录和快照随 QA 记录提交（不含密钥）。Mac 和 Windows 各走一遍；低配 Windows 只走 D、E、F 三组的测量部分。

### A. 开关关时和 0.17.65 一样

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| A1 | 两个新目录：一个装 0.17.65，一个装 B 波版本，都**不加** `--multi-bot`。同一账号登录，走完首启，各发同一句「你好，今天几号？」 | 两边侧栏都只有一行 APEX，没有「+」；头部、输入框、账户菜单、「在微信里找 APEX」、今日点子都一样（截图并排）；除了版本号和已知改动（列出来）外没有差别 | F |
| A2 | 两边各 `snapshot --live` 再 `diff` | B 波那边没有 `profiles/` 目录；在跑的引擎只有主引擎（加 IM 网关），环境变量里没有 `APEX_MULTI_BOT_ACTIVE`；根 config.yaml 的键一样（值指纹因账号 key 不同可以不同） | — |
| A3 | B 波那边打开开发者模式 | 上游 Bot 模式的界面和以前一样，多助手侧栏不出现 | — |

### B. 老用户升级

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| B1 | 新目录先用 0.17.65 登录、在 APEX 主线聊一句。退出，换成 B 波版本的 App、**同一个家目录**，加 `--multi-bot` 启动 | 侧栏第一行是 APEX，点开就是原来那条主线和历史；没有凭空多出助手；`check` 全 PASS 或只有 WARN | F |
| B2 | 不加 `--multi-bot` 再启动一次 | 回到一行 APEX 的样子，主线还在 | — |

### C. 建满 4 个和上限（K2、K4、K6）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| C1 | 全新目录 `--multi-bot`，登录。`watch` 开着。点「+」，起名「剪辑助手」，选形状和颜色，建好 | 预览实时变化；APEX 的紫色不在可选色里；建好直接进它的对话；首启三问出现（做什么 / 风格 / 平台，第三问第一项「跟 APEX 一样」） | — |
| C2 | 三问点选作答，再发「你叫什么？主要帮我做什么？今天几号？」 | 回答用新名字和刚选的分工，日期对；「✓ 剪辑助手 记下了 · 撤销」出现；`profiles/<目录>/SOUL.md` 有「分工」一段；共用底账镜像 `apex/memory-ledger-prompt.md` 没变（`snapshot` 前后 `diff`） | F |
| C3 | 点「撤销」 | SOUL 回到上一份（快照里 SOUL 哈希变回去） | — |
| C4 | 依次再建 3 个（名字含中文、一个带 emoji、一个很长的名字） | 侧栏顺序：APEX 第一，其余按创建先后；名字过长有省略；每个都能进对话 | — |
| C5 | 再点「+」 | 说清楚已到上限（APEX + 4），不让建第 5 个；`check` 的 C7 PASS | — |
| C6 | 选中 APEX 行的「···」 | 没有「删除」、没有「换样子」，有「改名」；APEX 仍是紫色圆 | — |
| C7 | `check` | C1–C7 全 PASS（C6 要求每个助手都聊过一句，见 D2） | — |

注意：**C1 到 C4 连着建 4 个，正好会撞上第 E 组预判的「排队 30 秒」**（建好直接进对话 = 立刻起它的引擎）。照实记下发生了什么，不要为了让它过而放慢节奏。

### D. 切换和冷启动

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| D1 | 重启 App（引擎都是冷的），`watch` 开着。每点一个助手前 `mark "点<名字>"`，点完截屏直到输入框占位变成「给 <名字> 发消息」 | 记每个助手第一次点开的：排队等槽、引擎就绪秒数（`report` 第一张表）、点击到能输入（截屏粗测，±2 秒） | — |
| D2 | 在每个助手里各发一句 | 每个都正常回复；`check` C6 PASS（名字、日期行） | F |
| D3 | 在引擎还在的两个助手之间来回切 5 次 | 热切换不再起新引擎（`report` 里没有新的 proc_new）；界面切换不卡（记体感和截屏时间） | — |
| D4 | 引擎被回收后再点开（见 E3） | 记第二次冷启动秒数 | — |

### E. 池满（主 1 + 池 3）

先读第 4 节的预判，验收就是证实或推翻它。

| # | 怎么做 | 通过标准 / 要记的 | 付费 |
|---|---|---|---|
| E1 | 4 分钟内依次点开助手 1、2、3、4（都是冷的） | 记第 4 个：有没有「waiting for a free local slot」、等了多久、有没有「timed out while waiting for a free slot」、用户看到什么（截图）、点重试后怎样。**期望（产品要求）**：第 4 个能用，最多等几秒，被挤掉的是最久没用的那个 | — |
| E2 | 4 个助手都开过后，等 4 分钟以上不碰助手 1，再点助手 4 | 应挤掉最久没用的助手（日志 `Evicting idle profile backend`），第 4 个起得来 | — |
| E3 | 所有助手都不碰，等 10 分钟以上 | 闲置的池引擎被回收（`Reaping idle profile backend`），主引擎不受影响；再点开它们是冷启动（D4） | — |
| E4 | 被挤掉 / 回收过的助手点回去，发一句 | 对话历史还在，能正常回复 | F |
| E5 | 每个引擎的内存：`report` 第二张表（就绪 30 秒后 RSS、Windows 上还有 USS）；主 1 + 池 3 都在跑时，测试目录下全部进程 RSS 峰值 | 记数字；Mac 和 Windows 分开记；低配机上看会不会开始换页 | — |

### F. 后台剪片时切走再切回

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| F0 | `fixture --minutes 3` 和 `fixture --minutes 20 --calibrate slow` 生成两个测试视频，放进测试目录的 `home/cwd/` | `--calibrate` 打印这台机器转码 20 分钟片子大约要多久，用来挑 F2 的参数（目标：任务跑 12 分钟以上） | — |
| F1 | 在「剪辑助手」里：「把 qa-3min.mp4 剪成 3 段，每段加一句标题字幕」。开始后立刻切到 APEX，聊一句，等 2 分钟切回 | 侧栏剪辑助手的副标题显示进度；切回时结果在、文件能播放 | F |
| F2 | 在「剪辑助手」里：「用 ffmpeg 把 qa-20min.mp4 转成 1080p H.264（preset slow，crf 18），转完告诉我文件大小」。开始后切到 APEX，**不碰剪辑助手 12 分钟以上**，期间可以点开别的助手 | 剪辑助手的引擎没被回收也没被挤掉（`report` 池事件里没有它的 evict / reap，引擎进程没退出）；任务做完，输出文件时长和原片一致；切回能看到完整回复 | F |
| F3 | F2 进行中把助手 2、3、4 都点开（池满） | 正在跑任务的剪辑助手不能被挤掉；记被挤掉的是谁、第 4 个是否排队 | — |
| F4 | 再开一个 F2 那样的长任务，开始后关掉窗口（Mac 上 ⌘W，App 不退出；Windows 上最小化到托盘或关窗，看 App 怎么处理），12 分钟后再打开 | 没有渲染端 ping 时，回收器先问引擎有没有回合在跑（hc-1080 #500 的退役栅栏），有就不回收：`report` 里没有剪辑助手的 reap，任务做完 | F |

代码依据：渲染端对「有在跑或在等你决定的回合」的助手保留后台连接，每 60 秒 ping 一次，所以窗口开着时它应该不会被闲置回收、也不在可挤掉的名单里（见第 4 节）。窗口关着或渲染端重载时 ping 会停，hc-1080（M4，fork #500）给闲置回收补了「先问引擎有没有回合在跑」；F4 在打包产物上验这一条。

### G. 改名和换样子（K6、M6）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| G1 | `snapshot` → 剪辑助手「···」→ 改名「小剪」→ `snapshot` → `diff` | 侧栏、头部胶囊、「给 小剪 发消息」、「小剪 记下了」都跟着变；`diff` 只动 `homes.<剪辑助手目录>.meta`（profile.yaml 的 `ui_meta.apex`），目录名不变，共用镜像 `shared` 不变 | — |
| G2 | 在选题助手里说「以后叫你小题」，然后 `snapshot` | 侧栏变成「小题」；`ui_meta.apex.name` 变了；共用底账镜像不变（名字不进底账）；再问「你叫什么」答「小题」 | F |
| G3 | 去 APEX 和别的助手问「你叫什么」 | APEX 还叫 APEX，别的助手名字不串 | F |
| G4 | 给 APEX 改名「小橙」（界面） | 能改；仍是紫色圆、第一行；重启后保持 | — |
| G5 | 给别的助手换形状和颜色 | 立即生效、重启后保持；颜色在深色侧栏上也看得清 | — |

### H. 删除（K9）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| H1 | `snapshot` → 删「小题」 → `snapshot` → `diff` | 确认框写清楚删什么（它的对话、文件、技能副本）、不删什么（共用的「关于你」、作品、用量）；删后 `profiles/<目录>` 没了、它的引擎进程没了；根目录和别的助手、`shared` 不变 | — |
| H2 | 删一个引擎正在跑的助手（Windows 上一定要做：文件被占用时删目录是老问题） | 先停引擎再删，不报错、不留半个目录；Windows 上没有「文件正被使用」 | — |
| H3 | 用同一个名字再建一个 | 是全新的助手，没有旧对话 | — |

### I. 重新登录后 key 轮换不 401（M4）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| I1 | 4 个助手的引擎都开着时 `snapshot`，然后退出登录、再登录（人来登录） | 重新登录会重新签发中转 key：根目录 key 指纹变了 | — |
| I2 | `snapshot` + `check` | C1 PASS：所有助手的 key 指纹都等于新的根指纹；`watch` 里看到每个助手 config 的 key 刷新行 | — |
| I3 | 在 APEX 和 4 个助手里各发一句 | 都正常回复；`report` 的 401 行数为 0；池里已经在跑的引擎也换了新 key（必要时被重启过，记下来） | F |

### J. 平台技能版本一致（M5）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| J1 | 建满后 `check` | C2 PASS；`snapshot` 里各助手 `platform_skills.versions` 一样，并且和服务端当前技能版本一致（版本号对照 apex-nodes `app/skills/apexnodes/*/SKILL.md`） | — |
| J2 | 新建一个助手后马上 `check` | 新助手立刻有全套平台技能（不用等下次同步） | — |

### K. 共用记忆（K1）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| K1 | 在助手 2 里说「记住：我的账号叫小橙子测评，主做美妆」 | 「它记得什么」里出现；共用底账镜像变了 | F |
| K2 | 去助手 3 问「我的账号叫什么？」 | 答得出来 | F |

### L. 重启、退出和清理

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| L1 | 退出再启动 | 侧栏顺序、名字、样子、未读点都保持；APEX 仍第一行 | — |
| L2 | `stop` | 测试目录下 0 个进程（池引擎和 IM 网关都退了，hc-1031） | — |
| L3 | 生成一张图（新建的助手里：「给我做一张美妆测评封面」） | 生成工具在新助手里能用（插件和平台工具凭据都到了池引擎） | F + G |

### M. 只在 Windows 上看

- 删除时的文件占用（H2）。
- 冷启动有没有被安全软件拖慢：win-5090 开着 Defender 和 AliPaladin 文件过滤（hc-923），记下来，不改它们的设置。
- 未签名安装包的提示照实截图（硬规则 15：Windows 安装包仍未签名）。

## 4. 量什么、预判什么

**冷启动**：

- 引擎就绪：从「排队等槽」或「Starting Hermes backend for profile "X"」那一行，到引擎打出 `HERMES_BACKEND_READY`。READY 那行有时进不了 desktop.log（Desktop 在认领子进程之后才开始记它的输出），工具就改用「引擎开始监听端口」的时间，报告里「就绪依据」写 listen。
- 点击到能输入：点之前 `mark`，点完截屏到输入框占位变成「给 X 发消息」。computer use 的截屏间隔大，误差约 ±2 秒，只作参考。
- 每个助手记三种：第一次点开（冷）、被回收后再点开（冷）、引擎还在时切回（热）。
- 2026-10-27（UTC）用本机装的 0.17.62 打包产物试跑过整套工具（全新目录、没登录、没付费调用）：首启 20 秒激活自带引擎；主引擎从「Starting」到 READY 3.7 秒；主引擎就绪 30 秒后 RSS 290 MB，连子进程峰值 328 MB；测试目录下全部进程 RSS 峰值 1142 MB；`stop` 后 0 个进程。macOS 不让读别的进程的 USS（AccessDenied，要 root），Mac 上 USS 一栏是空的，Windows 上有。

**内存**：每个引擎进程就绪 30 秒后的 RSS（Windows 加 USS）、连子进程的峰值（剪片时 ffmpeg 算在它的引擎头上）、测试目录下全部进程的 RSS 峰值。

**池满会怎样（读 fork main `50a50d1b` 的代码得出的预判，验收证实或推翻）**：

- 池上限 3 个（不含主引擎，`electron/pool-limits.ts`），产品模式里没有设置入口。APEX + 4 个助手时，4 个助手的引擎不可能同时在。
- 要给一个助手起引擎时，先挤掉「4 分钟内没被 ping 过」的里面最久没用的那个（`POOL_KEEPALIVE_FRESH_MS`，`electron/main.ts` 的 `evictLruPoolBackends`）。都在 4 分钟内用过时**一个也不挤**，新引擎等空槽最多 30 秒（`POOL_SLOT_WAIT_MS`），等不到就报「Local backend start for "X" timed out while waiting for a free slot.」
- 渲染端每 60 秒 ping 当前助手和「有在跑或在等你决定的回合」的助手（`use-gateway-boot.ts`、`store/gateway.ts`），窗口开着时这些都不会被挤、也不会被 10 分钟闲置回收；窗口关着时靠 hc-1080 #500 的「回收前先问引擎」兜住闲置回收（挤掉那条路 #500 没改）。
- 所以预判：**4 分钟内连着点开（或连着新建）4 个助手，第 4 个会排队 30 秒后失败；有后台任务在跑的助手占着槽，会让这更容易发生。** 这是 M1 / M4 的设计点（比如多助手开着时把池上限跟助手上限对齐，或允许挤掉没在干活的助手），验收只负责证实，结论回给协调会话。

## 5. QA 记录怎么写

验收时新建 `qa-report.md`，照以前的 QA 记录（如 `../hc-1015/qa-report.md`）：

1. 版本、run id、引擎钉、两台（三台）机器配置、测试账号档位、开始和结束时间。
2. 第 3 节每一步：通过 / 不通过 / 没做（写原因），证据文件名。
3. 冷启动和内存表：`report` 输出原样贴，每台机器一份。
4. 池满的实际行为和第 4 节预判的对照。
5. 实际花费：每台机器 `tokens --since <开始时间>` 的结果，加上协调会话从 ChinaAPI 调用日志读回的金额，对照 `paid-calls.md` 的预估。
6. 发现的问题：每条写复现步骤、影响、建议归哪张票（M1–M6 或新票，新票号找协调会话）。
7. 清理：每个测试目录 `stop` 报 0 个进程、`cleanup` 做过；Windows 上卸载项已清。

## 6. 放量

验收通过、内测机器上 `APEXNODES_MULTI_BOT=1` 跑满一周后，按 `rollout-request-draft.md` 起草申请给 Kael。只起草，不写库；客户端配置由协调会话在 Kael 批准后写。
