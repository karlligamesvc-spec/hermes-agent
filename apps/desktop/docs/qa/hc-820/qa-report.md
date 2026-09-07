# hc-820 — Desktop Phase 2A 真实 Run 抽屉 QA 报告

## 结论

本批次在 PR #262 原精确基线 `0ae743c20aef14da599698ef2921d31b17f6e740` 上开发，分支为 `codex/hc-820-desktop-phase2a-real-run-drawer`，版本保持 `0.17.24`。最新 R4 实包构建提交为 `1082c61b4a582e746823ef233dbeda11c3afb471`，安装戳 `dirty:false`。后续报告/测试修正/截图与堆叠 ancestry 提交必须与此构建身份区分；最终 main 诊断包会从最终 main SHA 重建。R3 的横向留白测试通过，但 Run 纵向位置未通过后续截图复核，R3 截图仅保留为反例，不作为完整视觉验收。

实现限定在 Phase 2A 的真实 Run 右抽屉。R3 审计另获明确授权修复同类缺陷：LegacyProjectsView 唯一的失效 padding 引用；没有改 canonical Projects 布局或数据/业务行为。既有 #261/#262 原分支未夹带此修复。未进入 Phase 3、Deliverable/Review 新页面、ApexNodes 后端、新 API、DeepSeek Harness、发布或部署。

## R4 原生标题栏 / Portal 审计（2026-09-07）

截图复核发现 R3 Run 错误页缩到窗口底部。根因是 Radix body Portal 无法继承 AppShell 子树内的 `--titlebar-height`，`top:var(...)` 因变量缺失失效，抽屉变成按内容高度、底部对齐。现有 OverlayView 已显式传递 `TITLEBAR_HEIGHT`；本次在 ResponsiveRouteDrawer 的 Content 复用相同模式，不改全局 token、Portal 容器或业务数据。非测试业务消费者共两个：WorkflowRunRouteDrawer 与 ProjectDetailRouteDrawer，均纳入验证。

实包守卫在动画稳定后的真实 BrowserWindow 上读取 DOM rect，独立要求 `top=34px`、`bottom=innerHeight`、`height=innerHeight-34px`。除三档原生窗口外，Run 验证 899/900px 断点，Project 验证 1099/1100px 断点；Project 还验证 Escape 后焦点归还原行，再次打开后显式“继续这个目标”才预填 Start。Project 宽度仍使用原有 35rem 上限；fixture 的应用字号为 17px，测试先读取实际 rem，不能误把 1rem 写死为 16px。

反向证据（安装的未修复 R3 App，构建 `4b181e2`）：Run 正常态顶边为 `131.03125px`、错误态 `747px`，两条测试分别失败；Project 顶边为 `329.78125px`，专门测试也失败。组件守卫在修复前因 Portal 上 token 为空失败。修复后两类消费者在所有上述原生尺寸均通过，主窗口宽高精确匹配请求值，显示模式结束后恢复。日志：`/private/tmp/hc820-portal-negative.log`、`/private/tmp/hc820-project-portal-negative.log`、`/private/tmp/hc820-portal-unit-negative.log`、`/private/tmp/hc820-portal-verified.log`。

R4 自动验证：定向 UI/身份层 47 tests；全量 UI **756 files / 7547 tests**；Electron/platform **179 files / 2728 tests**（2 files / 6 tests skipped）；release gates Node **65** + Vitest **15**；typecheck、lint（0 errors / 132 存量 warnings）、production build、`test:desktop:all` 与 `git diff --check` 通过。完整打包 `business-workspace-packaged.spec.ts` **12/12** 通过（55.5s）。初次整份运行的 Project 失败是新测试把 35rem 错算为 560px，实际595px；修正测试的单位换算后原产品代码不变，整份重新通过。

