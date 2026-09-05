# hc-816 APEX Desktop Phase 1 UI 评审记录

## 范围与基线

- 评审范围：开始、项目、工作流三页，以及三页共用的 Phase 1 页头和工作流入口组件。
- 唯一代码基线：`50b79e29ea140a636cea74a6260aa8ee85a468fc`（#256 HEAD，已包含 #254 → #255 → #256）。
- 版本：`0.17.24`。
- 工作树：`/Users/karl/projects/.wt/apex-desktop-ui-phase1-review-50b79e2`。
- 分支：`codex/hc-816-desktop-ui-phase1-visual`。
- 未修改 #254/#255/#256 原分支，未合并、未发布、未部署、未更新 updater feed。

## 批准的视觉依据

- [开始页原型](reference/home-centered-1235x1024.png)
- [项目页原型](reference/projects-complete-1235x1024.png)
- [工作流页原型](reference/workflows-complete-1235x1024.png)
- `APEX-DESKTOP-UI-REDESIGN-SPEC-2026-09.md`
- `APEX-DESKTOP-UI-REDESIGN-IMPLEMENTATION-2026-09.md`

## 逐页结论

### 开始页

- 保留中心化的目标输入与真实 `startGoal` / chat fallback，收紧输入区高度和上下留白。
- 将首屏固定为三条重点业务路径，改为紧凑横向卡片；700px 下自动单列并保持可滚动。
- “最近项目”仅读真实 Project bridge；不再把 session/task/artifact 重命名成项目。项目服务不可用时显示明确生命周期文案。
- “可用数据源”仅显示当前 bridge 证明可用的渠道，不伪造数量或连接状态。

### 项目页

- 增加与原型对齐的页头、新建项目入口、全部/进行中/已完成筛选和真实总数。
- 列表收口为同一圆角容器，状态、更新时间和点击入口形成清晰层级。
- `stepTotal === 0` 时只显示生命周期文案，不显示 `0 / 0`；`deliverableCount === 0` 时不显示伪成果计数。
- 加载、空、失败和 domain 不可用均保留独立、诚实的界面状态。

### 工作流页

- 三条重点路径使用大卡片，其他三条路径使用紧凑卡片，层级与批准原型一致。
- 用户选中模板后返回开始页，目标预填并保持可编辑。
- 路由状态同时保留服务端 template id / slug / version；用户编辑目标不会把 version 回退到内置值。
- “我的工作流”仅显示 bridge 返回的真实条目；本地评审条目均带 `[本地测试]` 标记。

## 视口矩阵

Playwright 通过 Electron CDP 把 renderer 固定为下列 CSS viewport，并对每页断言无水平溢出。700px 用例还会滚动到页面底部内容，再返回页头，证明滚动路径可用。macOS 原生窗口外框受当前 work area 限制时，1440×900 的外框可被系统夹到 876px 高；评审截图仍使用精确 renderer viewport。

| 页面   | 1440×900 Before / After                                                                                 | 1220×800 Before / After                                                                                 | 700×800 Before / After                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 开始   | [Before](screenshots/before/start-1440x900.png) / [After](screenshots/after/start-1440x900.png)         | [Before](screenshots/before/start-1220x800.png) / [After](screenshots/after/start-1220x800.png)         | [Before](screenshots/before/start-700x800.png) / [After](screenshots/after/start-700x800.png)         |
| 项目   | [Before](screenshots/before/projects-1440x900.png) / [After](screenshots/after/projects-1440x900.png)   | [Before](screenshots/before/projects-1220x800.png) / [After](screenshots/after/projects-1220x800.png)   | [Before](screenshots/before/projects-700x800.png) / [After](screenshots/after/projects-700x800.png)   |
| 工作流 | [Before](screenshots/before/workflows-1440x900.png) / [After](screenshots/after/workflows-1440x900.png) | [Before](screenshots/before/workflows-1220x800.png) / [After](screenshots/after/workflows-1220x800.png) | [Before](screenshots/before/workflows-700x800.png) / [After](screenshots/after/workflows-700x800.png) |

## 数据真值说明

| 界面数据                      | 评审包中的来源                                            | 产品表达                                           |
| ----------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Project 列表和状态            | 本地 HTTP 测试 API，按真实 Project bridge 结构返回        | 项目名显式加 `[本地测试]`                          |
| Workflow catalog / 我的工作流 | 本地 HTTP 测试 API，按真实 catalog/list bridge 结构返回   | 存储的工作流加 `[本地测试]`；页面显示本地评审提示  |
| 目标执行                      | 真实 `startGoal` 桥接；domain 暗开时使用现有 chat gateway | 不伪造运行进度                                     |
| 数据源                        | 现有渠道 bridge 的可用/绑定状态                           | 无 bridge 时显示不可用文案，不伪造来源数量         |
| 无真实 Step / Deliverable     | 数值为 0                                                  | 显示生命周期文案，不显示伪步骤、伪百分比或伪产出数 |

## 保留的行为契约

- 真实 `startGoal` 与 chat fallback。
- Project/Workflow 真实 API bridge。
- 目标编辑后 template id/version 不丢失。
- 创建失败时保留草稿和附件。
- APEX 身份层、默认中文、Profile 现有用量表面。
- Hermes 为唯一生产 executor，不提供 DSH 选择器。

## 未越界处理的差异

- 现有共享 shell 仍显示上游 `SESSIONS / BOTS` 顶栏，且未在侧栏顶部显示原型中的 APEX Logo。这些属于全局 shell / 助手与历史表面，本轮未扩大到 Phase 2/3。
- 原型的固定 1080px body 最小宽度、8–10px 小字号、模拟百分比/步骤/来源数都没有复制。
- 未实现 Run 双页签、Deliverable/Review 新页、定时运行重构、助手/历史新页、Profile/Settings 重做或 Phase 2 API。

## 反向验证

| 注入的回归                            | 必须变红的守卫                                                     | 结果                               |
| ------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| Start 卡片从 `shelf` 改回 `featured`  | `keeps Start scoped to three recommended paths...`                 | 失败：期望 3 个 `shelf`，实际 0    |
| 忽略路由传入的 template version       | `retains the routed catalog template id and version...`            | 失败：期望 version 7，实际回退为 1 |
| 将 Step 显示条件改为 `stepTotal >= 0` | `filters only real Project rows and hides zero deliverable counts` | 失败：界面出现 `0 / 0 步`          |

三个回归均已撤回，守卫恢复绿色。
