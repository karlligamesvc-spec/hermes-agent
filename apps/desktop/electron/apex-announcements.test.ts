/**
 * Tests for electron/apex-announcements.ts (hc-447 desktop 更新日志 entry
 * point, reading the hc-446 announcement feed).
 *
 * Run with: npx vitest run electron/apex-announcements.test.ts
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * These are the helpers behind the bridge: URL building, response
 * parsing/normalization, and (since hc-971 moved them out of main.ts) the two
 * reads, run here against a stand-in transport. The real transport and the
 * stored login JWT still live in main.ts.
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  announcementReadUrl,
  ANNOUNCEMENTS_LIST_PATH,
  announcementsListUrl,
  fetchAnnouncements,
  markAnnouncementRead,
  normalizeAnnouncement,
  parseAnnouncementsResponse
} from './apex-announcements'

test('announcementsListUrl appends the account route and trims a trailing slash', () => {
  assert.equal(announcementsListUrl('https://api.apex-nodes.com'), `https://api.apex-nodes.com${ANNOUNCEMENTS_LIST_PATH}`)
  assert.equal(announcementsListUrl('https://api.apex-nodes.com/'), `https://api.apex-nodes.com${ANNOUNCEMENTS_LIST_PATH}`)
})

test('announcementReadUrl appends /{id}/read and URL-encodes the id', () => {
  assert.equal(
    announcementReadUrl('https://api.apex-nodes.com', 'abc-123'),
    `https://api.apex-nodes.com${ANNOUNCEMENTS_LIST_PATH}/abc-123/read`
  )
  assert.equal(
    announcementReadUrl('https://api.apex-nodes.com/', 'has space/slash'),
    `https://api.apex-nodes.com${ANNOUNCEMENTS_LIST_PATH}/has%20space%2Fslash/read`
  )
})

test('normalizeAnnouncement maps a well-formed row', () => {
  const parsed = normalizeAnnouncement({
    id: 'ann-1',
    title: '现在可以查看更新日志了',
    body: '在「关于」页点击「查看」即可看到最近的产品更新。',
    level: 'major',
    status: 'published',
    target: 'both',
    created_by: 'user-1',
    published_at: '2026-07-20T00:00:00Z',
    created_at: '2026-07-19T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    read: false
  })

  assert.deepEqual(parsed, {
    id: 'ann-1',
    title: '现在可以查看更新日志了',
    body: '在「关于」页点击「查看」即可看到最近的产品更新。',
    level: 'major',
    publishedAt: '2026-07-20T00:00:00Z',
    read: false
  })
})

test('normalizeAnnouncement defaults an unknown/missing level to normal', () => {
  const parsed = normalizeAnnouncement({ id: '1', title: 't', body: 'b', level: 'bogus' })
  assert.equal(parsed.level, 'normal')

  const noLevel = normalizeAnnouncement({ id: '1', title: 't', body: 'b' })
  assert.equal(noLevel.level, 'normal')
})

test('normalizeAnnouncement preserves read:true and defaults a missing/non-boolean read to false', () => {
  assert.equal(normalizeAnnouncement({ id: '1', title: 't', body: 'b', read: true }).read, true)
  assert.equal(normalizeAnnouncement({ id: '1', title: 't', body: 'b' }).read, false)
  assert.equal(normalizeAnnouncement({ id: '1', title: 't', body: 'b', read: 'yes' }).read, false)
})

test('normalizeAnnouncement drops a row missing id/title/body', () => {
  assert.equal(normalizeAnnouncement({ title: 't', body: 'b' }), null)
  assert.equal(normalizeAnnouncement({ id: '1', body: 'b' }), null)
  assert.equal(normalizeAnnouncement({ id: '1', title: 't' }), null)
  assert.equal(normalizeAnnouncement({ id: '  ', title: 't', body: 'b' }), null)
})

test('normalizeAnnouncement fails soft on garbage', () => {
  assert.equal(normalizeAnnouncement(null), null)
  assert.equal(normalizeAnnouncement('nope'), null)
  assert.equal(normalizeAnnouncement([1, 2, 3]), null)
  assert.equal(normalizeAnnouncement(42), null)
})

test('parseAnnouncementsResponse maps every well-formed item, newest-first order preserved', () => {
  const items = parseAnnouncementsResponse({
    items: [
      { id: '2', title: 'newer', body: 'b2', published_at: '2026-07-21T00:00:00Z' },
      { id: '1', title: 'older', body: 'b1', published_at: '2026-07-20T00:00:00Z' }
    ],
    total: 2
  })

  assert.equal(items.length, 2)
  assert.equal(items[0].id, '2')
  assert.equal(items[1].id, '1')
})

test('parseAnnouncementsResponse drops malformed rows but keeps the well-formed ones', () => {
  const items = parseAnnouncementsResponse({
    items: [{ id: '1', title: 't', body: 'b' }, { id: '2' }, null, 'garbage'],
    total: 4
  })

  assert.equal(items.length, 1)
  assert.equal(items[0].id, '1')
})

test('parseAnnouncementsResponse fails soft to an empty list on garbage (never throws)', () => {
  assert.deepEqual(parseAnnouncementsResponse(null), [])
  assert.deepEqual(parseAnnouncementsResponse(undefined), [])
  assert.deepEqual(parseAnnouncementsResponse('nope'), [])
  assert.deepEqual(parseAnnouncementsResponse({}), [])
  assert.deepEqual(parseAnnouncementsResponse({ items: 'not-an-array' }), [])
})

test('parseAnnouncementsResponse returns an empty list for a genuinely empty feed (not an error state)', () => {
  assert.deepEqual(parseAnnouncementsResponse({ items: [], total: 0 }), [])
})

// ── the two reads (moved from main.ts by hc-971; behaviour unchanged) ───────

function reads(overrides: Record<string, unknown> = {}) {
  const calls: { bearer: string; body?: object; url: string }[] = []
  const logs: string[] = []

  return {
    accessToken: () => 'jwt-1',
    apiBase: () => 'https://api.apex-nodes.com',
    getJson: async (url: string, opts: { bearer: string }) => {
      calls.push({ bearer: opts.bearer, url })

      return { items: [{ body: 'b', id: 'a1', level: 'major', title: 't' }] }
    },
    log: (line: string) => {
      logs.push(line)
    },
    postJson: async (url: string, opts: { body: object; bearer: string }) => {
      calls.push({ bearer: opts.bearer, body: opts.body, url })

      return { ok: true }
    },
    ...overrides,
    calls,
    logs
  }
}

const failWith = (statusCode?: number) => async () => {
  throw Object.assign(new Error('boom'), statusCode === undefined ? {} : { statusCode })
}

test('fetchAnnouncements lists with the stored JWT and normalizes the rows', async () => {
  const d = reads()
  const result = await fetchAnnouncements(d)

  assert.equal(result.ok, true)
  assert.deepEqual(result.items.map(item => item && item.id), ['a1'])
  assert.deepEqual(d.calls, [{ bearer: 'jwt-1', url: `https://api.apex-nodes.com${ANNOUNCEMENTS_LIST_PATH}` }])
})

test('fetchAnnouncements: no JWT, an expired session and a failure each have their own shape', async () => {
  assert.deepEqual(await fetchAnnouncements(reads({ accessToken: () => '' })), { ok: false, needsSignIn: true, items: [], message: 'NOT_SIGNED_IN' })
  assert.deepEqual(await fetchAnnouncements(reads({ getJson: failWith(401) })), { ok: false, needsSignIn: true, items: [], message: 'SESSION_EXPIRED' })
  const failing = reads({ getJson: failWith(500) })
  assert.deepEqual(await fetchAnnouncements(failing), { ok: false, items: [], message: 'FETCH_FAILED' })
  assert.equal(failing.logs.length, 1)
})

test('markAnnouncementRead posts once and swallows failures', async () => {
  const d = reads()

  assert.deepEqual(await markAnnouncementRead(d, ' a1 '), { ok: true })
  assert.deepEqual(d.calls, [{ bearer: 'jwt-1', body: {}, url: `https://api.apex-nodes.com${ANNOUNCEMENTS_LIST_PATH}/a1/read` }])
  assert.deepEqual(await markAnnouncementRead(reads(), ''), { ok: false })
  assert.deepEqual(await markAnnouncementRead(reads({ accessToken: () => '' }), 'a1'), { ok: false })
  assert.deepEqual(await markAnnouncementRead(reads({ postJson: failWith(500) }), 'a1'), { ok: false })
})
