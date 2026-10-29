# hc-1107 — 「等你确认」:助手在等你时一眼看得出来

## 范围

- Cue 对比调研的 C1(https://claude.ai/artifact/EddNN3pdQcM4toyW26SWc7),PD Sheet1 第 1044 行。
- 只改单线产品模式。开关关、开发者模式逐字节不变：49 个 golden(`src/__identity__/waiting-for-you/`)在 fork main 91b2f71e 上先录，第一笔提交只有它们;开关关和开发者模式的 31 个在后面每笔提交上都不变。产品模式的 18 个在功能提交里重录，文件 diff 就是屏幕上的变化。hc-1077 的 `multi-bot/product-approval-inline.html` 一起重录(等你决定 → 等你确认、脸抬起来)。

## 改后的样子

截图来自开发页面：临时 Vite 页渲染真实的单线侧栏和对话，一边是 fork main 91b2f71e,一边是本分支，Electron 桥用替身。**不是打包产物。**

| 场景 | 改前 | 改后 | 截图 |
|---|---|---|---|
| 一个助手，等审批 | 侧栏「等你决定」,脸不变，没有点;活动行「等你决定」 | 侧栏「等你确认」+ 抬眼的脸 + 亮点;活动行「等你确认」+ 抬眼 | `screenshots/hc-1107-one-approval.jpg` |
| 一个助手，等你选 | 「等你决定」,脸不变 | 「等你决定」+ 抬眼 + 亮点 | `screenshots/hc-1107-one-clarify.jpg` |
| 多助手：当前等你选;后台一个等审批、一个接力中等审批、一个发送失败、一个在写回答 | 都是「等你决定」或最后一句，脸都不变;发送失败那个显示上一句回复;在写回答那个「正在思考…」 | 「等你决定」/「等你确认」/「在等你确认（APEX 交来的活）」各亮点、抬眼;「发送失败」红字;「正在回…」;接力卡 chip 和说明也说「在等你确认」 | `screenshots/hc-1107-several-a.jpg` |
| 多助手：接力确认卡开着;小红书文案的审批刚批完、命令还在跑 | APEX 行「等带货脚本交回」;小红书文案还是「等你决定」 | APEX 行「等你确认」+ 亮点;小红书文案马上回到「正在识别语音…」 | `screenshots/hc-1107-several-b.jpg` |

## 出口清单(硬规则 #12)

### A. 「助手在等你」从哪来(数过的全部来源)

「当前」= 正在看的助手;「后台」= 侧栏里别的助手(多助手)。每个阻塞请求都由 `server-requests.ts` 按会话挂起(后台 profile 的连接也汇到同一个处理函数);重连、resume 时引擎会重发，再挂一次;用户回答、请求撤回(`request.cancel`)、停下(`clearAllPrompts`)时立刻清掉。

| # | 来源 | 当前 / 后台 | 改前(main 91b2f71e) | 改后 |
|---|---|---|---|---|
| W1 | 审批：命令、代码、写指令文件(hc-1066 的 4 个出口是同一份请求：内联审批条、浮条 `PendingApprovalFallback`、原生通知的批准/拒绝按钮、「始终允许」对话框) | 两种都覆盖 | 活动行「等你决定」、脸不变;侧栏读 `needsInput`,**答完后还亮着，直到下一个工具跑完**(长命令要几分钟) | 「等你确认」+ 等你的脸 + 亮点;答完(任一出口)立刻恢复 |
| W2 | clarify 选择卡 | 两种 | 「等你决定」,脸不变，没有点 | 「等你决定」(字不变)+ 等你的脸 + 亮点 |
| W3 | sudo / secret / vault 三种(验证码、存登录、解锁) | 两种 | 同 W1 | 「等你确认」 |
| W4 | MCP 安装同意卡(`mcp.setup`) | 两种 | 只有 `needsInput`;活动行不算等你 | 「等你确认」(活动行也一样) |
| W5 | 接力确认卡(二期 R2 `$handoffProposal`,带用量行「要多跑 1 个回合，按你的套餐额度算」——这就是「花钱前的确认」) | 发起方那一行 | 看不出来 | 发起方一行「等你确认」+ 亮点;「交给它」/「先不」/接力关后立刻恢复 |
| W6 | 接手方的接力回合在等你(R1 轮询看到 `status: waiting`) | 后台 | 行写「在等你决定（X 交来的活）」,脸不变，没有点;靠 5 秒一次的轮询，答完还要等下一次轮询 | 本窗口持有那个会话时以挂起的请求为准(立刻);不持有时才用轮询结果;审批写「在等你确认（…）」 |
| W7 | 一条龙计划卡(R6)的「开始」 | — | — | **检查过，不改**:回合已经结束，只是提议，和「下一步」按钮一类;对话往下走它就消失。算成「等你」会让每条带计划的回复都长亮一个点。要算的话另开票 |
| W8 | gen_ladder 付费卡(「用掉 1 次额度」那类) | — | — | **检查过，不改**:只在云端插件 `apexnodes-gen-ladder` 里，本机引擎没有这个工具，单线产品模式到不了 |
| W9 | 「下一步」按钮(含「交给 X」) | — | — | 不改：建议，不阻塞 |
| W10 | 新助手首次三问(hc-1079) | — | — | 不改：行上已有「先问 3 个小问题」 |
| W11 | 失败卡(三条路)、中断提示 | — | — | 不改(失败，不是等待);只有「一句回复都没有 + 报错」的那种显示「发送失败」 |
| W12 | 只有 `needsInput`、没有挂起的请求(审批刚答完、命令还在跑;或请求在另一个窗口) | 两种 | 算等你 | **不再算等你**(这个窗口答不了，也看不到卡)。开发者模式的会话列表照旧读 `needsInput`,没动 |

### B. 显示在哪(数过的全部出口)

| 出口 | 文件 | 改不改 |
|---|---|---|
| 侧栏 APEX 单行(多助手关) | `app/single-thread/sidebar.tsx` `AssistantRow` | 改：脸、字、点 |
| 侧栏多助手行，当前 + 后台 | `app/single-thread/sidebar-bots.tsx` `BotRow` ← `bot-status.ts` | 改 |
| 对话底部活动行 | `components/assistant-ui/process/single-thread-process.tsx` | 改：字(确认/决定)、脸 |
| 接手方行的接力字样 | `app/single-thread/handoff/row-line.ts` | 改：跟这一行自己的「等你」走，不再跟轮询 |
| 发起方的接力卡(chip + 说明) | `app/single-thread/handoff/cards.tsx` | 改：审批说「在等你确认」 |
| 一条龙计划卡(每棒 chip、头部 chip、当前棒说明) | `app/single-thread/handoff/plan-card.tsx` | 改：同上;普查测试钉住没有卡片直接读「决定」字样 |
| 头部胶囊 | `app/single-thread/thread-header.tsx` | **检查过，不改**:hc-1014 定了头部不带状态，状态放活动行 |
| 新建助手面板、`@` 列表、接力卡里的头像 | `bot-sheet.tsx`、`composer-at.tsx`、`cards.tsx` | 不改：不是状态 |
| 原生通知 | `gateway-event/server-requests.ts` | 不改(hc-1066 已有) |
| 审批条、浮条、「始终允许」、选择卡本身 | `tool/approval*`、clarify | 不改：就是卡片本身 |
| 快速输入窗口 | `app/quick-entry/*` | 检查过：另一个 renderer,不显示助手状态 |
| 开发者模式 / 开关关的会话列表(needs-input 标记) | `session-status-dot.tsx`、`$attentionSessionIds` | 不改;golden 钉住(注入 I31 证明它会红) |

### C. 新状态

- 「正在回…」:回合在跑，用户最后一条之后的最新一段是有字的文字(在写回答)。
- 「发送失败」(红字):不在跑，用户最后一条之后只有报错、没有任何内容(`prompt.submit` 失败那种，或一开头就报错)。下一条一发出去就消失。带了部分内容再报错的不算。

### D. 文案出口

`i18n/single-thread.ts`(等你确认)、`single-thread-sidebar.ts`(正在回… / 发送失败)、`single-thread-handoff.ts`(在等你确认（…）、chip、说明):zh、zh-hant、en 三份齐;ja、ar 读 en(这三个文件本来就这样)。

## 反向验证(硬规则 #14)

脚本在独立 worktree 里把故障逐条放回最终 head 4fc7d47a,每条先断言锚点在文件里只命中 1 次，跑守卫测试(`CI=true`,JSON 报告，文件没加载算 BROKEN 不算 RED),再按 sha256 还原;跑完 worktree 干净。脚本和完整结果在协调会话笔记 `hc-1107-inject.py` / `hc-1107-inject-output.json`。在 5f106bc5 上先跑过前 31 条，也是全红。

基线(注入前)：GREEN,325 条。注入 35 条，红 35 条。

| # | 注入的故障(撤掉什么) | 注入的文件 | 结果(变红条数) | 变红的测试文件 | 第一条变红的测试 |
|---|---|---|---|---|---|
| I01 | 审批不再挂起「等你」 | `waiting-for-you.ts` | RED 16 | multi-bot-identity, single-thread-chat, waiting-for-you-identity, waiting-for-you | single_thread on, multi_bot off, product mode: byte-identical to main… |
| I02 | 选择卡不再挂起「等你」 | `waiting-for-you.ts` | RED 9 | sidebar-bots, sidebar, waiting-for-you-identity, waiting-for-you | product mode, one assistant the sidebar from another page, the thread… |
| I03 | MCP 安装同意卡不再算 | `waiting-for-you.ts` | RED 3 | waiting-for-you | what a parked prompt asks mcpSetup: confirm, under its own session on… |
| I04 | sudo 不再算 | `waiting-for-you.ts` | RED 2 | waiting-for-you | what a parked prompt asks sudo: confirm, under its own session only |
| I05 | 同一助手两个会话：选择排在审批前面 | `waiting-for-you.ts` | RED 1 | waiting-for-you | what a parked prompt asks a yes/no outranks a choice across the threa… |
| I06 | 所有挂起的请求都当成「选择」 | `waiting-for-you.ts` | RED 25 | multi-bot-identity, single-thread-chat, waiting-for-you-identity, waiting-for-you | single_thread on, multi_bot off, product mode: byte-identical to main… |
| I07 | 退回读 needsInput(审批答完还算等你) | `single-thread-presence.ts` | RED 5 | single-thread-presence, waiting-for-you-identity, waiting-for-you | product mode, one assistant the sidebar from another page, the thread… |
| I08 | 别的会话上的请求也算到这个助手 | `waiting-for-you.ts` | RED 4 | waiting-for-you-identity, waiting-for-you | product mode, several assistants and relay on assistants in the backg… |
| I09 | 侧栏行不读挂起的请求(只剩接力) | `bot-status.ts` | RED 9 | sidebar-bots, waiting-for-you-identity, waiting-for-you | product mode, several assistants and relay on the sidebar from anothe… |
| I10 | 接力回合自己的会话不读 | `bot-status.ts` | RED 1 | waiting-for-you | several assistants: on screen and in the background a relay turn whos… |
| I11 | 本窗口持有会话时仍用接力轮询 | `waiting.ts` | RED 1 | waiting-for-you | several assistants: on screen and in the background answered in this … |
| I12 | 去掉接力轮询的兜底 | `waiting.ts` | RED 3 | waiting-for-you-identity, waiting-for-you | product mode, several assistants and relay on assistants in the backg… |
| I13 | 接力确认卡不算等你 | `waiting.ts` | RED 2 | waiting-for-you-identity, waiting-for-you | product mode, several assistants and relay on the same with the relay… |
| I14 | 接力关时仍读接力状态 | `waiting.ts` | RED 1 | waiting-for-you | several assistants: on screen and in the background relay off: a stor… |
| I15 | 接手方的行字跟轮询走、不跟行 | `row-line.ts` | RED 3 | handoff-logic, waiting-for-you | several assistants: on screen and in the background a relay turn whos… |
| I16 | 接手方的行字从不说「确认」 | `row-line.ts` | RED 4 | handoff-logic, waiting-for-you-identity, waiting-for-you | product mode, several assistants and relay on assistants in the backg… |
| I17 | 等你时不亮点 | `row-dot.tsx` | RED 18 | waiting-for-you-identity, waiting-for-you | product mode, one assistant the sidebar from another page, the thread… |
| I18 | APEX 单行：对话开着时不亮点 | `sidebar.tsx` | RED 2 | waiting-for-you-identity, waiting-for-you | product mode, one assistant the sidebar on the conversation, waiting … |
| I19 | 多助手行：对话开着时不亮点 | `sidebar-bots.tsx` | RED 3 | waiting-for-you-identity, waiting-for-you | product mode, several assistants and relay on the sidebar on the conv… |
| I20 | 侧栏的脸不抬眼 | `sidebar-status.ts` | RED 17 | waiting-for-you-identity, waiting-for-you | product mode, one assistant the sidebar from another page, the thread… |
| I21 | 活动行的脸不抬眼 | `single-thread-process.tsx` | RED 10 | multi-bot-identity, single-thread-chat, waiting-for-you-identity, waiting-for-you | single_thread on, multi_bot off, product mode: byte-identical to main… |
| I22 | 活动行只看 awaitingInput、不看挂起的种类 | `single-thread-process.tsx` | RED 6 | multi-bot-identity, single-thread-chat, waiting-for-you-identity, waiting-for-you | single_thread on, multi_bot off, product mode: byte-identical to main… |
| I23 | 「确认」「决定」合成一个 | `single-thread.ts` | RED 18 | multi-bot-identity, single-thread-chat, waiting-for-you-identity, waiting-for-you | single_thread on, multi_bot off, product mode: byte-identical to main… |
| I24 | 眼睛不抬 | `apex-avatar.tsx` | RED 19 | multi-bot-identity, waiting-for-you-identity, waiting-for-you | single_thread on, multi_bot off, product mode: byte-identical to main… |
| I25 | 减少动态效果时亮点还在呼吸 | `apex-avatar.css` | RED 1 | waiting-for-you | the face (hc-1064’s figure) the hop and the lit dot are still under r… |
| I26 | 从不显示「正在回」 | `single-thread-presence.ts` | RED 4 | single-thread-presence, waiting-for-you-identity, waiting-for-you | product mode, one assistant the sidebar from another page, the thread… |
| I27 | 用户还没问就算「正在回」(我自己写出的 bug) | `single-thread-presence.ts` | RED 1 | multi-bot-identity | single_thread on, multi_bot off, product mode: byte-identical to main… |
| I28 | 有内容再报错也算「发送失败」 | `single-thread-presence.ts` | RED 1 | waiting-for-you | one assistant (APEX’s row) an answer that came with an error is not a… |
| I29 | 「发送失败」不是红字 | `sidebar-status.ts` | RED 5 | waiting-for-you-identity, waiting-for-you | product mode, one assistant the sidebar from another page, the thread… |
| I30 | 后台助手 needsInput 拖着时不报步骤 | `bot-activity.ts` | RED 1 | bot-activity | hc-1077 what a background assistant is doing names its step with need… |
| I31 | 关开关 / 开发者模式路径泄漏：会话列表的 needs-input 标记变了 | `session-states.ts` | RED 12 | waiting-for-you-identity | the switch off the sidebar from another page, the thread approval |
| I32 | 接力卡 chip 从不说「确认」 | `single-thread-handoff.ts` | RED 1 | waiting-for-you | the relay cards in the sender’s thread say the same words { kind: 'ap… |
| I33 | 接力卡说明从不说「确认」 | `single-thread-handoff.ts` | RED 1 | waiting-for-you | the relay cards in the sender’s thread say the same words { kind: 'ap… |
| I34 | 接力卡直接读「决定」字样(绕过拆分) | `cards.tsx` | RED 1 | waiting-for-you | the relay cards in the sender’s thread say the same words no card rea… |
| I35 | 没在等时活动信号多带 ask: null | `thread-signals.ts` | RED 1 | single-thread-chat | while a task runs: one activity line at the foot tells the sidebar wh… |
