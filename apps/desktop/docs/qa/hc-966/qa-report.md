# hc-966 — 登录时说清楚 Desktop 设备数已到上限

## 范围

- 服务端在「账户已有 8 个有效 Desktop 设备 key,且这次是新安装」时,provision-key 回 409 `desktop_device_key_limit_reached`。Desktop 原来把这个 code 丢了,登录页只说「账户连接暂时无法确认,请重新登录重试」,重试永远不会成功。
- 这次只改 Desktop:带上服务端的 code,登录页换成专门的一句提示。服务端不变。
- 文案经 Kael 确认。

## 改后的样子

截图来自开发页面:临时 Vite 页渲染真实的 `DesktopLoginScreen`,Electron 桥用替身,提示由 store 直接给。**不是打包产物。**

| 状态 | 提示框里的字 | 截图 |
|---|---|---|
| 改前(zh) | 账户连接暂时无法确认,请重新登录重试 | `screenshots/01-zh-before.jpg` |
| 改后(zh) | 这个账户登录的电脑数已达上限。请先在其中一台电脑的 APEX 里退出登录，再回到这里登录。 | `screenshots/02-zh-after.jpg` |
| 改后(zh-hant) | 這個帳戶登入的電腦數已達上限。請先在其中一台電腦的 APEX 裡登出，再回到這裡登入。 | `screenshots/03-zh-hant-after.jpg` |
| 改后(en) | This account is already signed in on the maximum number of computers. Sign out of APEX on one of them, then sign in here. | `screenshots/04-en-after.jpg` |
| 改后(ja) | このアカウントでログインしているパソコンが上限に達しています。いずれかのパソコンの APEX でログアウトしてから、ここでログインしてください。 | `screenshots/05-ja-after.jpg` |

中文在 22rem 宽的提示框里占两行。两个登录按钮和「使用自己的密钥」都还在、都能点:在别的电脑上退出后,回来直接再点登录即可。

## 规则

- 只有服务端 `detail.code = desktop_device_key_limit_reached` 才出这句;同为 409 的 `desktop_provision_superseded`、没有 body、代理页面、超时等,仍是原来的「账户连接暂时无法确认」。
- 文案不写具体台数,服务端以后改上限也不会说错。
- 阿拉伯语回落英文。

## 没覆盖的

- 后台自愈撞上限时不出这句(聊天走通用错误),退出再登录时才会看到。
- 用户看不到、也退不掉别的 Desktop 安装(网页控制台没有设备列表)。
