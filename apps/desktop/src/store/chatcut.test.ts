import { afterEach, describe, expect, it, vi } from 'vitest'

import { $chatcutFlag, chatcutSwitchFrom, readChatcutFlag, setChatcutFlagForTest } from './chatcut'

afterEach(() => {
  setChatcutFlagForTest(false)
  vi.unstubAllGlobals()
})

describe('the ChatCut switch', () => {
  it.each([
    ['nothing', null, false],
    ['no flag', { payload: { desktop_features: {} } }, false],
    ['false', { payload: { desktop_features: { chatcut: false } } }, false],
    ['a string', { payload: { desktop_features: { chatcut: 'true' } } }, false],
    ['a top-level key', { payload: { chatcut: true } }, false],
    ['the platform', { payload: { desktop_features: { chatcut: true } } }, true],
    ['this install on', { installSwitches: { chatcut: true }, payload: null }, true],
    [
      'this install off over the platform',
      { installSwitches: { chatcut: false }, payload: { desktop_features: { chatcut: true } } },
      false
    ]
  ])('%s', (_label, state, on) => {
    expect(chatcutSwitchFrom(state as never)).toBe(on)
  })

  it('reads through main, and a broken bridge keeps what it had', async () => {
    const get = vi.fn().mockResolvedValue({ payload: { desktop_features: { chatcut: true } } })

    vi.stubGlobal('hermesDesktop', { clientConfig: { get } })
    window.hermesDesktop = { clientConfig: { get } } as never

    await expect(readChatcutFlag()).resolves.toBe(true)
    expect($chatcutFlag.get()).toBe(true)

    get.mockRejectedValue(new Error('no bridge'))
    await expect(readChatcutFlag()).resolves.toBe(true)
  })
})
