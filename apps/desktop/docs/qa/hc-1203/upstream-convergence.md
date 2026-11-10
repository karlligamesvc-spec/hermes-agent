# hc-1203 — Hermes v0.23.0 同步与补丁对账

## 结论

- APEX fork 从 `6f44d6279f`（fork main，基线 v0.22.2 / `d923a5eb48`）合并上游 `v0.23.0`（`2bd378ed1b`，2026-11-05），之后又合入 fork main 的 #596（hc-1200），以及 #598（hc-1201）、#582（hc-1179）、#597（hc-1202）。区间规模：上游 8,170 个提交，fork 自 v0.22.2 起 1,559 个提交；合并冲突 784 个文件，其中 722 个在 `apps/desktop`。
- 合并原则沿用 hc-911 与 AGENTS 硬规则 #11：身份层、中文默认值、业务导航、托管服务接线和发布链路保留 APEX；上游的 runtime、安全和稳定性改进吸收进来；上游新的产品行为能接线就默认关，交给 Kael 决定。
- **Desktop 仍以 APEX 现行版本为基线**：`apps/desktop` 与 fork main 逐文件一致，上游改动的 1,891 个 Desktop 文件和 Electron 44 都没有进来。为跑在 v0.23 运行时上改的 Desktop 文件只有三处：`package.json`（Node ≥26 与两条 override，见“Desktop”）、`package-lock.json` 里对应的 spec 行，以及重新生成的 `src/lib/desktop-slash-registry.json`。
- 本票不是发版票：不推进 Desktop 版本号、updater feed、COS 安装包、云镜像或生产部署。
- **合入前要 Kael 定的事**见文末“待 Kael 决定”。其中第 1 条（云端浏览器）必须在下一次云镜像 roll 之前定。

## 合并冲突处理

| 冲突 | 处理 |
|---|---|
| `apps/desktop`（722 个冲突及其余全部上游 Desktop 改动） | 按 fork main 逐字节还原（硬规则 #11，hc-911 的决定） |
| hc-903 Desktop 模型写入围栏 | 留在上游的新代码上：主槽显式端点（#145466）与 Desktop 命名端点路径合并；自定义端点路由保留提交围栏，加上上游的 `refusing_locked_omissions`；toolset / terminal 写入保留 `mutate_config`，加上上游的校验；配置写入围栏包住上游的 `write_config_document` |
| hc-1034 批准暂停 | 移植到上游的多发现命令闸和本地会话 execute_code 规则上；探测豁免只用于主扫描 |
| hc-905 turn_id / 提示结果 | 与上游的 `hosted_images`、`report_ownership_refusal` 并存；cron 运行历史在上游新的 reconcile 签名上保留 executions 列表 |
| hc-941 MCP 期限 | 上游合入了它自己的版本；两边的测试都保留（重复的那一条见下“合并缺陷”） |
| 同一个 bug 两边各修一次 | 取上游写法：state.db sidecar 消失竞争、hosted-room 事件预算时钟、LSP 退出码与进程组释放 |
| workflows | 上游所有 Blacksmith runner 标签和 `useblacksmith/*` action 换回 fork main 用的 GitHub 托管标签和固定版本的 action；fork 的矩阵（tests 的 generate / slice_count、tests-os 的 Windows）保留 |
| `Dockerfile` | 保留 APEX 的字体、库和 IM extras，加上上游的 tmux、fal、documents；Webapp 阶段见下 |
| 安装器 | COS 优先的那段留在上游新的渠道逻辑上 |
| 锁文件 | `uv.lock` = 上游锁 + uv 0.13.5 为 fork 的 file-export / cloud-search extras 重锁（python-docx 对齐到 1.2.0；filelock 上限放到 <5，让 4.2.1 的安全修复生效）。并入 #597 后经 pm 重锁，再用 pm 的 uv 把 filelock 4.2.6→4.2.9、msgpack 1.2.3→1.2.4、oauthlib 4.0.0→4.0.1 升到 #597 的版本，其余不动；OSV 只剩 weasyprint 62.3（#597 记下的已知例外）。`package-lock.json` = fork 锁经 npm 12.0.2 / Node 26.12.1（pm 固定版本）协调 |
| fork main 第二次合入（#598 hc-1201、#582 hc-1179、#597 hc-1202） | #598、#582 无冲突，#582 的浏览器接缝随后移植（见“APEX 接缝移植”）。冲突都来自 #597：`pyproject.toml` 9 处，filelock 取 #597 的下限 4.2.1（fork 自己的 COS 缓存依赖），其余 8 处取 v0.23.0（每处都比 fork main 高）；`tests/pm/test_pip_check.py` 取 v0.23.0（只多 `allow_network` 标记，v0.23.0 的网络围栏要它）。#597 动过的其余文件（`pm/*`、`scripts/termux/*`、移植来的测试、`google_chat/oauth.py`）合并后与 v0.23.0 逐字节相同 |
| 上游删除 | `hermes_cli/copilot_auth.py`（Copilot 移到 github-copilot labs 插件）、huggingface-hub 可选技能；微信和 QQ Bot 移到 `plugins/platforms/*`，fork 的会话过期补丁随改名检测带过去 |
| 生成物 | 网关契约、prompt-surface 快照、Desktop slash 注册表、网关命令对照表按合并后的代码重新生成 |

