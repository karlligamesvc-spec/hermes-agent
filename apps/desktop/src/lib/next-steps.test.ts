import { describe, expect, it } from 'vitest'

import { createNextStepsSpeechFilter, NEXT_STEPS_PROTOCOL, parseNextSteps, stripNextStepBlocks } from './next-steps'
import fixtures from './next-steps.fixtures.json'

interface FixtureCase {
  block: { failed: null | string; options: [string, string][] } | null
  id: string
  text: string
  visible: string
}

const CASES = fixtures.cases as FixtureCase[]

const asFixture = (block: ReturnType<typeof parseNextSteps>['block']) =>
  block && { failed: block.failed, options: block.options.map(option => [option.label, option.message]) }

describe('parseNextSteps — the shared apex-next/1 fixture (same answers as the apex-nodes plugin)', () => {
  it('is the protocol the fixture describes', () => {
    expect(fixtures.protocol).toBe(NEXT_STEPS_PROTOCOL)
  })

  it.each(CASES.map(item => [item.id, item] as const))('%s', (_id, item) => {
    const parsed = parseNextSteps(item.text)

    expect(parsed.visible).toBe(item.visible)
    expect(asFixture(parsed.block)).toEqual(item.block)
    expect(stripNextStepBlocks(item.text)).toBe(item.visible)
  })
})

const REPLY = [
  '给你 5 个选题：',
  '1. 收纳避坑',
  '',
  '<!-- apex:next',
  '存进选题库 | 把这 5 个选题存进我的选题库',
  '写成脚本 | 把第 1 个选题写成 60 秒口播脚本',
  '-->'
].join('\n')

function speak(deltas: string[]): string {
  const filter = createNextStepsSpeechFilter()

  return deltas.map(delta => filter.push(delta)).join('') + filter.flush()
}

describe('createNextStepsSpeechFilter — streamed speech never reads the block out', () => {
  it.each([1, 2, 3, 5, 8, 13])('drops the block whatever the delta size (%i)', size => {
    const deltas = Array.from({ length: Math.ceil(REPLY.length / size) }, (_, index) =>
      REPLY.slice(index * size, (index + 1) * size)
    )

    const spoken = speak(deltas)

    expect(spoken.trim()).toBe('给你 5 个选题：\n1. 收纳避坑')
    expect(spoken).not.toContain('apex')
    expect(spoken).not.toContain('存进选题库')
  })

  it('never lets block text out before the block closes', () => {
    const filter = createNextStepsSpeechFilter()
    const released: string[] = []

    for (const char of REPLY) {
      released.push(filter.push(char))
    }

    expect(released.join('')).not.toContain('<')
    expect(released.join('')).not.toContain('存进')
  })

  it('drops a block the reply never finished', () => {
    expect(speak(['正文。', '<!-- apex:next\n写成', '脚本 | 把它'])).toBe('正文。')
  })

  it('releases a "<" that turned out not to start a block', () => {
    expect(speak(['a <', ' b'])).toBe('a < b')
    expect(speak(['价格 <', '!-- 备注 --> 结束'])).toBe('价格 <!-- 备注 --> 结束')
    expect(speak(['结尾 <'])).toBe('结尾 <')
  })
})
