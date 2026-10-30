# hc-1122 — 把 ChatCut 接进 APEX Desktop

PD Sheet1 第 1059 行。PR 正文有方案、出口清单和反向验证表，这里只放验收过程和截图。

## 怎么测的

全新沙箱的 dev Electron + 仓库里的真实引擎，每次都从首启开始，没有预置 token 或配置。

| 走查 | 模型 | ChatCut | 看什么 |
|---|---|---|---|
| 界面走查 | 脚本模型（通过 `tool_call` 调工具，和真模型一样） | 本地假服务（`tests/apex_overlay/chatcut_fake_service.py`） | 卡片、步骤文案、设置页、断开 |
| 真连验收 | 脚本模型，参数全部取自上一步的真实结果 | **真实 ChatCut**，Kael 的免费账号 | 授权、导入、转写、剪辑、字幕、导出 |
| 关闭验收 | 脚本模型 | 无 | `APEXNODES_CHATCUT=0`：没有痕迹 |

可行性验证的完整记录在交接笔记 `hc-1122-feasibility.md`。

## 结果

| 项 | 结果 |
|---|---|
| 助手提议连接 | 工具自己弹选择卡，用户不用看到任何技术词 |
| 选「连接」 | 打开系统浏览器，授权后 token 落到这个助手的目录，工具当场可用，不用开新会话 |
| 写 MCP 配置时引擎是否重启 | **没有**。engine PID 全程不变（真连 6 分钟，界面走查同样），`desktop.log` 没有重启记录 |
| 第一次导入 | 弹同意卡，说清传到哪里、用谁的额度；同意后写进 `apex/chatcut-upload-consent.json`，之后不再问 |
| 真实导入 | 编辑器在系统 Chrome 里，从我们自己的本机服务取文件，5 秒完成，URL 带随机路径 |
| 真实剪辑 | `read_script` → 划掉两句 → `apply_script`，10.1 秒 → 6.97 秒 |
| 真实字幕 | 建轨 + 生成成功；导出的画面里看得到（见可行性记录） |
| 真实导出 | `status: complete`，7133005 字节；第三次导出被 Chrome 的「允许多个下载」拦住（文档也提到），技能已写明怎么处理 |
| 额度 | 前后都是 5，没有调用任何生成工具（白名单里也没有） |
| 看过程 | 全部是人话（「连接 ChatCut」「导入素材」「剪视频」「处理字幕」「导出视频」），没有 `mcp__chatcut__…` |
| 断开 | 工具、配置、token、同意记录都清掉；engine PID 不变；按字节扫沙箱没有残留 |
| 开关关 | 设置侧栏没有 ChatCut；模型看不到任何 chatcut 工具；config.yaml 没有 chatcut，没有 `mcp-tokens`，`desktop.log` 没有 `APEX_CHATCUT` |

## 走查查出的问题（已修）

**第二张卡点不了。** 卡片是工具内部发起的，转录里没有配套的 `clarify` 开始和结束，上传卡落在了已回答的连接卡那一行，选项全灰，单元测试全绿也测不出。现在每张卡自己发开始和结束（`ask_on_card`），守卫是 `test_each_card_gets_its_own_clarify_row_that_opens_and_closes`。

## 截图

| | |
|---|---|
| 助手提议连接 | ![](screenshots/connect-card.jpg) |
| 第一次上传前征得同意 | ![](screenshots/upload-card.jpg) |
| 看过程 | ![](screenshots/steps.jpg) |
| 设置：已连接 | ![](screenshots/settings-connected.jpg) |
| 设置：断开前再问一次 | ![](screenshots/settings-confirm.jpg) |
| 设置：未连接 | ![](screenshots/settings-disconnected.jpg) |

截图里的 Mock Model 和「提供方」是因为沙箱走的「使用自己的密钥」；APEX 账号下没有这两项。

## 没验证的

- **真模型按技能走**：验收用的是脚本模型，证明了每个工具和卡片都通，没有证明真模型读技能后的表现。开关打开前要 Kael 用真实账号说一句「帮我剪这段」试一次。
- **打包产物**：这里是 dev 版。候选包要按发版流程再验一次。
- **关着编辑器时的真实报错**：导入失败后会自动打开编辑器重试一次（假服务上测过），真实服务的报错文字没有见过，代码不依赖它的内容。
- **Chrome 以外的默认浏览器**：Safari 从 https 页面访问 `http://127.0.0.1` 的行为没有测。失败时走「请用户在编辑器里手动上传」。
- **Chrome 的本地网络权限框**：这次没有拦住导入，不确定 Kael 之前有没有点过，已经问他。
- **退出 APEX 账号时的清理**：单元测试按字节扫描覆盖，真实账号没有点过。hc-1114（fork #535）合并后，engine 重启由它负责。
