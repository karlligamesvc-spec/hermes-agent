/**
 * hc-1060 (N5): 「停一下」 stops APEX. In single-thread mode the Stop button
 * left the composer for the activity line, and what the user types or says
 * while APEX works reaches the running turn as a steer. A steer that is only a
 * stop request halts the turn instead, as the activity line's 「停」 and Esc do,
 * rather than asking the model to stop at its next step.
 *
 * Deliberately narrow, like lib/voice-stop-word.ts: the whole message must be
 * the request (optionally addressed to APEX, with sentence-final particles and
 * punctuation), so 「停一下，先把标题改了」 still goes to APEX as words.
 */

const STOP_REQUESTS: ReadonlySet<string> = new Set([
  '停',
  '停停',
  '停一下',
  '停一停',
  '停下',
  '停下来',
  '停止',
  '暂停',
  '暫停',
  '先停',
  '先停下',
  '先停一下',
  '别做了',
  '別做了',
  '先别做了',
  '先別做了',
  '不做了',
  '不用做了',
  'stop',
  'stopit',
  'pleasestop'
])

const ADDRESS = /^(?:hey)?apex/

/** Punctuation, spaces and the particles a spoken or typed request trails. */
const NOISE = /[\s.,!?;:…~，。！？；：、．～「」"'“”]+/g
const PARTICLES = /[吧啊呀哈嘛啦]+$/

export function isStopRequest(text: string): boolean {
  const bare = text.toLowerCase().replace(NOISE, '').replace(ADDRESS, '').replace(PARTICLES, '')

  return STOP_REQUESTS.has(bare)
}

type Steer = (text: string, target?: { sessionId: string; storedSessionId: string }) => Promise<boolean> | boolean

/**
 * `steer`, except that a bare stop request for this session halts it and is
 * consumed (true: the composer clears it). A steer aimed at another session
 * (a voice conversation's own target) goes through untouched.
 */
export function steerWithStopRequests(
  steer: Steer,
  sessionId: null | string | undefined,
  halt: () => Promise<void>
): Steer {
  return async (text, target) => {
    if (!isStopRequest(text) || (target && target.sessionId !== sessionId)) {
      return steer(text, target)
    }

    await halt()

    return true
  }
}
