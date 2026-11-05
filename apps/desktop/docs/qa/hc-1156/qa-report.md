# hc-1156 口播精剪的入口和过程说法（验收记录）

分支 `claude/hc-1156-trim-entry`，基于 fork main `c5baa593`。只在单线程产品模式下生效。

## 怎么跑的

`e2e/trim-entry.spec.ts`：开发版 Electron（这个分支 `npm run build` 的 dist）、从这个检出直接起的真实引擎（`hermes serve`）、按脚本回答的本地假模型，全新沙盒（新的 HERMES_HOME 和 userData，`APEXNODES_SINGLE_THREAD=1`），登录页点「使用自己的密钥」接到本地假模型。没有任何付费调用。

1. 用 Chromium 自己的拖放事件（CDP `Input.dispatchDragEvent`，带真实文件路径，和从访达拖进来走同一条拖放处理）把一个真实视频文件拖到输入框上。
2. 输入框上方出现「剪干净 / 剪干净再加字幕 / 先找同类视频对照」，点「剪干净」。
3. 发出的话是「把这段口播剪干净」，视频作为附件一起发（引擎把它暂存进 `attachments/`）。
4. 假模型按 short-video-studio 在 Desktop 上的写法让引擎通过终端工具依次运行四条命令：`"$APEX_PYTHON" "$HERMES_HOME/skills/apexnodes/short-video-studio/scripts/footage_motion.py" pacing | recipe | trim | compare …`。四个子命令的真脚本在 apex-nodes（hc-1153–1155）里写，现在还没有，所以沙盒里放了一个只记录调用、`trim` 时停 8 秒的替身；规格最后核对引擎确实按顺序跑了这四条。
5. 剪的过程中看活动行，完成后点「看过程」看步骤。

复现：

```bash
cd apps/desktop && npm run build
HC1156_SHOTS="$TMPDIR/hc1156" APEX_PYTHON=<engine python> npx playwright test e2e/trim-entry.spec.ts --workers=1
```

本机跑之前按 e2e 惯例临时关掉 `apexnodes://` 协议注册（不提交）；跑完核对过访达的 `apexnodes` 处理程序仍是 `com.apexnodes.desktop`。

## 截图

| 图 | 看什么 |
|---|---|
| `01-dropped-take.jpg` | 视频拖进来后，输入框上方是三个精剪按钮 |
| `02-trim-chips.jpg` | 同一处放大 |
| `03-cut-running.jpg` | 剪的过程中 |
| `04-cut-running-line.jpg` | 活动行「正在剪掉停顿和口误… 第 3 步」，下面「已看完素材，正在剪辑」 |
| `05-steps.jpg` | 完成后「看过程」：量节奏 · 量好了 / 定剪法 · 定好了 / 剪掉停顿和口误 · 剪好了 / 对照检查 · 查过了 |

过程区里没有出现脚本名、子命令、`$APEX_PYTHON` 或路径（规格逐个核对）。

## 没在这里验的

- 开关关着、开发者模式下仍是原来的四个按钮和「在电脑上处理」：由 `src/paste-chips-identity.test.tsx` 的 golden（在 main 上录）和 `trim-chips.test.tsx`、`trim-plain-words.test.tsx` 钉住，没在开发版里再走一遍。
- ⌘V 粘贴访达里复制的视频：输入框今天只把粘贴的图片变成附件，视频文件进来只是文件名，所以不出按钮（本票不改）。
- 打包产物：这次是开发版。
- 真实账号、真实模型：都没用。
