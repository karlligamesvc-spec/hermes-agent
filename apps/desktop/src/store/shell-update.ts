/**
 * 壳(Electron 应用本体)自更新状态 store —— electron/shell-updater.cjs 的
 * renderer 侧薄镜像。机制(检查/下载/安装)全在主进程 electron-updater 里,
 * 这里只订阅状态推送 + 暴露「重启以更新」动作:
 *   - $shellUpdate: 主进程状态机快照(checking/downloading/downloaded/…),
 *     null = 还没拉到(或跑在没有该 bridge 的旧壳上);
 *   - initShellUpdateSubscription(): 挂事件订阅 + 拉初始快照,幂等,由侧栏
 *     胶囊在 mount 时调用(和引擎胶囊自持检查计划同思路);
 *   - installShellUpdate(): 触发 quitAndInstall(应用随即退出重启)。
 *
 * 下载全程静默——store 会收到 downloading 进度,但 UI 只对 downloaded 出胶囊。
 */

import { atom } from 'nanostores'

import type { DesktopShellUpdateState } from '@/global'

export const $shellUpdate = atom<DesktopShellUpdateState | null>(null)

// 模块级幂等闸:胶囊随侧栏折叠/展开反复重挂,订阅只挂一次(IPC listener
// 泄漏会让同一个状态推送翻倍)。
let subscribed = false

export function initShellUpdateSubscription(): void {
  if (subscribed) {
    return
  }

  const bridge = window.hermesDesktop?.shellUpdate

  // 旧壳没有这个 bridge:保持 null,胶囊永不出现。
  if (!bridge) {
    return
  }

  subscribed = true
  bridge.onEvent(state => $shellUpdate.set(state))

  // 初始快照补齐:renderer 可能在主进程已 downloaded 之后才挂载(比如
  // devtools reload),光靠事件流会永远等不到那次迁移。
  void bridge
    .getState()
    .then(state => {
      // 事件流已经写入更新状态时不要用旧快照倒退。
      if ($shellUpdate.get() === null) {
        $shellUpdate.set(state)
      }
    })
    .catch(() => {
      // 静默:拉不到快照就当没有更新,别打扰。
    })
}

/**
 * 触发 quitAndInstall。成功路径上应用直接退出重装,promise 通常没有然后;
 * 失败(极少)时抛错,由胶囊回退成可再点的状态。
 */
export async function installShellUpdate(): Promise<void> {
  const bridge = window.hermesDesktop?.shellUpdate

  if (!bridge) {
    throw new Error('unsupported')
  }

  const result = await bridge.install()

  if (!result.ok) {
    throw new Error(result.error || 'install_failed')
  }
}
