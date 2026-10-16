# hc-911 — Hermes v0.22.0 / v0.22.2 全量同步与补丁对账

## 结论

- APEX fork 从 `5ae64da653`（fork main，基线 v0.21.3 / `v2026.9.14`）合并上游 `v0.22.0`（`e06df9c2ea`，2026-10-13）。
- 区间规模：上游 17,524 个提交、14,003 个文件；fork 自有 714 个提交、1,446 个文件；真实合并冲突 291 个文件、873 个冲突块。
- 合并原则沿用 hc-844 与 AGENTS 硬规则 #11：身份层、中文默认值、业务导航、托管服务接线与发布链路保留 APEX；上游的 runtime、安全、稳定性改进吸收进来；上游新的产品行为能接线就默认关闭，交由 Kael 决策。
- **Desktop 以 APEX 现行版本为基线**（Kael 2026-10-15：保留成对发布链路 Mac arm64/x64 + Windows x64 NSIS + COS feed，只吸收上游 Desktop 的运行时与稳定性改进）。`apps/desktop` 与合并前的 fork main 逐文件一致，上游新增的 1,551 个 Desktop 文件不进；为跑在 v0.22 运行时上做的兼容修改见下文“Desktop”。
- Python 运行时、pm、安装器、网关与后端路由取上游 v0.22，APEX 接缝按原语义移植；合并中被测试抓到的 9 处真实缺陷已修（见“合并缺陷”）。
- 本票不是发版票：不推进 Desktop 版本号、updater feed、COS 安装包、云镜像或生产部署。`apps/desktop/bundled-runtime.json` 仍固定已发布的 v0.21 运行时包，换成 v0.22 运行时属于发版步骤（构建脚本已就绪，见“运行时包”）。
- 随后在同一 PR 内增量合并上游 `v0.22.2`（`d923a5eb48`，2026-10-15），见"增量合并 v0.22.2"。其中包含"受监管环境（systemd/launchd/**Docker**）重启后 gateway 因 PID 复用拒绝启动"的修复，云端每个 Agent 都跑在 Docker 里，这一条直接相关。

## 增量合并 v0.22.2

上游 `v0.22.2` 是从 `release/0.22.1` 切出、以已发布的 v0.22.1 为父的补丁版。与 v0.22.0 相比改了 256 个文件，其中 Desktop 26 个。这次合并有 29 个冲突文件。

| 冲突 | 处理 |
|---|---|
| `apps/desktop` 下 23 个 | 全部保留我方：`apps/desktop` 与 v0.22.0 合并提交逐文件一致。上游新增的 `electron/keep-awake-controller(.test).ts` 和 10 个 i18n 文件（`*_notices.ts`、`ar_boot.ts`、`zh-hant_boot.ts` 等）不进 |
| `ci.yaml`、`lockfile-diff.yml`、`tests.yml` | 上游给可复用 workflow 加了 `commit` 输入（稳定发布按提交串起测试）。与我方的 hc-885 detect 稀疏检出、`fetch-depth: 1` 加比较 refs 拉取、`slice_count` 输入并存 |
| `tests.yml`（新守卫） | 上游新增的 `tests/ci/test_stable_release_commit_threading.py` 要求每次检出都跟随 `commit` 输入，并禁止用触发方的 ref 判断被测提交。我方 fork 自有的两个 job 不满足：`generate`（按 `slice_count` 切片）的检出补上 `ref: ${{ inputs.commit }}`；`save-durations` 改为只在 push 到 main 时写耗时缓存，稳定发布的 dispatch 不写。修复前两条守卫都是红的 |
| `Dockerfile` | 两段注释并存：上游的 uv 缓存种子路径，以及我方的 extras 说明。`RUN` 行已同时带 `--cache` 和我方 extras |
| `tests/test_managed_runtime_resolution.py` | 采用上游新增的 `tools/mcp_tool_config.py` 行；上游 Desktop 的 source-backend 行仍不加回 |
| `package-lock.json` | 以我方为准执行 `npm install`，再对 `undici`、`source-map-js`、`minimatch` 执行 `npm update`，让上游的 overrides 真正生效 |

