# hc-831 — Desktop Phase 2B Deliverable / Activity QA

## 范围与基线

- 分支：`codex/hc-831-desktop-phase2b-deliverables`。
- fork 基线：`0453319ce38553a22c621d5157a3c8a47e9a53cc`（hc-820 合并后的 `main`）。
- 版本保持 `0.17.24`；本票不构建公开安装包、不上传、不更新 updater feed。
- 只修改 Mac / Windows 共用的 Desktop Electron bridge、renderer、四语言文案与测试；未修改 ApexNodes 后端、数据库、套餐、Relay、Runtime、生产配置或 DSH。
- 服务端合同以 ApexNodes hc-821 / hc-827 为准；生产 checkout 截至 2026-09-13 尚未包含这三条 Phase 2 GET，因此旧服务端和当前生产必须显示诚实 unavailable，而不是用会话附件或模拟数据替代。

## 真实数据闭环

- `/deliverables` 读取 typed `GET /workflow-domain/deliverables`，展示真实 Deliverable、状态、类型、摘要、证据数、更新时间和游标分页。
- `/deliverables/:deliverableId` 是路由驱动详情抽屉；读取 typed detail 的 `item / project / workflow / run`，展示白名单 payload、highlights、evidence、`sourceCapturedAt`、verifier 和 Review 历史。
- “打开成果”只把 `storageTarget.id` 交给 main；main 使用平台登录态调用现有 `/api/v1/account/files/{id}/download`，验证短链后直接交给系统打开。JWT、`download_url`、storage ref、bucket/path 均不进入 renderer。
- Review 只允许 `approved` / `changes_requested`。需要修改必须有非空且不超过 8000 字符的说明；失败时原输入保留，成功后重新读取权威详情。
- Run 内的交付物动作进入同一个 canonical Deliverable 详情；不再消费旧的直出 storage URL。Approve 仍可走已有 typed Review exit；“需要修改”进入详情填写必填说明。
- `/history` 读取 typed Activity 游标流，按本地 Today / Yesterday / Last seven days / Earlier 分组；Run、Deliverable、Review 均只根据服务端 `{target:{kind,id}}` 映射稳定路由，不从 title/summary 推断目标。
- Deliverable 详情、Run 与 Activity 抽屉均保留背景 location、浏览器 Back/Forward 和安全焦点键；冷 deep link 回落到对应 canonical 列表。

## 安全与出口清单

### Electron / preload

- `electron/apex-workflow-domain.ts`：Deliverable list/detail、Activity 与 user-file download 的唯一传输/投影边界；Hermes-only、字段/长度/状态/UUID 白名单；Review notes 失败关闭。
- evidence URL 在 Desktop 边界再次要求无用户凭据的公共 HTTPS，并拒绝 query、fragment、本地/私网主机；它只作为显示数据，不作为 SSRF fetch 入口。
- user-file 短链只在 main 中存在，允许签名 query；renderer 只见 file UUID 和 `{ok}`。
- `electron/main.ts`、`electron/preload.ts`、`src/global.d.ts`：四个新增 IPC 出口为 list/get/activity/openUserFile；mutation 不回传原始后端对象。

### Renderer

- `src/app/business-workspace/api/{types,adapters}.ts`：typed outcome 和旧 shell unavailable seam。
- `hooks/use-workflow-deliverables.ts`：首次读取、刷新、游标去重、加载更多失败保留和跨筛选 stale-result 隔离。
- `pages/{deliverables-page,deliverable-detail-page,history-page}.tsx`：三个 canonical UI 消费者。
- `pages/workflow-run-page.tsx`：Run → Deliverable canonical 交接。
- `src/app/routes.ts`、`src/app/contrib/surfaces.tsx`：详情 route、背景页、cold deep-link 与 Back/Forward。
- `src/i18n/{zh,zh-hant,en,ja,types}.ts`：四语言对称文案。

### 已检查、无需修改

- ApexNodes hc-821/hc-827：三条读取 API、tenant/relationship guard、safe public projection 与 default-off rollout gate 已存在；本票不重复后端实现。
- Web workflow-domain consumer：未消费这三条新读取，本票不改变 Web。
- user-file owner/re-sign endpoint：复用现有 authenticated ownership 检查；不新增下载 API。
- package version / release workflow：本票不发布，`0.17.24` 不可覆盖当前公开 feed。

## 自动验证

| 门禁 | 结果 |
|---|---|
| 定向 transport / route / UI / identity | 6 files / 89 tests 通过 |
| TypeScript / production build | 通过 |
| ESLint | 0 errors；132 条仓库基线 warning |
| Desktop UI 全量 | 763 files / 7,625 tests 通过 |
| Electron/platform 全量（标准并行执行） | 180 files 通过、2 files skipped；2,753 tests 通过、6 skipped；`remote-lifecycle.test.ts` 中 2 个既有进程时序用例超时 |
| Electron 时序失败复核 | 失败源码/测试相对 fork 基线零 diff；installer-wrapper 相关 3 tests 单独通过，mutex 1 test 单独通过；未放大超时或修改无关测试 |
| `test:desktop:all` | 通过；本地生成并签名 Mac arm64 APEX.app / DMG，未公证、未上传 |
| Release contract gates | 78 Node tests + 15 Vitest 通过 |
| hc-831 packaged E2E | 1/1 通过；覆盖宽/窄窗、Review POST、Activity target、焦点返回与 renderer 敏感字段隔离 |
| 格式/差异 | 目标 Prettier、E2E ESLint `--quiet`、`git diff --check` 通过 |

`npm run check` 因上述两个零 diff 的 `remote-lifecycle` 时序用例仍不是全绿；本报告保留这个事实，不用定向复跑冒充标准门禁通过。

本地 artifact-only 安装态截图：

- `screenshots/deliverable-detail-1220x800.png`：宽窗右侧详情抽屉。
- `screenshots/deliverable-detail-752x800.png`：窄窗无碰撞全屏详情。

## 反向验证

- 先断言 `url.search || url.hash` 目标锚点只有 1 处，再临时撤掉 evidence query 拒绝逻辑：安全投影测试立即因 `https://example.com/source?token=secret` 进入 renderer 而变红；恢复后转绿。
- 先断言 `changes_requested` 空说明目标锚点只有 1 处，再临时撤掉 main 侧必填校验：精确 Review POST 契约测试立即因“未按预期拒绝”而变红；恢复后转绿。
- Activity typed target、deep-link 背景/fallback、renderer 不接收 `download_url` 继续由 identity / route / surfaces 守卫测试覆盖，本轮未对这三项再做源码注入。

## 当前 No-Go

- 无生产部署授权；不改生产。
- 无 Desktop 发布授权；不 bump 版本、不构建或覆盖 `0.17.24` updater。
- 生产尚无 hc-810/hc-821/hc-827 ancestry；在 backend checkout 收敛并获得单独授权前，不能启用真实 Phase 2 reads。
- 本轮只有 Mac arm64 本地 artifact-only 安装态验收；未做 Mac arm64 / x64 + Windows x64 配对发布、Windows 签名或生产账号验收，这些仍是发布门禁。
