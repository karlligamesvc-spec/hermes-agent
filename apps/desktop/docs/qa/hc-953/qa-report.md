# hc-953 — 中文界面：建议卡片与过程区补齐中文

## 范围

- 只做两件事：翻译；把内部标识（工具代码名、技能 slug）换成中文显示名。
- 不改布局和交互。唯一的样式调整是计时器：`StableText` 给全角字符两格宽，让「12 秒」和数字一样不抖。
- 「过程尽量简化、说人话」的改版等原型确认后另做，这里没有动。
- 起因：2026-10-18 短视频岗位评测里，真机中文界面出现了「Thought for 3s」「Tool Search 4 results 33ms」「Used 4 tools」「正在运行 Media Transcribe」「已加载技能: social-media-research」，以及提问卡里的「(Recommended)」。

## 出口清单

### 1. 提问卡（Desktop）

| 出口 | 处理 |
|---|---|
| `clarify-tool.tsx` 原样渲染后端的 `(Recommended)` | 改为显示 `assistant.clarify.recommended`：zh「推荐」、zh-hant「推薦」、ja「おすすめ」，en 不变 |
| `store/clarify.ts` 的 `RECOMMENDED_LABEL` / `bareChoice` | 保留。它是线标记，识别和剥离逻辑不变，只改了注释 |
| 跳过后点选项，写进输入框的 `lateAnswer` 带着线标记 | 改用 `bareChoice(choice)` |
| zh 缺 `confirmAndContinueLabel`、`answeredBadge`、`questionProgress`、`lateAnswer`、`lateAnswerTip`、`lateAnswerHint`，会回退英文 | zh、zh-hant、ja 补齐 |
| other、placeholder、skip、skipped、continueLabel、notReady、sendFailed、loadingQuestion、gatewayDisconnected | 查过，zh 已有，无需改 |
| A–D 键帽 | 查过。是按键，不是文字，保留 |
| 结算卡里后端 `tool_error` 的英文 | 残留。后端错误文本，很少出现 |

### 2. 消息渠道的 clarify 文字

| 出口 | 处理 |
|---|---|
| `gateway/platforms/base.py::send_clarify` 的编号文字 | 改在统一入口处理（见下）。飞书、企微、钉钉、QQ、微信、元宝都继承这条，没有各自的覆写 |
| `gateway/relay/adapter.py` 原生按钮 | 统一入口覆盖 |
| telegram、discord、slack、whatsapp_cloud、whatsapp（投票）、google_chat、photon（投票）的覆写 | 统一入口覆盖。按钮或投票回传的是显示文字，由 `strip_recommended` 识别本地化标签 |
| 文字回退 `text_fallback_coro` | 和卡片用同一份 `send_kwargs`，一并覆盖 |
| 用户照抄「先出样片（推荐）」回复 | `strip_recommended` 同时剥离英文线标记和当前语言的标签 |
| CLI（`cli.py`）、TUI（`ui-tui`） | 未改，属于开发者终端。列为残留 |
| 飞书托管（scheduler → :8642 api_server） | 工具集里没有 clarify，无出口 |
| **云端容器** | **需 Kael 定**。apex-nodes 的 `app/services/hermes_profile.py` 生成的配置里没有 `display.language`，容器也没设 `HERMES_LANGUAGE`，所以云端 IM 的 clarify 提示（以及所有 gateway `t()` 文案）都是英文。本 PR 的本地化在云端不生效，需要 apex-nodes 在配置里加 `display.language: zh`。这是只读代码得出的结论，没在生产核实 |

统一入口的做法：`run_turn_runner._ask_clarify_question` 把选项交给适配器之前，先过一遍 `shown_choices()`（`run_turn_runner_clarify_delivery.py`）→ `display_choice()`。登记到 `clarify_gateway` 的仍是线上原值，所以编号回复、按钮和文字匹配都照旧。新的语言键是 `gateway.clarify.recommended_choice`，17 个语言文件都已补齐。

### 3. 首页与输入框卡片

