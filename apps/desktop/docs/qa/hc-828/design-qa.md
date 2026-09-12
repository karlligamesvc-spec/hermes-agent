# hc-828 Phase 1 视觉与交互 QA

## 评审原则

沿用三张批准原型的层级、留白、卡片与 APEX 品牌，但不复制 `body min-width: 1080px`、8–10px 小字号或固定模拟数字。本轮 Product Design 审计把连续反馈归并为共享组件与对象关系问题：同类入口只保留一种语义，同类页面只保留一套视觉语法，同类状态只从真实生命周期产生。

## 三档 Before / After

Before 采用 hc-816 Kael 首次实包复核截图；After 来自 `c12cf7a9` 代码候选、clean userData 的真实 Electron BrowserWindow。macOS 将请求的 1440×900 工作区夹为可用高度，文件名保留验收档名称。

| 页面 | 1440 档 | 1220 档 | 752 窄窗 |
|---|---|---|---|
| Start Before | [截图](../hc-816/screenshots/after-kael-review/start-1440x900.png) | [截图](../hc-816/screenshots/after-kael-review/start-1220x800.png) | [截图](../hc-816/screenshots/after-kael-review/start-752x800.png) |
| Start After | [截图](screenshots/after-c12cf7a9/start-1440x900.png) | [截图](screenshots/after-c12cf7a9/start-1220x800.png) | [截图](screenshots/after-c12cf7a9/start-752x800.png) |
| Projects Before | [截图](../hc-816/screenshots/after-kael-review/projects-1440x900.png) | [截图](../hc-816/screenshots/after-kael-review/projects-1220x800.png) | [截图](../hc-816/screenshots/after-kael-review/projects-752x800.png) |
| Projects After | [截图](screenshots/after-c12cf7a9/projects-1440x900.png) | [截图](screenshots/after-c12cf7a9/projects-1220x800.png) | [截图](screenshots/after-c12cf7a9/projects-752x800.png) |
| Workflows Before | [截图](../hc-816/screenshots/after-kael-review/workflows-1440x900.png) | [截图](../hc-816/screenshots/after-kael-review/workflows-1220x800.png) | [截图](../hc-816/screenshots/after-kael-review/workflows-752x800.png) |
| Workflows After | [截图](screenshots/after-c12cf7a9/workflows-1440x900.png) | [截图](screenshots/after-c12cf7a9/workflows-1220x800.png) | [截图](screenshots/after-c12cf7a9/workflows-752x800.png) |
| Workflow Run After | [截图](screenshots/after-c12cf7a9/workflow-run-1440x900.png) | [截图](screenshots/after-c12cf7a9/workflow-run-1220x800.png) | [截图](screenshots/after-c12cf7a9/workflow-run-752x800.png) |

## 逐页差异

### Start

- 中央“业务目标”是唯一主输入，旧底部 composer 不进入 DOM、Tab 顺序或辅助功能树。
- Focus 保留键盘可见性，但外圈跟随圆角容器，不再出现内外叠加的方框。
- 三条重点路径、近期 Project 和数据源保持次级信息密度；不展示模拟百分比、步骤或来源数。
- “连接助手”“历史会话”移到左下工具区，主导航只表达核心业务对象。

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

- Project、Workflow、定时任务、交付物采用同一 Header 结构和最大内容宽度。
- Settings 的 Content、Head、section/row 标题、说明与控件列由统一原语约束，避免页面内字号和基线漂移。
- 搜索会话输入占满可用宽度，焦点环跟随搜索容器，窄窗不再缩成短标签。

## 原生窗口检查

- 640–899px：完整侧栏自动收起，展开入口可见；内容无水平溢出。
- 1440、1220、752 三档均用真实 Electron `setContentSize`/BrowserWindow 截图，不是 renderer-only viewport。
- 带 composer 的普通 Session 继续保留底部安全区；Start 不挂载 composer。
- drawer Portal 自己携带标题栏高度，避免 CSS 变量因 Portal 脱离壳父树而丢失。
- 按钮名称、Tab 顺序、Focus 回落、disabled/alert 语义均由定向测试覆盖。

## 未覆盖

- authenticated 生产 `/workflows`、`/catalog` 完整态最终验收。
- 正式 Mac/Windows 配对发布、签名、notarization、上传与公开 updater。
- Workflow Run 双页签、Deliverable/Review 新页、定时运行重构、Profile/Settings 整体重做及 Phase 2 API。

