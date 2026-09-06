# hc-816 APEX Desktop Phase 1 UI 评审记录

## 范围与基线

- 评审范围：开始、项目、工作流三页，以及三页共用的 Phase 1 导航、目标输入、Project 详情抽屉与工作流入口组件。
- 唯一代码基线：`50b79e29ea140a636cea74a6260aa8ee85a468fc`（#256 HEAD，已包含 #254 → #255 → #256）。
- Draft PR：#261；分支：`codex/hc-816-desktop-ui-phase1-visual`；版本：`0.17.24`。
- 隔离工作树：`/Users/karl/projects/.wt/apex-desktop-ui-phase1-review-50b79e2`。
- 未修改 #254/#255/#256 原分支，未合并、未发布、未部署、未更新 updater feed，未进入 Phase 2。

## 批准的视觉依据

- [开始页原型](reference/home-centered-1235x1024.png)
- [项目页原型](reference/projects-complete-1235x1024.png)
- [工作流页原型](reference/workflows-complete-1235x1024.png)
- `APEX-DESKTOP-UI-REDESIGN-SPEC-2026-09.md`
- `APEX-DESKTOP-UI-REDESIGN-IMPLEMENTATION-2026-09.md`

## Kael 实包反馈修正

### 窄窗一级导航覆盖层收口

- 已逐项核对 7 个一级导航出口：开始、项目、工作流、定时运行、交付物、助手、历史；它们全部从 `ChatSidebar` 的原生 button 进入共享 `selectSidebarItem` 路径。
- `640–899px` 窄窗中，用户展开覆盖式侧栏并激活任一一级导航后，页面完成导航并立即收起覆盖层；鼠标点击和键盘 Enter 激活使用同一行为。
- 关闭动作只发送窄窗覆盖层的显式 `close` 事件，不写入持久化 pane `open` 状态；`900px` 及以上宽窗点击导航后仍保留完整侧栏和用户原有开关偏好。
- 两个覆盖层事件消费者均已核对：现行 tree renderer 和兼容 Pane 都按 `open` / `close` / `toggle` 处理，重复 `close` 保持关闭，不会把旧壳的侧栏反向打开。
- 真实 `752×800` Electron `BrowserWindow` 对 7 个出口逐一开栏、导航、关栏，并以“工作流”的键盘 Enter 激活覆盖键盘路径；再切回 `1220×800` 验证侧栏保持。
- 本项只修改共享导航/布局 seam 及其测试标记，没有修改业务数据、API bridge、APEX 身份、Hermes-only 或 DSH 边界。

### `0830bf0` 二次实包复验

- Kael 在默认真实登录态确认 Start 单输入、752px 窄窗、中文状态、描述去重和 APEX 辅助功能身份均已修好。
- 同次复验发现生产 hc-795 旧 Project envelope 不含 `summary` 时，React Compiler 会把详情页回调中的非空断言提前求值为无条件 `summary.currentRunId`，导致 workspace 崩溃。
- 详情页现先把可选 summary 归一化为安全的 `currentRunId` 标量；summary 缺失时展示“运行摘要暂时不可用”，仍允许用户显式“继续这个目标”，不伪造 Run 或进度。
- Workflow 不可用态移除会误导用户自行排查本机连接的“检查连接”；生产 404 的恢复动作收敛为“重试”和“返回开始页”。
- 本地 packaged E2E 的 Project fixture 已改为生产旧 envelope 形状（列表和详情均无 summary），确保优化后的实际 renderer bundle 也守住该路径。

### Start 只有一个输入

- Start 的“业务目标”成为该页面唯一可见、可聚焦、可由辅助功能识别的 textbox。
- 页面停留在 Start 零态时，旧全局 Chat composer 不挂载；不是透明、遮挡或移出屏幕。
- 普通 Session、目标启动后的对话、Project 详情和 Workflow Run 对象页仍保留全局 composer，用于追问、补资料与干预。
- 继续保留真实 `startGoal`、chat fallback、template id/version、失败草稿/附件和 Hermes-only 语义。

### 窄窗与原生窗口

- Phase 1 完整侧栏在 `640–899px` 自动收起，titlebar 保留“显示侧边栏”按钮。
- 原生 Electron `BrowserWindow.setBounds` 实测 `1440×900`、`1220×800`、`752×800`；不再使用 CDP renderer viewport 代替窗口验证。
- 三页均无 document 横向溢出；752px 可滚动到最后一项并完整回到页头。
- macOS titlebar 的侧栏入口横坐标不小于 70px，避开 traffic lights。
- 有全局 composer 的 752px Session 滚到底后，最后一条 assistant message 完整位于 composer 上方，并存在真实 clearance spacer。

