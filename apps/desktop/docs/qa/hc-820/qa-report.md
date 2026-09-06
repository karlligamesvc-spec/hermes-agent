# hc-820 — Desktop Phase 2A 真实 Run 抽屉 QA 报告

## 结论

本批次在冻结的 Draft PR #262 精确基线 `0ae743c20aef14da599698ef2921d31b17f6e740` 上完成，分支为 `codex/hc-820-desktop-phase2a-real-run-drawer`，版本保持 `0.17.24`。截图构建提交为 `ca6fa3f3ea5d455fe427201fa75a35ac06a34e6a`；其后的最终交付提交只增加本报告与截图，最终 App、DMG 和 SHA-256 记录在 Draft PR 中，避免构建提交自引用。

实现限定在 Phase 2A 的真实 Run 右抽屉：路由、两页签、真实生命周期数据、审阅/取消动作、轮询、响应式布局和辅助功能。未修改冻结的 #261/#262，也未进入 Phase 3、Deliverable/Review 新页面、ApexNodes 后端、新 API、DeepSeek Harness、发布或部署。

## 票号与隔离基线

- 票号：`hc-820`；创建前已查 ApexNodes 全 refs、`karlligamesvc-spec/hermes-agent` 全 refs、GitHub PR 和飞书 PD Sheet1 L 列，确认未占用后登记在 `apex` Sheet 第 765 行。
- 工作树：`/Users/karl/projects/.wt/hc820-desktop-phase2a-real-run-drawer`，不与冻结 PR 或其他 Session 共用。
- Base：Draft PR #262 @ `0ae743c20aef14da599698ef2921d31b17f6e740`。
- 冻结依赖：#261 @ `ce8b9e127f84bb59c642218457ba97bedaab2eb1`；#262 未改写、未 rebase、未 force-push。

## 文件出口清单

### Electron 与数据边界

- `electron/apex-workflow-domain.ts`：GET Run 的唯一安全投影；只接受 Hermes executor；事件按 sequence/time/id 稳定排序；交付物、证据计数和审阅状态仅输出白名单字段；仅允许无嵌入凭据的 HTTP(S) URL 作为可打开目标。
- `electron/main.ts`：取消和审阅 IPC 只回传 `{ ok: true }`，不把后端原始 Run/Review 响应带入 renderer。
- `src/app/business-workspace/api/types.ts`、`src/global.d.ts`：renderer bridge 类型收敛到安全 Run overview，不暴露 payload、schema、配置、用户标识或服务器路径。

### Renderer 与交互

- `src/app/business-workspace/hooks/use-workflow-run.ts`：复用的 Run hook；活跃状态每 3 秒轮询，窗口隐藏/失焦暂停，恢复可见后立即刷新，终态停止；失败保留最近成功数据并提供重试；防止旧请求覆盖新结果。
- `src/app/business-workspace/pages/workflow-run-page.tsx`：进展/执行详情两个页签；展示真实状态、时间、事件、待审阅与交付物；无 Step API 时显示诚实空态；仅 `waiting_review` 可审批/要求修改；取消与打开交付物均按能力可用性显隐或禁用。
- `src/app/contrib/surfaces.tsx`：`/workflows/runs/:runId` 使用路由驱动右抽屉，冷启动/关闭回落到 Workflows。
- `src/app/overlays/responsive-route-drawer.tsx`：640px 以上的 Run 抽屉宽度为 `min(540px, 100vw - 16px)`，640px 以下占满窗口；复用 Radix modal 的焦点圈定、分层 Escape 和焦点恢复。Project 抽屉语义保持不变。
- `src/components/ui/tabs.tsx`、`DESIGN.md`：补齐共享 TabsContent primitive 及设计约束。
- `src/i18n/{zh,zh-hant,en,ja,types}.ts`、`view-model/display-status.ts`：四语言 Run 文案与状态映射；未知服务端状态不直接回显原始值。

### 守卫与打包验收

- `electron/apex-workflow-domain.test.ts`：恶意原始 fixture、Hermes-only、安全排序和字段剥离。
- `src/app/business-workspace/hooks/use-workflow-run.test.tsx`：3 秒轮询、隐藏暂停、恢复刷新、终态停止、失败保留缓存和 stale request。
- `src/app/business-workspace/workflow-run-view.test.tsx`：双页签、诚实空态、允许动作与真实打开目标。
- `src/app/overlays/responsive-route-drawer.test.tsx`：Run 专属宽度、焦点陷阱、嵌套 Escape 与焦点回落。
- `src/identity-layer.test.tsx`：APEX/Hermes 身份边界、renderer 不接收原始 mutation 响应。
- `e2e/business-workspace-packaged.spec.ts`：安装包、干净 userData、受控本地 Run API、三档真实 Electron BrowserWindow、两页签、数据安全、焦点和截图。

## 数据口径与安全边界

- 截图和打包 E2E 的 Project、Run、事件与交付物来自受控本地 API，标题和目标明确标注 `[本地测试]`；它们不是生产数据。
- fixture 故意包含乱序事件、伪造 `steps`、原始 payload、用户标识和敏感配置，用来证明 Electron 白名单投影会排序并剥离它们，而不是把测试结构当产品数据。
- 当前真实 GET Run 合同没有 Step。进展页因此只显示“暂时没有可展示的阶段进度”，没有推测阶段、百分比、步骤、来源数量或待处理事项。
- Review/Deliverable 只使用 GET Run 已返回的真实嵌套数据；审批动作仅在 `waiting_review` 出现。无安全 URL 时“打开结果”明确不可用，不把服务器路径伪装成可打开目标。
- executor 只接受 `hermes`。页面没有宣称或展示 DeepSeek Harness 已接入。
- 生产 `/workflows`、`/catalog` 仍未完成 200 环境的最终验收；本批次不把本地 catalog 结果写成生产结论。

