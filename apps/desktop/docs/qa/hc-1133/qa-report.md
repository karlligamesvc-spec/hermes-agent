# hc-1133 — 产品模式的头像菜单、设置里的入口和升级页

## 范围

只在 `desktop_features.single_thread` 开、且不是开发者模式时生效。开关关闭和开发者模式的界面由 golden 钉住，逐字节不变。不改计费，不接支付，不发购买请求。

## 环境

全新沙箱里的 dev Electron：跑这个 PR 构建出来的 `dist` 和这个 checkout 的真引擎。账号服务、relay、LLM 都是本地假的，没有真实账号，没有付费请求。

- 假账号服务按 apex-nodes `week_summary` 的真实字段回 `plan-usage`。服务端现在没有 `enforced` 字段，走查里「真的在限额」的几步是假服务多回了 `enforced: true`。
- 主进程的 `shell.openExternal` 被换成记录 URL，所以「联系我们」验证到交给系统的地址，没有真的弹邮件窗口。
- 用了 `--use-mock-keychain`、本地关掉 `apexnodes://` 协议注册（只在验收用的副本里，没进提交），窗口设成不抢焦点。没有碰 `/Applications/APEX.app`，真实 `~/.apexnodes/logs/desktop.log` 走查前后没变。

## 产品模式的结果

| 步骤 | 做法 | 结果 |
|---|---|---|
| 菜单 | 点账户行 | 从上到下：头像、昵称、邮箱；卡片（套餐、升级、本周额度）；设置；联系我们；退出登录 |
| 额度：现在的生产回包 | `weekly` 有数字，没有 `enforced` | 「不限量」。没有百分比、进度条和重置时间 |
| 额度：周账本关着 | `weekly: null` | 「不限量」 |
| 额度：真的在限额 | `enforced: true`，用了 5% | 「还剩 95%」、进度条 95、「11月8日 8:00 重置」（本机时区） |
| 额度：用完 | `enforced: true`，用了 125% | 「已用完」（红字）、进度条 0、重置时间 |
| 套餐名 | `fast` / `advanced` | 卡片和账户行都叫 Pro / Max；Max 的按钮是「查看套餐」。账户行只有套餐名，没有百分比（见「第二轮」） |
| 联系我们 | 点 | 交给系统 `mailto:support@apex-nodes.com`，顶部提示写出地址，可复制 |
| 设置 | 点 | `/settings`，左栏 10 项：个性化、记忆、语音、通知、外观、连接微信和飞书、助手与记录、用量、账号、关于 |
| 个人资料 | 设置 › 账号 › 打开 | `/profile`，关掉回到打开设置之前的页面 |
| 定时运行 | 设置 › 助手与记录 › 打开 | `/cron` |
| 连接助手 | 设置 › 助手与记录 › 打开 | `/assistant` |
| 更早的对话 | 设置 › 助手与记录 › 打开 | `/history` |
| 重新登录，点返回 | 设置 › 账号 › 重新登录 | 登录页盖上来，能点。返回后还在 `?tab=account` |
| 重新登录，真的登录 | 同上 | 登录后回到 `?tab=account`，登录页关掉 |
| 本周额度 | 菜单点这一行 | `?tab=usage`，页面上有本周额度，状态和菜单一样 |
| 升级页 | 菜单点升级 | `?tab=plans`，列免费、Pro、Max，写「每周额度是免费的 5 倍 / 15 倍」「价格待公布」。当前套餐有标记，更低的套餐没有按钮 |
| 点付费 | 点「升级到 Pro」「升级到 Max」 | 提示「付费功能正在测试中，后续推出，现在不会扣费。」。页面不跳，假服务收到 0 个请求，没有 URL 交给系统 |
| 退出登录失败 | 假服务的吊销回 500 | 菜单关上，账号还在，提示带「重新登录」，点了能进登录页；日志写「sign-out failed (HTTP 500)」 |
| 退出登录 | 正常 | 引擎先重启（「正在重新连接 APEX…」），再出登录页；日志写吊销和从 4 个文件删掉 key；沙箱里搜不到 key |
| 再登录 | 同一账号 | 菜单没有自己弹出来，内容是新读的 |
| 登录后发一条 | 对话框发送 | 请求到了假 relay，回复正常 |
| 登录中途收到 401 | 主进程发 `hermes:auth-gate`，设置开着 | 登录页能点。登录后设置回到原来那页 |

### 英文（产品模式）

菜单是 Free、Upgrade、Weekly usage、Unlimited（真的在限额时是 95% left、Resets Nov 8, 8:00 AM）、Settings、Contact us、Sign out。左栏多 Assistants & history 和 Account。升级页是 Plans，付费按钮的提示是 Paid plans are still being tested and will launch later. You have not been charged.

### 多助手（`APEXNODES_MULTI_BOT=1`）

建了「剪辑助手」并停在它的对话上：

- 菜单和账户行是账号的昵称、邮箱和套餐，没有助手的名字。切助手不会重新读额度，也不会变。
- 设置的标题：账号、套餐、用量写「设置」；助手与记录、语音写「剪辑助手 的设置」。

### 深色和窄窗口