### Project 点击语义

- 所有 Project 行先进入 Project 详情抽屉，不再因没有 `currentRunId` 直接回到 Start。
- 详情通过现有 Project detail API bridge 读取真实项目；有真实 Run 才显示“打开当前运行”。
- 无 Run 时显示诚实空态和“继续这个目标”；只有用户点击该按钮后才回到 Start 并预填 objective。
- Project name 与 objective 完全相同时不重复描述；不显示伪 Run、Step、Deliverable、百分比或待处理事项。

### Workflows 恢复与确认

- 真实 catalog 不可用/失败时，不再回退展示内置模板；提供“重试”和“返回开始页”两个可执行动作。
- 页面只展示真实 catalog 返回并能映射到 Phase 1 路径的模板。
- catalog version 明确含 local/test/staging/review 时显示“本地测试数据”状态提示，不把测试模板冒充生产数据。
- 已走通：模板列表 → 选择模板 → Start 目标可编辑 → 启动前确认；确认区显示服务端 template version 和 Hermes executor。
- 没有 DeepSeek Harness 选择器或已接入声明。

### Phase 1R2 产品审计 P0 收口

- 从工作流确认页选择“更换工作流”，再从工作流页进入“开始一个目标”时，Start 的每次新导航都会清除旧 template id/version、catalog provenance、旧目标和错误状态。普通自由目标不再构造虚假的 `desktop-goal` 模板，也不会因 Workflow API 可用而误调用 `startGoal`；它稳定走现有 chat fallback。
- 只有用户明确选择真实 catalog 模板时才保留 template id/version 并调用真实 `startGoal`。创建失败仍保留可编辑目标与附件；本地 catalog 的“本地测试数据”来源标记会随模板进入启动确认，生产 provenance 不显示测试标签。
- Desktop version IPC 改以 Electron `app.getVersion()` 为应用版本单一事实源，引擎版本单独展示；Mac `afterPack` 同时核验 package version、builder runtime appInfo、`CFBundleShortVersionString` 和 `CFBundleVersion`，任一不一致即阻止产包。
- Settings 更新状态改为诚实状态机：未检查提示用户检查，检查中不显示旧“最新”，网络/检查失败显示不可达；只有一次成功且明确无更新的检查才显示“你已是最新版本”。
- Browser 布尔开关、BOTS activity-toast 控件补上中文可访问名称和 pressed 状态；Phase 1 必经的 assistant 错误恢复动作完成中文化。
- 752px 下，普通 Bot 行和 Group Chat 行的鼠标/键盘选择都会显式关闭窄窗覆盖侧栏；宽窗持久侧栏偏好不受影响。
- 已盘点文件树和 Terminal 的全部可达出口（titlebar、command/keybind、pane focus、statusbar、文件/Review 上下文动作、Terminal 新建/页签）。当前代码没有稳定的 APEX/customer-build 产品 gate；本轮没有临时硬编码关闭这些共享壳能力，作为独立产品决策保留，不借 Phase 1 扩大改造边界。

### 文案与辅助功能

- 中文 `active` 统一显示“进行中”，并补齐 archived/completed 等生命周期映射。
- `Wake word: "hey hermes"` 辅助名称已改为 APEX voice activation 身份文案。
- 守卫覆盖按钮名称、Start Tab 顺序、可编辑状态、Project 空态焦点入口和不可用 catalog 的可感知恢复操作。

## 与批准原型的逐页差异

### 开始页

- 保留原型的中心目标输入、三条重点路径、最近项目和数据源两栏层级；实包只保留一个主输入。
- 原型中的模拟 68% 进度和固定来源数量没有复制：最近项目显示真实生命周期，数据源只显示 bridge 可证明的状态。
- 1220×800 下信息密度更紧，以适配真实 macOS titlebar 和既有共享 shell。

### 项目页

- 保留原型的页头、筛选、统一列表容器、状态和时间层级。
- 原型的模拟阶段条和成果数没有复制；只有真实 Step/Deliverable 非零时才呈现。
- 本轮新增 Project 详情抽屉，承接“查看项目”语义；没有 Run 时使用生命周期空态。

### 工作流页