## APEX 接缝移植

| 接缝 | v0.23.0 的变化 | 处理 |
|---|---|---|
| `apex_overlay/media_tools.py`（Desktop 浏览器只用 COS 校验过的 Chromium） | agent-browser 和它的安装器被删，`apply()` 抛 AttributeError，Desktop 的 `browser_exec` 会退回 pm 从国外主机下载 | 接到 `browser_exec` 真正走的启动器：`tools.browser_launcher._maybe_autoinstall_chromium` 换成 APEX COS 安装（不碰国外主机，不覆盖用户 `browser.executable_path` 的设定，遵守 `security.allow_lazy_installs`）；`hermes_cli.browser_runtime.chromium_executable` 在上游所有候选之后给出 COS 浏览器。云端 / Linux 和未打包检出不受影响 |
| `package.json` 的 `allowScripts` | npm 12 只放行按精确版本登记的安装脚本；合并取了上游列表 | 补回 APEX Desktop 基线需要的 `electron@40.10.2`、`esbuild@0.28.1`、`fsevents@2.3.2` |
| `provider_filter`（hc-392 / hc-621） | Copilot 离开核心，核心不再跑 `gh auth token` | 第 6 道闸退休，其余 6 道保留；测试改用核心里仍有的 provider |
| `cn_im_banners`（hc-976） | 微信、QQ Bot 适配器搬进插件 | 接缝绑的是 `BasePlatformAdapter`，不用改；测试跟着搬 |
| `cron_update_notice`（hc-1183）、`cron_account_env`（hc-1169）、`im_launch_profile`（hc-1171）、`cron_desktop_delivery`（hc-1186） | 主频道环境变量名改由各平台插件给出；启动 profile 的密钥作用域上游自己就带进程环境；cron 由唯一的 gateway 执行，投递进队列再由 gateway 排出 | 接缝不变，测试按新路径改（详见提交 afa4dd08a2） |
| `tools/clarify_tool.py`（hc-965） | 上游给每个问题的展示副本都加“(Recommended)” | 只在规范化加了标签的地方加；`recommended: false` 的问题在各个界面都不带标签 |
| `hermes_cli/webapp.py`（hc-954） | Webapp 渲染构建在引擎目录里先拿构建锁，才走到打包引擎拒绝 | 先拒绝，再拿锁 |
| `upstream_copy`（hc-1116） | 5 条新的上游文案 | 飞书 clarify 卡片标题和新的 `/discard` 说明改成 APEX；`/debug local` 和两条新的 `/model` 文案归入“Kael 定”那一组 |
| APEX 媒体插件（图片、视频） | 新增 config-readers 守卫：配置只能经 `hermes_cli.config_backend` 读 | 改用 `config_exists()` |
| 证据闸插件 `apexnodes-honesty-tools` | 浏览器只剩 `browser_exec` | 与 apex-nodes 同一份 `__init__.py`（逐字节复制，apex-nodes 的比对测试读 fork main） |
| `apex_overlay/browser_window.py`（hc-1179，#582） | agent-browser 的 `tools.browser_tool._build_browser_env` 和 `tools.browser_tool_session._apply_chromium_sandbox_args` 被删，接缝什么都包不到 | 改包 `tools.browser_session_cloud` 的两个访问器，二者都在调用时读、不缓存：`user_data_dir()` 在没有固定资料目录、有窗口、Mac / Windows 时给 `<HERMES_HOME>/apex-browser-profile`（会话层按这个目录让所有会话共用一个窗口；用户固定的目录永远优先；无窗口的云端和 Linux 不变，Linux 上 Bot Desktop 自己固定资料目录）；`chromium_args()` 在 `apex.browser_hide_automation` 打开时加一次 `--disable-blink-features=AutomationControlled`，默认关。有窗口仍靠 #582 的 Desktop 产品配置 `browser.headed: true`；登录交给用户的提示词段不用改；接缝失败告警和种子注释改用 v0.23.0 的名字 |

