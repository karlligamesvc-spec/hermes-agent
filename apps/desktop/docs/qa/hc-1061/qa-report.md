# hc-1061 — G3 单线侧栏 1:1（原型 v2）

## 范围

- 原型 v2 第一批，Kael 2026-10-26 批（经协调会话转达）。只在 `desktop_features.single_thread` 的产品模式生效；开关关和开发者模式仍是完整的 ChatSidebar，`single-thread-shell/sidebar.html`、`account-menu.json` 两个 golden 没动。
- 依赖：hc-1064（形象，本 PR 的 base）；apex-nodes hc-1062（`GET /api/v1/account/plan-usage`）。服务端没部署前，账户行显示邮箱，和现在一样。

## 改后的样子

左边原型，右边 Desktop。截图来自开发页面：临时 Vite 页渲染真实组件，侧栏用壳的默认宽度 190px，Electron 桥用替身（套餐用量和微信绑定是假数据）。**不是打包产物。**

| 状态 | 侧栏 | 截图 |
|---|---|---|
| 第一次打开 | APEX 字标 + 搜索；APEX 一行（还没有回复，所以没有副标题）；「在微信里找 APEX · 扫一下就绑上」；「小满 · 快速 · 本月用了 3%」 | `screenshots/01-first-open-compare.jpg` |
| 做事中 | 小家伙眼睛往下看，副标题是活动行正在说的那一步（紫色）「正在识别语音…」 | `screenshots/02a-running-compare.jpg` |
| 隔天回来，对话在屏上 | 副标题是 APEX 最新一句的第一行 | `screenshots/04a-nextday-compare.jpg` |
| 隔天回来，人在别的页面 | 来了新回复，右边紫色未读点；回到对话就消失 | `screenshots/04a-unread-compare.jpg` |
| 通话中 | 副标题「通话中」 | `screenshots/03a-voice-compare.jpg` |
| 账户菜单 | 和 AccountPanel 一样的各项，设置后面多一项「沉浸式分析」 | `screenshots/06-account-menu.jpg` |
| 深色（APEX 深蓝） | 紫色副标题换浅紫，仍看得清 | `screenshots/07-running-dark.jpg` |

## 做法

- **搜索**：圆按钮调用 `openCommandPalette()`，CommandPalette 本身没改；它本来就能搜会话，更早的对话也在里面。
- **副标题的状态来源**：新的小 store `src/store/single-thread-presence.ts`。读主线自己的 session 状态（`$sessionStates` 里 storedSessionId 在主线 lineage 上的那个），所以人在设置页时也知道 APEX 在忙；活动行和语音面板通过叶子模块 `src/store/thread-signals.ts` 报「正在做哪一步」和「通话中」。优先级：通话中 > 等你决定 > 在做事（有步骤说步骤，没有说「在做事…」）> 最新一句。
- **未读点**：这次启动后，用户打开过对话、之后又来了新回复，且现在不在对话页，才出现。没有持久化「上次看到哪」（那是 G9a 的「新消息」分隔）。
- **在微信里找 APEX**：打开现有的 IM 入口页（hc-417 / hc-538），本机助手绑了微信就写「已绑定」。
- **账户行**：新写的 `sidebar-account.tsx`，不改 AccountPanel。名字下面一行来自 hc-1062，主进程用登录 JWT 读（`electron/apex-plan-usage.ts`，注册在 `apex-account-reads.ts`，main.ts 没变）。额度不限时只写套餐名；取不到、installer-only、旧服务端、旧主进程：写邮箱。用量按账号存，换账号不会串。一轮做完会重读一次。登录失效时直接用 AccountPanel 的「登录已失效」卡片。
- **「沉浸式分析」（N4）**：按差距清单的建议，侧栏只留一行 APEX，「沉浸式分析」挪进账户菜单，放在「设置」后面。

## 守卫和测试

- `src/app/single-thread/sidebar.test.tsx`：自上而下的顺序；搜索打开命令面板；各状态的副标题和小家伙的样子；未读点出现和消失；微信绑定三种情况和跳转；账户行五种用量显示、开局正在做事也会读、做完重读、不串账号、登录失效；**账户菜单和 AccountPanel 逐项对比**（同样的项、同样的顺序，只多「沉浸式分析」）；语音面板挂上就是通话中。
- `src/store/single-thread-presence.test.ts`：哪个 session 是主线、最新一句怎么取（「1.2 万…」开头的数字不当列表符号）、优先级、未读、百分比格式（0.29 → 29%，不到 1%）。
- `electron/apex-plan-usage.test.ts`：URL、只用 JWT、各种返回和 401/403/404/500。
- `src/single-thread-shell-identity.test.tsx`：开关开时侧栏只剩一行 `thread`，没有「沉浸式分析」行；开关关和开发者模式的 golden 不变。
- `src/apex-avatar-identity.test.tsx`：侧栏加入允许引用形象的文件；开关开时侧栏只有助手行一个形象。

## 和原型仍有出入

- **侧栏宽度**：原型 232px，Desktop 默认 190px（壳统一设的，和其他模式共用，可拖宽到 280px）。为了在 190px 下放得下，行的左右内边距少 2px，账户行头像 28px（和 AccountPanel 一样），用量那行 11px（和 AccountPanel 的邮箱一样）；「125%」「不到 1%」这种更长的会截断，鼠标停上去有全文。
- **配色**：侧栏底色、选中行用 Desktop 主题色（浅色下比原型的 #F1F1F4 更白，选中行是浅灰不是白卡），为了深色和深蓝主题。账户头像用 AccountPanel 的按邮箱取色，不是原型的淡紫。
- **用量文案**：服务端只有月额度，所以是「本月用了」不是「本周用了」（见 apex-nodes hc-1062）；套餐名用服务端给的「快速」，原型写的是「快速版」。
- **第一次打开**：原型副标题「先问 3 个小问题」；这里还没有回复时不写副标题（首启流程是 G12）。
- **做事中的副标题**：用活动行的步骤说法（「正在识别语音…」），原型示例是「在看这条视频…」。
- **「在微信里找 APEX」指向本机 IM 入口**：决定 8（IM 统一走云端）还没定，定了再改去处。原型的 ④ ⑤ 画板没画这一行，① ② 有，这里一直显示。
- **更新药丸**留在微信行上面（原型没有）。