## 原生窗口视觉验收

截图来自独立安装的 arm64 App、每次新建的 userData 和真实 `BrowserWindow.setBounds`，不是 renderer-only viewport。测试服务返回值均标有“本地测试”。

| 页签 | 1440×900 | 1220×800 | 752×800 |
|---|---|---|---|
| 进展 | [截图](screenshots/after-ca6fa3f/run-progress-1440x900.png) | [截图](screenshots/after-ca6fa3f/run-progress-1220x800.png) | [截图](screenshots/after-ca6fa3f/run-progress-752x800.png) |
| 执行详情 | [截图](screenshots/after-ca6fa3f/run-details-1440x900.png) | [截图](screenshots/after-ca6fa3f/run-details-1220x800.png) | [截图](screenshots/after-ca6fa3f/run-details-752x800.png) |

- 1440×900、1220×800：右抽屉宽 540px，底层 Workflows/Start 业务上下文保留并被 modal 遮罩。
- 752×800：右抽屉仍为 540px，窗口左侧保留 212px 上下文；无 root 横向溢出，长内容在抽屉内滚动。
- 页签、关闭按钮、审批动作均有可感知名称；Tab 留在抽屉内，Escape 只关闭最上层，关闭后焦点回到打开 Run 的控件。
- 进展页不制造视觉进度；执行详情只使用通用安全摘要（生命周期更新/工具活动），不呈现原始工具参数或结果。

## 自动验证

| 门禁 | 结果 |
|---|---|
| Phase 2A 定向 UI / route / a11y / identity | 6 files / 62 tests 通过 |
| Electron 安全投影定向测试 | 1 file / 8 tests 通过 |
| TypeScript typecheck | 通过 |
| ESLint | 通过，0 error；132 条存量 warning |
| Desktop UI 全量 | 755 files / 7,540 tests 通过（4 workers） |
| Electron/platform 全量 | 178 files 通过、2 skipped；2,724 tests 通过、6 skipped |
| Release gates | Node 65 / Vitest 15 通过 |
| `test:desktop:all`（`HERMES_DESKTOP_SKIP_BUILD=1`） | 通过；回读 App、DMG、runtime、install stamp 与 node-pty |
| 打包 E2E | 10/10 通过；含三档真实窗口和双页签 |
| Production build | 通过；install stamp 精确指向截图构建提交 |
| `git diff --check` | 最终提交前后均要求通过 |

默认 worker 数的 UI 全量跑中，`live-thread-module.test.ts` 的动态 import 两次超过其 15 秒上限；同文件单跑 9/9（import 4.7 秒），随后以 4 workers 重跑完整 7,540 项全部通过。没有放宽测试超时或修改该守卫。

## 反向故障注入

每次注入均先验证唯一目标确实落地，观察指定守卫变红，再恢复并重跑绿：

| 注入故障 | 变红守卫 |
|---|---|
| 将后端 `steps` 带入安全投影 | Electron 敏感/伪造阶段字段守卫 |
| 移除事件排序 | 事件顺序守卫，实际回读 `[2, 1]` |
| 将 event payload 带入 renderer | 敏感字段剥离守卫 |
| 移除 Hermes-only executor 拒绝 | 非 Hermes executor 拒绝守卫 |
| 将 `succeeded` 标成可轮询 | 终态停止轮询守卫 |
| 令可见性判断恒真 | 隐藏窗口暂停守卫，调用数由 1 变 5 |
| 刷新失败时清空 overview | 失败保留最近成功数据守卫 |
| 在 document 层捕获 Escape 并关闭外层 | 嵌套 Escape 优先级守卫 |
| 将抽屉宽度改回 `32rem` | 原生/组件 540px 响应式宽度守卫 |

## 构建、签名与发布边界

- 完整 build 与 builder 均清除了 `APPLE_API_*`、`APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`CSC_LINK`、`CSC_KEY_PASSWORD`、`CSC_NAME`，并显式设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`、`npm_config_arch=arm64`。
- builder 命令为 `npm run builder -- --mac dmg --arm64 --publish never`；日志明确显示跳过 macOS application signing、跳过 notarization，目标为 arm64 DMG。
- 主执行文件回读为 Mach-O arm64；只有 linker-generated ad-hoc signature，`TeamIdentifier=not set`、`Sealed Resources=none`，没有 Developer ID Authority。
- Gatekeeper 对该诊断 App 返回未签名拒绝，符合 unsigned/ad-hoc 试用包预期。
- `--publish never` 未上传 artifact，未更新公开 updater feed；本地生成的 `latest-mac.yml` 和 blockmap 均不提交。

## 未覆盖 / No-Go

- 未在生产 `/workflows`、`/catalog` 均返回 200 的环境做 Workflows 完整态最终验收。
- 未增加 Activity/history、Deliverable list/detail 或 Step API；未新增 Run/Deliverable/Review 页面。
- 未验证真实生产交付物预览，因为现有 GET Run 样本没有安全可打开 URL；只验证了本地受控 URL seam 和无目标时的诚实禁用态。
- 未做 Windows 真机或生产发布验收；本批次不得推进 Mac/Windows updater。
- 未修改 ApexNodes、#847 后端、scheduler、relay 或生产服务。
- Phase 3、Phase 1R2、DeepSeek Harness 和生产部署继续 No-Go。
