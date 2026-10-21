# hc-1001 — 快速输入小窗改成中文和 APEX 品牌

## 范围

- Kael 2026-10-20 批准(经短视频评测主会话转达)，原话：「……批准 hc-1001 修快速输入小窗的英文和品牌，推送前再查一次号。只合并，不发版。」
- 起因：hc-994(fork #436)用全局快捷键唤出「快速输入」小窗(默认关)，发现整窗是英文，还写着上游的品牌：「Ask Hermes…」「Quick Entry」「Current chat」「New session」。
- 进 0.17.61。0.17.60 已经从 `1fd75201` 切出，不受影响。
- 只改 Desktop 渲染层(`apps/desktop/src`)。`electron/main.ts`、`electron/preload.ts`、主进程 IPC 都没动。

## 根因

1. 小窗是单独的 renderer(`?win=quick`)，挂载时没有 I18nProvider,所有文案写死在组件里。它也不知道主窗口用的是什么语言。
2. 设置里那两行(设置 › 高级)读 `t.settings.quickEntry`。这组键只有 en 和 ar 有,zh、zh-hant、ja 都静默回落英文；英文和阿拉伯文里写的是「without opening Hermes」。
3. 小窗的崩溃界面用的是应用自己的 `RootErrorFallback`。它从 I18nProvider 读文案，小窗没有 provider,就拿到上下文默认值，也就是英文。

## 改法

- 新模块 `src/i18n/quick-entry.ts`:小窗和设置两行的全部文案。每个语言都是完整对象，所以 zh 少一个键是类型错误，不会静默回落英文。zh、zh-hant、en 都写全；ar 保留原来的设置两行译文(品牌改成 APEX),小窗文案用英文；ja 回落英文，和 hc-960 / hc-971 的独立文案模块一样。
- 小窗的语言：主窗口(`useQuickEntryBridge`,只在主窗口跑)把自己解析出的语言写进 localStorage 的 `apex.desktop.quickEntry.locale`。小窗挂载时同步读这个值，之后监听 `storage` 事件，主窗口改语言时它跟着变。没读到值(首次启动时主窗口还没写)就用中文，和 `main.tsx` 的 `initialLocale="zh"` 一致。
  - 为什么不走现有的 IPC 状态推送：主进程只在小窗 `did-finish-load` 时重放一次上次的状态，小窗的监听器要等动态 import 完才挂上，可能错过这一次。localStorage 在第一帧就能读到，主题和窗口透明度也是这样跨窗口同步的。
- 小窗还把 `<html lang>` 设成当前语言(index.html 写死 `lang="en"`,屏幕阅读器会用英文语音念中文)。
- 没有标题、也没有预览的会话，原来在「发到」下拉里显示原始会话 id,现在桥接推空串，小窗显示「无标题会话」。
- 崩溃界面：`QuickEntryRoot` 给 `RootErrorFallback` 套一个 I18nProvider,语言取出错那一刻主窗口的语言。
- `en.ts`、`ar.ts`、`types.ts` 删掉 `settings.quickEntry`,一共少 28 行;`zh.ts`、`zh-hant.ts`、`ja.ts` 和 `electron/main.ts` 没动(FILE_LINES 棘轮)。

## 出口清单

### 改了的

| # | 位置 | 原来 | 现在(zh) | en |
|---|---|---|---|---|
| 1 | 小窗输入框占位(已连接) | Ask Hermes… | 问 APEX 点什么… | Ask APEX… |
| 2 | 小窗输入框占位(未连接) | Not connected — open Hermes to reconnect | 未连接，打开 APEX 重新连接 | Not connected — open APEX to reconnect |
| 3 | 输入框无障碍名 `aria-label` | Quick Entry | 快速输入 | Quick Entry |
| 4 | 「发到」标签 | Send to | 发到 | Send to |
| 5 | 下拉无障碍名 | Target session | 发到哪个会话 | Target session |
| 6 | 下拉选项 | Current chat | 当前会话 | Current chat |
| 7 | 下拉选项 | New session | 新建会话 | New session |
| 8 | 没标题的会话 | 原始会话 id | 无标题会话 | Untitled session |
| 9 | 小窗 `<html lang>` | en(index.html) | zh | en |
| 10 | 小窗崩溃界面 | Something broke in the interface / Retry / Reload window / Open logs(上下文默认 en) | 界面出错了 / 重试 / 重新加载窗口 / 打开日志 | 不变 |
| 11 | 设置 › 高级「快速输入」开关标题 | Quick Entry(zh 缺键回落) | 快速输入 | Quick Entry |
| 12 | 开关说明 | …without opening Hermes. | 在任何地方按全局快捷键，唤出一个小输入框，不用打开 APEX 就能发一句话。 | …without opening APEX. |
| 13 | 快捷键行标题 / 输入框无障碍名 | Quick Entry shortcut | 快速输入快捷键 | 不变 |
| 14 | 快捷键行说明 | Needs at least one modifier, e.g. CommandOrControl+Shift+Space. | 照着框里的写法：修饰键在前、按键在后，用加号连接，至少带一个修饰键。 | 不变 |
| 15 | 状态：已生效 | Shortcut is active. | 快捷键已生效。 | 不变 |
| 16 | 状态：被占用 | Another app already uses this shortcut — pick a different one. | 这个快捷键已被别的应用占用，请换一个。 | 不变 |
| 17 | 状态：格式不对 | Not a valid shortcut. Include at least one modifier key. | 快捷键格式不对，至少要带一个修饰键。 | 不变 |
| 18 | ar 开关说明 | …دون فتح Hermes. | …دون فتح APEX. | — |

zh-hant 同样写全(「問 APEX 點什麼…」「目前的工作階段」「新工作階段」「未命名工作階段」等)，用词跟 zh-hant 侧栏的「工作階段」一致。

### 查过、没改的

| 位置 | 为什么不改 |
|---|---|
| 设置里快捷键输入框的值和清空后的占位 `CommandOrControl+Shift+Space` | 这是设置本身(Electron 的按键写法)，用户就是照这个格式输入的，不是文案。中文说明已改成「照着框里的写法」。守卫测试把占位钉死成默认快捷键，别的英文句子藏不进去。改成按键录制、显示 ⌘⇧ 键帽的方案列在后续。 |
| 小窗里的「›」 | 装饰符号,`aria-hidden`。 |
| 小窗窗口标题 | 无边框面板，没有标题栏，在调度中心里也隐藏；`document.title` 来自 index.html,是「APEX」。 |
| 主进程日志里的 `Quick entry failed to load`、`[quick-entry] …` | 只写 desktop.log,用户看不到。 |
| ErrorBoundary 的 `label="quick-entry"`、console 抓取标签 | 只进日志。 |
| 崩溃界面的说明行显示 `error.message` 原文 | 主窗口的崩溃界面也是这样(同一个组件),是全应用的行为，列在后续。 |
| 全局快捷键注册失败 | 只有设置里的状态行提示(已改中文)和日志，没有系统通知。 |
| 托盘、应用菜单、Dock 菜单、命令面板、快捷键设置页 | 都没有「快速输入」入口(`electron/main.ts` 和 `src` 全仓检索过)。 |
| 设置搜索 | 这两行没进搜索索引(`settings-search.ts` 没有 quickEntry)。 |
| `electron/quick-entry.ts`、`preload.ts`、`global.d.ts` 里的「Hermes」 | 代码注释，不显示。 |
| ja | 原来就回落英文；和其他独立文案模块一样先回落 en。 |
| 默认关 | 主进程没有配置文件时按关处理(`readQuickEntrySettings`)，这一票不改。 |

## 守卫测试

`src/quick-entry-identity.test.tsx`(hc-589 身份层守卫的快速输入这一半，18 条)和 `src/app/quick-entry/quick-entry-root.test.tsx`(崩溃界面，1 条)，共 19 条:

- zh、zh-hant 下渲染小窗，已连接和未连接两种状态，读出全部可见文字和 `aria-label` / `placeholder` / `title`(复用 hc-953 的 `src/test/zh-copy.ts`)：除 APEX 等白名单外不能有英文单词，也不能有 Hermes。
- zh 下逐字核对占位、标签、四个下拉选项(含「无标题会话」)；主窗口还没写语言时按中文打开且 `<html lang="zh">`;主窗口切到英文时小窗不用重开就跟着变；英文下写 APEX。
- 设置两行在 zh 下三种状态(已生效 / 被占用 / 格式不对)都没有英文单词和 Hermes;快捷键输入框的占位必须正好是默认快捷键。
- 文案表：zh、zh-hant 的键和 en 一一对应，每条都没有英文单词，也不能跟英文原文相同(防止「键在、值还是英文」的回落);所有语言都不能出现 Hermes;五个主目录文件里不能再出现 `quickEntry:` 键。
- 主窗口桥接：渲染后 localStorage 里是主窗口的语言；没标题的会话推空串，不推 id。
- 崩溃界面在 zh 下是「界面出错了」「重试」「重新加载窗口」「打开日志」。

## 反向验证

脚本逐条注入故障：注入前断言锚点在目标文件里恰好命中一次，注入后确认文件确实变了，跑两份守卫，记录 vitest 实际报出的失败测试，再按原字节恢复并核对 sha256。基线 19 条全绿，24 条注入全部变红，恢复后 19 条全绿。

| 注入 | 代表的故障 | 变红条数 |
|---|---|---|
| app-placeholder-upstream | 小窗占位换回上游的「Ask Hermes…」 | 6 |
| app-disconnected-upstream | 未连接提示换回上游英文 | 4 |
| app-current-chat-literal | 下拉选项写死英文 | 3 |
| app-new-session-literal | 下拉选项写死英文 | 3 |
| app-send-to-literal | 「发到」写死英文 | 3 |
| app-input-aria-literal | 输入框无障碍名写死英文 | 3 |
| app-target-aria-literal | 下拉无障碍名写死英文 | 3 |
| app-untitled-shows-id | 没标题的会话显示 id | 3 |
| app-no-document-lang | 小窗保持 `lang="en"` | 1 |
| copy-zh-placeholder-hermes | 中文文案里出现 Hermes | 5 |
| copy-zh-current-chat-english | zh 对象里留着英文 | 3 |
| copy-zh-taken-english | zh 设置状态留着英文 | 2 |
| copy-zhhant-new-session-english | zh-hant 对象里留着英文 | 2 |
| copy-zh-falls-back-to-en | 整个 zh 回落英文 | 7 |
| copy-en-placeholder-hermes | 英文文案里出现 Hermes | 5 |
| copy-default-locale-en | 没读到语言时按英文打开 | 1 |
| copy-no-storage-listener | 主窗口改语言后小窗不跟 | 1 |
| copy-settings-hook-english | 设置两行不管语言都读英文 | 3 |
| settings-placeholder-sentence | 快捷键占位里藏一句英文 | 3 |
| settings-invalid-literal | 「格式不对」状态写死英文 | 1 |
| bridge-no-locale-write | 主窗口不写语言 | 1 |
| bridge-title-falls-back-to-id | 桥接把会话 id 当标题推 | 1 |
| root-fallback-without-provider | 崩溃界面没有 provider,回落英文 | 1 |
| catalog-key-back | 主目录文件里又出现 `quickEntry` 键 | 1 |

每条注入实际变红的测试名见 PR 正文附的脚本输出。

## 截图

临时 Vite 页面渲染真实组件，Electron 桥用桩代替，用系统 Chrome 无头截图，窗口尺寸按真实小窗 640×168。不是打包产物，没有在真机上唤出。背景渐变是为了模拟桌面，真实小窗背景透明。

| 文件 | 内容 |
|---|---|
| `screenshots/01-zh-connected.png` | zh,已连接 |
| `screenshots/02-zh-disconnected.png` | zh,未连接 |
| `screenshots/03-zh-target-options.png` | zh,「发到」下拉的全部选项(原生下拉弹层截不到，截图时把下拉临时改成列表显示) |
| `screenshots/04-zh-hant-connected.png` | zh-hant |
| `screenshots/05-en-connected.png` | en,写 APEX |
| `screenshots/06-zh-settings-active.png` | 设置 › 高级 两行，快捷键已生效 |
| `screenshots/07-zh-settings-taken.png` | 同上，快捷键被别的应用占用 |

## 验证

- `npm run typecheck`(四段)通过。
- 改动文件 eslint 0 error、prettier 干净。
- 新守卫 19 条通过；相关旧测试(store、error-boundary、identity-layer、i18n、设置、contrib)23 个文件 273 条通过。
- 全量桌面 vitest:1223 个文件通过、3 个跳过；12868 条通过、25 条跳过。

## 后续(不在这一票)

1. 设置 › 高级 同一页的「Keep computer awake」「Disable F12 DevTools」两行，zh 没有键，中文界面显示英文。
2. `lib/chat-runtime.ts` 的 `sessionTitle()` 兜底「Untitled session」和 `NEW_SESSION_TITLE`「New session」是写死的英文，侧栏、命令面板、会话切换器都会用到。
3. 别的独立小窗也没有 I18nProvider:宠物浮窗的「Open in APEX」是英文；`main.tsx` 把 HUD 窗口标题设成「Hermes HUD」,开场动画窗口标题是「Hermes」。
4. 快捷键设置改成按键录制，用 ⌘⇧ 键帽显示(像快捷键设置页那样)，不再让用户手写 `CommandOrControl+Shift+Space`;现在输入框还会把这串截断。
5. 崩溃界面说明行直接显示 `error.message` 原文，全应用都是这样。
6. 小窗的连接状态和会话列表仍然只靠主进程在 `did-finish-load` 时重放一次；小窗的监听器挂得晚就会错过，小窗显示「未连接」直到下一次推送。这一票的语言已经不走这条路；连接状态值得单独查。
7. 打包产物真机验收：唤出小窗看中文，切换语言后再唤出。
