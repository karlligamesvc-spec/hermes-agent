# hc-993 — 结果后的「下一步」按钮（桌面端）

## 范围

- 开发方案 WP4 第 3 项：每个结果后面 2–3 个「下一步」按钮（存进选题库、写成脚本、做成发布包），失败时同样给退路。桌面端做按钮组件，技能约定输出格式。
- 约定写在 apex-nodes `docs/NEXT-STEPS-BLOCK-PROTOCOL.md`（`apex-next/1`），两个仓都按它做；云端那半（技能、IM 编号、选题库、下发闸）在配对的 apex-nodes PR。
- 只改消息结果这一层：输入框（composer）、首页、引导没动。
- 发版：按 Kael 10-20 的决定放进 0.17.61，不进 0.17.60。

## 改后的样子

截图来自开发用的预览页（真组件 + Electron 桥的代理桩 + `setRuntimeI18nLocale('zh')`），不是打包产物。

| 状态 | 截图 | 说明 |
|---|---|---|
| 结果后面 | `screenshots/1-result-buttons.jpg` | 答案下面一排按钮「存进选题库 / 写成脚本 / 做成发布包」；块的原文不显示。鼠标停在按钮上显示「点一下就发：…」。点一下等于用户发了那句话（用户消息照常显示），之后这一排就没了。 |
| 失败 | `screenshots/2-failed-three-buttons.jpg` | 技能写 `failed=生成样片`，显示 hc-973 的三个按钮（同一个组件、同一套发出去的话）。 |
| 还在输出 | `screenshots/3-streaming-no-block.jpg` | 不出按钮，还没写完的块也不露。 |
| 过程区已卡住 | `screenshots/4-stuck-step-no-duplicate.jpg` | 这一轮某一步失败、过程区已经给了三个按钮时，正文下面不再重复一排。 |

## 实现

- `src/lib/next-steps.ts`：解析与删块。与 apex-nodes 插件 `apexnodes-next-steps` 对共用样例 `next-steps.fixtures.json`（24 条，期望值手写）给出同样的结果；apex-nodes CI 比对两份样例逐字节相同。另有流式语音用的过滤器：一边收增量一边扣住可能是块开头的部分，块结束就丢掉。
- `src/components/assistant-ui/next-steps.tsx`：挂在助手文字部件后面。只有这一部件真带块、而且输出完了，才去读这一轮的状态；只在最新一轮、这一轮最后一个气泡、这一轮不在跑时出按钮。网关没连上时按钮置灰；点过一次就不能再点。
- 失败退路：把 hc-973 过程区的三个按钮抽成 `FailureActions`，过程区和这里共用，文字和发出去的话只有一份（`i18n/*-process.ts` 的 `failure` 段）。
- 文案：新模块 `i18n/next-steps.ts`（zh / zh-hant / en，ja / ar 退回英文），只有这一排的无障碍名「下一步」和悬停提示；按钮上的字是技能自己写的，不翻译。大文件 `en/zh/zh-hant/ja/types.ts` 没动（FILE_LINES 棘轮）。
- `plugins/apexnodes-next-steps/`：apex-nodes 云端插件逐字节相同的一份，加进桌面端默认启用的插件（`MANAGED_PLUGIN_NAMES` 与 `cli-config.yaml.example`）。桌面聊天（`platform=desktop`）的块原样留给渲染层；本机网关接的飞书、微信等 IM 换成编号文本；提到「选题库」时附上 `HERMES_HOME/apex/选题库.md`。
- 拉平台技能时带 `caps=next-steps`：没带的旧版本，服务端把技能里「结果后的「下一步」」一节去掉，所以旧版本的模型不会写块。

## 出口清单（块不能以原文出现的地方）

| 位置 | 处理 |
|---|---|
| 聊天正文 Markdown（`lib/markdown-preprocess.ts`） | 删块（含没写完的、被包进代码块的）；本身也是 HTML 注释，Streamdown 不显示 |
| 按钮（`components/assistant-ui/next-steps.tsx`，挂在 `thread/message-parts.tsx`） | 新增 |
| 复制（`thread/assistant-message.tsx` 的 `getMessageText`） | 删块 |
| 朗读、语音对话整段念（`lib/speech-text.ts` `sanitizeTextForSpeech`） | 删块 |
| 语音对话边出边念（`lib/voice-playback.ts` `startSpeechStream`，直连和网关两条路） | 扣住并丢掉块 |
| 系统通知「回复完成」（`use-message-stream/index.ts`，取回复前 140 字） | 删块 |
| 本机网关接的 IM（`plugins/apexnodes-next-steps`） | 编号文本 |
| 链接预览（`AssistantPreviewEmbeds`，只取链接） | 已核实：块里没有链接，不用改 |
| 用户消息、系统消息、推理 | 共用同一个 Markdown 预处理，块会被删；这些地方本来不会有块 |
| 会话标题 | 已核实：引擎只拿第一条用户消息起标题（`agent/title_generator.py`），碰不到块 |
| 侧栏会话搜索的预览（`app/chat/sidebar/index.tsx`，全文检索片段） | 没改：片段是搜到的词前后一小段，搜的词正好在块里时，预览里可能出现半行「存进选题库 \| 把这 5 个…」；片段没有块的开头，删不干净，列为后续 |

## 验证

- 新测试：`src/lib/next-steps.test.ts`（共用样例 + 流式过滤）、`src/components/assistant-ui/next-steps.test.tsx`（14 条，用 hc-973 的拆爆款夹具和真 Thread）、`src/lib/voice-playback.next-steps.test.ts`、`src/app/session/hooks/use-message-stream/next-steps-notification.test.tsx`、`tests/plugins/test_apexnodes_next_steps.py`（插件走本运行时真的钩子：`apply_llm_output_transform`、`_collect_pre_llm_call_context`、`tui_gateway` 报的平台名）。
- 反向验证 19 条注入，每条先断言锚点只命中 1 处，跑完按 sha256 还原；全部变红。表在 PR 里。
- 全量桌面 vitest：1223 个文件、12890 条通过；2 个 Electron 进程管理测试文件失败，干净的 fork main 上同样失败（本机环境）。`npm run typecheck`、eslint、`python scripts/check`（12 项）通过。

## 后续

1. 飞书按钮卡片：容器里的飞书适配器只给审批卡画按钮，别的卡片点击是 `/card button {…}` 命令。要发一张带按钮的卡片、把点击当成用户发了那句话，和飞书上的提问卡一起做。现在飞书和微信一样是编号。
2. 打包产物真机验收（需要登录账号）。
3. 选题库进桌面端界面（列表、改状态），与云端同步。
4. 侧栏会话搜索的预览片段：搜到块里的词时会带出半行块内容（见出口清单），要在检索前把块从消息里拿掉，或在片段里认出块的行。
