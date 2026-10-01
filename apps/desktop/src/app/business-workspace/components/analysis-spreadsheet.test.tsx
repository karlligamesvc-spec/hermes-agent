import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AnalysisAnchor } from '../analysis-types'

import { AnalysisSpreadsheet } from './analysis-spreadsheet'

afterEach(cleanup)

const label = (location: Record<string, number | string>) => `${location.sheet} ${location.cell}`
const cell = (id: string, sheet: string, address: string, text: string): AnalysisAnchor => ({ id, location: { sheet, cell: address }, text })

describe('analysis spreadsheet', () => {
  it('uses actual worksheets, sparse row/column addresses, empty missing cells and source selections', () => {
    const onSelect = vi.fn()
    render(<AnalysisSpreadsheet anchors={[
      cell('sales-a', 'Sales', 'A1', 'Revenue'), cell('sales-c', 'Sales', 'C3', '1200'),
      cell('cost-z', 'Costs', 'XFD1048576', 'Actual far cell')
    ]} label={label} locale="en" onSelect={onSelect} />)
    const sales = screen.getByRole('table', { name: 'Worksheet: Sales' })
    expect(within(sales).getAllByRole('columnheader').map(item => item.textContent)).toEqual(['Row', 'A', 'C'])
    expect(within(sales).getAllByRole('rowheader').map(item => item.textContent)).toEqual(['1', '3'])
    expect(within(sales).getAllByRole('cell').filter(item => item.textContent === '')).toHaveLength(2)
    fireEvent.click(within(sales).getByRole('button', { name: 'Sales C3: 1200' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('sales-c')
    expect(within(screen.getByRole('table', { name: 'Worksheet: Costs' })).getAllByRole('rowheader').map(item => item.textContent)).toEqual(['1048576'])
    expect(screen.getByRole('button', { name: 'Costs XFD1048576: Actual far cell' }).id).toBe('analysis-anchor-cost-z')
  })

  it('bounds the row-column cross product while preserving every value and unplaced or duplicate anchors', () => {
    const columns = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS']
    const anchors = columns.map((column, index) => cell(`real-${column}`, 'Wide', `${column}${index + 1}`, `Value ${column}`))
    anchors.push(cell('duplicate', 'Wide', 'A1', 'Second source value'), cell('unplaced', 'Wide', 'XFE1', 'Unlocated original'))
    const onSelect = vi.fn()
    render(<AnalysisSpreadsheet anchors={anchors} label={label} locale="en" onSelect={onSelect} />)
    const table = screen.getByRole('table', { name: 'Worksheet: Wide' })
    expect(within(table).getAllByRole('columnheader').map(item => item.textContent)).toEqual(['Row', 'Cell', 'Source value'])
    expect(within(table).getAllByRole('button')).toHaveLength(46)
    expect(within(table).getAllByRole('cell')).toHaveLength(92)
    expect(screen.getByText('Widely spaced data is shown by populated cell, preserving actual addresses.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Wide XFE1: Unlocated original' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('unplaced')
    expect(screen.getByRole('button', { name: 'Wide A1: Second source value' })).toBeTruthy()
  })
})
