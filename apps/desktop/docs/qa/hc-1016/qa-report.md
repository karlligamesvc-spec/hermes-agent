# hc-1016 — 记得你 v1(Desktop 一半)

## 范围

- 极简个人助手一期第 3 件「记得你 v1」。方案:https://claude.ai/artifact/8y9GcFPmPqQd29nRHwdp23 ,原型 v2:https://claude.ai/artifact/4tp3RzGAaBcEnbABWXtdMH 。Kael 2026-10-21 批准一期三张票(hc-1014 / hc-1015 / hc-1016),都放在 `desktop_features.single_thread` 后面，先内部灰度。
- 服务端记忆底账在 apex-nodes 配对 PR(hc-1016):`/api/v1/account/memory-ledger`(登录凭证)和 `/api/v1/media/memory-ledger`(agent key)。
- 本 PR:主进程读写底账并镜像提示段、apex-overlay 的提示段和 `apex_memory` 工具、「它记得什么」设置段、回复下面一行「记下了 · 撤销」。

## 改后的样子

截图来自开发页面：临时 Vite 页渲染真实的 `MemoryLedgerSettings` 和 `Thread`,底账数据在页面里直接给，界面语言 zh,Electron 桥用替身。**不是打包产物。**

| 状态 | 样子 | 截图 |
|---|---|---|
| 设置 › 个性化 › 它记得什么 | 一句说明(电脑和 IM 共用一份)、一句删除说明(真删，正在聊的这一段可能还记得);「关于你」「最近发生的(保留 30 天)」两组，每条有「改」「删」,每组底下一行输入框加「加上」 | `screenshots/memory-ledger-settings-zh.jpg` |
| 对话里记下一条 | 回复下面居中一行灰字「记下了：不露脸，女声配音 · 撤销」;点撤销后变成「已撤销：…」,撤销失败时说去「它记得什么」里删 | `screenshots/memory-noted-line-zh.jpg` |

截图里过程区那一行写的是通用的「处理」:`apex_memory` 还没有人话标题。过程区归 hc-1015,标题或收起留给它定。

## 开关关着时

- 设置页不渲染这一段(组件返回 null),对话里没有这一行;测试把「开」时去掉这一行后的整页 HTML 和「关 / 空闲 / 不可用」三种状态逐字比较，相同。
- 主进程只收到 `{ action: 'off' }`:删掉本机镜像，不发网络请求。没有镜像文件，引擎就没有提示段，也不提供 `apex_memory` 工具。
