import { describe, expect, it } from 'vitest'

import { mediaSaveName, mediaShortTitle } from './media'

const CACHE = '/Users/me/.apexnodes/cache/media'

describe('mediaShortTitle: what a result is called', () => {
  it.each([
    // The hc-1126 real name: named after the prompt, with a unique tail.
    [
      `${CACHE}/一条_15_秒的竖屏短视频_分三个镜头_镜头之间硬切_三个镜头里是同一个人_同一_4a2ea035.mp4`,
      '一条 15 秒的竖屏短视频 分三个镜头'
    ],
    // A name the assistant chose reads the same, words kept.
    [`${CACHE}/收纳架_15秒_字幕版.mp4`, '收纳架 15秒 字幕版'],
    [`${CACHE}/科技空镜 b-roll_9de0fb22.mp4`, '科技空镜 b-roll'],
    ['/Users/me/APEX/成片/拆解报告.docx', '拆解报告'],
    // One long word: cut, not dropped.
    [`/x/${'长'.repeat(40)}_4a2ea035.mp4`, '长'.repeat(24)],
    // Windows paths and file links.
    ['C:\\Users\\me\\成片\\口播_7b1c2d3e.mp4', '口播'],
    ['file:///Users/me/%E6%88%90%E7%89%87.mp4', '成片'],
    ['https://cdn.example.com/a/%E6%88%90%E7%89%87.mp4?sig=1', '成片'],
    // Characters a file name can't hold become a space.
    ['https://cdn.example.com/a/%E5%B0%81%E9%9D%A2%3A%E7%BA%A2.png', '封面 红'],
    // Not everything that ends in hex is a tail.
    [`${CACHE}/deadbeef.mp4`, 'deadbeef'],
    // Names nobody chose: no title.
    [`${CACHE}/media_4a2ea035.mp4`, ''],
    [`${CACHE}/generated_video_4a2ea035.mp4`, '']
  ])('%s', (path, title) => {
    expect(mediaShortTitle(path)).toBe(title)
  })

  it('never holds a path separator, whatever it is handed', () => {
    for (const path of ['/a/b/c.mp4', 'C:\\a\\b.mp4', 'file:///a/b%2Fc.mp4']) {
      expect(mediaShortTitle(path)).not.toMatch(/[\\/]/)
    }
  })
})

describe('mediaSaveName: what a save dialog starts from', () => {
  it.each([
    [
      `${CACHE}/一条_15_秒的竖屏短视频_分三个镜头_镜头之间硬切_4a2ea035.mp4`,
      '视频',
      '一条 15 秒的竖屏短视频 分三个镜头.mp4'
    ],
    [`${CACHE}/media_4a2ea035.mp4`, '视频', '视频.mp4'],
    ['/Users/me/APEX/拆解报告.docx', '文件', '拆解报告.docx'],
    ['/Users/me/APEX/no-extension', '文件', 'no-extension']
  ])('%s', (path, fallback, name) => {
    expect(mediaSaveName(path, fallback)).toBe(name)
  })

  it('is short, and is not the path (the hc-1126 215-character name)', () => {
    const path = `/private/tmp/claude-501/-Users-karlsu-projects-hermes-cloud--claude-worktrees-hc-1117-update-orphans-213e25/b19250d2/scratchpad/copy/home/hermes/cache/media/一条_15_秒的竖屏短视频_分三个镜头_镜头之间硬切_三个镜头里是同一个人_同一_4a2ea035.mp4`
    const name = mediaSaveName(path, '视频')

    expect([...name].length).toBeLessThanOrEqual(30)
    expect(name).not.toContain('private')
    expect(name).not.toContain('claude')
  })
})
