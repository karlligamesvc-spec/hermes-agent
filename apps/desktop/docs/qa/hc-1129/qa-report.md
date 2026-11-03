# hc-1129 — 单线产品模式收掉「交付物」

## 范围

只在 `desktop_features.single_thread` 开、且不是开发者模式时生效。开关关闭和开发者模式的行为和文字都不变，由 golden 钉住。后端、Workflow API 和已有数据都没动。

## 环境

全新沙箱里的 dev Electron：跑这个 PR 构建出来的 `dist` 和这个 checkout 的真引擎。LLM、APEX 账号服务、Workflow 数据都是本地假的，没有真实账号，也没有付费请求。假服务可以切成生产对未开通账号的回答：所有 `/workflow-domain/*` 都回 404 `workflow_domain_not_allowlisted`。

## 产品模式的结果

| 步骤 | 做法 | 结果 |
|---|---|---|
| 账户菜单 | 点账户行 | 个人资料、设置、定时运行、连接助手、更早的对话、重新登录、退出登录。没有「交付物」，其他项顺序不变 |
| 留下的项 | 逐个点 | `/profile`、`/settings`、`/cron`、`/assistant`、`/history` 都能打开，标题正确 |
| 封掉的路由 | 改 hash | `/deliverables`、`/deliverables?kind=report#row`、`/deliverables/`、`/deliverables/deliverable-1`、`/deliverables/deliverable-1?from=link#top`、`/deliverables/a%2Fb`、`/deliverables/a/b`、`/DELIVERABLES`、`/Deliverables/deliverable-1` 都回 `/` |
| 没封的路由 | 改 hash | `/cron`、`/assistant`、`/history`、`/artifacts` 都留在原地 |
| 深链 | 主进程发 `open-url` | `apexnodes://open/deliverables`、`apexnodes://open/deliverables/deliverable-1` 和对应的 `hermes://` 都回 `/`；对照组 `apexnodes://open/assistant` 打开连接助手 |
| 前进后退 | `/cron` → `/deliverables` → 后退 → 前进 | 进 `/deliverables` 时被替换成 `/`，后退到 `/cron`，前进回 `/` |
| 连接助手（有数据） | 假数据里有运行中、待验收、失败三种项目 | 小节是消息渠道、正在运行、需要处理。没有「最近交付」和「查看交付物」。待验收的「品牌周报」不是一行，失败的「竞品监控」是一行 |
| 连接助手（生产 404） | 假服务回 `workflow_domain_not_allowlisted` | 只有消息渠道一节，没有错误文字。这一页只发一次 `access`，`desktop.log` 只多一行 `not_enabled`。改之前是两次读取（项目和交付物），「最近交付」显示「暂时无法读取账号数据，请从对应页面重试。」，旁边的「查看交付物」通向故障页 |
| 运行抽屉 | 打开待验收、运行中、失败三种运行 | 没有「需要审阅」「交付物与审阅」，也没有批准、打开交付物、要求修改。保留状态、进展和执行详情，运行中的保留「取消运行」。关掉回 `/assistant` |
| 未登录 | 真的退出登录后改路由 | `/deliverables`、`/deliverables/deliverable-1` 都回对话路由，显示登录页，不是空白页 |
| 升级 | `lastRoute` 写成 `/deliverables`、`/deliverables/deliverable-1`，重开 | 先是连接动画，约 4 到 5 秒后都落在对话 |
| 接口 | 产品模式全程记录假服务收到的 Workflow 请求 | 只有 `access`、`projects`、`runs/<id>`。没有 `deliverables` |

### 英文（产品模式）

菜单是 Profile、Settings、Scheduled runs、Connect assistants、Earlier conversations、Sign in again、Sign out。连接助手的小节是 Messaging channels、Running now、Needs attention，说明是 See and connect your messaging channels.。

## 收掉之后，做好的视频和文档在哪里

让假 LLM 用真实回复的写法（`MEDIA:<路径>` 单独一行，和 hc-1126 记录的回复一样）交付一条视频、一份 docx、一份 pdf，再写一条只给路径的视频。