**顺带修好的 v0.22.0 锁文件缺陷**：v0.22.0 合并提交的锁文件里，依赖 `minimatch@^3` 的包（eslint、eslint-plugin-react、@eslint/config-array、@eslint/eslintrc、glob、dir-compare、@electron/asar）被解析成了 10.2.6。原因是当时试过嵌套 override，回退后 npm 没有重新解析。现在已恢复 3.1.5 的嵌套条目，与上游锁文件一致。锁文件修好后暴露了被它掩盖的第二个问题：Desktop 自带的 eslint 9 走 `minimatch@3`，`minimatch@3` 把 `brace-expansion` 当函数调用，而根目录的 override 把它换成了只导出 `expand` 的 5.x。于是带花括号的 glob 会让 `npm run lint` 直接崩溃（`expand is not a function`）。v0.22.0 那轮只把 Desktop 自己配置里的花括号 glob 改掉了，漏了它引入的根目录 `eslint.config.shared.mjs`（`**/*.{ts,tsx}`）。这次一并改成两个等价 glob，并做了追踪确认：Desktop lint 过程中再没有花括号模式经过 `minimatch@3`，lint 覆盖的文件集合不变。其余 `minimatch@3` 使用方都不会触发这个问题：app-builder-lib 自己用 minimatch 10；asar、universal、winstaller 不传花括号 glob，后两者 APEX 也不用。`npm ls --all` 只剩上游同样存在的两处可选平台依赖告警（lightningcss、wasm32 绑定）。

**吸收的上游改进**：

- 安全依赖：httpx2 / httpcore2 2.12.0，以及 brace-expansion 5.0.12、undici 6.29.0 / 7.30.0、js-yaml 4.3.2、source-map-js 1.2.2、vitest 4.1.11。
- gateway 主机会合（host rendezvous）：识别回收的 PID，按开机时间判定遗留记录。修的是受监管环境重启后拒绝启动的问题。
- 新建 profile 继承模型：一并带上自定义端点，`${VAR}` 保持引用，不读取凭据。
- 本地模型：长回合在笔记本睡眠后的保活，以及 llama.cpp 的 prompt 进度。
- pm：字节码编译失败时重试、uv 缓存种子重新合并、PATH 上的 npm 使用固定版本。
- 终端 PATH 改为用户自己的工具排在 Hermes 之前，与我方 hc-544 的用户 bin 追加互不冲突。
- 本地文件搜索使用固定版本的 ripgrep；Mistral 工具 id 配对修复。

不影响 APEX 的部分：Windows MSIX、Microsoft Store 打包线和稳定发布 lanes。APEX 走 NSIS 和 `desktop-release.yml`。

**接缝复查**：

- APEX overlay 和插件直接引用的上游模块，与 v0.22.2 改动的 119 个 Python 模块没有交集。
- 双方都改过的源文件有 4 个：`agent/chat_completion_stream_monitor.py`、`agent/model_metadata.py`、`hermes_cli/profiles.py`、`tools/environments/local.py`。逐个比对后没有语义冲突。四个文件里我方补丁依次是：末尾空行、本地探测 `trust_env=False`、hc-903 模型写入日志不随 profile 克隆/导出、hc-544 用户 bin 追加。
- hc-903 相关路由（`web_server_config`、`web_routers/models`、`web_routers/config_env`）上游未改。
- 生成物重跑后与合并结果逐字一致，Desktop slash 注册表的 APEX 覆盖仍然生效。生成物包括网关契约（openrpc 与 generated.ts）、Desktop slash 注册表、文档漂移基线、技能文档与侧栏。
- 所有可复用 workflow 调用方传的 `with` 键，都已与被调方的 `workflow_call.inputs` 逐个核对。
- 无新增需要 Kael 决策的产品行为。

**Desktop 基线跳过清单补 8 条**：`tests/ci/test_update_ci_routing.py` 中有 8 条测试校验上游的 CI 路由能到达上游 Desktop 的测试套件，涉及 `e2e/update/*.spec.ts` 的 playwright 套件，以及读取 `update_marker_corpus.json` 的 3 个 Desktop vitest 文件。APEX 基线没有这些文件。按测试 ID 比对时，它们是唯一的 fork 独有失败；v0.22.0 那轮按文件比对，被同文件里本机 bash 3.2 导致的失败掩盖了，这次补上。跳过条件按路径设定：被引用的文件一旦移植进来，跳过自动失效。

