import type { AnalysisAnchor } from '../analysis-types'

export interface AnalysisSpreadsheetCell {
  anchor: AnalysisAnchor
  address: string
  row: number
  column: number
  columnLabel: string
}

export interface AnalysisSpreadsheetSheet {
  name: string
  rows: number[]
  columns: Array<{ index: number; label: string }>
  cells: Map<string, AnalysisSpreadsheetCell[]>
  entries: AnalysisSpreadsheetCell[]
  compact: boolean
}

export function buildAnalysisSpreadsheet(anchors: AnalysisAnchor[]): { sheets: AnalysisSpreadsheetSheet[]; unplaced: AnalysisAnchor[] } {
  const groups = new Map<string, AnalysisSpreadsheetCell[]>()
  const unplaced: AnalysisAnchor[] = []

  for (const anchor of anchors) {
    const { sheet, cell } = anchor.location
    const match = typeof cell === 'string' ? /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(cell) : null
    const columnLabel = match?.[1].toUpperCase() ?? ''
    const column = [...columnLabel].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0)
    const row = Number(match?.[2])

    if (typeof sheet !== 'string' || !sheet.trim() || !match || column > 16384 || row > 1048576) {
      unplaced.push(anchor)

      continue
    }

    const entries = groups.get(sheet) ?? []
    entries.push({ anchor, address: `${columnLabel}${row}`, row, column, columnLabel })
    groups.set(sheet, entries)
  }

  const sheets = [...groups].map(([name, entries]) => {
    const cells = new Map<string, AnalysisSpreadsheetCell[]>()

    for (const entry of entries) {cells.set(entry.address, [...(cells.get(entry.address) ?? []), entry])}

    const rows = [...new Set(entries.map(entry => entry.row))].sort((a, b) => a - b)
    const columns = [...new Map(entries.map(entry => [entry.column, { index: entry.column, label: entry.columnLabel }])).values()].sort((a, b) => a.index - b.index)

    return { name, rows, columns, cells, entries: entries.toSorted((a, b) => a.row - b.row || a.column - b.column), compact: rows.length * columns.length > 2000 }
  })

  return { sheets, unplaced }
}
