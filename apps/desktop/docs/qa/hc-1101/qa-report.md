# hc-1101 — 单线模式下，自己发的消息能复制

## 为什么复制不了

单线产品模式下，用户气泡整个是一个按钮(点一下进编辑),所以:

- 全局样式让所有按钮里的字都选不中(`styles.css` 的 `button { user-select: none }`);
- 气泡上没有复制按钮，悬停只有「恢复」;
- 表情回应默认关，所以右键什么都不出;
- 拖着想选字，松手那一下等于点击，直接打开编辑框。

上游代码里其实写了「拖选结束时有选区就不进编辑」的保护(`hasTextSelection()`),只是选不中字，这条保护从来没起过作用。

## 改后

都只在单线产品模式下生效。开关关、开发者模式逐字节不变，见下面「身份层」。

| 怎么复制 | 改后的样子 | 截图 |
|---|---|---|
| 拖选 | 字能选中(白色半透明底);松手不进编辑;⌘C 和右键「复制」复制选中的部分 | `screenshots/04-after-drag-selected.png`,深色 `07-after-dark-selected.png` |
| 悬停 | 气泡左边是「复制」和「恢复」;运行中的最新一条是「复制」和「停止」 | `screenshots/03-after-hover.png` |
| 点「复制」 | 复制整条，图标变 ✓,提示「已复制」(和 APEX 回复上的复制一样) | `screenshots/06-after-copied.png` |
| 右键气泡(没选字) | 出 APEX 的右键菜单，只有一项「复制」,复制整条 | `screenshots/05-after-right-click.png` |

修前：悬停只有「恢复」,拖选什么都选不中(`01-before-hover-and-drag.png`);右键什么都不出(`02-before-right-click.png`)。

复制出来是气泡上看到的样子:

- 附件、链接的引用写法(`` @file:`/Users/…/脚本 v2.md` ``)换成它指的路径或链接，和气泡里的标签一致;
- 代码块原样;
- 自己打的行内代码保留反引号;
- 前后空白去掉。

截图来自开发页面：临时 Vite 页渲染真实的 `Thread` 和 `AppContextMenu`,单线开关开、产品模式、中文，Electron 桥用替身。**不是打包产物。** 真 Chrome(Playwright,系统 Chrome)里实测:

| 操作 | 修前 | 修后 |
|---|---|---|
| 拖选「发了，1.2 万播放，完播 18%」 | 选中 `""`,松手进编辑 | 选中整句，不进编辑 |
| 然后 ⌘C | 剪贴板没变 | 整句 |
| 悬停的按钮 | 恢复检查点 | 复制、恢复检查点 |
| 点「复制」 | — | 整句;提示变「已复制」 |
| 右键气泡 | 不出菜单 | 菜单「复制」→ 整句 |
| 多行 + 代码 + 链接 + 文件引用，点「复制」 | — | `第一行：先跑 \`npm test\`\n第二行：参考 https://v.douyin.com/iRemix01/ 和 /Users/xiaoman/脚本 v2.md` |

## 出口清单(硬规则 12)

人发的消息，文字能出去的地方:

| 出口 | 本 PR | 读的是什么 |
|---|---|---|
| 悬停「复制」 | 新增(单线) | `UserMessage` 的 `messageText` → `copyableMessageText` |
| 右键「复制」(没选字) | 新增(单线) | 同上 |
| 拖选后 ⌘C、右键「复制」 | 原有(应用菜单复制选区),单线下现在能选中 | 屏幕上的字 |
| 编辑框(单击气泡) | 不变 | `messageText` |
| 恢复 / 重来 | 不变 | `messageText` |
| 会话预览、搜索摘要 | 不变，不在本 PR 范围 | 引擎侧 |

