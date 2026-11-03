import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  HANDOFF_PLAN_MAX_LEGS,
  HANDOFF_PLAN_PROTOCOL,
  type HandoffPlanLeg,
  parseHandoffPlan,
  relayLegs,
  stripPlanBlocks
} from './handoff-plan'

interface PlanCase {
  name: string
  text: string
  legs: HandoffPlanLeg[] | null
  over_cap: boolean
  visible: string
}

interface PlanCases {
  protocol: string
  max_legs: number
  prompt_template: string
  prompt_template_legs: HandoffPlanLeg[]
  cases: PlanCase[]
}

/** hc-1091: the engine's prompt rule and this reader share one file (硬规则 12). */
const CASES = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'shared', 'apex-handoff-plan-cases.json'), 'utf8')
) as PlanCases

describe('apex-plan/1, the shared cases', () => {
  it('names the protocol and the cap both sides read', () => {
    expect(CASES.protocol).toBe(HANDOFF_PLAN_PROTOCOL)
    expect(CASES.max_legs).toBe(HANDOFF_PLAN_MAX_LEGS)
  })

  it('reads the template the engine’s rule prints as 「已有」 and two batons', () => {
    const { block, visible } = parseHandoffPlan(CASES.prompt_template)

    expect(block).toEqual({ legs: CASES.prompt_template_legs, overCap: false })
    expect(visible).toBe('')
  })

  it.each(CASES.cases.map(entry => [entry.name, entry] as const))('%s', (_name, entry) => {
    const { block, visible } = parseHandoffPlan(entry.text)

    expect(block).toEqual(entry.legs ? { legs: entry.legs, overCap: entry.over_cap } : null)
    expect(visible).toBe(entry.visible)
    expect(stripPlanBlocks(entry.text)).toBe(entry.visible)
  })
})

describe('relayLegs', () => {
  it('keeps the batons another assistant runs, in order', () => {
    const legs = CASES.cases[0]!.legs!

    expect(relayLegs(legs).map(leg => leg.to)).toEqual(['小红书文案', '剪辑助手'])
  })
})
