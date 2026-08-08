import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { CheckCircle2, Download, Loader2 } from '@/lib/icons'
import { $shellUpdate, initShellUpdateSubscription, installShellUpdate } from '@/store/shell-update'

// hc-447: the pill is compact by design (one line, sidebar-bottom) — a full
// changelog reader belongs in Settings → About (see ChangelogSection), not
// here. This just surfaces the FIRST line of the hand-authored notes so the
// capsule reads as human copy instead of a bare version number; the complete
// text is still available via the native title tooltip on hover. No line
// breaks in the preview — multi-line notes (or a joined multi-version note,
// see shell-updater.ts normalizeReleaseNotes) collapse to their first
// non-blank line.
function firstReleaseNotesLine(notes: string | null): string {
  if (!notes) {
    return ''
  }

  return (
    notes
      .split('\n')
      .map(line => line.trim())
      .find(Boolean) ?? ''
  )
}

// electron-updater 的 info.version 是裸 semver(0.17.2);展示带 v 前缀,已带的
// 保持原样。
function displayVersion(raw: string | null | undefined): string {
  if (!raw) {
    return ''
  }

  return raw.startsWith('v') ? raw : `v${raw}`
}

function clampPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return Math.max(0, Math.min(100, Math.round(value)))
}

// 侧栏底部「壳更新」胶囊,复用引擎胶囊的 p5-update-pill 视觉,挂在引擎胶囊上方。
//
// hc-605 之前这个胶囊只在 downloaded 一态出现,文案是「重启以更新 vX.Y.Z」;
// 结果 0728 真实用户连撞两次「更新了还是老样子」——他一直开着应用,包早就躺在
// ~/Library/Caches/hermes-updater/pending/ 里,而界面既没说下载在进行,也没说
// **不退出就装不上**。electron-updater 的安装点在进程退出那一刻(我们保持
// autoDownload + autoInstallOnAppQuit 不变),所以这件事必须由 UI 讲明白。
//
// 现在三态各自可辨:
//   available    ⤓  「发现新版本 vX.Y.Z」 + 「正在后台下载…」   纯状态,不可点
//   downloading  ⟳  「正在下载 vX.Y.Z」 + 「已下载 45%」+ 进度条  纯状态,不可点
//   downloaded   ✓  「vX.Y.Z 已下载完成」
//                   + 「退出应用后才会安装」   ← 缺的就是这一句
//                   + 发布说明首行(hc-447)
//                   + 明确 CTA 按钮「立即重启更新」→ quitAndInstall
//
// 绝不自动重启:用户可能正在对话中,退出只能由他点 CTA 触发;不点也没损失——
// 退出应用时 autoInstallOnAppQuit 照样兜底装上。
// checking / idle / disabled / error 仍然全程隐形(离线用户零打扰,下一轮周期
// 检查自动重试)。
// 和引擎胶囊同时命中时壳胶囊优先(runtime-update-pill.tsx 里对 downloaded
// 让位):壳包通常携带引擎 pin bump,重启一次两者一并到位。
export function ShellUpdatePill() {
  const { t } = useI18n()
  const s = t.sidebar.shellUpdate
  const state = useStore($shellUpdate)
  const [installing, setInstalling] = useState(false)

  // 订阅是模块级幂等的;胶囊随侧栏折叠反复重挂也只接一次线。
  useEffect(() => {
    initShellUpdateSubscription()
  }, [])

  const phase = state?.phase

  if (phase !== 'available' && phase !== 'downloading' && phase !== 'downloaded') {
    return null
  }

  const version = displayVersion(state?.version)

  if (phase === 'available') {
    return (
      <div
        className="p5-update-pill"
        data-state="available"
        data-testid="shell-update-pill"
        title={state?.releaseNotes ?? undefined}
      >
        <span aria-hidden className="p5-update-pill-icon">
          <Download className="size-3.5" />
        </span>
        <span className="p5-update-pill-text">
          <span className="p5-update-pill-title">{s.foundTitle(version)}</span>
          <span className="p5-update-pill-notes">{s.downloadingInBackground}</span>
        </span>
      </div>
    )
  }

  if (phase === 'downloading') {
    // percent 为 null(下载器还没报第一个 tick)时进度条走不确定态的脉冲,
    // 副标题退回「正在后台下载…」——不编一个假的 0%。
    const percent = clampPercent(state?.percent)

    return (
      <div className="p5-update-pill p5-update-pill--stack" data-state="downloading" data-testid="shell-update-pill">
        <div className="p5-update-pill-row">
          <span aria-hidden className="p5-update-pill-icon">
            <Loader2 className="size-3.5 animate-spin" />
          </span>
          <span className="p5-update-pill-text">
            <span className="p5-update-pill-title">{s.downloadingTitle(version)}</span>
            <span className="p5-update-pill-notes">
              {percent === null ? s.downloadingInBackground : s.downloadedPercent(percent)}
            </span>
          </span>
        </div>
        <div
          aria-hidden
          className="p5-update-pill-progress"
          data-indeterminate={percent === null ? 'true' : undefined}
          data-testid="shell-update-progress"
        >
          <span
            className="p5-update-pill-progress-fill"
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      </div>
    )
  }

  // hc-447: '' when the release shipped with no hand-authored notes — the
  // notes line is then absent entirely (unchanged since hc-447).
  const notesPreview = firstReleaseNotesLine(state?.releaseNotes ?? null)

  const handleInstall = async () => {
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
    <div className="p5-update-pill p5-update-pill--stack" data-state="ready" data-testid="shell-update-pill">
      <div className="p5-update-pill-row">
        <span aria-hidden className="p5-update-pill-icon p5-update-pill-icon--ready">
          <CheckCircle2 className="size-3.5" />
        </span>
        <span className="p5-update-pill-text">
          <span className="p5-update-pill-title">{s.readyTitle(version)}</span>
          {/* 这一行是 hc-605 的全部要害:不退出应用就装不上。 */}
          <span className="p5-update-pill-hint">{s.installsOnQuit}</span>
          {notesPreview && (
            <span className="p5-update-pill-notes" title={state?.releaseNotes ?? undefined}>
              {notesPreview}
            </span>
          )}
        </span>
      </div>
      <Button
        aria-busy={installing || undefined}
        className="w-full"
        data-testid="shell-update-install"
        disabled={installing}
        onClick={() => void handleInstall()}
        size="sm"
        type="button"
      >
        {installing && <Loader2 aria-hidden className="animate-spin" />}
        {installing ? s.restarting : s.restartNow}
      </Button>
    </div>
  )
}
