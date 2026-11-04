# hc-1142 退出登录卡顿：计时和截图

环境：dev Electron（`npm run build` 的 dist），全新沙箱，真引擎（本仓 `hermes serve`），假 LLM，假 APEX 账号服务和中转，产品模式（`APEXNODES_SINGLE_THREAD=1`）。账号服务每个请求加 0.8 秒，代替到 apex-nodes.com 的网络。没有用真实账号。

计时方法：页面里的 MutationObserver 记每次界面变化（下一帧时间），主进程在 `hermes:managed:signOut` 处理器外面包一层记开始和返回，假账号服务记每个请求的到达和回应，同一台机器同一时钟，以点击（pointerdown）为 0。

## 改前：fork main f159f8abf3

| 账号服务延迟 | 点击后 | capabilities | 吊销 | IPC 返回 | 登录页画出 | 登录页消失 | 登录页再出现 |
|---|---|---|---|---|---|---|---|
| 0 | 菜单不收，「退出登录」行转圈（15 ms） | 19 ms | 43 ms | 59 ms | 80 ms | 230 ms | 3531 ms |
| 0.8 s | 同上（12 ms） | 16→818 ms | 850→1651 ms | 1671 ms | 1694 ms | 1879 ms | 5178 ms |
| 0.8 s | 同上（13 ms） | 20→821 ms | 846→1648 ms | 1667 ms | 1695 ms | 1811 ms | 5079 ms |

登录页消失到再出现，正好是主引擎重启（`restarting primary backend … (sign-out; committed)` 到 `Hermes backend is ready`）。Kael 11-03 的日志里这段是 2.7 秒和 3.1 秒。

- `screenshots/before-1-waiting-for-revoke.png`：等吊销时，菜单还开着，只有一个小转圈。
- `screenshots/before-2-engine-restart-gap.png`：IPC 返回后、引擎重启时：原来的界面，没有账号行，输入框「正在重新连接 APEX…」。

## 改后

| 情形 | 菜单收起 +「正在退出登录…」 | 退出期间发出的请求 | IPC 返回 | 登录页画出 | 登录页消失 |
|---|---|---|---|---|---|
| 同一次运行里登录过 | 13 ms | 吊销 58→860 ms | 884 ms | 914 ms | 没有 |
| 重开 App，开菜单 1.5 s 后点 | 13 ms | 吊销 65→868 ms | 895 ms | 916 ms | 没有 |
| 重开 App，开菜单 0.1 s 就点 | 13 ms | 吊销 656→1456 ms（先等菜单打开时发出的 capabilities，−182→621 ms） | 1479 ms | 1497 ms | 没有 |
| e2e 最终一轮（48371020e4） | 14 ms | 吊销 52→852 ms | — | 913 ms | 没有 |
| 吊销回 500 | 13 ms | 吊销 41→843 ms | 866 ms | 不出（盖层 880 ms 撤掉，提示出来） | — |
| 提示里点「重试」（吊销正常） | 12 ms | 吊销 | — | 880 ms | 没有 |

退出那行日志（一行）：`… engines still on it restart once idle; took 877 ms: fence 24, capabilities 0, revoke 827, clear 23, clean-up 3`。几轮里 fence 15–65 ms，clear 13–69 ms，clean-up 3–4 ms。

- `screenshots/after-1-signing-out-cover.png`：点击后 0.15 s。
- `screenshots/after-2-login-during-engine-restart.png`：IPC 返回 1.6 s 后，引擎还在重启。
- `screenshots/after-3-revoke-failed.png`：吊销回 500：界面原样，提示原因和「重试」。

## 退出后马上登录（main 上的半登录）

在 main 上，退出 IPC 返回 60 ms 后发起浏览器登录、立刻回调：登录结果 `{ ok: false, hasRelayKey: true, message: 'ECONNRESET', localRuntime: true }`，`status()` 为 `signedIn: false, runtimePending: true`，服务器上已经发了新 key。改后同样时序：`ok: true`，新 key 进了引擎。

e2e `a sign-in started the moment the sign-out returns still ends on the new key`：本分支 3/3 过；把「登录先等引擎重启」撤掉，3 次里 2 次红（`ok: false, hasRelayKey: true`）。竞态窗口是 IPC 返回到旧引擎被停之间约 0.1–0.2 秒，所以撤掉后也有一次没撞上。
