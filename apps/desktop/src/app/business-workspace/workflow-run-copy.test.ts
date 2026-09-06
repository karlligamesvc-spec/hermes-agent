import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

describe('workflow Run lifecycle copy', () => {
  it.each([
    ['zh', zh],
    ['zh-Hant', zhHant],
    ['en', en],
    ['ja', ja]
  ])('keeps queue, start, tool and attempt copy useful in %s', (_locale, translations) => {
    const copy = translations.businessWorkspace.workflowDomain.run
    const generic = copy.eventSummary('run.waiting_review')
    const queued = copy.eventSummary('run.queued')
    const running = copy.eventSummary('run.running')
    const tool = copy.eventSummary('tool.result')
    const attempt = copy.attemptDescription(1, 2)

    expect(queued).not.toBe(generic)
    expect(running).not.toBe(generic)
    expect(queued).not.toBe(running)
    expect(tool).toMatch(/APEX.*Hermes/i)
    expect(attempt).not.toBe('1/2')
    expect(attempt).toMatch(/1/)
    expect(attempt).toMatch(/2/)
  })
})