**已知缺口（不在本 PR 改）**：`ci.yaml` 的 `e2e-desktop-core` 与 `e2e-desktop-update` 两条 lane 是 v0.22.0 带进来的，它们跑的 `apps/desktop/e2e/core`、`apps/desktop/e2e/update` 套件不在 APEX 基线里。PR 和 push 时 `gate-lanes` 会把 E2E lane 强制关掉，所以日常 CI 不受影响。只有以 release 模式手动 dispatch `ci.yaml`（或上游的 `stable-release.yml`）时，这两条会红。要关掉它们，需要同时改 `required_results.py` 的必需 lane 表，见"后续"。

**hc-913 已补上**：两条 lane 在套件缺失期间是裸 `if: false`，`required_results.py` 把它们列为延期作业，`e2e-desktop-update` 不再是必需的更新消费方。守卫 `tests/apex_overlay/test_desktop_e2e_lanes.py` 按两个 `playwright.config.ts` 是否存在钉住这两处，套件一移植进来就会变红，直到恢复为止。另外，上面那 8 条跳过并不完整：同类的 33 条测试（期望更新套件被派发）在本机被 bash 3.2 缺 `mapfile` 和 `platforms(linux, windows)` 平台门挡住了，在 Linux 上 hc-911 头本身就是红的。hc-913 把它们按同一套件路径跳过，并在守卫里重新断言其余 lane 的路由契约。

## #390 首轮 CI 的修复（fork 首次跑 v0.22 的 CI）

fork 的 Actions 自 10-08 起被 GitHub 以“用量过大”停用，#390 的第一轮 CI 是在维护者重新启用之后才跑起来的。结果是 31 项通过、14 项失败。对照前两次同步 PR（#254、#283，当时全绿），这次的失败来自 v0.22 新增的检查和 fork 自身的差异。另有一组失败被前一步挡住，第一轮根本没执行到（硬规则 #12 的“一个 bug 挡住另一个 bug”）：同一 job 里 footgun 一失败，后面的 shebang、临时目录字面量、OS 伪装、AGENTS.md 体量检查都没跑。

| 失败 | 原因 | 处理 |
|---|---|---|
| 8 个 Python 测试分片 | fork 自有的 `tests.yml` 分片步骤仍 `source .venv/bin/activate`，v0.22 的 setup-pm 不再生成 `.venv`，一条测试都没跑 | 删掉这一行；新增守卫 `test_ci_workflow_venv_activation.py`：每次激活 `.venv` 都必须有同 job 内的创建步骤 |
| Windows footguns 等 lint 守卫 | v0.22 规则更严：APEX 脚本里 19 处 BOM/编码，另有 6 处写死路径的 bash shebang、32 处临时目录字面量、3 处未标记的 OS 伪装，以及 Desktop AGENTS.md 链路超出 30,000 字符 | 读文件改用 `utf-8-sig`，补 `encoding=`；shebang 改为 `#!/usr/bin/env bash`（卸载脚本由 `/bin/bash <script>` 执行，shebang 不影响运行）；有意的 `/tmp` 和 OS 伪装逐行加带原因的 `no-tmp: ok` / `os-marker: ok`；Desktop AGENTS.md 的三节长篇原样移到 `apps/desktop/ENGINEERING.md`，原处换成上游 v0.22.2 的精简版并指向那里 |
| nix flake check | `apps/desktop` 精确固定 `js-yaml: 4.3.1`，上游 override 已升到 4.3.2；nix 的 `importNpmLock` 去掉 override 后离线安装，于是要找锁文件里不存在的 4.3.1 | 改成 4.3.2；新增 tests-js 守卫 `override-pins.test.mjs`。离线复现：去掉 override 后跑 `npm ci --offline`，4.3.1 报 `Missing: js-yaml@4.3.1`，4.3.2 安装成功 |
| 图标新鲜度 | 生成器用上游 Nous 图标重写 `apps/desktop/assets/*`，再拿去和提交里的 APEX 图标比对。照提示处理会把身份层换成上游的（硬规则 #11） | 生成和结构检查照常做；比对前还原 `apps/desktop`。该豁免在上游的 `product-identity.cjs` 移植进来之后自动失效。其余目标（web、website、bootstrap）照常比对，CI 上与提交一致 |
| Prebuilt TUI checks（tests-js） | 7 个文件依赖 APEX 基线里没有的上游 Desktop 模块，或在测上游 `notarize.mjs` 的重试语义 | `tests-js/vitest.config.ts` 按路径排除这 7 个文件，被引用的路径一旦移植进来，排除自动失效；守卫 `apex-desktop-baseline.test.mjs` |
| code health ratchet | 以 fork main 为基准，v0.22 的上游代码全被算成新代码，共 1,757 条阻断 | 见下“同步 PR 的上游基准” |
| 供应链风险扫描 | 命中 5 行，都是上游 Windows 启动器里的 base64，与 v0.22.2 一字不差 | 同上 |
| pinned-source-validate | “改 catalog 的 PR 只能改数据”的规则，同步 PR 必然违反（不在必需检查里） | 同上 |

