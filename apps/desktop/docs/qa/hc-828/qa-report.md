# hc-828 APEX Desktop Phase 1 实包反馈收敛 QA

## 结论

本轮从 fork `main@2c517460754bdbd7756a3a16b07816bde33e8c49` 建立隔离工作树，针对 Kael 在已安装 `0.17.24` 实包中连续记录的问题做同系统收敛。生产代码证据提交为 `c12cf7a9dba021ec1a3f4f07d59359a4e3ae9e28`；版本保持 `0.17.24`。

修复不是逐截图打补丁，而是统一了五个共享根：输入焦点、页面 Header/文字层级、侧栏信息架构、Project/Workflow 生命周期、route drawer 的原生窗口安全区。Phase 2、生产部署、公开 updater、DeepSeek Harness 均未进入本票。

## 问题归纳与根因修复

| 问题族 | 根因 | 收敛结果 |
|---|---|---|
| 文本框出现厚重方形 Focus 边框 | 全局 `*:focus-visible` 覆盖了控件自身圆角和容器焦点样式 | 全局规则只兜底无 `data-slot` 的元素；Input、Textarea、SearchField 和 Start 主输入由组件自身提供贴合形状的可见焦点。搜索输入恢复为占满可用宽度。 |
| 工作流运行抽屉过窄、内容贴边、关闭与取消冲突 | 抽屉宽度/内边距不足，Portal 丢失父级 `--titlebar-height`，导致内容从标题栏顶端开始 | 1100px 以上使用 `min(42rem, 52vw)` 右侧抽屉，内容 2rem 内边距；窄窗为标题栏下方全屏面。抽屉自身注入真实标题栏高度，并为关闭按钮和运行操作分别预留安全区。 |
| 侧栏看不到最近对话，“助手/历史”层级错误 | Business 模式沿用了过窄的 profile scope，工具入口又混在主业务导航 | 最近会话读取已加载的真实 sessions；“连接助手”“历史会话”收敛到左下工具区，不再冒充核心业务对象。 |
| 新建 Project 回到 Start、既有 Project 无法加 Workflow | “创建项目”和“继续目标”共用同一跳转；Start 启动总会新建 Project | 增加真实 `POST /projects` bridge 与保留输入的创建对话框；Project 详情列出真实 Workflow 并提供“增加工作流”；从 Project 发起的 Workflow 保留 `projectId`，不会再重复创建 Project。 |
| 已启用 Workflow 在 Workflows 页消失 | saved workflows 与 catalog 共用一个失败状态，catalog 404 把真实列表一起遮住 | 已保存 Workflow 与模板目录独立加载、独立错误；生产 catalog 不可用时仍展示真实“我的工作流”，目录区提供重试与返回开始页。 |
| Project 与 Workflow 语义混淆、看不到进展 | UI 没有显式表达容器与执行路径的层次；无 Run 时误导用户继续 | Project 是业务目标容器，Workflow 是容器内的执行路径，Run 才是某次执行。Project 详情只显示真实 Workflow/Run；无 Run 时显示诚实空态，不推算步骤或百分比。 |
| Settings、Project、Workflow、定时任务、交付物标题风格分裂 | 页面各自实现标题和 Settings 行级排版 | 新增共享 `ApexPageHeader`；Project/Workflow/定时任务/交付物使用同一标题、眉题、描述和动作节奏。Settings 使用统一 page/section/row title、description、control 原语。 |
| 中文界面泄漏 `active`、`run.started` 等枚举 | 服务端状态和事件键直接透传 | 生命周期状态集中映射；补齐 canonical Run 事件 `run.cancel_requested`、`run.succeeded` 等。未知事件仍原样诚实回退，不伪造业务含义。 |
| “后端版本过旧”让人误以为装 Desktop 会自动升级后端 | Desktop shell 与本机 Runtime 的独立版本生命周期没有解释 | 更新入口改为“检查兼容更新”；目录没有兼容 Runtime 时明确说明尚未发布。安装 Desktop 不会强制覆盖正在运行的 Runtime；本票没有发布 Runtime。 |

## 保留的产品契约

- Start 只挂载一个可见、可聚焦、可被辅助功能识别的“业务目标”主输入；普通 Session 和已启动执行仍保留底部 composer。
- 保留真实 `startGoal`、chat fallback、Workflow template id/version、草稿附件与失败保留。
- Project/Workflow 继续使用真实 API bridge；创建失败不关闭对话框、不丢输入。
- Project name 与 objective 完全一致时不重复描述。
- 没有真实 Step、Deliverable、来源或百分比时不显示模拟进度。
- 保持 APEX 身份层、默认中文、Profile 既有用量表面、Hermes-only 与 DSH No-Go。

## 文件出口