## 合并缺陷（测试抓到、已修）

| 缺陷 | 原因 | 修复 |
|---|---|---|
| 同一条回复里的多段视频又变成一个接一个（hc-1068） | 上游自己的期限改动把“长期限工具是屏障”并进了 `_NEVER_PARALLEL_TOOLS` 那一行，git 无冲突地合在 fork 的同工具例外前面 | 恢复 fork 的顺序，在该行加 ApexNodes 注释 |
| 云镜像构建会失败 | 新的 `webapp_build` 阶段 COPY 并运行 `apps/desktop/scripts/build-webapp.mjs`，APEX 基线没有这个文件；fork 的 CI 不构建镜像 | 去掉这个阶段和 runtime 里对应的 COPY；镜像不带 `dist-webapp`，`webapp.enabled` 保持上游默认的关。新守卫 `tests/apex_overlay/test_dockerfile_sources.py` |
| Desktop 写入 `COPILOT_GITHUB_TOKEN` 会报 ModuleNotFoundError | fork 的 hc-903 预备函数还 import 已删除的 `hermes_cli.copilot_auth`；装了 github-copilot 插件后它的 provider 会进 `PROVIDER_REGISTRY` | 按普通 api-key 行准备（与上游 `load_pool` 一致）；新测试 |
| APEX Desktop 会把 `/approve`、`/deny`、`/history`、`/config` 列进建议 | 上游自己的 Desktop 有了处理器，于是去掉了这 4 条的 `desktop=` 标记；APEX 基线没有（批准走卡片，后两条走 slash.exec 会被拒） | 这 4 条保留 v0.22 的标记（同时影响实时 `commands.catalog` 和离线 dump） |
| 工具集没有可配置类别时，提示变成“Unknown provider” | hc-903 先在写入围栏外解析 provider 行 | 先按上游 `apply_provider_selection` 的顺序拒绝 |
| 重复的测试定义（code health F811） | add/add 合并保留了上游文件又拼上 fork 的尾部 | 只留一份 |
| 中文技能的索引行被截短，hc-1165 放进前 57 字的触发词又看不到 | 上游 3a3bf5648e 把索引行改为在 60 字预算内的最后一个空白处截断；中文词之间没有空格，于是退回到英文词前面那个空格。APEX 的 67 个技能里 10 条中文索引行被截到 24–51 字（如 `xiaohongshu-account-launch` 60→24，`short-video-studio` 丢了“工程、账号分析”）。apex-nodes 的 hc-1165 守卫抓到 | `agent/skill_utils.py` 的截断把中日韩字符也算作断点（UAX #14），取最后一个空白和最后一个中日韩断点里靠后的那个：中文索引行与 fork main 逐字节相同，英文行保持上游的按词截断，fork 自带的 190 个技能一条不变。新测试 `tests/agent/test_skill_index_cjk_clip.py` |

## 出口清单

查过的位置都列出，包括核实后不用改的。

**浏览器栈（agent-browser 和十个 `browser_*` 工具被删）**

