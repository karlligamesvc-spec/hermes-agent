import { cleanup, render, screen } from '@testing-library/react'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { docxParagraphs } from '@/lib/docx-preview'
import { localPreviewTarget } from '@/lib/local-preview'

import { LocalFilePreview } from './preview-file'

const { readData, readText } = vi.hoisted(() => ({ readData: vi.fn(), readText: vi.fn() }))

vi.mock('@/lib/desktop-fs', () => ({
  desktopFsCacheKey: () => 'local:test',
  readDesktopFileDataUrl: readData,
  readDesktopFileText: readText
}))

function archive(xml: string, name = 'word/document.xml') {
  return `data:application/octet-stream;base64,${Buffer.from(zipSync({ [name]: strToU8(xml) })).toString('base64')}`
}

const body = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>高三逐字稿</w:t></w:r></w:p><w:p><w:r><w:t>第一句。</w:t><w:br/><w:t>第二句。</w:t></w:r><w:del><w:r><w:t>已删除</w:t></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容 &amp; 原文</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'

describe('Word body preview', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('opens a spaced Chinese Word path through the binary bridge and displays its paragraphs and table text', async () => {
    const path = '/Users/Test User/27高考报名早准备！ 陕西_逐字稿_7119593c.docx'
    const target = localPreviewTarget(path)!

    readData.mockResolvedValue(archive(body))
    render(<LocalFilePreview reloadKey={0} target={{ ...target, binary: true, previewKind: 'binary' }} />)
    await screen.findByText('高三逐字稿')
    expect(screen.getByText('第一句。 第二句。')).toBeTruthy()
    expect(screen.getByText('表格内容 & 原文')).toBeTruthy()
    expect(screen.queryByText('已删除')).toBeNull()
    expect(readData).toHaveBeenCalledWith(path)
    expect(readText).not.toHaveBeenCalled()
  })

  it.each([
    'data:text/plain;base64,SGVsbG8=',
    archive(body, 'unrelated.xml'),
    archive('<invalid>'),
    archive('<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]>' + body),
    archive('x'.repeat(4 * 1024 * 1024 + 1))
  ])('rejects invalid, unsafe or oversized document bodies', input => {
    expect(() => docxParagraphs(input)).toThrow()
  })
})
