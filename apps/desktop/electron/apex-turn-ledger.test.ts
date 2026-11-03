import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, test } from 'vitest'

import {
  createTurnLedger,
  registerTurnLedger,
  sessionIdsOf,
  TURN_LEDGER_FILE,
  type TurnLedgerStore,
  turnLedgerStoreIn
} from './apex-turn-ledger'

function memoryStore(initial: null | string = null): TurnLedgerStore & { text: null | string } {
  const store = {
    text: initial,
    read: () => store.text,
    write: (text: string) => {
      store.text = text
    }
  }

  return store
}

const listed = (store: { text: null | string }) => (JSON.parse(store.text ?? '{"ids":[]}').ids as string[]).sort()

/** The next launch: a fresh ledger over what this one left on disk. */
const nextLaunch = (store: TurnLedgerStore) => createTurnLedger(store).interrupted().sort()

describe('the ledger of turns a quit cuts off', () => {
  test('a turn a live window sees end leaves the ledger', () => {
    const store = memoryStore()
    const ledger = createTurnLedger(store)

    ledger.report(1, ['a', 'b'])
    assert.deepEqual(listed(store), ['a', 'b'])

    ledger.report(1, ['b'])
    assert.deepEqual(listed(store), ['b'])
    assert.deepEqual(nextLaunch(store), ['b'])
  })

  test('quitting freezes it: the turns the teardown then stops stay listed for the next launch', () => {
    const store = memoryStore()
    const ledger = createTurnLedger(store)

    ledger.report(1, ['clip'])
    ledger.freeze()
    ledger.report(1, [])
    ledger.windowGone(1)

    assert.deepEqual(nextLaunch(store), ['clip'])
  })

  test('a window closed mid-turn (macOS keeps the app) leaves its turn listed', () => {
    const store = memoryStore()
    const ledger = createTurnLedger(store)

    ledger.report(1, ['clip'])
    ledger.windowGone(1)
    ledger.report(2, [])

    assert.deepEqual(nextLaunch(store), ['clip'])
  })

  test('a turn two windows show leaves only when neither runs it', () => {
    const store = memoryStore()
    const ledger = createTurnLedger(store)

    ledger.report(1, ['a'])
    ledger.report(2, ['a'])
    ledger.report(1, [])
    assert.deepEqual(listed(store), ['a'])

    ledger.report(2, [])
    assert.deepEqual(listed(store), [])
  })

  test('the previous run stays listed until the renderer settles it or a new turn there ends', () => {
    const store = memoryStore(JSON.stringify({ ids: ['old', 'other'] }))
    const ledger = createTurnLedger(store)

    assert.deepEqual(ledger.interrupted().sort(), ['old', 'other'])

    ledger.report(1, ['fresh'])
    assert.deepEqual(listed(store), ['fresh', 'old', 'other'])

    ledger.settle(['other'])
    ledger.report(1, ['old'])
    ledger.report(1, [])
    assert.deepEqual(listed(store), [])
  })

  test('an unreadable or foreign file reads as empty', () => {
    for (const text of [null, '', '{', '[]', '{"ids":"a"}', '{"ids":[1,null," ","x"]}']) {
      assert.deepEqual(createTurnLedger(memoryStore(text)).interrupted(), text?.includes('"x"') ? ['x'] : [])
    }
  })

  test.each([
    [{ count: 1, titles: ['剪辑'], ids: ['s1'] }, ['s1']],
    [{ count: 1, titles: ['剪辑'] }, []],
    [{ ids: ['s1', 2, '', null] }, ['s1']],
    [null, []]
  ])('sessionIdsOf(%j)', (payload, expected) => {
    assert.deepEqual(sessionIdsOf(payload), expected)
  })
})

describe('wiring', () => {
  function fakeIpc() {
    const on = new Map<string, (event: any, payload: unknown) => void>()
    const handle = new Map<string, () => unknown>()

    return {
      handle: (channel: string, listener: () => unknown) => handle.set(channel, listener),
      handlers: handle,
      listeners: on,
      on: (channel: string, listener: (event: any, payload: unknown) => void) => on.set(channel, listener)
    }
  }

  function sender(id: number) {
    const destroyed: Array<() => void> = []

    return { destroy: () => destroyed.forEach(fn => fn()), id, once: (_: string, fn: () => void) => destroyed.push(fn) }
  }

  test('reports, a destroyed window, the quit signal, the read and the settle', () => {
    const ipc = fakeIpc()
    const store = memoryStore(JSON.stringify({ ids: ['last-run'] }))
    const quit = new AbortController()
    registerTurnLedger(ipc, store, quit.signal)

    const window = sender(7)
    const report = ipc.listeners.get('hermes:active-work')!

    report({ sender: window }, { count: 1, ids: ['clip'], titles: [] })
    window.destroy()
    assert.deepEqual(listed(store), ['clip', 'last-run'])

    const other = sender(8)
    report({ sender: other }, { count: 1, ids: ['apex'], titles: [] })
    quit.abort()
    report({ sender: other }, { count: 0, ids: [], titles: [] })
    assert.deepEqual(listed(store), ['apex', 'clip', 'last-run'])

    assert.deepEqual(ipc.handlers.get('hermes:interrupted-turns')!(), ['last-run'])
    ipc.listeners.get('hermes:interrupted-turns:settle')!({}, ['last-run'])
    assert.deepEqual(ipc.handlers.get('hermes:interrupted-turns')!(), [])
  })

  test('the file store writes atomically into userData', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc1100-ledger-'))

    try {
      const store = turnLedgerStoreIn(() => dir)

      assert.equal(store.read(), null)
      store.write('{"ids":["a"]}')
      assert.equal(fs.readFileSync(path.join(dir, TURN_LEDGER_FILE), 'utf8'), '{"ids":["a"]}')
      assert.deepEqual(fs.readdirSync(dir), [TURN_LEDGER_FILE])
    } finally {
      fs.rmSync(dir, { force: true, recursive: true })
    }
  })
})
