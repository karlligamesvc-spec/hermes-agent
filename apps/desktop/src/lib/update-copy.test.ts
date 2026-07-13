import { describe, expect, it } from 'vitest'

import { resolveUpdateCopy } from './update-copy'

// hc-475 follow-up: resolveUpdateCopy used to branch on a 'client' | 'backend'
// target; the 'client' branch (and its two test cases below) were removed
// along with the rest of the legacy client self-rebuild plane's renderer
// code — the overlay that calls this only ever targets the backend now. The
// backend-branch coverage is unchanged.
const copy = {
  availableTitleBackend: 'Backend update available',
  availableBodyBackend: 'A newer version of the connected Hermes backend is ready to install.',
  availableBodyNoChangelog: 'A newer version is ready. Release notes aren’t available for this install type.'
}

describe('resolveUpdateCopy', () => {
  it('with commits: names the backend in title and body', () => {
    const r = resolveUpdateCopy({ shownItems: 5, copy })
    expect(r.title).toBe('Backend update available')
    expect(r.body).toContain('backend')
  })

  it('no changelog (pip/non-git backend): degrades honestly, still names backend target in title', () => {
    const r = resolveUpdateCopy({ shownItems: 0, copy })
    expect(r.title).toBe('Backend update available')
    // Body must NOT pretend there are notes — it states they're unavailable.
    expect(r.body).toBe(copy.availableBodyNoChangelog)
  })
})