深色下菜单和升级页都走主题 token，文字可读，当前套餐有边框。窗口缩到 760×640 时升级页三列放得下，设置变成上方的下拉。窄窗口下侧边栏默认收起，要先打开侧边栏才有账户行，这一步没有走，菜单在窄窗口没有截图。

## 开发者模式

切到开发者模式：菜单还是原来的 个人资料、设置、项目、定时运行、连接助手、历史会话、交付物、重新登录、退出登录。`/settings?tab=plans` 落到个性化，左栏 18 项，没有账号、助手与记录。

## e2e（本地）

都在隔离的 worktree 上、这个 PR 构建的 dist 上跑。fork CI 只在发版时跑这些 e2e，所以这是本地证据。

- `e2e/sign-in-after-sign-out.spec.ts`：10 条全过。其中「signing in again」这条改成从设置 › 账号走，真的在设置开着时点重新登录、登录、关设置，再发一条，key 轮换正确。
- `e2e/sign-out-relay-key.spec.ts`：2 条全过。

走查的完整输出在 `walk-results.txt`，脚本和假服务在协调会话的共享笔记 `hc-1133-accept/`。

## 第二轮：账户行、个人资料、登录提示

同样的环境，又一个全新沙箱。这一轮多录了窗口画出来的每一条提示，不管是谁弹的。输出在 `walk-results-round3.txt`。

| 步骤 | 做法 | 结果 |
|---|---|---|
| 账户行：现在的回包 | 免费，周额度只记不拦 | 「免费」 |
| 账户行：付费 | `fast`，本月用了 18% | 「Pro」，没有百分比（`46-row-pro.jpg`） |
| 账户行：真的在限额 | `fast`，`enforced: true`，用了 5% | 账户行还是「Pro」；数字在卡片里，「还剩 95%」（`47-row-pro-enforced-menu.jpg`） |
| 账户行：其他 | `advanced`；认不出的 `team_internal`，云端叫它「团队」 | 「Max」；「团队」 |
| 个人资料 | 同上 5 种回包 | 头部徽标和方案一行一致：免费、Pro、Pro、Max、团队（`49-profile-free.jpg`、`48-profile-pro.jpg`、`51-profile-unknown-cloud-name.jpg`） |
| 登录提示：第一次登录 | 全新环境登录 | 「登录成功 / APEX 准备好了。」（`45-signin-toast-zh.jpg`） |
| 登录提示：重新登录 | 设置 › 账号 › 重新登录 | 同一句，登录后回到 `?tab=account`（`52-resignin-toast-zh.jpg`） |
| 登录提示：401 后再登录 | 主进程发 `hermes:auth-gate` | 同一句 |
| 退出失败 | 假服务的吊销回 500 | 「退出登录未完成。请重试；如果登录已过期，可重新登录。」带「重新登录」（`53-signout-failed-toast-zh.jpg`）。点了登录，还是同一句登录提示 |
| 退出，再登录 | 正常 | 退出这一路没有弹提示；再登录是同一句 |
| 英文（产品模式） | 语言切到英文，退出再登录 | 账户行和个人资料是 Pro / Plan: Pro；提示还是「APEX is ready / APEX connected.」（`55-signin-toast-en.jpg`） |
| 开发者模式 | 切过去，看个人资料，退出再登录 | 个人资料仍是 `free`（`56-developer-profile-raw-code.jpg`）；提示还是英文（`57-developer-signin-toast-en.jpg`） |

走查里三条路径上弹过的提示只有这些：

```text
[first sign-in] status: 登录成功 APEX 准备好了。
[re-sign-in from Settings] status: 登录成功 APEX 准备好了。
[a 401 from main] status: 登录成功 APEX 准备好了。
[sign-out fails] alert: 退出登录未完成。请重试；如果登录已过期，可重新登录。 重新登录
[sign-out fails] status: 登录成功 APEX 准备好了。
[sign in after sign-out] status: 登录成功 APEX 准备好了。
[English, product mode] status: APEX is ready APEX connected.
[developer mode] status: APEX is ready APEX connected.
```

**这一轮没在真窗口里触发的**：引擎不应答时的「APEX 还没准备好」（测试里让探测超时触发）、`managed-recovery` 的几条提示和 `use-gateway-boot` 的几条错误提示（读过代码，都有中文，走查里没出现）。繁体的两条提示只有测试覆盖。

## 证据边界

**证明了**：dev Electron 真窗口里的这些界面和跳转；主进程解析真实字段；点付费不发请求；登录页盖在设置上时能点。

**没有证明**：

- 打包产物和 Windows。这张票不发版。
- 真实云端回包。字段按 apex-nodes 现行代码写，没有连生产。
- 真的弹邮件窗口。`mailto:` 只验证到交给系统这一步。
- `support@apex-nodes.com` 有没有人看。官网页脚和条款写的是它，域名有 MX 记录，这张票没法证明收件后有人处理。
- `enforced` 这个字段。服务端还没有，将来真的拦人的票要加上它，Desktop 才会显示数字。

截图在 `screenshots/`，是窗口内容（CDP 截图），不含窗口外框。
