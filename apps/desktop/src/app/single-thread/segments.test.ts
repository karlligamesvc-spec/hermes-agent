import { describe, expect, it } from 'vitest'

import {
  dividerDateParts,
  IDLE_SEGMENT_SECONDS,
  isRestartRequest,
  isSlashBranch,
  isSlashNew,
  lastActivitySeconds,
  localDayKey,
  relativeDay,
  segmentBoundary,
  turnDivider,
  turnDividerKey,
  turnTimeLine
} from './segments'

/** Local wall-clock time in epoch seconds (the tests run in the machine's own zone). */
const at = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime() / 1000

describe('hc-1014 when the next message opens a new segment', () => {
  it.each([
    ['no earlier message', null, at(10, 22, 9), null],
    ['two minutes later', at(10, 22, 9), at(10, 22, 9, 2), null],
    ['5 h 59 min idle, same day', at(10, 22, 8), at(10, 22, 13, 59), null],
    ['6 h idle, same day', at(10, 22, 8), at(10, 22, 14), 'idle'],
    ['across midnight, 20 minutes', at(10, 21, 23, 50), at(10, 22, 0, 10), 'day'],
    ['next morning', at(10, 21, 18), at(10, 22, 9), 'day'],
    ['a week later', at(10, 14, 18), at(10, 22, 9), 'day']
  ])('%s', (_label, last, now, expected) => {
    expect(segmentBoundary(last, now)).toBe(expected)
  })

  it('the idle rule is six hours', () => {
    expect(IDLE_SEGMENT_SECONDS).toBe(21_600)
  })

  it('reads the newest timestamp, whatever the order, and skips rows without one', () => {
    expect(lastActivitySeconds([{ timestamp: 30 }, {}, { timestamp: 50 }, { timestamp: 40 }])).toBe(50)
    expect(lastActivitySeconds([{}, { timestamp: 0 }])).toBeNull()
  })
})

describe('hc-1014 「从头来」 and /new', () => {
  it.each([
    ['从头来', true],
    ['从头来，帮我写个新脚本', true],
    ['好，从头开始吧', true],
    ['我们从头来', true],
    ['别管刚才的，换个思路', true],
    ['换个话题。', true],
    ['Start over', true],
    ['重来', false],
    ['重新开始剪这条', false],
    ['这条视频从头来一遍字幕', false],
    ['从头来一遍字幕', false],
    ['帮我从头开始写', false],
    ['', false]
  ])('%j → %j', (text, expected) => {
    expect(isRestartRequest(text)).toBe(expected)
  })

  it.each([
    ['/new', true],
    ['  /reset  ', true],
    ['/new 帮我写脚本', false],
    ['/newsletter', false]
  ])('%j is a bare /new: %j', (text, expected) => {
    expect(isSlashNew(text)).toBe(expected)
  })

  it.each([
    ['/branch', true],
    ['/fork 从第 3 条开始', true],
    ['/branches', false],
    ['帮我 /branch', false]
  ])('%j asks for a branch: %j', (text, expected) => {
    expect(isSlashBranch(text)).toBe(expected)
  })
})

describe('hc-1014 the line above a turn', () => {
  it.each([
    ['first turn', null, at(10, 21, 14), [], `date:${localDayKey(at(10, 21, 14))}`],
    ['same day, minutes apart', at(10, 21, 14), at(10, 21, 14, 5), [], ''],
    ['next day', at(10, 21, 14), at(10, 22, 8), [], `date:${localDayKey(at(10, 22, 8))}`],
    ['6 h idle on one day', at(10, 22, 8), at(10, 22, 15), [], 'segment'],
    ['「从头来」 within an hour', at(10, 22, 8), at(10, 22, 8, 30), [at(10, 22, 8, 29)], 'segment'],
    ['a segment start before the previous turn does not count', at(10, 22, 8), at(10, 22, 8, 30), [at(10, 22, 7)], ''],
    ['no timestamp on the turn', at(10, 22, 8), null, [], '']
  ])('%s', (_label, prev, now, starts, expected) => {
    expect(turnDividerKey(turnDivider(prev, now, starts))).toBe(expected)
  })

  it('names the day, with the year only when it is not this one', () => {
    expect(dividerDateParts('date:2026-10-22', 2026)).toEqual({ day: 22, month: 10, weekday: 4, year: null })
    expect(dividerDateParts('date:2025-12-31', 2026)).toEqual({ day: 31, month: 12, weekday: 3, year: 2025 })
    expect(dividerDateParts('segment', 2026)).toBeNull()
  })
})

describe('hc-1059 the time line under a divider', () => {
  const NOW = at(10, 26, 16)

  it.each([
    ['earlier today', at(10, 26, 0, 5), 'today'],
    ['yesterday, just before midnight', at(10, 25, 23, 59), 'yesterday'],
    ['two days ago', at(10, 24, 23, 59), null],
    ['yesterday across a month boundary', at(10, 31, 20), 'yesterday', at(11, 1, 9)]
  ] as const)('%s', (_label, when, expected, now = NOW) => {
    expect(relativeDay(when, now)).toBe(expected)
  })

  it.each([
    [
      'first turn today: 「今天」, standing in for the date',
      null,
      at(10, 26, 14, 20),
      [],
      { at: at(10, 26, 14, 20), day: 'today' }
    ],
    ['first turn yesterday: 「昨天」', null, at(10, 25, 14, 52), [], { at: at(10, 25, 14, 52), day: 'yesterday' }],
    [
      'first turn last week: the date stays, the time goes under it',
      null,
      at(10, 20, 14),
      [],
      { at: at(10, 20, 14), day: null }
    ],
    [
      "a later day: the time under that day's date",
      at(10, 25, 14),
      at(10, 26, 9, 10),
      [],
      { at: at(10, 26, 9, 10), day: null }
    ],
    [
      'a new segment: the time under 「新的一段」',
      at(10, 26, 8),
      at(10, 26, 14, 5),
      [],
      { at: at(10, 26, 14, 5), day: null }
    ],
    ['minutes later on the same day: no line', at(10, 26, 14, 20), at(10, 26, 14, 40), [], null],
    ['no timestamp on the turn', at(10, 26, 8), null, [], null]
  ])('%s', (_label, prev, when, starts, expected) => {
    expect(turnTimeLine(prev, when, starts, NOW)).toEqual(expected)
  })
})
