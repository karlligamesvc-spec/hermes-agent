import './analysis-source-hub.css'

import { type ReactNode, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { AnalysisDocument } from '../analysis-types'
import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'

import { ANALYSIS_HUB_COPY } from './analysis-source-hub-copy'

export interface AnalysisSourceHubProps {
  locale: VideoBreakdownLocale
  title: string
  description: string
  controls: ReactNode
  status: ReactNode
  items: AnalysisDocument[]
  history: boolean
  onHistory: (history: boolean) => void
  onOpen: (id: string) => void
  onImport: () => void
  onFocusLink: () => void
  importDisabled: boolean
  openingId: string | null
  stateLabel: (item: AnalysisDocument) => string
}

export function AnalysisSourceHub({ locale, title, description, controls, status, items, history, onHistory, onOpen, onImport, onFocusLink, importDisabled, openingId, stateLabel }: AnalysisSourceHubProps) {
  const c = ANALYSIS_HUB_COPY[locale]
  const [filter, setFilter] = useState<'all' | 'video' | 'document'>('all')
  const visible = history ? items.filter(item => filter === 'all' || (filter === 'video' ? item.kind === 'subtitle' : item.kind !== 'subtitle')) : items.slice(0, 3)

  const formats = [
    { label: c.videos, icon: 'play', link: true },
    { label: c.text, icon: 'file-text', link: false },
    { label: 'PDF', icon: 'file-pdf', link: false },
    { label: 'Word', icon: 'file-text', link: false },
    { label: 'Excel', icon: 'table', link: false },
    { label: c.feishu, icon: 'link', link: true }
  ]

  return <div className="analysis-source-hub">
    <header className="analysis-hub-header">
      <span className="analysis-hub-mark"><Codicon name="book" size="1.5rem" /></span>
      <div><h1>{title}</h1><p>{description}</p></div>
      <div className="analysis-hub-header-actions">
        <Button onClick={() => onHistory(!history)} variant="outline"><Codicon name="history" />{history ? c.back : c.history}</Button>
        <Button disabled={importDisabled} onClick={onImport} variant="outline"><Codicon name="cloud-upload" />{c.local}</Button>
      </div>
    </header>
    {!history && <section aria-label={c.formats} className="analysis-hub-import">
      <div className="analysis-hub-import-copy"><h2>{c.hero}</h2><p>{c.intro}</p>{controls}</div>
      <div aria-hidden="true" className="analysis-hub-evidence-illustration">
        <div className="analysis-hub-illustration-paper"><Codicon name="file-text" size="1.5rem" /><strong>{c.evidence}</strong><p>{c.location}</p></div>
        <div className="analysis-hub-illustration-citation"><Codicon name="book" />{c.citation}</div>
      </div>
    </section>}
    {history && <Tabs className="analysis-hub-history-tabs" onValueChange={value => setFilter(value as typeof filter)} value={filter}>
      <TabsList aria-label={c.formats}>{(['all', 'video', 'document'] as const).map(value => <TabsTrigger key={value} value={value}>{value === 'all' ? c.all : value === 'video' ? c.videos : c.documents}</TabsTrigger>)}</TabsList>
    </Tabs>}
    <section aria-label={history ? c.history : c.recent} className="analysis-hub-records">
      <header><h2>{history ? c.history : c.recent}</h2>{!history && <Button onClick={() => onHistory(true)} variant="text">{c.allRecords}<Codicon name="arrow-right" /></Button>}</header>
      {status}
      {history && items.length > 0 && visible.length === 0 && <p className="text-sm text-(--ui-text-tertiary)">{c.filteredEmpty}</p>}
      <div className={history ? 'analysis-hub-history-list' : 'analysis-hub-recent-list'}>
        {visible.map(item => <Button className="analysis-hub-source-record" disabled={openingId === item.id} key={item.id} onClick={() => onOpen(item.id)} variant="outline">
          <Codicon name={item.kind === 'subtitle' ? 'play' : item.kind === 'excel' ? 'table' : item.kind === 'pdf' ? 'file-pdf' : 'file-text'} />
          <span><strong>{item.filename}</strong><small>{stateLabel(item)}</small></span><Codicon name="arrow-right" />
        </Button>)}
      </div>
    </section>
    {!history && <section aria-label={c.formats} className="analysis-hub-formats">
      <header><h2>{c.formats}</h2><p>{c.ownSources}</p></header>
      <div>{formats.map(format => <Button className="analysis-hub-format" disabled={!format.link && importDisabled} key={format.label} onClick={format.link ? onFocusLink : onImport} variant="outline"><Codicon name={format.icon} size="1.5rem" /><strong>{format.label}</strong><span>{format.link ? c.link : c.local}<Codicon name="arrow-right" /></span></Button>)}</div>
    </section>}
  </div>
}
