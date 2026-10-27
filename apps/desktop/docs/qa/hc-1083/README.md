# hc-1083 多助手第一期验收清单（M7）

状态：**准备好了，还没开始验收。** M1–M6（hc-1077 到 hc-1082）都已合进 fork main（`aa8e554e`）。等 Desktop 0.17.66 出 Mac arm64 + Windows x64 安装包（候选包或正式包都行，位置由协调会话给），在打包产物上照本清单走一遍。结果写进同目录的 `qa-report.md`，验收时新建。

本清单按 fork main `aa8e554e` 的代码写（2026-10-27 核对）。

本目录：

| 文件 | 做什么 |
|---|---|
| `README.md` | 本清单 |
| `paid-calls.md` | 验收要花钱的调用和预估；Kael 已在 hc-1083 会话里亲口批了额度 |
| `rollout-request-draft.md` | 验收后给 Kael 的「发一版客户端配置给所有人打开 multi_bot」申请草稿（只起草，不写库） |
| `multi_bot_qa.py` | 只读的测量和核对工具：快照、核对 C1–C9、冷启动、内存、池事件 |
| `fresh-env-mac.sh` | Mac 上起一份隔离的打包产物（全新空环境） |
| `fresh-env-win.ps1` | Windows 上同样的事 |

边界：多助手侧栏的 golden 和身份守卫（「APEX 永远第一行、紫色圆、不能删」）归 M1（hc-1077）。这里只在打包产物上看它们真的成立，不另录 golden。

## 0. 开始前要齐的东西

- [ ] **版本**：0.17.66 的候选或正式安装包，来自 `desktop-release.yml` 的 run，含 Mac arm64 DMG 和 Windows x64 exe。记下 run id、版本号、引擎钉的 commit。对照版用 0.17.65 的安装包（第 A、B 组）。
- [ ] **M1–M6 都在这一版里**：bump 分支要包含 fork main `aa8e554e`（`git merge-base --is-ancestor aa8e554e <bump 提交>`）。合并都由 Kael 批准：

  | 波次 | PR | 票 | 合并提交 |
  |---|---|---|---|
  | A | #500 | hc-1080 配置到每个 profile、池引擎 | `c376c8ac` |
  | A | #502 | hc-1081 平台技能到每个 profile | `09e0d63c` |
  | A | #503 | hc-1082 引擎里的名字和改名工具 | `42eb62d8` |
  | B | #504 | hc-1077 侧栏、切换、开关 | `df44d848` |
  | B | #505 | hc-1078 新建、改名、换样子、删除 | `3da0deca` |
  | B | #506 | hc-1079 新助手首启三问 | `aa8e554e` |
  | — | #507 | hc-1084（只改测试） | `75bd53df` |

- [ ] **服务端客户端配置**：读 `GET /api/v1/desktop/client-config`，确认 `desktop_features` 里没有 `multi_bot: true`；当前是 v4，其中 `single_thread: true`。
  - 多助手只在单线也开时才算开（`electron/apex-multi-bot.ts`）。所以内测要在本机开两个开关：`APEXNODES_MULTI_BOT=1` 和 `APEXNODES_SINGLE_THREAD=1`。脚本的 `--multi-bot` / `-MultiBot` 会把两个一起开上。
  - 第 A、B 组用 `--single-thread` / `-SingleThread`：只开单线，和线上配置一致，又不用等首启拉到配置。
- [ ] **测试账号**：Flash 档（档位跟账户走，K3），额度够跑完 `paid-calls.md`。**登录由人来做**，密码不经 Claude 的手；Claude 只点到登录页。
- [ ] **付费**：已批（2026-10-27，Kael 在 hc-1083 会话里亲口批）。范围是 Flash 测试账号，模型调用最多 ¥40，生图最多 3 张，不生成视频。只在这个范围内花；眼看要超就停下来问。
- [ ] **机器**：
  - Mac：本机 Mac Studio（arm64），用 computer use 驱动。先退出 `/Applications/APEX.app`：两个窗口都叫 APEX、bundle id 一样，computer use 分不清。
  - Windows 高配：`win-5090`（Windows 11 专业版、Ryzen 9 9950X3D、128 GB）。
    - 界面操作经 ToDesk（Mac 上有 ToDesk.app，测试机上 ToDesk 在跑），或人在机器前。
    - SSH 只用于准备、停止和只读核对。
    - 2026-10-27 在这台机器的 PowerShell 5.1 上检查过 `fresh-env-win.ps1`：0 个解析错误，三种开关写出的 `launch-apex.cmd` 都对。
  - **Windows 低配：还没有机器。** 方案要求在低配 Windows 上量冷启动和内存，两个选项都要先得到机器主人同意：
    - 借一台 ≤16 GB 内存、4–6 核的机器；
    - 或在 win-5090 上开一台 8 GB / 4 核的 Hyper-V 虚拟机（要先开 Hyper-V，这是系统改动）。

