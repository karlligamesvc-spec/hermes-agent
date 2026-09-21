# hc-690 — Desktop 统一安装与更新中心

> 状态：第一批已随 APEX 0.17.14 正式发布并完成 Mac/Windows 真机升级验收；第二批 durable plan 已合并；第三批真实进度实现中
> 日期：2026-08-08
> 产品决策：首次安装、Desktop 壳更新、Hermes Runtime 更新共用一个用户入口、一个进度界面和一条可恢复更新流程；底层产物继续独立发布与回滚。
> 边界：不修改 hc-685 Desktop vNext 原型。

## 0. 本批交付边界（2026-08-08）

本 PR 先完成用户最痛的“两个入口、两次确认、两次重启”闭环，不把一次 UI 收敛伪装成完整更新平台重写。

已交付：

- 新增共享 `desktop-update` 编排：Runtime-only、Shell-only、Shell+Runtime 均从同一 action 进入；
- 当前壳兼容目标 Runtime 时，先更新 Runtime，再由 Shell 的一次 `quitAndInstall` 完成整轮重启；
- Runtime 要求更高 Shell 时，在退出前原子持久化 `runtime-after-shell` 计划，新壳启动后自动续跑 Runtime；
- 侧栏、关于页、Command Center 共用同一检查、确认、执行和进度状态；命令面板只导航到该统一入口；
- 更新进度直接复用 `DesktopInstallOverlay` 的品牌、卡片、阶段行和错误恢复表面；
- 覆盖英文、简中、繁中、日文、阿拉伯文，并新增入口身份守卫与跨重启编排测试。

下列内容仍是本文件定义的目标架构，不在第一批 PR 冒充完成：完整 durable plan 状态机、真实字节级联合进度、下载取消、磁盘预检、损坏计划隔离、Shell-only 重启后版本读回、全故障矩阵与签名正式包真机验收。真机验收结果必须回填本文件和飞书 PD 后才能把 hc-690 标为完成。

第二批已实现、待下一正式 Desktop 版本发布验收：

- durable plan 新增 plan id、创建/更新时间、当前/目标壳与引擎版本、阶段、恢复次数和有界错误；兼容读取第一批 0.17.14 写出的最小 schema；
- Shell-only 也在 native install 前持久化计划，新壳启动后用 `app.getVersion()` 与本地 Runtime marker 读回冻结目标，未命中时保留计划并记录失败；
- 截断 JSON、未知 schema 等损坏计划会原子改名到 `.corrupt-*` 诊断文件并 fail-open，不阻塞 Desktop 启动；
- 恢复开始/失败 transition 写回主进程 authority，renderer 退出后仍可诊断。

第三批已实现、待合并及下一正式 Desktop 版本发布验收：

- Runtime bundle 下载从“请求结束后才报一次”改为每个网络数据块上报真实 received/total/attempt，断点续传继续从磁盘已有字节起算；
- 主进程把 preflight、download、verify、activate、complete 阶段推送给统一更新界面；renderer 仅展示，不持有机器更新真值；
- 有真实字节时展示字节与确定百分比；校验、激活、native install 等没有可信百分比的阶段改为不确定进度，不再伪造“当前阶段完成一半”；
- Runtime bundle 原有下载前磁盘预检继续作为硬门禁，并把所需/可用空间的可读消息透传到统一错误表面；不足时不进入更危险的 legacy fallback；
- 进度回调全程 fail-soft：窗口关闭或 IPC 观察者异常不得中断下载、校验或原子切换。

## 1. 问题与目标

当前 Desktop 存在三套用户感知：

1. 首次安装由 `DesktopInstallOverlay` 展示 bootstrap 十阶段；
2. Runtime 更新由 Runtime 胶囊/关于页触发，成功后 reload，再进入 bootstrap 或 bundle 流程；
3. Desktop 壳由 `electron-updater` 后台下载，侧栏另出壳更新胶囊，点击后 `quitAndInstall`。

