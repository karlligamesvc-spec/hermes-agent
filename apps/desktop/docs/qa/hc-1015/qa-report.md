# hc-1015 只有问题和回复（含三档不给用户看）— QA 报告

开关：`desktop_features.single_thread`（hc-1014 定义，默认关）。下文「单线模式」= 开关开着且不在开发者模式。

## 截图（`screenshots/`）

来源：临时 dev harness（真实的 Thread、ChatBar、StatusbarControls 组件，中文，Electron 桥用 stub 代替，夹具同 `src/test/remix-turn.ts`），**不是打包产物**。harness 已删除，没有提交。

| 文件 | 开关 | 内容 |
|---|---|---|
| 01-off-finished / 02-on-finished | 关 / 开 | 做完一单：关时是过程块 +「想了 15 秒」+ ⏱ 2:10 + 模型药丸；开时只有回答和「用时 2 分 10 秒 · 看过程」 |
| 03-off-opened / 04-on-opened | 关 / 开 | 展开步骤：开时步骤、来源、「用到的方法」都在「看过程」下面 |
| 05-off-running / 06-on-running | 关 / 开 | 进行中：开时对话底部一行活动（APEX 标 +「正在识别语音… 第 2 步」+ 慢步骤提示） |
| 07-off-approval / 08-on-approval | 关 / 开 | 危险命令审批：开时活动行写「等你决定」，下面照样是 运行 / 拒绝 / 命令 审批条 |
| 09-off-stuck / 10-on-stuck | 关 / 开 | 卡住：开时「识别语音没成功 第 2 步，共 2 步」、步骤自动展开、失败卡 + 重试 / 换个办法 / 先给我能出的部分 |
| 11-on-developer | 开 + 开发者模式 | 和开关关时一样（过程块、想了 N 秒、模型药丸都在） |
| 12-off-plus-advanced / 13-on-plus-advanced | 关 / 开 | 「+」› 高级：开时没有「场景…」「审批方式」，生成两行没有模型名和子菜单 |
| 14-off-statusbar | 关 | 状态栏：网关、工作目录、⚡ 智能审批、版本号。开关开时这一栏不画（审批是 smart、没有待装更新） |

## 身份层守卫（硬规则 11）

`src/single-thread-identity.test.tsx` 的 7 份 golden 是在 fork main `4ee99a81d6` 上、写任何单线代码之前录的（第一个提交 `b9ddba911c` 只有测试和 golden）。之后的提交没有改动 golden 一个字节：

- 消息区：做完、进行中、卡住、只思考没调工具四种回合，展开步骤 + 思考，开发者模式；
- 输入框整行（APEX 账号）；
- 开关开 + 开发者模式，对照同一份开发者模式 golden。

CI 模式（`CI=true`，不写 golden）和 UTC / Asia/Shanghai / America/Los_Angeles 三个时区连跑都一致。归一化只抹掉 React 生成的 id 和输入框轮换的占位语。

## 反向验证（硬规则 14）

脚本把每个改动撤掉或改坏（先断言锚点在文件里恰好命中 1 次），跑守它的测试，记下真实变红的用例，再按 sha256 原样还原。**52/52 变红，0 条绿。** 第 1 轮 46 处跑在 `c37bec69ec`；协调会话更正环境变量和 ⚡ 之后，主进程、引擎和状态栏那 20 处又在最终代码上整轮重跑，「主进程不写单机开关」的 3 处另跑一轮（第 2 轮里 ⚡ 锁定那条先是绿的，原因是测试里的 ⚡ 没带 toggleLabel、根本藏不掉，补上后变红）。脚本和原始输出在协调会话共享笔记 `hc-1015-reverse-verify.py` / `hc-1015-reverse-verify-output.txt`。

