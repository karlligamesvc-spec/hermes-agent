/**
 * hc-1072: the relay's model listing as main reads it, and the per-key memo of
 * the tiers it grants (what the single-thread config heal caps against).
 *
 * Run with: npx vitest run electron/apex-relay-tiers.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { describe, test, vi } from 'vitest'

import {
  fetchRelayModels,
  relayModelIds,
  type RelayModelsProbe,
  type RelayNet,
  RelayTierMemo
} from './apex-relay-tiers'

// The relay's answer for an advanced account since 2026-10-26 19:49Z (Max open).
const ADVANCED = JSON.stringify({
  object: 'list',
  data: [
    { id: 'apex-flash', object: 'model', owned_by: 'deepseek' },
    { id: 'apex-max', object: 'model', owned_by: 'deepseek' },
    { id: 'apex-pro', object: 'model', owned_by: 'deepseek' }
  ]
})

interface Reply {
  body?: string[]
  error?: boolean
  hang?: boolean
  status?: number
}

function fakeNet(reply: Reply) {
  const seen: { aborted: boolean; headers: Record<string, string>; url: string }[] = []

  const net: RelayNet = {
    request(options) {
      const request = new EventEmitter() as EventEmitter & ReturnType<RelayNet['request']>
      const record = { aborted: false, headers: {} as Record<string, string>, url: options.url }
      seen.push(record)
      request.setHeader = (name, value) => void (record.headers[name] = value)
      request.abort = () => void (record.aborted = true)

      request.end = () => {
        if (reply.hang) {
          return
        }

        queueMicrotask(() => {
          if (reply.error) {
            request.emit('error')

            return
          }

          const res = new EventEmitter() as EventEmitter & { statusCode?: number }
          res.statusCode = reply.status
          request.emit('response', res)

          for (const chunk of reply.body ?? []) {
            res.emit('data', Buffer.from(chunk))
          }

          res.emit('end')
        })
      }

      return request
    }
  }

  return { net, seen }
}

describe('the listing ids', () => {
  test.each([
    [ADVANCED, ['apex-flash', 'apex-max', 'apex-pro']],
    ['{"data":[{"id":" apex-pro "},{"id":""},{"id":7},null,"apex-max"]}', ['apex-pro']],
    ['{"data":[]}', []],
    ['{"object":"list"}', null],
    ['not json', null],
    ['', null]
  ])('reads %s', (body, ids) => {
    assert.deepEqual(relayModelIds(body), ids)
  })
})

describe('the relay probe', () => {
  test('asks the listing with the relay key and returns its ids on 200', async () => {
    const { net, seen } = fakeNet({ body: [ADVANCED.slice(0, 40), ADVANCED.slice(40)], status: 200 })
    const probe = await fetchRelayModels(net, 'https://apex-nodes.com/relay/v1/', ' sk-relay ')

    assert.deepEqual(probe, { models: ['apex-flash', 'apex-max', 'apex-pro'], ok: true, statusCode: 200 })
    assert.equal(seen[0].url, 'https://apex-nodes.com/relay/v1/models')
    assert.equal(seen[0].headers.Authorization, 'Bearer sk-relay')
    assert.equal(seen[0].headers.Accept, 'application/json')
  })

  test.each<[string, Reply, RelayModelsProbe]>([
    ['a dead key', { body: ['{"error":"x"}'], status: 401 }, { models: null, ok: false, statusCode: 401 }],
    [
      'a refusal shaped like a listing',
      { body: [ADVANCED], status: 403 },
      { models: null, ok: false, statusCode: 403 }
    ],
    ['a relay error', { body: ['oops'], status: 502 }, { models: null, ok: false, statusCode: 502 }],
    ['a 200 that is not a listing', { body: ['<html>'], status: 200 }, { models: null, ok: true, statusCode: 200 }],
    ['a network error', { error: true }, { models: null, ok: false, statusCode: 0 }]
  ])('answers %s with no ids, keeping the status the self-heal reads', async (_label, reply, expected) => {
    assert.deepEqual(await fetchRelayModels(fakeNet(reply).net, 'https://relay.test/v1', 'sk'), expected)
  })

  test('stops reading past a size no listing reaches', async () => {
    const huge = `{"data":[{"id":"apex-pro"}],"pad":"${'x'.repeat(300 * 1024)}"}`
    const chunks = huge.match(/[\s\S]{1,65536}/g) ?? []
    const probe = await fetchRelayModels(fakeNet({ body: chunks, status: 200 }).net, 'https://relay.test/v1', 'sk')

    assert.deepEqual(probe, { models: null, ok: true, statusCode: 200 })
  })

  test.each([
    ['no key', 'https://relay.test/v1', ''],
    ['no base URL', '', 'sk'],
    ['a base URL that is not one', 'not a url', 'sk'],
    ['a non-HTTP scheme', 'file:///etc', 'sk']
  ])('makes no request with %s', async (_label, baseUrl, key) => {
    const { net, seen } = fakeNet({ status: 200 })

    assert.deepEqual(await fetchRelayModels(net, baseUrl, key), { models: null, ok: false, statusCode: 0 })
    assert.equal(seen.length, 0)
  })

  test('gives up after the timeout as unreachable, not unauthorized', async () => {
    vi.useFakeTimers()

    try {
      const { net, seen } = fakeNet({ hang: true })
      const pending = fetchRelayModels(net, 'https://relay.test/v1', 'sk', { timeoutMs: 50 })
      await vi.advanceTimersByTimeAsync(60)

      assert.deepEqual(await pending, { models: null, ok: false, statusCode: 0 })
      assert.equal(seen[0].aborted, true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the tiers granted to a key', () => {
  const listed = (...models: string[]) => ({ models, ok: true })

  test('are unknown until that key’s listing names a tier', () => {
    const memo = new RelayTierMemo()

    assert.equal(memo.of('sk-a'), null)
    assert.equal(memo.note('sk-a', { models: null, ok: false }), false)
    assert.equal(memo.note('sk-a', listed('deepseek-v4-pro', 'apex-free')), false, 'an older relay lists no tier')
    assert.equal(memo.of('sk-a'), null)
  })

  test('are the listed aliases, weakest first, for that key only', () => {
    const memo = new RelayTierMemo()

    assert.equal(memo.note(' sk-a ', listed('apex-pro', 'APEX-FLASH', 'apex-free')), true)
    assert.deepEqual(memo.of('sk-a'), ['apex-flash', 'apex-pro'])
    assert.equal(memo.of('sk-b'), null, 'another account’s key')
    assert.equal(memo.of(''), null)
  })

  test('report a change only when the tiers for the key change', () => {
    const memo = new RelayTierMemo()

    assert.equal(memo.note('sk-a', listed('apex-flash', 'apex-pro')), true)
    assert.equal(memo.note('sk-a', listed('apex-pro', 'apex-flash')), false, 'same tiers, other order')
    assert.equal(memo.note('sk-a', listed('apex-flash', 'apex-pro', 'apex-max')), true, 'Max opened')
    assert.equal(memo.note('sk-a', listed('apex-flash')), true, 'plan dropped')
    assert.equal(memo.note('sk-b', listed('apex-flash')), true, 'a new key is news even with the same tiers')
    assert.equal(memo.of('sk-a'), null, 'the old key is forgotten')
  })

  test('keep the last answer through a failed probe, and forget it on a listing with no tier', () => {
    const memo = new RelayTierMemo()
    memo.note('sk-a', listed('apex-flash', 'apex-pro'))

    assert.equal(memo.note('sk-a', { models: null, ok: false }), false)
    assert.deepEqual(memo.of('sk-a'), ['apex-flash', 'apex-pro'])
    assert.equal(memo.note('sk-a', listed('deepseek-v4-pro')), false)
    assert.equal(memo.of('sk-a'), null)
  })

  test('hand out a copy', () => {
    const memo = new RelayTierMemo()
    memo.note('sk-a', listed('apex-flash'))
    memo.of('sk-a')?.push('apex-max')

    assert.deepEqual(memo.of('sk-a'), ['apex-flash'])
  })
})
