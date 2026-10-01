import './analysis-workspace-frame.css'

import type { ReactNode } from 'react'
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { AnalysisDocument } from '../analysis-types'
import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'

import { ANALYSIS_WORKSPACE_COPY } from './analysis-workspace-copy'

export interface AnalysisWorkspaceFrameProps {
  source: AnalysisDocument
  locale: VideoBreakdownLocale
  reader: ReactNode
  companion: ReactNode
  notes: ReactNode
  jump: (id: string) => void
  label: (location: Record<string, number | string>) => string
  sourcePane?: 'source' | 'notes'
  onSourcePaneChange?: (pane: 'source' | 'notes') => void
}

export function AnalysisWorkspaceFrame({ source, locale, reader, companion, notes, jump, label, sourcePane, onSourcePaneChange }: AnalysisWorkspaceFrameProps) {
  const copy = ANALYSIS_WORKSPACE_COPY[locale]
  const video = source.kind === 'subtitle'
  const id = useId()
  const [internalPane, setInternalPane] = useState<'source' | 'notes'>('source')
  const selectedTab = (sourcePane ?? internalPane) === 'notes' ? 'notes' : video ? 'reader' : 'outline'

  const changePane = (value: string) => {
    const pane = value === 'notes' ? 'notes' : 'source'

    if (sourcePane === undefined) {setInternalPane(pane)}
    onSourcePaneChange?.(pane)
  }

  const readerId = `${id}-reader`
  const companionId = `${id}-companion`

  const directory = <nav aria-label={copy.outline} className="analysis-frame-outline">
    {(source.anchors ?? []).length === 0 && <EmptyState title={copy.emptyOutline} />}
    {(source.anchors ?? []).map(anchor => <Button aria-label={`${label(anchor.location)}: ${anchor.text.slice(0, 120)}`} className="w-full justify-start text-start"
      key={anchor.id} onClick={() => jump(anchor.id)} size="sm" type="button" variant="ghost">
      <span className="analysis-frame-anchor"><span>{label(anchor.location)}</span><strong>{anchor.text}</strong></span>
    </Button>)}
  </nav>

  return <div className="analysis-workspace-frame" data-mode={video ? 'video' : 'document'}>
    <nav aria-label={copy.navigation} className="analysis-frame-shortcuts">
      <a href={`#${readerId}`}>{video ? copy.jumpMedia : copy.jumpReader}</a>
      <a href={`#${companionId}`}>{copy.jumpCompanion}</a>
    </nav>
    <div className="analysis-frame-columns">
      <section aria-label={video ? copy.media : copy.navigation} className="analysis-frame-source">
        <Tabs onValueChange={changePane} value={selectedTab}>
          <TabsList aria-label={copy.navigation}>
            <TabsTrigger value={video ? 'reader' : 'outline'}>{video ? copy.media : copy.outline}</TabsTrigger>
            <TabsTrigger value="notes">{copy.notes}</TabsTrigger>
          </TabsList>
          <TabsContent forceMount hidden={selectedTab === 'notes'} value={video ? 'reader' : 'outline'}>
            {video ? <div className="analysis-frame-reader-content" id={readerId} tabIndex={-1}>{reader}</div> : directory}
          </TabsContent>
          <TabsContent forceMount hidden={selectedTab !== 'notes'} value="notes">{notes}</TabsContent>
        </Tabs>
      </section>
      {!video && <section aria-label={copy.reader} className="analysis-frame-reader" id={readerId} tabIndex={-1}>
        <header><h2>{copy.reader}</h2></header>
        <div className="analysis-frame-reader-content">{reader}</div>
      </section>}
      <section aria-label={video ? copy.viewingCompanion : copy.readingCompanion} className="analysis-frame-companion" id={companionId} tabIndex={-1}>
        <header><h2>{video ? copy.viewingCompanion : copy.readingCompanion}</h2></header>
        <div className="analysis-frame-companion-content">{companion}</div>
      </section>
    </div>
  </div>
}
