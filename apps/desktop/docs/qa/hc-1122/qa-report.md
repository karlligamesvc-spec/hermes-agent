# hc-1122 — ChatCut 经 APEX 自己的账号接进 Desktop

PD Sheet1 第 1059 行。方案、出口清单和反向验证在 PR 正文，这里只记验收。

## 现在的做法

Desktop 不连 ChatCut。引擎的 `mcp_servers.chatcut` 指向 Scheduler 的代理 `/api/v1/chatcut/mcp`，用这个助手自己的 APEX key 登录。ChatCut 的凭据只在 Scheduler；代理按用户认领工程，只放剪辑工具（apex-nodes 的配对 PR）。

这台电脑上不登录 ChatCut，面板里也不开 ChatCut 编辑器：所有用户共用一个 ChatCut 账号，而 ChatCut 会把导入、本地渲染、取画面派给任何一个登录着这个账号的浏览器。

只做 Desktop：代理只认 Desktop 的 key，云端助手的 key 一律拒绝；云端容器里也没有这个开关，不会写这条配置。

## 验过的

| 项 | 怎么验的 | 结果 |
|---|---|---|
| 开关关 | `test_off_adds_nothing_and_writes_nothing`；身份层 golden `launch-env-off.json` | 不加提示词，不写 config.yaml；golden 逐字节不变 |
| 回滚 | 上一次写下的条目在开关关时被删掉，别的服务器不动 | 通过 |
| 开关开、已登录 APEX | 条目只有占位符 `${TOOLS_GATEWAY_BASE}`、`${TOOLS_GATEWAY_KEY}` | APEX key 不在 config.yaml 里，也没有 `mcp-tokens` |
| 开关开、没登录 | 没有条目，没有提示词段 | 通过 |
| 开发者自己的 `chatcut` 服务器 | 开关开、关都不动 | 通过 |
| 真引擎连代理 | 本地假代理 + 真 MCP 客户端 | 请求只到 `/api/v1/chatcut/mcp`，带 `Bearer <APEX key>`；代理多给的 `manage_memory` 被白名单挡掉 |
| 「看过程」 | `mcp__chatcut__*` 的步骤文案 | 中、繁、英都不出现原始工具名 |

## 没验证的

- **真实服务端到端。** 要等 APEX 自己的 ChatCut 账号授权给 Scheduler（步骤在 apex-nodes PR 和 contract 里）。按要求，不再用任何人个人的 ChatCut 账号测。
- **导入本机素材。** 共用账号下没有安全的做法，要 ChatCut 提供服务端导入接口。在那之前，这个功能没法端到端用起来，所以开关不能开。
- **真模型按技能走**、**打包产物**：开关打开前再验。

## 之前的验收（用户自己的账号，方向改了以后已撤下）

10-30/31 用 Kael 的免费账号，在系统 Chrome 和右侧面板里跑通过：授权、导入、转写、按文字剪、字幕、导出。改用 APEX 账号后，这条路径的代码已撤下（OAuth、面板编辑器、本机文件服务、设置页、退出账号时的清理），截图一并删掉。恢复时可以从这个分支的历史里找：撤下之前的最后一个提交是 `a7947a5e41`。
