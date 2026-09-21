# hc-844 — Hermes 0.21.3 全量基线收敛与补丁对账

## 结论

- APEX fork 从 `68bd8f3a74` 全量合并上游稳定标签 `v2026.9.14`
  （annotated tag `7a963716b8`，release commit `345cd2b057`），Hermes Runtime 升至
  `0.21.3`。
- APEX Desktop 产品版本保持 `0.17.30`；本票不是公开发版票，不推进 updater、
  COS 安装包或生产部署。
- 合并原则是保留 APEX 的产品身份、中文默认值、业务导航和托管服务接线，同时吸收
  上游 runtime、Desktop shell、会话、队列、通知、provider 与安装器的稳定性改进。
- 对账发现一项旧补丁已被上游完整替代；远端实机门禁还发现两项已经由上游修复、但在
  下游融合时被旧 APEX 分支覆盖的安装器行为，现已按上游语义恢复并保留 APEX seam。
  其余平台特有能力继续保留或迁移到上游的新 seam。另发现两处上游 0.21.3 尚未覆盖
  的 macOS 系统代理边界，已补回归。

## 补丁去留

| 补丁 / 行为 | 处理 | 依据 |
|---|---|---|
| hc-644 工具参数日志限长 | 删除下游实现 | 上游已统一使用 `_FULL_ARGS_LOG_BOUND=100_000`，继续保留会造成双重截断 |
| hc-376 后台 review 写 skill 需审批 | 保留并迁移 | 上游拆出 `tools/write_approval.py` 后仍无 APEX 的 background-origin stage 规则 |
| hc-206 企业微信群环境白名单回退 | 保留 | 上游仍没有 `WECOM_GROUP_ALLOWED_USERS` 的 env-only fallback |
| 微信 reset banner 过滤与过期会话真实状态 | 保留并手工融合 | 属于 APEX 渠道产品契约，上游没有等价实现 |
| hc-684 Tirith 临时下载重试 | 保留 | 上游没有覆盖该网络故障路径 |
| 中国区 COS / 镜像安装链路 | 保留 | 上游新增 Python、Termux、Node archive 修复，但不替代 APEX 的 COS-first 路径 |
| Windows managed Python 版本报告与 venv 判定 | 采用上游并融合 | 上游已统一使用实际解析出的 `$resolvedPython.Version`；融合时曾退回配置版本，现恢复上游语义并保留 APEX 安装流程 |
| Linux Node archive 无 xz 回退 | 采用上游并融合 | 上游两个安装入口均已在缺少 `xz` 时选择 `.tar.gz`；现同时恢复，并保留 `HERMES_NODE_DIST_BASE` / COS 下载基址 |
| Desktop 通知主进程实现 | 采用上游 | 上游已抽成 `notification-ipc.ts`，旧内联实现不再保留 |
| 旧 bot chat pointer 兼容测试 | 删除 | 上游 canonical session registry 已替代旧指针模型 |
| APEX Desktop 身份层、中文默认值、业务首页、托管 relay、国内 provider 目录 | 保留 | 产品层契约，不由通用上游替代 |
| hc-843 排队消息 exactly-once claim | 本票不吞并 | 稳定标签与当前 upstream/main 均无等价实现；保持独立 PR，在 hc-844 后重放 |

## 手工融合点

上游 0.21.3 将若干大文件拆成模块。自动 merge 一度把旧单体实现追加到新实现之后，
形成“双实现”。本票恢复上游拆分结构，再把仍需保留的 APEX 行为放到新的责任边界：

- `agent/conversation_loop.py`、`agent/background_review.py`、`tools/approval.py`、
  `tools/web_tools.py`、`hermes_cli/main.py`、`hermes_cli/web_server.py`、
  `hermes_cli/session_export_html.py`：移除旧单体重复块。
- `tools/write_approval.py`：迁移 hc-376 的后台写入审批规则。
- `agent/background_review.py`：保留 staged-write 结果摘要。
- `hermes_cli/main_desktop.py`：保留 APEX.app / APEX.exe / APEX 可执行文件识别。
- `plugins/web/searxng/provider.py`：以新的 Base provider 为基线，融合 APEX 网关认证、
  self-hosted keyless 与可操作错误信息。
- `tools/environments/local.py`：以新环境清洗流程为基线，保留 APEX 用户 bin PATH 增广。
- `scripts/install.ps1`：采用上游按实际解析出的 Python 版本报告和判断 venv 的行为，
  保留 APEX 的 Windows 安装与镜像接线。
- `scripts/install.sh`、`scripts/lib/node-bootstrap.sh`：恢复上游的 xz 能力探测和 gzip
  回退，同时继续使用 APEX 可配置的 Node 分发基址。
- `apps/desktop/electron/main.ts`：采用上游 notification / ambient claim / SSH profile
  清洗，同时保留 APEX 环境桥、Windows updater preflight 与安全打开策略。
- Desktop renderer：采用上游 canonical session group、队列 retry tick、hidden display kind、
  gateway bootstrap 等修复，保留 APEX 的会话优先选择和产品导航。
- 根目录 `docs/`：上游已迁走该目录，但 fork 中的 APEX 产品契约、发布说明、ADR 与
  运维边界仍是下游事实源，因此不随上游删除。

## 本次新增稳定性修复

