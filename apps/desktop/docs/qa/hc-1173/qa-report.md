# hc-1173 原型：OpenFilm Studio 在 APEX Desktop 的预览框里

2026-11-07 · Mac Studio(M4 Max)· 本分支的开发版 APEX Desktop(Electron 40.10.2)· openfilm 0.3.0(钉死)· Chromium headless shell 149.0.7827.55

**这是原型，不是发布**:开关默认关，平台开关打不开它;工具包只装在开发机的开发目录里，没打进 APEX;没发版，没碰更新源。
截图来自开发版(Playwright 启动 `dist/` + e2e 的假模型 + 「使用自己的密钥」),不是正式包。

## 结论

1. **能用**:智能体回复里给出 `film.html`,点「打开预览」,右边预览框里就是 Studio:多轨时间线、中文界面、窄框自动换成「上面预览、下面时间线」。
2. **人改的写回同一份文件**:
   - 点画面上的字幕、改字 → `captions.vtt` 只改那一句;
   - 双击开场花字、改字 → `film.html` 里花字片段多出 `overrides`,`scenes/hook.html` 不动;
   - 分割 → `film.html` 里一个 `<video>` 变两个。
3. **智能体能接着改**:智能体的 `openfilm look`(用同一个 `OPENFILM_HOME`)找到的就是 APEX 起的这个 Studio,不开浏览器，报出人改的花字。智能体随后重写 `film.html` 时，Studio 保住人的修改，下一条命令开头告诉智能体:「The person changed these in Studio while you worked … clip hook overrides at #hookA1; clip shot03 time; clip shot03-b」。
4. **新发现的严重问题**:上面第 3 条的合并会**丢掉整条字幕轨**(`<track kind="captions">`),见下文「坏了的」第 1 条。上线前必须解决。
5. **报告里没测过的那条路通了**:APEX 自带的 Electron 40(Node 24.15)当 Node 跑 Studio,0.2 秒起来;Studio 的渲染子进程(`fork`)和 Chromium 也正常。

## 怎么接的(本分支)

- **开关**:`APEXNODES_OPENFILM_STUDIO=1` 才开;`APEXNODES_OPENFILM_TOOLKIT` 指向装着 `node_modules/openfilm`(和 `browsers/`)的目录。不读平台下发的 `desktop_features`:工具包没随 APEX 分发前，远端打开只会报错。可选 `APEXNODES_OPENFILM_FFMPEG_DIR`(开发版不跑已装好的引擎，用它指到引擎的 ffmpeg)。
- **主进程**(`electron/openfilm-studio.ts`):第一次需要时，用 APEX 自己的二进制带 `ELECTRON_RUN_AS_NODE=1` 起一个子进程，跑一个小宿主脚本，调用 `openfilm/studio` 的 `startStudio({ port: 0, stays: true, advertise: true, openBrowser })`。
  - 用子进程而不是在主进程里直接调:`PATH`(引擎自带的 ffmpeg 放最前)、`OPENFILM_*`、`PLAYWRIGHT_BROWSERS_PATH` 只给 Studio,不漏给引擎和其他子进程;Studio 崩了不带走 APEX。
  - 子进程只拿到一小份环境(HOME、语言、代理等),主进程里的其他变量(含密钥)不传。
  - `OPENFILM_HOME/LIBRARY/SAVED/SKILLS/EXPORTS` 都在 APEX 数据目录的 `openfilm/` 下;`OPENFILM_NO_BROWSER=1`、`OPENFILM_NO_UPDATE_CHECK=1`。
  - 宿主必须是文件，不能用 `-e`:Studio 用 `execArgv` fork 渲染进程,`-e` 会让每个渲染进程再跑一遍宿主(有测试钉住)。
  - Studio 要开浏览器(顶栏「桌面版」、登录)时只记日志、不开;日志里不写启动密钥。APEX 退出时关掉子进程的 stdin,Studio 自己干净退出(`run.json` 也删掉);实测 Studio 和 Chromium 子进程都跟着退了。
- **渲染进程**:`openPreview()` 是预览的唯一入口。开关开时，本机的 `film.html` 交给 Studio,在一个专用、不持久化的预览页签里打开(复用现成的 `<webview>` 浏览器页签，没有新的预览类型);Studio 打不开就照旧显示文件。
- `electron/main.ts` 不能变长(代码健康棘轮):把 `previewUrlTarget` 原样挪到 `electron/preview-url-target.ts`,补了测试;main.ts 净少 6 行。

## 第 4、5 步实测(开发版)

