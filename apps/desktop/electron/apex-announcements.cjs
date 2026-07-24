'use strict'

/**
 * apex-announcements.cjs
 *
 * Pure, electron-free helpers for the hc-447 desktop "更新日志" (changelog)
 * entry point. Kept standalone (no `require('electron')`) so it can be
 * unit-tested with `node --test`, same pattern as apex-feishu.cjs. main.cjs
 * requires these and wires them into the electron-coupled IPC (the stored
 * login JWT, the authed fetch transport).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * hc-446 already ships a single content source for product-update copy —
 * admin-authored "you can now…" announcements, published to the web
 * /app/whats-new page and (when ANNOUNCEMENTS_ENABLED) pushed over IM. The
 * desktop had no reader for that feed at all. This module is the read side
 * only: list the published announcements for the signed-in user, and a
 * best-effort read receipt. No second content source, no desktop-specific
 * authoring path.
 *
 * ── Backend contract (hc-446) ────────────────────────────────────────────
 *   GET {API_BASE}/api/v1/account/announcements
 *   Authorization: Bearer <login JWT>
 *   200 → { items: [{ id, title, body, level, status, target, created_by,
 *                      published_at, created_at, updated_at, read }], total }
 *
 *   POST {API_BASE}/api/v1/account/announcements/{id}/read
 *   Authorization: Bearer <login JWT>
 *   200 → { ok: true }
 *
 * list_visible_for_user (app/services/announcement_service.py) only ever
 * returns status=published rows, newest first — this module trusts that
 * ordering/filtering and does not re-derive it. An empty `items` array is a
 * normal, expected response (no published announcements yet, or
 * ANNOUNCEMENTS_ENABLED still off upstream — that flag gates IM dispatch, not
 * this read) — never treated as an error by any caller of this module.
 *
 * ── Not this module's job ────────────────────────────────────────────────
 * No unread-badge / sidebar dot and no subscription toggle (the richer hc-446
 * web surface) — this is a read-only "查看更新日志" entry: list + mark-read.
 */

const ANNOUNCEMENTS_LIST_PATH = '/api/v1/account/announcements'

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Build the list-fetch URL for an apiBase.
 *
 * @param {string} apiBase e.g. https://api.apex-nodes.com
 * @returns {string}
 */
function announcementsListUrl(apiBase) {
  return `${trimTrailingSlash(apiBase)}${ANNOUNCEMENTS_LIST_PATH}`
}

/**
 * Build the mark-read URL for one announcement.
 *
 * @param {string} apiBase
 * @param {string} announcementId
 * @returns {string}
 */
function announcementReadUrl(apiBase, announcementId) {
  return `${trimTrailingSlash(apiBase)}${ANNOUNCEMENTS_LIST_PATH}/${encodeURIComponent(String(announcementId || ''))}/read`
}

/**
 * Validate + normalize one raw announcement row into the shape the desktop
 * renders. Returns null for a garbage entry (missing id/title/body) so a
 * malformed row is dropped instead of crashing the whole list.
 *
 * @param {unknown} raw
 * @returns {null | { id: string, title: string, body: string, level: 'major'|'normal', publishedAt: string|null, read: boolean }}
 */
function normalizeAnnouncement(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const str = value => (typeof value === 'string' ? value.trim() : '')
  const id = str(raw.id)
  const title = str(raw.title)
  const body = str(raw.body)
  if (!id || !title || !body) return null

  return {
    id,
    title,
    body,
    level: raw.level === 'major' ? 'major' : 'normal',
    publishedAt: str(raw.published_at) || null,
    read: raw.read === true
  }
}

/**
 * Validate + normalize the GET .../announcements response body. Returns an
 * empty list on garbage (fail-soft — a malformed body degrades to "no
 * announcements", never throws); a body with some malformed individual rows
 * keeps the well-formed ones instead of dropping the whole response.
 *
 * @param {unknown} body parsed JSON response
 * @returns {ReturnType<typeof normalizeAnnouncement>[]}
 */
function parseAnnouncementsResponse(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
    return []
  }
  return body.items.map(normalizeAnnouncement).filter(Boolean)
}

module.exports = {
  ANNOUNCEMENTS_LIST_PATH,
  announcementReadUrl,
  announcementsListUrl,
  normalizeAnnouncement,
  parseAnnouncementsResponse
}
