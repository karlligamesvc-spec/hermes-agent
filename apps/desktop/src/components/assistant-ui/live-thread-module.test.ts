import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Guard: the live message area must keep resolving to OUR thread implementation.
 *
 * Two Thread modules sit side by side in this tree (hc-589 audit A-5.1):
 *
 *   components/assistant-ui/thread.tsx        ← ours, what ships today
 *   components/assistant-ui/thread/index.tsx  ← upstream v0.19.0's refactor
 *
 * `@/components/assistant-ui/thread` picks ours only because a FILE wins over a
 * DIRECTORY of the same name. That is an accident of module resolution, not a
 * decision anything states — and both implementations satisfy the same props,
 * so a tidy-up of the import path (`.../thread` → `.../thread/index`, or moving
 * thread.tsx under thread/) would silently swap the entire message area with
 * nothing failing: two full test suites exist, one per tree, and both stay
 * green either way.
 *
 * What that swap actually costs: upstream's module has no `gen_ladder` branch,
 * so the generation-ladder cards (hc-575) stop rendering in chat.
 *
 * De-duplicating the two trees is hc-590's job. Until then this test is the
 * only thing standing between an innocent import edit and a silent regression.
 */

const ASSISTANT_UI_DIR = __dirname
const SRC_DIR = resolve(ASSISTANT_UI_DIR, '../..')

const OUR_THREAD = resolve(ASSISTANT_UI_DIR, 'thread.tsx')
const UPSTREAM_THREAD = resolve(ASSISTANT_UI_DIR, 'thread/index.tsx')

/** The import specifier the chat view must keep using. */
const LIVE_SPECIFIER = '@/components/assistant-ui/thread'

function read(path: string): string {
  return readFileSync(path, 'utf-8')
}

describe('live thread module', () => {
  it('is imported by the chat view through the bare specifier, not the directory', () => {
    const chatView = read(resolve(SRC_DIR, 'app/chat/index.tsx'))

    const threadImport = /import\s*\{[^}]*\bThread\b[^}]*\}\s*from\s*'([^']*assistant-ui\/thread[^']*)'/u.exec(chatView)

    expect(threadImport, `app/chat/index.tsx no longer imports Thread from an assistant-ui/thread module`).not.toBeNull()

    expect(
      threadImport?.[1],
      `app/chat/index.tsx must import Thread from '${LIVE_SPECIFIER}' — anything deeper resolves to upstream's ` +
        `thread/ refactor and silently replaces the whole message area (see hc-590).`
    ).toBe(LIVE_SPECIFIER)
  })

  it('renders the gen_ladder card, which upstream thread/ does not', () => {
    // The marker is a product feature, not a string: our module wires the
    // generation-ladder tool result into a card. If this assertion has to move,
    // the message area moved with it — check what else came along.
    expect(read(OUR_THREAD)).toContain('genLadderCardFromResult')
    expect(
      read(UPSTREAM_THREAD) + read(resolve(ASSISTANT_UI_DIR, 'thread/message-parts.tsx')),
      `upstream's thread/ grew a gen_ladder branch — re-check whether this guard still describes the difference`
    ).not.toContain('genLadder')
  })

  it('wins over the same-named directory when the bare specifier is resolved', async () => {
    const live = await import('@/components/assistant-ui/thread')
    const upstream = await import('@/components/assistant-ui/thread/index')

    expect(typeof live.Thread).toBe('function')
    expect(
      live.Thread,
      `'${LIVE_SPECIFIER}' now resolves to upstream's thread/index.tsx — the message area has been swapped`
    ).not.toBe(upstream.Thread)
  })
})
