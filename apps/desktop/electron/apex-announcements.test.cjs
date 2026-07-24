/**
 * Tests for electron/apex-announcements.cjs (hc-447 desktop 更新日志 entry
 * point, reading the hc-446 announcement feed).
 *
 * Run with: node --test electron/apex-announcements.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * These are the pure helpers behind the bridge: URL building and response
 * parsing/normalization. Auth transport (the stored login JWT, safeStorage)
 * lives in main.cjs and is exercised there; here we prove the pure
 * shaping/gating logic.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ANNOUNCEMENTS_LIST_PATH,
  announcementReadUrl,
  announcementsListUrl,
  normalizeAnnouncement,
  parseAnnouncementsResponse
} = require('./apex-announcements.cjs')

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
