import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AnalysisDocument } from '../analysis-types'

import { AnalysisSourceHub } from './analysis-source-hub'

afterEach(cleanup)

const items: AnalysisDocument[] = Array.from({ length: 4 }, (_, index) => ({
  id: `owned-${index}`, filename: `actual-${index}.txt`, kind: 'text', status: 'ready', storageMode: 'local'
}))

describe('analysis source hub', () => {
  it('offers three actual recent sources and sends explicit format actions to the real import or link field', () => {
    const onImport = vi.fn(); const onFocusLink = vi.fn(); const onOpen = vi.fn()
    render(<AnalysisSourceHub controls={<input aria-label="Actual link field" />} description="Source evidence" history={false}
      importDisabled={false} items={items} locale="zh" onFocusLink={onFocusLink} onHistory={vi.fn()} onImport={onImport}
      onOpen={onOpen} openingId={null} stateLabel={() => '本地保存 · 可提问'} status={null} title="沉浸式分析" />)
    expect(screen.getAllByRole('button', { name: /actual-/ })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /actual-3/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /actual-1/ }))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('owned-1')
    fireEvent.click(screen.getByRole('button', { name: /视频.*粘贴资料链接/ }))
    fireEvent.click(screen.getByRole('button', { name: /飞书文档.*粘贴资料链接/ }))
    expect(onFocusLink).toHaveBeenCalledTimes(2)
    expect(onImport).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Excel.*打开本地资料/ }))
    expect(onImport).toHaveBeenCalledOnce()
  })

  it('filters actual history and shows an explicit empty category without hiding the return action', () => {
    render(<AnalysisSourceHub controls={null} description="Source evidence" history importDisabled={false} items={items}
      locale="zh" onFocusLink={vi.fn()} onHistory={vi.fn()} onImport={vi.fn()} onOpen={vi.fn()} openingId={null}
      stateLabel={() => '本地保存 · 可提问'} status={null} title="沉浸式分析" />)
    expect(screen.getAllByRole('button', { name: /actual-/ })).toHaveLength(4)
    fireEvent.mouseDown(screen.getByRole('tab', { name: '视频' }), { button: 0, ctrlKey: false })
    expect(screen.queryByRole('button', { name: /actual-/ })).toBeNull()
    expect(screen.getByText('此分类暂无资料。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '返回资料入口' })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('tab', { name: '文档与表格' }), { button: 0, ctrlKey: false })
    expect(screen.getAllByRole('button', { name: /actual-/ })).toHaveLength(4)
  })
})
