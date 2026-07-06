# WORK-NOTES · hc-418 browser/computer-use 操作状态面 (W5-3, P2 Codex 对标)

Branch: `feat/hc418-op-status` · fork `karlligamesvc-spec/hermes-agent`
PD r416. Goal: 桌面 UI 可视化 runtime 的 browser_* / computer_use 工具调用,补信任感缺口。

---

## ① 摸底结论(runtime 真实事件源 — 读源码,非猜测)

### A. Browser 工具(`browser_*`) — `tools/browser_tool.py`

工具名单(`toolsets.py:47-50`,default bundle 全开):
`browser_navigate` `browser_snapshot` `browser_click` `browser_type`
`browser_scroll` `browser_back` `browser_press` `browser_get_images`
`browser_vision` `browser_console` `browser_cdp` `browser_dialog`

参数 schema(`BROWSER_TOOL_SCHEMAS`,`tools/browser_tool.py:1819+`):
- `browser_navigate(url)` — 1826-1831 `{url}`;**结果 JSON** `{success, url, title, snapshot, element_count}`(`browser_tool.py:2855-2858` + auto-snapshot 2896-2907)。→ **有 URL,无截图产物**。
- `browser_click(ref)` — 1854-1860,ref 如 `@e5`;结果含 `clicked`。
- `browser_type(ref, text)` — 1866-1878。
- `browser_scroll(direction)` — 1887-1894 enum up/down。
- `browser_press(key)` — 1911-1916。
- `browser_back()` / `browser_get_images()` — 无参。
- `browser_vision(question, annotate)` — 1929+,**唯一有截图产物的**:结果 JSON 含 `"screenshot_path": <abs png path>`(`browser_tool.py:4131`),且工具鼓励 agent 在回复里发 `MEDIA:<screenshot_path>`(见 description 1930)。截图是**文件路径**,不是 data-URL。

★ **截图产物有无**:browser 侧只有 `browser_vision` 产 `screenshot_path`(本地文件路径)。`browser_navigate/snapshot` 只给文本 accessibility snapshot(`snapshot` 字段),**无图**。

### B. Computer-use(`computer_use`) — `tools/computer_use/`

单一 tool,`action` discriminator(`tools/computer_use/schema.py:32-48`):
`capture click double_click right_click middle_click drag scroll type key set_value wait list_apps focus_app`

参数:`action`(必填)、`mode`(som/vision/ax)、`app`、`element`(SOM 序号)、`coordinate`[x,y]、`button`、`text`、`keys`、`direction`、`amount`、`value`、`capture_after` 等。

**结果形态**(`tools/computer_use/tool.py:238-288`):返回 JSON string(text-only:wait/key/list_apps/focus_app/失败),或 dict 标 `_multimodal`(image+summary),adapter 把 base64 图拼进 `tool_result`(`data:image/png;base64,...`,tool.py:26-27,34-36)。→ **capture/带 capture_after 的动作有截图,且是 data-URL(base64)**,可直接 `<img>`。

**审批门**(tool.py:269 `_DESTRUCTIVE_ACTIONS`):mutating actions(click/type/drag/scroll/key/…)走 approval;`capture`/`wait`/`list_apps` 免审批。Gateway 侧审批走「normal tool-approval infra」(tool.py:300-302),桌面已有 `PendingToolApproval`(tool-fallback.tsx:355)。
风险:computer_use 控**真实桌面**(背景模式,不抢光标 focus,但仍点真实 app)→ 需比 browser 更强警示。

### C. 桌面如何接 session 事件流(tool_call → UI)

事件管线:gateway RPC event → `use-gateway-boot.ts:223/250 onEvent` → `use-message-stream.ts:715 handleGatewayEvent`。
Tool 事件类型(`use-message-stream.ts:912-922`):
- `tool.start` / `tool.progress` / `tool.generating` → `upsertToolCall(..., 'running')`
- `tool.complete` → `upsertToolCall(..., 'complete')`
Payload → part 转换在 `chat-messages.ts:446-469 upsertToolPart`:产出 `{type:'tool-call', toolCallId, toolName, args, result, isError}`。payload 键:`name`(工具名)、`tool_id`/`tool_call_id`/`id`、`args`/`arguments`、`result`、`error`、`duration_s`。