| 出口 | 处理 |
|---|---|
| `workflow-starter-card.tsx`，只渲染 i18n 的 title 和 summary | 组件本身没有文案。改了 zh、zh-hant 文案：`home.primaryPaths.commerce.summary` 的 Listing 改为「商品详情页」；`geo.prompt` 的 AI Search 改为「AI 搜索」；`videoStages.project` 的 Brief、Treatment 改为「创意简报」「拍摄方案」 |
| `workflow-starters.ts`、`view-model/workflow-starters.ts` | 只取 i18n，查过，无需改 |
| `video-quick-overview.ts` | 纯数据函数，没有文案，查过，无需改 |
| `lib/project-idea-templates.ts` 的 18 条英文灵感 | 新增 zh、zh-hant 两套，按界面语言选用；ja 仍用英文 |
| 新建项目对话框的「例如 Skunkworks」 | zh、zh-hant 改为「例如 新品上市」 |
| 新建项目对话框的「（保存到 IDEA.md）」 | 残留。IDEA.md 是真实文件名 |
| `suggestion-pills.tsx` | 只渲染 provider 给的文案，查过 |
| 技能建议胶囊：label、tip、done 用的是 slug | 改用技能中文名。未命名的技能显示「使用这个技能」。插入输入框的 `/slug` 命令不变，那是交互 |
| GitHub 胶囊 zh 里的「gh CLI 技能」「agent」「/github-auth」 | 改写 |
| mcp、repair、cron 胶囊 | zh 已有。zh-hant 原本五个 provider 全缺、会回退英文，已补齐 |
| 空状态建议：开始页（BusinessStartHome）和场景货架（ScenarioShelf） | 文案来自 i18n 和服务端目录，扫描后只有上面几处是英文。YouTube、TikTok、Instagram 是平台名，在白名单里 |

### 4. 过程区

| 出口 | 处理 |
|---|---|
| 「Thought for 3s」「Thought briefly」 | zh、zh-hant、ja 补 thought、thoughtBriefly、thoughtFor、turnDuration。秒的单位也走 i18n，显示「思考了 3 秒」 |
| 实时计时「12s」（`formatElapsed`） | 改为「12 秒」 |
| 「Tool Search 4 results 33ms」 | 标题走工具名表，显示「已查找可用工具」；计数走 `countLabel`，显示「4 条结果」；时长走 `formatDuration`，显示「33 毫秒」「2 分 6 秒」 |
| 「Tool Describe 4ms」 | 显示「已查看工具说明 4 毫秒」 |
| 「Used 4 tools」：`run-summary.ts` 里写死的英文 | 改走 i18n `runSummary`：「用了 4 个工具」「查阅了 3 项资料」「运行了 5 条命令」，分隔符用「，」 |
| 「正在运行 Media Transcribe」：未知工具把代码名转成英文标题 | 工具名表给出「正在转成逐字稿」。没有中文名的工具（MCP、kanban、a2a 等），zh 统一显示「已使用工具」「正在使用工具」 |
| `social_download` 等显示代码名 | 工具中文名表共 76 个：APEX 平台工具 27 个，工具检索桥 3 个，内置工具 46 个。下面有映射表 |
| 「已加载技能: social-media-research, …」 | 技能中文名表 59 个：apex-nodes 的 58 个平台技能，加上 Desktop 的 hypit。没列出的技能不显示 slug；读技能资源时不显示内部路径 |
| 重新加载历史后，`tool_call` 桥显示成「Tool Call」 | 解析出被桥接的工具，按它的中文名显示 |
| 展开后的固定标签 | 都改走 i18n：Search、Search results、stdout、stderr、exit 0、Tool payload、Arguments、Result、Details、Snapshot summary、Error details、Duration、「… N more characters truncated」、浏览器快照统计、cron 明细、错误兜底文案、N items、N fields、「… N more items」 |
| 委派卡兜底「Delegated task」 | 走 i18n |
| 状态行的读屏名「Hermes is working」 | 改为「APEX 正在处理」。en 也改成 APEX is working（身份层） |
| 助手互发消息：Messaging X、Messaged X、Message from X、show message（发送侧和接收侧） | 走 i18n |
| titles.memory、resultUnavailable、memoryWriteNoted、「Cron 任务」、「复制 URL」 | 补齐或改写 |
| 浏览器类子标题：Navigated in browser、Clicked …、Field:、Value:、Query:、Queried web sources、Executed command、Changed file、Fetched webpage、cron 子标题 | 查过。行头不渲染子标题（只给文件编辑用），不会上屏，未改 |
| 展开明细里由结果 JSON 字段名生成的标签，例如「Results」 | 残留。这是工具的原始数据，建议放进过程区改版处理 |
| 工具和命令的原始输出、搜索结果标题、模型写的 browser_exec 步骤说明 | 是数据，不是产品文案 |

