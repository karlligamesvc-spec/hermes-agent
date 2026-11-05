import { afterEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import {
  COMPOSER_AREAS,
  COMPOSER_SEND_TAKEN,
  composerDraftFor,
  type ComposerMiddleware,
  runComposerMiddleware,
  submitThroughComposerMiddleware
} from './contrib'

const disposers: Array<() => void> = []

function addMiddleware(id: string, handler: ComposerMiddleware['handler'], order?: number) {
  disposers.push(
    registry.register({ id, area: COMPOSER_AREAS.middleware, order, data: { handler } satisfies ComposerMiddleware })
  )
}

afterEach(() => {
  disposers.splice(0).forEach(d => d())
})

describe('runComposerMiddleware', () => {
  it('passes the draft through untouched when nothing is registered', async () => {
    const draft = { text: 'hello' }

    expect(await runComposerMiddleware(draft)).toBe(draft)
  })

  it('chains rewrites in registry order', async () => {
    addMiddleware('b', d => ({ ...d, text: `${d.text}b` }), 20)
    addMiddleware('a', d => ({ ...d, text: `${d.text}a` }), 10)

    expect(await runComposerMiddleware({ text: 'x' })).toEqual({ text: 'xab' })
  })

  it('cancels the send when a handler returns null', async () => {
    addMiddleware('gate', () => null)
    addMiddleware('later', d => ({ ...d, text: 'never' }), 99)

    expect(await runComposerMiddleware({ text: 'x' })).toBeNull()
  })

  it('treats a throwing handler as pass-through', async () => {
    addMiddleware('boom', () => {
      throw new Error('broken plugin')
    })
    addMiddleware('after', d => ({ ...d, text: `${d.text}!` }), 99)

    expect(await runComposerMiddleware({ text: 'x' })).toEqual({ text: 'x!' })
  })

  it('supports async handlers', async () => {
    addMiddleware('async', async d => ({ ...d, text: d.text.toUpperCase() }))

    expect(await runComposerMiddleware({ text: 'quiet' })).toEqual({ text: 'QUIET' })
  })
})

describe('hc-1146 a middleware that takes a send over', () => {
  it('stops the chain: the composer clears, nothing after it runs', async () => {
    const later: string[] = []

    addMiddleware('take', () => COMPOSER_SEND_TAKEN, 10)
    addMiddleware('later', d => (later.push(d.text), d), 99)

    expect(await runComposerMiddleware({ text: 'x' })).toBe(COMPOSER_SEND_TAKEN)
    expect(later).toEqual([])
  })

  it('cannot take a bound send: that is a cancel', async () => {
    addMiddleware('take', () => COMPOSER_SEND_TAKEN)

    expect(await runComposerMiddleware({ bound: true, text: 'x' })).toBeNull()
  })

  it.each([
    ['typed (no options)', undefined, false],
    ['typed with its composer scope and attachments', { attachments: [], composerScope: 'thread-root' }, false],
    ['an option left undefined', { displayKind: undefined }, false],
    ['machine text', { displayKind: 'hidden' }, true],
    ['a queued entry', { fromQueue: true, sessionId: 'rt', storedSessionId: 'thread-root' }, true],
    ['a voice-live turn', { surface: 'voice-live', voiceContext: '…' }, true],
    ['a /skill with display text', { displayText: '/work fix it' }, true]
  ] as const)('%s → bound: %s', (_label, options, bound) => {
    const draft = composerDraftFor('words', options as never)

    expect(draft.text).toBe('words')
    expect(draft.bound === true).toBe(bound)
    expect('bound' in draft).toBe(bound)
  })
})

describe('hc-1146 the composer’s send through the chain (ChatBar onSubmit)', () => {
  const appSubmit = () => {
    const calls: [string, unknown][] = []

    return {
      calls,
      submit: async (text: string, options: unknown) => {
        calls.push([text, options])

        return true
      }
    }
  }

  it('passes the chain’s draft on, with the send’s own options', async () => {
    addMiddleware('rewrite', d => ({ ...d, text: `${d.text}!` }))
    const { calls, submit } = appSubmit()

    expect(
      await submitThroughComposerMiddleware('hi', { composerScope: 'root', displayText: '/x' } as never, submit)
    ).toBe(true)
    expect(calls).toEqual([['hi!', { attachments: undefined, composerScope: 'root', displayText: '/x' }]])
  })

  it('a cancelled send is not accepted; the app’s submit does not run', async () => {
    addMiddleware('gate', () => null)
    const { calls, submit } = appSubmit()

    expect(await submitThroughComposerMiddleware('hi', undefined, submit)).toBe(false)
    expect(calls).toEqual([])
  })

  it('a plain send taken over is accepted (the composer clears) without the app’s submit', async () => {
    addMiddleware('take', () => COMPOSER_SEND_TAKEN)
    const { calls, submit } = appSubmit()

    expect(await submitThroughComposerMiddleware('hi', { attachments: [], composerScope: 'root' }, submit)).toBe(true)
    expect(calls).toEqual([])
  })

  it('a queued entry cannot be taken over: that is a cancel, so the queue keeps it', async () => {
    addMiddleware('take', () => COMPOSER_SEND_TAKEN)
    const { calls, submit } = appSubmit()

    expect(
      await submitThroughComposerMiddleware('hi', { fromQueue: true, storedSessionId: 'root' } as never, submit)
    ).toBe(false)
    expect(calls).toEqual([])
  })
})