**同步 PR 的上游基准**：`.github/apex-upstream-baseline.json` 记录本次合入的上游 release（`v0.22.2` / `d923a5eb48`）。`scripts/ci/upstream_sync_baseline.py` 只在三个条件同时满足时才认它：记录相对 base 有变化；GitHub API 确认 `NousResearch/hermes-agent` 的该 tag 指向这个 commit；在有完整历史的 checkout 里，该 commit 已合入 head。

- **code health**：再以上游 release 为基准判定一遍。一条发现只有在两边都阻断时才算阻断，1,757 条降到 15 条。15 条里有 2 条是真问题，已修：合并留下的重复导入（F811）、新脚本 subprocess 没设 timeout。另外 13 条是“上游增长 + fork 原有补丁”叠加在同一个单元里。逐条核对过 fork 补丁量的变化，都写进记录的 `health_allow` 并注明原因。这份清单只对改动了记录的那个 PR 生效，合并后 main 上的值就成为新的上限。
- **供应链扫描**：同步 PR 只看相对 fork base 和相对上游 release 都是新增的那些行（995,675 行新增中，APEX 自己的有 4,617 行），5 处上游命中被排除。PR 在自己文件里写出与上游完全相同的一行，照样会报。
- **pinned-source-validate**：同步 PR 只校验与上游 release 不同的条目（本 PR 没有），并跳过“只能改数据”规则。检测脚本优先取 base 分支上的版本，避免 PR 改写自己的判定。

**下次同步时**：更新记录里的 tag 和 commit，清空 `health_allow`，再按 code health 的结果逐条补上。

## 结构性冲突（UD / DU / AA）

| 文件 | 处理 | 依据 |
|---|---|---|
| `tools/tirith_security.py`、`tests/tools/test_tirith_security.py` | 随上游删除 | 上游整体移除 tirith，由内置规则替代；hc-684 的下载重试随之作废 |
| `Dockerfile` 的 tirith bake 步骤 | 删除 | 依赖已删除的模块，不删镜像构建必然失败（同 2026-07-06 bake 事故形状） |
| `scripts/lib/node-bootstrap.sh` | 随上游删除 | 安装器改为 PM 固定版本；**我方 `HERMES_NODE_DIST_BASE` 国内镜像需迁到新机制（待办）** |
| `plugins/memory/openviking/` | 随上游删除 | 记忆 provider 移到目录插件；hc-903 在此处的 `mutate_config` 围栏随之失效（APEX 默认不使用 OpenViking） |
| `apps/desktop/src/plugins/hermes-bots/i18n.test.ts` | 保留我方 | 上游批量清理低价值测试时删除；该文件钉的是 hc-828 文案 |
| 其余 14 个上游删除的测试/e2e/ps1 脚本 | 随上游删除 | 被测对象已被上游重写或删除 |
| `apps/desktop/src/i18n/ru.ts` | 保持删除 | APEX 不发俄语 |
| `apps/desktop/src/lib/gateway-ws-url.ts` | 采用上游 | 解析逻辑已迁入 `@hermes/shared`，合并树其余调用方已改用它 |
| 7 个 AA 测试文件 | 原路径采用上游，我方版本改名为 `*.apex.test.*` 并列保留 | 我方版本钉了 hc-591/hc-596/hc-532/Windows 身份闸/hc-906 等 APEX 行为 |

## 补丁去留（Python 核心）