两条更新通道各自正确，但用户会看到两个版本、两个入口、两次确认，甚至两次重启。当前“壳胶囊优先、Runtime 胶囊让位”只是在视觉上避让，不是联合更新。

本票目标：

- 用户只看到“APEX 安装/更新”，无需理解壳与 Runtime 的实现边界；
- 首次安装、Runtime-only、Shell-only、Shell+Runtime 使用同一进度表面；
- 同一轮更新最多确认一次、完整退出重启一次；
- 壳与 Runtime 仍是两个可独立灰度、校验、回滚的产物；
- 进程退出、机器重启或网络中断后能恢复同一更新计划；
- 任何失败不得破坏当前可用 Runtime 或覆盖用户显式配置。

## 2. 产品入口

### 2.1 单一更新概念与动作

- 侧栏只渲染一个 `UpdateCenterPill`；不得再同时出现 Shell/Runtime 两个胶囊。
- 设置 → 关于只保留一个“应用与引擎”区块：同时展示 Desktop 与引擎当前版本，但只有一个“检查更新/立即更新”动作。
- Command Center 只保留一个“检查 APEX 更新”动作，并调用同一 store/action。
- 首次安装无入口选择：应用启动时自动进入同一个全屏进度表面。

旧壳缺少联合 IPC 时允许 renderer 使用现有 Shell/Runtime bridge 兼容降级；降级不得显示两个主 CTA。

### 2.2 文案

正常用户文案统一使用“APEX”或“应用”，不把 `Electron`、`bootstrap`、`pin`、`fork sha` 暴露为主信息。

主标题：

- 首装：`正在安装 APEX`
- 更新：`正在更新 APEX`
- 待重启：`更新已准备好`
- 成功：`APEX 已是最新版本`

版本详情可展示：

- `应用 0.17.x`
- `引擎 v0.20.x`（继续使用现有 humanized display version）

## 3. 统一状态模型

Electron 是机器更新事实的唯一 authority。Renderer 只订阅快照、展示并发起有限动作。

```text
idle
  -> checking
  -> available
  -> downloading_shell
  -> downloading_runtime
  -> verifying
  -> staging
  -> ready_to_restart
  -> restarting
  -> resuming
  -> activating_runtime
  -> starting_gateway
  -> completed

任一可恢复阶段 -> failed(retryable)
用户允许取消的阶段 -> cancelled
```

目标态的统一计划至少冻结以下字段（第一批仅实现跨壳恢复所需的 schema/kind/requestedAt 与 shell/runtime 目标版本）：

- schema version；
- plan id / created at / last transition；
- 当前 Desktop 版本与目标 Desktop 版本；
- 当前 Runtime key/version 与目标 Runtime key/version/commit；
- 平台、架构、bundle schema；
- Runtime `min_desktop_version`；
- 各产物下载/校验/暂存状态；
- 是否需要 native shell install；
- 是否需要跨重启恢复；
- 上一次错误分类与可重试阶段。

计划写入应用数据目录并原子替换；完成或明确取消后清理。禁止把下载 URL、token、key 或用户内容写入 renderer persistence。

## 4. 编排规则

### 4.1 首次安装

- 继续使用现有 bootstrap runner 与十阶段协议；
- 通过统一 view-model 适配到更新中心；
- 首装仍可展示 Python/Node/配置等详细步骤，但默认主摘要只显示“准备环境/安装引擎/启动服务”；
- 取消、失败重试、日志保存语义保持不变。

### 4.2 Runtime-only

- 下载并校验平台 bundle；
- 使用现有 never-in-place staging、verify、atomic pointer/link switch；
- 激活后重启 gateway/刷新 renderer，通常不退出整个 Desktop；
- legacy bootstrap fallback 仍通过同一进度表面展示。

### 4.3 Shell-only

- `electron-updater` 继续负责平台包、签名/哈希验证与 native install；
- 下载进度映射到统一状态机；
- 下载完成只出现一个“立即重启并完成更新”按钮；
- 调用 `quitAndInstall` 前持久化计划，下一进程启动后验证运行中的壳版本并结束计划。

