/**
 * apex-quit-confirm.ts — the quit confirmation also asks once the window is
 * closed (hc-1104).
 *
 * quit-guard.ts decides from what the windows report (store/active-work.ts)
 * whether a quit would cut off a turn. On macOS the app stays in the Dock when
 * its last window closes and the turn keeps running in the engine, but a
 * closed window no longer reports and there is no window to show the dialog
 * on: ⌘Q, the Dock's Quit and APEX › Quit all quit at once.
 *
 * So when no window reports on macOS, the engines answer instead. Each local
 * engine the quit would stop (the primary engine Desktop spawned, every pooled
 * engine with a child of its own) is asked `GET /api/health/idle`: the
 * token-gated, read-only snapshot behind the retirement fence, which does not
 * close admission. An engine that says it is working, or that cannot prove it
 * is idle, holds the quit for the same confirmation, shown without a parent
 * window. No answer (no engine, an engine without the route, a probe past its
 * deadline) is no reason to ask. The turn ledger (apex-turn-ledger.ts) cannot
 * decide this: it lists what was running when the window went away, not what
 * is running now.
 *
 * With a window reporting nothing changes: the same check, dialog and parent
 * as before. Windows and Linux quit as their last window closes, so they never
 * reach the engine check.
 *
 * Never asked: the system ending the session (NSWorkspaceWillPowerOff comes
 * before macOS asks the app to quit for a logout, restart or shutdown) and the
 * shell update's quitAndInstall ('before-quit-for-update'). A dialog there
 * would hold up the logout, or leave the installer waiting on a process that
 * does not exit, so quits stop asking for ENDING_MS.
 *
 * This all runs in before-quit ahead of the teardown, so "Keep Running" never
 * aborts `localBackendLifecycle.signal`: the engines and the turn ledger stay
 * as they were. "Quit Anyway" lets the teardown freeze the ledger with the
 * turns it cuts off, and the next launch says 「上次被打断了」.
 */

import { type ActiveWork, type QuitPrompt, quitPromptFor } from './quit-guard'

/** After the session starts ending, quits go through without asking for this long. */
export const ENDING_MS = 30_000
/** How long the engines get to answer before the quit goes ahead without them. */
export const ENGINE_PROBE_DEADLINE_MS = 2_000
export const ENGINE_IDLE_PATH = '/api/health/idle'

export interface LocalEngine {
  baseUrl: string
  token: string
}

/** The fields read from a backend pool entry. */
interface PooledEngine {
  port?: null | number
  process?: unknown
  token?: null | string
}

/**
 * The local engines a quit stops: the primary engine when Desktop spawned it
 * and its connection has settled, and every pool entry with a child of its own
 * (remote descriptors have none).
 */
export async function localEnginesOf(
  primary: { connection: null | Promise<unknown>; owned: boolean },
  pool: Iterable<PooledEngine>
): Promise<LocalEngine[]> {
  const engines: LocalEngine[] = []
  const connection = primary.owned ? await primary.connection?.catch(() => null) : null
  const { baseUrl, mode, token } = (connection ?? {}) as { baseUrl?: unknown; mode?: unknown; token?: unknown }

  if (mode === 'local' && typeof baseUrl === 'string' && typeof token === 'string') {
    engines.push({ baseUrl, token })
  }

  for (const entry of pool) {
    if (entry.process && entry.port && entry.token) {
      engines.push({ baseUrl: `http://127.0.0.1:${entry.port}`, token: entry.token })
    }
  }

  return engines
}

/**
 * Chats one engine's idle snapshot holds the quit for: those named by a
 * `session:<id>,<id>` ledger, 1 for any other work or for an engine that cannot
 * prove it is idle, 0 when idle. Anything that is not a snapshot is no answer.
 */
export function engineWorkCount(snapshot: unknown): number {
  const { detail, idle, ok } = (snapshot ?? {}) as { detail?: unknown; idle?: unknown; ok?: unknown }

  if (ok !== true || (idle !== false && idle !== null)) {
    return 0
  }

  const sessions =
    typeof detail === 'string' && detail.startsWith('session:') ? detail.slice('session:'.length).split(',') : []

  return Math.max(1, sessions.filter(Boolean).length)
}

function answerWithin(answer: () => Promise<unknown>, ms: number): Promise<unknown> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms)

    Promise.resolve()
      .then(answer)
      .then(resolve, () => resolve(undefined))
      .finally(() => clearTimeout(timer))
  })
}

export interface DialogParent {
  isDestroyed: () => boolean
  isVisible: () => boolean
}

export interface QuitDialogOptions {
  buttons: string[]
  cancelId: number
  defaultId: number
  detail: string
  message: string
  type: 'question'
}