| 补丁 / 行为 | 处理 | 依据 |
|---|---|---|
| Dockerfile CJK 字体与 pango/cairo 渲染库、ffmpeg/ripgrep | 保留并并入上游新包列表 | 文档导出与媒体工具依赖 |
| Dockerfile extras | 改用上游 `pm.build_env`，补 `feishu dingtalk wecom edge-tts cloud-search` | v0.22 废弃运行时懒安装（`tools/lazy_deps.py` 只会抛错），云端需要的 extra 必须构建时选好；`wecom` 是新增 |
| pyproject `file-export`、`cloud-search` extras | 保留 | APEX 文件交付与国内搜索 |
| pyproject `exclude-newer` | 采用上游（3 天、无豁免） | 上游改为从审核锁文件安装 |
| pyproject `hermes_cli` package-data | 上游 ∪ 我方 | 顺带修复我方此前丢失的 `local_runtime/*.json` |
| `cli-config.yaml.example` | 合成单个 `plugins:` 块 | 两边各有顶层 `plugins:`，直接并列会让后者覆盖我方 10 个插件的启用列表 |
| hc-903 Desktop 模型写入围栏 | 迁到上游新的 `_write_config_state`（`atomic_config_write` 与 `atomic_config_replace` 的唯一写入口） | 可重入；`save_config` 外层围栏保留 |
| hc-903 `_set_plugin_entry_flag` 加锁读改写 | 移植到上游新模块 `plugins_cmd_capabilities.py` | 上游搬家时用的是旧的 load/save |
| hc-903 `_toggle_plugin_toolset` 加锁读改写 | 保留锁，采用上游解析逻辑，去掉"补 cli"分支 | 上游有意移除该分支（会覆盖内置工具组合） |
| hc-903 凭据预备（`prepare_env_credential_pool_entries` 等） | 保留，置于上游新 helper 之前 | 上游无等价实现 |
| 回环地址绕过系统代理（`trust_env=False`） | 保留并叠加上游 `verify=` / 响应体上限 / 重试 | macOS + Clash 场景 |
| LSP 退出先等 100ms 自然退出 | 保留，之后接上游 `kill_process_tree` | hc-844 PID 复用竞态修复 |
| 微信过期会话恢复后重新标记已连接 | 保留并接入上游"先分发后持久化"顺序 | APEX 渠道契约 |
| 平台失败连续计数（attempts / failing_since） | 迁到上游新的 `_prepare_runtime_status_update` | 两条写路径都经过它 |
| 回复语言约束（`_resolve_response_language_prompt`） | 保留 | APEX 默认中文沟通 |
| APEX 卸载路径（APEX.app / Programs\APEX 等） | 保留并补上游 legacy desktop entry 与图标尺寸 | 身份层 |
| hc-905 定时任务创建时模型快照 | **采用上游：定时任务跟随主模型，需固定用 `pinned`** | 上游删除整个快照子系统；**功能层变化，待 Kael 决策** |

## 补丁去留（Desktop 后端 / 仪表盘路由，续）

| 补丁 / 行为 | 处理 | 依据 |
|---|---|---|
| hc-903 主模型切换（显式端点、锁外 Nous 网关计算、围栏内重读） | 嵌入上游 `_prepare_main_assignment` / `_apply_main_assignment_sync(prepared)` 拆分；保留上游 `endpoint_already_known` 与 `reconcile_record()` | 两边都在把网络校验挪出锁 |
| `cron_model_impact` 返回字段 | 去掉 | base 原有、上游随快照机制删除；合并后 Desktop 不再读取 |
| `config_write_scope` | 在 profile 与 `_CONFIG_MUTATION_LOCK` 之间进入 hc-903 围栏 | 上游新 helper 的顺序是"锁→围栏"，与 hc-903"围栏先于配置锁"相反 |
| ops / dashboard_ui / memory_providers / mcp 的 hc-903 `mutate_config` 读改写 | 保留，外层套上游 `?profile=` 作用域与配置变更锁 | 两者正交，都要 |
| MCP 插件提供的服务器不可修改 | 采用上游，放进我方原子写入路径 | 上游新安全约束 |
| `PUT /api/env` 凭据预备 + 围栏 | 保留，叠加上游的脱敏预览拒绝与 API key 埋点 | |
| `_env_write_errors(http_passthrough=)` | 采用上游（总是透传 HTTPException） | 参数为 base 原有、上游删除 |
| hc-905 定时任务 `executions` 列表 | 保留，改在上游 `_owner_home_scope` 内读取 | APEX Desktop `cron-run-history.tsx` 依赖 |
| hc-905 prompt outcome（`turn_id` / `finish_prompt_outcome` / `run_tracked_prompt`） | 整文件采用上游 `prompt_turn.py`，再按 7 个锚点补回 | 上游重构为 `try/finally` + `_start_session_work` |
| hc-544 子进程 PATH 补用户 bin 目录 | 移植到上游新的 `hermes_subprocess_env` | 上游拆出 `_scrub_credentials` |
| 回环地址绕代理（skills hub） | 移到上游统一入口 `_skills_hub_http_get` | 一处覆盖 6 个调用点（原先只补了 2 处） |
| 进程组清理 | 采用上游（同组检测、EPERM 处理）；进程已不存在时保留我方"直接返回" | 上游更完整地修了同一个 macOS 问题 |

