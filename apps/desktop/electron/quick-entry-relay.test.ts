import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createQuickEntryRelay,
  QUICK_ENTRY_ACK_TIMEOUT_MS,
  QUICK_ENTRY_RECEIPT_TIMEOUT_MS,
  quickEntryCaptureOf
} from './quick-entry-relay'

// hc-1113: in 0.17.67 a line typed into Quick Entry reached no assistant and
// left nothing in desktop.log. Every line now ends in one log line, and one
// that did not land goes back into the quick window with why.

const LINE = '标题写 3 个，别带表情'
const EDITOR = { name: '剪辑助手', profile: 'apex-bot-2' }

function contents() {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    send: vi.fn()
  }
}

function setup(options: { primary?: boolean } = {}) {
  const primary = contents()
  const quick = contents()
  const log = vi.fn()
  const showQuick = vi.fn()
  const hideQuick = vi.fn()

  const relay = createQuickEntryRelay({
    hideQuick,
    log,
    primary: () => (options.primary === false ? null : primary),
    quick: () => quick,
    showQuick
  })

  const sentToPrimary = () => primary.send.mock.calls.filter(([channel]) => channel === 'hermes:quick-entry:submit')
  const lastId = () => (sentToPrimary().at(-1)?.[1] as { id: string }).id
  const lines = () => log.mock.calls.map(([line]) => String(line))

  // What the quick window gets on its next summon.
  const nextShown = () => {
    relay.shown(quick)

    return quick.send.mock.calls.at(-1)
  }

  return { hideQuick, lastId, lines, nextShown, primary, quick, relay, sentToPrimary, showQuick }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('hc-1113 a Quick Entry line on its way to the main window', () => {
  it('hides the window and hands the line, its target and its assistant to the main window with an id', () => {
    const t = setup()

    t.relay.submit({ assistant: EDITOR, target: 'current', text: `  ${LINE}  ` })

    expect(t.hideQuick).toHaveBeenCalledTimes(1)
    expect(t.sentToPrimary()).toEqual([
      ['hermes:quick-entry:submit', { assistant: EDITOR, id: 'qe-1', target: 'current', text: LINE }]
    ])
  })

  it('an empty line goes nowhere and logs nothing', () => {
    const t = setup()

    t.relay.submit({ target: 'current', text: '   ' })

    expect(t.sentToPrimary()).toEqual([])
    expect(t.lines()).toEqual([])
  })

  it('delivered: one log line naming the assistant and where it went, never the text', () => {
    const t = setup()

    t.relay.submit({ assistant: EDITOR, target: 'current', text: LINE })
    t.relay.receipt({ id: t.lastId(), stage: 'accepted' })
    t.relay.receipt({ id: t.lastId(), kind: 'current', profile: 'apex-bot-2', stage: 'delivered' })
    vi.advanceTimersByTime(QUICK_ENTRY_RECEIPT_TIMEOUT_MS * 2)

    expect(t.lines()).toEqual(['[quick-entry] delivered to "apex-bot-2" (current)'])
    expect(t.showQuick).not.toHaveBeenCalled()
    expect(t.nextShown()?.[1]).toBeNull()
  })

  it.each([
    ['busy', 'a turn is still running'],
    ['switch', 'the assistant was not on hand in time'],
    ['refused', 'the app did not send it']
  ])('failed (%s): logged with why, and the line goes back into the window', (reason, detail) => {
    const t = setup()

    t.relay.submit({ assistant: EDITOR, target: 'current', text: LINE })
    t.relay.receipt({ id: t.lastId(), stage: 'accepted' })
    t.relay.receipt({ detail, id: t.lastId(), profile: 'apex-bot-2', reason, stage: 'failed' })

    expect(t.lines()).toEqual([`[quick-entry] not delivered to "apex-bot-2": ${reason} (${detail})`])
    expect(t.showQuick).toHaveBeenCalledTimes(1)
    expect(t.nextShown()).toEqual(['hermes:quick-entry:shown', { failure: { name: '剪辑助手', reason, text: LINE } }])
    // Handed back once: the next summon is a plain one.
    expect(t.nextShown()?.[1]).toBeNull()
  })

  it('the main window is closed: logged, and the line goes back into the window', () => {
    const t = setup({ primary: false })

    t.relay.submit({ target: 'current', text: LINE })

    expect(t.lines()).toEqual([
      '[quick-entry] not delivered to the chat on screen: no-window (the main window is closed)'
    ])
    expect(t.nextShown()?.[1]).toEqual({ failure: { name: null, reason: 'no-window', text: LINE } })
  })

  it('nobody in the main window takes it: after the ack wait it is a failure, not silence', () => {
    const t = setup()

    t.relay.submit({ assistant: EDITOR, target: 'current', text: LINE })
    vi.advanceTimersByTime(QUICK_ENTRY_ACK_TIMEOUT_MS - 1)
    expect(t.lines()).toEqual([])

    vi.advanceTimersByTime(1)
    expect(t.lines()).toEqual([
      `[quick-entry] not delivered to "apex-bot-2": no-answer (the main window did not take it within ${QUICK_ENTRY_ACK_TIMEOUT_MS} ms)`
    ])
    expect(t.showQuick).toHaveBeenCalledTimes(1)

    // A receipt that turns up afterwards changes nothing.
    t.relay.receipt({ id: t.lastId(), kind: 'current', stage: 'delivered' })
    expect(t.lines()).toHaveLength(1)
  })

  it('accepted but never answered: the longer wait ends as a failure too', () => {
    const t = setup()

    t.relay.submit({ target: 'current', text: LINE })
    t.relay.receipt({ id: t.lastId(), stage: 'accepted' })
    vi.advanceTimersByTime(QUICK_ENTRY_RECEIPT_TIMEOUT_MS - 1)
    expect(t.lines()).toEqual([])

    vi.advanceTimersByTime(1)
    expect(t.lines()).toEqual([
      `[quick-entry] not delivered to the chat on screen: no-answer (no answer within ${QUICK_ENTRY_RECEIPT_TIMEOUT_MS} ms)`
    ])
  })

  it('no log line ever carries what was typed', () => {
    const t = setup()

    t.relay.submit({ target: 'current', text: LINE })
    t.relay.receipt({ id: t.lastId(), reason: 'busy', stage: 'failed' })
    t.relay.submit({ target: 'current', text: LINE })
    vi.advanceTimersByTime(QUICK_ENTRY_RECEIPT_TIMEOUT_MS)

    expect(t.lines()).toHaveLength(2)
    expect(t.lines().join('\n')).not.toContain('标题')
  })
})

describe('hc-1113 the quick window hears which assistant is on screen on every summon', () => {
  it('forwards each push and hands the latest over when summoned, so a missed push cannot leave an old name', () => {
    const t = setup()

    t.relay.state({ assistant: EDITOR, connected: true, sessions: [] })
    t.relay.state({ assistant: { name: 'APEX', profile: 'default' }, connected: true, sessions: [] })

    expect(t.quick.send).toHaveBeenCalledWith('hermes:quick-entry:state', {
      assistant: { name: 'APEX', profile: 'default' },
      connected: true,
      sessions: []
    })
    expect(t.nextShown()).toEqual([
      'hermes:quick-entry:shown',
      { assistant: { name: 'APEX', profile: 'default' }, connected: true, sessions: [] }
    ])
  })

  it('a freshly loaded window gets the latest state, with a line that did not land', () => {
    const t = setup({ primary: false })
    const fresh = contents()

    t.relay.state({ connected: true, sessions: [] })
    t.relay.submit({ target: 'current', text: LINE })
    t.relay.replay(fresh)

    expect(fresh.send).toHaveBeenCalledWith('hermes:quick-entry:state', {
      connected: true,
      failure: { name: null, reason: 'no-window', text: LINE },
      sessions: []
    })
  })
})

describe('quickEntryCaptureOf', () => {
  it.each([
    ['a bare line', { text: ' hi ' }, { assistant: null, target: 'current', text: 'hi' }],
    ['a picked session', { target: 's1', text: 'hi' }, { assistant: null, target: 's1', text: 'hi' }],
    [
      'an assistant with no name',
      { assistant: { profile: 'apex-bot-2' }, text: 'hi' },
      { assistant: { name: 'apex-bot-2', profile: 'apex-bot-2' }, target: 'current', text: 'hi' }
    ],
    [
      'an assistant with no profile',
      { assistant: { name: 'x' }, text: 'hi' },
      { assistant: null, target: 'current', text: 'hi' }
    ]
  ])('%s', (_label, raw, expected) => {
    expect(quickEntryCaptureOf(raw)).toEqual(expected)
  })

  it.each([undefined, null, 'hi', {}, { text: '  ' }, { text: 3 }])('nothing to send: %j', raw => {
    expect(quickEntryCaptureOf(raw)).toBeNull()
  })
})

describe('hc-1113 main.ts routes Quick Entry through the relay', () => {
  const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')

  it.each([
    ["ipcMain.on('hermes:quick-entry:submit', (_event, payload) => quickEntryRelay.submit(payload))"],
    ["ipcMain.on('hermes:quick-entry:receipt', (_event, receipt) => quickEntryRelay.receipt(receipt))"],
    ["ipcMain.on('hermes:quick-entry:state', (_event, payload) => quickEntryRelay.state(payload))"],
    ['quickEntryRelay.shown(quickEntryWindow.webContents)'],
    ['quickEntryRelay.replay(win.webContents)']
  ])('%s', wiring => {
    expect(main.split(wiring)).toHaveLength(2)
  })

  it('sends nothing to the quick window or the main window on these channels by itself', () => {
    expect(main).not.toMatch(/send\('hermes:quick-entry:(submit|state|shown)'/)
  })

  it('preload carries the receipt to main and the handed-over state to the quick window', () => {
    const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8')
    const onShown = preload.slice(preload.indexOf('onShown: callback =>'), preload.indexOf("'hermes:quick-entry:shown', listener)"))

    expect(preload).toContain("receipt: receipt => ipcRenderer.send('hermes:quick-entry:receipt', receipt)")
    expect(onShown).toContain('const listener = (_event, payload) => callback(payload)')
  })

  it('reads a missing quick-entry.json with the one default (no enabled literal of its own)', () => {
    const read = main.slice(
      main.indexOf('function readQuickEntrySettings()'),
      main.indexOf('function writeQuickEntrySettings(')
    )

    expect(read).toContain('return sanitizeQuickEntrySettings(null)')
    expect(read).not.toMatch(/enabled\s*:/)
  })
})
