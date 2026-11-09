# hc-1176 实测：OpenFilm 工具包走 media-tools 下载，第一次做视频时后台装

2026-11-07，Mac（Apple Silicon），开发版 APEX（本分支的 `dist/`，e2e 假模型，「使用自己的密钥」），全新的 HERMES_HOME。
开关 `APEXNODES_OPENFILM_STUDIO=1`，没有设开发工具包。

## 结论

1. **没就绪时照常放成片。** 智能体给出 film.html 时编辑器还没装：预览框照常把 film.html 当网页打开，右下角提示「编辑器还在准备，先放成片；好了会自动切过去。」（截图 01）
2. **后台装。** 打开时主进程用正在运行的引擎跑 `python -m apex_overlay.media_tools openfilm`：
   - 先从 APEX COS 下好智能体浏览器的 Chrome for Testing 153（核对了 sha256）；
   - 再去 COS 取工具包。COS 上还没有，所以是 404，日志只记一行「toolkit not installed: … HTTP Error 404」，不打扰用户；
   - 没留下半截安装：`tool-cache/openfilm/` 里只有锁文件，没有 `ready.json`。
3. **装好后自动切过去。** 用引擎的同一个 `ensure_openfilm()` 装本地构建的工具包，模拟 COS 上已经有了：只把锁里那个 COS 地址换成本地文件，大小和 sha256 照样核对。装完写出 `ready.json`，几秒内仍在前台的 film.html 自己切到了 OpenFilm Studio（截图 02）。
4. **用的是智能体浏览器。** Studio 带起 16 个 Chrome for Testing 进程，来自沙盒的 `tool-cache/chrome/930e2a2c…/`；Playwright 的浏览器一个都没有。

## Chrome 共用

- **Mac**：OpenFilm 用智能体浏览器的 CfT 153 渲染 CookVlog 前 3 秒（90 帧），和 Playwright 的 headless shell 149 对比：
  - 逐帧 SSIM 平均 0.988，最低 0.9858；
  - 并排看不出差别（截图 03），残差像编码噪声；
  - 1080×1920 渲染 34.4 秒，headless shell 是 30.6 秒。
- **Windows**：智能体渲染用的是 headless shell 152（锁里的 `render-win-x64`，Hypit 也用它），`ensure_openfilm` 拿的就是这一份。Windows 上用它渲染还没实测。
- 浏览器缺失时 OpenFilm 只报错、不从 Playwright CDN 下载：补丁 0002 加守卫 `chromium.test.mjs`。

## 没测的

- 从 COS 真实下载工具包：还没上传，要先问 Kael。
- Windows 上的整条链路（下载、解压、headless shell 152 渲染）。
- 正式包。
- 真实模型：用的是假模型，没有真的调视频工具；工具触发由单测和消息流测试覆盖。
- film.html 当网页显示时是白底。开关关时也一样，这一票没改，第 4 项（APEX 版编辑器页面）会处理预览框的样子。