| R4 已检查截图 | 1440×900 | 1220×800 | 752×800 |
|---|---|---|---|
| Run 进展 | [截图](screenshots/after-1082c61-r4/run-progress-1440x900.png) | [截图](screenshots/after-1082c61-r4/run-progress-1220x800.png) | [截图](screenshots/after-1082c61-r4/run-progress-752x800.png) |
| Run 执行详情 | [截图](screenshots/after-1082c61-r4/run-details-1440x900.png) | [截图](screenshots/after-1082c61-r4/run-details-1220x800.png) | [截图](screenshots/after-1082c61-r4/run-details-752x800.png) |
| Run 读取失败 | [截图](screenshots/after-1082c61-r4/run-error-1440x900.png) | [截图](screenshots/after-1082c61-r4/run-error-1220x800.png) | [截图](screenshots/after-1082c61-r4/run-error-752x800.png) |
| canonical Project 详情 | [截图](screenshots/after-1082c61-r4/project-detail-1440x900.png) | [截图](screenshots/after-1082c61-r4/project-detail-1220x800.png) | [截图](screenshots/after-1082c61-r4/project-detail-752x800.png) |
| Legacy Projects | [截图](screenshots/after-1082c61-r4/legacy-projects-1440x900.png) | [截图](screenshots/after-1082c61-r4/legacy-projects-1220x800.png) | [截图](screenshots/after-1082c61-r4/legacy-projects-752x800.png) |

验收路径：①打开 Run，标题/审阅动作正常；②切执行详情，事件与滚动正常；③注入读取失败，诚实错误态和重试完整可见；④打开 Project 概览，标题不重复，摘要未提供时不猜 Run；⑤关闭回原行、显式继续目标，焦点和草稿预填正常。截图不是完整辅助技术合规证明；本轮仅验证已有可访问名称、键盘圈定、Escape 和焦点回落。

R4 App 从 DMG 只读挂载后独立安装到 `/Users/karl/Applications/APEX Phase2A hc-820 portal-1082c61.app`。独立 DMG：`/Users/karl/Applications/APEX Phase2A hc-820 portal-1082c61.dmg`；SHA-256 **`c3a524c5671609d0df58423ff2af96a387f16238d795f01d8230027ed0863c9a`**。安装戳回读完整 commit `1082c61b4a582e746823ef233dbeda11c3afb471`、`dirty:false`；主程序 arm64，`Signature=adhoc`、`TeamIdentifier=not set`，没有 Developer ID Authority。构建遵循下文相同清空签名环境、完整 build、显式 `--mac dmg --arm64 --publish never`；没有 notarize、上传或公开 updater feed 更新。

所有具名 Project/Run/事件/交付物来自明确标注的本地测试 API；错误态来自本地503注入，Legacy兼容列表为空。上述结果不代表生产 catalog 已返回200，也不代表 Windows/macOS x64 实包验收或下一层 Deliverable/Review 页面完成。

首启边界：每次 fixture 使用新建 userData，真实点击“使用自己的密钥”及“稍后再选择提供方”，随后通过真实 managed signIn bridge 登录受控本地评审服务；这不是生产登录/扫码验收。测试显式设置100%缩放，并调整评审窗口透明度以稳定截图；不能据此宣称覆盖所有用户缩放与系统显示模式。正式生产账号、实际 LLM 计费及独立 VoiceOver 全流程仍未覆盖。

## R3 合并前留白审计（2026-09-07）

全仓 `--page-inset-x` 有三个引用、零个定义：Run 正常态、Run 首次读取错误态、Legacy Projects fallback。三个出口均改为现有 `PAGE_INSET_X`；没有新增 CSS token。组件测试覆盖正常态、失败后重试和 Legacy loading。实包测试独立读取 computed padding、真实内容边界、页面/容器 scrollWidth，并检查原生窗口宽高；没有从被测常量计算期望值。

| 原生窗口 | 三个出口的实际左/右 padding | root clientWidth / scrollWidth |
|---|---|---|
| 1440×900 | 57.6px / 57.6px | 1440 / 1440 |
| 1220×800 | 48.8px / 48.8px | 1220 / 1220 |
| 752×800 | 30.08px / 30.08px | 752 / 752 |