`messageText` 在 hydration 时已经去掉附加的上下文、上下文警告和 `@image:` 行。二期 R2(#517)合进来后，它还会去掉接力头 `<!-- apex:handoff … -->`(`withoutHandoffHeader`)。两个新出口都从 `messageText` 取字，所以 R2 一合，接力头就不会被复制出去。已在「本分支 + #511→#517→#515→#512」的试合并上验证：从悬停按钮和右键菜单复制交来的活，只拿到正文，没有 `apex:`。R2 的出口普查(`reply-markers.test.ts`)已经把 `user-message.tsx` 记为「用户气泡、编辑、恢复」。合并后把这一行的注释补上「复制」。

## 身份层(硬规则 11)

- 第一个 commit 只有 `src/user-message-identity.test.tsx` 和 `src/__identity__/user-message/*.html`,是在干净的 fork main `784a824659` 上录的。
- 录的内容：一段对话里的每一行用户消息，包括气泡、气泡下的图片、悬停栏的停止或恢复、后台进程提示、助手互发提示、带时间戳的一条。三种情况：开关关的产品模式、开关关的开发者模式、开关关但表情回应开。
- 在 main 上 `CI=true`、`TZ=UTC / Asia/Shanghai / America/Los_Angeles` 各跑一遍，sha256 都没变。
- 本分支上：开关关的三份逐字节一致;开关开 + 开发者模式，和开发者模式那份逐字节一致。
- 原有的 `single-thread-identity`、`single-thread-shell-identity`、`multi-bot` 等 golden 全都没动。

## 健康度

- `UserMessage` 的复杂度从 26 降到 25(上限 20,原本就超)。悬停栏挪进了 `user-message-rail.tsx`,`UserMessage` 只多了一行 hook 调用，换了一个词。
- 函数行数 220 不变;`user-message.tsx` 从 613 行变成 614 行。
- `python scripts/check --only health`:0 blocking。

## 测试

- `src/components/assistant-ui/thread/user-message-copy.test.tsx`,28 条:
  - 三种模式下悬停栏里有什么，以及最新一条运行中和已完成两种情况;
  - 只有图片的消息没有悬停栏;
  - 复制出来的文字，以及「已复制」反馈;
  - 用真 `AppContextMenu` 测右键「复制」;
  - 开发者模式、开关关时右键不出菜单;
  - 表情回应开时，右键仍是表情选择器;
  - 选了一部分字时，复制的是选中的部分;
  - 把真实的单线样式表注入页面后，算出来的 `user-select`;
  - 用能编辑的运行时测：没选字时单击会进编辑(对照),拖选后单击不进;
  - `copyableMessageText` 的 8 种输入。
- 全量:ui vitest 10804/10804,electron vitest 4186 通过(另有 25 条跳过),`npm run check:lint` 0 error。

## 反向验证(硬规则 14)

注入前先断言锚点只命中 1 次;每次跑两份测试(`user-message-copy`、`user-message-identity`),记下真实失败的用例，再按 sha256 还原。脚本和输出在协调会话共享笔记 `hc-1101-inject.py` / `hc-1101-inject-output.json`。

| # | 注入 | 结果 | 变红的用例(节选) |
|---|---|---|---|
| I1 | 删掉单线下「字能选中」那条样式 | 红 1 条 | selecting what you sent single-thread mode: the bubble text is user-se |
| I2 | 「复制」在所有模式都出 | 红 11 条 | single_thread off: the user rows are unchanged product mode, while the; single_thread off: the user rows are unchanged developer mode, while t |
| I3 | 「复制」永远不出 | 红 3 条 | the hover rail beside your bubble single-thread mode (running false): ; the hover rail beside your bubble single-thread mode (running true): [ |
| I4 | 复制原文(引用写法漏出去) | 红 7 条 | the hover rail beside your bubble copies the message as the bubble sho; a plain right-click on your bubble opens the app menu in single-thread |
| I5 | 代码块里的引用也被改写 | 红 1 条 | copyableMessageText: your message as the bubble shows it a fenced bloc |
| I6 | 右键「复制」在所有模式都出 | 红 2 条 | a plain right-click on your bubble opens nothing in developer mode, as; a plain right-click on your bubble opens nothing in off mode, as befor |
| I7 | 右键「复制」永远不出 | 红 1 条 | a plain right-click on your bubble opens the app menu in single-thread |
| I8 | 气泡右键退回 main 的 undefined | 红 1 条 | a plain right-click on your bubble opens the app menu in single-thread |
| I9 | 悬停栏拿到空文字 | 红 3 条 | the hover rail beside your bubble single-thread mode (running false): ; the hover rail beside your bubble single-thread mode (running true): [ |
| I10 | 「复制」排到恢复/停止后面 | 红 11 条 | single_thread off: the user rows are unchanged product mode, while the; single_thread off: the user rows are unchanged developer mode, while t |
| I11 | 悬停栏空着也画出来 | 红 3 条 | the hover rail beside your bubble single-thread mode: a message that i; the hover rail beside your bubble developer mode: a message that is on |
| I12 | 只有图片的消息也出「恢复」 | 红 3 条 | the hover rail beside your bubble single-thread mode: a message that i; the hover rail beside your bubble developer mode: a message that is on |
| I13 | 拖选后松手照样进编辑(去掉选区保护) | 红 1 条 | selecting what you sent a drag that ends in a selection keeps it shut |
| I14 | 右键菜单复制未处理的原文 | 红 1 条 | a plain right-click on your bubble opens the app menu in single-thread |

14/14 红;还原后 33/33 绿,工作区干净。第一轮 I13 是绿的：测试用的运行时不支持编辑，所以有没有那条保护，点了都不会出编辑框。改成能编辑的运行时，并加了「没选字时点一下确实会进编辑」的对照，再跑全部 14 条。
