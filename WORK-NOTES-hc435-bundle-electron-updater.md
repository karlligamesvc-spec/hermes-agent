# WORK-NOTES · hc-435 真因修复:electron-updater 没打进 app asar/resources(P0)

Branch: `fix/hc435-bundle-electron-updater` · fork `karlligamesvc-spec/hermes-agent`
Goal:壳自更新从 0.16.1 起从未生效(用户 0.16.2 实测日志铁证)。真因 = `require('electron-updater')` 在打包 app 里抛 `Cannot find module` → `autoUpdater=null` → shell-updater 整体 disabled。修成:把 electron-updater + 全依赖闭包随包发出去,`require` 兜底从 `process.resourcesPath` 解析。

---

## ★ 真因(源码级钉死,非猜)

用户 0.16.2 app 日志(`~/.apexnodes/logs/desktop.log`):
```
[shell-update] electron-updater unavailable (disabled): Cannot find module 'electron-updater'
[shell-update] disabled (dev / unpackaged build)
```

`electron/main.cjs:initShellUpdater()` → `require('electron-updater')` 抛 → `autoUpdater=null`
→ `createShellUpdater({autoUpdater:null})` → `shell-updater.cjs:82 disabled = !isPackaged || !autoUpdater = true`
→ `shell-updater.cjs:116-118` 提前返回并打 `disabled (dev / unpackaged build)`,**`setFeedURL`(:142)/`enabled: feed=…`(:143) 永不执行**。
= 壳自更新不检查/不下载/无胶囊,从 0.16.1 首个 shell-updater 版本起从未工作。

### 为什么 electron-updater 没进包 —— 两重叠加,都对着 app-builder-lib 26.15.3 源码核实

1. **`build.files` 是白名单**(`dist/** assets/** electron/** public/** package.json`),不含 node_modules。
2. **`scripts/before-build.cjs` 返回 `false`**。electron-builder 里这会置 `_nodeModulesHandledExternally = true`(`packager.js:468`,注释原文 "handling node_modules is done outside of electron-builder"),使 `platformPackager.js:366` **整段跳过 `computeNodeModuleFileSets`** —— 那正是唯一会遍历生产依赖树(含 workspace-root hoist)把 node_modules 收进 asar 的收集器。结果:**asar 里 0 个 node_modules 条目**,任何生产依赖(含 electron-updater)都不进包,与 hoist 无关。

外加 workspace dedup 把 electron-updater hoist 到**仓库根** `node_modules`(本机实测:root 有、`apps/desktop/node_modules` 没有;818 包 hoist 到根,app 级只 9 个),app 级 matcher 本就够不着。

→ **票面推荐的 `files += node_modules/**` 无效**(已实测:asar 仍 0 条 node_modules)。因为 (2) 把收集器整个短路了,而 `node_modules/**` glob 相对 `apps/desktop` 解析、也够不到根 hoist。

### 与上一个 hc-435 seat(feed-path,commit 52e5b7269)的关系:那份诊断是**误判**,但其代码对且必要
- 上一 seat 结论「arch-aware `setFeedURL` 0.16.1 就在、feed 解析正确」**代码层面属实**,但它在 **`node_modules` 里跑 electron-updater util 做的隔离实测**,从未验证 electron-updater 在**真打包 app 内**能否被 require。恰是本票要补的洞。
- 那份分析有个隐藏前提:`autoUpdater` 非空。用户日志证明 require 就抛了 → autoUpdater=null → `setFeedURL` 根本没被调 → feed 路径分析全程 moot。
- 两个修复叠加、不冲突:**本票让模块加载成功(autoUpdater 非空)→ 才轮到那份 arch-aware feed 把它指向对的子目录**。feed 护栏留着,别回退。

---

## 修法(对齐仓库既有 node-pty 的同款 pattern)

`scripts/stage-native-deps.cjs` 早就为**同一个「hoist 依赖够不着」问题**解过 node-pty:拷进 `build/native-deps/` + `extraResources` 发出去 + main.cjs 从 `process.resourcesPath` 兜底 require。本票照抄这套。

1. **新增 `scripts/stage-updater-deps.cjs`**(进 `npm run build` 链,`stage-native-deps` 之后):
   - 用 `require.resolve` **走真实依赖图**算出 electron-updater 的完整生产依赖闭包(**不手列**——手列必漏 transitive 如 argparse/debug/ms/sax/graceful-fs/universalify/jsonfile,漏一个就还是 Cannot find module)。实测闭包 = **16 包**。
   - 拷进 `build/updater-deps/vendor/node_modules/<pkg>/`,保留版本钉死的嵌套 `electron-updater/node_modules/{fs-extra,jsonfile,semver,universalify}`(不同版本永不撞)。
   - 去掉 `.map/.ts/.md`;结尾自检:electron-updater 的 `package.json` + main 入口(`out/main.js`)不在就 **抛错断构建**(宁可红也不发哑包)。
   - **★ `vendor/` 中间层是关键**:electron-builder 的 extraResources 拷贝器(`app-builder-lib/util/filter.js:43`)**硬拒**被拷 `from` 目录下**顶层名为 `node_modules`** 的路径。若直接 `build/updater-deps/node_modules/*`,electron-builder 会产出**空的** updater-deps/、整棵 node_modules 静默丢掉(实测踩到)。放到 `vendor/node_modules/*` 后,顶层子项是 `vendor`(放行),更深的 `vendor/node_modules` 命中 `**/*` 正常发出;Node require 需要的 `node_modules` 命名也保住了。

2. **`package.json`**:
   - `build` 脚本加 `&& node scripts/stage-updater-deps.cjs`。
   - `extraResources` 加 `{ "from": "build/updater-deps", "to": "updater-deps" }`。
   - (回退了试探性的 `files += node_modules/**`——实测无效,不留。)