反向验证使用未修复的 R2 安装 App（`f6953d4`）：三个出口分别由实包几何守卫捕获 `paddingLeft=0`，预期至少 20px，3/3 失败。相同守卫在 R3 安装 App 上 3/3 通过，每条测试覆盖三档窗口。初次验证还发现 macOS 可用桌面会把请求 900 高度限制为 870；该轮不是有效的 900 高度证据。之后只在测试期间把显示空间从 1512×982 临时调至 1800×1169，取得真实 1440×900 原生 bounds，测试结束恢复原显示模式。没有修改产品窗口逻辑。旧 R2 标称 1440×900 截图没有高度相等守卫，本报告不将其当作精确 900 高度证明。

| R3 截图 | 1440×900 | 1220×800 | 752×800 |
|---|---|---|---|
| Run 进展 | [截图](screenshots/after-4b181e2-r3/run-progress-1440x900.png) | [截图](screenshots/after-4b181e2-r3/run-progress-1220x800.png) | [截图](screenshots/after-4b181e2-r3/run-progress-752x800.png) |
| Run 执行详情 | [截图](screenshots/after-4b181e2-r3/run-details-1440x900.png) | [截图](screenshots/after-4b181e2-r3/run-details-1220x800.png) | [截图](screenshots/after-4b181e2-r3/run-details-752x800.png) |
| Run 读取失败 | [截图](screenshots/after-4b181e2-r3/run-error-1440x900.png) | [截图](screenshots/after-4b181e2-r3/run-error-1220x800.png) | [截图](screenshots/after-4b181e2-r3/run-error-752x800.png) |
| Legacy Projects | [截图](screenshots/after-4b181e2-r3/legacy-projects-1440x900.png) | [截图](screenshots/after-4b181e2-r3/legacy-projects-1220x800.png) | [截图](screenshots/after-4b181e2-r3/legacy-projects-752x800.png) |

R3 自动验证：定向 51 tests；typecheck 通过；lint 0 errors / 132 存量 warnings；Desktop UI 756 files / 7546 tests；Electron/platform 179 files / 2728 tests（2 files / 6 tests skipped）；release gates Node 65 + Vitest 15；production build、`test:desktop:all` 与 `git diff --check` 通过。整份 `business-workspace-packaged.spec.ts` 12/12 通过（50.2s）：开始页单输入、三页本地数据、原生窄窗导航、真实 chat fallback、项目详情、模板编辑/启动前确认、Profile/Settings，以及三个留白出口。原生 Run 验证包括左右留白、无横向溢出、双页签、审阅首屏顺序、滚动回顶与焦点回落。

R3 App 从 DMG 只读挂载后独立安装到 `/Users/karl/Applications/APEX Phase2A hc-820 inset-4b181e2.app`。独立 DMG 为 `/Users/karl/Applications/APEX Phase2A hc-820 inset-4b181e2.dmg`，SHA-256 `a1b85c56fc2af7b1e3f25e52ddc4bfaec4a925583f9a2e775c5f82e8f4e3a3bd`。执行完整 build 后显式运行 `npm run builder -- --mac dmg --arm64 --publish never`；清除全部 `APPLE_*`、`CSC_*`、`NOTARIZE_*`，显式 `CSC_IDENTITY_AUTO_DISCOVERY=false` 与 `npm_config_arch=arm64`。日志确认跳过签名/notarization；回读主程序为 arm64、`Signature=adhoc`、`TeamIdentifier=not set`，无 Developer ID Authority。未上传或更新公开 updater feed。

数据均来自标有“本地测试”的受控 API；Run 错误态为本地注入 503，Legacy fallback 使用测试环境真实读取出的空状态。没有新的生产验收结论；生产 Workflow catalog、Windows 真机、Mac x64 实包与 canonical Deliverable 完整链仍未覆盖。下文 R1/R2 结果保留为历史证据。

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