| # | 注入 | 文件 | 变红 |
|---|---|---|---|
| 1 | 开关关时也画「看过程」行 | `single-thread-process.tsx` | 5 条（single-thread-identity.test.tsx） |
| 2 | 开关关时也用活动行替换尾部两行 | `assistant-message.tsx` | 1 条（single-thread-identity.test.tsx） |
| 3 | 开关关时也不画过程块 | `tool-group-slot.tsx` | 6 条（single-thread-identity.test.tsx） |
| 4 | 开关关时也藏思考 | `message-parts.tsx` | 1 条（single-thread-identity.test.tsx） |
| 5 | 开关关时也藏 ⏱ | `assistant-message.tsx` | 5 条（single-thread-identity.test.tsx） |
| 6 | APEX 账号不论开关都藏模型药丸 | `model-choice.ts` | 1 条（single-thread-identity.test.tsx） |
| 7 | 单线模式不认开发者模式 | `single-thread.ts` | 4 条（model-choice.test.ts、single-thread-chat.test.tsx、single-thread-composer.test.tsx、single-thread-identity.test.tsx） |
| 8 | 单线模式下过程块仍画在回答中间 | `tool-group-slot.tsx` | 4 条（single-thread-chat.test.tsx） |
| 9 | 单线模式下仍出思考 | `message-parts.tsx` | 1 条（single-thread-chat.test.tsx） |
| 10 | 回答下面没有「看过程」行 | `assistant-message.tsx` | 3 条（single-thread-chat.test.tsx） |
| 11 | 一个回合的每个气泡都出「看过程」 | `single-thread-process.tsx` | 3 条（single-thread-chat.test.tsx） |
| 12 | 仍用旧的尾部两行 | `assistant-message.tsx` | 3 条（single-thread-chat.test.tsx） |
| 13 | 活动行下不挂审批条 | `single-thread-process.tsx` | 1 条（single-thread-chat.test.tsx） |
| 14 | 等用户时不说「等你决定」 | `single-thread-process.tsx` | 2 条（single-thread-chat.test.tsx） |
| 15 | 去掉失败卡和三个按钮 | `single-thread-process.tsx` | 1 条（single-thread-chat.test.tsx） |
| 16 | 卡住时步骤默认收起 | `single-thread-process.tsx` | 1 条（single-thread-chat.test.tsx） |
| 17 | 仍出 ⏱ | `assistant-message.tsx` | 2 条（single-thread-chat.test.tsx） |
| 18 | 仍出「换更强的再答一次」 | `assistant-message.tsx` | 1 条（single-thread-chat.test.tsx） |
| 19 | 仍出「在新对话中分支」 | `assistant-message.tsx` | 1 条（single-thread-chat.test.tsx） |
| 20 | APEX 错误卡仍出「切换提供方」 | `assistant-message.tsx` | 1 条（single-thread-chat.test.tsx） |
| 21 | 输入框仍出模型药丸 | `model-pill.tsx` | 2 条（model-tier-exits.test.ts、single-thread-composer.test.tsx） |
| 22 | 高级里仍有「场景…」 | `toolbar-start.tsx` | 1 条（single-thread-composer.test.tsx） |
| 23 | 高级里仍有「审批方式」 | `toolbar-start.tsx` | 1 条（single-thread-composer.test.tsx） |
| 24 | 生成两行仍有模型子菜单 | `context-menu.tsx` | 1 条（single-thread-composer.test.tsx） |
| 25 | 自带密钥的用户也没了模型药丸 | `model-choice.ts` | 6 条（model-choice.test.ts、model-tier-exits.test.ts、single-thread-chat.test.tsx、single-thread-composer.test.tsx、single-thread-slash.test.ts） |
| 26 | 三档模式不再藏模型选择 | `model-choice.ts` | 2 条（model-choice.test.ts、model-tier-exits.test.ts） |
| 27 | 单线模式下 userFacingModelName 仍给模型名 | `model-tiers.ts` | 1 条（model-choice.test.ts） |
| 28 | 单线模式下 useUserFacingModelName 仍给模型名 | `model-tiers.ts` | 1 条（model-choice.test.ts） |
| 29 | 自带密钥的模型名也被藏 | `model-tiers.ts` | 1 条（model-choice.test.ts） |
| 30 | 单线模式下 /moa 仍在候选 | `desktop-slash-commands.ts` | 1 条（single-thread-slash.test.ts） |
| 31 | 审批不是 off 也留 ⚡ | `single-thread-statusbar.ts` | 4 条（single-thread-statusbar.test.tsx） |
| 32 | 没有待装更新也留版本号 | `single-thread-statusbar.ts` | 4 条（single-thread-statusbar.test.tsx） |
| 33 | 插件项被滤掉 | `single-thread-statusbar.ts` | 2 条（single-thread-statusbar.test.tsx） |
| 34 | 钩子不认开关 | `single-thread-statusbar.ts` | 4 条（single-thread-statusbar.test.tsx） |
| 35 | 用户藏过 ⚡ 时 off 也看不到它 | `single-thread-statusbar.ts` | 1 条（single-thread-statusbar.test.tsx） |
| 36 | 空状态栏仍画 | `statusbar-controls.tsx` | 1 条（single-thread-statusbar.test.tsx） |
| 37 | 平台值不是字面 true 也算开 | `apex-single-thread.ts` | 2 条（apex-single-thread.test.ts） |
| 38 | 不认本机 APEXNODES_SINGLE_THREAD | `apex-single-thread.ts` | 3 条（apex-single-thread.test.ts） |
| 39 | 主进程顺手写了 hc-1014 的输入变量 | `apex-single-thread.ts` | 4 条（apex-single-thread.test.ts） |
| 40 | 主进程启动调用顺手写了单机开关 | `apex-model-tiers.ts` | 6 条（apex-single-thread.test.ts） |
| 41 | main.ts 删掉单机开关 | `main.ts` | 1 条（apex-single-thread.test.ts） |
| 42 | 开关关的那次启动留着旧信号 | `apex-single-thread.ts` | 1 条（apex-single-thread.test.ts） |
| 43 | 启动只落三档开关 | `apex-model-tiers.ts` | 1 条（apex-single-thread.test.ts） |
| 44 | main.ts 换回只落三档的调用 | `main.ts` | 1 条（apex-model-tiers.test.ts） |
| 45 | 单线模式下 Pro 选择保留 | `apex-model-tiers.ts` | 2 条（apex-single-thread.test.ts） |
| 46 | 配置自愈跳过单线模式 | `apex-model-tiers.ts` | 3 条（apex-single-thread.test.ts） |
| 47 | 只开三档也把 Pro 改回 Flash | `apex-model-tiers.ts` | 2 条（apex-model-tiers.test.ts、apex-single-thread.test.ts） |
| 48 | 没开也加提示段 | `single_thread_prompt.py` | 7 条（test_single_thread_prompt_seam.py） |
| 49 | 开了也不加提示段 | `single_thread_prompt.py` | 3 条（test_single_thread_prompt_seam.py） |
| 50 | 去掉「照常先问」那条 | `single_thread_prompt.py` | 1 条（test_single_thread_prompt_seam.py） |
| 51 | 引擎把 "true" 也当开（只认主进程写的 1） | `single_thread_prompt.py` | 1 条（test_single_thread_prompt_seam.py） |
| 52 | 插件 register 不调这个接缝 | `__init__.py` | 1 条（test_single_thread_prompt_seam.py） |

