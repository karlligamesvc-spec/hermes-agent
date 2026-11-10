import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'

import { previewPaneId } from '@/app/chat/preview-tile-ids'
import { $paneVisible } from '@/components/pane-shell/tree/store'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import { OPENFILM_STUDIO_COPY, type OpenfilmSetupCopy } from '@/i18n/openfilm-studio'
import { triggerHaptic } from '@/lib/haptics'
import {
  $openfilmSetup,
  closeOpenfilmSetup,
  type OpenfilmCheck,
  type OpenfilmProgress,
  type OpenfilmSetup,
  retryOpenfilmSetup,
  toggleOpenfilmEditor
} from '@/lib/openfilm-editor-entry'
import { $openfilmStudioOn, OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'

import type { TitlebarTool } from './titlebar-controls'
import { TitlebarIcon } from './titlebar-icon'

/**
 * The titlebar's 剪辑 (hc-1201), beside 打开设置: opens the editor, or hides it
 * while it shows (lib/openfilm-editor-entry.ts). Only while the editor is open
 * to this account; its glyph is the 剪辑 tab's own. The first time, its
 * popover checks this computer and installs what the editor needs.
 */
export function useOpenfilmEditorTool(): TitlebarTool {
  const { locale } = useI18n()
  const on = useStore($openfilmStudioOn)
  const showing = useStore($paneVisible(previewPaneId(OPENFILM_STUDIO_TAB_ID)))
  const copy = OPENFILM_STUDIO_COPY[locale]

  return {
    active: showing,
    hidden: !on,
    icon: <TitlebarIcon name="file-media" />,
    id: 'openfilm-editor',
    label: showing ? copy.hideEditor : copy.openEditor,
    onSelect: () => {
      triggerHaptic('open')
      void toggleOpenfilmEditor(showing)
    },
    tour: 'openfilm-editor',
    wrap: button => <OpenfilmEditorSetup>{button}</OpenfilmEditorSetup>
  }
}

/** The switch, with its first-run popover anchored under it. */
export function OpenfilmEditorSetup({ children }: { children: ReactNode }) {
  const { locale } = useI18n()
  const setup = useStore($openfilmSetup)

  return (
    <Popover
      onOpenChange={open => {
        if (!open) {
          closeOpenfilmSetup()
        }
      }}
      open={setup !== null}
    >
      <PopoverAnchor asChild>
        <span className="inline-flex">{children}</span>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-80 p-3"
        data-testid="openfilm-editor-setup"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        {setup && <OpenfilmSetupBody copy={OPENFILM_STUDIO_COPY[locale].setup} setup={setup} />}
      </PopoverContent>
    </Popover>
  )
}

/** 41.6 MB, 1.2 GB: decimal, as the download sizes and the disk are told elsewhere. */
export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(bytes / 1e6, 0.1).toFixed(1)} MB`
}

type RowState = 'downloading' | 'installing' | 'problem' | 'ready' | 'waiting'

/** Where one part stands: there already, its download, being installed, or still to come. */
function partState(
  part: 'browser' | 'toolkit',
  check: null | OpenfilmCheck,
  progress: null | OpenfilmProgress
): RowState {
  if (check?.[part].ready || (part === 'browser' && progress?.step === 'toolkit')) {
    return 'ready'
  }

  if (progress?.step !== part) {
    return 'waiting'
  }

  return progress.done < progress.total ? 'downloading' : 'installing'
}

function Row({ children, state }: { children: ReactNode; state: RowState }) {
  const glyph = {
    downloading: <Codicon name="loading" spinning />,
    installing: <Codicon name="loading" spinning />,
    problem: <Codicon className="text-(--ui-red)" name="error" />,
    ready: <Codicon className="text-(--ui-green)" name="check" />,
    waiting: <Codicon className="opacity-50" name="circle-large-outline" />
  }[state]

  return (
    <li className="flex items-start gap-2" data-state={state}>
      <span className="mt-0.5 inline-flex shrink-0">{glyph}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  )
}

function partLine(copy: OpenfilmSetupCopy, state: RowState, progress: null | OpenfilmProgress): string {
  if (state === 'downloading' && progress) {
    return copy.downloading(formatSize(progress.done), formatSize(progress.total))
  }

  return { downloading: copy.waiting, installing: copy.installing, problem: copy.failed, ready: copy.ready, waiting: copy.waiting }[
    state
  ]
}

export function OpenfilmSetupBody({ copy, setup }: { copy: OpenfilmSetupCopy; setup: OpenfilmSetup }) {
  if (setup.phase === 'empty') {
    return <p className="text-sm leading-relaxed">{copy.empty}</p>
  }

  if (setup.phase === 'checking') {
    return (
      <div className="grid gap-2 text-sm">
        <p className="font-medium">{copy.title}</p>
        <p className="flex items-center gap-2 text-(--ui-text-secondary)">
          <Codicon name="loading" spinning />
          {copy.checking}
        </p>
      </div>
    )
  }

  const check = setup.check
  const progress = setup.phase === 'preparing' ? setup.progress : null
  const diskShort = setup.phase === 'disk'
  const renderer = partState('browser', check, progress)
  const editor = partState('toolkit', check, progress)

  return (
    <div className="grid gap-3 text-sm">
      <p className="font-medium">{copy.title}</p>
      <ul className="grid gap-2">
        <Row state="ready">{copy.account}</Row>
        {check && (
          <Row state={diskShort ? 'problem' : 'ready'}>
            {diskShort
              ? copy.diskShort(formatSize(check.disk.free), formatSize(check.disk.needed))
              : copy.diskEnough(formatSize(check.disk.free))}
          </Row>
        )}
        <Row state={renderer}>
          {copy.renderer}
          <span className="text-(--ui-text-secondary)"> · {partLine(copy, renderer, progress)}</span>
        </Row>
        <Row state={editor}>
          {copy.editor}
          <span className="text-(--ui-text-secondary)"> · {partLine(copy, editor, progress)}</span>
        </Row>
      </ul>
      {progress && progress.done < progress.total && <Progress size="sm" value={progress.done / progress.total} />}
      {setup.phase === 'failed' && <SetupAction hint={copy.failed} label={copy.retry} />}
      {diskShort && <SetupAction hint={copy.diskHint} label={copy.recheck} />}
    </div>
  )
}

function SetupAction({ hint, label }: { hint: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-(--ui-text-secondary)">{hint}</p>
      <Button onClick={() => void retryOpenfilmSetup()} size="sm" type="button" variant="outline">
        {label}
      </Button>
    </div>
  )
}
