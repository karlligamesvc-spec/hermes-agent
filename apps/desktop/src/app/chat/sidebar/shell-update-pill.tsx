import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import { ChevronRight, Loader2, RefreshCw } from '@/lib/icons'
import { $shellUpdate, initShellUpdateSubscription, installShellUpdate } from '@/store/shell-update'

// hc-447: the pill is compact by design (one line, sidebar-bottom) — a full
// changelog reader belongs in Settings → About (see ChangelogSection), not
// here. This just surfaces the FIRST line of the hand-authored notes so the
// capsule reads as human copy instead of a bare version number; the complete
// text is still available via the native title tooltip on hover. No line
// breaks in the preview — multi-line notes (or a joined multi-version note,
// see shell-updater.cjs normalizeReleaseNotes) collapse to their first
// non-blank line.
function firstReleaseNotesLine(notes: string | null): string {
  if (!notes) {
    return ''
  }

  return notes.split('\n').map(line => line.trim()).find(Boolean) ?? ''
}

// 侧栏底部「壳更新」胶囊(Codex 同款「重启以更新 vX.Y.Z」),复用引擎胶囊的
// p5-update-pill 视觉,挂在引擎胶囊上方。刻意比引擎胶囊更沉默:
//   - 检查/下载全程隐形(机制在主进程 electron-updater,autoDownload 静默拉);
//   - 只有 downloaded(新壳已就位,就差重启)才出胶囊;
//   - 点击 → quitAndInstall,应用退出换包自动拉起;
//   - 出错不打扰 —— 主进程记日志,这里保持隐形,不点也会在退出时自动装。
// 和引擎胶囊同时命中时壳胶囊优先(runtime-update-pill.tsx 里让位):壳包
// 通常携带引擎 pin bump,重启一次两者一并到位,没必要各促各的。
export function ShellUpdatePill() {
  const { t } = useI18n()
  const state = useStore($shellUpdate)
  const [installing, setInstalling] = useState(false)

  // 订阅是模块级幂等的;胶囊随侧栏折叠反复重挂也只接一次线。
  useEffect(() => {
    initShellUpdateSubscription()
  }, [])

  if (state?.phase !== 'downloaded') {
    return null
  }

  // electron-updater 的 info.version 是裸 semver(0.16.1);展示带 v 前缀。
  const version = state.version ? (state.version.startsWith('v') ? state.version : `v${state.version}`) : null
  // hc-447: '' when the release shipped with no hand-authored notes — the
  // pill then renders exactly as it did before this ticket (title + version).
  const notesPreview = firstReleaseNotesLine(state.releaseNotes)

  const handleClick = async () => {
    if (installing) {
      return
    }

    setInstalling(true)

    try {
      await installShellUpdate()
      // 成功即退出重装;不复位 installing,避免退出前的最后一帧闪回可点态。
    } catch {
      // 极少数失败(spawn 失败等):回到可再点;退出时 autoInstallOnAppQuit
      // 仍会兜底安装,所以这里不需要报错打扰。
      setInstalling(false)
    }
  }

  return (
    <button
      aria-busy={installing || undefined}
      className="p5-update-pill"
      data-state={installing ? 'applying' : 'idle'}
      data-testid="shell-update-pill"
      disabled={installing}
      onClick={() => void handleClick()}
      type="button"
    >
      <span aria-hidden className="p5-update-pill-icon">
        {installing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
      </span>
      <span className="p5-update-pill-text">
        <span className="p5-update-pill-title">{t.sidebar.shellUpdate.restartToUpdate(version ?? '')}</span>
        {notesPreview && (
          <span className="p5-update-pill-notes" title={state.releaseNotes ?? undefined}>
            {notesPreview}
          </span>
        )}
      </span>
      {installing ? null : <ChevronRight aria-hidden className="p5-update-pill-chevron size-3.5" />}
    </button>
  )
}
