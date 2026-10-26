# hc-1070 — 单线产品模式彻底去掉「沉浸式分析」

## 范围

- 只在 `desktop_features.single_thread` 开、且不是开发者模式时生效。开关关和开发者模式：侧栏「沉浸式分析」一行、`/analysis` 页面都和以前一样。
- 接在 hc-1061(G3,fork #490)后面。G3 把「沉浸式分析」从单线侧栏挪进了账户菜单(放在「设置」后面);这张票把它从账户菜单也拿掉，并且关上路由本身。

## 改了什么

| 出口 | 文件 | 改法 |
|---|---|---|
| 单线账户菜单里的「沉浸式分析」 | `src/app/single-thread/sidebar-account.tsx` | 删掉这一项。菜单现在和 AccountPanel 逐项相同，只是「历史会话」叫「更早的对话」 |
| 单线侧栏把这一项接到导航 | `src/app/single-thread/sidebar.tsx` | 删掉 `ANALYSIS_ITEM` 和 `onAnalysis` |
| `/analysis` 路由 | `src/app/contrib/surfaces.tsx` + 新文件 `src/app/single-thread/analysis-route-gate.tsx` | 路由外面加一道门：产品模式到了 `/analysis` 就换成 `/`,单线外壳再把 `/` 打开成那一条对话。门在登录门(AccountWorkspace)外面，所以未登录时也不会停在空白页 |
| 不再用的文案 | `src/i18n/single-thread-sidebar.ts` | 删掉 `analysis` 键(en / zh / zh-hant) |

路由那道门一处拦住了下面这些走法，因为它们最后都是 `navigate('/analysis')`:

- 冷启动恢复上次的路由(`use-desktop-integrations.ts`,`getRememberedRoute`):开发者模式下停在分析页、下次以产品模式启动;
- 历史后退 / 前进;
- `hermes://open/analysis` 这类深链(`pathFromHermesDeepLink`);
- 插件系统通知点开时带的路径(`onNotificationActivate` → `resolveHermesOpenPath`);
- 插件的 `host.navigate`;
- 开发者模式下开着分析页，然后关掉开发者模式(路由元素跟着重新渲染)。

## 查过、不用改的

| 出口 | 为什么不用改 |
|---|---|
| 完整侧栏 ChatSidebar 的「沉浸式分析」一行(`src/app/chat/sidebar/index.tsx`) | 只在开关关或开发者模式下渲染(SidebarSurface 二选一),要保持原样，golden 钉着 |
| AccountPanel(单线模式未登录 / 登录失效时账户行用它) | 本来就没有分析这一项 |
| 命令面板(单线侧栏的搜索按钮打开它) | 没有分析这一项 |
| 快捷键(`lib/keybinds/actions.ts`、`hooks/use-keybinds.ts`) | 没有去分析页的动作;导航契约里 analysis 也没有 keybindActionId |
| Electron 应用菜单、托盘(`electron/main.ts`) | 没有分析相关的菜单项 |
| 深链的 login / blueprint 两种(`app/desktop-deep-link.ts`) | 不跳路由;通用的 `open/…` 由路由门拦 |
| 会话通知、HUD 的 goto | 只打开会话 |
| 贴士、首启(`lib/tips/*`、G12 的 `single-thread-first-open.ts`、开场动画、引导) | 没有提到或链接到分析 |
| Start 页接分析页交接过来的草稿(`start-page.tsx`) | 方向是从分析页出来;单线模式下 Start 页本身就换成了对话 |
| 工作流 starter 里的 `analysis`(`workflow-starters.ts`) | 是视频分镜分析这一步工作流，不是沉浸式分析页 |
| 粘贴动作(`composer/paste-actions.ts`)、斜杠命令 | 只拼文字，不跳页 |
| DesktopController 里的 ChatSidebar | 这个组件现在没有地方挂载(贡献式外壳取代了它) |
| 主进程 `hermes:analysis:*` IPC | 是分析页的数据通道，不是入口 |
| 弹出窗口 | 路由门看的是产品模式，不分窗口，弹出窗口一样回去 |
| 云端文案和技能(apex-nodes)、fork 的插件和技能 | 两个仓都 grep 过，没有「沉浸式分析」或 `/analysis` 链接 |
| e2e 里点「沉浸式分析」的用例 | 跑的是开关关的完整侧栏，不受影响 |

## 守卫和测试

- `src/app/contrib/surfaces.test.tsx`(真实的 ChatRoutesSurface):产品模式冷启动在 `/analysis` → `/`;之后再导航过去 → `/`;未登录时也回到 `/`;开发者模式开着分析页、关掉开发者模式 → `/`;开关关、开发者模式 → 分析页照常打开。
- `src/app/single-thread/sidebar.test.tsx`:单线账户菜单和 AccountPanel 逐项相同;再按字面钉一遍整张菜单(个人资料、设置、项目、定时运行、连接助手、更早的对话、交付物、重新登录、退出登录);项目和定时运行仍走外壳的导航。
- `src/single-thread-shell-identity.test.tsx`:开关关和开发者模式的侧栏、账户菜单、记录、历史页 golden 一字未动(`__identity__/` 下没有改动)。

## golden

- `__identity__/single-thread-shell/` 下的 golden 都没动。
- 单线侧栏和单线账户菜单没有单独的 golden 文件，靠上面的测试钉着。为了证明只少了这一项：在 fork main `79afcf475b`(含 #490)和本分支上，用同一个渲染(单线侧栏 + 账户菜单打开，zh 和 en 各一份)各录两次。两边各自稳定；两边相比，zh 和 en 都只少了一个菜单项(书本图标 +「沉浸式分析」/「Deep analysis」),别的一个字节不差。

## 反向验证

9 个注入，每个先断言锚点只命中一次，跑完按 sha256 还原:

| 注入 | 变红的测试 |
|---|---|
| R1 路由门永远不拦 | surfaces 的 4 条(冷启动、之后导航、未登录、关掉开发者模式) |
| R2 路由不包门 | 同上 4 条 |
| R3 门放进登录门里面 | 未登录那 1 条 |
| R4 开关关也拦 | 开关关 / 开发者模式照常打开 2 条、关掉开发者模式 1 条，外加原有的 3 条分析页交接测试 |
| R5 门只看开关、不看开发者模式 | 开发者模式那 2 条 |
| R6 账户菜单「设置」后面加回「沉浸式分析」 | 菜单 2 条 |
| R7 账户菜单末尾加回「沉浸式分析」 | 菜单 2 条 |
| R8 单线侧栏加回一行「沉浸式分析」 | 侧栏顺序 1 条、单线身份测试 1 条 |
| R9 开关关时侧栏那一行的文案被改 | 开关关、开发者模式两份侧栏 golden |

9/9 变红，还原后 67/67 绿。

## 没做的

- 没有截图，也没在打包产物上走过：证据是真实组件在 vitest 里渲染出的 DOM。
- 沉浸式分析页本身、它的数据通道和服务端接口都没动，开发者模式里照常能用。
