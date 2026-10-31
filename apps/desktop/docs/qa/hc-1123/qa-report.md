# hc-1123 — 单线产品模式收掉「项目」和「工作流」，选择器改叫文件夹

## 范围

只在 `desktop_features.single_thread` 开、且不是开发者模式时生效。开关关闭和开发者模式的行为和文字都不变，由 golden 钉住。后端、Project / Workflow API 和已有数据都没动，所以可逆。

## 环境

全新沙箱里的 dev Electron：跑这个 PR 构建出来的 `dist` 和这个 checkout 的真引擎。LLM、APEX 账号服务、Workflow 数据都是本地假的，没有真实账号，也没有付费请求。开关用 `APEXNODES_SINGLE_THREAD=1` 打开。机器是 Mac。

## 产品模式的结果

| 步骤 | 做法 | 结果 |
|---|---|---|
| 账户菜单 | 点账户行 | 个人资料、设置、定时运行、连接助手、更早的对话、交付物、重新登录、退出登录。没有「项目」，其他项顺序不变 |
| 留下的项 | 逐个点 | `/profile`、`/settings`、`/cron`、`/assistant`、`/history`、`/deliverables` 都能打开，标题正确 |
| 封掉的路由 | 改 hash | `/projects`、`/projects?status=active#row`、`/projects/project-review`、`/projects/a%2Fb`、`/PROJECTS`、`/workflows`、`/workflows?projectId=project-review`、`/WORKFLOWS`、`/analysis` 都回 `/` |
| 没封的路由 | 改 hash | `/cron`、`/deliverables`、`/history`、`/assistant` 都留在原地 |
| 深链 | `app.emit('open-url', …)` | `apexnodes://open/projects`、`apexnodes://open/projects/project-review`、`apexnodes://open/workflows`，以及对应的 `hermes://` 都回 `/`；对照组 `apexnodes://open/cron` 打开 `/cron` |
| 前进后退 | `/cron` → `/projects` → 后退 → 前进 | 进 `/projects` 时被替换成 `/`，后退到 `/cron`，前进回 `/` |
| 连接助手 | 假数据里有运行中和待验收的项目 | 小节是消息渠道、正在运行、需要处理、最近交付。没有「查看项目」。点「品牌周报」打开运行抽屉，背景仍是连接助手，关掉回 `/assistant` |
| 没有来源的运行抽屉 | 直接打开 `/workflow-runs/run-review`，和 `apexnodes://open/workflow-runs/run-review` | 抽屉打开，垫在下面的是连接助手，关掉回 `/assistant` |
| 文件夹选择器 | 点按钮、看列表、用真实鼠标点「新建空白文件夹…」 | 按钮和提示都是「选择文件夹」，占位是「搜索文件夹…」「文件夹名称」，标题是「新建文件夹」 |
| 交付物 | 列表、详情 | 说明是「查看、验证并确认 APEX 做好的成果。」。详情的字段是工作流、关联运行、创建时间、更新时间，没有「所属项目」。抽屉关掉回 `/deliverables` |
| 未登录 | 真的退出登录后改路由 | `/projects`、`/projects/project-review`、`/workflows`、`/analysis` 都回 `/`，显示登录页，不是空白页 |
| 升级 | `lastRoute` 写成 `/projects`、`/projects/project-review`、`/workflows`，重开 | 都落在对话 |
| 接口 | 产品模式全程记录假服务收到的 Workflow 请求 | 只有 `access`、`projects`（连接助手的只读列表）、`deliverables`、`deliverables/<id>`、`runs/<id>`。没有 `projects/<id>`、`workflows`、`catalog`，也就是项目详情页和工作流页一次都没挂载 |

### 英文（产品模式）

菜单是 Profile、Settings、Scheduled runs、Connect assistants、Earlier conversations、Deliverables、Sign in again、Sign out。按钮和提示是 Choose folder，占位是 Folder name。连接助手的小节是 Messaging channels、Running now、Needs attention、Recent deliverables。交付物说明是 Review, verify, and approve what APEX has made.，详情没有 Project 字段。这几页扫不到 Project 或 Hermes。

## 全屏字样扫描

在产品模式能到的每一页，扫一遍可见文字和 `aria-label`、`placeholder`、`title`、`alt`，找「项目」「專案」「project」「プロジェクト」「Hermes」。

