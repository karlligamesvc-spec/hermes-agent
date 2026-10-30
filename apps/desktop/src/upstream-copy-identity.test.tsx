// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { setRuntimeI18nLocale } from '@/i18n'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { seedShellState } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'
import { failedRepliesHtml, failedTurnHistoryJson } from './__identity__/upstream-copy/render'

/**
 * hc-1116 identity guard (hard rule 11) for the engine's failure wording.
 *
 * The goldens under `__identity__/upstream-copy/` were recorded on fork main
 * before hc-1116, with the same harness (render.tsx): replies that failed live
 * (the error card) and a transcript closed by the engine's failed-turn rows.
 *
 * - single_thread off, and single_thread on in developer mode: byte-identical.
 * - single-thread product mode: the change, pinned by
 *   assistant-error-message.test.tsx and failed-turn.test.ts, not here.
 */

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/upstream-copy'

afterAll(restoreRecordingTimeZone)

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
  localStorage.clear()
})

describe.each([
  ['single_thread off', 'off', false, 'product'],
  ['single_thread on, developer mode', 'developer', true, 'technical']
] as const)('%s', (_label, prefix, singleThread, toolView) => {
  beforeEach(() => {
    seedShellState()
    setSingleThreadFlagForTest(singleThread)
    setToolViewMode(toolView)
    setRuntimeI18nLocale('zh')
  })

  it('replies that failed live: the error card prints the engine’s text', async () => {
    await expect(await failedRepliesHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-failed-replies.html`)
  })

  it('a reopened transcript keeps the engine’s failed-turn rows', async () => {
    await expect(failedTurnHistoryJson()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-failed-turn-history.json`)
  })
})
