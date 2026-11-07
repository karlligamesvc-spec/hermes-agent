import { afterEach, describe, expect, it } from 'vitest'

import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { setToolViewMode } from '@/store/tool-view'

import { composerDisabledWhileConnecting, composerHiddenWhileLoading } from './composer-while-loading'

afterEach(() => {
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

describe('hc-1146 the composer while a conversation’s history loads', () => {
  it.each([
    ['both switches off', false, false, 'product', true],
    ['single-thread alone', true, false, 'product', true],
    ['developer mode with both on', true, true, 'technical', true],
    ['several assistants', true, true, 'product', false]
  ] as const)('with %s, hidden while loading: %s', (_label, singleThread, multiBot, toolView, hidden) => {
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)
    setMultiBotFlagForTest(multiBot)

    expect(composerHiddenWhileLoading(true)).toBe(hidden)
    // Not loading, it is never what hides the composer.
    expect(composerHiddenWhileLoading(false)).toBe(false)
  })
})

describe('hc-1146 the composer while the gateway is not open (the engine starting, a reconnect)', () => {
  it.each([
    ['both switches off', false, false, 'product', true],
    ['single-thread alone', true, false, 'product', true],
    ['developer mode with both on', true, true, 'technical', true],
    ['several assistants: a send waits for the gateway instead', true, true, 'product', false]
  ] as const)('with %s, sends refused while connecting: %s', (_label, singleThread, multiBot, toolView, disabled) => {
    setToolViewMode(toolView)
    setSingleThreadFlagForTest(singleThread)
    setMultiBotFlagForTest(multiBot)

    expect(composerDisabledWhileConnecting(false)).toBe(disabled)
    // Open, it never refuses.
    expect(composerDisabledWhileConnecting(true)).toBe(false)
  })
})
