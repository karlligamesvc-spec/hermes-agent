import { describe, expect, it } from 'vitest'

import { PendingStartIntents } from './start-intents'

const request = { objective: 'Private business goal', starter: { id: 'template', version: 3 }, kind: 'goal' }

function storage() {
  const values = new Map<string, string>()

  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) } }
}

describe('unconfirmed Start intentions', () => {
  it('replays an owner-scoped intent across reloads, separates request semantics, and removes only confirmed attempts', async () => {
    const saved = storage()
    const firstWindow = new PendingStartIntents(saved)
    const first = await firstWindow.begin('owner-a', request)
    const reloaded = new PendingStartIntents(saved)

    expect(await reloaded.begin('owner-a', request)).toEqual(first)
    const changed = await reloaded.begin('owner-a', { ...request, objective: 'Edited goal' })

    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey)
    expect((await reloaded.begin('owner-a', { ...request, starter: { id: 'template', version: 4 } })).idempotencyKey)
      .not.toBe(first.idempotencyKey)
    expect((await reloaded.begin('owner-b', request)).idempotencyKey).not.toBe(first.idempotencyKey)
    await reloaded.confirm('owner-a', first)
    expect((await new PendingStartIntents(saved).begin('owner-a', request)).idempotencyKey).not.toBe(first.idempotencyKey)
    expect(await reloaded.begin('owner-a', { ...request, objective: 'Edited goal' })).toEqual(changed)
    expect([...saved.values.values()].join('')).not.toContain(request.objective)
    expect([...saved.values.values()].join('')).not.toContain('template')
  })

  it('keeps other-window intents when another request is added or confirmed', async () => {
    const saved = storage()
    const firstWindow = new PendingStartIntents(saved)
    const secondWindow = new PendingStartIntents(saved)
    const first = await firstWindow.begin('owner', request)
    const second = await secondWindow.begin('owner', { ...request, objective: 'Second request' })
    const third = await firstWindow.begin('owner', { ...request, objective: 'Third request' })

    await firstWindow.confirm('owner', first)
    const restarted = new PendingStartIntents(saved)

    expect(await restarted.begin('owner', { ...request, objective: 'Second request' })).toEqual(second)
    expect(await restarted.begin('owner', { ...request, objective: 'Third request' })).toEqual(third)
    const replacement = await secondWindow.begin('owner', request)

    expect(replacement.idempotencyKey).not.toBe(first.idempotencyKey)
    await firstWindow.confirm('owner', first)
    expect(await restarted.begin('owner', request)).toEqual(replacement)
  })

  it('retains an ambiguous same-request attempt after a peer confirms and begins a newer attempt', async () => {
    const saved = storage()
    const firstWindow = new PendingStartIntents(saved, 'window-a')
    const secondWindow = new PendingStartIntents(saved, 'window-b')
    const first = await firstWindow.begin('owner', request)

    expect(await secondWindow.begin('owner', request)).toEqual(first)
    await firstWindow.confirm('owner', first)
    expect(await secondWindow.begin('owner', request)).toEqual(first)
    const next = await firstWindow.begin('owner', request)

    expect(next.idempotencyKey).not.toBe(first.idempotencyKey)
    // Reloading the window with the lost reply retains its own original attempt.
    const reloadedSecond = new PendingStartIntents(saved, 'window-b')

    expect(await reloadedSecond.begin('owner', request)).toEqual(first)
    await reloadedSecond.confirm('owner', first)
    expect(await new PendingStartIntents(saved, 'window-c').begin('owner', request)).toEqual(next)
    expect(await reloadedSecond.begin('owner', request)).toEqual(next)
  })

  it('retains the same window retry identity when a writable cache becomes unavailable', async () => {
    const saved = storage()
    const unavailable = { ...saved, setItem: () => { throw new Error('Storage quota unavailable') } }
    const current = new PendingStartIntents(unavailable)
    const first = await current.begin('owner', request)

    expect(await current.begin('owner', request)).toEqual(first)
    await current.confirm('owner', first)
    expect((await current.begin('owner', request)).idempotencyKey).not.toBe(first.idempotencyKey)
    expect(saved.values.size).toBe(0)
  })

  it('retains a loaded retry key when persisting its window copy fails', async () => {
    const saved = storage()
    const first = await new PendingStartIntents(saved).begin('owner', request)
    const unavailable = { ...saved, setItem: () => { throw new Error('Storage quota unavailable') } }
    const current = new PendingStartIntents(unavailable)

    expect(await current.begin('owner', request)).toEqual(first)
    expect(await current.begin('owner', request)).toEqual(first)
  })

  it('keeps unknown-account retries in the current window without persisting them', async () => {
    const saved = storage()
    const firstWindow = new PendingStartIntents(saved)
    const first = await firstWindow.begin(null, request)

    expect(await firstWindow.begin(undefined, request)).toEqual(first)
    expect(saved.values.size).toBe(0)
    expect((await new PendingStartIntents(saved).begin(null, request)).idempotencyKey).not.toBe(first.idempotencyKey)
  })
})
