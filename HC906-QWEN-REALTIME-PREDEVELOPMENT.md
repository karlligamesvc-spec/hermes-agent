# hc-906: 千问实时语音接入前审计（2026-10-04）

用户已授权通过 ChinaAPI 接入千问实时语音。PD apex sheet 5c1253 第845行，稳定编号 hc-906；两仓全历史与 PD 全 L1:L933 核号，登记后独立回读通过。

基线：Cloud origin/main 2c066f18a123cc4f27e2f8bfb2f6a0b750f3976b；fork a28ab5f51c21f3c99c619ddf12b87f2579d0d3d6。Cloud 复用本任务已附着的干净 worktree，fork 新建独立 hc906 worktree。现有公开桌面 0.17.45，本票未发布。

真实供应商探针：使用服务端既有凭据（未输出或搬运密钥）连接 wss://api.chinaapi.ai/v1/realtime?model=qwen-audio-3.0-realtime-flash，收到 session.created/session.updated；中文“你好”返回66,560 base64音频字节和 usage；嵌套 function 工具 schema 发出 apex_assistant(request) 调用。默认音色 longanqian，输入16kHz单声道PCM，输出24kHz。ChinaAPI catalog 标准音频入/出 $4.5/$15 per million tokens，不适用此前阿里云直连估价；历史/文本及助手调用另计。

出口盘点：Desktop 两处共享语音引擎菜单 → 当前 profile REST/status 与已鉴权本地/远端 WS → runtime 捕获当前 profile 的 APEX 凭据 → Cloud Relay Agent-key/account/installer entitlement/quota → ChinaAPI 原生 Realtime；response.done 使用量 → 现有 token_usage 月聚合。模型工具委托 → 既有 prompt.submit/审批/工具 → function_call_output → 原生语音。Nginx 主域与 claw 兼容 Relay 出口均需 WS upgrade；API 别名主要是 Scheduler，不承载本次 relay URL。Mac/Windows 共用 renderer。

GPT-Live 与 chained 两条既有引擎保留。图片、视频生成、文件ASR、文字模型选择及既有套餐不改。供应商凭据仅 Relay env；客户端持有的仍是可撤销 APEX Agent key。每个完成响应记录真实文本/音频总token，权重按公开价格面计算写入 billable_tokens，quota仍遵守既有 shadow/enforce 策略，不虚称钱包金额等于供应商账单。

验证：确定性 auth/禁用账号/installer freeze/quota/失效key/跨租户/profile/usage 两种拼写/重复响应/取消回调回归；loopback真实 WS 和真实导入配置链；JS事件/PCM/麦克风释放与工具衔接；反向注入后测试必须失败。真实上游仅上述短探针，不能代替真人麦克风、弱网、声学回声与物理Windows验收。发布需另记同步构建和三个公开manifest；本轮无生产重启/配置/DB变更。回滚为撤回新引擎或恢复既有 chained 设置，无schema变更。

实施证据（未发布）：完整 session_config 被真实 ChinaAPI 接受；APEX 工具调用及工具结果生成语音；合成 PCM16k 语音经 VAD/ASR 正确识别中文，并有文本/音频 usage。实际 native 人声不是物理麦克风验收。

桌面 typecheck/build 成功；941 UI 文件8991测试全绿，此后新增模型设置与连接切换守卫的定向103测试全绿。Python 实际 profile/HTTP/WS/RPC 与既有语音回归4文件18测试绿，ruff绿；eslint退出0、仍有297既有/非阻断警告。四项唯一锚点反向注入（移除挂断记账、借用默认profilekey、接收旧响应音频、旧profile状态覆盖）都真实变红后恢复。Cloud专项331测试绿；初次全量6072绿/319失败，其中316缺少本机dropdb，另外3个路由盘点/WS兼容测试已修复。全部后端还需有PG的CI通过，不把本机专项等同完整生产验证。

Cloud执行Issue：https://github.com/karlligamesvc-spec/apex-nodes/issues/971 。当前没有生产启用、Runtime重启或Desktop版本/公开feed变更。主域和claw的新WS路由须部署后分别以真实nginx -T核验；Cloud合同位于docs/FEATURE-CONTRACTS.md（独立Cloud仓）。
