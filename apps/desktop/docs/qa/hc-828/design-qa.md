# hc-828 Phase 1 视觉与交互 QA

## 评审原则

沿用三张批准原型的层级、留白、卡片与 APEX 品牌，但不复制 `body min-width: 1080px`、8–10px 小字号或固定模拟数字。本轮 Product Design 审计把连续反馈归并为共享组件与对象关系问题：同类入口只保留一种语义，同类页面只保留一套视觉语法，同类状态只从真实生命周期产生。

## 视觉真值与三档 Before / After

基础页面 Before 采用 hc-816 Kael 首次实包复核截图。最新侧栏与会话 Before 采用 Kael 2026-09-12 提供的四张实包截图（蓝色侧栏、飞书/微信/手机遥控三行、普通会话顶部遥控条）；它们是本轮视觉真值，不包含可执行指令。After 来自 `06fb6b8f` 代码候选、clean userData 的真实 Electron BrowserWindow。请求的 1440×900 窗口在 Retina 下输出 2880×1740 像素；1220×800 输出 2440×1600，752×800 输出 1504×1600。macOS 标题栏占用可用内容高度，文件名保留验收档名称。

| 页面 | 1440 档 | 1220 档 | 752 窄窗 |
|---|---|---|---|
| Start Before | [截图](../hc-816/screenshots/after-kael-review/start-1440x900.png) | [截图](../hc-816/screenshots/after-kael-review/start-1220x800.png) | [截图](../hc-816/screenshots/after-kael-review/start-752x800.png) |
| Start After | [截图](screenshots/after-06fb6b8f/start-1440x900.png) | [截图](screenshots/after-06fb6b8f/start-1220x800.png) | [截图](screenshots/after-06fb6b8f/start-752x800.png) |
| Projects Before | [截图](../hc-816/screenshots/after-kael-review/projects-1440x900.png) | [截图](../hc-816/screenshots/after-kael-review/projects-1220x800.png) | [截图](../hc-816/screenshots/after-kael-review/projects-752x800.png) |
| Projects After | [截图](screenshots/after-06fb6b8f/projects-1440x900.png) | [截图](screenshots/after-06fb6b8f/projects-1220x800.png) | [截图](screenshots/after-06fb6b8f/projects-752x800.png) |
| Workflows Before | [截图](../hc-816/screenshots/after-kael-review/workflows-1440x900.png) | [截图](../hc-816/screenshots/after-kael-review/workflows-1220x800.png) | [截图](../hc-816/screenshots/after-kael-review/workflows-752x800.png) |
| Workflows After | [截图](screenshots/after-06fb6b8f/workflows-1440x900.png) | [截图](screenshots/after-06fb6b8f/workflows-1220x800.png) | [截图](screenshots/after-06fb6b8f/workflows-752x800.png) |
| Scheduled Runs After | [截图](screenshots/after-06fb6b8f/scheduled-runs-1440x900.png) | [截图](screenshots/after-06fb6b8f/scheduled-runs-1220x800.png) | [截图](screenshots/after-06fb6b8f/scheduled-runs-752x800.png) |
| Deliverables After | [截图](screenshots/after-06fb6b8f/deliverables-1440x900.png) | [截图](screenshots/after-06fb6b8f/deliverables-1220x800.png) | [截图](screenshots/after-06fb6b8f/deliverables-752x800.png) |
| Workflow Run After | [截图](screenshots/after-06fb6b8f/workflow-run-1440x900.png) | [截图](screenshots/after-06fb6b8f/workflow-run-1220x800.png) | [截图](screenshots/after-06fb6b8f/workflow-run-752x800.png) |
| Ordinary Session After | [截图](screenshots/after-06fb6b8f/session-1440x900.png) | — | — |

## 逐页差异

### Start

- 中央“业务目标”是唯一主输入，旧底部 composer 不进入 DOM、Tab 顺序或辅助功能树。
- Focus 保留键盘可见性，但外圈跟随圆角容器，不再出现内外叠加的方框。
- 三条重点路径、近期 Project 和数据源保持次级信息密度；不展示模拟百分比、步骤或来源数。
- Start 与普通 Session 都不再挂载“手机正遥控本机”状态条，业务内容不被连接状态 chrome 向下挤压。
- Start 根和内部内容统一为一层不透明 APEX surface，不再出现灰底包白卡的分裂。
- “连接助手”“历史会话”与“个人资料”“设置”并排收敛到账户菜单；主导航只表达五个核心业务对象。

