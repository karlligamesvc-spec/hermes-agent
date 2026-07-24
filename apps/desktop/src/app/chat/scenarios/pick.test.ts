import { afterEach, describe, expect, it, vi } from 'vitest'

import { onComposerInsertRequest } from '../composer/focus'

import type { ScenarioItem } from './catalog'
import { insertScenarioPrefill } from './pick'
import { onScenarioSessionRequest } from './scenario-session-bridge'

const item = (over: Partial<ScenarioItem>): ScenarioItem => ({
  key: 'k',
  name: 'name',
  status: 'live',
  param_required: false,
  ...over
})

// requestComposerInsert (../composer/focus) defers its dispatch to a real
// macrotask (see its own docstring); a short real-timer wait lets it land
// without fighting fake timers over an unrelated internal.
const flushMacrotask = () => new Promise(resolve => setTimeout(resolve, 10))

describe('insertScenarioPrefill', () => {
  const unsubscribers: Array<() => void> = []

  afterEach(() => {
    while (unsubscribers.length) {
      unsubscribers.pop()?.()
    }
  })

  it('requests a scenario session named after the catalog item, for a live pick', () => {
    const onSession = vi.fn()

    unsubscribers.push(onScenarioSessionRequest(onSession))

    const inserted = insertScenarioPrefill(item({ key: 'single_transcribe', name: '拆一条视频', param_required: true }))

    expect(inserted).toBe(true)
    expect(onSession).toHaveBeenCalledTimes(1)
    expect(onSession).toHaveBeenCalledWith('拆一条视频')
  })

  it('inserts the mapped 口令 inline into the main composer', async () => {
    const onInsert = vi.fn()

    unsubscribers.push(onComposerInsertRequest(onInsert))

    insertScenarioPrefill(item({ key: 'trending', name: '热榜' }))
    await flushMacrotask()

    expect(onInsert).toHaveBeenCalledWith({ mode: 'inline', target: 'main', text: '抖音热榜' })
  })

  it('requests a session even when the scenario name is blank (name-missing degradation is the subscriber\'s job)', () => {
    const onSession = vi.fn()

    unsubscribers.push(onScenarioSessionRequest(onSession))

    insertScenarioPrefill(item({ key: 'brand_new', name: '', param_required: false }))

    expect(onSession).toHaveBeenCalledWith('')
  })

  it('is a no-op for a coming-soon scenario: no session request, no prefill, returns false', async () => {
    const onSession = vi.fn()
    const onInsert = vi.fn()

    unsubscribers.push(onScenarioSessionRequest(onSession), onComposerInsertRequest(onInsert))

    const inserted = insertScenarioPrefill(item({ status: 'coming_soon' }))
    await flushMacrotask()

    expect(inserted).toBe(false)
    expect(onSession).not.toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('the shelf and the ✦ menu are the same call — one function, so both entries behave identically', () => {
    const onSession = vi.fn()

    unsubscribers.push(onScenarioSessionRequest(onSession))

    const scenario = item({ key: 'comments', name: '看评论区' })

    // Simulates entry ① (zero-state card) then entry ② (✦ menu row): both
    // literally call insertScenarioPrefill, so there is no separate codepath
    // to diverge — this just documents/locks that invariant.
    insertScenarioPrefill(scenario)
    insertScenarioPrefill(scenario)

    expect(onSession).toHaveBeenNthCalledWith(1, '看评论区')
    expect(onSession).toHaveBeenNthCalledWith(2, '看评论区')
  })
})
