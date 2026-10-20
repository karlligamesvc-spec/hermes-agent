import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n'

import { APEX_ROTATION_TIP_IDS, isApexAccount, rotationTips } from './apex-ui-tips'
import { TIP_CATALOG } from './catalog'

// hc-995 (Q10): the in-app UI tip rotation speaks to developers, so an APEX
// account gets only the tips listed for it (none today); everyone else keeps
// the whole catalog.

describe('which UI tips an account gets', () => {
  it.each([
    [{ enabled: true, status: 'signed-in' }, true],
    [{ enabled: true, status: 'expired' }, true],
    [{ enabled: true, status: 'signed-out' }, false],
    [{ enabled: false, status: 'signed-in' }, false]
  ] as const)('%j is an APEX account: %s', (state, expected) => {
    expect(isApexAccount(state as never)).toBe(expected)
  })

  it('an APEX account’s rotation offers none of today’s developer tips', () => {
    expect(rotationTips(TIP_CATALOG, true)).toEqual([])
    expect(APEX_ROTATION_TIP_IDS.size).toBe(0)
  })

  it('everyone else keeps the whole catalog, in order', () => {
    expect(rotationTips(TIP_CATALOG, false)).toEqual(TIP_CATALOG)
  })

  it('the tips left out are the developer-facing ones (why the list is empty)', () => {
    const developerWords = /Hermes|终端|Telegram|cron|密钥|命令|技能|工作目录/

    for (const tip of TIP_CATALOG) {
      expect(TRANSLATIONS.zh.tips.items[tip.id].text + TRANSLATIONS.zh.tips.items[tip.id].title).toMatch(developerWords)
    }
  })
})
