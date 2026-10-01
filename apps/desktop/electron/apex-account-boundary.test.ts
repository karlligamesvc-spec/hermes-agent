import { expect, it } from 'vitest'

import { analysisAccountBoundary, canApplyManagedRenewal } from './apex-account-boundary'

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const token = (sub: string, generation: number) => `fixture.${Buffer.from(JSON.stringify({ sub, generation })).toString('base64url')}.test`

it('only renews the exact still-current credential for the same account', () => {
  const original = token(owner, 1)
  const renewed = token(owner, 2)

  for (const [current, request, next, expected] of [
    [original, original, renewed, true],
    [original, original, original, false],
    ['', original, renewed, false],
    [token(other, 1), original, renewed, false],
    [renewed, original, token(owner, 3), false],
    [original, original, token(other, 2), false],
    [original, '', renewed, false],
    [original, original, 'not-a-jwt', false],
    ['fixture.e30.test', 'fixture.e30.test', renewed, false]
  ] as const) { expect(canApplyManagedRenewal(current, request, next)).toBe(expected) }
})

it('keeps pending reads and writes bound to the initiating account, including rejected requests', async () => {
  let current: string | null = owner
  const boundary = analysisAccountBoundary(owner, () => current)
  expect(await boundary.run(async () => 'current account data')).toBe('current account data')

  for (const next of [other, null]) {
    for (const failed of [false, true]) {
      current = owner
      let finish!: () => void

      const pending = boundary.run(async () => {
        await new Promise<void>(resolve => { finish = resolve })

        if (failed) {throw new Error('old account network error')}

        return 'old account private content'
      })

      current = next
      finish()
      await expect(pending).rejects.toThrow('analysis_account_changed')
    }
  }

  let dispatched = false
  await expect(boundary.run(async () => { dispatched = true })).rejects.toThrow('analysis_account_changed')
  expect(dispatched).toBe(false)
  current = owner
  await expect(boundary.run(async () => { throw new Error('offline') })).rejects.toThrow('offline')
})
