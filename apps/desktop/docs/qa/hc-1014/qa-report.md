# hc-1014 单线对话：QA 记录

开关是 `desktop_features.single_thread`，默认关。打开它有两种办法：

- 管理端 client config 里设 `desktop_features.single_thread: true`。这是一条全局配置，打开就是所有安装。
- 单台装机设环境变量 `APEXNODES_SINGLE_THREAD=1`，内部灰度用这个；设成 `=0` 则强制关。

开关打开且不在开发者模式时，就是「单线产品模式」。开发者模式下一切照旧。

## 截图

截图来自 renderer 预览页，不是打包产物。做法是一张临时 Vite 页加 `hermesDesktop` 代理桩，上面渲染真实组件，不经过 Electron，也不登录。

还有两点和真实 App 不同：

- 输入框用的是加载时的占位框，不是真实输入框。真实输入框在主线里没有改动。
- 预览页没有标题栏留白，所以最上面一条分隔线贴着顶边。

| 状态 | 文件 |
|---|---|
| 开关关：开始页、侧栏「开始 ⌘N」、会话列表都在 | `screenshots/flag-off-start-and-sidebar.png` |
| 开关开：一条对话跨两天；跨天画日期，同一天闲置超过 6 小时画「新的一段」 | `screenshots/flag-on-one-thread-two-days.png` |
| 开关开、还没有主线时：两句问候加 hc-991 的三张卡，没有开始页 | `screenshots/flag-on-first-open-empty-thread.png` |
| 开关开：账户菜单「更早的对话」，列表里不含主线 | `screenshots/flag-on-earlier-conversations.png` |
| 开关开：打开一条更早的对话，只读，输入框换成「回到对话」 | `screenshots/flag-on-earlier-conversation-read-only.png` |

## 身份层守卫（硬规则 11）

守卫在 `src/single-thread-shell-identity.test.tsx`。

`src/__identity__/single-thread-shell/` 下的 golden 是在 fork main 4ee99a81d6 上录的。录制用的是同一个 `render.tsx`，那时还没有任何单线代码：

- 时钟固定在 2026-10-21 12:00，React、Radix、dnd-kit 生成的 id 都做了归一。
- 连录两次逐字节相同。
- 录制时 main 的开发者模式渲染和产品模式逐字节相同，所以开发者模式也和这份 golden 比。

两种情况必须和 golden 逐字一致：

- 开关关着；
- 开关开着但在开发者模式。

逐字比对的范围：

- 侧栏，包括「开始」行、⌘N、会话列表和「+」；
- 账户菜单，包括「历史会话」；
- 一条跨两天的对话：没有分隔线，「在新对话中分支」还在；
- 历史页；
- 开始页开关（`$introSplashShown === $introSplash`）；
- 空对话里不出现单线问候。

开关打开时，钉住的是：

- 没有开始页；
- 侧栏只有「对话」「沉浸式分析」两行，没有会话行、kbd、「开始」或「新对话」；
- 账户菜单里「更早的对话」替换「历史会话」，其余菜单项和顺序不变；
- 「更早的对话」页列出主线以外的会话；
- 对话里的分隔线依次是 `5 月 1 日 周五`、`新的一段`、`5 月 2 日 周六`，并且没有「在新对话中分支」；
- 还没有主线时显示问候；主线正在打开时什么都不显示，不会先闪一下问候。

## 反向验证（硬规则 14）

脚本是协调会话共享笔记里的 `hc-1014-inject.py`，结果在 `hc-1014-inject-output.json`。每条注入的做法：

1. 先断言锚点在文件里只命中 1 次；
2. 改坏代码，跑指定的 vitest 文件；
3. 用 vitest 的 json 报告记下真实变红的测试 id；
4. 恢复文件，用 sha256 证明恢复成功。

基线是全绿。第一轮 52 条里有 3 条没变红，都按发现处理了：