| 位置 | 处理 |
|---|---|
| Desktop：`apex_overlay/media_tools.py` | 已改（见上） |
| Desktop：`browser.executable_path`、pm Chromium、`/etc/hermes/chromium-executable-path` 的优先级 | 用户设定和 pm 已装的浏览器仍然优先，COS 浏览器排在最后（测试 `test_a_pm_build_or_a_pin_still_wins`、`test_a_browser_the_user_pinned_is_never_downloaded_over`） |
| 网站黑名单（ApexNodes #149：每个出口都过黑名单） | `browser_exec` 对代码里每个网址字面量走 `tools.browser_url_policy`（SSRF 下限，然后网站策略），上游的浏览器测试都把网站策略桩掉了，新增 `test_browser_exec_refuses_a_blocklisted_url_before_any_browser_runs`；Firecrawl 跳转后复查仍在，测试的假响应改成 v0.23.0 的字段含义（`url` 是跳转后的地址） |
| 证据闸插件 | 已改（与 apex-nodes 同一份） |
| 云镜像 `Dockerfile` | 上游把烘焙路径改成 `/etc/hermes/chromium-executable-path`，原样接受；apex-nodes 侧的读法在配套 PR |
| `apex_overlay/cn_mirror_env.py` | 核实：它设置的 `PLAYWRIGHT_DOWNLOAD_HOST`、`HERMES_NODE_DIST_BASE` 在 v0.23.0 已没有运行时读者（Chromium 走 pm 或 COS 接缝，node 走 pm），留着无害；清理列入后续 |
| 托管助手（云端） | 见“待 Kael 决定”第 1 条 |
| Desktop：`apex_overlay/browser_window.py`（hc-1179） | 已改（见上） |
| Desktop：`browser_login_prompt`（登录交给用户的提示词段） | 核实：只讲窗口、登录和人机验证交给用户，不涉及工具名，不用改 |
| Desktop 种子 `browser.headed: true`（`apex-managed.ts`） | 核实：v0.23.0 的 `tools.browser_session_cloud.is_headed_mode` 读同一个键，不用改；注释里的旧函数名已更新 |
| Bot Desktop（`tools/bot_desktop/browser.py` 也读 `user_data_dir()`） | 核实：只在 Linux 启用（`tools/bot_desktop/runtime.py`），接缝只在 Mac / Windows 生效，两者不重叠 |
| 接缝失败告警（`plugins/apex-overlay/__init__.py`） | 已改：说 `browser_exec` 的窗口，不再说 agent-browser |
| apex-nodes 侧（技能、操作截图、证据闸、飞书进度、容器环境、能力目录、Office PDF 兜底） | 配套 PR，出口清单在那边 |

**被删或搬走的模块**

| 位置 | 处理 |
|---|---|
| 全仓静态 import 扫描（AST，所有 `import` / `from … import` 指向仓内模块的） | 只剩两处指向已删除模块：`agent/credential_pool.py`（hc-903，已修）和 `tests/fixtures/model_mutation_runtime.py`（已改）。上游自己的 3 处可选 import 与上游一致 |
| `apex_overlay` 与 APEX 插件里的动态目标（`import_module("…")` 和 `*_MODULE` 常量，共 35 个） | 全部可解析 |
| 搬走的平台适配器（微信、QQ Bot、Signal、BlueBubbles、WhatsApp Cloud、元宝）的旧路径 | 只有 `tests/gateway/test_hc1012_media_send_raise_notice.py` 还在用，已改；hc-1012 的修复（`send_voice` 收 `is_voice`）在搬过去的适配器里，反向验证过 |
| `apex_overlay/provider_filter.py` 的 Copilot 闸 | 退休 |

**技能索引（上游改为按词截断）**

| 位置 | 处理 |
|---|---|
| `agent/skill_utils.py` 的 `clip_skill_description`（`extract_skill_description` 和 `prompt_builder` 的两处都经它） | 已改（见“合并缺陷”） |
| APEX 平台技能和 Desktop 技能（apex-nodes `app/skills`、`app/desktop_skills`，67 个） | 逐个对比新旧截断：中文行全部恢复；剩下 39 条差异都是英文行末不再显示半个单词 |
| fork 自带技能（`skills/`、`optional-skills/`、`plugins/`，190 个） | 补丁前后一条不变 |
| `skill_manage` 的 60 字限制 | 上游行为：fork main 已对新技能生效，v0.23.0 扩到改动过的描述；平台技能不经 `skill_manage`，不受影响 |

**依赖（#597）**

| 位置 | 处理 |
|---|---|
| `pyproject.toml` | #597 改过的 20 项（certifi、filelock、Pillow 及其 override、PyJWT、urllib3、mcp ×3、pyasn1、aiohttp ×5、brotlicffi、mistralai、opentelemetry ×2、setuptools）合并后都不低于 #597；另有 6 条 v0.22 时代的条目 v0.23.0 自己改了形状，按 v0.23.0 |
| `uv.lock` | 20 个指定下限逐个达到；#597 锁里变过的每个包都不低于 #597 的版本；pm `--check-lock` 通过；OSV querybatch 362 个包只剩 weasyprint 62.3 |
| `pm/*`、`pm/pip_check.py`、`scripts/termux/*` 和移植来的测试 | 与 v0.23.0 逐字节相同（上游自己带着同样的移植） |