- 保留三条重点路径和紧凑的其他路径；目标从模板预填后仍可编辑。
- 实包完整态来自可控本地 catalog，页面和截图均显式标注本地测试数据。
- 原型没有覆盖的 catalog 故障态增加了重试和返回 Start，不使用本地模板伪装成功态。

### 仍保留的共享 shell 差异

- 既有共享 shell 仍显示 `SESSIONS / BOTS` 顶栏，侧栏顶部也尚未替换成原型的 APEX Logo。
- 这些出口属于全局壳、助手/历史表面，本轮不扩大到 Phase 2；Phase 1 内容区已保持 APEX 中文、品牌紫色、圆角、卡片与间距体系。

## 原生窗口截图

截图来自真实打包 APEX.app，以独立临时 userData 和本地测试 API 运行；每个 Project/Workflow 测试条目都显式标记测试属性。为避免 Playwright renderer 截图丢失 macOS 原生 vibrancy 后变成灰色底，本组对比图通过产品现有“窗口透明度”设置将强度设为 0；窗口、titlebar、安全区、滚动与响应式布局仍是实际 Electron `BrowserWindow`。

| 页面 | 1440×900 Before / After | 1220×800 Before / After | 约 700–752px Before / After |
| --- | --- | --- | --- |
| 开始 | [Before](screenshots/before/start-1440x900.png) / [After R2](screenshots/after-phase1r2/start-1440x900.png) | [Before](screenshots/before/start-1220x800.png) / [After R2](screenshots/after-phase1r2/start-1220x800.png) | [Before 700](screenshots/before/start-700x800.png) / [After R2 752](screenshots/after-phase1r2/start-752x800.png) |
| 项目 | [Before](screenshots/before/projects-1440x900.png) / [After R2](screenshots/after-phase1r2/projects-1440x900.png) | [Before](screenshots/before/projects-1220x800.png) / [After R2](screenshots/after-phase1r2/projects-1220x800.png) | [Before 700](screenshots/before/projects-700x800.png) / [After R2 752](screenshots/after-phase1r2/projects-752x800.png) |
| 工作流 | [Before](screenshots/before/workflows-1440x900.png) / [After R2](screenshots/after-phase1r2/workflows-1440x900.png) | [Before](screenshots/before/workflows-1220x800.png) / [After R2](screenshots/after-phase1r2/workflows-1220x800.png) | [Before 700](screenshots/before/workflows-700x800.png) / [After R2 752](screenshots/after-phase1r2/workflows-752x800.png) |

## 数据真值

| 界面数据 | 评审来源 | 页面表达 |
| --- | --- | --- |
| Project 列表、详情和状态 | 本地 HTTP 测试 API，按真实 Project list/detail bridge 契约返回 | 名称显式加 `[本地测试]`；状态映射中文 |
| Workflow catalog / 我的工作流 | 本地 HTTP 测试 API，按真实 catalog/list bridge 契约返回 | 页面显示“本地测试数据”；保存条目加 `[本地测试]` |
| 普通目标启动 | 现有 chat gateway；即使 Workflow domain 可用也不构造伪模板 | 不伪造 Run 或执行进度 |
| 已选 Workflow 启动 | 真实 `startGoal` bridge，保留服务端 template id/version | 测试 catalog 在确认与失败态继续显式标注，生产数据不显示测试标签 |
| 数据源 | 现有渠道 bridge 可用/绑定状态 | 无 bridge 时显示不可用/未连接，不伪造来源数 |
| 无真实 Run / Step / Deliverable | API 空值或数值 0 | 诚实生命周期空态，不显示伪步骤、伪百分比、伪产出 |

## 验证结果

- Phase 1R2 定向 UI / route / a11y / identity：8 files，129 tests，通过。
- Desktop version IPC：2/2，通过；Mac after-pack version identity：5/5，通过。
- Desktop UI 全量：751 files，7518 tests，通过。
- Electron/platform：178 files 通过、2 skipped；2722 tests 通过、6 skipped。
- release gates：Node 65/65；Vitest 15/15，通过。
- `npm run typecheck`：通过。
- `npm run lint`：0 error；131 个基线 warning。
- `npm run test:desktop:all`：清除签名凭据并设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 后通过。
- 原生 Phase 1 packaged E2E：8/8，通过；逐一覆盖 7 个一级导航的 752px 自动收栏、键盘 Enter 和 1220px 侧栏保持，并覆盖真实窗口三档、Start 单输入、生产旧 Project envelope 详情、测试 catalog 确认流、Workflow API 可用时的普通目标 chat fallback、Settings 运行包版本与 composer 安全区。
- `git diff --check`：通过。

