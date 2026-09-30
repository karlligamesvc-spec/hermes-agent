import { cleanStores, STORE_UNMOUNT_DELAY } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $workflowDomainRevision, WORKFLOW_DOMAIN_POLL_INTERVAL_MS } from './read-revision'

class WindowChannel extends EventTarget {
  static current: WindowChannel
  constructor() {super(); WindowChannel.current = this}
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('BroadcastChannel', WindowChannel)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanStores($workflowDomainRevision)
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Workflow refresh subscriptions retain their mounting realm', () => {
  it('clears its timer and listeners after delayed deactivation when browser globals disappeared', () => {
    const ownerWindow = window
    const ownerDocument = document
    const addWindow = vi.spyOn(ownerWindow, 'addEventListener')
    const addDocument = vi.spyOn(ownerDocument, 'addEventListener')
    const removeWindow = vi.spyOn(ownerWindow, 'removeEventListener')
    const removeDocument = vi.spyOn(ownerDocument, 'removeEventListener')
    const schedule = vi.spyOn(ownerWindow, 'setInterval')
    const stop = vi.spyOn(ownerWindow, 'clearInterval')
    const off = $workflowDomainRevision.listen(() => {})
    const timer = schedule.mock.results[0]!.value
    const focus = addWindow.mock.calls.find(([event]) => event === 'focus')![1]
    const blur = addWindow.mock.calls.find(([event]) => event === 'blur')![1]
    const visibility = addDocument.mock.calls.find(([event]) => event === 'visibilitychange')![1]

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), WORKFLOW_DOMAIN_POLL_INTERVAL_MS)
    off()
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('document', undefined)
    vi.advanceTimersByTime(STORE_UNMOUNT_DELAY - 1)
    expect(removeWindow).not.toHaveBeenCalled()
    expect(() => vi.advanceTimersByTime(1)).not.toThrow()
    expect(stop).toHaveBeenCalledWith(timer)
    expect(removeWindow).toHaveBeenCalledWith('focus', focus)
    expect(removeWindow).toHaveBeenCalledWith('blur', blur)
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', visibility)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads focus, schedules timers and removes listeners only in the original realm', () => {
    const ownerWindow = window
    const ownerDocument = document
    const focused = vi.mocked(ownerDocument.hasFocus)
    const schedule = vi.spyOn(ownerWindow, 'setInterval')
    const removeWindow = vi.spyOn(ownerWindow, 'removeEventListener')
    const removeDocument = vi.spyOn(ownerDocument, 'removeEventListener')
    const off = $workflowDomainRevision.listen(() => {})
    const nextWindow = { setInterval: vi.fn(), clearInterval: vi.fn(), removeEventListener: vi.fn() }
    const nextDocument = { visibilityState: 'visible', hasFocus: vi.fn(() => true), removeEventListener: vi.fn() }

    focused.mockReturnValue(false)
    ownerWindow.dispatchEvent(new Event('blur'))
    const revision = $workflowDomainRevision.get()

    vi.stubGlobal('window', nextWindow)
    vi.stubGlobal('document', nextDocument)
    ownerWindow.dispatchEvent(new Event('focus'))
    expect($workflowDomainRevision.get()).toBe(revision)
    expect(nextDocument.hasFocus).not.toHaveBeenCalled()
    focused.mockReturnValue(true)
    ownerWindow.dispatchEvent(new Event('focus'))
    expect($workflowDomainRevision.get()).toBe(revision + 1)
    expect(schedule).toHaveBeenCalledTimes(2)
    nextDocument.visibilityState = 'hidden'
    nextDocument.hasFocus.mockReturnValue(false)
    WindowChannel.current.dispatchEvent(new MessageEvent('message', { data: 1 }))
    expect($workflowDomainRevision.get()).toBe(revision + 2)
    off()
    vi.advanceTimersByTime(STORE_UNMOUNT_DELAY)
    expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function))
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(nextWindow.setInterval).not.toHaveBeenCalled()
    expect(nextWindow.clearInterval).not.toHaveBeenCalled()
    expect(nextWindow.removeEventListener).not.toHaveBeenCalled()
    expect(nextDocument.removeEventListener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
