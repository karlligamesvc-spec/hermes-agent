# hc-1101 — 单线模式下，自己发的消息能复制;对话区细节和 Muse 对齐

## 范围

只改单线产品模式。开关关、开发者模式逐字节不变(见「身份层」)。

两轮需求:

1. 第一轮：人发的消息要能复制。Kael:「现在发送消息没办法复制」「muse里，现在人发的消息可以复制」。
2. 第二轮：和 Muse 逐项对比后，Kael 对清单定了「按建议做」。做了第 2、3、4、5、7、8、9、10 条。第 8 条 Kael 选了 B(「B 放在用时那行右边」),看过对比图后定稿(「可以」)。第 5 条是在二期 #517 进 main 之后做的。第 6、11、12 条不做，第 13 条另开票。

## 为什么原来复制不了

用户气泡整个是一个按钮(点一下进编辑),而 `styles.css` 让所有按钮里的字都选不中。所以:

- 选不中字;
- 悬停只有「恢复」;
- 表情回应关着时，右键什么都不出;
- 拖着想选字，松手那一下等于点击，直接打开编辑框。

## 改后

截图来自开发页面：临时 Vite 页渲染真实的 `Thread` 和 `AppContextMenu`,单线开、产品模式、中文，Electron 桥用替身。**不是打包产物。**

| 条目 | 改后的样子 | 截图 |
|---|---|---|
| 1 复制 | 悬停时气泡左边是「复制」「改一下」「从这条重来」(运行中最后一个是「停止」);点「复制」后图标变 ✓,提示「已复制」 | `03-after-rail.png` `06-after-copied.png` |
| 1 选中 | 字能拖选，选区是白色半透明底(深色模式同样);⌘C、右键「复制」复制选中的部分 | `04-after-drag-selected.png` `07-after-dark-selected.png` |
| 1 + 4 右键 | 没选字时右键气泡：顶上一行「今天 09:10」,下面「复制」,复制整条 | `05-after-right-click-time.png` |
| 2 改一下 | 单击气泡不再进编辑;点悬停栏的「改一下」才打开编辑框 | `03-after-rail.png` |
| 10 网址 | 网址是白色下划线链接，应用内浏览器打开，⌘ 点或中键点用系统浏览器;输入框写进去的引用仍是标签 | `10-links.png` |
| 3 从这条重来 | 确认框「从这条重新开始？/ 这条之后的对话会清掉，再重新回答这条。/ 取消 / 重新开始」 | `09-redo-dialog.png` |
| 9 重新回答 | 回复操作行最后一个按钮的提示是「重新回答」 | `11-reanswer.png` |
| 7 仍在发送中 | 网关 5 秒没接，最新那条下面写「仍在发送中」;接了就消失 | `12-still-sending.png` |
| 5 右键回复 | 右键 APEX 的回复，只出一行时间和「复制」,复制的是看到的回复(不带下一步按钮那块和交回摘要);选了字就复制选中的部分;转录区的空白处仍是外壳菜单 | `16-reply-right-click.jpg` |
| 8 操作行(B) | 「复制 / 朗读 / 重新回答」在「用时 · 看过程」那一行的右边;气泡到「用时」仍是 10px;没有「用时」那行的回复，按钮仍在最底下 | `13-action-row-hover.jpg` `14-action-row-rest.jpg` `15-action-row-failure-turn.jpg`(左边改前，右边改后) |

修前的样子:

- 悬停只有「恢复」,拖选什么都选不中(`01-before-hover-and-drag.png`);
- 右键什么都不出(`02-before-right-click.png`);
- 右键 APEX 的回复出的是外壳菜单(`08-reply-right-click-shell-menu.png`),对应第 5 条。

真 Chrome 里实测(Playwright + 系统 Chrome):

| 操作 | 修前 | 修后 |
|---|---|---|
| 拖选「发了，1.2 万播放，完播 18%」 | 选中 `""`,松手进编辑 | 选中整句，不进编辑 |
| 然后 ⌘C | 剪贴板没变 | 整句 |
| 单击气泡 | 进编辑 | 不进编辑;「改一下」进编辑 |
| 悬停的按钮 | 恢复检查点 | 复制、改一下、从这条重来 |
| 右键气泡 | 不出菜单 | 「今天 09:10 \| 复制」→ 整句 |
| 多行 + 代码 + 链接 + 文件引用，点「复制」 | — | `第一行：先跑 \`npm test\`\n第二行：参考 https://v.douyin.com/iRemix01/ 和 /Users/xiaoman/脚本 v2.md` |
| 回复的版式(第 8 条) | — | 左边线、宽度不变;气泡到「用时」10px;按钮和「用时」同一行，那一行不变高;没有「用时」那行的回复总高度不变 |

