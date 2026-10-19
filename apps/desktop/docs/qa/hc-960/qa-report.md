# hc-960 — Desktop Flash / Pro / Max 三档 QA

## 范围与基线

- fork 基线：`82a74b09bc`（#418 合并后的 `main`）。版本保持 `0.17.58`；本票不构建公开安装包、不上传、不更新 updater feed。
- 只改 Mac / Windows 共用的 Desktop Electron 主进程、renderer、Bot Mode / Kanban 插件与测试；不改 ApexNodes 后端、Relay、Runtime 或生产配置。
- 档位开关默认关闭：中转站上线 `apex-flash` / `apex-pro` / `apex-max` 别名（WP2，服务端会话）之前，所有改动路径的行为与 `main` 相同。

## 怎么拍的

- dev build：Playwright 用 `npm run build` 的产物启动 Electron（主进程 + renderer），不是安装包；全新沙箱 HOME，走真实首启时序，不预置状态。
- `APEXNODES_MODEL_TIERS=1`；托管中转站、登录与 API 都指向仓库自带的 mock 推理服务（`tests-js/scripts/mock-server.ts`），不碰生产流量和真实账号。mock 的 `/v1/models` 只列 `apex-flash`、`apex-pro`，相当于一个“快速版”账号，Max 尚未开放。
- 每张截图后，脚本遍历页面上所有可见文本节点以及 `title` / `aria-label` / `placeholder`，用模型词表（deepseek、kimi、gemini、qwen、glm、mimo、claude、gpt-、`-APEX`、`apex-*` 别名、Nous Portal 等）扫描。

## 结果

| 截图 | 画面 | 扫描 |
|---|---|---|
| `0-before-tier-switch-off.jpg` | 对照：同一账号、开关关闭。开始页输入框里有 “DeepSeek Flash” 模型胶囊 | 有模型名（对照组，预期） |
| `1-start.jpg` | 开关打开：开始页没有模型胶囊 | 无模型名 |
| `2-answer.jpg` | 提问后的回答 | 无模型名 |
| `3-retry-stronger.jpg` | 回答下方常驻 “换更强的再答一次” | 无模型名 |
| `4-after-retry.jpg` | 点击后重新回答 | 无模型名 |
| `5-settings-tier.jpg` | 设置 › 档位：“这个助手用哪一档”，Flash（默认）/ Pro / Max（即将开放），“高级：用自己的模型服务” 折叠区 | 无模型名 |
| `6-settings-max-locked.jpg` | 点 Max：只解释，不切换 | 无模型名 |
| `7-bot-mode-add-assistant.jpg` | Bot Mode “添加助手”：三档在主表单里，选中 Pro | 无模型名 |

中转站按顺序收到的 `model`：`apex-flash`、`apex-flash`、`apex-pro`——“换更强的再答一次”确实以 Pro 发出，不是同档重答。

## 已知未覆盖

- 只拍了 macOS dev build；未打包、未在 Windows 真机上跑。
- 服务端别名尚未上线，这里的“可用档位”来自 mock 的 `/v1/models`；真实套餐的灰显以 WP2 上线后的 `GET /v1/models` 为准。
- 设置页顶部说明仍写“管理 APEX 的个性化、外观、提供方和已归档对话”，而提供方页面在档位模式下已折进“高级”；Bot Mode 对话框里 “Title” / “Description” 是原有英文标签。两处都列在 PR 的后续事项里。