## 测试

新增测试（都在本 PR）：

| 文件 | 条数 | 管什么 |
|---|---|---|
| `src/single-thread-identity.test.tsx` | 8 | 开关关时消息区 6 种 + 输入框 1 种逐字一致；开关开 + 开发者模式对照同一份 golden |
| `src/components/assistant-ui/thread/single-thread-chat.test.tsx` | 11 | 「用时 · 看过程」位置和展开、无思考 / ⏱、活动行文案和位置、审批条、「等你决定」、卡住三按钮、开发者模式、不出换更强 / 分支 / 切换提供方（各带开关关或自带密钥的对照） |
| `src/app/chat/composer/single-thread-composer.test.tsx` | 4 | APEX 账号无模型药丸、高级里无场景和审批方式、生成两行无模型子菜单；自带密钥和开发者模式保留 |
| `src/app/shell/single-thread-statusbar.test.tsx` | 10 | 只留 off 时的 ⚡ 和待装更新的版本号、插件项照常、空了不画、钩子在开关关 / 开发者模式时原样返回；用真的 ⚡ 菜单：用户藏过也照样显示，点开选「智能」会写 `approvals.mode` |
| `src/lib/single-thread-slash.test.ts` | 4 | `/moa` 不出候选（`/model` 本来就不在候选里），自带密钥保留 |
| `src/store/model-choice.test.ts` | 11 | `$modelChoiceHidden` 真值表（含三档模式不受影响）、展示用模型名在单线模式下为空 |
| `electron/apex-single-thread.test.ts` | 28 | 只认字面 `true`；和 hc-1014 一样本机 `APEXNODES_SINGLE_THREAD` 优先；只写引擎用的 `APEX_SINGLE_THREAD_ACTIVE`，渲染端 installSwitches 不受影响；关的那次启动清掉旧信号；主进程不改 `APEXNODES_SINGLE_THREAD`（main 启动时那个调用对 5 种初值都原样留着，外加扫一遍主进程模块源码，不许赋值或 delete）；配置自愈钉 `apex-flash` 和不动的情况 |
| `tests/apex_overlay/test_single_thread_prompt_seam.py` | 19 | 只在 `APEX_SINGLE_THREAD_ACTIVE` 为 1 时加段、规则原文、真实 `AIAgent` 的 `build_system_prompt` 带上它、插件 register 调到它 |

改的既有测试：`src/model-tier-exits.test.ts`（hc-960 出口清单：门换成 `$modelChoiceHidden`，并钉住「三档模式时它一定为真」）、`electron/apex-model-tiers.test.ts`（main.ts 启动调用改名）。

全量（rebase 到 hc-1014 之后的提交 `c37bec69ec`；之后按协调会话改了环境变量和 ⚡，又重跑了 Electron 全量 264 文件 / 3573 条、`tests/apex_overlay` 694 条、相关 UI 165 文件 / 1962 条和 `scripts/check`，都过）：

- Desktop `npm run typecheck` 四段全过；eslint 0 error（剩下的 12 条 warning 是 main.ts 和 use-statusbar-items.tsx 里原有的行）；
- Desktop UI 全量 991 文件 / 9771 条全过；Electron 全量 264 文件 / 3568 条全过（25 条本来就跳过）；
- `tests/apex_overlay` 加 `tests/agent/test_system_prompt*.py`：40 文件 / 798 条全过（34 条本来就跳过）；
- `python scripts/check` 12 项通过，code health 0 blocking（main.ts 净 0 行，四个 i18n 大文件没动）。