**apex-nodes 读 fork 的对照测试**

| 位置 | 处理 |
|---|---|
| 21 个读 fork 的测试文件（`FORK_PLUGINS_DIR`） | 指向合并后的本分支：三处替身没跟上 v0.23.0 的结构（平台显示档位挪进插件注册、截断拆出新函数、图片插件改经 `config_backend`），在配套 PR 里改；改完对着本分支 994 passed，对着现在的 fork main 只剩证据闸逐字节比对 1 条（本 PR 先合） |

**合并时两边各落一版的功能**

| 功能 | 处理 |
|---|---|
| hc-941 长期限工具（上游版本 + fork 版本） | 期限计算取上游；fork 叠在上面的 hc-1068 例外恢复顺序（见“合并缺陷”）；上游的期限测试与 fork 的批次测试都通过 |
| state.db sidecar、hosted-room 事件预算、LSP 退出 | 取上游写法，fork 的测试通过 |

**Desktop（APEX 基线）**

| 位置 | 处理 |
|---|---|
| `apps/desktop` 其余全部文件 | 与 fork main 逐字节一致 |
| `package.json` | `engines.node >=26`（与根目录和 CI 的 pm Node 一致）；`dompurify 3.4.17`、`katex 0.19.0` 写进 Desktop 自己的清单（安全 override，katex GHSA-238p-pmpm-9mq7） |
| `src/lib/desktop-slash-registry.json` | 按合并后的命令表重新生成；与 fork main 相比只多了新命令（`/autoprune`、`/discard` 可用，`/rewind`、`/worktree` 标为 terminal） |
| 身份层守卫（`*-identity.test.tsx`） | 见“验证” |
| tests-js | 两个新上游测试依赖 APEX 基线没有的上游 Desktop 模块，按路径加入 `APEX_DESKTOP_BASELINE`；三条 Webapp 构建测试在 `build-webapp.mjs` 缺失时跳过 |

**CI**

| 位置 | 处理 |
|---|---|
| Blacksmith runner 与 action | 合并时换回；新守卫 `tests/ci/test_fork_runner_compatibility.py::test_fork_ci_never_asks_for_a_blacksmith_runner_or_action`（workflows 和 actions 里任何非注释行出现 blacksmith 都算） |
| `js-tests.yml` 的 job id | 用上游的 `check`（名为 “JS & TS checks”）；fork 的分支保护只要求 “All required checks pass (v2)”，没有必需检查改名 |
| `.github/apex-upstream-baseline.json` | v0.23.0 / `2bd378ed1b`，`health_allow` 清空 |
| Desktop 基线跳过清单 | v0.23.0 把 `[host-backend-attach.ts]` 换成 `[local-gateway.ts]`，旧条目一直“通过”名字检查而新用例在跑并失败；补上它和 `build-webapp.mjs` 那条；`test_desktop_baseline_skips.py` 新增按 pytest 收集结果核对参数化 ID。`test_desktop_build_reuse.py` 两条也进清单：它把上游 Desktop 的 `bundle-env.mjs`、`product-identity.cjs` 复制进临时检出，APEX 基线两样都没有；在本树上复用探测报 `buildStampPayload is not a function`，`hermes update` 照旧重建（无法判断即重建） |
| fork CI 的 macOS runner | 上游的 macOS 测试跑在 12 vCPU 的 Blacksmith runner 上。`test_browse_schema_drift.py` 的 `[ddl]` 在 fork 的 GitHub 托管 `macos-latest` 上两次（`dd6ba36b96`、`55b26f01ef`，含任务内重试）都返回笼统的 “schema is unavailable or corrupt” 503，而不是预算内的 “nothing was changed”；fork 的 Linux runner 和开发机 Mac 都通过，开发机的能效核上则是 gateway 启动的 5 秒等待先用完。新增 `FORK_MACOS_RUNNER_SKIPS`：只在 fork CI 的 macOS 上跳过，Linux 照跑；名字守卫改为先去掉参数化 ID 的 `[...]` |

**上游新测试与 fork 设计的适配（测试改动，生产代码不变）**