## 1. 全新环境（硬规则 11：不拿预置好的状态自证）

每个场景组都从**新的空目录**开始，除非下面写明要接着上一组的状态。

**Mac**（测试目录放在本会话 scratchpad 或 `~/apex-qa/`）：

```bash
Q=apps/desktop/docs/qa/hc-1083
$Q/fresh-env-mac.sh prepare ~/Downloads/APEX-0.17.66-mac-arm64.dmg ~/apex-qa/hc1083-mac-1
$Q/fresh-env-mac.sh launch ~/apex-qa/hc1083-mac-1 --multi-bot     # 单线和多助手都开；等到「bundled-engine activated」；验退出提示加 --quit-confirm
PY=$($Q/fresh-env-mac.sh python ~/apex-qa/hc1083-mac-1)          # 引擎自带 python（带 psutil、ruamel.yaml）
$Q/fresh-env-mac.sh stop ~/apex-qa/hc1083-mac-1                   # SIGTERM，应报「测试目录下 0 个进程」
$Q/fresh-env-mac.sh cleanup ~/apex-qa/hc1083-mac-1 --delete       # 从 LaunchServices 注销再删
```

- `launch` 的开关：`--multi-bot` 同时设 `APEXNODES_MULTI_BOT=1` 和 `APEXNODES_SINGLE_THREAD=1`；`--single-thread` 只设后者；都不加时由平台配置决定。每次启动的开关记在测试目录的 `launches.log`。
- 直接起二进制，不用 `open`；带 `--use-mock-keychain`；HERMES_HOME、userData、工作目录都在测试目录里。
- 本机 `~/.local/bin/hermes` 是开发版 CLI。0.17.59 起打包版只用自带引擎（hc-924），首启日志应是 `[bundled-engine] activated …`，不应是采用了 PATH 上的 hermes。
- 自动更新在启动 60 秒后第一次检查。0.17.66 若就是最新版，不会更新。**对照版 0.17.65 会下载新版、退出时装上**，所以对照版每个目录只起一次，测完就删。