## 出口清单(硬规则 12)

| 东西 | 出口 | 本 PR |
|---|---|---|
| 人发的消息的文字 | 悬停「复制」、右键「复制」(没选字) | 新增(单线);都读 `messageText` → `copyableMessageText` |
| | 拖选后 ⌘C、右键「复制」(选了字) | 原有，单线下现在选得中 |
| | 编辑框、从这条重来 | 不变，读 `messageText` |
| 「恢复检查点」一类的词 | 悬停栏、确认框、版本切换、回复的「刷新」 | 全部经 `useThreadCopy` |
| 消息时间 | 用户气泡和 APEX 回复自己的右键、应用菜单的选中文字右键 | 都经 `menuCaptionFor`(`data-message-at` 只在单线下加) |
| APEX 回复的文字 | 复制按钮、朗读、右键「复制」(第 5 条) | 都读 `getMessageText`,也就是 R2 的 `visibleReplyText`;R2 的出口普查里已补上 |
| 发送失败的提示 | `submit.ts` 错误卡后面那一处 | 经 `notifyPromptFailed`,外加出口普查 |
| | `submit.ts` 另外两处(会话不可用) | 查过，不改：没有错误卡，弹窗是唯一的提示 |

`messageText` 在 hydration 时已经去掉附加的上下文和 `@image:` 行。二期 R2 合进来后，它还会去掉接力头;在和二期整摞的试合并上验证过。

## 身份层(硬规则 11)

- 第一个 commit 只有 `src/user-message-identity.test.tsx` 和 5 份 golden,是在干净的 fork main `784a824659` 上录的。之后每个 commit 都逐字节一致(`CI=true`;`TZ=UTC / Asia/Shanghai / America/Los_Angeles`)。
- 单线产品模式下有意变了的:
  - `__identity__/multi-bot/product-*.html` 重录了：回复上的「刷新」→「重新回答」,回复根节点多了 `data-context-menu-skip` 和 `data-message-at`(第 5 条);
  - 二期 R2 的 `__identity__/handoff-ui/product-thread.html` 合进 main 后重录，变化就是这一批单线的改动：普通气泡、复制 / 改一下、重新回答、时间属性、回复的跳过标记;在三个时区下都稳定;
  - hc-1059 的 `single-thread-chat.test.tsx` 改了三处:
    - 两处原来按「编辑消息」按钮找紫色气泡，现在按 `[data-user-bubble]` 找;
    - 版式测试改钉网格布局 B;
    - 另外新加一条：没有「用时」那行的回复，按钮在最底下。

## 健康度

- `UserMessage` 复杂度 26 → 25,没加分支。
- `submit.ts` 那个已到上限的回调一行没加。
- `python scripts/check --only health`:0 blocking。

## 反向验证(硬规则 14)

每条注入前先断言锚点只命中 1 次，跑五份测试:`user-message-copy`、`user-message-actions`、`user-message-identity`、hc-1059 的 `single-thread-chat`,以及开关关时回复那几份 golden(`single-thread-identity`)。记下真实失败的用例，再按 sha256 还原。这一轮是在合入 #517 的 main 上跑的。脚本和输出在协调会话共享笔记 `hc-1101-inject-4.py` / `hc-1101-inject-4-output.json`。

