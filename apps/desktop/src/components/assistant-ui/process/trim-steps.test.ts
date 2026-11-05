import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Locale, setRuntimeI18nLocale } from '@/i18n'
import { SINGLE_THREAD_PROCESS_COPY } from '@/i18n/single-thread-process'
import { TRIM_COMMANDS } from '@/test/trim-turn'
import { englishWords } from '@/test/zh-copy'

import { plainApprovalSentence, plainStageLine, plainStep } from './plain-steps'
import { stageProgress, terminalIntent } from './step-intent'
import { buildTurnSteps, type TurnPart } from './turn-process'

// hc-1156: the 口播精剪 subcommands of short-video-studio's footage_motion.py,
// in the shapes the skill writes them on the Desktop ("$APEX_PYTHON" plus the
// installed skill path) and in the cloud (python3 plus the skill's own folder).

const SCRIPT = '"$APEX_PYTHON" "$HERMES_HOME/skills/apexnodes/short-video-studio/scripts/footage_motion.py"'
const W = '/Users/me/.apexnodes/cache/scratch/trim'

beforeEach(() => setRuntimeI18nLocale('zh'))
afterEach(() => setRuntimeI18nLocale('en'))

describe('footage_motion.py subcommands', () => {
  it.each([
    [TRIM_COMMANDS.pacing, 'pacing'],
    [TRIM_COMMANDS.trim, 'trim'],
    [TRIM_COMMANDS.compare, 'compare'],
    [TRIM_COMMANDS.recipe, 'recipe'],
    // The cloud's form, and the variable written with braces.
    ['python3 scripts/footage_motion.py trim in.mp4 --out out.mp4', 'trim'],
    [
      '${APEX_PYTHON} $HERMES_HOME/skills/apexnodes/short-video-studio/scripts/footage_motion.py pacing a.mp4',
      'pacing'
    ],
    // Inside the plumbing a command picks up on the way.
    [`mkdir -p ${W}/check && ${SCRIPT} compare ${W}/trimmed.mp4 --recipe ${W}/recipe.json 2>&1 | tail -20`, 'compare'],
    [`cd ${W} && ${SCRIPT} trim a.mp4 --out b.mp4`, 'trim'],
    [`bash -lc '${SCRIPT} pacing a.mp4'`, 'pacing'],
    // One command doing two: the cut names it, and the plan beats measuring.
    [`${SCRIPT} trim a.mp4 --out b.mp4 && ${SCRIPT} compare b.mp4`, 'trim'],
    [`${SCRIPT} pacing a.mp4 && ${SCRIPT} recipe pacing.json`, 'recipe'],
    // The script's older subcommands, now readable on the Desktop too.
    [`${SCRIPT} assemble ${W}/timeline.json --out ${W}/final.mp4`, 'render'],
    [`${SCRIPT} subtitles ${W}/timeline.json --out ${W}/subs.ass`, 'subtitles'],
    [`${SCRIPT} sheet ${W}/final.mp4 --out ${W}/sheet.jpg`, 'frames'],
    // Its footage-reading form has no subcommand: a plain script, like python3's.
    [`${SCRIPT} /Users/me/Movies/素材 --out ${W}/analysis/footage-motion`, 'program'],
    ['python3 scripts/footage_motion.py /Users/me/Movies/素材', 'program'],
    // The same words after another script are that script's business.
    [`"$APEX_PYTHON" ${W}/my_tool.py trim a.mp4`, 'program'],
    [`"$APEX_PYTHON" ${W}/build.py`, 'render'],
    // Not the Desktop's Python.
    [`"$OTHER_PYTHON" ${W}/footage_motion.py trim a.mp4`, null],
    ['echo trim', null]
  ])('%s → %s', (command, intent) => {
    expect(terminalIntent(command)).toBe(intent)
  })
})