渲染:`thread.tsx:628-629` 把 `MessagePrimitive.Parts` 的 `tools.Fallback` 设为 `ChainToolFallback`(thread.tsx:450-465),它按 toolName 分发:`todo`→null、`image_generate`→`ImageGenerateTool`、`clarify`→`ClarifyTool`、else→`ToolFallback`。**这就是插入 browser/computer 卡的官方 seam。**

`ToolFallback`(tool-fallback.tsx:505)→`ToolEntry`→`buildToolView`(tool-fallback-model.ts:1296)把 part 映射成图标/标题/副标题/detail/imageUrl/previewTarget。已有 `browser_*` tone=`browser` icon=`globe`,并有 navigate/click/type/snapshot 的 subtitle 逻辑(tool-fallback-model.ts:966-999)。但 model 里列的 `browser_fill`/`browser_take_screenshot` 是**上游命名,本 runtime 不存在**;缺 `browser_scroll/back/press/vision/console` 和 `computer_use` 的 title/subtitle。

`toolImageUrl`(tool-fallback-model.ts:786-803):只认 data-URL 或 remote http(s) 图,**丢弃裸文件路径**(避免 404)。→ browser_vision 的 `screenshot_path`(本地路径)当前会被丢。computer_use 的 base64 data-URL 会被认下(如果落在 `image_url/url/path` 键)。

### D. 停止/取消机制(真值)

**有真停止**:`use-prompt-actions.ts:1379 cancelRun` → `requestGateway('session.interrupt', {session_id})`(行 1425)。这是**整个 turn 级中断**(Stop 按钮 + Esc 已用,composer/index.tsx:1055/1610)。
**无 per-tool-call 取消** —— 中断粒度是整个 turn。
→ 诚实结论:操作卡的「停止」= 复用现有 `cancelRun`(session.interrupt),**真能停**(通过停掉当前 turn 停掉浏览器/桌面活动),不是假按钮。文案要如实(「停止」= 中断当前任务)。

### E. 全局状态存放

`SessionState`(app/types.ts:138-153):`messages/busy/streamId/interrupted`。tool parts 存在 message.parts 里(`chat-messages.ts` part 结构)。
`status-stack`(composer/status-stack/index.tsx)= composer 上方的状态 sink,session-scoped,由 `$statusItemsBySession` 驱动,分组渲染 subagent/background/todo/queue,每行有 onStop/onDismiss。→ 全局「正在控制浏览器/桌面」指示的自然归宿。

---

## ② ③ ④ 实现方案(诚实)

- 操作卡:`ChainToolFallback` 新增分支 `browser_*` / `computer_use` → `<OperationCard>`。卡显示:动作动词 + URL/目标 + (computer_use 的 app) + 截图缩略(computer_use base64 / browser_vision screenshot_path 经 electron file 协议;无图退文本卡)+ 状态。复用 disclosure/copy chrome 就地增强,而非丢弃。
- 全局指示:派生 store `$activeOperation`(从当前 running tool parts 计算 browser/computer 活跃),status-stack 顶部渲染一条 chip:browser=普通蓝、computer_use=醒目警示(红/琥珀 + 「正在控制你的桌面」)。chip 带「停止」→ `cancelRun`(真中断)。
- ⑤ 无操作时 `$activeOperation` 为空 → chip/卡都不出现,零噪音。

## ⑥ 测试
- 操作卡:有截图/无截图两态、browser vs computer、running/done/error。
- 状态 chip:出现/消失、computer_use 警示态。
- 停止:接 cancelRun(真中断)。
- desktop typecheck + vitest 零回归。

## 验证记录
（见文末,随实现更新）
