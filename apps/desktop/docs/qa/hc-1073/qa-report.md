# hc-1073 QA:登录 JWT 被拒时的「登录已失效」卡片

截图来自开发用的渲染页(真实组件 + 假的 `window.hermesDesktop`,`managed.cloudLogin()` 按状态返回),不是打包产物，也没有真的登录。用 Playwright 驱动本机 Chrome 无头截图，2 倍像素，侧栏宽 260px。

| 截图 | 状态 | 看到的 |
|---|---|---|
| `screenshots/classic-rejected.jpg` | 经典模式，已登录，云端对登录 JWT 回过 401 | 账户行上方一张「登录已失效 / 技能和插件没更新，点此重新登录」,账户行照常 |
| `screenshots/single-rejected.jpg` | 单线产品模式，同上 | 卡片在「在微信里找 APEX」和账户行之间，账户行仍显示「快速 · 本月用了 18%」 |
| `screenshots/click-sign-in.jpg` | 点了卡片之后 | 托管登录面板打开，提示「登录已失效，技能和插件一直没有更新。重新登录后会马上更新。」 |
| `screenshots/classic-expired.jpg` | relay key 也失效(原有的 `expired` 状态) | 原来那一张卡，文案没变，没有第二张 |

JWT 正常时卡片不渲染，`AccountPanel` 的 HTML 与改动前逐字相同(`cloud-login-notice.test.tsx` 和身份层 golden 钉住),所以没有截「正常」那张。

已知小差异：单线模式的账户行左右内边距(px-2)比这张卡(沿用经典模式的 px-1.5)大一点，警告圆比头像靠左约 3px。单线模式在 `expired` 状态下本来就显示这张经典卡(#490),这里保持一致，没有另做一版。
