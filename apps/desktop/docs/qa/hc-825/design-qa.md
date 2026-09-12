# hc-825 Phase 1-only 视觉 QA

## 评审边界

本轮视觉对象仅为 Start、Projects、Project 详情与 Workflows，以及这些页面共用的主侧栏、业务画布、输入、卡片、按钮和窄窗规则。Profile、Settings 和账户 Overlay 保持 fork main，不把旧的扩展视觉试验带入 Phase 1 发布候选。

基线：fork `main@077490a963007e4c77170e425bfd2b61f76dfd17`，版本 `0.17.24`。Draft #263/hc-820 Phase 2A 不是祖先；Run drawer、双页签和 compact responsive Run drawer 为 No-Go。

## 页面裁决标准

### Start

- 单一“业务目标”主输入位于页面视觉中心，快捷入口和数据源信息形成次级层级。
- Start 不挂载底部全局 composer；键盘顺序为目标输入、提交、附件相关可用动作。
- 草稿、附件、chat fallback、template id/version 和失败保留语义不变。

### Projects

- 列表行先进入 Project 详情，不因缺少 `currentRunId` 而直接跳回 Start。
- 有 Run 显示真实 Run 入口；无 Run 显示诚实空态和“继续这个目标”。
- Project name 等于 objective 时不重复；不展示推算的百分比、步骤或待办。

### Workflows

- 真实目录不可用时提供重试和返回开始页；测试 catalog 必须明确标记。
- 完整态路径为目录→模板→可编辑目标→启动前确认。
- 不宣称 DSH 接入，不用测试模板冒充生产目录。

### 窗口与壳

- 1440×900、1220×800、700–752px 三档均检查真实 BrowserWindow，而非只改 renderer viewport。
- 640–899px 完整侧栏自动收起，展开入口可见；页面无水平滚动。
- 浅色业务路由在 glass 设置下仍为连续不透明 APEX 画布；普通 Session 的 glass 语义不被改写。
- macOS traffic lights、安全区、标题栏拖拽区、焦点回落和滚动到底后的最后内容均可见。

## 证据状态

已从严格 Phase 1-only 集成 `8e5463144fd5ffb3e19a772829e3c15814ef8acd`（tree `9258a5c4036bead3a6f42f38f6e0606284242b86`）完成一次实包证据闭环。该集成的两个父提交分别为 hc-824 `89a95a662d00b2af2b67c88af770fd11887b620a` 与 hc-825 `f50024aa15ead8627914270231e4081c4995f991`；最终 Draft restack 只会在此基础上追加测试、截图与 QA 文档，不改变 renderer 生产源码。最终远端 HEAD、tree、CI 与从该精确 HEAD 重建的 DMG 哈希以 PR body 为准。

- packaged Electron 测试：`business-workspace-packaged.spec.ts` 9/9 通过；显式使用可导入当前 checkout 的 Python 3.11 runtime。
- 三档原生 BrowserWindow：1220×800 与 752×800 为精确窗口；macOS 将请求的 1440×900 夹为 1440×874，截图为 Retina 2×。
- Start 原生辅助功能树仅有一个 `text entry area Description: 业务目标`；从该输入按 Tab 后焦点进入“开始执行”。
- 本地测试 Project/catalog 在 UI 中都带 `[本地测试]`；未生成 Run、Step、Deliverable、来源数量或百分比。
- 诊断包：`APEX-0.17.24-mac-arm64.dmg`，SHA-256 `689e45b8f2cc0a3012017bd46d3b184f9d130eb7525c3124c672cfce13cd6e51`。
- 独立安装：`/Users/karl/Applications/APEX Phase 1 QA 8e546314.app`；clean userData 与独立、无空格的 `HERMES_HOME` 完成真实首启。
- 签名回读：`Signature=adhoc`、`TeamIdentifier=not set`，无 `Authority` / Developer ID；无 notarization ticket。构建使用 `--publish never`，没有上传或公开 updater feed 变更。

