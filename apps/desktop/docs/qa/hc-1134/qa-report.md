# hc-1134 — Desktop 的套餐名写 FREE、PRO、MAX

## 范围

`free` 写 FREE，`fast` 写 PRO，`advanced` 写 MAX。简体、繁体、英文一样，日文和阿拉伯文跟英文。模型档位 Flash、Pro、Max 是另一回事，不改。内部代码不改。

## 环境

全新沙箱里的 dev Electron：跑这个 PR 构建出来的 `dist` 和这个 checkout 的真引擎。账号服务、relay、LLM 都是本地假的，没有真实账号，没有付费请求。没有碰 `/Applications/APEX.app`，真实 `~/.apexnodes/logs/desktop.log` 走查前后没变。

为了让档位选择器出现，走查打开了 `APEXNODES_MODEL_TIERS=1`，点 Max 那几步再打开 `APEXNODES_MODEL_TIER_MAX=1`。假 relay 的 `/v1/models` 只列 `apex-flash`，相当于一个 FREE 账号。

引擎按地址给自定义端点命名：真实账号的 relay 是 apex-nodes.com，得到 `custom:apex-nodes.com`；假 relay 在 127.0.0.1 上，得到 `Local (...)`，选择器不把它当托管 relay，只会说「查不到能用哪几档」。所以进开发者模式之前，走查把沙箱 `config.yaml` 里的名字改成了 `Apex-nodes.com` 再重启。只改了沙箱，没有改产品代码。

## 产品模式

| 步骤 | 结果 |
|---|---|
| 菜单卡片（FREE） | 卡片和账户行都写 FREE（`60-menu-free.jpg`） |
| 升级页 | 三列 FREE、PRO、MAX，写「每周额度是 FREE 的 5 倍 / 15 倍」，按钮「升级到 PRO」「升级到 MAX」（`62-plans-testing-notice.jpg`） |
| 点付费 | 提示正在测试，假服务收到 0 个请求 |
| 设置 › 账号、设置 › 用量 | 都写 FREE（`63-settings-account.jpg`、`64-settings-usage.jpg`） |
| 个人资料 | 徽标和方案一行：FREE、PRO、MAX（`65-profile-free.jpg`、`68-profile-pro.jpg`） |
| 账户行和菜单，`fast`、`advanced` | PRO；MAX，按钮是「查看套餐」（`66-menu-pro.jpg`、`67-menu-max.jpg`） |
| 认不出的代码，云端叫它「团队」 | 账户行和个人资料都写「团队」 |
| 繁体 | FREE、升級、每週額度是 FREE 的 5 倍（`70-hant-plans.jpg`） |
| 英文 | FREE、Upgrade、5× the FREE weekly allowance（`71-en-menu-free.jpg`、`72-en-plans.jpg`） |
| 档位选择器 | **产品模式点不到。** 左栏没有「档位」，`?tab=config:model` 落到个性化，页面上没有档位卡片（`69-product-no-tier-page.jpg`） |

## 模型档位的锁定徽标

| 步骤 | 结果 |
|---|---|
| 开发者模式，FREE 账号，Max 没开放 | Pro 写「PRO 起可用」，Max 写「即将开放」（`73-developer-tier-page.jpg`） |
| 点 Pro | 「Pro 档需要 PRO 或以上的套餐。」（`74-developer-locked-pro.jpg`） |
| 点 Max | 「Max 档还没开放。」 |
| 开发者模式，FREE 账号，Max 开放 | Pro「PRO 起可用」，Max「MAX 起可用」；点 Max：「Max 档需要 MAX 或以上的套餐。」（`76-developer-locked-max.jpg`） |
| 繁体 | 「PRO 起可用」；「Pro 檔需要 PRO 或以上的方案。」（`78-hant-locked-pro.jpg`） |
| 英文 | 「PRO plan and up」；「Max needs the MAX plan or higher.」（`79-en-locked-max.jpg`） |
| 开关关闭 | 同一个选择器，同样的徽标和提示（`80-switch-off-locked-pro.jpg`） |

卡片标题一直是 Flash、Pro、Max。

锁定的卡片是 `aria-disabled`，不是 `disabled`，人可以点。Playwright 看到 `aria-disabled` 就不肯点，所以这几步用了 `force: true`，那还是一次真实的鼠标点击。

## 开发者模式和开关关闭

个人资料的方案还是原始代码 `free`（`75-developer-profile-raw.jpg`、`81-switch-off-profile-raw.jpg`）。开发者模式的账号菜单还是原来的 个人资料、设置、项目、定时运行、连接助手、历史会话、交付物、重新登录、退出登录。

## 证据边界

**证明了**：dev Electron 真窗口里的这些名字；徽标真的画出来、真的点过；产品模式点不到选择器；开发者模式的个人资料没变。

**没有证明**：

- 打包产物和 Windows。
- 真实云端回包。字段按 apex-nodes 现行代码写，没有连生产。
- **PRO 账号看到 Pro 已解锁、只有 Max 锁定的画面。** 走查把假 relay 改成也列 `apex-pro` 再重启，引擎读到的还是旧列表，卡片没变（`walk-results.txt` 里 `a PRO account` 那一段，是这个没走通的结果，不是 PRO 账号的画面）。这个状态只有 `tier-availability.test.ts` 的单元测试覆盖。
- Bot Mode 的新建和编辑助手对话框（`plugins/hermes-bots`）用的是同一个选择器，这轮没有点。
- 平台的 `desktop_features.model_tiers` 现在是开是关。这轮没有读生产。

截图在 `screenshots/`，是窗口内容（CDP 截图），不含窗口外框。走查的完整输出在 `walk-results.txt`。
