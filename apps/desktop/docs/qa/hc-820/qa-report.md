# hc-820 — Desktop Phase 2A 真实 Run 抽屉 QA 报告

## 结论

本批次在冻结的 Draft PR #262 精确基线 `0ae743c20aef14da599698ef2921d31b17f6e740` 上完成，分支为 `codex/hc-820-desktop-phase2a-real-run-drawer`，版本保持 `0.17.24`。R2 审计修复与截图构建提交为 `f6953d4aeb25a0f7e522e47d9278fcf9ca5c99a8`；其后的最终交付提交只增加本报告与截图，避免构建提交自引用。

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
- `src/app/business-workspace/pages/workflow-run-page.tsx`：进展/执行详情两个页签；`waiting_review` 时把真实待审阅交付物和主动作置于第一个业务区；无 Step API 时显示紧凑且诚实的生命周期说明；仅 `waiting_review` 可审批/要求修改；取消与打开交付物均按能力可用性显隐或禁用。切回进展和切换 Run 时回到顶部。
- `src/app/contrib/surfaces.tsx`：`/workflows/runs/:runId` 使用路由驱动右抽屉，冷启动/关闭回落到 Workflows。
- `src/app/overlays/responsive-route-drawer.tsx`：Run 在 900px 以上使用 `min(540px, 100vw - 16px)` 右抽屉，在 899px 及以下占满标题栏下方的窗口；打开时把初始焦点放在 dialog 自身，避免 Radix 自动聚焦页签触发浏览器滚动；原生窗口 resize 重置内部滚动顶部。复用 Radix modal 的焦点圈定、分层 Escape 和焦点恢复。Project 抽屉语义保持不变。
- `src/components/ui/tabs.tsx`、`DESIGN.md`：补齐共享 TabsContent primitive 及设计约束。
- `src/i18n/{zh,zh-hant,en,ja,types}.ts`、`view-model/display-status.ts`：四语言 Run 文案与状态映射；排队、开始和工具活动改为可读的业务摘要，尝试次数改为自然语言；未知服务端状态不直接回显原始值。

### 守卫与打包验收

- `electron/apex-workflow-domain.test.ts`：恶意原始 fixture、Hermes-only、安全排序和字段剥离。
- `src/app/business-workspace/hooks/use-workflow-run.test.tsx`：3 秒轮询、隐藏暂停、恢复刷新、终态停止、失败保留缓存和 stale request。
- `src/app/business-workspace/workflow-run-view.test.tsx`：双页签、诚实空态、允许动作与真实打开目标。
- `src/app/business-workspace/workflow-run-copy.test.ts`：四语言排队/开始/工具/尝试次数文案守卫。
- `src/app/overlays/responsive-route-drawer.test.tsx`：Run 的 899/900px 断点、初始 scrollTop、resize 重置、焦点陷阱、嵌套 Escape 与焦点回落。
- `src/identity-layer.test.tsx`：APEX/Hermes 身份边界、renderer 不接收原始 mutation 响应。
- `e2e/python-prerequisite.ts`、`python-prerequisite.unit.test.ts`：打包 source-runtime E2E 优先使用显式 Python override，其次验证当前 checkout 或主 checkout 的 repo venv；没有 Python 3.10+ 与 Hermes runtime 依赖时在启动 Electron 前清晰失败，不回退 `/usr/bin/python3`。
- `e2e/business-workspace-packaged.spec.ts`：安装包、干净 userData、受控本地 Run API、三档真实 Electron BrowserWindow、两页签、数据安全、初始/切页/resize 滚动、审阅首屏顺序、焦点和截图。

## 数据口径与安全边界

- 截图和打包 E2E 的 Project、Run、事件与交付物来自受控本地 API，标题和目标明确标注 `[本地测试]`；它们不是生产数据。
- fixture 故意包含乱序事件、伪造 `steps`、原始 payload、用户标识和敏感配置，用来证明 Electron 白名单投影会排序并剥离它们，而不是把测试结构当产品数据。
- 当前真实 GET Run 合同没有 Step。进展页因此只显示“暂时没有可展示的阶段进度”，没有推测阶段、百分比、步骤、来源数量或待处理事项。
- Review/Deliverable 只使用 GET Run 已返回的真实嵌套数据；审批动作仅在 `waiting_review` 出现。无安全 URL 时“打开结果”明确不可用，不把服务器路径伪装成可打开目标。
- executor 只接受 `hermes`。页面没有宣称或展示 DeepSeek Harness 已接入。
- 生产 `/workflows`、`/catalog` 仍未完成 200 环境的最终验收；本批次不把本地 catalog 结果写成生产结论。

## 原生窗口视觉验收

截图来自独立安装的 arm64 App、每次新建的 userData 和真实 `BrowserWindow.setBounds`，不是 renderer-only viewport。测试服务返回值均标有“本地测试”。

R1 审计前截图保留在 `screenshots/after-ca6fa3f/`；R2 修正后截图如下：

| 页签 | 1440×900 | 1220×800 | 752×800 |
|---|---|---|---|
| 进展 | [R2 截图](screenshots/after-f6953d4-r2/run-progress-1440x900.png) | [R2 截图](screenshots/after-f6953d4-r2/run-progress-1220x800.png) | [R2 截图](screenshots/after-f6953d4-r2/run-progress-752x800.png) |
| 执行详情 | [R2 截图](screenshots/after-f6953d4-r2/run-details-1440x900.png) | [R2 截图](screenshots/after-f6953d4-r2/run-details-1220x800.png) | [R2 截图](screenshots/after-f6953d4-r2/run-details-752x800.png) |