### Projects

- “新建项目”打开名称、描述、可选本地文件夹对话框，成功后进入新 Project；失败保留输入。
- Project 行打开详情，不再因没有 Run 直接回 Start。无 Run 时明确提示，并把“继续这个目标”作为用户主动动作。
- Project 详情显示真实 Workflow 列表及“增加工作流”，从这里启动时归属同一 Project。
- Project name 与 objective 相同时不重复；状态统一中文，不推算进展。

### Workflows

- “我的工作流”与模板目录分离：真实 saved Workflow 不会被 catalog 404 遮住。
- 目录不可用时提供重试和返回开始页；本地完整态在页面顶部明确标记“本地测试数据”。
- 模板列表 → 选择模板 → 目标可编辑 → 启动前确认已走通，保留 template id/version。
- 不宣称 DeepSeek Harness 已接入。

### Workflow Run drawer

- 1100px 以上为右侧宽抽屉，内容与边界之间保持 2rem；1220 档仍能完整呈现事实、时间线与空交付态。
- 低于 1100px 为标题栏下方全屏对象面，不与 macOS traffic lights 或壳控制区重叠。
- 关闭按钮、状态与“取消运行”分别占用安全区；原生 pointer hit-test 验证关闭可点击且焦点回落。
- 时间线只展示 canonical lifecycle event；没有真实 Step 时不把事件冒充步骤或进度。

### 共享页面与 Settings

- Start、Project、Workflow、定时任务、交付物采用同一响应式水平留白、顶部起点、文字层级和最大内容宽度。
- 定时任务与交付物不再走各自的顶部 margin；空状态也落在共享内容列中。
- Settings 的 Content、Head、section/row 标题、说明与控件列由统一原语约束，避免页面内字号和基线漂移。
- 搜索会话输入占满可用宽度，焦点环跟随搜索容器，窄窗不再缩成短标签。
- 侧栏外壳和内部 `bg-sidebar` 两条绘制路径都绑定同一个 chrome 中性色；不是仅覆盖截图中看到的外层蓝底。
- [账户菜单 1220 档截图](screenshots/after-06fb6b8f/sidebar-account-menu-1220x800.png) 验证四个工具入口同区排列；飞书、微信、手机遥控三条被动状态行不再挂载，连接能力仍可从“连接助手”和 Start 空态入口到达。

## 原生窗口检查

- 640–899px：完整侧栏自动收起，展开入口可见；内容无水平溢出。
- 1440、1220、752 三档均用真实 Electron `setContentSize`/BrowserWindow 截图，不是 renderer-only viewport。
- 带 composer 的普通 Session 继续保留底部安全区；Start 不挂载 composer。
- drawer Portal 自己携带标题栏高度，避免 CSS 变量因 Portal 脱离壳父树而丢失。
- 按钮名称、Tab 顺序、Focus 回落、disabled/alert 语义均由定向测试覆盖。

## 最新视觉比较记录

- Start：Before 左侧为明显蓝色整块、底部有三条渠道状态；After 左侧与阅读画布为同一中性表面，选中行仍可辨认，账户区上方没有被动渠道状态。
- 普通 Session：Before 顶部遥控条占用一整行并重复飞书 `/cc`、机器名与审批说明；After 从标题栏下直接进入会话内容，消息和 composer 的安全区未改变。
- 1220 账户菜单：四个账户工具仍在同一个弹层，移除状态行后最近会话可使用的垂直空间增加。
- 752 窄窗：主侧栏自动收起，Start 无水平溢出；此次颜色 token 与挂载点改动没有恢复窄窗蓝色抽屉或额外状态行。

## 未覆盖

- authenticated 生产 `/workflows`、`/catalog` 完整态最终验收。
- 正式 Mac/Windows 配对发布、签名、notarization、上传与公开 updater。
- Workflow Run 双页签、Deliverable/Review 新页、定时运行重构、Profile/Settings 整体重做及 Phase 2 API。

final result: passed