| 测试 | 原因 |
|---|---|
| `test_execute_code_local_session_approval.py` | 样例 `"import os"` 在 hc-1034 的只读探测白名单里，改用 `"import os; os.listdir('.')"`（与 hc-1034 已有做法一致）；每个用例前后清掉 hc-1034 的暂停状态 |
| `test_skill_manager_tool.py::TestLockedGuard` | APEX 默认把后台复盘的技能写入暂存待审（hc-376）；这组用例让后台写入落盘，锁成为唯一的拒绝来源（与 `test_skill_ledger.py` 一致） |
| `test_legacy_turn_canonical_barrier.py`、`test_submit_time_user_row.py` | fork 按关键字传 `turn_id` / `hosted_images`（hc-905），桩改成接受关键字 |
| `test_whatsapp_dashboard_repair.py`、`test_hc903_side_config_mutations.py[whatsapp]` | hc-903 用 `asyncio.to_thread` 保存（写入围栏不能阻塞事件循环），上游的线程桩放行没有 `daemon` 参数的线程；hc-903 的记录桩补上 v0.23.0 新读的字段 |
| `test_cron_script_execution_history.py`（hc-889） | v0.23.0 浏览历史不再创建会话库（上游策略），测试先像 gateway 启动那样建库 |
| `test_session_events_execution_stamp.py` | 网关断言照常运行；与上游 Desktop 帧副本的比对在该文件存在时才跑 |
| `test_project_metadata.py` | python-docx 1.2.0 |

## 反向验证

每条都先断言被替换的文本恰好出现一次，再只跑守它的测试，最后还原。

| 撤掉什么 | 变红的测试 |
|---|---|
| hc-1068 的同工具例外排回屏障之后（即合并结果） | `test_parallel_video_generation.py` 9 条 |
| Dockerfile 换回合并时的上游版本 | `test_dockerfile_sources.py`（第 357、363、365 行） |
| hc-903 预备函数放回 Copilot 分支 | `test_a_plugin_registered_copilot_row_is_prepared_like_any_api_key_row`（ModuleNotFoundError） |
| 插件适配器的 `send_voice` 去掉 `**kwargs` | `test_weixin_send_voice_takes_is_voice_from_base_dispatch` 两条 |
| `check_execute_code_guard` 去掉本地会话规则 | 本地会话的 4 条和 smart 模式那条（后者改样例前是靠探测白名单“通过”的） |
| `browser_url_policy` 不查网站策略 / Firecrawl 不做跳转后复查 | 新的 `browser_exec` 黑名单用例 / 跳转用例 |
| 跳过清单放回 `[host-backend-attach.ts]` | `test_every_parametrized_entry_is_a_test_id_pytest_collects` |
| workflow 里放一个 Blacksmith runner / 一个 `useblacksmith` action | Blacksmith 守卫 |
| 媒体接缝的各项（不包启动器、不换安装器、无视用户设定、无视懒安装策略、COS 失败后退回 pm） | `test_media_tools_browser_seam.py` 对应用例 |
| clarify 不按规范化结果加标签 | `TestClarifyNoRecommendation` 6 条和 `test_proactive_chain` 两条 |
| Webapp 构建先拿锁再拒绝 | `test_webapp_renderer_build_is_refused` |
| 去掉 `test_desktop_build_reuse` 的基线条目 | `test_every_entry_names_an_existing_upstream_test` |
| macOS 跳过对所有平台生效 / 不并入 / 不看 fork CI 信号 | `test_macos_runner_skips_apply_only_on_the_fork_s_macos_runner` |
| 名字守卫不去掉 `[ddl]` | `test_fork_runner_skips_name_real_tests_and_their_follow_up` |
| provider_filter 六道闸逐一撤掉 | 各自点名的用例 |
| hc-1179 移植逐项撤掉：不包 `user_data_dir`、覆盖用户固定的目录、忽略有窗口、忽略平台、忽略开关、不去重、包回 agent-browser 的旧目标、插件不再调用接缝 | `test_browser_window_seam.py` 各自点名的用例（8 处，每处 1–5 条） |
| 截断去掉中日韩断点（即上游原样） | `test_skill_index_cjk_clip.py` 4 条；apex-nodes 的 hc-1165 守卫 2 条 |
| 截断只认中日韩断点、不认空白 | `test_skill_index_cjk_clip.py` 的 english、mixed 两条 |

## 验证

（数字在 PR 正文里随最后一次运行更新。）