`agent/anthropic_adapter.py` 现在复用 runtime 的 keepalive HTTP transport。此前 stock
`httpx` 会读取 macOS 系统代理，却不执行系统代理的 ExceptionsList，导致
`127.0.0.1`、局域网或自定义 Anthropic-compatible endpoint 被错误送到代理并在到达
服务前返回 502。修复后只采用显式代理环境变量，并与 OpenAI 通道共用 NO_PROXY
语义和连接池策略。

反向验证：在修复前，直接 `httpx` 和 Anthropic SDK 请求本地捕获服务器均返回空体
502，服务器收到 0 次请求；修复后
`tests/agent/test_anthropic_client_auth.py` 的真实回环请求通过，并确认只发送目标
provider 的 `x-api-key`，不泄漏环境中的 bearer token。

`tools/url_safety.py` 现在只在明确设置 `HTTP(S)_PROXY` / `ALL_PROXY` 环境变量时
启用代理 mount；没有显式代理变量时不再从 macOS SystemConfiguration 隐式继承代理。
这样既保留上游的代理环境能力，也避免 Slack / 企业微信远端素材下载绕过直连 transport
的连接时 DNS 重绑定校验。反向验证覆盖了“显式代理仍存在 mount”和“清空代理变量后
重绑定在发起 TCP 连接前被阻断”两侧契约。

全量回归还暴露了 4 个只在 30 worker 重负载下首跑失败、重试通过的时序测试。本票将
LSP 退出改为先等待 100 ms 的协议级自然退出，避免退出与 PID 重用竞态；另外把三个
测试改为分别等待真正的 watchdog、为非超时断言保留调度余量、让 WebSocket 超时发生在
请求进入阻塞 provider 后。对应 22 项定向回归通过。

GitHub 的真实 Windows runner 进一步发现安装日志仍引用配置的 Python minor，而不是
最终解析出的解释器版本；Linux Python slice 则通过“移除 xz”故障注入发现两个 Node
安装入口仍会挑选 `.tar.xz`。两项在上游稳定标签中都已经修复，说明问题来自融合覆盖，
不是上游缺能力。本票已恢复上游行为，并对两个 Node 入口分别验证“有 xz 选 xz、无 xz
选 gzip”，防止只修一个入口。

Linux 全量分片随后发现 shutdown diagnostic 虽然成功创建了子进程，融合结果却漏掉了
稳定标签和原 APEX 分支都存在的 `return proc.pid`，使调用方恒收到 `None`。本票恢复该
返回契约，并新增跨平台、确定性的 PID 守卫；反向删除返回语句时守卫稳定变红，Linux
真实子进程用例继续负责验证日志实际落盘。

远端全量门禁还暴露了稳定标签自身的高并发测试抖动。对照 upstream/main 后确认其中
三项已有标签后的上游修复：delegate 超时事件窗口（`bd607f3835`）、远程 kernel 注册表
并发快照（`16bddc88dd`）、local-model quickstart 固定硬件预算（`86b809934a`）。本票只
吸收这些测试稳定化，不混入标签后的产品功能；同形的 sidebar single-flight 事件测试也
改为等待真实事件并保证释放。另将 APEX 身份守卫迁到 v0.21 的 `main_desktop.py` seam，
并让语音偏好故障测试拦截实际 localStorage prototype，避免守卫测试自身失真。

## 上游标签之后的已知项

- upstream/main 的 `0e5da5e9ec` 包含 duplicate-final 修复，但不在稳定标签
  `v2026.9.14` 内；不混入本次稳定标签合并，后续单独评估 backport。
- 已选择性吸收 upstream/main 的三项纯测试稳定化提交：`bd607f3835`、`16bddc88dd`、
  `86b809934a`；没有因此把 main 上其余未发布功能带入本票。
- hc-843 是 APEX 队列消息 exactly-once 修复，仍须在本票合并后 rebase / replay；
  upstream 0.21.3 的队列保护不能替代它。

## 验证矩阵

| 门禁 | 结果 |
|---|---|
| Desktop renderer 全量 Vitest | 888 files / 8,468 tests 通过 |
| Desktop Electron 全量 Vitest | 219 files；2 skipped；2,998 passed |
| Desktop TypeScript typecheck | 通过 |
| Desktop ESLint | 0 errors；220 个上游/存量 warnings |
| paired-release gates | 78 Node tests + 15 Vitest tests 通过 |
| Python `ruff check .` | 通过；仅 3 个 invalid-noqa warnings |
| Python bytecode compile | 通过 |
| Python runtime 全量 suite | 4,210 files / 50,069 passed / 0 failed / 608 OS-specific skipped；退出码 0 |
| Python 重负载 flake 收敛 | 4 files / 22 tests 通过 |
| 新暴露并发测试定向循环 | 4 files / 31 tests × 10 轮连续通过 |
| GitHub Windows-only runner | 真实 Windows 门禁通过（含 managed Python fallback） |
| Node archive 双入口故障注入 | `install.sh` 与 `node-bootstrap.sh` 均通过有/无 xz 两侧验证 |
| APEX 身份 / 语音偏好守卫 | 2 files / 45 tests 通过；修复前对应 3 项会稳定变红 |
| shutdown diagnostic 返回契约 | 确定性 PID 守卫通过；删除 `return proc.pid` 后稳定变红 |
| Desktop production build | 通过（Vite renderer + Electron main/preload + native/updater deps） |
| Desktop packaged/fresh-env gate | 本票不产出发布包；留给 Mac/Windows 成对发布票执行 |

## 发布边界

本票只建立可评审的收敛分支和完整验证证据。合并、生产部署、Mac/Windows 成对构建、
公开 updater feed 更新均需要后续明确授权。
