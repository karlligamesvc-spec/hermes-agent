/**
 * The titlebar's 剪辑 (hc-1201): the editor opened by hand, and hidden again.
 *
 * Kael asked for a switch beside 打开设置 that opens and hides the editor, and
 * that checks this computer and installs what the editor needs the first time.
 * Main does the work (electron/openfilm-studio.ts); this drives it:
 *
 * - While the editor shows, the switch hides it (its tab closes; Studio keeps
 *   running in main, so opening it again is quick).
 * - Otherwise, when the editor is ready, it opens the newest film.html of the
 *   conversation on screen (the composer's preview rows), else the project
 *   last opened in the editor, else says how a project comes about. It never
 *   makes an empty project.
 * - When it is not ready, the switch's popover runs the first-run check (the
 *   engine's look at the account, the toolkit, the browser it renders with and
 *   the free disk space), starts the install as the person asked for it, shows
 *   how far it is, and opens the editor once it is ready.
 *
 * One run at a time: a newer click or closing the popover ends the one before.
 */

import { atom } from 'nanostores'

import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { $openfilmStudioOn, OPENFILM_STUDIO_TAB_ID, openfilmProjectFolder } from '@/lib/openfilm-studio'
import { closeRightRailTab, openFilmFolderInEditor } from '@/store/preview'
import { $previewStatusBySession } from '@/store/preview-status'
import { $activeSessionId } from '@/store/session'
import { $focusedRuntimeId } from '@/store/session-states'

/** The engine's first-run check (main's `openfilmStudio.check`). */
export interface OpenfilmCheck {
  browser: { bytes: number; ready: boolean }
  disk: { free: number; needed: number }
  toolkit: { bytes: number; ready: boolean }
}

/** The install's download, as main last heard it from the engine. */
export interface OpenfilmProgress {
  done: number
  step: 'browser' | 'toolkit'
  total: number
}

/** What the switch's popover shows; null while it is closed. */
export type OpenfilmSetup =
  | { check: null | OpenfilmCheck; phase: 'failed' }
  | { check: null | OpenfilmCheck; phase: 'preparing'; progress: null | OpenfilmProgress }
  | { check: OpenfilmCheck; phase: 'disk' }
  | { phase: 'checking' }
  | { phase: 'empty' }

export const $openfilmSetup = atom<null | OpenfilmSetup>(null)

/** How often the popover asks main how far the install is. */
export const OPENFILM_SETUP_POLL_MS = 1_000

/** The film.html a preview row names (lib/openfilm-studio.ts `openfilmProjectFolder` reads the same). */
const FILM_TARGET = /(^|[\\/])film\.html$/

let run = 0

const bridge = () => window.hermesDesktop?.openfilmStudio

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

/** The switch: hide the editor while it shows, close the popover while it is open, else open the editor. */
export async function toggleOpenfilmEditor(showing: boolean): Promise<void> {
  if ($openfilmSetup.get() !== null) {
    closeOpenfilmSetup()

    return
  }

  if (showing) {
    closeRightRailTab(OPENFILM_STUDIO_TAB_ID)

    return
  }

  await openOpenfilmEditor()
}

/** Closing the popover ends its run; an install it started goes on in main. */
export function closeOpenfilmSetup(): void {
  run += 1
  $openfilmSetup.set(null)
}

export async function openOpenfilmEditor(): Promise<void> {
  const desktop = bridge()

  if (!desktop) {
    return
  }

  const mine = ++run
  const status = await Promise.resolve(desktop.status()).catch(() => null)

  if (mine !== run || !status) {
    return
  }

  if (!status.on) {
    // The answer changed since the switch was drawn: it goes away with it.
    $openfilmStudioOn.set(false)
    $openfilmSetup.set(null)

    return
  }

  if (status.ready) {
    await openNewestProject(mine)

    return
  }

  await prepare(mine)
}

/** The popover's 重试 / 重新检查: the check again, and the install started even right after a failure. */
export async function retryOpenfilmSetup(): Promise<void> {
  await prepare(++run)
}

async function prepare(mine: number): Promise<void> {
  const desktop = bridge()

  $openfilmSetup.set({ phase: 'checking' })
  const check = (await Promise.resolve(desktop?.check?.()).catch(() => null)) ?? null

  if (mine !== run) {
    return
  }

  if (check && check.disk.free < check.disk.needed) {
    $openfilmSetup.set({ phase: 'disk', check })

    return
  }

  await Promise.resolve(desktop?.prefetch(true)).catch(() => undefined)

  if (mine !== run) {
    return
  }

  $openfilmSetup.set({ phase: 'preparing', check, progress: null })
  await follow(mine, check)
}

/** Until the editor is ready (then it opens), the install fails, or the run ends: how far it is. */
async function follow(mine: number, check: null | OpenfilmCheck): Promise<void> {
  const desktop = bridge()

  while (mine === run) {
    await pause(OPENFILM_SETUP_POLL_MS)

    const status = await Promise.resolve(desktop?.status()).catch(() => null)
    const install = await Promise.resolve(desktop?.progress?.()).catch(() => null)

    if (mine !== run) {
      return
    }

    if (status && !status.on) {
      $openfilmStudioOn.set(false)
      $openfilmSetup.set(null)

      return
    }

    if (status?.ready) {
      await openNewestProject(mine)

      return
    }

    // Neither ready nor installing: the install failed (or main cannot say how it went, which reads the same).
    if (status && !status.preparing && (install?.failed ?? true)) {
      $openfilmSetup.set({ phase: 'failed', check })

      return
    }

    $openfilmSetup.set({ phase: 'preparing', check, progress: install?.progress ?? null })
  }
}

async function openNewestProject(mine: number): Promise<void> {
  for (const project of await openfilmProjectCandidates()) {
    if (mine !== run) {
      return
    }

    if (await openFilmFolderInEditor(project.folder, project.source)) {
      if (mine === run) {
        $openfilmSetup.set(null)
      }

      return
    }
  }

  if (mine === run) {
    $openfilmSetup.set({ phase: 'empty' })
  }
}

/**
 * Where a project to open may be, best first: the newest film.html of the
 * conversation on screen (its preview rows, newest last), then the project
 * last opened in the editor. Each is a folder that held film.html; main says
 * whether it still does when it is opened.
 */
export async function openfilmProjectCandidates(): Promise<Array<{ folder: string; source: string }>> {
  const sessionId = $focusedRuntimeId.get() ?? $activeSessionId.get()
  const rows = sessionId ? ($previewStatusBySession.get()[sessionId] ?? []) : []
  const projects: Array<{ folder: string; source: string }> = []

  for (const row of [...rows].reverse()) {
    if (!FILM_TARGET.test(row.target)) {
      continue
    }

    const target = await normalizeOrLocalPreviewTarget(row.target, row.cwd || undefined).catch(() => null)
    const folder = target ? openfilmProjectFolder(target) : null

    if (folder && !projects.some(project => project.folder === folder)) {
      projects.push({ folder, source: target?.source ?? row.target })
    }
  }

  const last = await Promise.resolve(bridge()?.lastProject?.()).catch(() => null)

  if (typeof last === 'string' && last && !projects.some(project => project.folder === last)) {
    const separator = last.includes('\\') && !last.includes('/') ? '\\' : '/'

    projects.push({ folder: last, source: `${last}${separator}film.html` })
  }

  return projects
}