3. **`electron/main.cjs` initShellUpdater**:`require('electron-updater')` 抛后,兜底
   `require(path.join(process.resourcesPath,'updater-deps','vendor','node_modules','electron-updater')).autoUpdater`。
   dev(未打包)走不到兜底(hoist resolve 就成)。idiom 与上方 node-pty 兜底一致。

4. **`.github/workflows/desktop-macos.yml`**:在既有「Assert packaged asar completeness」门里加一行,electron-updater 入口不在就 `::error` 断构建——和现有 `native-deps` 检查同款护栏,防这个精确回归再静默发版。

---

## 本地打包硬验证(决定性,已做)

环境:`npm ci`(workspace 根,同 CI)→ `npm run build` → `CSC_IDENTITY_AUTO_DISCOVERY=false npm run builder -- --dir --mac`(跳签名,快;asar/resources 内容为准)。

### baseline(未修,现网状态)—— 证 bug
```
app.asar 顶层条目: assets  dist  electron  package.json  public
app.asar 里 node_modules 条目数: 0
app.asar 里 electron-updater 条目数: 0
```
→ 坐实:白名单 + beforeBuild:false 使 asar **零** node_modules,electron-updater 不在包里。

### `files += node_modules/**`(票面推荐)—— 证其无效
```
app.asar 里 node_modules 条目数: 0   （加了 glob 仍然 0）
```
→ 排除票面修法,坐实收集器被 beforeBuild:false 短路。

### 修后(stage-updater-deps + extraResources)—— 证修好
`release/mac-arm64/APEX.app/Contents/Resources/updater-deps/vendor/node_modules/` 实发 **16 包 / 202 文件**:
```
argparse  builder-util-runtime  debug  electron-updater  graceful-fs  js-yaml
lazy-val  lodash.escaperegexp  lodash.isequal  ms  sax  tiny-typed-emitter
electron-updater/node_modules/{fs-extra, jsonfile, semver, universalify}   ← 版本钉死嵌套保住
electron-updater/out/main.js  ← 入口在
```

**模拟真·运行时 require(main.cjs 兜底同一路径)**:
```
require(<resourcesPath>/updater-deps/vendor/node_modules/electron-updater)
→ require() SUCCEEDED — module + closure resolved: object
→ .autoUpdater getter 抛 "Cannot read properties of undefined (reading 'getVersion')"
```
后一句是**预期且是好信号**:纯 node 下没有 electron 的 `app` 对象,electron-updater 深入到构造 MacUpdater 才碰到 `app.getVersion()`。**说明模块 + 全闭包解析成功**——旧 bug 会在 require 那步就 `MODULE_NOT_FOUND`,根本进不到 electron API。真 Electron 里 `app` 存在,这步就返回 autoUpdater。

`require.resolve` 全闭包遍历:**17 次解析、0 unresolved、入口在盘**。

### 现有打包未破
app.asar renderer(`dist/electron/assets/public/package.json`)原样;`native-deps/…/pty.node`、`lib`、`install.sh/ps1`、`install-stamp.json`、`icon.icns` 全在。改动纯增量。

---

## 包体积影响
`build/updater-deps` = **1.6MB / 202 文件**(最大:electron-updater 668K、js-yaml 492K、argparse 172K)。整个打包 .app 327MB → **+约 0.5%**,可忽略。

---

## 质量门
- `npm run typecheck`(真 tsc):**通过**。
- `npm run lint`:2 个 error 在 `main.cjs:23`(net 未用)、`:4723`(resolveManagedRelayCredential 未用)—— **均在我 diff 之外(我只改 :7794 一处)、且 origin/main 就有,非本票引入**。desktop eslint 也非本仓 CI 门(ci.yml 的 lint 是 Python lint;desktop 门 = typecheck.yml + desktop-*.yml build)。
- `build/updater-deps`、`release/` 均 gitignore 覆盖(`.gitignore:68 apps/desktop/build/`),不会误提交。

## 平台
- 修在 `npm run build`(mac/win 都跑),extraResources 两端同发。mac `--dir` 已完整验证。
- win `--dir` 本机跨编译在 `electron.exe→APEX.exe` rename 处 ENOENT 挂(`before-pack.cjs` 记的已知 macOS→win 跨编译坑,与本改无关);CI 的 `desktop-windows.yml` 跑真 Windows runner,同一 `npm run build` 一样 stage updater-deps。
- follow-up(非本票必须):`desktop-windows.yml` 没有 mac 那样的 packaged-content 门;可对称加一行 electron-updater 存在校验做保险(win nsis/msi resources 路径不同,需装后或 unpacked 校验)。

---

## 交给 PM:0.16.4 发版清单(最终验收)
1. bump 版本 → 0.16.4(`apps/desktop/package.json` version)。
2. dispatch `desktop-macos.yml` + `desktop-windows.yml`(签名/公证 secrets 已在)。新加的 completeness 门会自动校验 electron-updater 已进包。
3. COS 六件产物照旧发各自 per-arch 子目录 feed(feed 布局不动,上一票的护栏保留)。
4. **最终验收**:用户装 0.16.4 后看 `~/.apexnodes/logs/desktop.log`,应出现
   `[shell-update] enabled: feed=…<mac-arm64|mac-x64|win-x64>`(而非 `disabled (dev / unpackaged build)`)。
   出现 `enabled: feed=` = 模块加载成功 + arch-aware feed 生效 = 壳自更新真·打通(从 0.16.4 起为最后一次手动下载后可自更新)。

## 阻塞项
无。CI 绿即可交 PM bump+dispatch(Docker 非门)。