首次诊断将 `HERMES_HOME` 放在带空格的路径时，runtime `install.sh` 因未引用路径而失败；默认生产路径 `~/.apexnodes` 不含空格。本轮用独立无空格 runtime root 复验成功，该安装脚本问题不属于 Phase 1 renderer 范围，记录为未覆盖边界而不扩票修改。

## 三档截图与 Before/After

“Before”沿用 hc-816 首轮实包、只作 Kael 反馈问题的基线；“After”来自上述严格 Phase 1-only 原生集成。

| 页面 | 1440 档 | 1220 档 | 窄窗档 |
|---|---|---|---|
| Start Before | [1440×900](../hc-816/screenshots/before/start-1440x900.png) | [1220×800](../hc-816/screenshots/before/start-1220x800.png) | [700×800](../hc-816/screenshots/before/start-700x800.png) |
| Start After | [1440×874](screenshots/after-8e546314/start-1440x900.png) | [1220×800](screenshots/after-8e546314/start-1220x800.png) | [752×800](screenshots/after-8e546314/start-752x800.png) |
| Projects Before | [1440×900](../hc-816/screenshots/before/projects-1440x900.png) | [1220×800](../hc-816/screenshots/before/projects-1220x800.png) | [700×800](../hc-816/screenshots/before/projects-700x800.png) |
| Projects After | [1440×874](screenshots/after-8e546314/projects-1440x900.png) | [1220×800](screenshots/after-8e546314/projects-1220x800.png) | [752×800](screenshots/after-8e546314/projects-752x800.png) |
| Workflows Before | [1440×900](../hc-816/screenshots/before/workflows-1440x900.png) | [1220×800](../hc-816/screenshots/before/workflows-1220x800.png) | [700×800](../hc-816/screenshots/before/workflows-700x800.png) |
| Workflows After | [1440×874](screenshots/after-8e546314/workflows-1440x900.png) | [1220×800](screenshots/after-8e546314/workflows-1220x800.png) | [752×800](screenshots/after-8e546314/workflows-752x800.png) |

## 与批准原型的逐页差异

- Start：保留原型的中心目标区、三个快速入口和宽松留白；为真实附件、失败保留与 chat fallback 保留既有行为，没有复制原型的固定最小宽度或小字号。Kael 反馈后的唯一输入规则已在视觉、焦点和辅助功能三层同时成立。
- Projects：保留原型的清晰列表与状态层级，但不复制固定模拟数字；详情先展示真实 Project，再由用户显式选择“继续这个目标”，无 Run 时只显示诚实空态。
- Workflows：保留三条重点路径和紧凑其他路径；目录不可用时提供重试、检查连接与返回开始页。完整态截图只使用明确标注的本地测试 catalog，不宣称生产 `/workflows`、`/catalog` 已可用，也不宣称 DSH 接入。
- 壳层：三档均保持 APEX 字体、颜色、圆角和间距；640–899px 自动收栏并显示展开入口，没有横向溢出。macOS traffic lights、安全区与内容滚动按真实 BrowserWindow 验证。

## 故障注入

- 恢复 Start 底部全局 composer 后，单输入/辅助功能守卫变红；恢复修复后重新通过。
- 撤掉窄窗自动收栏、水平溢出或 composer 安全区任一约束，相应原生几何守卫变红；恢复后重新通过。
- 恢复无 Run Project 行直接回 Start 的旧行为后，Project 路由守卫变红；恢复后重新通过。
- 去掉 Workflow 错误态恢复动作或本地测试标识后，对应目录/文案守卫变红；恢复后重新通过。
- 截图矩阵测试若不显式回到 Start，会继承上一个测试的 Workflows 路由并失败；补上窗口复位和 Start 导航后，完整 packaged spec 9/9 通过。

## 停止条件

拿到新的三页 Phase 1 原生评审包后停下交给 Kael。生产 Workflows 完整态仍等待 authenticated `/workflows`、`/catalog` 200；未经授权不合并、不发布、不部署、不更新 updater，也不进入 Phase 2。