**Windows**（`C:\apex-qa\hc-1083\<run>`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 prepare -Root C:\apex-qa\hc-1083\win-1 -Installer C:\apex-qa\APEX-0.17.66-win-x64.exe
powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 scripts -Root C:\apex-qa\hc-1083\win-1 -MultiBot   # 第 A、B 组用 -SingleThread
# 把 multi_bot_qa.py 拷到 C:\apex-qa\hc-1083\win-1\，然后在测试机桌面上双击 launch-apex.cmd（不要用计划任务起）
powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 stop -Root C:\apex-qa\hc-1083\win-1
powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 cleanup -Root C:\apex-qa\hc-1083\win-1 -Delete
```

- 计划任务默认优先级 7，即低 I/O、低内存优先级，冷启动会慢 2 倍多（hc-923 实测）。所以 App 只从桌面双击起。
- `watch` 要读进程的环境变量才能认出测试目录的进程。SSH 会话读不到时，在桌面上双击 `watch.cmd <场景>` 跑。

## 2. 测量和核对工具

都用引擎自带的 python 跑，并加 `-I`。工具只读：不改文件、不发网络请求；密钥只输出 sha256 前 12 位。

| 命令 | 用途 |
|---|---|
| `$PY -I multi_bot_qa.py watch --home <家目录> --out runs/watch-<场景>.jsonl --uss` | 一直开着：盯 desktop.log 和本测试目录的进程，记冷启动、内存和池事件。Ctrl-C 停 |
| `$PY -I multi_bot_qa.py mark --out runs/watch-<场景>.jsonl "点剪辑助手"` | 点之前打一个时间点，报告里会出「标记→就绪」 |
| `$PY -I multi_bot_qa.py report runs/watch-<场景>.jsonl` | 出冷启动、内存、池事件三张表（Markdown，直接贴进 QA 记录） |
| `$PY -I multi_bot_qa.py snapshot --home <家目录> --live --out runs/snap-<步骤>.json` | 快照，见下面的清单 |
| `$PY -I multi_bot_qa.py check --home <家目录>` | 跑 C1–C9，有 FAIL 时退出码 1 |
| `$PY -I multi_bot_qa.py diff runs/snap-a.json runs/snap-b.json` | 两份快照差在哪（改名、删除、改设置、重新登录前后） |
| `$PY -I multi_bot_qa.py tokens --home <家目录> --since <开始时间>` | 各助手会话库里的 token 合计，按标价折美元（算实际花费） |
| `$PY -I multi_bot_qa.py fixture --home <家目录> --out <文件>.mp4 --minutes 20 --calibrate slow` | 用自带 ffmpeg 生成后台剪片用的测试视频，并估这台机器转码要多久 |

快照里每个助手记这些：

- key 指纹；
- config.yaml 每个顶层段的指纹，设置页改了谁的哪一段，`diff` 一眼看出来；
- 插件表、平台技能；
- SOUL（含第一行和各级标题）；
- 产品标记 `origin` 和首启三问的状态（`intake_status`）；
- 主线会话和它最后一条消息；
- 模型要调的和真跑了的工具，按名字计数；
- 在跑引擎的开关环境变量。

核对项（`check`）：

| 编号 | 查什么 | 失败说明什么 |
|---|---|---|
| C1 | 每个用托管中转的家目录里，所有指向中转地址的 `api_key` 都和根目录一样；产品模式建的助手必须走托管中转 | M4 没把 key 同步到这个助手，它会 401 |
| C2 | 各助手 `skills/apexnodes/` 下的文件和根目录逐个哈希一致 | M5 没把平台技能装到这个助手 |
| C3 | 各助手的 `plugins.enabled` 包含根目录的全部插件 | 这个助手缺 apex-overlay 或生成工具 |
| C4 | APEX 和产品模式建的助手没有标题为「Bot Chat」的会话 | 走成了上游 Bot 模式的对话（K5） |
| C5 | 产品模式建的助手的 profile.yaml 不带 `ui_meta.hermes-bots` | 引擎会把它当上游 Bot 模式管理的 profile |
| C6 | 每个「APEX 主线」最新一段的系统提示：有「Conversation started:」日期行、没有「## Messaging other agents」、有这个助手的名字 | 日期丢了、混进互发协议，或新助手还说自己叫 APEX（M6） |
| C7 | 助手（有 SOUL.md 的 profile）不超过 4 个 | 上限没守住（K2） |
| C8 | 新助手 SOUL.md 第一行是模板形状（`You are <名字>, an AI assistant from ApexNodes HK, …`）时，里面的名字等于 `ui_meta.apex.name` | 改名没带到 SOUL（hc-1082 的 `apex_rename` 或 hc-1078 的改名入口漏了一处） |
| C9 | 侧栏里的每个助手（有 SOUL.md、不是上游 Bot 模式的）都带 `ui_meta.apex.origin: product` | hc-1078 新建时没写产品标记。M4 只给带这个标记的助手同步配置、让它跟 APEX 的档位走，没有标记的会掉队 |

「产品模式建的助手」按合并后的约定认：`ui_meta.apex.origin` 恰好是 `product`（fork `shared/apex-product-assistant.ts`）。不看 `ui_meta.apex` 在不在，因为 hc-1082 的改名工具会给任何 profile 写名字。

这些核对是工具自己读文件判断的，没有复用产品的写入逻辑（硬规则 12：验证器不要复用被验证者的逻辑）。工具本身的反向验证见 `tests/scripts/test_multi_bot_qa.py` 和 PR 描述。

## 3. 验收步骤

「付费」一栏：— 不调模型；**F** 要发消息（Flash）；**G** 要生成。

每一步都留证据：截图放 `screenshots/`；`runs/` 里的 watch 记录和快照随 QA 记录提交（不含密钥）。

Mac 和 Windows 各走一遍。低配 Windows 只走 D、E、F 三组的测量部分（E2 除外）。

### A. 开关关时和 0.17.65 一样

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| A1 | 两个新目录：一个装 0.17.65，一个装 0.17.66，都用 `--single-thread`（**不加** `--multi-bot`）。同一账号登录，走完首启，各发同一句「你好，今天几号？」 | 两边侧栏都只有一行 APEX，没有「+」；头部、输入框、账户菜单、「在微信里找 APEX」、今日点子、设置页标题「设置」都一样（截图并排）；除了版本号和已知改动（列出来）外没有差别 | F |
| A2 | 两边各 `snapshot --live` 再 `diff` | 0.17.66 那边：没有 `profiles/` 目录；在跑的引擎只有主引擎（加 IM 网关）；环境变量有 `APEX_SINGLE_THREAD_ACTIVE=1`、没有 `APEX_MULTI_BOT_ACTIVE`；根 config.yaml 的键和 0.17.65 一样（值的指纹因账号 key 不同可以不同） | — |
| A3 | 0.17.66 那边打开开发者模式 | 上游 Bot 模式的界面和以前一样，多助手侧栏不出现 | — |

### B. 老用户升级

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| B1 | 新目录先用 0.17.65（`--single-thread`）登录，在 APEX 主线聊一句。退出，换成 0.17.66、**同一个家目录**，加 `--multi-bot` 启动 | 侧栏第一行是 APEX，点开就是原来那条主线和历史；没有凭空多出助手；`check` 全 PASS 或只有 WARN | F |
| B2 | 只加 `--single-thread` 再启动一次 | 回到一行 APEX 的样子，主线还在 | — |

### C. 建满 4 个和上限（K2、K4、K6）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| C1 | 全新目录 `--multi-bot`，登录，`watch` 开着。点「+」，在「新建一个助手」里起名「剪辑助手」，选形状和颜色，点「建好了」 | 「侧栏里会是这个样子」的预览实时变化；6 种形状、6 种颜色（蓝 / 青 / 绿 / 橙 / 玫红 / 金），没有紫色，并写着「紫色圆是 APEX 的，留给它。」；建好直接进它的对话。对话里先问候「你好，我是剪辑助手。你的账号情况 APEX 已经告诉我了，不用再说一遍。」，然后出三问卡片（1 / 3「我主要帮你做什么？」、「我说话什么风格？」、「主要给哪个平台做？」，第三问第一项是「跟 APEX 一样：…」）；侧栏这一行的副标题是「先问 3 个小问题」 | — |
| C2 | 三问点选作答（剪辑出片 / 简短直接 / 跟 APEX 一样），先 `snapshot`，再发「你叫什么？主要帮我做什么？今天几号？」，再 `snapshot`、`diff` | 出现「剪辑助手 记下了：管剪辑出片 · …」和「撤销」；侧栏副标题变成「分工定了：剪辑出片」；快照里 `intake_status` 是 noted，SOUL 标题里有「## 分工」；回答用新名字和刚定的分工，日期对；共用底账镜像 `apex/memory-ledger-prompt.md` 没变（`diff` 里 `shared` 不变，K1：分工只进它自己的 SOUL） | F |
| C3 | 点「撤销」 | 显示「已撤销，这三条不记」；侧栏副标题「分工没记，随时再说」；快照里 `intake_status` 是 undone，SOUL 里没有「## 分工」 | — |
| C4 | 依次再建 3 个：名字含中文的、带 emoji 的、正好 12 个字的。中间试两次不该成的：13 个字，和一个重名 | 13 个字提示「最多 12 个字」，重名提示「已经有助手叫这个名字了」，都建不成；面板写着「你已经建了 N 个，还能再建 M 个」；侧栏顺序 APEX 第一，其余按创建先后，长名字有省略；每个都能进对话 | — |
| C5 | 再点「+」 | 「+」的无障碍名是「已经有 5 个助手了，先删掉一个再建」（APEX 算在内，`multi_bot_max` 默认 5）；面板照样打开，底下写「已经有 4 个了，先删掉一个再建」，建不了；`check` 的 C7 PASS | — |
| C6 | 选中 APEX 那一行，点「···」 | 只有「改名」，没有「改名或换样子」和「删除这个助手」；APEX 仍是紫色圆 | — |
| C7 | `check` | C1–C9 全 PASS（C6 要每个助手都聊过一句，见 D2） | — |
| C8 | 打开开发者模式，再切回来 | 开发者模式里多助手侧栏不出现，界面和 A3 一样；切回后 4 个助手和它们的对话都还在 | — |

C1 到 C4 连着建 4 个，正好会撞上第 4 节说的「池满挤掉」：建好直接进对话，就是立刻起它的引擎。照第 4 节的预期记下发生了什么，不要为了让它过而放慢节奏。

### D. 切换和冷启动

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| D1 | 重启 App（引擎都是冷的），`watch` 开着。每点一个助手前 `mark "点<名字>"`，点完截屏，直到输入框占位变成「给 <名字> 发消息」 | 记每个助手第一次点开时：有没有排队等槽、引擎就绪秒数（`report` 第一张表）、点击到能输入的时间（截屏粗测，±2 秒）。冷启动时对话区的「正在唤醒 …」写的是助手名字，不是 profile 目录名 | — |
| D2 | 在每个助手里各发一句 | 每个都正常回复；`check` 的 C6 PASS（名字、日期行） | F |
| D3 | 在引擎还在的两个助手之间来回切 5 次 | 热切换不起新引擎（`report` 里没有新的 proc_new）；界面切换不卡（记体感和截屏时间） | — |
| D4 | 引擎被挤掉或回收后再点开（见 E1、E3） | 记第二次冷启动秒数 | — |

### E. 池满（主引擎 1 个 + 池 3 个）

先读第 4 节的预期，验收就是证实或推翻它。

| # | 怎么做 | 通过标准 / 要记的 | 付费 |
|---|---|---|---|
| E1 | 4 分钟内依次点开助手 1、2、3、4（都是冷的、手上没事） | 第 4 个**不排队**：`report` 里有一行 `evict_room`（`Evicting profile backend "<最久没用的>" to make room for another assistant (committed)`），没有 `slot_wait` / `slot_timeout`，第 4 个正常就绪，没出现「暂时打不开「X」，稍后再试。」。记被挤掉的是谁（应是最久没用的那个）、点击到能输入要多久 | — |
| E2（只在 Mac 做） | 让池里 3 个引擎都在干活：在助手 1、2、3 里各发一个长任务（同 F2 的转码，或任何会停在「X 想在你的电脑上运行…」等你批准的事，先不批）。然后点开助手 4 | 立刻（不是 30 秒后）提示「<名字>、<名字>、<名字>都在做事，等其中一个做完再切过来。」，没有 `evict_room`、没有新的 `pool_start`；3 个任务都没被打断。之后结束其中一个（任务做完，或拒绝那个批准），再点助手 4：这次挤掉刚闲下来的那个，正常打开 | F |
| E3 | 所有助手都不碰，等 10 分钟以上 | 闲置的池引擎被回收：`reap` 行带 `: committed`（引擎答应退下）；主引擎不受影响。再点开它们是冷启动（D4） | — |
| E4 | 被挤掉或回收过的助手点回去，发一句 | 对话历史还在，能正常回复 | F |
| E5 | 每个引擎的内存：`report` 第二张表（就绪 30 秒后的 RSS，Windows 上还有 USS）；主 1 + 池 3 都在跑时，测试目录下全部进程 RSS 峰值 | 记数字，Mac 和 Windows 分开记；低配机上看会不会开始换页 | — |

### F. 后台剪片时切走再切回

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| F0 | `fixture --minutes 3` 和 `fixture --minutes 20 --calibrate slow` 生成两个测试视频，放进测试目录的 `home/cwd/` | `--calibrate` 打印这台机器转码 20 分钟片子大约要多久，用来挑 F2 的参数（目标：任务跑 12 分钟以上） | — |
| F1 | 在「剪辑助手」里说「把 qa-3min.mp4 剪成 3 段，每段加一句标题字幕」。开始后立刻切到 APEX 聊一句，等 2 分钟再切回 | 侧栏剪辑助手那一行的副标题显示它在做什么；做完时系统通知标题是「剪辑助手 · 回复就绪」（不是「APEX」，也没有别的助手的名字；测试副本的通知权限照实记）；切回时结果在、文件能播放 | F |
| F2 | 在「剪辑助手」里说「用 ffmpeg 把 qa-20min.mp4 转成 1080p H.264（preset slow，crf 18），转完告诉我文件大小」。开始后切到 APEX，**12 分钟以上不碰剪辑助手**，期间可以点开别的助手 | 剪辑助手的引擎没被回收也没被挤掉：`report` 池事件里没有它的 `evict` / `evict_room` / `reap`，引擎进程没退出；任务做完，输出文件时长和原片一致；切回能看到完整回复 | F |
| F3 | F2 进行中把助手 2、3、4 都点开（池满） | 正在跑任务的剪辑助手不会被挤掉：被挤的是手上没事的助手（`evict_room` 里没有剪辑助手）；记被挤掉的是谁、第 4 个有没有被拒 | — |
| F4（Mac） | 在剪辑助手里再开一个 F2 那样的长任务（跑 12 分钟以上），开始后按 ⌘W 关窗口（Mac 上 App 不退出），`watch` 开着，12 分钟后点 Dock 图标重开 | ① `report` 池事件里约 10 分钟时有剪辑助手的「Keeping idle profile backend … did not retire」，没有它的 reap，引擎进程没退出；② 任务跑完，输出文件时长和原片一致；③ 结果送达：重开后对话里有最后的回答，`snapshot` 里剪辑助手的 `main_thread_last_message` 是 assistant、`finish_reason` 为 stop，不是停在工具结果上 | F |
| F5（Mac、Windows 都做） | 同样的长任务，开始后让电脑睡眠 15 分钟再唤醒。睡眠时渲染端和主进程的定时器都停了，醒来时活跃时间已经过了 10 分钟。要有人在机器前：Mac 是本机，睡眠时 Claude 的会话也停；Windows 经 ToDesk 也会断开 | 同 F4 的 ①②③；醒来后第一次回收检查问到「有回合在跑」就留着 | F |
| F6（Windows） | Windows 上关最后一个窗口就是退出 App。用 `-QuitConfirm` 起，长任务进行中关窗口 | 弹出「还有任务在跑」的确认；选不退出，任务照跑；选退出，引擎都停掉（`stop` 报 0 个残留），再打开后这条对话如实显示中断，不假装做完 | F |

代码依据：

- 窗口开着时，渲染端对「有在跑或在等你决定的回合」的助手保留后台连接，每 60 秒 ping 一次，所以它不会被闲置回收。
- 多助手开时用户点开别的助手，主进程会先问每个池引擎有没有回合在跑，在跑的不挤（第 4 节）。
- 窗口关着、电脑睡眠或渲染端重载时 ping 会停。hc-1080（M4，fork #500）给闲置回收也补了「先问引擎」，用的是引擎自带的退役栅栏 `/api/health/retirement`。F4、F5 在打包产物上验这一条，Mac 和 Windows 都要有结果。
- 没有这条修复时，回收会 SIGTERM 掉引擎，那一轮收不到 message.complete（hc-1080 实测）。

### G. 改名和换样子（K6、M6）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| G1 | `snapshot` → 剪辑助手「···」→「改名或换样子」→ 在「改一下剪辑助手」里改名「小剪」→「改好了」→ `snapshot` → `diff` | 侧栏、头部胶囊、「给 小剪 发消息」、「小剪 记下了」、「小剪 的设置」都跟着变；`diff` 只动 `homes.<剪辑助手目录>.meta`（`ui_meta.apex.name`）和它的 SOUL（第一行），`origin` 还是 product；目录名不变，共用镜像 `shared` 不变 | — |
| G2 | 先 `snapshot`。在一个新助手（如选题助手）里说一句「以后你叫小题」，回复后再 `snapshot`、`diff`；在同一个助手里接着问「你叫什么？」 | 四处都要对，见表下 | F |
| G2b | 在另一个新助手里换个说法：「你改叫小剪吧」 | 同 G2 的四处。两种说法都要调到 `apex_rename`；哪种没调到，把原话和回复截图记下来交 M6 | F |
| G3 | 去 APEX 和别的助手问「你叫什么」 | APEX 还叫 APEX，别的助手名字不串 | F |
| G4 | APEX「···」→「改名」→「小橙」 | 能改；仍是紫色圆、第一行；「在微信里找」跟着叫小橙（K7：微信只接 APEX）；重启后保持 | — |
| G5 | 给别的助手换形状和颜色 | 立即生效，重启后保持；颜色在深色侧栏上也看得清 | — |

G2 的四处：

1. 模型真调了 `apex_rename`：快照里这个助手的 `tool_calls.requested.apex_rename` 和 `ran.apex_rename` 各 +1，`apex_memory` 没有增加。
2. 侧栏、头部胶囊跟着变成「小题」，`ui_meta.apex.name` = 小题。
3. SOUL.md 第一行变成 `You are 小题, …`（`check` 的 C8 PASS），「## 分工」那一段一字不变。
4. 共用记忆底账没有多一条称呼记录：`diff` 里 `shared` 不变，「它记得什么」里也没有。

另外，下一轮回复要自称「小题」。

### H. 删除（K9）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| H1 | `snapshot` → 小题「···」→「删除这个助手」→ `snapshot` → `diff` | 确认框标题「删掉「小题」？」，正文说清会删什么（它的对话、它在这台电脑上存的图片和视频、它那份技能）、不受影响的是什么（「关于你」、交付物、用量）；点「删掉」后回到 APEX；`profiles/<目录>` 没了，它的引擎进程没了；根目录、别的助手和 `shared` 都不变 | — |
| H2 | 删一个引擎正在跑的助手（Windows 上一定要做：文件被占用时删目录是老问题） | 先停引擎再删，不报错、不留半个目录；Windows 上没有「文件正被使用」 | — |
| H3 | 用同一个名字再建一个 | 是全新的助手：没有旧对话，三问重新问 | — |

### I. 重新登录后 key 轮换不 401（M4）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| I1 | 池里 3 个引擎都开着时 `snapshot`，然后退出登录、再登录（人来登录） | 重新登录会重新签发中转 key：根目录 key 指纹变了 | — |
| I2 | `snapshot` + `check` | C1 PASS：所有助手的 key 指纹都等于新的根指纹；`watch` 里看到每个助手 config 的 key 刷新行 | — |
| I3 | 在 APEX 和 4 个助手里各发一句 | 都正常回复；`report` 里含 401 的日志行数为 0；池里已经在跑的引擎也换了新 key（hc-1080 会停掉用旧 key 起的引擎，再连时用新 key 起；记下来） | F |

### J. 平台技能版本一致（M5）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| J1 | 建满后 `check` | C2 PASS；`snapshot` 里各助手 `platform_skills.versions` 一样，并且和服务端当前技能版本一致（版本号对照 apex-nodes `app/skills/apexnodes/*/SKILL.md`） | — |
| J2 | 新建一个助手后马上 `check` | 新助手立刻有全套平台技能，不用等下次同步 | — |

### K. 共用记忆（K1）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| K1 | 在助手 2 里说「记住：我的账号叫小橙子测评，主做美妆」 | 出现「<助手 2> 记下了：…」；「它记得什么」里有这一条；共用底账镜像变了 | F |
| K2 | 去助手 3 问「我的账号叫什么？」 | 答得出来 | F |

### S. 设置页（Kael 定：第一期维持现状）

2026-10-27 Kael 选了 A：多助手时，除「模型 / 档位」外的设置页改的是**屏幕上那个助手自己的 profile**，标题写「X 的设置」。「模型 / 档位」页改的是账户的，也就是 APEX 那一份，所有助手共用（K3）。

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| S1 | 在剪辑助手上打开设置，再切到 APEX 打开设置 | 标题分别是「剪辑助手 的设置」和「APEX 的设置」（G4 之后是「小橙 的设置」）；多助手关时（A1）标题仍是「设置」 | — |
| S2 | `snapshot` → 在剪辑助手的设置里改一项非档位的设置（比如语音或工作区里一个看得见的选项）→ `snapshot` → `diff` | `diff` 只动 `homes.<剪辑助手目录>.config.sections.<那一段>`；根目录和别的助手都不变。切到 APEX 打开同一页，显示的还是 APEX 原来的值 | — |
| S3 | 在剪辑助手的设置里打开「模型」（档位模式下叫「档位」） | 上面有一句「档位所有助手共用，这里改的是账户的(跟 APEX 一样)。别的设置是这个助手自己的。」；显示的档位和在 APEX 上看到的一样 | — |
| S4 | 账户能选第二个档位时，在剪辑助手的档位页换一次，`snapshot`、`diff`，再换回来（中间不发消息） | 改的是根目录的 `config.sections.model`；各个产品模式助手的 `model_default` 跟着根目录走（hc-1080 的配置修正）。要是要等重启或下次打开它才跟上，记下什么时候跟上的。Flash 账号如果只能选 Flash，记「只能看说明，换不了」 | — |
| S5 | 在 APEX 上打开档位页 | 没有那句共用说明（它改的就是自己的） | — |

### L. 重启、退出和清理

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| L1 | 退出再启动 | 侧栏顺序、名字、样子、未读点都保持；APEX 仍第一行 | — |
| L2 | `stop` | 测试目录下 0 个进程（池引擎和 IM 网关都退了，hc-1031） | — |
| L3 | 在新建的助手里生成一张图：「给我做一张美妆测评封面」 | 生成工具在新助手里能用（插件和平台工具凭据都到了池引擎） | F + G |

### N. 对话外面的名字（hc-1077）

| # | 怎么做 | 通过标准 | 付费 |
|---|---|---|---|
| N1 | 在剪辑助手上按快速输入的快捷键 | 小窗写「问 剪辑助手 点什么…」；输入一句后落进剪辑助手的主线，不是 APEX 的。切到 APEX 再按，小窗跟着变 | F |
| N2 | 打开命令面板（⌘K / Ctrl+K），搜「对话」 | 各助手的主线显示成「和 剪辑助手 的对话」等；选中别的助手的那条，那个助手切到前台 | — |
| N3 | 系统通知（F1 已看过「剪辑助手 · 回复就绪」）点开 | 点开就是那个助手的主线，它自动切到前台 | — |

### M. 只在 Windows 上看

- 删除时的文件占用（H2）。
- 冷启动有没有被安全软件拖慢：win-5090 开着 Defender 和 AliPaladin 文件过滤（hc-923）。记下来，不改它们的设置。
- 未签名安装包的提示照实截图（硬规则 15：Windows 安装包仍未签名）。

## 4. 量什么、预期什么

**冷启动**：

- **引擎就绪**：从「排队等槽」或「Starting Hermes backend for profile "X"」那一行，到引擎打出 `HERMES_BACKEND_READY`。READY 那一行有时进不了 desktop.log（Desktop 在认领子进程之后才开始记它的输出），这时工具改用「引擎开始监听端口」的时间，报告里「就绪依据」写 listen。
- **点击到能输入**：点之前 `mark`，点完截屏，到输入框占位变成「给 X 发消息」。computer use 的截屏间隔大，误差约 ±2 秒，只作参考。
- 每个助手记三种：第一次点开（冷）、被挤掉或回收后再点开（冷）、引擎还在时切回（热）。
- **试跑数字**：2026-10-27（UTC）用本机装的 0.17.62 打包产物试跑过整套工具，全新目录、没登录、没付费调用。
  - 首启 20 秒激活自带引擎；主引擎从「Starting」到 READY 3.7 秒。
  - 主引擎就绪 30 秒后 RSS 290 MB，连子进程峰值 328 MB；测试目录下全部进程 RSS 峰值 1142 MB。
  - `stop` 后 0 个进程。
  - macOS 不让读别的进程的 USS（AccessDenied，要 root），所以 Mac 上 USS 一栏是空的，Windows 上有。

**内存**：每个引擎进程就绪 30 秒后的 RSS（Windows 加 USS）、连子进程的峰值（剪片时 ffmpeg 算在它的引擎头上）、测试目录下全部进程的 RSS 峰值。

**池满会怎样**（读 fork main `aa8e554e` 的代码得出的预期，验收证实或推翻）：

- **上限**：池上限 3 个，不含主引擎（`electron/pool-limits.ts` 默认值；全新环境没改过）。APEX + 4 个助手时，4 个助手的引擎不可能同时在。
- **多助手开、用户点开一个没引擎的助手**：走 `makeRoomInPool`（`electron/apex-pool-engines.ts`，hc-1080 #500）。
  - 池里每个引擎都是候选，从最久没用的开始，挨个问它的退役栅栏。
  - 手上没事的答应退下，被停掉，日志 `Evicting profile backend "X" to make room for another assistant (committed)`，它的助手下次冷启动。
  - 有回合在跑、在等你批准、还在启动或答不上来的留着。
  - 挤出一个位子就停；一个都挤不出来时，**立刻**以 `APEX_POOL_ALL_BUSY` 失败，侧栏说「X、Y、Z都在做事，等其中一个做完再切过来。」，不等 30 秒。
- **多助手关，或不是用户点的启动**（后台补连）：还是上游的老路。只挤 4 分钟内没被 ping 过的里面最久没用的那个；挤不出来就等空槽，最多 30 秒（日志 `waiting for a free local slot`，后台的超时记成 `slot wait timed out (background)`）。
- **闲置回收**：10 分钟没被 ping 的池引擎，回收前也先问引擎（`reap` 行带原因，留下的记 `reap_kept`）。窗口开着时，渲染端每 60 秒 ping 当前助手和「有在跑或在等你决定的回合」的助手。
- **所以预期**：
  - E1：4 分钟内连着点开（或连着新建）4 个助手，第 4 个不排队，挤掉最久没用的那个；
  - E2：池里 3 个都在干活时，立刻被拒、说清楚为什么；
  - F3：正在剪片的助手不会被挤。
- 准备阶段读 `50a50d1b` 时的预判（「第 4 个排队 30 秒后失败」）已被 #500 的 `makeRoomInPool` 改掉，不再适用。
- **已知的观测缺口**：池满被拒（`APEX_POOL_ALL_BUSY`）不进 desktop.log。它在起引擎之前抛出，主进程的启动失败日志接不到；渲染端只打到 console，打包产物看不到。E2 的证据只能是截图，加上 `report` 里那段时间没有 `evict_room` 和新的 `pool_start`。

## 5. QA 记录怎么写

验收时新建 `qa-report.md`，照以前的 QA 记录（如 `../hc-1015/qa-report.md`）：

1. 版本、run id、引擎钉、两台（三台）机器配置、测试账号档位、开始和结束时间。
2. 第 3 节每一步：通过 / 不通过 / 没做（写原因），以及证据文件名。
3. 冷启动和内存表：`report` 输出原样贴，每台机器一份。
4. 池满的实际行为和第 4 节预期的对照。
5. 实际花费：每台机器 `tokens --since <开始时间>` 的结果，加上协调会话从 ChinaAPI 调用日志读回的金额，对照 `paid-calls.md` 的预估和批准的额度。
6. 发现的问题：每条写复现步骤、影响、建议归哪张票（M1–M6 或新票；新票号找协调会话）。
7. 清理：每个测试目录 `stop` 报 0 个进程、`cleanup` 做过；Windows 上的卸载项已清。

## 6. 放量

验收通过、内测机器上 `APEXNODES_MULTI_BOT=1` 跑满一周后，按 `rollout-request-draft.md` 起草申请给 Kael。只起草，不写库；客户端配置由协调会话在 Kael 批准后写。