## Desktop：保持 APEX 基线

| 项 | 处理 | 依据 |
|---|---|---|
| `apps/desktop` 全部冲突与上游自动合入的改动 | 恢复为合并前 fork main；上游新增的 1,551 个文件不进 | 上游一个月 3,336 个 Desktop 提交（electron 下 492 个 fix）且换了打包与身份层（MSIX、`product-identity.cjs`、`electron-builder.config.cjs`、`version 0.0.0`）；逐块三方合并会拼出不一致的壳 |
| 共享层 `apps/shared` | 取合并结果（与 v0.22 后端契约一致） | 我方 Desktop 对它 typecheck 只有 1 处不兼容（见下行） |
| `layout.apply` 事件分支 | 删除 | 上游以 `set_theme` + `theme.apply` 服务端请求取代 `apply_layout`，事件已不存在 |
| `theme.apply` / `theme.pick` / `setup_beat` 服务端请求 | 不实现 | 我方渲染层对未处理的服务端请求回 -32601，工具立即失败而不是挂 300s；是否移植上游 `set_theme` 界面待 Kael |
| `client.capabilities {server_requests: true}` | 由合并后的共享客户端在每次 `gateway.ready` 发送 | v0.22 后端对未声明的 WS 客户端直接让 clarify/审批/sudo/密钥等请求失败；我方 Desktop 测试按此更新 |
| `profiles.remember_onboarding` | 不处理 | 上游删除；我方只在 `HERMES_GUEST_ONBOARDING=1` 的 Nous 引导里调用，默认关闭 |
| slash 注册表转储 `desktop-slash-registry.json` | 按 v0.22 注册表重新生成；`/skills`、`/reasoning` 用 APEX 本地覆盖保持“去侧边栏 / 高级设置” | v0.22 为它们做了上游 Desktop 原生界面，我方没有；本地 spec 优先于实时目录 |
| STT 模型建议 | 补 `turbo`、groq、xai 列表；不加 deepinfra 提供方 | 与运行时目录对齐；新增提供方属产品选项 |
| 打包产物名查找 | `install.ps1` 的 `-IncludeDesktop` 先找 `APEX.exe`（`Hermes.exe` 兜底）、快捷方式 `APEX.lnk`；身份层守卫改钉“install.sh 不得出现 `Hermes.app`” | v0.22 的 install.sh 只按目录判断产物，按名字启动移到 `hermes_cli/main_desktop.py`（保留我方 APEX 查找） |
| ESLint 花括号 glob | `**/*.{ts,tsx}` 拆成两个模式 | 根 overrides 把 `brace-expansion` 统一到 5.0.9，我方 ESLint 9 依赖的 `minimatch@3` 遇花括号崩溃；不改锁文件结构，与上游一致 |
| `tests-js` 中上游打包版 Desktop 冒烟链路 | `tests-js` 的 tsconfig/vitest 排除 `desktop-smoke*`；我方 e2e tsconfig 只纳入 `mock-server.ts` / `mock-provider-config.ts` | 依赖上游 Desktop 的 `backend-discovery.ts`、`data-paths.mjs` |
| 上游依赖上游 Desktop 文件的 Python/CI 测试 | `tests/_fixtures/apex_desktop_baseline.py` 按精确测试 ID 跳过，仅在所引路径确实缺失时生效；`tests/apex_overlay/test_desktop_baseline_skips.py` 守卫不过期、不扩大 | 上游测试文件保持逐字节一致 |
| 上游 e2e 通道 `e2e_desktop_core` / `e2e_desktop_update` | 分类器路由原样保留；hc-913 起作业在套件缺失期间为 `if: false`，并在门禁里延期 | 套件不在 APEX 基线；APEX Desktop 发布只走 `desktop-release.yml`（硬规则 #15） |

