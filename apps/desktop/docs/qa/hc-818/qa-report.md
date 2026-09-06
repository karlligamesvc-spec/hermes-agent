# hc-818 — Desktop 共享壳层、Profile 与 Settings QA 报告

## 结论

本批次在冻结的 Draft PR #261 精确基线 `ce8b9e127f84bb59c642218457ba97bedaab2eb1` 上完成。实现提交为 `f7c0491bb672d704d8fb9b4d2dd8f37558954469`；最终交付提交是在其上仅增加本报告与截图的 PR #262 当前 HEAD。版本保持 `0.17.24`，分支为 `codex/hc-818-desktop-shared-profile-settings`，PR #262 保持 Draft。

未修改 Start、Projects、Workflows 的行为或 API，也未进入 Run / Deliverable / Review、Phase 2 或 DeepSeek Harness。未改 scheduler、relay、发布工作流或 updater feed；未合并、未部署、未发布。

## 票号与基线

- 新票号：`hc-818`。
- 建分支前已检查 ApexNodes 全 refs/PR、`karlligamesvc-spec/hermes-agent` 全 refs/PR，以及飞书 PD Sheet1 L 列。
- 飞书检查范围：`apex!L1:L933`，revision `6902`；`hc-817` 位于第 763 行，`hc-818` 当时不存在。
- 工作树：`/Users/karl/projects/.wt/hc818-desktop-profile-settings`，未与 #261 或其他 Session 共用。
- 基线：Draft PR #261 @ `ce8b9e127f84bb59c642218457ba97bedaab2eb1`。

## 文件出口清单

### 共享壳层与路由

- `src/app/overlays/overlay-view.tsx`：改为命名的 modal dialog；增加焦点圈定/恢复、背景滚动锁、Escape 分层与紧凑全屏布局。
- `src/app/overlays/account-surface-header.tsx`：新增 Profile / Settings 共用的 APEX 账户层标题栏。
- `src/app/overlays/overlay-split-layout.tsx`：宽窗内容上限与 752px 原生窗口紧凑断点。
- `src/app/shell/hooks/use-overlay-routing.test.tsx`：钉住 path/search/hash 精确回落。
- `src/app/chat/sidebar/account-panel.tsx`：账户入口辅助功能名称包含动作意图与真实姓名。
- `src/app/contrib/wiring.tsx`、`src/app/desktop-controller.tsx`：两条真实 renderer 入口均接通 Profile → Settings。

### Profile

- `src/app/profile/index.tsx`：真实账户层级、真实 analytics、诚实空态/错误重试、账户详情、Settings 入口与热图键盘操作。
- `src/app/profile/index.test.tsx`：覆盖完整、稀疏、未登录、零会话、错误/重试、Settings handoff 与热图 roving focus。

### Settings

- `src/app/settings/index.tsx`：在流式标题/搜索、客户 IA、真实内容分发与隐藏技术深链。
- `src/app/settings/constants.ts`：`connections` 兼容别名正确落到 Gateway。
- `src/app/settings/primitives.tsx`：可滚动内容区稳定 QA 锚点。
- `src/app/settings/index.test.tsx`：中文 IA、兼容别名、隐藏 About 深链。
- `src/i18n/{zh,en,types}.ts`：客户可见 Browser/APEX 文案与类型对齐。

### 保留出口与守卫

- `src/developer-outlets.test.ts`：Terminal pane/actions 与 file-tree pane/titlebar 入口必须继续存在。
- `src/identity-layer.test.tsx`：APEX 身份层、版本来源与客户可见文案。
- `src/app/command-center/delete-confirm.test.tsx`：嵌套 dialog 的 Escape 优先级。
- `e2e/business-workspace-packaged.spec.ts`：真实打包 App 的三档原生窗口、焦点、滚动与可达性；串行长任务在用例结束时通过主 composer 停止，避免污染后续 Overlay 验收。
- `src/styles.css`：仅限本批次 Profile / Settings 作用域样式。

