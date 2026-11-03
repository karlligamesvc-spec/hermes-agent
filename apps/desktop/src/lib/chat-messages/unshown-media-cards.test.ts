import { describe, expect, it } from 'vitest'

import { mediaPathFromMarkdownHref } from '@/lib/media'

import { renderMediaTags } from './parts'

// hc-1066: in single-thread mode the next-steps plugin hands paid clips the reply never
// showed to the Desktop chat as MEDIA: paragraphs instead of raw cache paths. This is the
// exact note tests/plugins/test_apexnodes_next_steps.py (CARDS_NOTE) pins on the engine side.
const CLIPS = [
  '/Users/u/.apexnodes/cache/media/竖屏口播_cf68f9ae.mp4',
  '/Users/u/.apexnodes/cache/media/科技空镜 b-roll_9de0fb22.mp4'
]

const CARDS_NOTE = ['这一轮还生成了下面这些素材(都已计费)，上面没给你看：', ...CLIPS.map(path => `MEDIA:${path}`)].join(
  '\n\n'
)

describe('the unshown-media note in single-thread mode', () => {
  it('becomes one media card per clip, with no path left in the words', () => {
    const rendered = renderMediaTags(`做完了。\n\n${CARDS_NOTE}`)
    const links = [...rendered.matchAll(/\]\((#media:[^)]+)\)/g)].map(match => mediaPathFromMarkdownHref(match[1]))
    const words = rendered.replace(/\]\(#media:[^)]+\)/g, ']')

    expect(links).toEqual(CLIPS)
    expect(words).toContain('这一轮还生成了下面这些素材(都已计费)，上面没给你看：')
    expect(words).not.toContain('MEDIA:')
    expect(words).not.toContain('/Users/')
  })
})
