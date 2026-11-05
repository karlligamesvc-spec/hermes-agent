# hc-1158 ⌘V 访达里复制的视频文件（验收记录）

分支 `claude/hc-1158-paste-copied-file`，叠在 hc-1156（`claude/hc-1156-trim-entry` `b0b5a70f`）上。改动不分模式；验收在单线程产品模式下做，因为精剪按钮只在那里出现。

## 先量了 Chromium 怎么交出一次「复制文件」

一个只有可编辑框的 Electron 40.10.2（Chrome 144）小页面，系统剪贴板放进访达复制文件时的内容（每个文件一项 `public.file-url`，第一项带文件名文字），再用 `webContents.paste()` 粘贴，记下 paste 事件里看到的东西：

| 复制的是 | paste 事件里 |
|---|---|
| 一个视频（中文文件名） | `types: ['Files']`，一个 `kind: 'file'` 的 File，`getPathForFile` 拿到真实路径；**文字是空的** |
| 同上，再加一张图标 TIFF | 同上；没有多出图片项。但主进程 `clipboard.readImage()` 这时读到的是那张 1024×1024 的图标 |
| 一个 PNG 文件 | 一个 `type: 'image/png'` 的 File，有真实路径，文字空 |
| 一个文件夹 | 一个 File，`webkitGetAsEntry().isDirectory === true`，有真实路径 |
| 两个文件 | 只交出第一个 |

所以改动前在 Electron 40 上，⌘V 一个复制的视频：图片路径不收（不是图片），文字是空的，于是走到「空粘贴」分支去读主进程剪贴板图片（WSL 的兜底）。读不到就什么都没有，读到图标就会把图标当图片附上。输入框里不会出现文件名，也不出按钮。

## 怎么跑的

`e2e/paste-copied-file.spec.ts`，和 hc-1156 的 `trim-entry.spec.ts` 同一套：开发版 Electron（这个分支 `npm run build` 的 dist），从这个检出直接起的真实引擎（`hermes serve`），按脚本回答的本地假模型，全新沙盒（`APEXNODES_SINGLE_THREAD=1`）。登录页点「使用自己的密钥」接到假模型，没有任何付费调用。

1. 主进程 `clipboard.writeBuffer('public.file-url', …)` 把沙盒里的 `口播第一条.webm` 放进系统剪贴板。上面那个小页面核对过，这样写进去，粘贴时交出的 File 和访达复制的一样。
2. 点输入框，按 ⌘V（Playwright 在 Mac 上把 Meta+V 当 Chromium 的 paste 命令执行，读的是系统剪贴板）。
3. 输入框里出现视频附件，上方是「剪干净 / 剪干净再加字幕 / 先找同类视频对照」，输入框里没有文字。
4. 点「剪干净」，发出的是「把这段口播剪干净」，视频作为附件一起发（引擎暂存进 `attachments/口播第一条.webm`），假模型回答出现。
5. 再放进 `口播第二条.webm`，点一下回答那段文字（焦点不在任何输入框上，规格核对过），按 ⌘V，走窗口级粘贴（paste-to-focus）。第二条视频照样成为附件，三个按钮再出现。

规格结束时把运行前剪贴板里的文字、HTML 和 RTF 写回去。本机跑的时候另外在前后整份存取了剪贴板。

复现：

```bash
cd apps/desktop && npm run build
HC1158_SHOTS="$TMPDIR/hc1158" npx playwright test e2e/paste-copied-file.spec.ts --workers=1
```

本机跑之前按 e2e 惯例临时关掉 `apexnodes://` 协议注册（不提交）；跑完核对过 `apexnodes` 的处理程序仍是 `com.apexnodes.desktop`。

## 改动前后

同一份规格在 hc-1156 分支（没有这次改动）上构建后跑：第 3 步失败，按钮组是空的（`Expected ['剪干净', '剪干净再加字幕', '先找同类视频对照'] / Received []`），输入框里没有附件，也没有文字（`00-before-paste-does-nothing.jpg`）。在这个分支上整份通过（14 秒）。

## 截图

| 图 | 看什么 |
|---|---|
| `00-before-paste-does-nothing.jpg` | 改动前：⌘V 后什么都没有 |
| `01-pasted-take.jpg` | ⌘V 后：视频附件 + 三个精剪按钮，输入框是空的 |
| `02-trim-chips.jpg` | 同一处放大 |
| `03-pasted-on-transcript.jpg` | 发过一轮后，在回答上点一下再 ⌘V：第二条视频成为附件，按钮再出现 |

## 没在这里验的

- 开关关着 / 开发者模式：粘贴后得到的附件和拖进来一样，按钮由 hc-1156 的规则决定（四个按钮）。由 `paste-files.test.tsx`（开关关着出四个按钮）和 hc-1156 的 golden 钉住，没在开发版里再走一遍。
- 真的在访达里按 ⌘C：这次没有访达的操作权限，用的是同样形状的剪贴板（见上表）。
- 一次复制几个文件：Chromium 只交出第一个，这里不处理。
- 非单线程模式首页的 Start 输入框（business goal launcher 的 textarea）：⌘V 仍不收文件，见 PR 的出口清单。
- 打包产物、Windows、真实账号和模型：都没用。