- **`chat-view-reads-raw-splash`**：注入的是等价改写 `&& true`，不是故障，而且被断言的那行字串仍然原样存在。改为注入真实的回退写法 `useStore($introSplash)`。
- **`restart-phrase-unanchored`**：测试里缺「从头来一遍字幕」这种情况。已补上这条用例，它属于「重做那一步」，不是新的一段。
- **`cold-start-restores`**：测试传的是「配置还没回来」，根本走不到守卫。现在同时测「设置为开」和「还没回来」两种。

之后新增了 5 条注入，覆盖标签栏「+」、命令面板新建会话、`/branch`。最终 57 条全部变红，没有一条未命中锚点：

| # | 注入（撤掉或改坏什么） | 文件 | 结果 | 变红的测试（节选） |
|---|---|---|---|---|
| 1 | `flag-install-switch-ignored` | `src/store/single-thread.ts` | RED | hc-1014 desktop_features.single_thread {"installSwitches":{"single_thread":true},"payload":null} reads as true（共 3 条） |
| 2 | `flag-literal-true-relaxed` | `src/lib/desktop-features.ts` | RED | hc-1014 desktop_features.single_thread {"payload":{"desktop_features":{"single_thread":"true"}}} reads as false |
| 3 | `flag-env-zero-not-off` | `electron/apex-desktop-features.ts` | RED | hc-1014 install switches for desktop_features APEXNODES_SINGLE_THREAD="0" reads as false（共 2 条） |
| 4 | `main-drops-install-switches` | `electron/main.ts` | RED | hc-1014 install switches for desktop_features main answers hermes:clientConfig:get through clientConfigForRenderer with process.env |
| 5 | `dev-mode-not-exempt` | `src/store/single-thread.ts` | RED | hc-1014 developer mode with the switch on: byte-identical to main keeps the sidebar: 开始 row, ⌘N, session list and "+" all there（共 9 条） |
| 6 | `start-page-kept` | `src/store/intro-splash.ts` | RED | hc-1014 switch on, product mode: one conversation has no Start page |
| 7 | `chat-view-reads-raw-splash` | `src/app/chat/index.tsx` | RED | hc-1014 the seams stay wired the chat view reads the single-thread splash and the gated composer |
| 8 | `chat-view-ungated-composer` | `src/app/chat/index.tsx` | RED | hc-1014 the seams stay wired the chat view reads the single-thread splash and the gated composer |
| 9 | `sidebar-not-swapped` | `src/app/contrib/surfaces.tsx` | RED | hc-1014 switch on, product mode: one conversation has no session list, no 开始 / ⌘N row and no "+": one row opens the conversation |
| 10 | `shell-not-mounted` | `src/app/contrib/surfaces.tsx` | RED | hc-1014 the seams stay wired the sidebar surface swaps in the single-thread sidebar and the chat surface mounts the shell |
| 11 | `lookup-fails-open` | `src/store/main-thread.ts` | RED | hc-1014 the thread is found by its title, never by a stored id fails closed: a failed lookup is an error, never "no thread yet" |
| 12 | `held-thread-downgraded` | `src/store/main-thread.ts` | RED | hc-1014 the thread is found by its title, never by a stored id never downgrades a thread it holds because one later read failed or came back empty |
| 13 | `stale-lookup-lands` | `src/store/main-thread.ts` | RED | hc-1014 the thread is found by its title, never by a stored id lands only the newest lookup, so a profile switch mid-read keeps the new profile |
| 14 | `lookup-matches-any-row` | `src/store/main-thread.ts` | RED | hc-1014 the thread is found by its title, never by a stored id matches the lineage root title, and ignores a row that only looks similar |
| 15 | `rotation-not-followed` | `src/store/main-thread.ts` | RED | hc-1014 which stored ids are the thread follows a rotation onto a tip the session list has not seen yet |
| 16 | `lineage-not-recognized` | `src/store/main-thread.ts` | RED | hc-1014 which stored ids are the thread recognizes every segment of the lineage through the session list |
| 17 | `middleware-not-passthrough-off` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: the switch off passes the very same draft through and calls nothing |
| 18 | `unsettled-thread-sends` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: a send that does not belong in the thread stops while the thread is unknown (fail closed: no second thread)（共 3 条） |
| 19 | `earlier-conversation-sends` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: a send that does not belong in the thread stops from an earlier conversation |
| 20 | `draft-sends-while-thread-opening` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: a send that does not belong in the thread stops from the Start draft while the found thread is opening |
| 21 | `slash-new-forks` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: segments of the thread /new opens a segment and sends nothing: the thread never forks |
| 22 | `day-boundary-ignored` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: segments of the thread the first message of a new day opens a segment first, then goes out（共 3 条） |
| 23 | `restart-phrase-ignored` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: segments of the thread 「从头来」 opens a segment that keeps only what lasts, and still sends the message |
| 24 | `restart-focus-dropped` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: segments of the thread 「从头来」 opens a segment that keeps only what lasts, and still sends the message |
| 25 | `failed-summary-eats-message` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: segments of the thread a failed summary still lets the message out |
| 26 | `compress-while-busy` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: segments of the thread does not compress while a turn is running |
| 27 | `segment-start-not-recorded` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: segments of the thread records where the segment started and waits for the rotation it causes |
| 28 | `first-message-not-claimed` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: the first message makes the thread lets the draft through and marks the session it creates for claiming |
| 29 | `title-conflict-not-adopted` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: the first message makes the thread adopts the thread another window made when the title is already taken |
| 30 | `idle-rule-five-hours` | `src/app/single-thread/segments.ts` | RED | hc-1014 when the next message opens a new segment 5 h 59 min idle, same day（共 2 条） |
| 31 | `day-rule-dropped` | `src/app/single-thread/segments.ts` | RED | hc-1014 when the next message opens a new segment across midnight, 20 minutes（共 3 条） |
| 32 | `restart-phrase-unanchored` | `src/app/single-thread/segments.ts` | RED | hc-1014 「从头来」 and /new "从头来一遍字幕" → false |
| 33 | `segment-marker-ignored` | `src/app/single-thread/segments.ts` | RED | hc-1014 the line above a turn 「从头来」 within an hour |
| 34 | `turn-divider-unmounted` | `src/components/assistant-ui/thread/list.tsx` | RED | hc-1014 switch on, product mode: one conversation joins the segments into one timeline with a date per day and 「新的一段」 after idle hours（共 2 条） |
| 35 | `divider-drawn-with-switch-off` | `src/app/single-thread/turn-divider.tsx` | RED | hc-1014 the switch off: byte-identical to main keeps the transcript: no date or segment lines, 在新对话中分支 still offered（共 2 条） |
| 36 | `branch-in-new-chat-kept` | `src/components/assistant-ui/thread/index.tsx` | RED | hc-1014 switch on, product mode: one conversation joins the segments into one timeline with a date per day and 「新的一段」 after idle hours |
| 37 | `empty-greeting-with-switch-off` | `src/components/assistant-ui/thread/index.tsx` | RED | hc-1014 the switch off: byte-identical to main draws no single-thread greeting in an empty chat（共 2 条） |
| 38 | `greeting-flashes-while-opening` | `src/app/single-thread/thread-empty.tsx` | RED | hc-1014 switch on, product mode: one conversation greets in the conversation when there is no thread yet, and stays blank while one is opening |
| 39 | `claim-window-gated-composer` | `src/app/single-thread/composer-gate.tsx` | RED | hc-1014 the composer gate the session a first message just created → read-only: true |
| 40 | `pre-thread-sessions-writable` | `src/app/single-thread/composer-gate.tsx` | RED | hc-1014 the composer gate any conversation before the thread exists → read-only: true |
| 41 | `earlier-bar-never-shown` | `src/app/single-thread/composer-gate.tsx` | RED | hc-1014 the composer gate puts a read-only bar with the way back under an earlier conversation |
| 42 | `history-not-earlier` | `src/app/business-workspace/pages/history-page.tsx` | RED | hc-1014 switch on, product mode: one conversation lists every conversation but the thread on 「更早的对话」 |
| 43 | `earlier-lists-the-thread` | `src/app/single-thread/earlier-conversations.tsx` | RED | hc-1014 switch on, product mode: one conversation lists every conversation but the thread on 「更早的对话」 |
| 44 | `account-menu-says-history` | `src/app/single-thread/nav-labels.ts` | RED | hc-1014 switch on, product mode: one conversation names the old sessions 「更早的对话」 in the account menu |
| 45 | `cold-start-restores` | `src/app/contrib/hooks/use-desktop-integrations.ts` | RED | useDesktopIntegrations hc-1014 single-thread mode opens the one conversation, never a remembered chat, with the setting on or still loading（共 2 条） |
| 46 | `start-not-taken-over` | `src/app/single-thread/use-single-thread-shell.ts` | RED | hc-1014 the single-thread shell opens the thread instead of the Start page, at its live tip |
| 47 | `shell-runs-in-secondary-window` | `src/app/single-thread/use-single-thread-shell.ts` | RED | hc-1014 the single-thread shell stays out of a secondary window |
| 48 | `middleware-registered-switch-off` | `src/app/single-thread/use-single-thread-shell.ts` | RED | hc-1014 the single-thread shell does nothing at all with the switch off: no lookup, no middleware, Start stays Start |
| 49 | `claim-listener-missing` | `src/app/single-thread/use-single-thread-shell.ts` | RED | hc-1014 the single-thread shell titles the session a first message creates |
| 50 | `quick-entry-not-routed` | `src/app/single-thread/quick-entry.ts` | RED | hc-1014 quick entry goes to the one conversation sends to the thread on screen as the current chat, and to the thread in the background otherwise（共 2 条） |
| 51 | `new-tab-opens-second-chat` | `src/app/single-thread/another-conversation.ts` | RED | hc-1014 ⌘T and the new-window shortcut with single-thread product mode they true |
| 52 | `tab-strip-plus-shown` | `src/app/single-thread/new-session-tab.ts` | RED | hc-1014 the other new-chat entries hides the tab strip "+" only in single-thread product mode |
| 53 | `tab-strip-reads-raw-action` | `src/components/pane-shell/tree/renderer/tree-group.tsx` | RED | hc-1014 the seams stay wired the tab strip "+" and the command palette read the one-conversation guard |
| 54 | `palette-keeps-new-chat` | `src/app/single-thread/another-conversation.ts` | RED | hc-1014 the other new-chat entries drops the palette's new-chat rows (and a group left empty) only in single-thread product mode |
| 55 | `palette-not-filtered` | `src/app/command-palette/index.tsx` | RED | hc-1014 the seams stay wired the tab strip "+" and the command palette read the one-conversation guard |
| 56 | `slash-branch-forks` | `src/app/single-thread/composer-middleware.ts` | RED | hc-1014 composer middleware: segments of the thread /branch is refused: the one thread has no second conversation to branch into |
| 57 | `keybinds-bypass-guard` | `src/app/hooks/use-keybinds.ts` | RED | hc-1014 the seams stay wired ⌘T and the new-window shortcut go through the one-conversation guard |

## 其他检查

- `npm run typecheck` 通过。
- 改动和新增文件 `eslint` 通过：没有 error，新文件也没有 warning。
- `python scripts/check --only health` 通过：40 个文件，0 blocking。几个超过上限的大函数行数和复杂度都没涨，包括 ChatSidebar、ContribWiring、ChatViewContent、ThreadMessageListInner、CommandPalette、TreeGroup、useDesktopIntegrations 的恢复 effect。
- `electron/main.ts` 净少 3 行；`en.ts`、`zh.ts`、`types.ts` 都没动，新文案在 `i18n/single-thread-chat.ts`。
- 最终代码跑全量 desktop vitest：13393 条通过，1 条失败。
  - 失败的是 `electron/packaged-runtime.test.ts` 里一条测试，满载时超过 5 秒；单独跑两次都是 36/36 通过。
  - 本票没碰这个文件。之前两次全量（1254 files）都是全绿。
