import type { ThreadMessage } from '@assistant-ui/react'

import { remixTool } from './remix-turn'

/**
 * hc-1156: one 口播精剪 task on the creator's computer — a talking-head take
 * dropped in with 「把这段口播剪干净」. The short-video-studio skill measures
 * the take's pacing, cuts the pauses and flubs, and checks the cut against the
 * plan, each a `footage_motion.py` subcommand run the way platform skills run
 * on the Desktop: `"$APEX_PYTHON" "$HERMES_HOME/skills/…/footage_motion.py" <sub> …`.
 * Times are seconds after T0.
 */

const T0 = Date.UTC(2026, 10, 5, 13, 0, 0) / 1000
const createdAt = new Date(T0 * 1000)

const SCRIPT = '"$APEX_PYTHON" "$HERMES_HOME/skills/apexnodes/short-video-studio/scripts/footage_motion.py"'
const WORK = '/Users/me/.apexnodes/cache/scratch/trim'
export const TRIM_TAKE = '/Users/me/Movies/口播第一条.mp4'

/** The four subcommands' command lines, as the skill writes them. */
export const TRIM_COMMANDS = {
  compare: `${SCRIPT} compare "${WORK}/trimmed.mp4" --recipe "${WORK}/recipe.json" --out "${WORK}/check"`,
  pacing: `${SCRIPT} pacing "${TRIM_TAKE}" --out "${WORK}/pacing.json"`,
  recipe: `${SCRIPT} recipe "${WORK}/pacing.json" --out "${WORK}/recipe.json"`,
  trim: `${SCRIPT} trim "${TRIM_TAKE}" --recipe "${WORK}/recipe.json" --out "${WORK}/trimmed.mp4"`
}

type Part = Record<string, unknown>

const span = (from: number, to: number): [number, number] => [from, to]

function term(id: string, command: string, at: [number, number] | null) {
  return remixTool(
    id,
    'terminal',
    { command, timeout: 300 },
    at ? { result: { output: '', exit_code: 0, error: null }, span: at } : {}
  )
}

const said = (text: string): Part => ({ type: 'text', text })

const SKILL = remixTool(
  'skill',
  'skill_view',
  { name: 'short-video-studio' },
  { result: { success: true, content: '短视频制作' }, span: span(2, 2.2) }
)

export const TRIM_ANSWER = '剪好了：1 分 40 秒剪到 1 分 21 秒，去掉了 7 处长停顿和 1 段说错重来的地方。'

function message(id: string, role: 'assistant' | 'user', content: Part[], running = false): ThreadMessage {
  return {
    id,
    role,
    content,
    ...(role === 'user'
      ? { attachments: [] }
      : { status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' } }),
    createdAt,
    metadata:
      role === 'user'
        ? { custom: {} }
        : { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as unknown as ThreadMessage
}

const ask = () => message('trim-ask', 'user', [said('把这段口播剪干净')])

/** The finished task: measure, decide, cut, check. */
export function trimFinishedTurn(): ThreadMessage[] {
  return [
    ask(),
    message('trim-a', 'assistant', [
      SKILL,
      term('pacing', TRIM_COMMANDS.pacing, span(3, 20)),
      term('recipe', TRIM_COMMANDS.recipe, span(21, 22)),
      term('trim', TRIM_COMMANDS.trim, span(23, 70)),
      term('compare', TRIM_COMMANDS.compare, span(71, 90)),
      said(TRIM_ANSWER)
    ])
  ]
}

/** Mid-task: the take is measured and the cut is running. */
export function trimRunningTurn(): ThreadMessage[] {
  return [
    ask(),
    message(
      'trim-a',
      'assistant',
      [
        SKILL,
        term('pacing', TRIM_COMMANDS.pacing, span(3, 20)),
        term('recipe', TRIM_COMMANDS.recipe, span(21, 22)),
        term('trim', TRIM_COMMANDS.trim, null)
      ],
      true
    )
  ]
}