没有扫到的页面：对话、定时运行、连接助手、更早的对话、交付物列表和详情、个人资料、IM 入口、账户菜单、⌘K、文件夹选择器的列表和新建表单，设置的个性化、记忆、语音、连接微信和飞书、用量、关于。

还扫到的，这次都没改：

| 位置 | 文字 | 谁看得到 |
|---|---|---|
| 运行抽屉「执行器」 | Hermes | 账号里有运行中或待处理的旧数据 |
| 运行抽屉「交付物与审阅」空状态 | Hermes 完成工作并保存结果后，交付物会出现在这里。 | 同上 |
| 设置 › 通知 | A desktop plugin sent a notification while Hermes was in the background.（中文界面也是英文） | 所有人 |
| 设置 › 外观 | iMessage-style emoji tapbacks — react to messages, and Hermes can react to yours.（中文界面也是英文） | 所有人 |
| 设置 › 外观 | `~/project git:main ❯`（终端主题预览里的示例） | 所有人 |

读代码还看到，运行抽屉的「执行详情」标签里有两条事件文字带 Hermes：「已请求 Hermes 执行」「APEX / Hermes 使用了工具，参数和结果已隐藏。」。这个标签这次没有点开。

## 开发者模式和开关关闭的结果

| 步骤 | 开发者模式 | 开关关闭 |
|---|---|---|
| 菜单 | 有「项目」，在「设置」和「定时运行」之间 | 同左 |
| `/projects`、`/projects/project-review` | 能打开 | 能打开 |
| `/workflows` | 能打开，带「我的项目 \| 工作流库」标签 | 能打开 |
| 没有来源的运行抽屉 | 垫 `/workflows`，关掉回 `/workflows` | 没有在 App 里点，golden 钉着 |
| 交付物说明 | 还是「查看、验证并确认 Hermes 为真实项目生成的业务成果。」 | 同左 |
| 交付物详情 | 有「所属项目」 | 没有在 App 里点，golden 钉着 |
| 对话框上方的按钮 | 还是「选择项目」 | 没有在 App 里点，golden 钉着 |

## 截图

产品模式：

- [菜单和选择文件夹按钮](screenshots/product-menu.png)
- [选择器的列表](screenshots/product-folder-chip-list.png)、[新建表单](screenshots/product-folder-chip-new.png)
- [连接助手](screenshots/product-assistant.png)、[打开运行抽屉](screenshots/product-assistant-run-drawer.png)、[没有来源的运行抽屉](screenshots/product-run-drawer-no-source.png)
- [交付物](screenshots/product-deliverables.png)、[交付物详情](screenshots/product-deliverable-detail.png)
- [未登录时打开 `/workflows`](screenshots/product-signed-out-on-workflows.png)
- [记住的路由是 `/projects`，重开后的落点](screenshots/product-upgrade-landing.png)

英文：

- [菜单](screenshots/en-product-menu.png)、[选择器的列表](screenshots/en-product-folder-chip-list.png)、[新建表单](screenshots/en-product-folder-chip-new.png)、[交付物](screenshots/en-product-deliverables.png)

没有变化的一侧：

- [开发者模式菜单](screenshots/developer-menu.png)、[开发者模式的 `/workflows`](screenshots/developer-workflows.png)、[开发者模式的「选择项目」](screenshots/developer-chip.png)、[开关关闭时的菜单](screenshots/switch-off-menu.png)

开发者模式和开关关闭的项目页截图上有一行「暂时无法刷新最新状态」。那一页的代码和 golden 都没变，这里的假服务也没有实现所有接口，所以我判断是假数据造成的；没有在干净的 main 上跑同一个脚本对照。

## 证据的边界

- 没有跑打包产物，也没有用真实账号。
- 假服务的运行抽屉没有步骤和交付物，审阅、重试这些操作没有点过。
- 「升级」是直接写 `localStorage` 再重开模拟的，不是真的从旧版本升级。
- 深链是在主进程里发 `open-url`，没有经过操作系统派发。
- 插件通知点开（`activate`）和插件 `host.navigate` 没有在 App 里实际触发。这两条路最后都是 `navigate(path)`，靠路由门的单元测试和读代码确认。
- 选择器的系统文件夹对话框标题和创建失败提示，只在单元测试里验过，没有在 App 里触发。
- 繁体、日文、阿拉伯文的新文字只有单元测试扫过，没有在 App 里看，也没有请人校对。
- 字样扫描只看到页面当时的状态。交付物读取失败、运行失败这些状态没有在 App 里触发。
- Windows 没测，它已经停在 0.17.66。