### 5. 代码健康棘轮

五个 i18n 文件和 `gateway/run_turn_runner.py` 原本就超过行数上限，规则是只能变少。处理方式：

- 把各语言的 `assistant.tool` 段搬到同目录的 `i18n/<locale>-assistant-tool.ts`，类型搬到 `types-assistant-tool.ts`。
- 选项映射放进已有的兄弟模块 `run_turn_runner_clarify_delivery.shown_choices`。
- 改完后 `python scripts/check` 12 项全部通过，0 个阻断项。

## 守卫测试

`src/test/zh-copy.ts` 在 zh 下取出界面上的拉丁单词，然后去掉白名单。白名单只有 APEX、AI、GEO、GitHub、Instagram、TikTok、X、YouTube。键帽（`<kbd>`）不计入。

| 文件 | 守什么 |
|---|---|
| `components/assistant-ui/thread/zh-process-copy.test.tsx` | 真实 Thread 在 zh 下渲染：已完成一轮的摘要和展开后的每一行（思考、工具检索、技能、桥接调用、平台工具、无中文名的 MCP 工具）；真机所见的「Tool Search」那一行；进行中的行；思考计时；安静等待时的状态行；展开后的搜索、输出、退出码；助手互发消息的通知 |
| `components/assistant-ui/zh-clarify-copy.test.tsx` | 单问题卡显示「推荐」；多问题卡的进度和按钮；跳过后写进输入框的文字不带线标记 |
| `zh-cards-copy.test.tsx` | 扫描 zh 和 zh-hant 文案树：assistant.clarify、assistant.tool、思考和状态相关键、五个输入框胶囊、home.primaryPaths、workflows.homePaths 和 videoStages，不许有英文，也不许缺键；每个 APEX 平台工具都有中文名（来源是各 `plugins/apexnodes-*/plugin.yaml` 加 `tests/contracts/plugin_tools_contract.json`）；未命名技能不出 slug；开始页卡片；新建项目灵感；真实的技能和 GitHub 胶囊 provider |
| `tests/gateway/test_clarify_recommended_localized.py` | 走真实 clarify_tool → TurnRunner → clarify_gateway：文字提示里是「（推荐）」，回传的是去掉标签的选项；照抄显示的文字也能答上；原生卡片拿到本地化标签，按下后回传去掉标签的选项；英文保持原样 |

## 反向验证：注入什么，哪条变红

每次注入前先断言锚点在文件里只出现 1 次，注入后断言确实生效；跑完恢复文件，再核对 sha256 和原文件一致。25 处注入全部变红。

| # | 注入 | 变红的测试 |
|---|---|---|
| D1 | zh `thoughtBriefly` 改为英文 | zh-cards：has no English, and no key it lacks |
| D2 | 删掉 zh `thoughtFor`（回退英文） | zh-cards：has no English… |
| D3 | zh `clarify.recommended` 改为英文 | zh-clarify：3 条全部变红 |
| D4 | 卡片改回渲染 `(Recommended)` | zh-clarify：3 条全部变红 |
| D5 | 晚到答复带回线标记 | zh-clarify：drafts a late answer… |
| D6 | run-summary 写死 `${n} tools` | zh-process：4 条 |
| D7 | 毫秒写死 `ms` | zh-process：3 条 |
| D8 | 技能行显示 slug | zh-process：2 条 |
| D9 | 未知工具显示代码名 | zh-process：opens onto rows… |
| D10 | 从 zh 工具名表删掉 media_transcribe | zh-cards：names every APEX platform tool；zh-process：opens onto rows… |
| D11 | 历史里的 `tool_call` 不解析 | zh-process：opens onto rows… |
| D12 | stderr 标签写死 | zh-process：labels search results… |
| D13 | 退出码徽标写死 `exit` | zh-process：labels search results… |
| D14 | 灵感标签改为英文 | zh-cards：offers zh ideas… |
| D15 | 技能胶囊用 slug 作标签 | zh-cards：两条胶囊用例 |
| D16 | 开始页卡片标题改回 Brief | zh-cards：catalog sweep + Start cards |
| D17 | 「show message」写死 | zh-process：reports a message to another assistant… |
| D18 | 实时计时写死 `s` | zh-process：3 条，含思考计时和安静等待 |
| D19 | 结果摘要写死 `item` | zh-process：labels search results… |
| D20 | 未命名技能回退成 slug | zh-process，zh-cards |
| D21 | 状态行改回「Hermes is working」 | zh-process：names a quiet wait… |
| P1 | `display_choice` 改为原样返回 | gateway：文字提示和原生卡片 2 条 |
| P2 | `strip_recommended` 只认英文 | gateway：照抄显示文字和原生卡片 2 条 |
| P3 | 网关直接把线上原值交给适配器 | gateway：文字提示和原生卡片 2 条 |
| P4 | zh.yaml 标签改回英文 | gateway：3 条 |

