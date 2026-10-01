import './analysis-workspace-frame.css'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

import type { AnalysisAnchor } from '../analysis-types'
import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'

import { buildAnalysisSpreadsheet } from './analysis-spreadsheet-model'
import { ANALYSIS_WORKSPACE_COPY } from './analysis-workspace-copy'

export interface AnalysisSpreadsheetProps {
  anchors: AnalysisAnchor[]
  onSelect: (id: string) => void
  label: (location: Record<string, number | string>) => string
  locale: VideoBreakdownLocale
}

export function AnalysisSpreadsheet({ anchors, onSelect, label, locale }: AnalysisSpreadsheetProps) {
  const copy = ANALYSIS_WORKSPACE_COPY[locale]
  const { sheets, unplaced } = buildAnalysisSpreadsheet(anchors)

  const cellValue = (anchor: AnalysisAnchor) => <Button aria-label={`${label(anchor.location)}: ${anchor.text}`} className="max-w-full whitespace-pre-wrap text-start"
    id={`analysis-anchor-${anchor.id}`} key={anchor.id} onClick={() => onSelect(anchor.id)} size="inline" type="button" variant="text">{anchor.text}</Button>

  return <div className="analysis-spreadsheet">
    {anchors.length === 0 && <EmptyState title={copy.emptyOutline} />}
    {sheets.map(sheet => <section aria-label={`${copy.sheet}: ${sheet.name}`} key={sheet.name}>
      <h3>{sheet.name}</h3>
      <p className="analysis-sheet-disclosure">{sheet.compact ? copy.compact : copy.sparse}</p>
      <div className="analysis-sheet-scroll">
        <table aria-label={`${copy.sheet}: ${sheet.name}`}>
          <thead><tr><th scope="col">{copy.row}</th>
            {sheet.compact ? <><th scope="col">{copy.cell}</th><th scope="col">{copy.value}</th></> : sheet.columns.map(column => <th key={column.index} scope="col">{column.label}</th>)}
          </tr></thead>
          <tbody>{sheet.compact ? sheet.entries.map(entry => <tr key={entry.anchor.id}>
            <th scope="row">{entry.row}</th><td>{entry.address}</td><td>{cellValue(entry.anchor)}</td>
          </tr>) : sheet.rows.map(row => <tr key={row}>
            <th scope="row">{row}</th>{sheet.columns.map(column => <td key={column.index}>
              {(sheet.cells.get(`${column.label}${row}`) ?? []).map(entry => cellValue(entry.anchor))}
            </td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </section>)}
    {unplaced.length > 0 && <section aria-label={copy.unplaced}><h3>{copy.unplaced}</h3>
      <div className="analysis-sheet-unplaced">{unplaced.map(cellValue)}</div>
    </section>}
  </div>
}