- `python scripts/check`：全部守卫通过；code health 同步模式（`--upstream-base 2bd378ed1b`）0 条阻断。
- 全量 Python 套件（本机 macOS，12 个 worker）：合并后第一次跑有 95 个文件失败。逐个按测试 ID 与干净的上游 v0.23.0、fork main 比对：合并引入的已全部修好；其余与上游或 fork main 相同，都是本机环境问题（bash 3.2 没有 `mapfile`、系统代理拦截 127.0.0.1、`keychain` extra 未装、macOS 临时目录执行位、真实镜像 404）。
- `tests-js` 的 `npm run check`：typecheck、lint 通过；vitest 只剩 4 条与干净上游相同的 `/private/var` 路径别名失败。
- Desktop vitest（ui、electron）与身份层守卫：见 PR 正文。
- 并入 #598 / #582 / #597 之后：相关 Python 测试与合并前的 head `21d4f6b352` 用同一个 venv 逐 ID 比对，只多 1 条并发时序偶发（重跑通过）；apex-nodes 读 fork 的对照测试见“出口清单”。
- **本机验证不了的**：
  - `tests/ci/test_update_ci_routing.py` 等 37 条 workflow 重放测试（15 条在 macOS bash 3.2 上缺 `mapfile`，22 条只在 Linux / Windows 跑），只能看 fork CI。hc-913 的经验是这类失败会掩盖 Linux 上的真实失败。
  - 云镜像真实构建（本机没有 Docker）；静态守卫覆盖了 COPY 源和 RUN 调用的仓内脚本。

## 待 Kael 决定

1. **（下一次云镜像 roll 之前必须定）云端助手要不要浏览器。** 托管助手关了 `terminal`（apex-nodes `HOSTED_DISABLED_TOOLSETS`），而上游会从没有 terminal 的会话里拿掉 `browser_exec`（`model_tools._rewrite_browser_exec`）；agent-browser 的工具在新镜像上已不存在。换上 v0.23.0 镜像后，云端助手没有任何能打开网页的浏览器工具。三条路：
   - 一、fork overlay 让托管会话保留 `browser_exec`（它在每个助手自己的容器里跑 Python，与已开放的 `execute_code` 同类风险）；
   - 二、托管配置放开 `terminal`（安全姿态变更，同时放出 shell）；
   - 三、接受云端没有浏览器，技能改用 `web_extract`（先确认生产配了 `FIRECRAWL_API_URL`）。
2. **#582（hc-1179）先合：已按此做完。** #582、#597 合入 fork main（`40a7e45a0f`、`1e635626d5`）之后，本 PR 合入 main 并带上浏览器接缝的移植（见“APEX 接缝移植”和“反向验证”）。
3. **上游行为变化（已吸收，默认未改）**：
   - 一个 gateway 承载所有会话之后，本地 CLI / TUI / Desktop 自己的轮次里 `execute_code` 不再整段弹批准，靠脚本内每条 terminal 命令的批准（上游 T2）。消息平台、kanban、注入的轮次照旧整段批准。
   - cron 投递改为进队列、由 gateway 排出（hc-1186 的接缝已跟上）。
   - 上游新的 microsoft-office 技能第一次使用时会 pip 安装 documents extra；Desktop 打包没带这个 extra（列为 deferred）。
   - 上游 Webapp（浏览器里的 Desktop）不随云镜像发布，也不在 APEX Desktop 里。
   - `/debug local` 和两条新的 `/model` IM 文案保留上游英文，与同组旧文案一样等 Kael 定。
   - 技能索引行改为按词截断（中文按中日韩字符断开，修法见“合并缺陷”，是 fork 对 `agent/skill_utils.py` 的核心补丁）；`skill_manage` 对改动过的描述也卡 60 字（以前只卡新技能）。

## 后续（不在本 PR）

- hc-1034：子代理被拒或无人应答时记下的暂停不带轮次，父会话下一次检查时认领，即使那次检查已经在下一轮。子代理的无人应答会让下一轮第一条需要批准的操作直接被拦。
- `apex_overlay/cn_mirror_env.py` 设置的两个下载镜像变量已没有读者，可以删。
- 截断的中日韩断点是通用问题（不用本平台的中文用户也受影响），可以回贡上游；回贡与否由 Kael 定。
- `test_browse_schema_drift.py` 的 `[ddl]`：慢机器上浏览返回的 503 文案不对。找出是哪个错误绕过了预算，报给上游；查清后删掉 `FORK_MACOS_RUNNER_SKIPS` 里那条。
