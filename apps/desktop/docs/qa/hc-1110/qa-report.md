# hc-1110 — 重新登录和首次打开用同一个登录界面

## 范围

- PD Sheet1 第 1047 行。和 hc-1106(#527,换 key 后重启引擎)、hc-1111(apex-nodes #1128,登录上限，只改服务端)相邻。
- 首次打开的登录界面(`DesktopLoginScreen`,「开始使用」+「登录 APEX 账户」+「使用 Google 登录」+「使用自己的密钥」)是基准。所有「重新登录」都换成它，只多一个「返回」。
- 14 份 golden(`src/__identity__/re-sign-in/`)在 fork main e495735111 上先录，第一笔提交只有它们:首次打开在 gate 能给出的每个状态(中/英、登录已过期、账户异常、登录中、登录被拒、检查中)、「使用自己的密钥」通到的两个提供方页、两个账户菜单和「登录已失效」卡。后面每笔提交都逐字节不变。

## 改后的样子

截图来自开发页面：临时 Vite 页渲染真实的 `DesktopAuthGate` + 引导层 + 通知栏，Electron 桥用替身。**不是打包产物。**改前 = fork main e495735111,改后 = 本分支，同一个页面。

| 场景 | 改前 | 改后 | 截图 |
|---|---|---|---|
| 首次打开 | 「开始使用」登录页 | 不变 | `before-1-first-open.jpg` / `after-1-first-open.jpg` |
| 账户菜单「重新登录」 | 引导卡：邮箱 + 密码 +「登录并开始」+「或」+「用 Google 登录」「用 APEX 登录」+「使用我自己的提供方」「稍后再选择提供方」 | 首次打开那一页 + 「返回」 | `*-2-account-menu-relogin.jpg` |
| 「登录已失效」卡 | 引导卡，红字「登录已过期,请重新登录」 | 首次打开那一页，灰框写「登录已过期,请重新登录」+「返回」(和中途 401 的登录页同一个灰框) | `*-3-expired-card.jpg` |
| 云端登录失效卡(登录 JWT 过期，hc-1073) | 引导卡 + 红字原因 | 首次打开那一页 + 灰框原因 + 「返回」 | `*-4-cloud-login-jwt.jpg` |
| 发消息被中转拒(401 自愈不了) | 引导卡，红字 **`managedRecovery.signInRequired.reason`**(文案键从来不存在)，通知也是键名 | 首次打开那一页 + 灰框「登录已失效，刚才那条消息没有发出去。重新登录后再发一次。」 | `*-5-send-401.jpg` |
| 重新登录时名额已满 | 引导卡 + 红字上限文案 | 首次打开那一页 + 灰框上限文案(和首次打开同一处) | `*-6-device-limit.jpg` |
| 英文 | 引导卡英文版 | Get started 页 + Back | `*-7-account-menu-relogin-en.jpg` |

## 出口清单(硬规则 #12)

### A. 会出现 APEX 账户登录界面的入口(数过的全部)

| # | 入口 | 触发 | 改前 | 改后 |
|---|---|---|---|---|
| E1 | 首次打开 | `DesktopAuthGate`,`checking` → `signed-out` | 「开始使用」登录页 | **不改**(golden 钉住) |
| E2 | 退出登录后再登录 | `signOutAccount` → `signed-out` | 同 E1 | **不改**(同一个 gate 状态) |
| E3 | 中途 401 / 403 account_disabled(main 的 `broadcastAuthGate`) | `handleAuthGate` → `signed-out` / `disabled` | E1 那页 + 灰框「登录已过期」/「账户状态异常」 | 页面不改;**修**:之后登录被拒(如名额满)的报错以前被灰框盖住看不到，现在新报错优先 |
| E4 | 账户菜单「重新登录」(单线关 / 开发者模式:`AccountPanel`) | `requestManagedReSignIn('')` | 引导卡(邮箱密码) | E1 那页 + 「返回」 |
| E5 | 单线账户菜单「重新登录」(`SingleThreadAccountRow`) | 同上 | 同上 | 同上 |
| E6 | 「登录已失效」卡(hc-519,账户 `expired`) | `requestManagedReSignIn(登录已过期)` | 引导卡 + 红字 | E1 那页 + 灰框 + 「返回」 |
| E7 | 云端登录失效卡(hc-1073,登录 JWT 被云端拒;技能和插件停更) | `requestManagedReSignIn(云端原因)` | 同上 | 同上 |
| E8 | 发消息 401、自愈不了(hc-511 / hc-1106 那条链路) | `managed-recovery.ts` | 引导卡 + 文案键名;通知也是键名 | E1 那页 + 灰框原因;通知用新文案;登录成功后那条「需要重新登录」通知一起收掉 |
| E9 | 启动 / 模型目录 401 的后台对账 | `reconcileRelayAuthState`(silentHeal) | 只把账户降成 `expired`,不弹页 | 不改(之后走 E6) |
| E10 | 退出登录失败通知上的「重新登录」 | `requestManagedReSignIn('')` | 引导卡 | E1 那页 + 「返回」 |
| E11 | 连接微信 / 飞书时登录过期，对话框里的「重新登录」 | `requestManagedReSignIn(登录已过期)` | 引导卡 | E1 那页 + 灰框 + 「返回」 |
| E12 | 网页一键登录(`apexnodes://login`,hc-530) | `$pendingDesktopLoginCode` | 只有 E1 那页会接；引导卡开着时这个码一直等着 | 重新登录页也接(同一个组件) |
| E13 | 设备名额已满(`MANAGED_DEVICE_LIMIT_REACHED`;hc-1111 改服务端上限) | 登录结果 | E1 在灰框里显示;引导卡红字;**E3/E6 打开时被开头的灰框盖住** | 两处都在同一个灰框，最新的报错优先 |
| E14 | 多助手开着 | 登录目标 = 当前助手的 profile(`getApiRequestProfile`) | 引导卡 | E1 那页;登完仍在原来的助手和页面;main 把新 key 写进每个家目录，hc-1106 等空闲重启拿旧 key 的引擎 |
| E15 | 重新登录页上「使用自己的密钥」 | — | 引导卡的「使用我自己的提供方」→ 提供方页(带「返回登录」,点了界面把账户当成已登出，盖上 E1 那页且没法回去) | 设置 › 提供方打开的同一个提供方页(右上角关闭回到原处)，账户保持登录 |
| E16 | 首次打开 / 硬 gate 上「使用自己的密钥」 | `skipManagedForByok` + `markManagedUnavailable` | 提供方页 +「返回登录」 | **不改**(golden `first-open-own-key.html`) |

### B. 检查过、不改

| 位置 | 为什么不改 |
|---|---|
| 引导层 `ManagedSignInPanel`(邮箱密码那张卡,`components/onboarding/index.tsx`) | 不再从重新登录进来;只剩「账户 gate 已放行但 status 说没登录」的瞬间(硬 gate z-1400 盖在它上面)。没删，免得动上游的引导壳 |
| 旧壳 `DesktopController` + `desktop-onboarding-overlay.tsx` | App 挂的是 `ContribController`;旧壳和新壳用同一个 `DesktopAuthGate` 和 store,自动一致 |
| 第二窗口(HUD、快速输入、弹出的浏览器) | 不挂登录 gate,也没有账户菜单 |
| 浏览器回环登录结果页(「登录已完成 / 未完成」,`apex-loopback.ts`) | 两条路共用，本来就一样 |
| 远程网关重新登录(`boot-failure-reauth.ts`「退出并重新登录」、`first-run-remote-form`) | 远程网关的会话，不是 APEX 账户 |
| Nous 免费层登录(`free-tier/sign-in-dialog.tsx`)、guided onboarding | 上游免费层;APEX 的 `HERMES_GUEST_ONBOARDING` 不开 |
| 提供方 / 连接器 OAuth 的「重新登录 {provider}」 | 第三方提供方，不是 APEX 账户 |
| 设置 › 密码与登录(vault) | 助手代你登网站的保险库，不是 APEX 账户 |
| 首次打开的「了解你」三张卡(hc-1063)、能力介绍(hc-1108) | 不在登录页上：它们在空对话里，按账户的云端 intake 决定;重新登录不碰对话也不碰 intake,换成同一个账户不会再出。登录完成后测试确认没有别的覆盖层(`[data-glass-opaque]` 为空) |

## 开发者模式、单线关

和首次打开一样：登录 gate 不分模式，一个组件。开发者模式和单线关(`AccountPanel`)、单线产品模式(`SingleThreadAccountRow`)的「重新登录」都打开同一页。理由：登录是身份层(硬规则 #11),首次打开那页是 APEX 自己的(logo、「开始使用」、APEX 主按钮);旧的引导卡是上游 BYOK 引导壳的一部分(「连接模型提供方」那一族)。开发者要的提供方页仍然从「使用自己的密钥」和设置 › 提供方进。

## 有意的差别(只有一处)

- 「返回」:账户还登录着(或只是 `expired`,本地照常能用),所以必须能回去;首次打开没有可回的地方。样式和「使用自己的密钥」一样(`variant=text`、`xs`、三级灰)，放在它下面;登录进行中和首次打开的按钮一样禁用(浏览器回环最多等 5 分钟)。
- 标题仍是「开始使用」,和中途 401 的登录页一致;原因写在灰框里。

## 测试

- `re-sign-in-identity.test.tsx`:14 份 golden;重新登录(菜单 / 过期卡 / IM / 云端 / 发消息被拒 / 登录中 / 登录被拒，中英)= 对应 golden 逐字节 + 正好一个「返回」;重新登录页「使用自己的密钥」= 设置 › 提供方那页的 golden 逐字节。
- `re-sign-in-exits.test.tsx`:谁能打开登录(调用点普查、`<DesktopLoginScreen` 只在 gate、gate 只在两个壳);每个入口点真实组件打开同一页;「返回」和登录完成都留在原页(`/chat-a`)、原状态;多助手时登录目标是当前助手;被拒报错优先;网页一键登录;硬 401 接管(没有「返回」);托管关时什么都不画;文案没有键名。
- 旧行为测试改成新契约:`identity-layer`(hc-511)、`account-panel`、`cloud-login-notice`、`binding-login-recovery`、`store/onboarding`。

## 反向验证

见 PR 描述里的表(21 处注入，每处断言锚点命中 1 次、注入后文件确实变了、跑完逐字节还原)。脚本和结果在协调会话共享笔记 `hc-1110-inject.py` / `hc-1110-inject-output.json`。