受保护业务出口的基线差异为空：

```text
apps/desktop/src/app/business-workspace/**
apps/desktop/src/api/workflow-domain.ts
apps/desktop/src/store/business-workspace.ts
```

Terminal 与文件树均未删除；隐藏技术 Settings 仍可深链访问。

## 视觉验收

参考：

- `profile-usage-modal-1235x1024.png`
- `settings-modal-1235x1024.png`
- `profile-usage-existing.png`
- `APEX-DESKTOP-UI-REDESIGN-SPEC-2026-09.md`
- `APEX-DESKTOP-UI-REDESIGN-IMPLEMENTATION-2026-09.md`

截图来自独立安装的打包 App、干净 userData 与真实 Electron `BrowserWindow.setBounds`，不是 renderer-only viewport。截图构建提交为 `b21ffa0a73fc917eecc328a7040db4211de835b4`；其后 `f7c0491bb6` 仅稳定 E2E 的长任务收尾，不改变产品 UI。

| 页面 | 1440×900 | 1220×800 | 752×800 |
|---|---|---|---|
| Profile | [截图](screenshots/after-b21ffa0/profile-1440x900.png) | [截图](screenshots/after-b21ffa0/profile-1220x800.png) | [截图](screenshots/after-b21ffa0/profile-752x800.png) |
| Settings | [截图](screenshots/after-b21ffa0/settings-1440x900.png) | [截图](screenshots/after-b21ffa0/settings-1220x800.png) | [截图](screenshots/after-b21ffa0/settings-752x800.png) |

### 与批准原型的差异

- Profile 保留原型的标题—身份—指标—活动热图—账户信息层级，但只呈现真实返回的会话、Token 与 API 调用；没有真实 active days / skills 时不复制原型的固定数字。真实数据为稀疏时，卡片数量随数据收敛而不是硬补五张。
- Profile 使用现有 APEX 产品字体、颜色、圆角与底层导航；账户详情只读，未复制原型中尚无真实 API 支撑的“编辑资料”、时区、加入时间或安全状态。
- Settings 保留原型的标题、分栏导航、内容卡片与紧凑节奏，但内容来自现有真实 Settings store / IPC；未复制原型的假开关或假默认值。原型只展示少量概念分区，实包保留 Personalization、Appearance、Browser、Providers、Archived Chats 及技术深链。
- 1440 与 1220 档分别限制在 1040px（Profile）/ 1024px（Settings），避免超宽内容；752 原生窗口在产品默认 90% 缩放下对应约 836 CSS px，因此断点按原生窗口体验校准到 `53rem`，并用 `!p-0` 压过后置 `sm:p-*`，确保真正贴合窗口而非残留 49px inset。
- 三档均无 root 横向溢出；752 档 Settings 使用紧凑分类选择器，Profile 热图只在自身区域处理密度；关闭入口与 traffic-light 安全区不冲突。

## 数据口径

- 账户身份、Projects 与 Workflow catalog：由本地受控评审服务提供，名称、邮箱与业务数据均明确包含“本地测试”或 `.local.test`，不得视为生产数据。
- Profile usage：来自干净 userData 中启动的真实本地 Hermes analytics API；前序打包用例实际创建 1 个本地会话，因此“会话 1”是本地真实生命周期结果。该路径没有真实 LLM 计费调用，所以 Token/API 为真实 `0`，不是模拟百分比或填充数字。
- Profile 缺少的 skills、active days 等模块直接省略；无会话时显示一个诚实空态；错误态保留 Retry。
- Settings：读取现有真实本地 store / IPC。SOUL.md 内容是当前测试 userData 的本地配置，不是生产账户数据。
- 生产 Workflows `/workflows`、`/catalog` 最终完整态不在本批次验收范围，仍需生产接口返回 200 后另验；本批次没有宣称 DeepSeek Harness 已接入。