## 安装器与国内链路

- `scripts/install.sh` / `install.ps1` 取上游 v0.22（pm 驱动、按 `pm/lock.json` 固定 uv/PortableGit 并校验 sha256），再移植 APEX 接缝：地域库加载与 CN 镜像环境、COS 源码包优先的 repository 阶段（`.hermes-source-commit` 校验、陈旧树重抽、失败致命）、CN 模式下先取 COS 上同一 sha256 的内容寻址副本、hc-678 在 clone 时固定 `core.autocrlf=false`。
- `pm/artifact_mirror.py`：CN 模式（`HERMES_CN_MIRRORS=1` + HTTPS COS 基址）先取 `<COS>/upstream/sha256/<sha>`，再原始 URL，再上游镜像；摘要不变。
- 退役（机制随上游重写消失）：node-deps 增量、网络探测缓存、快速更新通道、托管 uv 缓存（改由 `pm.packages.uv_cache_dir`）、hc-636 哈希镜像档、hc-727 ps1 完整性修复、hc-632 winget 前的 COS 可选包。改写：hc-678、hc-633、hc-543、地域接缝、hc-472（改为驱动 pm 真实 `PythonEnvironment` 的行为测试，放 `tests/pm/`）。
- `scripts/verify-environment.py` 静态检查改为钉 pm（artifact mirror 与 runtime builder 的 index 剥离）。

## 运行时包

- `scripts/build-runtime-bundle.mjs`：被构建提交带 `pm/lock.json` 时按其固定的 CPython（3.14.7）与 uv（0.12.3）构建，否则沿用 3.11；fixup/smoke 从包内 `cpython-X.Y.Z` 推导版本，旧包仍可重定位。
- `apps/desktop/scripts/bundled-runtime-package.mjs`：解释器路径按包的 Python 版本推导（新增 3.11/3.14 双用例并反向验证）。
- `bundled-runtime.json` 不动（仍是已发布的 v0.21 包，`uv_version` 与该包一致）。

## 合并缺陷（测试抓到并已修）

1. `web_routers/dashboard_ui.py` 用了 `LateState` 未导入 → web server 起不来（整个 Desktop 后端）。
2. `/api/model/set`：上游锁 + hc-903 围栏包住了 Nous 网关预计算 → 预计算挪到锁外（`_prepare_main_gateway_tools`），反向验证有效。
3. `PUT /api/model/moa`：回执在围栏提交前计算 → 恒为空；移到 `with` 外。
4. 旧式 `custom_providers` 激活：上游的提升在围栏前快照上做，围栏内重读后丢失 → 404；围栏内重做提升。
5. ops 的记忆 provider 选择 / hooks 增删、记忆 provider setup：套上上游 `config_write_scope` / `scoped_to_thread` 后，旁路写入在准备阶段持有配置锁或进程级 profile 锁，阻塞 Desktop 模型写入 → 改为只取 profile 作用域，`mutate_config` 内短锁读改写。
6. cron 执行记录：任务删除后所有者解析失败 → 读到默认 profile；无所有者时退回调用方提示。
7. `plugins/apexnodes_gateway.py` 与 `apex_overlay/media_tools.py` 的 ffmpeg/tar 子进程未关 stdin。
8. 三个 APEX 测试与一处发版脚本仍 `import yaml`（v0.22 去掉了 PyYAML，统一 ruamel）。
9. `apex_overlay/media_tools.py` 依赖已删除的 `tools.lazy_deps` → 改用 `pm.lazy_installs_allowed`；picker 预热改为先等插件发现（apex-overlay 拒绝名单生效后再列 provider）。
10. （v0.22.2 增量时发现）锁文件把 `minimatch@^3` 解析成 10.2.6，掩盖了根目录 eslint 共享配置里那个让 Desktop lint 崩溃的花括号 glob。锁文件与 glob 都已修正，详见"增量合并 v0.22.2"。

## 需要 Kael 决策的上游行为变化

