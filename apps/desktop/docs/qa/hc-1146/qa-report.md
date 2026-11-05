# hc-1146 侧栏右键菜单改成 Grok Bot 那种

Kael 11-05 发了 Grok Bot 的右键菜单截图（Pin / Move to new section / Mark as Unread / Rename Bot / Copy conversation ID / Hide from sidebar / Delete），要求会话列表的右键改成这种菜单，并选了除「移到新分组」外的全部几项。

## 截图

截图来自开发用的临时页面（Vite 渲染真实的 `SidebarSurface` 和 `AppContextMenu`，桥接口打桩，无头 Chrome 2x），不是打包产物。临时页面没有提交。

| 文件 | 内容 |
|---|---|
| `screenshots/menu-assistant-light.jpg` | 右键「带货脚本」：置顶 · 标为未读 / 改名或换样子 / 复制对话 ID / 从侧栏隐藏 · 删除这个助手（红） |
| `screenshots/menu-apex-light.jpg` | 右键 APEX（当前这行，带「···」）：标为未读 / 改名 / 复制对话 ID |
| `screenshots/menu-assistant-dark.jpg` | 同上，深色 |
| `screenshots/after-light.jpg` | 「剪辑助手」置顶（APEX 后第一个，名字后小图钉）；「带货脚本」标为未读（行尾紫点）；「小红书文案」隐藏，下面一行「已隐藏 1 个助手」带它的小头像 |
| `screenshots/after-hidden-menu-light.jpg` | 点「已隐藏」：点一下放回侧栏 |
| `screenshots/menu-pinned-unread-light.jpg` | 已置顶的那行右键：第一项变成「取消置顶」 |

## 各项落在哪里

| 菜单项 | 存哪 | 说明 |
|---|---|---|
| 置顶 / 取消置顶 | `profile.yaml` 的 `ui_meta.apex.pinned` | APEX 之后、其他助手之前；组内按创建顺序 |
| 标为未读 / 标为已读 | 本机 localStorage `apex.single-thread.bots.unread-marks.v1` | 下次这个助手的对话出现在屏幕上时自动变已读；在当前对话上标为未读，离开后才亮 |
| 改名 / 改名或换样子 | 不变（hc-1078 的表单） | APEX 只能改名（K6） |
| 复制对话 ID | 读 | 该助手「APEX 主线」当前的会话 id（tip）；还没对话时置灰 |
| 从侧栏隐藏 | `ui_meta.apex.hidden` | 只影响侧栏；接力、通知、搜索、「+」的上限照常算它；当前显示的就是它时先切回 APEX |
| 删除这个助手 | 不变（hc-1078 的确认框） | |

没做：Grok 的「移到新分组」（侧栏没有分组）。

为什么不用上游 Bot 模式的 `ui_meta['hermes-bots'].pinned/hidden`：profile 一旦带上 `hermes-bots` 键，引擎就把它当 Bot 模式助手（换提示词、加 `message_agent`），hc-1078 起就规定产品模式绝不写这个键（`single-thread-bot-ops.ts` 头注释，测试钉着）。开发者模式 Bot 面板里的「隐藏」仍按原样把助手整个排除在产品名单外，两者含义不同，这次没动它。

## 检查

- `npm run check:lint`：0 error。
- `vitest run --project ui`：12,544 个全过。
- `python scripts/check --only health`：0 blocking。
- 反向验证（逐个注入，跑对应测试，全部变红后还原）：去掉右键包装、当前行框不转发 trigger 属性、点不读标记、上屏不清标记、隐藏不过滤、置顶不排序、缓存丢标记、冲突不重试、写入覆盖已存字段、不拒 APEX、失败不回滚、隐藏当前不切回 APEX、APEX 也给置顶/隐藏/删除，共 13 项。
- 身份层 golden：只有多助手开着的 12 个 golden 变了，差别只是行和当前行框上多了 `data-slot="context-menu-trigger" data-hermes-context-menu-trigger=""`（框上还有 Radix 的 `data-state="closed"`）。开关关着的 golden 一个没变。
