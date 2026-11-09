# hc-1207 — 工作目录外的文件夹交到助手手里

## 范围

- 输入框「+」的「添加文件夹」、从访达拖入文件夹、粘贴从访达复制的文件夹：文件夹在助手工作目录外时，之前引擎只回一句 `path is outside the allowed workspace`，助手拿不到文件夹。现在按会话授权，引擎展开成 📁 目录清单。
- 「添加文件或视频」选的文件在修复前就能用：`file.attach` 会把工作目录外的文件拷进 `attachments/`。这次没有改它，只补了验证。
- 设计、信任边界和入口清单写在 `docs/product/APEX-DESKTOP-FOLDER-DROP-CONTRACT.md` 的 hc-1207 一节。

## 修复前后（同一流程，fork main 9f44bfc65a 对照本分支）

下面三条都在真引擎上跑，模型用本地假模型。

| 流程 | 修复前 | 修复后 |
|---|---|---|
| 第二个助手 apex-bot-2，工作目录不包含 `~/Downloads`。从「下载」选真实的 `作品列表.xlsx`（7 KB）和一个真实文件夹，一起发送 | 表格拷进 `profiles/apex-bot-2/attachments/`，能用；文件夹报 `path is outside the allowed workspace` | 表格同前；文件夹展开为 `📁 @folder:/Users/…/Downloads/<文件夹>`，列出 `clip1.mp4`、`notes.txt` |
| hc-906 首页拖入文件夹 e2e（断言加强后） | 红：请求里带着拒绝行 | 绿：📁 清单里有 60 个片段和嵌套的「第二批/」 |
| `e2e/folder-grants.spec.ts`：菜单选文件夹、菜单选 xlsx、拖入文件夹、文件和文件夹一起拖入、粘贴文件夹、手打外部引用、第二个助手 | 红：第一步文件夹就被拒绝 | 绿：每一步都展开；手打的外部引用仍被拒绝 |

截图（开发版 Electron，不是打包产物）：

- `screenshots/01-real-files-picked.jpg`：第二个助手的输入框上方，有真实表格和文件夹两张附件卡片。
- `screenshots/02-real-files-answered.jpg`：发出后的气泡，表格指向 apex-bot-2 的 attachments，文件夹指向「下载」里的原位置。
- `screenshots/03-e2e-menu-folder.jpg`：菜单选的文件夹变成附件卡片。
- `screenshots/04-e2e-dropped-folder.jpg`：拖进输入框的文件夹也变成附件卡片。之前在输入框里是内联 `@folder:` 标签，发出去会被拒绝。

## 关于系统选文件窗口

开发版里点「+ → 添加文件或视频」，确实弹出了 macOS 原生选文件窗口，并且停在「下载」。但窗口里的选择没有做完：

- 后台控制下，这个窗口不接受回车和 ⇧⌘G，点击也只能移动焦点。
- 改用全屏控制时，屏幕锁了。

所以上面几次运行里，「选了哪个路径」由主进程替窗口给出，走的是同一个 `hermes:selectPaths` 处理函数，主进程照常把这个答案记为「用户交出的路径」。窗口里的点选本身没有覆盖到；需要的话，等解锁后可以补跑一次。

## 自动化检查（本机 macOS，Python 3.14，Node 来自 fork 锁文件）

- 引擎：`tests/apex_overlay/test_folder_grants_seam.py`，29 个全过。`tests/apex_overlay` 整个目录、`tests/tui_gateway/contracts`、`tests/agent/test_context_references.py` 和 5 个子进程环境变量测试文件：只有 `test_cron_desktop_delivery_seam.py::test_a_second_attempt_at_the_same_delivery_is_not_logged_as_another` 在整目录跑时失败。它在 fork main 上整目录跑也失败，单独跑能过，属于既有的顺序问题。
- Desktop：UI 套件 12,941 个全过。electron 套件 4,816 过、3 个失败，都在 `runtime-gateway-retirement.test.ts`，fork main 上同样这 3 个失败，属于本机环境问题。
- `npm run check:lint`：0 错误。`scripts/check`：12 项通过，code health 0 blocking。
- e2e：`folder-drop.spec.ts` 和 `folder-grants.spec.ts` 3 个全过。

## 反向验证

`reverse_verify.py` 逐个注入故障。每次先断言锚点在文件里只出现 1 次，只跑负责守这处的测试，跑完按 sha256 还原文件。35 个注入里 34 个变红，结果见 PR 描述里的表。P10 保持绿是预期的：它只放宽「非工作区」那类拒绝，而 `_resolve_path` 另一种拒绝（NT 设备路径）对任何根都会再抛出，所以注入前后行为等价，不算故障。

e2e 层另做了两项：

- 去掉 preload 记录拖入路径的那一行后重建，「拖入文件夹」一步变红（`第二批素材` 被拒），菜单两步仍绿。
- 在 fork main 上跑加强后的 hc-906 e2e，连跑 2 次都在新断言 `not.toContain('outside the allowed workspace')` 处变红。原来只断言 `prompt.includes(folder)` 的版本，在 fork main 上是绿的。

## 顺带确认的既有行为（未改）

在已有会话的对话里用菜单选文件，会暂存两份（`作品列表.xlsx` 和 `作品列表-2.xlsx`）：先是 drop-time 上传一份，发送时又传一份，模型拿到的是 `-2` 那份。fork main 上用同一流程复现了同样的结果，与本改动无关。
