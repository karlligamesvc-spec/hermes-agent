# hc-825 APEX Desktop Phase 1-only QA 报告

## 当前结论

2026-09-09 按 Phase 2 No-Go 边界，从 fork `main@077490a963007e4c77170e425bfd2b61f76dfd17` 在隔离工作树中重放 hc-825，并完成第二轮严格范围审计。候选仅保留 Start、Projects、Project 详情、Workflows、窄窗、APEX 身份层和这些页面依赖的共享 renderer 修复；版本仍为 `0.17.24`。

Draft PR #263 的 hc-820 Run drawer、双页签、compact responsive Run drawer 及其文案/测试未进入候选。Profile、Settings、账户 Overlay 的独立 JSX、样式、i18n 与实包测试已恢复为 fork main，避免把 Phase 1 三页验收扩成 Profile/Settings 重做。

远端 #265、PR base、公开 updater 和 release workflow 尚未修改。任何早于本次 Phase 1-only restack 的 App、DMG、截图、哈希和 CI 只作为历史诊断证据冻结，不能证明新的发布候选。

## 允许范围与行为

- Start：页面只挂载一个可见、可聚焦、可被辅助功能识别的“业务目标”输入；旧全局 composer 在 Start 不进入视觉、Tab 顺序或辅助功能树，在普通 Session 与既有 Run 场景继续保留。
- Start：保留真实 `startGoal`、chat fallback、附件草稿、Workflow template id/version，以及失败后不清除目标和附件。
- Projects：点击行先打开真实 Project 详情；有真实 Run 时允许继续打开，无 Run 时显示诚实空态。只有点击“继续这个目标”才返回 Start 并预填 objective。
- Projects：Project name 与 objective 完全相同时不重复描述；生命周期状态和当前 Run 状态分开，不伪造 Run、Step、百分比、Deliverable 或待办。
- Workflows：只展示真实 bridge 返回的目录或明确标注的本地测试 catalog；不可用态提供重试与返回开始页。目标在启动前可编辑，附件不受支持时保留草稿并明确提示。
- 窄窗：640–899px 收起完整侧栏并保留展开入口；业务画布不横向溢出，带 composer 的普通 Session 仍保留完整底部安全区。
- 身份层：保持 APEX 品牌、默认中文、Hermes-only 和 DSH No-Go；辅助功能文案不暴露上游 wake-word 身份。

## 文件出口

- 页面：`src/app/business-workspace/pages/{start-page,projects-page,workflows-page}.tsx`
- Phase 1 共享组件：`business-goal-launcher.tsx`、`business-page-header.tsx`、`start-shelf.tsx`、`workflow-starter-card.tsx`
- Project 语义：`src/app/business-workspace/view-model/project.ts` 与既有 Project detail/API seam
- 壳与窄窗：`src/app/contrib/controller.tsx`、`src/store/{business-workspace,business-canvas,layout}.ts`、Pane shell / sidebar、`src/styles.css`
- Start composer/focus：`src/app/chat/index.tsx`、composer controls、`src/components/chat/intro.tsx`
- 共享品牌与控件：批准的 APEX/Workflow 资产、Button、RowButton、Badge、主题与 i18n
- 验证：Business Workspace、identity、route/drawer、layout、i18n、UI primitive 与 packaged Phase 1 守卫
- 明确未改：Profile、Settings、Account overlay 的生产实现；Workflow Run Phase 2A；Electron/Deliverable/Review 新页；Phase 2 API；发布与 updater

## 数据口径

- Project、Workflow、Profile 与 Settings 仍走既有真实 bridge/store；本票没有新增生产数据或假保存。
- 本地 catalog/Project fixture 必须带“本地测试”标记，只证明布局和选择流程。
- 无真实 Run/Step/Deliverable/来源/百分比时显示空态或生命周期文案，不补模拟数字。
- Workflows 完整生产态仍以 authenticated `/workflows`、`/catalog` 返回 200 为前提；当前本地候选不构成生产接口 Go。

## 本地验证

本次严格范围工作树已完成：

- 定向 Phase 1 / identity / route / layout / i18n：11 files / 147 tests 通过。
- Desktop 全量 UI：758 files / 7581 tests 通过。
- Desktop typecheck：通过。
- Desktop lint：0 errors；131 个既有 warning。
- 范围守卫：明确断言 hc-820 的 `data-run-scroll-container`、Run 双页签、compact route drawer 标志不在候选中。
- 反向验证：向现有 Run 页面精确注入一次 `data-run-scroll-container` 后，发布边界守卫按预期失败；恢复后重新通过。
- `git diff --check`、Electron/platform、release gates 与精确组合树验证在最终本地集成 HEAD 收口，并由协调报告记录。

旧分支的远端 CI 全绿只对应旧 HEAD；任何 force-with-lease restack 都必须重新跑 GitHub CI，不能继承旧绿色结论。

## 仍需重生成

远端 restack 获得授权并完成后，必须从最终 Phase 1-only 精确组合 HEAD 重新生成：

1. 三档真实 Electron 原生窗口截图：1440×900（若 macOS 实际夹高则记录实际值）、1220×800、700–752px。
2. Start / Projects / Workflows 的 Before/After 与测试数据标记。
3. Mac arm64 unsigned/ad-hoc 试用 App、DMG、codesign 读回与 SHA-256。
4. clean userData 下单输入、侧栏、安全区、Project 详情与 Workflow 选择→编辑→确认路径。
5. 所有改写后 PR 的 GitHub CI 与最终 ancestry/tree 证明。

未经新的明确授权，不合并、不发布、不部署、不触发 desktop-release，不更新 updater feed，不进入 Phase 2。
