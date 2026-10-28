/**
 * hc-1099: one desktop.log line when switching assistants goes wrong, so a
 * packaged build can say why a click did not land.
 *
 * The renderer reaches desktop.log through its error-level console: main
 * captures every `console.error` of the main window as `[renderer
 * console:main] …` (electron/renderer-log.ts). Each line names the assistant
 * (its profile) asked for and the one it was asked from, the reason and how
 * long it took. Nothing is written for a switch that lands, or for one a later
 * click replaced.
 */

/** A switch still not settled after this long gets its "still waiting" line (once). */
export const BOT_SWITCH_SLOW_MS = 15_000

/** A follow this soon after a click's switch settled is that switch being undone. */
export const FOLLOW_UNDO_WINDOW_MS = 5_000

/** Why openBot was called: the user's click on a row, or the shell following the conversation on screen. */
export type BotSwitchCause = 'click' | 'follow'

export interface BotSwitchWatch {
  /** The switch rejected (the engine could not be reached, every pool slot busy …). */
  failed: (error: unknown) => void
  /** It resolved: `answering` is the active profile now, `replaced` whether a later click took over. */
  resolved: (answering: string, replaced: boolean) => void
  /** Always, last: stops the slow-switch timer. */
  done: () => void
}

/** A click's switch: when it settled (null while under way). */
interface ClickSwitch {
  settledAt: null | number
  target: string
}

let lastClick: ClickSwitch | null = null

function line(text: string): void {
  console.error(`[multi-bot] ${text}`)
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)

  return text.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error'
}

/** Start watching one switch from `from` to `target`. */
export function watchBotSwitch(target: string, from: string, cause: BotSwitchCause): BotSwitchWatch {
  const startedAt = Date.now()
  const elapsed = () => `${Date.now() - startedAt} ms`
  const head = `switch ${from} → ${target}`

  if (cause === 'follow' && lastClick && lastClick.target !== target) {
    const since = lastClick.settledAt === null ? null : startedAt - lastClick.settledAt

    if (since === null || since < FOLLOW_UNDO_WINDOW_MS) {
      line(
        `switch to ${lastClick.target} undone: the conversation on screen belongs to ${target} (${
          since === null ? 'while that switch was still under way' : `${since} ms after it landed`
        })`
      )
    }
  }

  const click: ClickSwitch | null = cause === 'click' ? { settledAt: null, target } : null

  if (click) {
    lastClick = click
  }

  const slow = setTimeout(() => line(`${head} still waiting after ${elapsed()}`), BOT_SWITCH_SLOW_MS)

  return {
    done: () => {
      clearTimeout(slow)

      if (click) {
        click.settledAt = Date.now()
      }
    },
    failed: error => line(`${head} failed after ${elapsed()}: ${reasonOf(error)}`),
    resolved: (answering, replaced) => {
      if (!replaced && answering !== target) {
        line(`${head} did not land after ${elapsed()}: the engine answering is ${answering}'s`)
      }
    }
  }
}

/** Tests only. */
export function resetBotSwitchLogForTest(): void {
  lastClick = null
}