| # | 注入 | 结果 | 变红的用例(节选) |
|---|---|---|---|
| C1 | 删掉单线下「字能选中」那条样式 | 红 1 条 | selecting what you sent single-thread mode: the bubble tex |
| C2 | 「复制」在所有模式都出 | 红 9 条 | single_thread off: the user rows are unchanged product mod; single_thread off: the user rows are unchanged developer m |
| C3 | 「复制」永远不出 | 红 5 条 | your bubble is your words; 「改一下」 opens the editor single-t; the hover rail beside your bubble single-thread mode (runn |
| C4 | 复制原文(引用写法漏出去) | 红 7 条 | the hover rail beside your bubble copies the message as th; a plain right-click on your bubble opens the app menu in s |
| C5 | 代码块里的引用也被改写 | 红 1 条 | copyableMessageText: your message as the bubble shows it a |
| C6 | 右键「复制」在所有模式都出 | 红 2 条 | a plain right-click on your bubble opens nothing in develo; a plain right-click on your bubble opens nothing in off mo |
| C7 | 右键「复制」永远不出 | 红 2 条 | a plain right-click on your bubble opens the app menu in s; a hand-over never brings its header to the clipboard copie |
| C8 | 气泡右键退回 main 的 undefined | 红 2 条 | a plain right-click on your bubble opens the app menu in s; a hand-over never brings its header to the clipboard copie |
| C9 | 悬停栏拿到空文字 | 红 5 条 | your bubble is your words; 「改一下」 opens the editor single-t; the hover rail beside your bubble single-thread mode (runn |
| C10 | 悬停栏空着也画出来 | 红 3 条 | the hover rail beside your bubble single-thread mode: a me; the hover rail beside your bubble developer mode: a messag |
| C11 | 只有图片的消息也出「恢复」 | 红 3 条 | the hover rail beside your bubble single-thread mode: a me; the hover rail beside your bubble developer mode: a messag |
| C12 | 右键菜单复制未处理的原文 | 红 1 条 | a plain right-click on your bubble opens the app menu in s |
| E1 | 气泡又变回点了就编辑 | 红 3 条 | hc-1059 bubbles hold the words, and only the words your me; hc-1059 bubbles hold the words, and only the words your me |
| E2 | 「改一下」永远不出 | 红 3 条 | your bubble is your words; 「改一下」 opens the editor single-t; the hover rail beside your bubble single-thread mode (runn |
| E3 | 「改一下」点了不进编辑 | 红 1 条 | your bubble is your words; 「改一下」 opens the editor single-t |
| L1 | 网址不再是链接 | 红 1 条 | the web addresses you typed open single-thread mode: an ad |
| L2 | 所有模式都把网址做成链接 | 红 7 条 | single_thread off: the user rows are unchanged product mod; single_thread off: the user rows are unchanged developer m |
| L3 | 输入框写的引用被拆成第二个链接 | 红 2 条 | the web addresses you typed open single-thread mode: an ad; the web addresses you typed open splitLinks: a composer re |
| L4 | 句末句号算进网址 | 红 1 条 | the web addresses you typed open splitLinks: a trailing fu |
| W1 | 单线用词丢了 | 红 6 条 | your bubble is your words; 「改一下」 opens the editor single-t; starting over from a message, in plain words single-thread |
| W2 | 单线用词漏到所有模式 | 红 22 条 | single_thread off: the message area is unchanged a finishe; single_thread off: the message area is unchanged a running |
| W3 | 悬停栏「从这条重来」读成版本词 | 红 2 条 | starting over from a message, in plain words single-thread; the hover rail beside your bubble single-thread mode (runn |
| W4 | 确认按钮仍是「恢复并重新运行」 | 红 1 条 | starting over from a message, in plain words single-thread |
| W5 | 回复操作行仍是「刷新」 | 红 1 条 | the reply’s regenerate button single-thread mode: 重新回答 |
| T1 | 消息右键菜单没时间(用户气泡和回复共用) | 红 2 条 | a plain right-click on your bubble opens the app menu in s; a plain right-click on APEX’s reply single-thread mode: it |
| T2 | 选中文字右键菜单没时间 | 红 2 条 | a plain right-click on your bubble single-thread mode: wit; a plain right-click on APEX’s reply single-thread mode: wi |
| T3 | 时间属性在所有模式都加 | 红 13 条 | single_thread off: the message area is unchanged a finishe; single_thread off: the message area is unchanged a running |
| T4 | 「今天」「昨天」对调 | 红 8 条 | when a message was sent, on top of its menu zh Wed Oct 28 ; when a message was sent, on top of its menu zh Tue Oct 27  |
| T5 | 菜单不画时间 | 红 4 条 | a plain right-click on your bubble opens the app menu in s; a plain right-click on your bubble single-thread mode: wit |
| P1 | 右键回复的复制菜单在所有模式都出 | 红 9 条 | single_thread off: the message area is unchanged a finishe; single_thread off: the message area is unchanged a running |
| P2 | 右键回复的复制菜单永远不出 | 红 1 条 | a plain right-click on APEX’s reply single-thread mode: it |
| P3 | 回复根节点没有跳过标记(外壳菜单抢走右键) | 红 1 条 | a plain right-click on APEX’s reply single-thread mode: it |
| P4 | 右键回复复制原文(带下一步按钮那块) | 红 1 条 | a plain right-click on APEX’s reply single-thread mode: it |
| P5 | 回复根节点没有时间 | 红 2 条 | a plain right-click on APEX’s reply single-thread mode: it; a plain right-click on APEX’s reply single-thread mode: wi |
| P6 | 回复根节点没有右键处理 | 红 1 条 | a plain right-click on APEX’s reply single-thread mode: it |
| S1 | 「仍在发送中」立刻出 | 红 1 条 | 「仍在发送中」 under a send the gateway has not taken single-thre |
| S2 | 「仍在发送中」在所有模式都出 | 红 2 条 | 「仍在发送中」 under a send the gateway has not taken developer m; 「仍在发送中」 under a send the gateway has not taken off mode: n |
| S3 | 「仍在发送中」出在每一条下面 | 红 1 条 | 「仍在发送中」 under a send the gateway has not taken single-thre |
| S4 | 后来的锁也算到更早的消息头上 | 红 2 条 | 「仍在发送中」 under a send the gateway has not taken single-thre; 「仍在发送中」 under a send the gateway has not taken single-thre |
| S5 | 拿锁不发布 | 红 2 条 | 「仍在发送中」 under a send the gateway has not taken single-thre; 「仍在发送中」 under a send the gateway has not taken single-thre |
| S6 | 放锁不发布 | 红 1 条 | 「仍在发送中」 under a send the gateway has not taken single-thre |
| F1 | 单线下仍弹窗 | 红 1 条 | a failed send says so once single-thread mode: 0 toast bes |
| F2 | 所有模式都不弹窗 | 红 2 条 | a failed send says so once developer mode: 1 toast beside ; a failed send says so once off mode: 1 toast beside the er |
| F3 | submit.ts 退回原来的 notifyError | 红 1 条 | a failed send says so once submit.ts toasts a failed promp |
| R1 | 回复不是网格 | 红 1 条 | hc-1059 bubbles hold the words, and only the words 用时 · 看过 |
| R2 | 正文和过程区仍占位 | 红 1 条 | hc-1059 bubbles hold the words, and only the words 用时 · 看过 |
| R3 | 按钮另起一行(Kael 点名) | 红 1 条 | hc-1059 bubbles hold the words, and only the words 用时 · 看过 |
| R4 | 按钮挪回最底下(Kael 点名) | 红 1 条 | hc-1059 bubbles hold the words, and only the words 用时 · 看过 |
| R5 | 「用时」那行离开第一行 | 红 1 条 | hc-1059 bubbles hold the words, and only the words 用时 · 看过 |
| R6 | 没「用时」那行的回复把按钮挪到上面 | 红 1 条 | hc-1059 bubbles hold the words, and only the words a reply |
| R7 | 正文丢了缩进 | 红 1 条 | hc-1059 bubbles hold the words, and only the words 用时 · 看过 |
| B1 | 悬停栏样式把气泡也挪走 | 红 1 条 | selecting what you sent single-thread mode: the rail moves |
| B2 | 紫色气泡样式漏掉新气泡 | 红 1 条 | hc-1059 bubbles hold the words, and only the words your me |

53/53 红;还原后 104/104 绿，工作区干净。

前几轮发现的问题(都已修，后两轮全红):
- 第一轮「拖选后松手照样进编辑」没变红：测试用的运行时不支持编辑。改用能编辑的运行时，并加了「没选字时点一下确实会进编辑」的对照。
- 第二轮「仍在发送中出在每一条下面」(S3)没变红：测试里旧消息的时间写死成 09:00,结果取决于跑测试的钟点，「只看最新一条」这条规则从没被单独测到。改成两条消息都在锁之后发出、时间相对现在算。