### 4.4 Shell + Runtime

用户只点击一次“立即更新”。

1. 冻结本次 shell/runtime 目标组合；
2. 若当前 shell 能安全理解 bundle schema，允许先下载/校验/暂存 Runtime；
3. 若目标 Runtime 要求更高 shell 版本，不得在旧壳激活；持久化计划后先安装壳；
4. 新壳启动后自动恢复同一计划，下载或激活 Runtime；
5. 启动 gateway，读回 Desktop 与 Runtime 实际版本；
6. 两者达到冻结目标才标记 completed。

禁止把“Runtime latest 在执行中发生变化”混入已冻结计划；新版本留到下一轮检查。

## 5. 统一进度界面

以当前 `DesktopInstallOverlay` 为视觉真值，抽取通用 `InstallUpdateProgress` 表现组件；bootstrap、shell updater、runtime bundle 分别提供 adapter，不复制第二套 overlay。

默认摘要阶段：

1. 检查更新
2. 下载应用
3. 下载引擎
4. 校验与准备
5. 重新启动
6. 完成

详细信息展开后才展示 bootstrap 十阶段、真实耗时和日志。

目标态进度规则（第三批已完成 Runtime bundle 字节进度、`aria-live` 与不确定进度；shell native install 仍无可信百分比）：

- 有真实 bytes 时按 bytes 展示；
- 无法取得 native install 百分比时显示不确定进度，不伪造数值；
- 不再用“已完成步骤 + 当前步骤半步”作为用户主百分比；
- `role=progressbar` 提供 min/max/now；阶段变化通过 `aria-live=polite` 播报；
- `prefers-reduced-motion` 下关闭非必要进度动画。

取消规则：

- 下载/Runtime staging 可取消；UI 立即进入 cancelling/cancelled，清理由后台完成；
- 已调用 native `quitAndInstall` 后不可取消，不显示误导按钮；
- 取消只影响当前动作，不同时关闭底层页面或触发第二个 Esc 行为。

## 6. 失败与回滚

| 故障 | 行为 |
|---|---|
| shell 检查/下载失败 | 保持当前壳与 Runtime；显示可重试错误；周期检查仍可继续 |
| Runtime bundle 下载/sha/verify 失败 | 不切 pointer；保留当前 Runtime；允许重试 |
| shell 已更新、Runtime 未完成 | 新壳继续使用旧 Runtime（兼容门禁通过时）并恢复计划；若不兼容则进入明确恢复表面，不启动错误组合 |
| Runtime 已暂存、shell 安装失败 | 不激活要求新壳的 Runtime；回到 ready/retry |
| 进程在任意阶段退出 | 下次启动从 durable plan 与真实磁盘状态重算，不盲信上次 renderer 状态 |
| 计划损坏/版本不支持 | 隔离损坏计划并记录诊断；回退到独立检查，不阻塞应用启动 |
| 空间不足 | 在下载/解压前拒绝，展示所需/可用空间；不走更危险的 legacy fallback |

验证器不得复用写入标记作为唯一真值：壳版本用运行中 `app.getVersion()`，Runtime 用 marker + tree/source stamp + active pointer 三方核对。

## 7. 数据、配置与兼容边界

- 用户显式的模型、session、approval、reasoning、memory、skill 等配置不得因联合更新被覆盖；沿用 hc-687 的“只补缺省值”守卫。
- 不把 Runtime 打进 Desktop 安装包；两种产物仍独立签名/发布/回滚。
- 不增加用户可见的 `HERMES_*` 环境变量；内部计划为应用实现细节。
- 不修改 hc-685 导航与业务工作区原型。
- 不在本票改变 v0.20 能力默认开关。
- 不把更新成功仅定义成进程重启或 HTTP 200；必须读回实际版本与 gateway health。

## 8. 验收矩阵

### 8.1 行为