- Project/Workflow API：`electron/apex-workflow-domain.ts`、`electron/main.ts`、`electron/preload.ts`、`src/app/business-workspace/api/{adapters,types}.ts`、`src/global.d.ts`。
- 页面与流程：`projects-page.tsx`、`project-detail-page.tsx`、`workflows-page.tsx`、`start-page.tsx`、`workflow-run-page.tsx`、`project-create-dialog.tsx`、`use-workflow-domain-lists.ts`。
- 共享视觉：`components/ui/apex-page-header.tsx`、`components/ui/search-field.tsx`、`settings/primitives.tsx`、`page-search-shell.tsx`、`styles.css`。
- 壳与导航：`app/chat/sidebar/index.tsx`、`app/overlays/responsive-route-drawer.tsx`、`app/artifacts/index.tsx`、`app/cron/index.tsx`。
- 状态与文案：`i18n/{zh,zh-hant,en,ja,ar,types}.ts`、`store/updates.ts`。
- 守卫：对应 UI/Electron tests、`identity-layer.test.tsx`、`business-workspace-packaged.spec.ts`。

## 数据口径

- 真实数据：生产 Project、Workflow、Workflow Run、Project detail 均来自既有 authenticated API；本票只新增 Project 创建的同域桥接，不新增 Phase 2 API。
- 本地测试数据：截图中的 Project、Workflow catalog 和 Run 都带 `[本地测试]` 或“本地测试数据”标识，只用于实包布局与交互验收。
- 空状态：没有真实 Run/Step/Deliverable 时只展示生命周期或空态，不制造完成度、步骤、来源数或待办。
- 仍待生产确认：Workflows 完整生产态必须等 authenticated `/workflows`、`/catalog` 稳定返回 200；本地 catalog 通过不等于生产 Go。

## 验证结果

- Desktop typecheck：通过。
- Desktop lint：0 errors；131 个既有 warnings。
- Phase 1 定向 UI/路由/辅助功能：通过；最后一次增量 2 files / 7 tests 通过。
- Desktop 全量 UI：759 files / 7589 tests 通过。
- Electron/platform：180 files 通过、2 skipped；2747 tests 通过、6 skipped。
- identity-layer、route/drawer、release gates：通过；release gates 为 Node 78 + Vitest 15。
- production build：通过。
- packaged Electron clean userData：10/10 通过；真实 BrowserWindow 覆盖 1440、1220、752 三档，并验证原生标题栏、侧栏、抽屉、滚动与辅助功能。
- `git diff --check`：通过。

## 反向故障注入

每项注入前均精确确认目标锚点，失败后恢复并复绿：

- 恢复 SearchField 内容宽度后，搜索布局守卫变红。
- 恢复旧抽屉 `35rem/42vw` 后，宽窗几何守卫变红。
- 删除抽屉自身标题栏高度后，安全区单测变红；对应旧包的真实关闭点击被壳按钮截获。
- 删除 `run.running` 中文映射后，中文事件守卫显示原始枚举并变红。
- 移除 Start → existing Project 的 `projectId` 后，路由守卫变红。
- 重新把 saved workflows 绑定到 catalog 成败后，catalog 404 下的真实 Workflow 守卫变红。
- 恢复“新建项目→Start”旧跳转后，Project 创建对话框守卫变红。
- 移除 Runtime 无兼容版本提示、左下工具分组、Settings row 或共享 Header 标记后，各自身份/更新/页面守卫变红。

## 实包证据

- 构建源提交：`c12cf7a9dba021ec1a3f4f07d59359a4e3ae9e28`；arm64；版本 `0.17.24`。
- 诊断 DMG：`apps/desktop/release/APEX-0.17.24-mac-arm64.dmg`；该代码证据包 SHA-256 `6a8c695e1bff9afb9c122388c838e0a5f7b9b168ff4804fe59e393c9bbb7c5f5`。
- 签名回读：`Signature=adhoc`、`TeamIdentifier=not set`、无 Developer ID Authority；stapler 明确无 ticket。
- 构建方式：清空 Apple/CSC/GitHub 发布凭据，`CSC_IDENTITY_AUTO_DISCOVERY=false`、`npm_config_arch=arm64`，完整 build 后显式 `builder --mac dmg --arm64 --publish never`。
- builder 在 release 目录生成本地 `latest-mac.yml` 作为未跟踪诊断元数据；没有上传、没有改动或发布公开 updater feed。
- 一次全量脚本预检发现其内部 builder 会自动探测 Developer ID，已在签名步骤立即中断并丢弃该 release 目录；以上候选随后从空 release 目录按禁签名参数重建，未复用中断产物。

最终 Draft HEAD 仅在代码证据提交之后追加 QA 截图/报告；最终 HEAD 的 DMG、安装路径、哈希与 CI 以 Draft PR body 和交付回报的只读回读为准。

## 停止条件

本轮只交付 Phase 1 实包反馈收敛。未经新授权，不合并、不发布、不部署、不更新公开 updater feed、不进入 Phase 2。