## 其他验证

- Desktop：`npm run typecheck` 通过；改动文件 eslint 无新增问题（clarify-tool.tsx 的两条 exhaustive-deps 警告 main 上就有）。
- Desktop 全量 UI 测试：953 个文件、9202 条全部通过。
- Python：clarify、i18n 和各平台 clarify 相关 21 个文件，476 条通过、1 条跳过；`python scripts/check` 12 项通过。
- 截图：用真实组件在 zh 下渲染，开 Vite dev 服务器，在应用内浏览器里截图。用的是临时页面，不在本 PR 里。打包产物的真机复测没做，因为需要登录账号跑真实对话。

| 截图 | 内容 |
|---|---|
| `screenshots/1-process-summary.jpg` | 已完成一轮：「已思考」和摘要「已加载技能：社媒调研，…，用了 5 个工具」 |
| `screenshots/2-process-rows.jpg` | 展开后：「已查找可用工具 4 条结果 33 毫秒」「已查看工具说明 4 毫秒」、三个技能中文名、「已查看热榜」（桥接）、「已下载视频」「已转成逐字稿 2 分 6 秒」 |
| `screenshots/3-live-and-clarify.jpg`、`3b-live-rows-zoom.png` | 进行中：「正在使用 3 个工具」「正在下载视频 0 秒」「正在转成逐字稿 0 秒」；提问卡：「先出 10 秒样片 推荐」「其他 (输入你的答案)」「跳过」「继续」 |
| `screenshots/4-start-cards-and-pills.jpg` | 开始页卡片，含「商品详情页」「4. 创意简报与可编辑工程」；胶囊「使用技能：选题研究」「定时执行」 |
| `screenshots/5-new-project-ideas.jpg` | 新建项目：「例如 新品上市」，灵感胶囊全部中文 |

## 需要 Kael 定的事

1. 云端 IM 的语言：apex-nodes 给云端容器配置加 `display.language: zh`，云端的 clarify 提示和所有 gateway 文案才会是中文。要另开 apex-nodes 票。
2. 工具名和技能名两张映射表请过目，尤其是平台技能的叫法。
3. 白名单里的 GEO 和 AI 要不要保留，还是改成中文说法。
4. 灵感池仍是开发者向的题材（小游戏、接口封装…）。要不要换成创作者向，另开票。
5. ja 没有工具名和技能名表，仍显示英文代码名。是否需要补，另定。

## 残留出口（本票不做）

- 展开明细里由结果 JSON 字段名生成的标签（例如「Results」）。属于工具原始数据，放进过程区改版。
- CLI 和 TUI 终端里的 `(Recommended)`。
- 新建项目对话框里的 IDEA.md 文件名。
- 结算提问卡里后端 `tool_error` 的英文。

## 映射表

#### 工具中文名(zh;zh-hant 同义繁体)

