# hc-1063 原型 v2「第一次打开」：QA 记录

只在单线程产品模式下生效，也就是 `desktop_features.single_thread` 打开，而且不在开发者模式。今日点子另外由 `desktop_features.daily_ideas` 控制，默认关。

## 截图

每张图左边是原型 v2（https://claude.ai/artifact/4tp3RzGAaBcEnbABWXtdMH ，「第一次打开」画板），右边是本分支。

截图来自 renderer 预览页，不是打包产物：一张临时 Vite 页，加一个 `hermesDesktop` 桥接桩，渲染真实组件，不经过 Electron，也不登录。档案和今日点子的回答是假数据；档案的完成规则和云端一致，`completed_at` 设上以后不会清掉。原型那边裁掉了顶部的演示黄条。

| 状态 | 文件 |
|---|---|
| 第 1 张卡：问候里有「名字能改」，标题旁写「1 / 3」，点一下就答，没有「继续」「先跳过」 | `screenshots/01-card1.jpg` |
| 答完第 1 张：卡片收起成问题加选中项，APEX 说「好物测评，懂了。」，接着出第 2 张 | `screenshots/02-card2.jpg` |
| 第 3 张卡前面 APEX 说「好，最后一个。」 | `screenshots/03-card3.jpg` |
| 答完：「✓ APEX 记下了：… · 撤销」，今日点子（开关开），再一句贴士 | `screenshots/04-done-ideas.jpg` |
| 撤销以后：「已撤销，这三条不记」，收起的卡还在，不再出新卡 | `screenshots/05-undone.jpg` |
| 答完，今日点子开关关着（默认）：只有记下了这一行和贴士 | `screenshots/06-done-ideas-off.jpg` |
| 记忆底账：「✓ APEX 记下了」；看过程里这一步叫「记住一条」，没有「用到的方法」 | `screenshots/07-memory-step.jpg` |

截图里还不一样的地方：侧栏、头部胶囊、形象、输入框和气泡分别归 G3、G2、G4、G1 处理，这几处在截图里还是现在的样子。其余有意保留的不同和原因，写在 PR 说明里。

## 开关关时不变（硬规则 11）

- `src/__identity__/single-thread/*` 和 `src/__identity__/single-thread-shell/*` 的 golden 都没改，原样通过。
- 除了下一节的「最头疼」说法，其余改动只在三个地方出现：单线空对话、单线 footer、底账那一行。这三处在开关关的时候都不渲染。「最头疼」的新说法是按决定对所有人生效的。
- 新的步骤名只有 `apex_memory` 一个工具用得到，而这个工具只在开关打开时注册。

## 「最头疼」选项统一成原型说法

设置 › 个性化、开始页三张卡（开关关时显示的那一组）和对话里第一次打开的卡片，读的是同一张表 `creator-intake-copy.ts` 的 `painPoints`。现在这张表里的说法是：不知道拍什么、拍了没人看、剪辑太费时间、不会写文案、不会拍。

- 选项的 id 和各处原来的顺序都不变，所以云端存的档案不受影响。
- 设置页没有 golden，由 `creator-profile-settings.test.tsx` 逐项钉住这五个说法；开始页卡片由 `creator-intake-cards.test.tsx` 钉住。
- 其他 identity golden 都没变：5 个文件、103 条测试，在 `CI=true` 下跑，本地时区和 UTC 各跑一遍。
- 上面那组截图是合入 G4 之前拍的，所以里面的输入框还是旧样子。