- 1440×900、1220×800：右抽屉宽 540px，底层 Workflows/Start 业务上下文保留并被 modal 遮罩。
- 752×800：Run 占满标题栏下方的窗口，不再保留无效的 212px 模糊区；macOS traffic-light 安全区保留，无 root 横向溢出，长内容在 Run 内滚动。
- 三档打开、切回进展、窗口 resize 后 `scrollTop === 0`，标题完整可见；`waiting_review` 的审阅动作在阶段说明之前且处于首屏。
- 页签、关闭按钮、审批动作均有可感知名称；初始焦点在 dialog，Tab 留在抽屉内，Escape 只关闭最上层，关闭后焦点回到打开 Run 的控件。
- 进展页不制造视觉进度；无真实 Step 的说明高度小于 160px。执行详情用不同文案说明排队、开始和工具活动，不呈现原始工具参数或结果。

## 自动验证

| 门禁 | 结果 |
|---|---|
| R2 定向 UI / route / a11y / identity / Python prerequisite | 5 files / 53 tests 通过 |
| Electron 安全投影定向测试 | 1 file / 8 tests 通过 |
| TypeScript typecheck | 通过 |
| ESLint | 通过，0 error；132 条存量 warning |
| Desktop UI 全量 | 756 files / 7,545 tests 通过 |
| Electron/platform 全量 | 179 files 通过、2 skipped；2,728 tests 通过、6 skipped |
| Release gates | Node 65 / Vitest 15 通过 |
| `test:desktop:all`（`HERMES_DESKTOP_SKIP_BUILD=1`） | 通过；回读 App、DMG、runtime、install stamp 与 node-pty |
| R2 打包 E2E | 定向 1/1 通过；一条测试内覆盖三档真实窗口、双页签、滚动/顺序/焦点 |
| Production build | 通过；install stamp 精确指向 `f6953d4aeb25` |
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
| 删除 `onOpenAutoFocus`，恢复 Radix 自动聚焦 | dialog 初始焦点/`scrollTop` 守卫，实际焦点回到关闭按钮 |
| 把 Run 断点改回 640px | 899/900 断点守卫，实际收到 `(min-width: 640px)` |
| 把阶段空态移到待审阅之前 | `waiting_review` 首个业务区与主动作顺序守卫 |
| 删除紧凑 Step 空态标记 | 紧凑空态结构守卫 |
| 把 queued 摘要恢复为通用生命周期文案 | 四语言 Run 文案守卫 |
| 无兼容 repo venv 时回退 Node 可执行文件 | Python prerequisite 必须 fail-before-launch 守卫 |

## 构建、签名与发布边界

- 完整 build 与 builder 均清除了 `APPLE_API_*`、`APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`CSC_LINK`、`CSC_KEY_PASSWORD`、`CSC_NAME`，并显式设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`、`npm_config_arch=arm64`。
- builder 命令为 `npm run builder -- --mac dmg --arm64 --publish never`；日志明确显示跳过 macOS application signing、跳过 notarization，目标为 arm64 DMG。
- 主执行文件回读为 Mach-O arm64；只有 linker-generated ad-hoc signature，`TeamIdentifier=not set`、`Sealed Resources=none`，没有 Developer ID Authority。
- Gatekeeper 对该诊断 App 返回未签名拒绝，符合 unsigned/ad-hoc 试用包预期。
- `--publish never` 未上传 artifact，未更新公开 updater feed；本地生成的 `latest-mac.yml` 和 blockmap 均不提交。
- 独立 App：`/Users/karl/Applications/APEX Phase2A hc-820 f6953d4.app`。
- 独立 DMG：`/Users/karl/Applications/APEX Phase2A hc-820 f6953d4.dmg`；SHA-256 `3396a21c396567e9a8026d0417d6a36af7e6ac58ab8b05781e7f0020b845363e`。

## 打包 E2E 可复现命令与 Python 前置条件

本次刻意不设置 Python override，fixture 从 worktree 的 `.git` 指针解析主 checkout，并验证其 `.venv/bin/python` 为 Python 3.10+ 且可导入 `hermes_cli.main`。若机器没有兼容 repo venv，命令会在 Electron 启动前失败，并提示设置 `HERMES_DESKTOP_PYTHON`；不会再落到 macOS `/usr/bin/python3` 3.9。

```bash
cd /Users/karl/projects/.wt/hc820-desktop-phase2a-real-run-drawer/apps/desktop
env -u HERMES_DESKTOP_PYTHON \
  HERMES_DESKTOP_PACKAGED_BINARY='/Users/karl/Applications/APEX Phase2A hc-820 f6953d4.app/Contents/MacOS/APEX' \
  HC820_SCREENSHOT_DIR=/private/tmp/apex-hc820-r2.f6953d4 \
  npx playwright test e2e/business-workspace-packaged.spec.ts \
  --grep 'packaged real Run drawer preserves context'
```

## 未覆盖 / No-Go

- 未在生产 `/workflows`、`/catalog` 均返回 200 的环境做 Workflows 完整态最终验收。
- 未增加 Activity/history、Deliverable list/detail 或 Step API；未新增 Run/Deliverable/Review 页面。
- 未验证真实生产交付物预览，因为现有 GET Run 样本没有安全可打开 URL；只验证了本地受控 URL seam 和无目标时的诚实禁用态。
- 未做 Windows 真机或生产发布验收；本批次不得推进 Mac/Windows updater。
- 未修改 ApexNodes、#847 后端、scheduler、relay 或生产服务。
- Phase 3、Phase 1R2、DeepSeek Harness 和生产部署继续 No-Go。