export interface QuitConfirmDeps<P extends DialogParent> {
  isMac: boolean
  /** HERMES_DESKTOP_SKIP_QUIT_CONFIRM, or a hand-off quit (update / swap / uninstall script). */
  skip: () => boolean
  /** How many windows report, and their merged report. */
  windowWork: () => { reporters: number; work: ActiveWork }
  /** The focused window, else the first one. */
  parent: () => null | P | undefined
  engines: () => Promise<LocalEngine[]>
  /** GET ENGINE_IDLE_PATH on one engine. */
  probe: (engine: LocalEngine) => Promise<unknown>
  showMessageBox: (parent: null | P, options: QuitDialogOptions) => Promise<{ response: number }>
  /** Brings the app forward, so a dialog with no parent is not left behind another app. */
  focusApp: () => void
  quit: () => void
  log: (line: string) => void
  now?: () => number
  probeDeadlineMs?: number
}

/** What says the session is ending; see the header. */
export interface SessionEndSources {
  /** systemPreferences, macOS only. */
  workspace?: { subscribeWorkspaceNotification: (event: string, callback: () => void) => number }
  /** Electron's own autoUpdater: Squirrel.Mac emits this, and electron-updater emits it for NSIS. */
  updater: { on: (event: 'before-quit-for-update', listener: () => void) => unknown }
}

export interface QuitConfirm {
  /** For before-quit: true when the quit is held (the event was prevented) for the dialog or the engines. */
  hold: (event: { preventDefault: () => void }) => boolean
  /** The session is ending: quits go through without asking for ENDING_MS. */
  sessionEnding: () => void
  watchSessionEnd: (sources: SessionEndSources) => void
}

export function createQuitConfirm<P extends DialogParent>(deps: QuitConfirmDeps<P>): QuitConfirm {
  const now = deps.now ?? Date.now
  let endingAt = Number.NEGATIVE_INFINITY
  let promptOpen = false
  let checking = false
  // "Quit Anyway", or engines with nothing running: the quit this starts goes straight to the teardown.
  let confirmed = false

  const ending = () => now() - endingAt < ENDING_MS

  const quitNow = () => {
    confirmed = true
    deps.quit()
  }

  function ask(parent: null | P, prompt: QuitPrompt) {
    promptOpen = true

    if (!parent) {
      deps.focusApp()
    }

    void deps
      .showMessageBox(parent, {
        buttons: ['Keep Running', 'Quit Anyway'],
        cancelId: 0,
        defaultId: 0,
        detail: prompt.detail,
        message: prompt.message,
        type: 'question'
      })
      .then(({ response }) => {
        promptOpen = false

        if (response === 1) {
          quitNow()
        }
      })
      .catch(() => {
        // A dialog we can't show must not become a quit we can't perform.
        promptOpen = false
        quitNow()
      })
  }

  async function askEngines() {
    const engines = await deps.engines()
    const deadline = deps.probeDeadlineMs ?? ENGINE_PROBE_DEADLINE_MS
    const answers = await Promise.all(engines.map(engine => answerWithin(() => deps.probe(engine), deadline)))
    const count = answers.reduce<number>((sum, answer) => sum + engineWorkCount(answer), 0)
    const prompt = deps.skip() || ending() ? null : quitPromptFor({ count, titles: [] }, false)

    deps.log(`[quit] no window open: ${count} running in ${engines.length} local engine(s)${prompt ? ', asking' : ''}`)

    if (!prompt) {
      quitNow()

      return
    }

    const parent = deps.parent()

    ask(parent && !parent.isDestroyed() && parent.isVisible() ? parent : null, prompt)
  }

  const sessionEnding = () => {
    endingAt = now()
  }

  return {
    hold(event) {
      if (deps.skip() || confirmed || promptOpen || ending()) {
        return false
      }

      const { reporters, work } = deps.windowWork()
      const prompt = quitPromptFor(work, false)
      const parent = deps.parent()

      if (prompt && parent && !parent.isDestroyed()) {
        event.preventDefault()
        ask(parent, prompt)

        return true
      }

      if (!deps.isMac || reporters > 0) {
        return false
      }

      event.preventDefault()

      if (!checking) {
        checking = true
        // A check that breaks must not become a quit we can't perform either.
        void askEngines()
          .catch(quitNow)
          .finally(() => {
            checking = false
          })
      }

      return true
    },

    sessionEnding,

    watchSessionEnd({ updater, workspace }) {
      for (const watch of [
        () => workspace?.subscribeWorkspaceNotification('NSWorkspaceWillPowerOffNotification', sessionEnding),
        () => updater.on('before-quit-for-update', sessionEnding)
      ]) {
        try {
          watch()
        } catch (error) {
          deps.log(`[quit] cannot watch for the session ending: ${(error as Error)?.message || error}`)
        }
      }
    }
  }
}