const cmd = (id: string, command: string) =>
  ({
    args: { command },
    completedAt: 2,
    result: { exit_code: 0, output: '' },
    timestamp: 1,
    toolCallId: id,
    toolName: 'terminal',
    type: 'tool-call'
  }) as TurnPart

const TRIM_TASK: TurnPart[] = [
  cmd('p', TRIM_COMMANDS.pacing),
  cmd('r', TRIM_COMMANDS.recipe),
  cmd('t', TRIM_COMMANDS.trim),
  cmd('c', TRIM_COMMANDS.compare)
]

describe('the 口播精剪 steps in single-thread product mode', () => {
  it.each([
    ['zh', ['量节奏', '定剪法', '剪掉停顿和口误', '对照检查']],
    ['zh-hant', ['量節奏', '定剪法', '剪掉停頓和口誤', '對照檢查']],
    ['en', ['Measure pacing', 'Decide how to cut', 'Cut pauses and flubs', 'Check against references']]
  ] as const)('reads in %s', (locale: Locale, titles) => {
    setRuntimeI18nLocale(locale)

    expect(buildTurnSteps(TRIM_TASK, false, true).steps.map(step => step.copy.title)).toEqual(titles)
  })

  it('says what each is doing while it runs and what it did', () => {
    expect(
      TRIM_TASK.map(part => {
        const step = plainStep([{ args: part.args as Record<string, unknown>, toolName: 'terminal' }])!

        return [step.copy.running, step.copy.done({ calls: 1 })]
      })
    ).toEqual([
      ['正在量节奏', '量好了'],
      ['正在定剪法', '定好了'],
      ['正在剪掉停顿和口误', '剪好了'],
      ['正在对照检查', '查过了']
    ])
  })

  it('stays the computer’s generic step when the mode is off', () => {
    const { steps } = buildTurnSteps(TRIM_TASK, false)

    expect(steps.map(step => step.copy.title)).toEqual(['在电脑上处理'])
    expect(steps.some(step => 'intent' in step)).toBe(false)
  })

  it('moves the task from looking to cutting to checking', () => {
    const { steps } = buildTurnSteps(TRIM_TASK, false, true)

    expect(plainStageLine(steps.slice(0, 2))).toBeNull()
    expect(plainStageLine(steps.slice(0, 3))).toBe('已看完素材，正在剪辑')
    expect(plainStageLine(steps)).toBe('已看完素材、剪好初版，正在核对成片')
    expect(stageProgress(steps)).toEqual({ current: 'check', done: ['look', 'edit'], round: 1 })
  })

  it('counts measuring the finished cut as checking it', () => {
    const { steps } = buildTurnSteps([cmd('t', TRIM_COMMANDS.trim), cmd('p', TRIM_COMMANDS.pacing)], false, true)

    expect(stageProgress(steps)).toEqual({ current: 'check', done: ['edit'], round: 1 })
  })

  it('says what a cut waiting on approval is for', () => {
    expect(plainApprovalSentence(TRIM_COMMANDS.trim, 'script execution via -e/-c flag')).toBe(
      'APEX 想在你的电脑上运行一条命令，用来剪掉停顿和口误。你同意了才会执行，点「命令」可以看具体内容。'
    )
  })
})

describe('the new words', () => {
  // 报告第 08 节: plain words only — no tool, script or measurement names.
  it.each(['zh', 'zh-hant', 'en'] as const)('name no tool or term in %s', locale => {
    const { intents } = SINGLE_THREAD_PROCESS_COPY[locale]

    const words = (['pacing', 'trim', 'compare', 'recipe'] as const)
      .flatMap(intent => [intents[intent].running, intents[intent].title, intents[intent].done({ calls: 1 })])
      .join('\n')

    expect(words).not.toMatch(/footage|motion|\.py|ffmpeg|LUFS|APEX_PYTHON|HERMES/i)

    if (locale !== 'en') {
      expect(englishWords(words)).toEqual([])
    }
  })
})