| 去哪里找 | 视频 | docx | pdf | 备注 |
|---|---|---|---|---|
| 对话里的卡片 | 有播放器 | 有「下载」「打开预览」 | 有「下载」「打开预览」 | 视频卡片这版没有下载按钮，只能点播放器的 ⋮（hc-1126），hc-1130 在改 |
| ⌘K →「产物」（`/artifacts`） | 有 | **没有** | 有 | `artifact-utils.ts` 的文件后缀表里没有 docx。这一页只能从 ⌘K 进，菜单里没有入口。中文标题还叫「交付物」 |
| 只写了路径的文件 | 在对话里是一段路径文字 | | | 产物页能列出来 |
| 更早的对话 | 换过对话后回去翻 | 同左 | 同左 | |
| 磁盘 | 工具生成的在 `<引擎目录>/cache/media`，让助手放到文件夹里的在那个文件夹 | `<引擎目录>/cache/documents` 或那个文件夹 | 同左 | App 里没有打开这些文件夹的入口。多助手模式下删掉助手，它这台电脑上存的图片和视频会一起删掉 |

这张票不做新页面。产物页的 docx、标题和入口要另外定。

## 全屏字样扫描

在产品模式能到的每一页，扫一遍可见文字和 `aria-label`、`placeholder`、`title`、`alt`，找「交付」「deliverable」。

没有扫到的页面：对话、定时运行、连接助手、更早的对话、运行抽屉（待验收和失败）、个人资料、IM 入口、账户菜单、⌘K、设置的 8 个分区。

只扫到一处：`/artifacts` 的中文标题「交付物」。这是 ⌘K「产物」打开的上游页面，这次不动。

## 开发者模式和开关关闭的结果

| 步骤 | 开发者模式 | 开关关闭 |
|---|---|---|
| 记住的路由是 `/deliverables` | 重开后恢复到 `/deliverables` | 同左 |
| 菜单 | 个人资料、设置、项目、定时运行、连接助手、历史会话、交付物、重新登录、退出登录 | 同左 |
| 交付物列表 | 能打开，点一行打开详情，关掉回列表 | 同左 |
| 连接助手 | 有最近交付和查看交付物，待验收的项目是一行 | 同左 |
| 运行抽屉 | 有需要审阅、批准交付物、打开交付物、要求修改，打开后到详情 | 同左 |

开发者模式和开关关闭的页面上有一行「暂时无法刷新最新状态」。那些页面的代码和 golden 都没变，这里的假服务也没有实现所有接口，所以我判断这是假服务的问题。

## 截图

产品模式：

- [账户菜单](screenshots/product-menu.png)
- [连接助手，有 Workflow 数据](screenshots/product-assistant.png)、[连接助手，生产的 404](screenshots/product-assistant-not-enabled.png)
- [待验收的运行抽屉](screenshots/product-run-drawer-review.png)、[失败的运行抽屉](screenshots/product-run-drawer-failed.png)
- [未登录时打开 `/deliverables`](screenshots/product-signed-out-on-deliverables.png)
- [记住的路由是 `/deliverables/<id>`，重开时的连接动画](screenshots/product-upgrade-connecting.png)、[之后的落点](screenshots/product-upgrade-landing.png)
- [对话里的视频和文档卡片](screenshots/product-chat-results.png)、[产物页，没有 docx](screenshots/product-artifacts.png)

英文：

- [菜单](screenshots/en-product-menu.png)、[连接助手](screenshots/en-product-assistant.png)

没有变化的一侧：

- [开发者模式菜单](screenshots/developer-menu.png)、[开发者模式的运行抽屉](screenshots/developer-run-drawer.png)、[开发者模式的连接助手](screenshots/developer-assistant.png)
- [开关关闭的菜单和交付物页](screenshots/switch-off-menu.png)、[开关关闭的运行抽屉](screenshots/switch-off-run-drawer.png)

## 证据的边界

- 没有跑打包产物，也没有用真实账号。
- 「升级」是直接写 `localStorage` 再重开模拟的，不是真的从旧版本升级。
- 深链是在主进程里发 `open-url`，没有经过操作系统派发。
- 插件通知点开（`activate`）和插件 `host.navigate` 没有在 App 里实际触发。这两条路最后都是 `navigate(path)`，靠路由门的单元测试和读代码确认。
- 生产的 404 是假服务按代码模拟的，没有连生产。`not_enabled` 的来源是读代码和 hc-1126 的 `desktop.log` 得出的，没有登录服务器看 `.env`。
- 视频卡片用的是仓库里的测试 webm，docx 和 pdf 是假文件，「打开预览」和「下载」没有点。
- 待验收的运行不能在产品模式里处理，这条只在单元测试和开发者模式的对照里验过，没有用真实的运行数据。
- 繁体、日文、阿拉伯文的新说明是我写的，只有单元测试扫过，没有在 App 里看，也没有请人校对。
- Windows 没测，它已经停在 0.17.66。
