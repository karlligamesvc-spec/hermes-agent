import { describe, expect, it } from 'vitest'

import { parseAnalysisSourceLink } from './analysis-source-link'

describe('analysis source links', () => {
  it.each([
    ['', null, false],
    [' \n\t ', null, false],
    ['https://v.douyin.com/fwkul39fT3A/', 'https://v.douyin.com/fwkul39fT3A/', false],
    ['把7天压缩到了10分钟 # Ski... https://v.douyin.com/fwkul39fT3A/ Jvf:/ 11/06 P@x.sE :4pm', 'https://v.douyin.com/fwkul39fT3A/', false],
    ['复制链接：“https://v.douyin.com/fwkul39fT3A/”。', 'https://v.douyin.com/fwkul39fT3A/', false],
    ['Read https://example.com/video.', 'https://example.com/video', false],
    ['(https://example.com/a_(b))', 'https://example.com/a_(b)', false],
    ['看这个 (https://example.com/a_(b)?q=(one)&next=https://other.example/a,b#part!)', 'https://example.com/a_(b)?q=(one)&next=https://other.example/a,b#part!', false],
    ["'https://example.com/?q=it's#part'", "https://example.com/?q=it%27s#part", false],
    ["Read 'https://example.com/?q=it's#part'.", "https://example.com/?q=it%27s#part", false],
    ['分享 https://example.com/?q=a。b，c#part！', 'https://example.com/?q=a%E3%80%82b%EF%BC%8Cc#part%EF%BC%81', false],
    ['https://example.com/a_(b)?q=a,b!?;&next=https://other.example/#part.', 'https://example.com/a_(b)?q=a,b!?;&next=https://other.example/#part.', false],
    ['https://example.com/video.', 'https://example.com/video.', false],
    ['https://example.com/unmatched)', 'https://example.com/unmatched)', false],
    ['https://EXAMPLE.COM:443/video https://example.com/video', 'https://example.com/video', false],
    ['https://feishu.cn/wiki/abc', 'https://feishu.cn/wiki/abc', true],
    ['分享 https://TEAM.FEISHU.CN/docx/abc?from=share#anchor', 'https://team.feishu.cn/docx/abc?from=share#anchor', true],
    ['https://larksuite.com/docx/abc', 'https://larksuite.com/docx/abc', true],
    ['https://team.larksuite.com/docx/abc', 'https://team.larksuite.com/docx/abc', true],
    ['https://notfeishu.cn/wiki/abc', 'https://notfeishu.cn/wiki/abc', false],
    ['https://feishu.cn.example.com/wiki/abc', 'https://feishu.cn.example.com/wiki/abc', false],
    ['https://larksuite.com.example.com/docx/abc', 'https://larksuite.com.example.com/docx/abc', false],
    ['https://example.com/feishu.cn', 'https://example.com/feishu.cn', false],
    ['链接 https://[::1]/a_(b)。', 'https://[::1]/a_(b)', false]
  ] as const)('extracts a unique address without changing URL semantics: %s', (input, url, isFeishu) => {
    expect(parseAnalysisSourceLink(input)).toEqual({ url, isFeishu, error: null })
  })

  it.each([
    ['没有链接', 'invalid_source_link'],
    ['www.example.com/video', 'invalid_source_link'],
    ['http://example.com/video', 'invalid_source_link'],
    ['ftp://example.com/video', 'invalid_source_link'],
    ['https:/example.com/video', 'invalid_source_link'],
    ['https://', 'invalid_source_link'],
    ['https:///example.com/video', 'invalid_source_link'],
    ['https://user:secret@feishu.cn/wiki/abc', 'invalid_source_link'],
    ['https://@feishu.cn/wiki/abc', 'invalid_source_link'],
    ['分享 https://user@feishu.cn/wiki/abc', 'invalid_source_link'],
    ['http://example.com/a https://example.com/b', 'invalid_source_link'],
    ['https://example.com/a https://example.com/b', 'multiple_source_links'],
    ['https://example.com/a，https://example.com/b', 'multiple_source_links'],
    ['分享 https://example.com/a,https://example.com/b', 'multiple_source_links'],
    ['https://example.com/a,https://example.com/b?q=share', 'multiple_source_links'],
    ['分享 https://example.com/?next=https://example.com/b http://example.com/c', 'invalid_source_link'],
    ['https://example.com/a https://example.com/a#other', 'multiple_source_links']
  ] as const)('refuses invalid or ambiguous sources: %s', (input, error) => {
    expect(parseAnalysisSourceLink(input)).toEqual({ url: null, isFeishu: false, error })
  })
})