| 工具 | 完成 | 进行中 |
|---|---|---|
| `tool_search` (工具检索桥) | 已查找可用工具 | 正在查找可用工具 |
| `tool_describe` (工具检索桥) | 已查看工具说明 | 正在查看工具说明 |
| `tool_call` (工具检索桥) | 已调用工具 | 正在调用工具 |
| `social_download` (APEX 平台) | 已下载视频 | 正在下载视频 |
| `media_transcribe` (APEX 平台) | 已转成逐字稿 | 正在转成逐字稿 |
| `image_ocr` (APEX 平台) | 已识别图片文字 | 正在识别图片文字 |
| `social_batch_submit` (APEX 平台) | 已提交批量下载转写 | 正在提交批量下载转写 |
| `social_batch_status` (APEX 平台) | 已查看批量进度 | 正在查看批量进度 |
| `creator_top_posts` (APEX 平台) | 已查看博主热门作品 | 正在查看博主热门作品 |
| `social_audience` (APEX 平台) | 已查看人群画像 | 正在查看人群画像 |
| `social_captions` (APEX 平台) | 已获取视频字幕 | 正在获取视频字幕 |
| `social_comments` (APEX 平台) | 已查看评论 | 正在查看评论 |
| `social_content` (APEX 平台) | 已查看作品详情 | 正在查看作品详情 |
| `social_creator_discovery` (APEX 平台) | 已查找博主 | 正在查找博主 |
| `social_keyword_insight` (APEX 平台) | 已查看关键词热度 | 正在查看关键词热度 |
| `social_posts` (APEX 平台) | 已查看账号作品 | 正在查看账号作品 |
| `social_product` (APEX 平台) | 已查看在售商品 | 正在查看在售商品 |
| `social_profile` (APEX 平台) | 已查看账号资料 | 正在查看账号资料 |
| `social_search` (APEX 平台) | 已搜索作品 | 正在搜索作品 |
| `social_trending` (APEX 平台) | 已查看热榜 | 正在查看热榜 |
| `generate_image` (APEX 平台) | 已生成图片 | 正在生成图片 |
| `generate_video` (APEX 平台) | 已生成视频 | 正在生成视频 |
| `live_record_start` (APEX 平台) | 已开始录制直播 | 正在开始录制直播 |
| `live_record_status` (APEX 平台) | 已查看直播录制进度 | 正在查看直播录制进度 |
| `live_record_stop` (APEX 平台) | 已结束直播录制 | 正在结束直播录制 |
| `doc_file_write` (APEX 平台) | 已生成文档 | 正在生成文档 |
| `xlsx_file_write` (APEX 平台) | 已生成表格 | 正在生成表格 |
| `pptx_file_write` (APEX 平台) | 已生成演示文稿 | 正在生成演示文稿 |
| `feishu_doc_write` (APEX 平台) | 已写入飞书文档 | 正在写入飞书文档 |
| `feishu_bitable_write` (APEX 平台) | 已写入飞书多维表格 | 正在写入飞书多维表格 |
| `annotate_preview` | 已标注预览 | 正在标注预览 |
| `browser_back` | 已返回上一页 | 正在返回上一页 |
| `browser_cdp` | 已执行浏览器指令 | 正在执行浏览器指令 |
| `browser_console` | 已查看网页控制台 | 正在查看网页控制台 |
| `browser_dialog` | 已处理网页弹窗 | 正在处理网页弹窗 |
| `browser_exec` | 已操作网页 | 正在操作网页 |
| `browser_get_images` | 已获取网页图片 | 正在获取网页图片 |
| `browser_press` | 已按下按键 | 正在按下按键 |
| `browser_scroll` | 已滚动页面 | 正在滚动页面 |
| `browser_vault` | 已使用保存的登录 | 正在使用保存的登录 |
| `browser_vision` | 已查看网页画面 | 正在查看网页画面 |
| `close_terminal` | 已关闭终端 | 正在关闭终端 |
| `computer_use` | 已操作电脑 | 正在操作电脑 |
| `cronjob_manage` | 已设置定时任务 | 正在设置定时任务 |
| `delegate_task` | 已委派任务 | 正在委派任务 |
| `desktop_preview` | 已打开预览 | 正在打开预览 |
| `desktop_project` | 已更新项目 | 正在更新项目 |
| `drive_preview` | 已打开文件预览 | 正在打开文件预览 |
| `feishu_doc_read` | 已读取飞书文档 | 正在读取飞书文档 |
| `feishu_drive_add_comment` | 已添加飞书评论 | 正在添加飞书评论 |
| `feishu_drive_list_comments` | 已查看飞书评论 | 正在查看飞书评论 |
| `feishu_drive_list_comment_replies` | 已查看飞书评论回复 | 正在查看飞书评论回复 |
| `feishu_drive_reply_comment` | 已回复飞书评论 | 正在回复飞书评论 |
| `focus_pane` | 已切换面板 | 正在切换面板 |
| `gui_tour` | 已演示界面 | 正在演示界面 |
| `manage_catalog` | 已查看可连接的应用 | 正在查看可连接的应用 |
| `manage_connections` | 已管理连接 | 正在管理连接 |
| `process_manage` | 已查看后台任务 | 正在查看后台任务 |
| `react_to_message` | 已回应消息 | 正在回应消息 |
| `read_terminal` | 已查看终端输出 | 正在查看终端输出 |
| `read_window_below` | 已查看窗口内容 | 正在查看窗口内容 |
| `send_message` | 已发送消息 | 正在发送消息 |
| `session_search` | 已搜索历史对话 | 正在搜索历史对话 |
| `set_theme` | 已切换主题 | 正在切换主题 |
| `setup_beat` | 已完成引导步骤 | 正在进行引导 |
| `show_tip` | 已显示提示 | 正在显示提示 |
| `skill_manage` | 已更新技能 | 正在更新技能 |
| `skill_view` | 已加载技能 | 正在加载技能 |
| `skills_list` | 已列出技能 | 正在列出技能 |
| `text_to_speech` | 已生成语音 | 正在生成语音 |
| `todo_list` | 已更新待办 | 正在更新待办 |
| `video_analyze` | 已分析视频 | 正在分析视频 |
| `video_generate` | 已生成视频 | 正在生成视频 |
| `x_search` | 已搜索 X 平台 | 正在搜索 X 平台 |
| `xai_video_edit` | 已编辑视频 | 正在编辑视频 |
| `xai_video_extend` | 已延长视频 | 正在延长视频 |