| 步骤 | 做了什么 | 结果 | 截图 |
|---|---|---|---|
| 交付 | 假模型回复里带 `film.html` 链接 | 回复里出现文件卡片 | `01-agent-reply-film-card.jpg` |
| 4 | 点「打开预览」 | 预览框里打开 Studio,工程 cook2,时间线完整 | `02-step4-studio-in-preview-pane.jpg` |
| 5a | 播放头拖到 9.6 秒，点画面上的字幕 | 右侧出现字幕面板，文字「菜是我们买好带来的」 | `03-step5a-click-caption-on-picture.jpg` |
| 5a | 改成「菜是我们提前买好的」,点别处 | `captions.vtt` 只改第 26 行;这一句的逐字时间和 `<c.k>` 样式都没了(已知坑);`film.html` 不变 | `04-step5a-caption-retyped.jpg` |
| 5b | 2 秒处点开场花字，再双击 | 选中「这间厨房」那一行(500×172),双击后出现文字框 | `05-step5b-double-click-hook-text.jpg` |
| 5b | 改成「这间厨房不归我」,点别处 | `film.html` 第 27 行变成 `overrides='[{"at":"#hookA1","text":"这间厨房不归我"}]'`,同时去掉了默认的 `at="0"`;`hook.html` 不动 | `06-step5b-hook-text-edited.jpg` |
| 5c | 7.07 秒处选中第 3 镜，点「分割 (⌘B)」 | 一个 `<video>` 变两个(`#t=0.6,2.426` 和 `shot03-b` `#t=2.426,4.667`,`at="7.059"`);后半段带着同样的 `zoomArrive` 入场动画，画面在切点处又糊了一下(已知坑) | `07-step5c-split-shot3.jpg` |
| 5d | 智能体在工程目录跑 `openfilm look` | 报出 `✎ hook changed in Studio: #hookA1 text`;**没报**改字幕文字和分割;生成器写的 20 条淡入淡出也被报成「changed in Studio」(已知坑) | — |
| 合并 | 智能体用生成器原样重写 `film.html` | Studio 保住花字和分割，`look` 开头告诉智能体;**但字幕轨被删了** | `08-captions-gone-after-agent-rewrite.jpg` |
| 开关关 | 同一个开发版，不设开关，走同样的流程 | `film.html` 照旧当网页打开(空白),没有任何 OpenFilm 进程、日志和目录 | `09-switch-off-unchanged.jpg` |

## 坏了的 / 要注意的

1. **人改过东西后，智能体重写 `film.html`,字幕轨整条消失**(新发现，严重)。Studio 的合并保住了人的修改，却删了 `<section><track kind="captions" …></section>`;时间线上字幕全没了,`captions.vtt` 还在磁盘上但没人引用;`look` 也不报。复现了两次(cook2:改字幕 + 改花字 + 分割;cook3:只改花字)。对照组 cook4(人没改)让智能体写入，字幕轨保留。所以是「保住人的修改」这条合并路径的问题。要么报上游、等修，要么生成器换一种写字幕轨的方式绕开(没试)。
2. **`look` 只报写在 `overrides` 里的改动**:人改的字幕文字(在 `captions.vtt`)和分割(改的是 `<video>` 本身)它不说。智能体要自己比对文件，或者靠上面那条合并通知(只在它的写入会覆盖人的修改时才有)。
3. 改字幕会丢逐字计时(报告里的坑，复现)。
4. 分割会把入场动画复制到后半段(报告里的坑，复现，截图 07 里能看到糊)。
5. Studio 写回时省掉默认值(`at="0"`),智能体比较差异时别当成人改的。
6. **默认语言跟系统走**:这台 Mac 的 Electron 报 `en-US`,Studio 就是英文。Studio 自己的语言设置存在 `localStorage['openfilm.language']`,按来源(含端口)保存，而 Studio 每次启动换端口，所以记不住。测试时手动设成 `zh-CN`。
7. **预览框外壳**:Studio 用的是浏览器页签，地址栏露出带启动密钥的地址;聊天里再点一个网页链接，会把 Studio 页签导航走(现有浏览器页签的规则)。
8. **占资源**:Studio 进程树空闲时约 1.2 GB RSS(宿主 278 MB + 8 个 headless Chromium,共享内存重复计入);每个工程 `.film/` 缓存约 100 MB(预览代理 90 MB)。
9. **会联网**:Studio 一启动就从 GitHub 拉技能目录(`openfilm/home/skill-catalog/` 出现了)和示例索引。

## 装机体积(开发目录 `~/.apexnodes-dev/openfilm/0.3.0`)