- [ ] 首装只出现统一进度界面，成功后进入应用。
- [x] Runtime-only 只有一个入口和一次确认（组件与编排测试）。
- [x] Shell-only 只有一个入口；0.17.13 → 0.17.14 真机均只重启一次且版本读回正确；第二批已补主进程 durable readback，待下一版本验证自动清计划。
- [x] Shell+Runtime 只有一个入口和一次确认，编排只触发一次完整应用重启（单测）。
- [x] Runtime 要求新 shell 时先壳后引擎，旧壳不激活不兼容 Runtime（单测）。
- [ ] Runtime 不要求新 shell 时允许预下载/暂存，重启后快速完成。
- [x] 关于页、侧栏、Command Center 调用同一 action/state，不产生两个更新提示；命令面板导航到同一入口。
- [x] 首装、更新、恢复态使用同一视觉组件和五语言文案（代码与视觉验收）。

### 8.2 故障注入

- [ ] shell feed 404 / 下载中断 / hash 或签名失败。
- [ ] Runtime bundle 404 / sha 不符 / 解压失败 / verify 失败。
- [ ] 低磁盘、只读目录、pointer 切换失败。
- [ ] `quitAndInstall` 抛错。
- [ ] 下载、staging、重启前、重启后各阶段强杀进程并恢复。
- [x] durable plan 被截断或 schema 超前会被拒绝并隔离为 `.corrupt-*`，不阻塞启动。
- [x] 撤掉跨重启恢复逻辑后对应编排测试会变红。
- [x] 撤掉“不兼容 Runtime 不激活”门禁后对应编排测试会变红。
- [x] 注入旧上游双入口后 identity/入口守卫会变红。

### 8.3 平台

- [x] macOS arm64 正式签名、公证包从 0.17.12 → 0.17.13 → 0.17.14 连续升级，配置与工作数据哈希保持。
- [x] macOS x64 正式签名、公证、Gatekeeper 与发布 feed 通过（无独立 x64 真机）。
- [x] Windows x64 正式发布包从 0.17.12 → 0.17.13 → 0.17.14 连续升级，配置与工作数据哈希保持；安装包当前仍未签名。
- [x] 使用 COS 正式 feed 与已安装打包产物验证，不使用源码/dev server 或预置更新状态自证。

### 8.4 APEX 0.17.14 正式发布验收（2026-08-09）

- fork PR #225 合并提交：`be676eec4188e250132f003ea0508f0b2cb7277f`；
- macOS workflow `31310234192`：arm64/x64 build、签名、公证、Gatekeeper、GitHub artifact 与 COS feed 全部成功；
- Windows workflow `31310235831`：x64 build、完整性门禁与 COS feed 成功；安装包未签名，保持为已知发布边界；
- 三份正式 feed 均为 `0.17.14`：`mac-arm64/latest-mac.yml`、`mac-x64/latest-mac.yml`、`win-x64/latest.yml`；
- Mac 真机：Help → Check for Updates 实际进入 `#/command-center?section=system`，显示 `AI 引擎 0.20.0`；`codesign --deep --strict` 与 `spctl` 均通过；
- Windows 真机：0.17.14 asar `package.json` 版本读回正确，统一系统页显示 `AI 引擎 0.20.0`，五项稳定配置哈希与升级前一致；
- COS 对 multi-range 返回包 MIME 而非 `multipart/byteranges`，因此 0.17.13 → 0.17.14 仍回退完整包；0.17.14 已配置 sequential single-range，必须在下一正式版本的真实升级中闭环，不能提前标记实机通过。

## 9. 交付与发布

- fork PR 标题必须含 `hc-690`；
- 更新 Desktop feature contract/身份层守卫；
- renderer typecheck/lint/build 与完整 desktop 测试全绿；
- Mac/Windows 签名发行前先做本地打包产物 smoke；
- 发布后用正式 feed 做旧版本 → 新版本联合更新真机验证；
- 飞书 PD 回填 PR、构建、真机结果与回滚点。
