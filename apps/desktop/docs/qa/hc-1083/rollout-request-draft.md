# 申请草稿：发一版客户端配置，给所有人打开多助手（multi_bot）

> 草稿模板。验收（`qa-report.md`）和一周内测做完后，把【】里的内容填上，交协调会话转给 Kael。
> 只起草，不写库。客户端配置由协调会话在 Kael 批准后写。

## 要批的事

在 `desktop_client_configs` 新建 v【N+1】= 当前生效的 v【N】+ `desktop_features.multi_bot: true`，其余一字不改。`multi_bot_max` 不写，客户端缺省 5（APEX + 4 个，K2）。

生效后：

- 只有【B 波版本号】及以上、并且单线模式开着的 Desktop 会出现多助手；更旧的版本不认这个键，照旧。
- 开发者模式不受影响。
- 每个人侧栏第一行仍是 APEX 和原来那条主线（K5、K6），不建就和现在一样。

## 依据

| 项 | 结果 |
|---|---|
| 验收记录 | `apps/desktop/docs/qa/hc-1083/qa-report.md`（fork PR【#】） |
| 第 3 节各组 | A【】B【】C【】D【】E【】F【】G【】H【】I【】J【】K【】L【】M【】 |
| 冷启动（Mac / Windows 高配 / Windows 低配） | 第一次点开【】秒；回收后再开【】秒；热切换【】秒 |
| 每个引擎内存 | 【】MB（Mac）/【】MB（Windows）；主 1 + 池 3 都在时全部进程【】MB |
| 池满实际行为 | 【证实或推翻 README 第 4 节的预判；M1 / M4 怎么处理的】 |
| 内测一周 | 【几台机器、谁在用、用了几个助手、发现的问题和处理】 |
| 实际花费 | 【tokens 合计和 ChinaAPI 回读】，批准额度【】 |

## 风险和对策

- 池上限 3 个：4 个助手不可能同时在，切到第 4 个要冷启动，可能要等。【验收后的实际情况和处理】
- 内存：每多开一个助手多一个引擎进程，约【】MB。低配机器【情况】。
- 删除是真删（K9），确认框写清楚了删什么、不删什么，没有回收站。
- Windows 安装包仍未签名（硬规则 15），和现在一样。
- 记忆底账所有助手共用（K1），名字和分工不进底账（M6 已验）。

## 怎么做（协调会话执行，照 v3、v4 的做法）

1. 读当前生效行，确认是 v【N】，记下 payload。
2. ops SQL 一个事务：锁表；前置检查；先把 v【N】的 `is_active` 关掉（`uq_desktop_client_configs_active` 只允许一行生效），再插入 v【N+1】，`created_by` 为 NULL；写一行 `audit_log`（`action=desktop_client_config_created`，`details` 里 `via=ops-sql`、`approved_by=Kael`、`previous_version=【N】`，`id` 用 `gen_random_uuid()`）；后置检查。
3. 先在生产库里 ROLLBACK 空跑一遍，再正式执行。备份到 `/data/hermes/ops-artifacts/multi-bot-on-<UTC 时间>/`。
4. 读回公开接口：`known_version=【N】` 返回 v【N+1】且带 `multi_bot: true`；`known_version=【N+1】` 返回 unchanged。
5. 找一台没设 `APEXNODES_MULTI_BOT` 的【B 波版本】Desktop，重启后侧栏出现「+」。

## 回滚

再发一版更高的 v【N+2】，把 `multi_bot` 设成 false。**不能**重新激活旧的 v【N】：客户端不认比手里低的版本号。关掉以后已经建好的助手怎样：【按验收 B2 的结果填，预期是侧栏回到一行 APEX、助手的 profile 留在磁盘上不删】。

## 要 Kael 回答

- 批不批：【 】
- 什么时候生效：【 】
