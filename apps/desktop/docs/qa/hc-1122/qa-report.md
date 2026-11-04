# hc-1122 — ChatCut 经 APEX 自己的账号接进 Desktop

PD Sheet1 第 1059 行。方案、出口清单和反向验证在 PR 正文，这里只记验收。

## 现在的做法

Desktop 不连 ChatCut。引擎的 `mcp_servers.chatcut` 指向 Scheduler 的代理 `/api/v1/chatcut/mcp`，用这个助手自己的 APEX key 登录。ChatCut 的凭据只在 Scheduler；代理按用户认领工程，只放剪辑工具（apex-nodes 的配对 PR）。

这台电脑上不登录 ChatCut，面板里也不开 ChatCut 编辑器：所有用户共用一个 ChatCut 账号，而 ChatCut 会把导入、本地渲染、取画面派给任何一个登录着这个账号的浏览器。

只做 Desktop：代理只认 Desktop 的 key，云端助手的 key 一律拒绝；云端容器里也没有这个开关，不会写这条配置。

本机文件和成片走 Scheduler（`apex_overlay/chatcut_files.py`）：
- `chatcut_upload_files` 把文件传给 Scheduler，由它在沙箱里跑 ChatCut 的上传助手；助手不进这台电脑。
- `chatcut_save_export` 经 Scheduler 把成片存进下载文件夹。ChatCut 的存储链接不用凭据就能下载，所以不进这台电脑，也不进对话。
- 第一次上传前弹卡片问用户，同意的记录在退出 APEX 账号或开关关掉时删掉。

## 验过的

| 项 | 怎么验的 | 结果 |
|---|---|---|
| 开关关 | `test_off_adds_nothing_and_writes_nothing`；身份层 golden `launch-env-off.json` | 不加提示词，不写 config.yaml；golden 逐字节不变 |
| 回滚 | 上一次写下的条目在开关关时被删掉，别的服务器不动 | 通过 |
| 开关开、已登录 APEX | 条目只有占位符 `${TOOLS_GATEWAY_BASE}`、`${TOOLS_GATEWAY_KEY}` | APEX key 不在 config.yaml 里，也没有 `mcp-tokens` |
| 开关开、没登录 | 没有条目，没有提示词段 | 通过 |
| 开发者自己的 `chatcut` 服务器 | 开关开、关都不动 | 通过 |
| 真引擎连代理 | 本地假代理 + 真 MCP 客户端 | 请求只到 `/api/v1/chatcut/mcp`，带 `Bearer <APEX key>`；代理多给的 `manage_memory` 被白名单挡掉 |
| 「看过程」 | `mcp__chatcut__*` 和两个文件工具的步骤文案 | 中、繁、英都不出现原始工具名 |
| 第一次上传 | `test_chatcut_files.py`，本地假 Scheduler | 卡片写明经过 APEX 服务器、存到 ChatCut 美国服务器、不花额度；不同意或没卡片时什么都不传；退出登录、关开关后重新问 |
| 上传什么 | 同上 | 只传绝对路径下、1 GB 以内的视频、音频、图片；`id_rsa`、相对路径、空文件、超大文件都不传 |
| 保存成片 | 同上 | 写满才挪进下载文件夹，不覆盖已有文件；没传完整就什么都不留 |

## 没验证的

- **真实服务端到端。** 要等 APEX 自己的 ChatCut 账号授权给 Scheduler（步骤在 apex-nodes PR 和 contract 里）。按要求，不再用任何人个人的 ChatCut 账号测。
- **真上传、真导出。** 协调会话 11-04 在服务器上用同一种沙箱跑通过一次（上传、转写、按文字剪、字幕、云端导出）；这个 PR 的代码还没对真账号跑过，验收步骤在 apex-nodes PR 里，要 Kael 批准后由协调会话执行。
- **真模型按技能走**、**打包产物**：开关打开前再验。

## 之前的验收（用户自己的账号，方向改了以后已撤下）

10-30/31 用 Kael 的免费账号，在系统 Chrome 和右侧面板里跑通过：授权、导入、转写、按文字剪、字幕、导出。改用 APEX 账号后，这条路径的代码已撤下（OAuth、面板编辑器、本机文件服务、设置页、退出账号时的清理），截图一并删掉。恢复时可以从这个分支的历史里找：撤下之前的最后一个提交是 `a7947a5e41`。
