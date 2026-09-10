# hc-825 Phase 1-only 视觉 QA

## 评审边界

本轮视觉对象仅为 Start、Projects、Project 详情与 Workflows，以及这些页面共用的主侧栏、业务画布、输入、卡片、按钮和窄窗规则。Profile、Settings 和账户 Overlay 保持 fork main，不把旧的扩展视觉试验带入 Phase 1 发布候选。

基线：fork `main@077490a963007e4c77170e425bfd2b61f76dfd17`，版本 `0.17.24`。Draft #263/hc-820 Phase 2A 不是祖先；Run drawer、双页签和 compact responsive Run drawer 为 No-Go。

## 页面裁决标准

### Start

- 单一“业务目标”主输入位于页面视觉中心，快捷入口和数据源信息形成次级层级。
- Start 不挂载底部全局 composer；键盘顺序为目标输入、提交、附件相关可用动作。
- 草稿、附件、chat fallback、template id/version 和失败保留语义不变。

### Projects

- 列表行先进入 Project 详情，不因缺少 `currentRunId` 而直接跳回 Start。
- 有 Run 显示真实 Run 入口；无 Run 显示诚实空态和“继续这个目标”。
- Project name 等于 objective 时不重复；不展示推算的百分比、步骤或待办。

### Workflows

- 真实目录不可用时提供重试和返回开始页；测试 catalog 必须明确标记。
- 完整态路径为目录→模板→可编辑目标→启动前确认。
- 不宣称 DSH 接入，不用测试模板冒充生产目录。

### 窗口与壳

- 1440×900、1220×800、700–752px 三档均检查真实 BrowserWindow，而非只改 renderer viewport。
- 640–899px 完整侧栏自动收起，展开入口可见；页面无水平滚动。
- 浅色业务路由在 glass 设置下仍为连续不透明 APEX 画布；普通 Session 的 glass 语义不被改写。
- macOS traffic lights、安全区、标题栏拖拽区、焦点回落和滚动到底后的最后内容均可见。

## 证据状态

早于本次 restack 的 App、DMG、截图与哈希全部冻结为历史诊断证据。它们包含不同祖先或不同范围，不能作为当前候选的 Before/After 或签名证明。

当前源码已完成定向 Phase 1/identity/layout/i18n 147 tests、typecheck 与 Phase 2A 反向注入守卫。最终组合必须重新完成全量 UI/Electron/release gates、production build、独立 App 安装、clean userData 原生三档复拍与 SHA-256 记录。

## 停止条件

拿到新的三页 Phase 1 原生评审包后停下交给 Kael。生产 Workflows 完整态仍等待 authenticated `/workflows`、`/catalog` 200；未经授权不合并、不发布、不部署、不更新 updater，也不进入 Phase 2。
