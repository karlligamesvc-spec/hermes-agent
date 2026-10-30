# hc-1123 — 单线产品模式收掉「项目」

## 范围

只在 `desktop_features.single_thread` 开、且不是开发者模式时生效。开关关闭和开发者模式的行为不变，由 golden 钉住。后端、Project / Workflow API 和已有数据都没动，所以可逆。

## 环境

全新沙箱里的 dev Electron：跑构建好的 `dist` 和这个 checkout 的真引擎。LLM、APEX 账号服务、Workflow 数据都是本地假的，没有真实账号，也没有付费请求。开关用 `APEXNODES_SINGLE_THREAD=1` 打开。机器是 Mac。

## 结果

| 步骤 | 做法 | 结果 |
|---|---|---|
| 账户菜单 | 点账户行 | 个人资料、设置、定时运行、连接助手、更早的对话、交付物、重新登录、退出登录。没有「项目」，其他项顺序不变 |
| 留下的项 | 逐个点 | `/profile`、`/settings`、`/cron`、`/assistant`、`/history`、`/deliverables` 都能打开，标题正确 |
| 路由 | 改 hash | `/projects`、`/projects?status=active#row`、`/projects/project-review`、`/projects/a%2Fb`、`/PROJECTS`、`/analysis` 都回 `/` |
| 没封的路由 | 改 hash | `/cron`、`/deliverables`、`/history`、`/assistant`、`/workflows` 都留在原地 |
| 深链 | `app.emit('open-url', …)` | `apexnodes://open/projects`、`apexnodes://open/projects/project-review`、`hermes://open/projects`、`hermes://open/projects/project-review` 都回 `/`；对照组 `apexnodes://open/cron` 打开 `/cron` |
| 前进后退 | `/cron` → `/projects` → 后退 → 前进 | 进 `/projects` 时被替换成 `/`，后退到 `/cron`，前进回 `/` |
| 连接助手 | 假数据里有运行中和待验收的项目 | 没有「查看项目」。点「品牌周报」打开运行抽屉，背景仍是连接助手，关掉回 `/assistant` |
| `/workflows` | 直接改路由 | 没有「我的项目」标签。保存的工作流是一行文字，不是按钮 |
| 未登录 | 真的退出登录后改路由 | `/projects`、`/projects/project-review`、`/analysis` 都回 `/`，显示登录页，不是空白页 |
| 升级 | `lastRoute` 写成 `/projects`，重开 | 落在对话 |
| 升级 | `lastRoute` 写成 `/projects/project-review`，重开 | 落在对话 |
| 开发者模式 | 开关开、开发者模式开、重开 | 恢复到 `/projects/project-review`，抽屉打开。菜单里有「项目」，在「设置」和「定时运行」之间。`/projects` 能打开 |
| 开关关闭 | `APEXNODES_SINGLE_THREAD=0`、重开 | 菜单和项目页同开发者模式 |
| 接口 | 产品模式全程记录假服务收到的 Workflow 请求 | 没有 `GET projects/<id>`，项目详情页一次都没挂载。到开发者模式才出现这个请求 |

## 截图

- [产品模式菜单](screenshots/product-menu.png)
- [产品模式连接助手](screenshots/product-assistant.png)
- [连接助手打开运行抽屉](screenshots/product-assistant-run-drawer.png)
- [直接打开 `/workflows`](screenshots/product-workflows-direct-route.png)
- [未登录时打开 `/projects`](screenshots/product-signed-out-on-projects.png)
- [记住的路由是 `/projects`，重开后的落点](screenshots/product-upgrade-landing.png)
- [开发者模式菜单](screenshots/developer-menu.png)
- [开关关闭时的菜单](screenshots/switch-off-menu.png)

开发者模式和开关关闭的项目页截图上有一行「暂时无法刷新最新状态」。那一页的代码和 golden 都没变，这里的假服务也没有实现所有接口，所以我判断是假数据造成的；没有在干净的 main 上跑同一个脚本对照。

## 证据的边界

- 没有跑打包产物，也没有用真实账号。
- 假服务的运行抽屉没有步骤和交付物，审阅、重试这些操作没有点过。
- 「升级」是直接写 `localStorage` 再重开模拟的，不是真的从旧版本升级。
- 深链是在主进程里发 `open-url`，没有经过操作系统派发。
- 插件通知点开（`activate`）和插件 `host.navigate` 没有在 App 里实际触发。这两条路最后都是 `navigate(path)`，靠路由门的单元测试和读代码确认。
- Windows 没测，它已经停在 0.17.66。
