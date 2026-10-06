# hc-906 引擎更新的安装路径与恢复

## 2026-10-06：安装成功后的 shell-only 计划误报

用户从0.17.46更新到0.17.47后，日志确认 r8 的 ba8e344e 引擎已验证并激活、网关就绪；但旧窗口保存的 shell-only 计划仍将当前4e8299引擎作为目标，renderer因此报 `runtime_target_not_active`。这不是引擎安装失败或进程占用。该用户本机在核对0.17.47 App、marker、源码stamp和bundle manifest一致后，将过期计划移动到受控backup并关闭误报；引擎与用户数据未修改。

0.17.48修复由Electron读取收尾计划时等待正在进行的runtime准备；仅当成功的packaged installer结果为installed/current、运行shell已达到计划版本、marker与源码都匹配其verified commit，才将“保持当前引擎”的shell-only目标改为实际内嵌引擎。原current/source历史、planId与requestedAt保留。runtime-after-shell或已经明确更换引擎的计划保持冻结；preserved/安装失败/marker或源码不符/旧shell均不写计划。在线默认版本不参与这次收尾判断。

回归命令（在apps/desktop）：

```sh
npx vitest run electron/desktop-update-plan.test.ts electron/runtime-version.test.ts src/store/desktop-update.test.ts
npm run typecheck
```

renderer测试通过真实计划文件、runtime准备闸和version IPC重现重启后引擎前进的路径。将计划读取恢复为原始目标后，断言收到 `runtime_target_not_active` 而变红；注入锚点确认只命中一次并还原源文件。正式发布native consumer另在三个原生runner的真实F8安装故障/回滚/重试后，证明失败时计划字节不变、成功激活后收尾目标为实际包内commit。完整consumer需使用构建出的bundled-runtime资源，unit smoke不证明真人麦克风、实际Squirrel/NSIS应用替换或物理Windows体验。公开安装包状态以成对发布与独立回读证据为准，未通过之前不得声称0.17.48已经上线。

## 2026-10-04 用户验收发现

0.17.45 的独立引擎更新将源码安装器指向已提交的 `HERMES_HOME/hermes-agent` 链接。该链接实际指向 `versions/1da9e36b7000`，源码更新覆盖了该版本树，但保留旧 bundle manifest 和 pointer。Node 阶段重新执行 npm/TUI/浏览器工具安装；`npx playwright install chromium` 因本地没有该包而访问镜像，发生 ECONNRESET，整个阶段耗时 232,778 ms。安装器完成后仍存在混合依赖，0.17.46 启动时报告 bundle key 校验不一致并保留可启动的旧目录。

另一个同类出口是相同源码 pin 在不同安装包中重新构建：文件清单不同，但目录仍只按源码 pin 命名，原实现试图按新清单验证旧产物而失败。不得通过跳过校验或原地覆盖修复。

## 修复约定

- 显式引擎更新目标与当前安装包内嵌 pin 完全一致时，保留原 marker 作为版本排序/回滚依据，持久化 override，再通过启动时共用的离线引擎准备闸安装。成功完成来源验证后才清除 override。
- 独立版本目录和带 bundle manifest 的安装树不得进入源码 bootstrap。目标不在安装包内时，提示先更新安装包；可用旧引擎、配置和会话保留。已有可选在线 bundle 更新保留自身流程，但失败不得回退覆盖版本目录。
- 旧 shell 已造成的“新 source stamp + 旧 bundle metadata”采用新增目录恢复。
- 相同源码 pin 的文件清单变更采用 `<source-key>-<index-hash-prefix>` 独立目录；archive、完整清单、verifier、目标平台、重定位、Python imports 和真实 HTTP/RPC 检查仍执行。旧版本保留为 rollback target。正常同产物重开执行已有 verifier，避免重复安装。
- primary、后台 profile、消息及本地 Agent 的共用准备闸均保持原有生命周期/闲置证明；远程连接、自定义 root、诊断包不自动采用内嵌引擎。Mac/Windows 共用同一逻辑。
- 中文、英文、日文、繁体中文改为“浏览器与工具依赖”，说明下载可能需要数分钟；阿拉伯语继承英文安装文案。

## 本机恢复证据

使用 0.17.46 安装包内实际 arm64 归档与生产 `installPackagedRuntime`，通过全量校验/重定位/idle proof/HTTP/RPC 后切换至 `versions/4e8299b39d0f`，耗时 19,491 ms。pointer 的 previous 保留 `1da9e36b7000`。配置、环境凭据、认证文件、会话数据库 SHA256 前后相同；APEX 正常重开，desktop.log 于 19:16:32 UTC 确认 backend ready，无 npm 重新安装。证据仅涉及本机恢复，不代表新修复已经进入公开安装包或 Windows 真机验收。另在全新临时 home 用真实 0.17.46 归档验证同 pin、不同清单切换：17,628 ms 完成全部生产 verifier/重定位/HTTP/RPC，旧产物保留，配置字节相同，临时 home 已清除。

## 回归与边界

在 `apps/desktop`：

```sh
npm exec -- vitest run electron/packaged-runtime.test.ts electron/apex-bundle-install.test.ts electron/bootstrap-runner.test.ts electron/apex-bundle-layout.test.ts electron/apex-runtime-latest.test.ts src/components/boot-install-format.test.ts src/components/desktop-install-overlay.test.tsx
npm run typecheck
npm run lint
npm run test:ui
npm run test:desktop:platforms
npm run build
```

真实本机生产安装入口已完成恢复；原生小归档测试覆盖 source-over-bundle 与同 pin 不同文件清单的新增目录、原配置保留、旧目录保留、重开验证。移除 source bootstrap guard 后命中本地 installer trap 而变红；移除混合 source/manifest 恢复判断后真实 bundle verifier 报不同 key 而变红。将同 pin 产物目录强制改回原目录后，真实校验器报告不同 files_index 而变红。故障注入逐次断言锚点只命中一次，再恢复源文件。Windows junction 测试必须在原生 Windows CI 跑；Mac 测试不假扮 Windows。

本次 smoke 不覆盖传统 CLI `hermes update`、供应商语音网络、真实麦克风、每种文件系统崩溃或 Windows 物理机。公开修复仍需后续 Mac arm64/x64 + Windows x64 同 SHA 的统一安装包发布，不能直接替换本机 ASAR 并称为生产发布。

本地最终检查：UI 8,994/941 文件通过；原生 Electron 3,197 通过、25 个平台条件用例跳过；发布 gate 的 Node 用例与 15 个 pack hooks 通过；typecheck、lint（0 errors）和 build 通过。Cloud compatibility smoke 的纯逻辑 7 项通过；本机缺少 Postgres createdb/dropdb，14 项真实 DB 用例需由配有 Postgres 的 Cloud CI 验证，不将环境失败描述为通过。
