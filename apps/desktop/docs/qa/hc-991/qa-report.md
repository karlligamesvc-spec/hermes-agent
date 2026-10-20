# hc-991 — 首次使用三张选择卡：做什么内容、主要发哪个平台、最头疼什么

## 范围

- 开发方案 WP4「小白引导」第 1 项（冷启动三张选择卡），原型画布「首页 · 新用户冷启动」。Kael 2026-10-20 批准 hc-991（经短视频评测主会话转达）。
- Desktop 一半：开始页三张卡、设置 › 个性化「创作档案」、主进程读写账号接口并镜像画像段、本机助手每个新会话带上（apex-overlay 插件提示词分段）。
- 服务端一半在 apex-nodes 配对 PR（`GET/PUT /api/v1/account/creator-profile`，答案存在 hc-232 用户画像里）。

## 改后的样子

截图来自开发页面：临时 Vite 页渲染真实组件，界面语言 zh，Electron 桥用替身，替身按服务端规则应答。**不是打包产物。**

| 位置 | 样子 | 截图 |
|---|---|---|
| 开始页 第 1 张 | 「先回答 3 个小问题，我就知道该怎么帮你。」「你主要做什么内容？」「第 1 题，共 3 题」；A–E 好物测评、知识口播、探店、剧情、Vlog；F 一行「其他（自己写）」输入框（最多 40 字）；下方「点一下就行，也可以自己写。」「先跳过」「继续」 | `screenshots/01-content-type.jpg` |
| 第 2 张 | 「记下了。」「主要发在哪个平台？」抖音、小红书、视频号、快手、B 站，多选，选中的字母键帽变实心；选了才能点「继续」 | `screenshots/02-platforms-two-picked.jpg` |
| 第 3 张 | 「好，就按这些平台的习惯来。」「现在最头疼的是哪件事？」没选题、不会写脚本、不会剪、没流量、不会拍；点一下就答 | `screenshots/03-pain-point.jpg` |
| 完成 | 「记住了：好物测评 · 抖音、小红书 · 不会写脚本。之后的任务都会按这个来，想改可以去「设置 › 个性化」。」+「知道了」；三张都跳过时是「好，先不填。想补的话可以去「设置 › 个性化」。」 | `screenshots/04-done-line.jpg` |
| 设置 › 个性化 › 创作档案 | 说明一句（桌面上新开的对话马上按新的来；云端助手在下次重启后用上）；三行：主要做的内容（下拉，含「没填」「其他（自己写）」）、主要发布平台（五个开关按钮）、最头疼的事（下拉） | `screenshots/05-settings.jpg` |
| 设置里改 | 改成「其他（自己写）」并写「萌宠日常」、加选视频号；右上角「已保存」 | `screenshots/06-settings-edited.jpg` |

截图时设置页只渲染了「创作档案」这一段：个性化页的其他几段（关于、卸载、SOUL 编辑器）要更多 Electron 桥，开发页面起不来。挂载位置由 `personalization-settings.tsx` 决定（个性化页最上面）。

## 行为

- 只在已登录 APEX 账号、开始页（业务工作台，默认开）显示。云端说已经答完、账号没有这项功能（403/404）、读取失败、旧版主进程没有这个桥，都不显示。
- 每张卡答完立刻保存（一次一个 PUT）；中途退出，下次从第一张既没答也没跳过的卡接着问。
- 保存失败：卡片不动，提示「没保存上，请再点一次。」
- 不追问第二轮：三张都答过或跳过后，云端记一次 `completed_at`，之后不再出现；在设置里清空答案也不会重新弹。
- 复用提问卡：`clarify-tool.tsx` 只导出外壳、选项行、字母键帽和文本框样式，提问卡行为不变。开始页卡片不抢全局按键（开始页的字母键属于输入框），用点击和 Tab。

## 本机助手怎么带上

- 主进程每次读写都把云端返回的 `prompt_segment`（与云端助手 `agent.system_prompt` 里同一段「用户画像」）原子写到 `<HERMES_HOME>/apex/user-profile-prompt.md`（0600）。
- `apex_overlay/user_profile_prompt.py` 注册插件提示词分段 `apex.user-profile`，每个新会话建提示词时读一次；同一 Desktop 的所有本机 profile 读根目录这一份。已有会话不变。
- 退出登录、换成另一个账号登录、账号没有这项功能时删除；请求发出后换了账号，回来的回复不写。
- 真 `AIAgent` 测试：有文件时系统提示词里有「## Plugin Context: apex.user-profile」和三项，没有文件时没有。

## 和原型不一样的地方（请 Kael 看）

1. 选项按任务单：内容 5 类 + 自己写；平台 5 个、可多选（原型是单选 +「几个平台都发」）；头疼 5 项。
2. 完成提示写「想改可以去「设置 › 个性化」」，没写原型的「想改随时说"改一下"」：助手现在没有写回账号画像的工具。
3. 老用户第一次打开新版也会看到一次，可跳过；只给新注册账号看需要「新账号」的判据，任务单没要求。
4. 卡片沿用提问卡外观（填充色底、无描边），没用原型里带描边和阴影的卡片。

## 出口清单

| 出口 | 处理 |
|---|---|
| 开始页 `BusinessStartHome`（默认） | 加卡片 |
| 开始页回滚路径（业务工作台开关为 `0` 时的 `ScenarioShelf`） | 已核实，不加，回滚路径保持原样 |
| 新对话 / 会话页 | 不加（任务单：首个会话或首页，选首页） |
| 设置 › 个性化 | 加「创作档案」 |
| preload `managed.creatorProfile` ↔ 主进程 | 新增，注册在 `apex-account-reads.ts`；hc-914 对齐守卫通过 |
| 退出登录 / 换号登录 | 删镜像 |
| 同账号续期、runtimePending 翻转 | 已核实，不删 |
| 本机会话、本机网关接的 IM | 都经插件分段，一处覆盖 |
| 本机多个 profile | 读根目录同一份 |
| 云端容器 | 会加载 apex-overlay，但没有镜像文件，无分段 |
| 远程网关连接 | 卡片照常存到账号；远程那台机器读不到这台的镜像（没改） |
| 语言 | zh、zh-hant、en、ja、ar 五份都有类型约束；zh、zh-hant 不含英文（Vlog、B 站 例外） |

## 测试

- 新测试：`electron/apex-creator-profile.test.ts`、`src/store/creator-profile.test.ts`、`src/app/business-workspace/components/creator-intake-cards.test.tsx`、`src/app/settings/creator-profile-settings.test.tsx`、`tests/apex_overlay/test_user_profile_prompt_seam.py`。
- 全量桌面 vitest：12896 通过、7 失败；7 条在干净 fork main `922a8e3591` 上同一台机器逐条相同（`packaged-runtime.test.ts`、`runtime-gateway-retirement.test.ts`，起真进程）。
- `npm run typecheck`、`scripts/check`（12 项）、`tests/apex_overlay`（646 通过）。
- 反向验证 17/17 变红（每条注入先断言锚点只命中 1 次，跑完按 sha256 还原），清单见 PR。

## 还没验证

- 打包产物、全新空环境里的真实首启（硬规则 11）：登录 → 开始页三张卡 → 新会话问「帮我做个视频」，看助手是否按画像出方案。