| 项目 | 体积 | 来源 / 时间 |
|---|---|---|
| openfilm 0.3.0 + playwright-core 1.61.1(`node_modules`) | 65 MB | npmmirror,6 秒 |
| Chromium headless shell 149 | 192 MB | `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`,12 秒 |
| Playwright 自带的 ffmpeg(OpenFilm 用不到) | 2.5 MB | 同上 |
| **合计** | **约 260 MB** | |
| APEX 数据目录里 Studio 自己的东西 | 约 0.2 MB | `openfilm/home` |
| 每个工程的 `.film/` 缓存 | 约 100 MB | 预览代理、波形、帧 |

ffmpeg 用的是已装 APEX 引擎的 9.0.2(`~/.apexnodes/hermes-agent/.runtime/bin`)。

## Studio 界面要为 APEX 改的(只列，不改)

- 顶栏「桌面版」按钮(下载 OpenFilm 桌面版;原型里拦掉了，不开浏览器，但按钮还在)。
- 登录和服务:设置 → 服务、OpenFilm 自己的付费生成素材。
- 素材库和社区素材库(openfilm.dev)、示例(GitHub 示例索引)、技能目录(GitHub)。
- 版本更新(已用 `OPENFILM_NO_UPDATE_CHECK=1` 关掉检查;`stays` 时顶栏更新也会拒绝)。
- 默认语言要跟 APEX(中文),不跟系统。
- 品牌：页签名「OpenFilm Studio」、Logo、深色配色;商标条款不允许改过的版本叫 OpenFilm。
- 「切换项目」(会列出 Studio 自己的工程库)、「切换到画布」。
- 需要模型的功能(翻译字幕、画布写字)没接 `askAgent`,现在会走 OpenFilm 自己连的服务。
- 预览框外壳：换成没有地址栏的专用页签，不露启动密钥。

## 请 Kael 定的

1. 「合并丢字幕轨」这个坑出来以后，还继续走 OpenFilm 吗?继续的话：报上游等修，还是我们生成器绕开?
2. 工具包怎么给用户:260 MB 的媒体包在第一次要「可编辑版」时下载，还是随 APEX 一起装?
3. 智能体那一侧要不要接：引擎环境里放同一个 `OPENFILM_HOME`、`openfilm` 命令和 APEX 的剪辑技能(这次是我在 shell 里替智能体跑的 `look`)。
4. Studio 外壳怎么改：fork OpenFilm 改界面(MIT 允许，不能叫 OpenFilm),还是用 `editorDir` 把 Studio 的编辑器编进 APEX 自己的页面?
5. 开关：现在只有本机环境变量能开。内测要不要做成平台开关(只给内部账号)?
6. 票号：本分支用 hc-1173(本仓、fork、PD L 列三处查过都空着),PD 表还没写这一行，需要你确认。

## 没测的

- 正式包(`.app`)里跑：打包后 `ELECTRON_RUN_AS_NODE` 是否被 Electron fuse 关掉、asar 里的路径，都没验。
- Windows。
- 真实智能体回合(用的是 e2e 假模型);真人在 APEX 里按 ⌘A、⌘B 等快捷键(测试用的是 webview 的输入事件和 `selectAll()`)。
- 导出、剪映草稿导出(报告里在浏览器里测过，这次没在 APEX 里测)。

## 复现

```bash
# 工具包(开发目录，不进 APEX)
mkdir -p ~/.apexnodes-dev/openfilm/0.3.0 && cd ~/.apexnodes-dev/openfilm/0.3.0
npm install openfilm@0.3.0 --save-exact --registry=https://registry.npmmirror.com
PLAYWRIGHT_BROWSERS_PATH=$PWD/browsers PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright node node_modules/playwright-core/cli.js install chromium-headless-shell

# 开发版 APEX(apps/desktop,全新的 HERMES_HOME / userData)
export APEXNODES_OPENFILM_STUDIO=1
export APEXNODES_OPENFILM_TOOLKIT=$HOME/.apexnodes-dev/openfilm/0.3.0
export APEXNODES_OPENFILM_FFMPEG_DIR=$HOME/.apexnodes/hermes-agent/.runtime/bin
```

样片用 `~/Desktop/APEX调研/openfilm-spike-20261107/工程/tools/build_openfilm.py` 重新生成(和试点那份逐字节相同)。

测试:`npx vitest run electron/openfilm-studio.test.ts electron/preview-url-target.test.ts --project electron`、`npx vitest run src/store/preview-openfilm-studio.test.ts --project ui`。
反向验证：宿主改成 `-e` 启动 → 「opens a project…」变红(execArgv 断言);把主进程环境整份传给子进程 → 环境测试和子进程测试变红;开关关时也路由 → 「is unchanged while the switch is off」变红。