#### 技能中文名

| 技能 slug | 中文名 |
|---|---|
| `amazon-listing-optimization` | 亚马逊商品页优化 |
| `amazon-review-analysis` | 亚马逊评论分析 |
| `bad-review-recovery` | 差评挽回 |
| `batch-viral-breakdown` | 批量爆款分析 |
| `benchmark-account-breakdown` | 对标账号拆解 |
| `campaign-planning` | 活动策划 |
| `competitor-analysis` | 竞品分析 |
| `complaint-handling` | 客诉处理 |
| `conversion-copywriting` | 转化文案 |
| `creator-content-selector` | 博主爆款筛选 |
| `customer-support-reply` | 客服回复 |
| `design-studio` | 设计工作室 |
| `dianping-review-reply` | 点评回复 |
| `document-summary` | 文档摘要 |
| `document-workbench` | 文档制作 |
| `douyin-account-launch` | 抖音起号 |
| `douyin-to-bitable` | 抖音视频建档 |
| `douyin-transcript-organize` | 视频逐字稿整理 |
| `douyin-video-transcript` | 视频转逐字稿 |
| `faq-answering` | 常见问题解答 |
| `file-export` | 文件导出 |
| `financial-research` | 财务与行业研究 |
| `generation-ladder` | 分步生成 |
| `group-solitaire-script` | 群接龙文案 |
| `honesty-verification` | 事实核验 |
| `hypit` | 视频制作 |
| `image-generation` | 图片生成 |
| `live-script-breakdown` | 直播话术拆解 |
| `meeting-summary` | 会议纪要 |
| `objection-handling` | 异议处理 |
| `presentation-workbench` | 演示文稿制作 |
| `product-research` | 选品调研 |
| `professional-writing` | 专业写作 |
| `proposal-writer` | 方案撰写 |
| `quote-message-writer` | 报价话术 |
| `real-estate-listing-copy` | 房源文案 |
| `refund-negotiation` | 退款协商 |
| `restaurant-menu-offer-packaging` | 餐饮套餐包装 |
| `review-mining` | 评论挖掘 |
| `sales-follow-up` | 销售跟进 |
| `selling-point-extractor` | 卖点提炼 |
| `shop-ledger-bot-config` | 店铺台账 |
| `short-video-studio` | 短视频工作室 |
| `skill-authoring` | 技能编写 |
| `social-batch-transcribe` | 批量下载转写 |
| `social-image-understanding` | 图片文字识别 |
| `social-media-research` | 社媒调研 |
| `social-post-writer` | 社媒文案 |
| `spreadsheet-quality-check` | 表格数据检查 |
| `spreadsheet-workbench` | 电子表格制作 |
| `text-polish` | 文字润色 |
| `topic-research` | 选题研究 |
| `video-generation` | 视频生成 |
| `video-script-breakdown` | 视频脚本拆解 |
| `wechat-moments-selling` | 朋友圈卖货文案 |
| `wechat-mp-account-launch` | 公众号起号 |
| `x-account-launch` | X 平台起号 |
| `xiaohongshu-account-launch` | 小红书起号 |
| `xiaohongshu-note-style` | 小红书笔记写作 |