一次初始 `test:desktop:all` 调用继承了本机 Developer ID，日志刚显示签名身份即被中止；未进入 notarize、上传或 updater。随后全部打包门禁都在清空签名变量且禁用身份发现的环境中重跑。最终交付包必须以同样环境从提交后的精确 HEAD 显式执行 `--publish never`，并回读 codesign。

## 反向故障注入

| 注入回归 | 变红的守卫 / 结果 |
| --- | --- |
| Start 恢复挂载全局 composer | `intro-visibility` 单输入守卫失败 |
| 窄窗阈值从 899 改回 768 | `layout-constants` 断言失败 |
| 移除 transcript 的 composer clearance spacer | 752px 长对话 packaged E2E 失败：预期 1 个可见 clearance，实际 0 |
| Project 行恢复“无 Run 直接回 Start” | Project route 守卫失败 |
| catalog 失败时恢复内置模板、移除恢复操作 | Workflow recovery 守卫失败 |
| 删除中文 active 映射 | 生命周期文案守卫失败 |
| name/objective 相同时仍渲染 objective | Project detail 去重守卫失败 |
| 恢复 `Wake word: "hey hermes"` | composer controls a11y 守卫失败 |
| 隐藏“启动前确认” | catalog 确认流守卫失败 |
| 移除本地测试 catalog 标记 | 测试数据身份守卫失败 |
| 将 Project run id 归一化恢复为无保护的 `summary.currentRunId` | 旧 envelope 详情测试真实崩溃，归一化单测同时失败 |
| 在 Workflow 不可用态恢复“检查连接”按钮 | recovery 守卫失败：不允许把生产 API 404 误导成本机连接问题；仅保留“重试”和“返回开始页” |
| 移除共享导航中的窄窗覆盖层关闭调用 | 7 个一级导航的 close 事件从 7 降为 0，`use-session-actions` 定向守卫失败；恢复后重新全绿 |
| 把兼容 Pane 恢复为不区分模式的 toggle-only 监听器 | 连续显式 `close` 后覆盖层错误保持 open，PaneShell 幂等关闭守卫失败；恢复后重新全绿 |
| 仅在 routed workflow 为 truthy 时更新 Start 选择 | “工作流 → 更换工作流 → 开始一个目标”完整序列失败：旧确认卡与模板残留；恢复后普通目标走 chat fallback |
| Desktop IPC 再次用 engine version 充当 app version | version IPC 守卫失败：期望 `0.17.17`，实际被注入为 `0.17.18` |
| 删除 catalog provenance 的跨页传递 | 本地测试来源和生产无标签两条守卫同时失败 |
| 未检查更新时恢复显示“最新” | Settings 诚实状态守卫失败 |
| 删除 Browser boolean 的 `aria-label` | 中文 Browser 开关辅助名称守卫失败 |
| 删除 BOTS activity-toast 的 `aria-label` | 实际 DOM 可访问名称与 pressed-state 守卫失败 |
| 删除 Bot 与 Group 选择后的窄窗 close | 两条 752px overlay 守卫分别失败 |
| 把中文“重试”恢复为英文 `Retry` | Phase 1 错误恢复中文化守卫失败 |
| 将 Info.plist 或 builder runtime version 注入为 `0.21.0` | after-pack gate 分别拒绝 Info/runtime 与 package `0.17.24` 不一致的构建 |

以上注入均先断言命中唯一目标，再运行对应守卫确认失败，随后恢复并重跑为绿。

## 未覆盖与停止点

- 生产 `/workflows`、`/catalog` 当前仍因未部署 hc-810 返回 404；完整态只验证可控本地 catalog，并已显式标注。生产完整态最终验收继续等待另行授权的 backend fast-forward 与 scheduler 回读。
- 未做 Windows 真机视觉验收；本轮交付是 Mac arm64 诊断包，不是生产成对发布。
- 未验证真实生产 Run 的长时追问、审批与干预；仅守住对象页 composer 和现有 Run route。
- 未实现 Run 双页签、Deliverable/Review 新页、定时运行重构、助手/历史新页、Profile/Settings 重做、Phase 2 API 或 DSH。
- Phase 1 三页评审包完成后停止，等待 Kael 试用确认。
