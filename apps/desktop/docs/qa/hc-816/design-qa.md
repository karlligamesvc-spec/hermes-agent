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

- 真实 catalog 不可用/失败时，不再回退展示内置模板；提供“重试”“检查连接”“返回开始页”三个可执行动作。
- 页面只展示真实 catalog 返回并能映射到 Phase 1 路径的模板。
- catalog version 明确含 local/test/staging/review 时显示“本地测试数据”状态提示，不把测试模板冒充生产数据。
- 已走通：模板列表 → 选择模板 → Start 目标可编辑 → 启动前确认；确认区显示服务端 template version 和 Hermes executor。
- 没有 DeepSeek Harness 选择器或已接入声明。

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
- 原型没有覆盖的 catalog 故障态增加了重试、连接检查和返回 Start，不使用本地模板伪装成功态。

### 仍保留的共享 shell 差异

- 既有共享 shell 仍显示 `SESSIONS / BOTS` 顶栏，侧栏顶部也尚未替换成原型的 APEX Logo。
- 这些出口属于全局壳、助手/历史表面，本轮不扩大到 Phase 2；Phase 1 内容区已保持 APEX 中文、品牌紫色、圆角、卡片与间距体系。

## 原生窗口截图

截图来自真实打包 APEX.app，以独立临时 userData 和本地测试 API 运行；每个 Project/Workflow 测试条目都显式标记测试属性。

| 页面 | 1440×900 Before / After | 1220×800 Before / After | 约 700–752px Before / After |
| --- | --- | --- | --- |
| 开始 | [Before](screenshots/before/start-1440x900.png) / [After](screenshots/after-kael-review/start-1440x900.png) | [Before](screenshots/before/start-1220x800.png) / [After](screenshots/after-kael-review/start-1220x800.png) | [Before 700](screenshots/before/start-700x800.png) / [After 752](screenshots/after-kael-review/start-752x800.png) |
| 项目 | [Before](screenshots/before/projects-1440x900.png) / [After](screenshots/after-kael-review/projects-1440x900.png) | [Before](screenshots/before/projects-1220x800.png) / [After](screenshots/after-kael-review/projects-1220x800.png) | [Before 700](screenshots/before/projects-700x800.png) / [After 752](screenshots/after-kael-review/projects-752x800.png) |
| 工作流 | [Before](screenshots/before/workflows-1440x900.png) / [After](screenshots/after-kael-review/workflows-1440x900.png) | [Before](screenshots/before/workflows-1220x800.png) / [After](screenshots/after-kael-review/workflows-1220x800.png) | [Before 700](screenshots/before/workflows-700x800.png) / [After 752](screenshots/after-kael-review/workflows-752x800.png) |

## 数据真值

| 界面数据 | 评审来源 | 页面表达 |
| --- | --- | --- |
| Project 列表、详情和状态 | 本地 HTTP 测试 API，按真实 Project list/detail bridge 契约返回 | 名称显式加 `[本地测试]`；状态映射中文 |
| Workflow catalog / 我的工作流 | 本地 HTTP 测试 API，按真实 catalog/list bridge 契约返回 | 页面显示“本地测试数据”；保存条目加 `[本地测试]` |
| 目标启动 | 真实 `startGoal` bridge；domain 暗开时走现有 chat gateway | 不伪造 Run 或执行进度 |
| 数据源 | 现有渠道 bridge 可用/绑定状态 | 无 bridge 时显示不可用/未连接，不伪造来源数 |
| 无真实 Run / Step / Deliverable | API 空值或数值 0 | 诚实生命周期空态，不显示伪步骤、伪百分比、伪产出 |

## 验证结果

- 定向 UI / route / a11y / identity / Electron bridge：7 files，118 tests，通过。
- Desktop UI 全量：750 files，7502 tests，通过。
- Electron/platform：178 files 通过、2 skipped；2719 tests 通过、6 skipped。
- release gates：Node 65/65；Vitest 12/12，通过。
- `npm run typecheck`：通过。
- `npm run lint`：0 error；131 个基线 warning。
- `npm run test:desktop:all`：清除签名凭据并设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 后通过。
- 原生 Phase 1 packaged E2E：6/6，通过；覆盖真实窗口三档、Start 单输入、Project 详情、测试 catalog 确认流、chat fallback 与 composer 安全区。
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

以上注入均先断言命中唯一目标，再运行对应守卫确认失败，随后恢复并重跑为绿。

## 未覆盖与停止点

- 未连接生产 catalog；完整态只验证可控本地 catalog，并已显式标注。
- 未做 Windows 真机视觉验收；本轮交付是 Mac arm64 诊断包，不是生产成对发布。
- 未验证真实生产 Run 的长时追问、审批与干预；仅守住对象页 composer 和现有 Run route。
- 未实现 Run 双页签、Deliverable/Review 新页、定时运行重构、助手/历史新页、Profile/Settings 重做、Phase 2 API 或 DSH。
- Phase 1 三页评审包完成后停止，等待 Kael 试用确认。
