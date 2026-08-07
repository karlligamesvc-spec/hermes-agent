import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Guard: there is exactly ONE Thread implementation, and it is the split tree.
 *
 * Until hc-590 two of them sat side by side — our 65KB `thread.tsx` monolith and
 * upstream v0.19.0's `thread/` refactor — and `@/components/assistant-ui/thread`
 * picked the monolith purely because a FILE wins over a same-named DIRECTORY.
 * Both satisfied the same props, so an innocent import tidy-up would have
 * silently swapped the entire message area. hc-590 retired the monolith and
 * moved its two carve-outs (the hc-575 gen_ladder card, the hc-554 scroll-safe
 * zero state) into the split tree.
 *
 * This test is the reverse of the guard it replaces: it fails if the monolith
 * comes back. Re-adding any of the deleted files restores the ambiguity — and
 * a file named `thread.tsx` would once again shadow `thread/` for every
 * existing import in the tree, with nothing else failing.
 */

const ASSISTANT_UI_DIR = __dirname
const SRC_DIR = resolve(ASSISTANT_UI_DIR, '../..')

/** The import specifier the chat view uses; it must land on `thread/index.tsx`. */
const LIVE_SPECIFIER = '@/components/assistant-ui/thread'

/**
 * The retired monolith and the modules only it imported. `thread.tsx` is the
 * one that shadows; the rest are its private half of the duplicated tree, kept
 * in the list so a partial revert is caught too.
 */
const RETIRED_MODULES = [
  'thread.tsx',
  'thread-list.tsx',
  'tool-fallback.tsx',
  'tool-fallback-model.ts',
  'tool-approval.tsx',
  'user-message-text.tsx'
]

function read(path: string): string {
  return readFileSync(path, 'utf-8')
}

describe('live thread module', () => {
  it('is imported by the chat view through the bare specifier', () => {
    const chatView = read(resolve(SRC_DIR, 'app/chat/index.tsx'))

    const threadImport = /import\s*\{[^}]*\bThread\b[^}]*\}\s*from\s*'([^']*assistant-ui\/thread[^']*)'/u.exec(chatView)

    expect(
      threadImport,
      `app/chat/index.tsx no longer imports Thread from an assistant-ui/thread module`
    ).not.toBeNull()

    expect(threadImport?.[1]).toBe(LIVE_SPECIFIER)
  })

  it.each(RETIRED_MODULES)('does not resurrect %s', module => {
    expect(
      existsSync(resolve(ASSISTANT_UI_DIR, module)),
      `${module} is back. It duplicates the thread/ + tool/ split tree, and thread.tsx in particular shadows ` +
        `'${LIVE_SPECIFIER}' for every importer — the exact ambiguity hc-590 removed.`
    ).toBe(false)
  })

  it('resolves the bare specifier to the split tree, not a same-named file', async () => {
    const live = await import('@/components/assistant-ui/thread')
    const split = await import('@/components/assistant-ui/thread/index')

    expect(live.Thread).toBeTruthy()
    expect(
      live.Thread,
      `'${LIVE_SPECIFIER}' stopped resolving to thread/index.tsx — something shadows the directory again`
    ).toBe(split.Thread)
  })

  it('keeps the gen_ladder card wired in the split tree', () => {
    // hc-575's generation-ladder cards were a monolith-only branch; carrying
    // them over is what made retiring it safe. Behaviour is covered by
    // thread/message-parts.test.tsx — this only pins where the branch lives, so
    // a future re-sync with upstream can't drop it back out.
    expect(read(resolve(ASSISTANT_UI_DIR, 'thread/message-parts.tsx'))).toContain('genLadderCardFromResult')
  })
})
