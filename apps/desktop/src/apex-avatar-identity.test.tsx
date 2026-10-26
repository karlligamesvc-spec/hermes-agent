// First, before any app module: the shell harness renders dates in its recording zone.
import './__identity__/single-thread-shell/time-zone'

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApexAvatar } from '@/components/apex-avatar'
import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { resetMainThreadForTest } from '@/store/main-thread'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import { remixRunningTurn } from '@/test/remix-turn'

import { renderSidebar, renderTranscript, seedShellState } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1064 identity guard (hard rule 11) for APEX's avatar.
 *
 * The purple figure from 「APEX 极简助手原型 v2」 is a new brand element, so two
 * things are pinned here:
 *
 * 1. It is ours: drawn inline on the prototype's grid in the prototype's
 *    purple, with no image, no asset path and nothing from upstream's art.
 * 2. It appears only in single-thread product mode: only the single-thread
 *    surfaces import it, and with the switch off or in developer mode no
 *    surface draws it — APEX there is still BrandMark, the app icon (pinned in
 *    identity-layer.test.tsx).
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const SRC = __dirname
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf8')

/** The only files allowed to draw the avatar: each renders only in single-thread product mode. */
const AVATAR_SURFACES = [
  'app/single-thread/thread-header.tsx',
  'components/assistant-ui/process/single-thread-process.tsx'
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      return sourceFiles(path)
    }

    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

afterAll(restoreRecordingTimeZone)

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  vi.useRealTimers()
})

describe('hc-1064 the avatar is our own drawing', () => {
  it('is the prototype figure, drawn inline: a #6A4CEB disc and two white eyes on a 28×28 grid', () => {
    const svg = render(<ApexAvatar />).container.querySelector('svg')!

    expect(svg.getAttribute('viewBox')).toBe('0 0 28 28')
    expect([...svg.children].map(node => node.outerHTML)).toEqual([
      '<circle cx="14" cy="14" fill="#6A4CEB" r="14"></circle>',
      '<rect fill="#FFFFFF" height="7.4" rx="1.8" width="3.6" x="8.3" y="8"></rect>',
      '<rect fill="#FFFFFF" height="7.4" rx="1.8" width="3.6" x="16.1" y="8"></rect>'
    ])
  })

  it.each(['idle', 'working', 'talking'] as const)('pulls in no image or outside element when %s', mood => {
    const { container } = render(<ApexAvatar mood={mood} />)

    expect(container.querySelector('img, image, use, foreignObject, [href], [src]')).toBeNull()
  })

  it('reaches for no asset, upstream art included, in its source or its stylesheet', () => {
    const source = read('components', 'apex-avatar.tsx') + read('components', 'apex-avatar.css')

    expect(source).not.toMatch(/assetPath|import\.meta|url\(|\.(?:png|jpe?g|gif|webp|svg|ico|icns)\b|nous|hermes/i)
  })
})

describe('hc-1064 the avatar appears only in single-thread product mode', () => {
  beforeEach(() => {
    seedShellState()
    resetMainThreadForTest()
  })

  it('is imported only by the single-thread product surfaces', () => {
    const importers = sourceFiles(SRC)
      .filter(path => /from '@\/components\/apex-avatar'/.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path))
      .sort()

    expect(importers).toEqual(AVATAR_SURFACES)
  })

  it.each([
    ['the switch off', false, 'product'],
    ['developer mode with the switch on', true, 'technical']
  ] as const)('%s: no surface draws it', async (_label, flag, toolView) => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)

    expect(renderSidebar().container.querySelector('[data-apex-avatar]')).toBeNull()
    cleanup()
    expect((await renderTranscript(remixRunningTurn())).querySelector('[data-apex-avatar]')).toBeNull()
  })

  it('the switch on in product mode: the activity line wears it, looking down at the work', async () => {
    setSingleThreadFlagForTest(true)

    const container = await renderTranscript(remixRunningTurn())
    const avatars = [...container.querySelectorAll('[data-apex-avatar]')]

    expect(avatars).toHaveLength(1)
    expect(avatars[0]!.closest('[data-single-thread-activity]')).not.toBeNull()
    expect(avatars[0]!.getAttribute('data-apex-avatar')).toBe('working')
  })
})