1. 定时任务不再按创建时快照运行，改为跟随主模型（需固定用 `pinned`）。
2. `sessions.auto_prune` 默认开启：结束且 90 天未活动的会话在启动时删除。
3. 首启引导使用 Nous 免费试用模型 `nous/welcome`、Connectors 首次使用创建 Nous 身份（我方 Desktop 显式传 `HERMES_GUEST_ONBOARDING=0`，默认关闭）。
4. 上游 Desktop 新能力是否逐项移植（均未进本票）：`set_theme` 主题/布局卡片、`/skills` 与 `/reasoning` 原生界面、deepinfra STT、HUD 修饰键、命令截图、云端发现/挑战窗口、MSIX/AppInstaller 更新、上游 e2e 框架。
5. 插件启停改由 PM 以整文件摘要比对发布（冲突即拒绝重试），hc-903 不再在应用进程内为它加锁；比对与写入之间有窄窗口（上游残余风险）。
6. macOS 公证：上游的 `apps/desktop/scripts/notarize.mjs` 增加了 notarytool 超时后续等同一提交、已受理时只重试票据传播（不重新提交、不重建）的逻辑；APEX 的版本没有这些。这属于 Desktop 发版稳定性改进，是否移植待定（tests-js 里对应的上游测试已按基线排除）。

## 合并中发现的风险（存量，非本次引入）

- hc-903 围栏与 `_CONFIG_MUTATION_LOCK` 的获取顺序在 fork 里本来就有两种（`config_env` 的 PUT /api/config 是"围栏→锁"，自定义端点激活等是"锁→围栏"）。围栏底层是带忙等超时的 sqlite 锁，不会永久死锁，最坏是超时报错。需要单独复查。

## 后续（不在本票）

- COS 按 sha256 镜像 pm 产物（`<COS>/upstream/sha256/<sha>`）的发布脚本与 `verify-environment.py` 闸门；在此之前 CN 模式取 COS 会 404 后回落原始 URL。
- 安装器路径的国内哈希镜像 Python 依赖档（APEX Desktop 运行时包不受影响）。
- 发版时用新构建脚本为合并提交出 Mac arm64/x64 + Windows x64 运行时包并更新 `bundled-runtime.json`。
- `main.ts` 非打包路径的系统 Python 白名单（3.11–3.13）与 v0.22 锁文件（仅 3.14）不再匹配，只影响开发/源码模式。
- 本机运行测试会在 `~/.hermes/tools` 建立 pm 工具库（约 2.1 GB，上游默认位置）。
- ~~fork 的 `ci.yaml` 中，`e2e-desktop-core`、`e2e-desktop-update` 指向 APEX 没有的上游 Desktop e2e 套件。~~ hc-913 已按第一种处理（`if: false` + 延期）。把 APEX 自己的 Desktop e2e 接到这两个入口仍是可选的后续工作。

## 验证

本机 macOS（Mac Studio），v0.22.2 合并结果：

- `ruff check .`：0 条。
- Python 全量（`scripts/run_tests.sh -j 12`）：60,889 通过 / 223 失败 / 1,485 跳过。
  - 失败的 61 个文件放到干净上游 v0.22.2 上重跑，得到 214 条失败。逐条按测试 ID 比对：fork 独有的是上面 8 条路由测试（已加入跳过清单，重跑为 0）、`test_stable_release_commit_threading` 的 2 条（已修），以及 1 条高负载下偶发的 `test_local_interrupt_cleanup`（单跑通过）。
  - 其余失败上游同样存在，原因是 macOS 自带 bash 3.2 没有 `mapfile`、本机有真实的 `~/.hermes`、网络。
- tests/apex_overlay：412 通过（1 条仅 Windows 跳过）。
- Desktop：
  - typecheck（renderer + electron + e2e）通过。
  - lint 0 错误（349 条告警，与 v0.22.0 同一批文件）。
  - vitest UI 9,120、electron 3,221 全过。
  - release-gates：node 100 条、vitest 15 条全过。
  - `npm run build` 通过。
- 开发模式 Desktop 跑在 v0.22.2 运行时上，使用全新 HOME 与用户数据目录：后端就绪、网关就绪；首屏为 APEX 中文登录；“使用自己的密钥”后进入 APEX 首页；向本地 OpenAI 兼容模拟服务发消息，流式回复正常；errors.log 只有 2 条预期警告。
- 未验证：用 v0.22.2 运行时包打出的 APEX.app / APEX.exe（发版步骤）；Windows 真机；国内网络。
