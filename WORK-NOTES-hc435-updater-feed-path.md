# WORK-NOTES · hc-435 壳自更新 feed 路径错位修复(P1,阻塞 0.16.3 真自更新)

Branch: `fix/hc435-updater-feed-path` · fork `karlligamesvc-spec/hermes-agent`
Goal(票面):electron-updater 读根目录 `desktop/latest-mac.yml` = 404 → 壳自更新从未生效;修成 arch-aware 子目录 feed + 救存量用户。

---

## ★ 头号结论(实测推翻票面前提):治本(arch-aware setFeedURL)0.16.1 就已上线,壳自更新在 0.16.2 是好的

票面诊断的「症状」(根目录 404)属实,但「壳自更新从未生效」不成立 —— 那份诊断基于一个**早于 0.16.1 发车 seat 落地 setFeedURL 的旧快照**。真相:

- `apps/desktop/electron/shell-updater.cjs:122`(自 **0.16.1 首个 shell-updater 提交 9790955aa / PR #48** 起就在)运行时按平台-架构调
  `autoUpdater.setFeedURL({ provider:'generic', url: <base>/mac-<arch> })`。
  `shellUpdateFeedUrl()`(:29)映射 darwin/arm64→`mac-arm64`、darwin/x64→`mac-x64`、win32→`win-x64`。
- electron-updater 6.8.x 契约(读**已装源码** `node_modules/electron-updater/out/`,非猜):
  - `AppUpdater.setFeedURL` 直接 `clientPromise = Promise.resolve(provider)`,**完全盖过**打包进 app-update.yml 的根 feed;`configOnDisk`(=app-update.yml)仅在**从未调过** setFeedURL 时才读。
  - `GenericProvider`:`baseUrl = newBaseUrl(url)`(`util.js` 自动补尾斜杠),`getLatestVersion()` 取 `newUrlFromBase('latest-mac.yml', baseUrl)` = `<url>/latest-mac.yml`;`resolveFiles` 也相对 `baseUrl` 解析 zip/exe。
  - 时序:`setFeedURL` 在 `createShellUpdater` 里**同步**执行(app ready),远早于 60s 延迟的首个 `checkForUpdates`;electron-updater **从不自发检查**。→ 打包的根 app-update.yml **永不被读**。

### 实测(2026-07-06,curl + 跑真 electron-updater util 走一遍解析)
- 根目录:`desktop/latest-mac.yml` → **404**、`desktop/latest.yml` → **404**(故意为空,红鲱鱼)。
- 子目录:`desktop/mac-arm64/latest-mac.yml`、`mac-x64/…`、`win-x64/latest.yml` → **均 200**(version 0.16.2)。
- 子目录里 **0.16.1 和 0.16.2 两个 zip 都在**(`APEX-0.16.1-mac-arm64.zip` + `0.16.2` 均 200)。
- 端到端证明脚本(用**已装的** `electron-updater/out/util.js` 的 `newBaseUrl/newUrlFromBase/getChannelFilename`,即 GenericProvider 真实路径 + 真 HTTP):三个 arch 的 **channel yml HTTP 200 + 首个安装包文件 HTTP 200**。
  → 已装 0.16.2 的壳,自更新会正确解析到各自子目录 feed 和安装包。

## 存量救法(fix ②)诚实结论:不需要,且有害 —— 不做

- 「把 latest-mac.yml 也传一份到根目录救存量」的前提是**存量 app 读根目录**。但**没有任何已发布版本读根目录**:0.16.1 是史上第一个 shell-updater 版本,它本就带 arch-aware setFeedURL。
- 0.16.1 / 0.16.2 的 arm64+win 存量用户**现在就正确读子目录**(实测 200)。
- 往根目录传 arm64+x64 同名 `latest-mac.yml` = **正是这套 per-arch 布局要避免的互覆盖**(后传架构盖掉先传的,其 updater 在错 arch 的 files 列表里找不到 zip)。故**主动不做**,并在两个发版 yml 头注钉死「根目录故意为空,别去『修』这个 404」。

## 0.16.2 → 0.16.3 这一跳能否自动(票面要的诚实结论)
- **arm64:能**,无需任何代码改动。已装 0.16.2 壳读 `desktop/mac-arm64/latest-mac.yml`;PM 发 0.16.3 时把该子目录 feed 更新到 0.16.3 即可自动下载+「重启以更新」。
- **x64 / win-x64:同样能**(各读自己子目录)。
- 唯一前提:0.16.3 发版流水线把 feed 传到**同样的 per-arch 子目录**(现有 desktop-macos.yml / desktop-windows.yml 已就是这么传的 `desktop/mac-<arch>/` / `desktop/win-x64/`)。

## PM 提示的「第二个 updater」是**引擎更新**,与本票无关
- `main.cjs:2058 repairMacUpdaterHelper(updater)` + `:2255` 的 `updater` = `resolveUpdaterBinary()` 拿到的**暂存 Tauri `hermes-setup` 二进制**(runtime/引擎更新的 hand-off),不是 electron-updater。
- 菜单「Check for Updates…」(`main.cjs:3904`)→ `sendOpenUpdatesRequested()` → 引擎更新 UI,也不是 electron-updater。
- 全仓 electron-updater 只有一处实例:`initShellUpdater → createShellUpdater`,已正确。

---

## 本 PR 实际改了什么(治本已在 → 加护栏 + 钉不变量,防静默回归)

既然治本已上线且实测好用,正确动作**不是**堆无用的根目录上传(死重 + 重新引入互覆盖),而是把「feed 必须落 per-arch 子目录、根目录故意空」这个命门用护栏和不变量钉死,防将来有人「简化」回根 feed。

1. `shell-updater.cjs`
   - `shellUpdateFeedUrl`:空 `arch` **直接抛**(带解释),绝不让 feed 塌成 `base/` + 空段的根 feed;补命门注释(hc-435)。
   - `createShellUpdater`:算 feedUrl 包 try/catch —— 抛则**整体降级为 disabled**(状态=disabled,胶囊不出),既不去读 404 根 feed,也不因异常 arch 把 `initShellUpdater` 带崩(守住「自更新故障绝不拦启动」契约)。
2. `shell-updater.test.cjs` 新增 3 条回归:
   - feed **永不等于/塌回**裸 base,必须以 `/(mac|win|linux)-(arm64|x64)` 结尾。
   - 空 arch 抛 `missing arch`(不产出根 feed)。
   - packaged 但 arch 不可解析 → 降级 disabled、**从未 setFeedURL**、不崩、有日志。
3. `desktop-macos.yml` / `desktop-windows.yml` 头注:显式写明**根目录 `desktop/latest-*.yml` 故意为空(404 是预期)**,别为「修」这个 404 往根目录传(=互覆盖);已端到端验证各 arch 子目录 feed+安装包均 200。
4. `apps/desktop/package.json`:**不改**。`build.publish.url` 停在 `desktop/` 根仅用于**打包期**让 electron-builder 生成 yml/blockmap,运行时以 setFeedURL 覆盖为准(JSON 无注释,权威说明在 `shell-updater.cjs` 头注,已充分)。

## 验证记录
- `npm ci`(root workspace,worktree 内真装 deps)EXIT 0。
- `npm run typecheck`(= `tsc -p . --noEmit`,CI typecheck.yml 门)**EXIT 0**。
- `npm run build`(= assert-* + `tsc -b` + vite build + postbuild,CI typecheck.yml 的 desktop-build 门)**EXIT 0**。
- `node --test electron/shell-updater.test.cjs`:**14/14 pass**(含新增 3 条)。改动文件 `npx eslint electron/shell-updater.*` **零告警**。
  （注:仓库 desktop JS 无 CI eslint 门 / 无 CI node --test 门 —— `ci.yml` 对 desktop 只跑 TypeScript;origin/main 本就有 28 条 pre-existing eslint error 在 main.cjs/src,非本 PR 引入,不阻塞。）

## 给 PM 的 0.16.3 发版清单
1. bump `apps/desktop/package.json` version → `0.16.3`(本 PR 不 bump)。
2. dispatch `Desktop macOS build` + `Build ApexNodes Desktop (Windows)`(带 COS secrets)→ 产物+feed 落 `desktop/mac-arm64|mac-x64|win-x64/`(现有 yml 已如此)。
3. 更新官网三链(client bundle)指向 0.16.3 包(和历来一样,web 仓单独同步)。
4. 无需任何根目录操作。发版后已装 0.16.2(arm64/x64/win)会在下个检查周期自动下载 0.16.3 + 出「重启以更新」胶囊。

## 阻塞项
- 无代码阻塞。真机端到端确认「0.16.2 自动升 0.16.3」需 PM 真发一次 0.16.3(把某子目录 feed 推到 0.16.3),我这侧已实测证明 0.16.2 壳会解析到子目录 feed+安装包(均 200),机制成立。