## 自动验证

| 门禁 | 结果 |
|---|---|
| TypeScript typecheck | 通过 |
| ESLint | 通过，0 error；131 条存量 warning |
| Desktop UI 全量 | 754 files / 7,531 tests 通过 |
| Electron/platform | 178 files 通过、2 skipped；2,722 tests 通过、6 skipped |
| Release gates | Node 65 / Vitest 15 通过 |
| `test:desktop:all`（`HERMES_DESKTOP_SKIP_BUILD=1`） | 通过；回读 app、DMG、runtime、install stamp 与 node-pty |
| 打包 E2E | 9/9 通过；含 1440×900、1220×800、752×800 原生窗口 |
| Production build | 通过；install stamp 精确指向构建 commit |
| `git diff --check` | 通过 |
| 受保护 Phase 1 业务文件差异 | 空 |

打包 E2E 显式使用 `/Users/karl/.hermes/hermes-agent/venv/bin/python`。宿主 `/usr/bin/python3` 为 3.9，无法解析当前 runtime 的 `str | None`；ApexNodes `.venv` 虽为 3.12，但缺少 runtime 所需的 `rich`。两次均在 UI 启动前失败，改用实际 Hermes runtime venv 后 9/9 通过。

## 反向故障注入

每次注入前均以唯一锚点确认命中，观察守卫变红后恢复，并重新跑绿：

| 注入故障 | 变红守卫 |
|---|---|
| `max-[53rem]:!p-0` 改为 `!p-1` | 752px compact overlay 守卫 |
| 移除 `connections` → Gateway alias | Settings compatibility route |
| 零会话判断改为不可达条件 | Profile 诚实空态 |
| 中文“浏览器”退回 `Browser` | 中文客户 IA / identity |
| 账户菜单 Profile 指向 Settings | 精确账户路由 |
| 移除 Terminal action 注册 | developer outlets |
| `aria-modal=true` 改为 false | Overlay accessibility |
| APEX app version 改读 engine version | About/version separation（3 项失败） |

## 构建、签名与发布边界

- 完整 build 与 builder 均清除了 `APPLE_API_*`、`APPLE_ID*`、`APPLE_TEAM_ID`、`CSC_LINK`、`CSC_KEY_PASSWORD`、`CSC_NAME`，并设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`、`npm_config_arch=arm64`。
- builder 命令为 `npm run builder -- --mac dmg --arm64 --publish never`；日志明确显示 `skipped macOS application code signing`、`Skipping notarization` 与 `target=DMG arch=arm64`。
- 产物主执行文件为 Mach-O arm64；回读只有 linker-generated ad-hoc signature，`TeamIdentifier=not set`、`Sealed Resources=none`，不存在 Developer ID Authority。
- `--publish never` 未上传任何 artifact，未写公开 updater feed。`latest-mac.yml` / blockmap 仅为本地 builder 输出且未提交。
- 一次早期本地 `test:desktop:all` 误在未清签名环境下启动，检测到了 Developer ID；在签名阶段立即中断，不完整 App 已移到 `~/.Trash/APEX-hc818-interrupted-developer-id-20260906.app`。该次没有 notarize、上传、公开 feed 变更，也没有进入最终交付。此后所有 build/builder/desktop checks 均显式清除签名变量。
- 最终独立 App、DMG SHA-256 与精确最终 HEAD 记录在 Draft PR #262 的交付说明中，以避免 QA 文件自引用造成 commit/hash 循环。

## 未覆盖 / No-Go

- 未在生产 `/workflows`、`/catalog` 200 环境复验 Workflows 完整态。
- 未做 Windows 真机验收；本批次不是生产发布，不能据此推进 Mac/Windows updater。
- 未修改或复验 #847 后端 ancestry 收敛；它与本 UI 分支独立。
- Phase 1R2 / Phase 2、DeepSeek Harness、Run / Deliverable / Review 新 API 均为 No-Go。
