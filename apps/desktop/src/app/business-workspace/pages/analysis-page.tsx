import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { Button } from '@/components/ui/button'
import { ErrorBanner } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { $connection } from '@/store/session'

import { analysisDocumentsBridge } from '../analysis-bridge'
import { ANALYSIS_PAGE_COPY as COPY } from '../analysis-page-copy'
import { parseAnalysisSourceLink } from '../analysis-source-link'
import { ANALYSIS_SOURCE_LINK_COPY } from '../analysis-source-link-copy'
import type { AnalysisDocument, AnalysisQuestion, AnalysisVideoResolution } from '../analysis-types'
import { captureWorkflowMutationScope } from '../api/mutation-scope'
import { $workflowDomainAccountScope, $workflowDomainRevision, workflowDomainUrgentRevision, workflowWindowIsViewed } from '../api/read-revision'
import { AnalysisNotesPanel } from '../components/analysis-notes-panel'
import { AnalysisSourceHub } from '../components/analysis-source-hub'
import { ANALYSIS_HUB_COPY } from '../components/analysis-source-hub-copy'
import { AnalysisSpreadsheet } from '../components/analysis-spreadsheet'
import { AnalysisWorkspaceFrame } from '../components/analysis-workspace-frame'
import { DeepAnalysisReports } from '../components/deep-analysis-reports'
import { SOURCE_ANSWER_COPY, SourceQuestionAction } from '../components/source-question-answer'
import { VideoAnalysisModes } from '../components/video-analysis-modes'
import { VideoSemanticOverviewPanel } from '../components/video-semantic-overview'
import { WorkflowRefreshNotice } from '../components/workflow-refresh-notice'
import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'
import { captureVideoFrame, sampleVideoFrames } from '../video-frame-evidence'
import { videoQuickOverview } from '../video-quick-overview'
import { VIDEO_TRANSCRIPT_COPY } from '../video-transcript-draft'
import { VIDEO_WORKSPACE_COPY } from '../video-workspace-draft'

function timestamp(seconds: number): string {
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60

  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`
}

function frameTimestamp(seconds: number): string {
  const tenths = Math.floor(seconds * 10 + 1e-6)

  return `${timestamp(Math.floor(tenths / 10))}.${tenths % 10}`
}

function locationLabel(location: Record<string, number | string>, copy: { page: string; paragraph: string; sheet: string; timestamp: string }): string {
  if (typeof location.start_seconds === 'number') {return copy.timestamp.replace('{time}', timestamp(location.start_seconds))}

  if (location.page) {return copy.page.replace('{n}', String(location.page))}

  if (location.sheet) {return copy.sheet.replace('{sheet}', String(location.sheet)).replace('{cell}', String(location.cell))}

  return copy.paragraph.replace('{n}', String(location.paragraph || 1))
}

const bridge = analysisDocumentsBridge

function humanError(code: string, copy: { cloudUnavailable: string; empty: string; error: string; failed: string; noSourceText: string; permission: string; subtitleInvalid: string; videoNoTiming: string; videoFileTooLarge: string; videoFileUnsupported: string; videoEmpty: string; mediaQuota: string }): string {
  if (['no_readable_text', 'empty_file'].includes(code)) {return copy.noSourceText}

  if (['analysis_cloud_storage_unavailable', 'cloud_upload_failed', 'download_unavailable'].includes(code)) {return copy.cloudUnavailable}

  if (['permission_denied', 'analysis_cloud_storage_disabled', 'feishu_permission_denied', 'feishu_authorization_required', 'feishu_identity_mismatch', 'feishu_binding_required', 'feishu_scope_unavailable'].includes(code)) {return copy.permission}

  if (code === 'unsupported_format') {return copy.empty}

  if (['invalid_subtitle', 'invalid_subtitle_timing'].includes(code)) {return copy.subtitleInvalid}

  if (['timed_evidence_unavailable', 'timed_evidence_invalid'].includes(code)) {return copy.videoNoTiming}

  if (code === 'video_file_too_large') {return copy.videoFileTooLarge}

  if (code === 'video_file_unsupported') {return copy.videoFileUnsupported}

  if (code === 'empty_video_file') {return copy.videoEmpty}

  if (code === 'media_quota_exceeded') {return copy.mediaQuota}

  if (['parse_failed', 'parse_interrupted'].includes(code)) {return copy.failed}

  return copy.error
}

export function AnalysisView({ onDeepBreakdown }: {
  onDeepBreakdown?: (document: AnalysisDocument, locale: VideoBreakdownLocale, frames: ReadonlyArray<{ seconds: number; dataUrl: string }>) => Promise<void> | void
}) {
  const { locale } = useI18n()
  const c = COPY[locale]
  const sourceLinkCopy = ANALYSIS_SOURCE_LINK_COPY[locale]
  const connection = useStore($connection)
  const revision = useStore($workflowDomainRevision)
  const accountScope = useStore($workflowDomainAccountScope)
  const seenRevision = useRef({ revision, urgent: workflowDomainUrgentRevision() })
  const [policy, setPolicy] = useState<{ mode: 'cloud' | 'local'; cloud_storage_configured: boolean } | null>(null)
  const [policyLoading, setPolicyLoading] = useState(true)
  const [policyError, setPolicyError] = useState('')
  const policyRequestRef = useRef(0)
  const [items, setItems] = useState<AnalysisDocument[]>([])
  const [listStatus, setListStatus] = useState<'error' | 'loading' | 'ready'>('loading')
  const listRequestRef = useRef(0)
  const listPending = useRef<{ owner: string; urgent: number; request: number } | null>(null)
  const [listRefreshFailed, setListRefreshFailed] = useState(false)
  const [detailRefreshFailed, setDetailRefreshFailed] = useState(false)
  const [selected, setSelected] = useState<AnalysisDocument | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const selectedDocumentIdRef = useRef<string | null>(null)
  const openedDocumentIdRef = useRef<string | null>(null)
  const openRequestRef = useRef(0)
  const detailPending = useRef<{ owner: string; urgent: number; request: number; id: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const operationRef = useRef(0)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const linkInputRef = useRef<HTMLInputElement>(null)
  const [workspaceVisible, setWorkspaceVisible] = useState(true)
  const [readingPane, setReadingPane] = useState<'source' | 'notes'>('source')
  const [historyVisible, setHistoryVisible] = useState(false)
  const sourceLink = parseAnalysisSourceLink(link)
  const composingLink = useRef(false)
  const [videoResolution, setVideoResolution] = useState<AnalysisVideoResolution | null>(null)
  const [transcribingVideo, setTranscribingVideo] = useState(false)
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const [authFlow, setAuthFlow] = useState<{ id: string; interval: number } | null>(null)
  const [feishuAuthorized, setFeishuAuthorized] = useState(false)
  const [question, setQuestion] = useState('')
  const [note, setNote] = useState('')
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [pdfPreview, setPdfPreview] = useState<{ id: string; url: string } | null>(null)
  const [pdfPage, setPdfPage] = useState(1)
  const [pdfError, setPdfError] = useState(false)
  const [localVideo, setLocalVideo] = useState<{ documentId: string; name: string; url: string } | null>(null)
  const [frames, setFrames] = useState<Array<{ id: number; videoUrl: string; seconds: number; dataUrl: string }>>([])
  const frameIdRef = useRef(0)
  const [videoError, setVideoError] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const selectedId = selected?.id
  const selectedKind = selected?.kind
  const selectedStatus = selected?.status
  const activeVideo = localVideo?.documentId === selectedId ? localVideo : null
  const quickOverview = videoQuickOverview(selected)
  useEffect(() => () => {
    if (localVideo) {URL.revokeObjectURL(localVideo.url)}
  }, [localVideo])

  const refreshPolicy = useCallback(async (background = false) => {
    const request = ++policyRequestRef.current
    const owner = $workflowDomainAccountScope.get()
    setPolicyLoading(true)
    setPolicyError('')

    if (!background) {setPolicy(null)}

    try {
      const result = await bridge()?.policy()

      if (request !== policyRequestRef.current || owner !== $workflowDomainAccountScope.get()) {return null}

      if (result?.ok && result.policy && ['cloud', 'local'].includes(result.policy.mode) && typeof result.policy.cloud_storage_configured === 'boolean') {
        setPolicy(result.policy)

        return result.policy
      }

      setPolicyError(result?.code ?? 'analysis_policy_unavailable')
      setPolicy(null)
    } catch {
      if (request === policyRequestRef.current && owner === $workflowDomainAccountScope.get()) {
        setPolicyError('analysis_policy_unavailable'); setPolicy(null)
      }
    } finally {
      if (request === policyRequestRef.current && owner === $workflowDomainAccountScope.get()) {setPolicyLoading(false)}
    }

    return null
  }, [])

  const refreshList = useCallback(async (background = false) => {
    const owner = $workflowDomainAccountScope.get()
    const urgent = workflowDomainUrgentRevision()

    if (background && listPending.current?.owner === owner && listPending.current.urgent === urgent) {return}
    const request = ++listRequestRef.current
    listPending.current = { owner, urgent, request }

    if (!background) {setListStatus('loading')}

    try {
      const result = await bridge()?.list()

      if (request !== listRequestRef.current || owner !== $workflowDomainAccountScope.get() || urgent !== workflowDomainUrgentRevision()) {return}

      if (result?.ok && Array.isArray(result.items)) {
        const incoming = result.items
        setItems(current => result.cloudUnavailable ? [...incoming.filter(item => item.storageMode === 'local'), ...current.filter(item => item.storageMode === 'cloud')] : incoming)
        setListStatus('ready')
        setListRefreshFailed(Boolean(result.cloudUnavailable))
      } else {
        if (!background) {setListStatus('error')}
        setListRefreshFailed(true)
      }
    } catch {
      if (request === listRequestRef.current && owner === $workflowDomainAccountScope.get() && urgent === workflowDomainUrgentRevision()) {
        if (!background) {setListStatus('error')}
        setListRefreshFailed(true)
      }
    } finally {
      if (listPending.current?.request === request) {listPending.current = null}
    }
  }, [])

  const openDocument = useCallback(async (id: string, select = false, background = false) => {
    if (select) {
      const switchingSource = openedDocumentIdRef.current !== id
      selectedDocumentIdRef.current = id

      if (switchingSource) {
        setReadingPane('source')
        openedDocumentIdRef.current = null
        setSelected(null)
        setOpeningId(id)
        setLocalVideo(null)
        setFrames([])
        setVideoError('')
        setQuestion('')
        setNote('')
        setAnchorId(null)
        setError('')
        setDetailRefreshFailed(false)
      }
    } else if (selectedDocumentIdRef.current !== id) {
      return
    }

    const owner = $workflowDomainAccountScope.get()
    const urgent = workflowDomainUrgentRevision()

    if (background && detailPending.current?.id === id && detailPending.current.owner === owner && detailPending.current.urgent === urgent) {return}
    const request = ++openRequestRef.current
    detailPending.current = { owner, urgent, request, id }

    try {
      const result = await bridge()?.get(id)

      if (request !== openRequestRef.current || selectedDocumentIdRef.current !== id || owner !== $workflowDomainAccountScope.get() || urgent !== workflowDomainUrgentRevision()) {return}

      if (result?.ok && result.item?.id === id) {
        openedDocumentIdRef.current = id
        setSelected(result.item)

        if (select) {setWorkspaceVisible(true)}
        setDetailRefreshFailed(false)

        if (!background) {setVideoError('')}
      } else if (result?.code === 'source_not_found') {
        selectedDocumentIdRef.current = null
        openedDocumentIdRef.current = null
        setSelected(null); setOpeningId(null); setLocalVideo(null); setFrames([])
        setItems(current => current.filter(item => item.id !== id))
        setDetailRefreshFailed(false)
      } else {
        if (background) {setDetailRefreshFailed(true)}
        else {setError(result?.code ?? c.error)}
      }
    } catch {
      if (request === openRequestRef.current && selectedDocumentIdRef.current === id && owner === $workflowDomainAccountScope.get() && urgent === workflowDomainUrgentRevision()) {
        if (background) {setDetailRefreshFailed(true)} else {setError(c.error)}
      }
    } finally {
      if (detailPending.current?.request === request) {detailPending.current = null}

      if (request === openRequestRef.current && selectedDocumentIdRef.current === id && owner === $workflowDomainAccountScope.get()) {setOpeningId(null)}
    }
  }, [c.error])

  // eslint-disable-next-line no-restricted-syntax -- Request generation invalidates late reads when the account workspace unmounts.
  useEffect(() => {
    void refreshPolicy()

    return () => {policyRequestRef.current += 1}
  }, [accountScope, refreshPolicy])
  // eslint-disable-next-line no-restricted-syntax -- Request and selected-object lifetime, without mirroring an atom.
  useEffect(() => {
    setItems([]); setSelected(null); setOpeningId(null); setLocalVideo(null); setFrames([])
    setWorkspaceVisible(true); setHistoryVisible(false); setReadingPane('source')
    operationRef.current += 1; busyRef.current = false; setBusy(false); setTranscribingVideo(false); setUploadingVideo(false)
    setQuestion(''); setNote(''); setAnchorId(null); setLink(''); setVideoResolution(null); setError(''); setVideoError(''); setAuthFlow(null); setFeishuAuthorized(false)
    selectedDocumentIdRef.current = null; openedDocumentIdRef.current = null
    setListRefreshFailed(false); setDetailRefreshFailed(false)
    void refreshList()

    return () => {listRequestRef.current += 1; openRequestRef.current += 1; operationRef.current += 1}
  }, [accountScope, refreshList])

  const refreshSources = useCallback(() => {
    void refreshList(true)
    const id = selectedDocumentIdRef.current

    if (id) {void openDocument(id, false, true)}
  }, [openDocument, refreshList])

  // eslint-disable-next-line no-restricted-syntax -- Track consumed invalidations; callback ownership reads the account atom directly.
  useEffect(() => {
    const urgent = workflowDomainUrgentRevision()
    const changed = seenRevision.current.revision !== revision
    const forced = seenRevision.current.urgent !== urgent
    seenRevision.current = { revision, urgent }

    if (!changed || (selectedStatus === 'processing' && !forced)) {return}
    refreshSources()
    void refreshPolicy(true)
  }, [refreshPolicy, refreshSources, revision, selectedStatus])
  useEffect(() => {
    if (selected?.status !== 'processing') {return}

    const timer = window.setInterval(() => {
      if (!workflowWindowIsViewed()) {return}
      void openDocument(selected.id, false, true)
      void refreshList(true)
    }, 2000)

    return () => window.clearInterval(timer)
  }, [selected?.id, selected?.status, openDocument, refreshList])
  useEffect(() => {
    setPdfPreview(null)
    setPdfPage(1)
    setPdfError(false)

    if (!selectedId || selectedKind !== 'pdf' || selectedStatus !== 'ready') {return}
    let active = true
    let objectUrl = ''
    void bridge()?.previewPdf?.(selectedId).then(result => {
      if (!active) {return}

      try {
        const prefix = 'data:application/pdf;base64,'

        if (!result.ok || !result.data_url?.startsWith(prefix) || typeof URL.createObjectURL !== 'function') {throw new Error('preview_unavailable')}
        const binary = atob(result.data_url.slice(prefix.length))

        if (!binary.startsWith('%PDF-')) {throw new Error('preview_unavailable')}
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: 'application/pdf' }))
        setPdfPreview({ id: selectedId, url: objectUrl })
      } catch {setPdfError(true)}
    }).catch(() => {if (active) {setPdfError(true)}})

    return () => {
      active = false

      if (objectUrl) {URL.revokeObjectURL(objectUrl)}
    }
  }, [selectedId, selectedKind, selectedStatus])
  useEffect(() => {
    if (!authFlow) {return}
    const isCurrent = captureWorkflowMutationScope()
    let active = true

    const timer = window.setTimeout(() => {
      void bridge()?.pollFeishu(authFlow.id).then(result => {
        if (!active || !isCurrent()) {return}

        if (!result?.ok) {setAuthFlow(null); setError(result?.code ?? c.error);

 return }

        if (result.status === 'authorized') {setAuthFlow(null); setFeishuAuthorized(true);

 return }

        if (result.status !== 'pending') {setAuthFlow(null); setError('feishu_authorization_required');

 return }

        setAuthFlow({ ...authFlow, interval: result.interval ?? authFlow.interval })
      })
    }, authFlow.interval * 1000)

    return () => {active = false; window.clearTimeout(timer)}
  }, [authFlow, c.error])

  const perform = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    if (busyRef.current) {return}
    const ownerIsCurrent = captureWorkflowMutationScope()
    const operation = ++operationRef.current
    const isCurrent = () => ownerIsCurrent() && operation === operationRef.current
    busyRef.current = true; setBusy(true); setError('')

    try {await action(isCurrent)} catch {if (isCurrent()) {setError(c.error)}}
    finally {if (isCurrent()) {busyRef.current = false; setBusy(false)}}
  }

  const acceptTimedTranscript = async (result: { ok: boolean; code?: string; item?: AnalysisDocument } | undefined, isCurrent: () => boolean) => {
    if (!isCurrent()) {return}

    if (!result?.ok || !result.item) {
      if (result?.code !== 'cancelled') {setError(result?.code ?? c.error)}

      return
    }

    const timedEvidence = result.item.kind === 'subtitle' && result.item.status === 'ready' && result.item.anchors?.some(anchor =>
      typeof anchor.location.start_seconds === 'number' && Number.isFinite(anchor.location.start_seconds)
      && anchor.location.start_seconds >= 0
      && typeof anchor.location.end_seconds === 'number' && Number.isFinite(anchor.location.end_seconds)
      && anchor.location.end_seconds > anchor.location.start_seconds && !!anchor.text.trim())

    if (!timedEvidence) {setError('timed_evidence_unavailable');

 return}

    setLink('')
    setVideoResolution(null)
    await refreshList()

    if (!isCurrent()) {return}
    await openDocument(result.item.id, true)
  }

  const transcribeResolvedVideo = async (sourceUrl: string, isCurrent: () => boolean) => {
    if (!isCurrent()) {return}
    setTranscribingVideo(true)

    try {await acceptTimedTranscript(await bridge()?.transcribeVideoLink(sourceUrl), isCurrent)}
    finally {if (isCurrent()) {setTranscribingVideo(false)}}
  }

  const openSourceLink = () => {
    const sourceUrl = sourceLink.url

    if (!sourceUrl || composingLink.current) {return}
    void perform(async isCurrent => {
      if (sourceLink.isFeishu) {
        const result = await bridge()?.importLink(sourceUrl)

          if (!isCurrent()) {return}

        if (!result?.ok || !result.item) {setError(result?.code ?? c.error);

 return}

        setLink('')
        await refreshList()

        if (!isCurrent()) {return}
        await openDocument(result.item.id, true)

        return
      }

      const result = await bridge()?.resolveVideoLink(sourceUrl)

          if (!isCurrent()) {return}

      if (!result?.ok || !result.resolution) {setError(result?.code ?? c.error);

 return}

      setVideoResolution(result.resolution)

      if (!result.resolution.source_url || !['download_candidate', 'audio_candidate'].includes(result.resolution.capability ?? '')) {return}
      const effectivePolicy = policy ?? await refreshPolicy()

      if (!isCurrent()) {return}

      if (effectivePolicy && (effectivePolicy.mode === 'local' || effectivePolicy.cloud_storage_configured)) {
        await transcribeResolvedVideo(result.resolution.source_url, isCurrent)
      }
    })
  }

  const captureCurrentFrame = () => {
    const player = videoRef.current

    if (!activeVideo || !player) {
      setVideoError(c.frameFailed)

      return
    }

    try {
      const frame = { id: ++frameIdRef.current, videoUrl: activeVideo.url, ...captureVideoFrame(player) }
      setFrames(previous => [...previous.filter(item => item.videoUrl === activeVideo.url).slice(-2), frame])
      setVideoError('')
    } catch {
      setVideoError(c.frameFailed)
    }
  }

  const jump = (id: string) => {
    const sourceLocation = selected?.anchors?.find(anchor => anchor.id === id)?.location

    if (!sourceLocation || selectedDocumentIdRef.current !== selected?.id) {return}
    flushSync(() => setReadingPane('source'))

    if (selected?.kind === 'pdf' && typeof sourceLocation?.page === 'number') {setPdfPage(sourceLocation.page)}

    if (selected?.kind === 'subtitle' && activeVideo && videoRef.current && typeof sourceLocation?.start_seconds === 'number') {
      const seconds = sourceLocation.start_seconds
      const player = videoRef.current

      if (Number.isFinite(seconds) && seconds >= 0) {
        if (player.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(player.duration) && seconds > player.duration) {setVideoError(c.videoTimeOutside)}
        else {player.currentTime = seconds; setVideoError('')}
      }
    }

    document.getElementById(`analysis-anchor-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const answer = (item: AnalysisQuestion) => (
    <article className="rounded-xl border border-(--ui-border) p-4" key={item.id}>
      <h4 className="font-medium">{item.question}</h4>
      {item.answer_type.startsWith('semantic_') && <p className="text-xs text-(--ui-text-tertiary)">{SOURCE_ANSWER_COPY[locale].label}</p>}
      {item.source_revision && item.source_revision !== selected?.analysis_revision && <p className="text-xs">{SOURCE_ANSWER_COPY[locale].stale}</p>}
      <p className="mt-2 whitespace-pre-wrap text-sm text-(--ui-text-secondary)">{item.answer_type === 'no_evidence' ? c.noEvidence : item.answer_type === 'semantic_no_evidence' ? SOURCE_ANSWER_COPY[locale].noEvidence : item.answer}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {item.citations.map(citation => {
          const sourceAnchor = selected?.anchors?.find(anchor => anchor.id === citation.anchor_id)

          return sourceAnchor && (!item.source_revision || item.source_revision === selected?.analysis_revision) && <button className="rounded-lg border px-2 py-1 text-xs" key={citation.anchor_id} onClick={() => jump(citation.anchor_id)} type="button">
            {c.citation} · {locationLabel(sourceAnchor.location, c)}
          </button>
        })}
      </div>
    </article>
  )

  const workspaceNotes = selected?.status === 'ready' && <AnalysisNotesPanel anchorId={anchorId} busy={busy} copy={c} draft={note}
    notes={selected.notes ?? []} onChange={setNote} onDelete={id => void perform(async isCurrent => {
                  const sourceId = selected.id
                  const result = await bridge()?.deleteNote(sourceId, id)

          if (!isCurrent()) {return}

                  if (!result?.ok) {if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return}

                  await openDocument(sourceId)
    })} onJump={jump} onSave={() => void perform(async isCurrent => {
                  const sourceId = selected.id
                  const result = await bridge()?.addNote(sourceId, note, anchorId)

          if (!isCurrent()) {return}

                  if (!result?.ok) { if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return }

                  if (selectedDocumentIdRef.current === sourceId) {setNote(''); setAnchorId(null)}
                  await openDocument(sourceId)
    })} />

  const workspaceReader = selected && <>            {selected.kind === 'pdf' && selected.status === 'ready' && <section className="rounded-xl border p-4">
              <h3 className="mb-3 font-medium">{c.pdfOriginal} · {c.page.replace('{n}', String(pdfPage))}</h3>
              {pdfPreview?.id === selected.id && <iframe aria-label={c.pdfOriginal} className="h-96 w-full rounded-lg border bg-white" key={`${pdfPreview.url}-${pdfPage}`} src={`${pdfPreview.url}#page=${pdfPage}`} title={c.pdfOriginal} />}
              {pdfError && <p className="text-sm text-(--ui-text-secondary)">{c.pdfPreviewUnavailable}</p>}
            </section>}
            {selected.kind === 'subtitle' && selected.status === 'ready' && <section className="space-y-3 rounded-xl border p-4">
              <h3 className="font-medium">{c.videoPlayer}</h3>
              <p className="text-xs text-(--ui-text-secondary)">{c.videoPairing}</p>
              <label className="inline-block cursor-pointer rounded-lg border px-3 py-2 text-sm">
                {c.attachVideo}
                <input accept="video/*" aria-label={c.attachVideo} className="sr-only" onChange={event => {
                  const file = event.target.files?.[0]
                  event.target.value = ''

                  if (!file) {return}

                  if (!file.type.startsWith('video/') && !(!file.type && /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(file.name))) {
                    setVideoError(c.videoUnsupported)

                    return
                  }

                  setLocalVideo({ documentId: selected.id, name: file.name, url: URL.createObjectURL(file) })
                  setFrames([])
                  setVideoError('')
                }} type="file" />
              </label>
              {activeVideo && <video aria-label={`${c.videoPlayer}: ${activeVideo.name}`} className="w-full rounded-lg bg-black" controls onError={() => setVideoError(c.videoPlaybackFailed)} preload="metadata" ref={videoRef} src={activeVideo.url} />}
              {activeVideo && <button className="rounded-lg border px-3 py-2 text-sm" onClick={captureCurrentFrame} type="button">{c.frameCapture}</button>}
              {activeVideo && frames.some(frame => frame.videoUrl === activeVideo.url) && <div aria-label={c.frameEvidence} className="space-y-2" role="region">
                <p className="text-xs text-(--ui-text-tertiary)">{c.frameBoundary}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {frames.filter(frame => frame.videoUrl === activeVideo.url).map(frame => <figure className="rounded-lg border p-2" key={frame.id}>
                    <img alt={`${c.frameEvidence} · ${frameTimestamp(frame.seconds)}`} className="w-full rounded bg-black" src={frame.dataUrl} />
                    <figcaption className="mt-1 text-xs text-(--ui-text-secondary)">{frameTimestamp(frame.seconds)}</figcaption>
                  </figure>)}
                </div>
              </div>}
              {videoError && <p className="text-sm text-destructive" role="alert">{videoError}</p>}
            </section>}
{selected.status === 'ready' && <>              <section className="space-y-3"><h3 className="font-medium">{c.evidence}</h3>
                {(selected.anchors ?? []).length === 0 && <p>{c.noSourceText}</p>}
                {selected.kind === 'excel' ? <AnalysisSpreadsheet anchors={selected.anchors ?? []} label={location => locationLabel(location, c)}
                  locale={locale} onSelect={id => { setAnchorId(id); setNote(''); setReadingPane('notes') }} /> : (selected.anchors ?? []).map(anchor => <article className="scroll-mt-5 rounded-xl border p-4" id={`analysis-anchor-${anchor.id}`} key={anchor.id}><div className="flex justify-between gap-3 text-xs text-(--ui-text-secondary)"><span>{locationLabel(anchor.location, c)}</span><button className="underline" onClick={() => { setAnchorId(anchor.id); setNote(''); setReadingPane('notes') }} type="button">{c.anchorNote}</button></div><p className="mt-2 whitespace-pre-wrap text-sm">{anchor.text}</p></article>)}
              </section>
</>}</>

  const workspaceReports = selected && <> {(quickOverview || !!selected.deep_reports?.length) && <DeepAnalysisReports bridge={bridge()} key={`reports:${selected.analysis_scope}:${selected.id}:${selected.analysis_revision}`} locale={locale} onChange={reports => {
              setSelected(current => current?.id === selected.id && current.analysis_scope === selected.analysis_scope && current.analysis_revision === selected.analysis_revision
                ? { ...current, deep_reports: reports } : current)
            }} source={selected} />} </>

  const workspaceQuick = selected?.status === 'ready' && <> {quickOverview && <VideoSemanticOverviewPanel bridge={bridge()} jump={jump} key={`${selected.analysis_scope}:${selected.id}:${selected.analysis_revision}:${locale}`} label={location => locationLabel(location, c)} locale={locale} source={selected} />}
              {quickOverview && <section aria-label={c.quickTitle} className="space-y-3 rounded-xl border p-4">
                <h3 className="font-medium">{c.quickTitle}</h3>
                <p className="text-sm text-(--ui-text-secondary)">{c.quickCoverage.replace('{count}', String(quickOverview.count)).replace('{start}', timestamp(quickOverview.firstSeconds)).replace('{end}', timestamp(quickOverview.lastSeconds))}</p>
                <p className="text-xs text-(--ui-text-tertiary)">{c.quickBoundary}</p>
                <div className="grid gap-2 md:grid-cols-3">
                  {quickOverview.samples.map(anchor => <button className="min-w-0 rounded-lg border p-3 text-left text-sm hover:bg-(--ui-row-active-background)" key={anchor.id} onClick={() => jump(anchor.id)} type="button">
                    <span className="block text-xs text-(--ui-text-secondary)">{c.quickJump} · {locationLabel(anchor.location, c)}</span>
                    <span className="mt-1 block line-clamp-3 whitespace-pre-wrap">{anchor.text}</span>
                  </button>)}
                </div>
              </section>} </>

  const workspaceDeep = selected?.status === 'ready' && <> {quickOverview && onDeepBreakdown && <div className="space-y-1">
                  <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={busy || connection?.mode === 'remote'} onClick={() => void perform(async isCurrent => {
                    let visualEvidence = activeVideo ? frames.filter(frame => frame.videoUrl === activeVideo.url) : []

                    if (activeVideo && visualEvidence.length < 3) {
                      const seconds = quickOverview.samples
                        .map(anchor => Number(anchor.location.start_seconds) + Math.min(0.25, (Number(anchor.location.end_seconds) - Number(anchor.location.start_seconds)) / 2))
                        .filter(second => visualEvidence.every(frame => Math.abs(frame.seconds - second) > 0.1))
                        .slice(0, 3 - visualEvidence.length)

                      const sampled = await sampleVideoFrames(activeVideo.url, seconds)

                      if (!isCurrent() || selectedDocumentIdRef.current !== selected.id || videoRef.current?.src !== activeVideo.url) {return}
                      visualEvidence = [...visualEvidence, ...sampled.map(frame => ({ ...frame, id: ++frameIdRef.current, videoUrl: activeVideo.url }))].slice(-3)

                      if (sampled.length) {setFrames(visualEvidence); setVideoError('')}
                      else if (!visualEvidence.length) {setVideoError(c.frameFailed)}
                    }

                    if (!isCurrent()) {return}
                    await onDeepBreakdown(selected, locale, visualEvidence)
                  })} type="button">{c.deepAction}</button>
                  {connection?.mode !== 'remote' && <p className="text-xs text-(--ui-text-tertiary)">{VIDEO_TRANSCRIPT_COPY[locale].notice}</p>}
                  {connection?.mode !== 'remote' && bridge()?.prepareDeepWorkspace && <p className="text-xs text-(--ui-text-tertiary)">{VIDEO_WORKSPACE_COPY[locale].notice}</p>}
                  <p className="text-xs text-(--ui-text-tertiary)">{connection?.mode === 'remote' ? c.deepLocalOnly : activeVideo ? frames.some(frame => frame.videoUrl === activeVideo.url) ? c.deepFrameDisclosure : c.deepAutoFrameDisclosure : c.deepDisclosure}</p>
                </div>}{workspaceReports} </>

  const workspaceQuestions = selected?.status === 'ready' && <> <section className="space-y-3 rounded-xl border p-4">
                <h3 className="font-medium">{c.question}</h3>
                <div className="flex gap-2"><input aria-label={c.question} className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" onChange={event => setQuestion(event.target.value)} value={question} /><button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || question.trim().length < 2} onClick={() => void perform(async isCurrent => {
                  const sourceId = selected.id
                  const result = await bridge()?.ask(sourceId, question)

          if (!isCurrent()) {return}

                  if (!result?.ok) { if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return }

                  if (selectedDocumentIdRef.current === sourceId) {setQuestion('')}
                  await openDocument(sourceId)
                })} type="button">{c.ask}</button></div>
                <SourceQuestionAction bridge={bridge()} locale={locale} onSaved={async id => {
                  if (selectedDocumentIdRef.current === id) {await openDocument(id)}
                }} question={question} source={selected} />
                {(selected.questions ?? []).map(answer)}
              </section> </>

  const workspaceCompanion = selected?.kind === 'subtitle' ? <VideoAnalysisModes deep={workspaceDeep}
    key={`${selected.analysis_scope}:${selected.id}`} locale={locale} questions={workspaceQuestions} quick={quickOverview ? workspaceQuick : null} /> : <>{workspaceReports}{workspaceQuestions}</>

  const importDocument = () => void perform(async isCurrent => {
          const result = await bridge()?.importFile()

          if (!isCurrent()) {return}

          if (result?.code === 'cancelled') {return}

          if (!result?.ok || !result.item) { setError(result?.code ?? c.error);

 return }

          await refreshList()

          if (!isCurrent()) {return}
          await openDocument(result.item.id, true)
        })

  const sourceControls = <>      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); openSourceLink() }}>
        <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={busy || !policy || (policy.mode === 'cloud' && !policy.cloud_storage_configured)} onClick={importDocument} type="button">{c.import}</button>
        <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !policy || (policy.mode === 'cloud' && !policy.cloud_storage_configured)} onClick={() => void perform(async isCurrent => {
          setUploadingVideo(true)

          try {await acceptTimedTranscript(await bridge()?.uploadVideo(), isCurrent)}
          finally {if (isCurrent()) {setUploadingVideo(false)}}
        })} type="button">{uploadingVideo ? c.videoUploading : c.videoUploadLocal}</button>
        <Input aria-describedby="analysis-source-link-hint" aria-label={c.link} className="min-w-52 flex-1" disabled={busy}
          onChange={event => { setLink(event.target.value); setVideoResolution(null) }}
          onCompositionEnd={() => { composingLink.current = false }} onCompositionStart={() => { composingLink.current = true }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || composingLink.current) {return}
            event.preventDefault()

            if (!event.nativeEvent.isComposing) {openSourceLink()}
          }} placeholder={sourceLinkCopy.placeholder} ref={linkInputRef} type="text" value={link} />
        <Button disabled={busy || !sourceLink.url} type="submit">{sourceLinkCopy.open}</Button>
        {sourceLink.isFeishu && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !!authFlow} onClick={() => void perform(async isCurrent => {
          const result = await bridge()?.authorizeFeishu()

          if (!isCurrent()) {return}

          if (!result?.ok || !result.flow_id) {setError(result?.code ?? c.error);

 return }

          setAuthFlow({ id: result.flow_id, interval: result.interval ?? 5 }); setFeishuAuthorized(false)
        })} type="button">{c.authorize}</button>}
        {sourceLink.isFeishu && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={() => void perform(async isCurrent => {
          const result = await bridge()?.forgetFeishu()

          if (!isCurrent()) {return}

          if (!result?.ok) {setError(result?.code ?? c.error);

 return }

          setAuthFlow(null); setFeishuAuthorized(false)
        })} type="button">{c.forget}</button>}
        {videoResolution?.source_url && ['download_candidate', 'audio_candidate'].includes(videoResolution.capability ?? '') && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !policy || (policy.mode === 'cloud' && !policy.cloud_storage_configured)} onClick={() => void perform(async isCurrent => {
          await transcribeResolvedVideo(videoResolution.source_url!, isCurrent)
        })} type="button">{transcribingVideo ? c.videoAnalyzing : c.videoAnalyze}</button>}
        {sourceLink.url && <button className="rounded-lg border px-3 py-2" onClick={() => void window.hermesDesktop.openExternal(videoResolution?.source_url ?? sourceLink.url!)} type="button">{c.openLink}</button>}
      </form>
      <p className="text-xs text-(--ui-text-tertiary)">{c.videoUploadDisclosure}</p>
      <p className="text-sm text-(--ui-text-secondary)" id="analysis-source-link-hint">{sourceLink.error ? sourceLink.error === 'multiple_source_links' ? sourceLinkCopy.multiple : sourceLinkCopy.invalid : sourceLink.isFeishu ? authFlow ? c.authorizing : feishuAuthorized ? c.authorized : c.linkHint : videoResolution ? transcribingVideo ? c.videoAnalyzing : videoResolution.status === 'unreadable' ? c.videoUnreadable : (videoResolution.status === 'upload_required' ? c.videoUpload : c.videoCandidate).replace('{platform}', videoResolution.platform ?? '') : sourceLink.url ? sourceLinkCopy.ready : null}</p>
      {videoResolution?.source_url && ['download_candidate', 'audio_candidate'].includes(videoResolution.capability ?? '') && <p className="text-xs text-(--ui-text-tertiary)">{c.videoProcessingDisclosure}</p>}
</>

  const policyNotice =       <details className="analysis-storage-notice" open={policyLoading || !!policyError || (policy?.mode === 'cloud' && !policy.cloud_storage_configured) || undefined}>
        <summary className="font-medium">{policy ? policy.mode === 'cloud' ? c.cloud : c.local : policyLoading ? c.policyLoading : c.policyUnavailable}</summary>
        {policy && <p className="mt-1 text-(--ui-text-secondary)">{policy.mode === 'cloud' ? c.cloudDisclosure : c.localDisclosure}</p>}
        {policy?.mode === 'cloud' && !policy.cloud_storage_configured && <p className="mt-2 text-destructive">{c.cloudUnavailable}</p>}
        {policyError && <ErrorBanner className="mt-3">
          <span role="alert">{policyError === 'sign_in' ? c.policySignIn : policyError === 'permission_denied' ? c.policyDenied : c.policyReadFailed}</span>
          <Button className="mt-2" disabled={policyLoading} onClick={() => void refreshPolicy()} size="sm" variant="outline">{c.policyRetry}</Button>
        </ErrorBanner>}
      </details>

  const sourceStatus = <>
    {listStatus === 'loading' && <p className="text-sm text-(--ui-text-secondary)">{c.loadingSources}</p>}
    {listStatus === 'error' && <div className="space-y-2 text-sm text-destructive" role="alert"><p>{c.failedList}</p><Button disabled={busy} onClick={() => void refreshList()} variant="outline">{c.retryList}</Button></div>}
    {items.length === 0 && listStatus === 'ready' && !listRefreshFailed && <p className="text-sm text-(--ui-text-secondary)">{c.empty}</p>}
    {openingId && <p role="status">{c.opening}</p>}
  </>

  return <section className="apex-business-surface apex-business-page apex-primary-page overflow-y-auto analysis-prototype-surface">
    <div className="apex-primary-page-column space-y-5 pb-10">
      {policyNotice}
      {(!selected || !workspaceVisible) ? <AnalysisSourceHub controls={sourceControls} description={c.description}
        history={historyVisible} importDisabled={busy || !policy || (policy.mode === 'cloud' && !policy.cloud_storage_configured)}
        items={items} locale={locale} onFocusLink={() => linkInputRef.current?.focus()} onHistory={setHistoryVisible}
        onImport={importDocument} onOpen={id => void openDocument(id, true)} openingId={openingId}
        stateLabel={item => `${item.storageMode === 'cloud' ? c.cloud : c.local} · ${item.status === 'ready' ? c.ready : item.status === 'processing' ? c.processing : c.failed}`}
        status={sourceStatus} title={c.title} /> : <>
        <header className="analysis-workspace-header"><Button onClick={() => { setWorkspaceVisible(false); setHistoryVisible(false) }} variant="text">{ANALYSIS_HUB_COPY[locale].back}</Button><h1>{c.title}</h1><Button onClick={() => { setWorkspaceVisible(false); setHistoryVisible(true) }} variant="text">{c.source}</Button></header>
        {sourceControls}
      </>}
      {error && <p className="text-sm text-destructive" role="alert">{humanError(error, c)}</p>}
      <WorkflowRefreshNotice state={{ refreshFailed: listRefreshFailed || detailRefreshFailed, retry: refreshSources }} />
      {selected && workspaceVisible && <div className="analysis-open-source">
        <aside className="analysis-record-strip">
          <h3 className="font-medium">{c.source}</h3>
          {listStatus === 'loading' && <p className="text-sm text-(--ui-text-secondary)">{c.loadingSources}</p>}
          {listStatus === 'error' && <div className="space-y-2 text-sm text-destructive" role="alert"><p>{c.failedList}</p><button className="rounded-lg border px-3 py-1" onClick={() => void refreshList()} type="button">{c.retryList}</button></div>}
          {items.length === 0 && listStatus === 'ready' && !listRefreshFailed && <p className="text-sm text-(--ui-text-secondary)">{c.empty}</p>}
          {items.map(item => <button className={`block w-full rounded-xl border p-3 text-left ${(openingId ?? selected?.id) === item.id ? 'bg-(--ui-row-active-background)' : ''}`} key={item.id} onClick={() => void openDocument(item.id, true)} type="button">
            <span className="block truncate font-medium">{item.filename}</span>
            <span className="text-xs text-(--ui-text-secondary)">{item.storageMode === 'cloud' ? c.cloud : c.local} · {item.status === 'ready' ? c.ready : item.status === 'processing' ? c.processing : c.failed}</span>
          </button>)}
        </aside>
        <main className="min-w-0 space-y-5">
          {selected && <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
              <div><h3 className="font-semibold">{selected.filename}</h3><p className="text-xs text-(--ui-text-secondary)">{selected.status === 'ready' ? c.ready : selected.status === 'processing' ? c.processing : humanError(selected.error_code ?? '', c)}</p>{selected.kind === 'subtitle' && <p className="mt-1 text-xs text-(--ui-text-secondary)">{selected.evidence_origin || selected.evidenceOrigin ? c.videoTranscriptNotice : c.subtitleNotice}</p>}</div>
              <div className="flex gap-2">
                <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void perform(async isCurrent => {
                  const sourceId = selected.id
                  const result = await bridge()?.openSource(sourceId)

          if (!isCurrent()) {return}

                  if (!result?.ok && selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}
                })} type="button">{selected.kind === 'feishu' || (selected.kind === 'subtitle' && (selected.source_url || selected.sourceUrl)) ? c.openLink : c.open}</button>
                {(selected.storageMode === 'cloud' ? (selected.can_retry ?? selected.status === 'failed') : selected.status === 'failed') && <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => void perform(async isCurrent => {
                  const sourceId = selected.id
                  const result = await bridge()?.retry(sourceId)

          if (!isCurrent()) {return}

                  if (!result?.ok) { if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return }

                  await openDocument(sourceId)
                })} type="button">{c.retry}</button>}
                <button className="rounded-lg border px-3 py-2 text-sm text-destructive" onClick={() => void perform(async isCurrent => {
                  const sourceId = selected.id
                  const result = await bridge()?.delete(sourceId)

          if (!isCurrent()) {return}

                  if (!result?.ok) { if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return }

                  if (selectedDocumentIdRef.current === sourceId) {
                    selectedDocumentIdRef.current = null
                    openedDocumentIdRef.current = null
                    openRequestRef.current += 1
                    setSelected(null)
                    setOpeningId(null)
                    setLocalVideo(null)
                    setFrames([])
                  }

                  await refreshList()
                })} type="button">{c.remove}</button>
              </div>
            </div>
            <AnalysisWorkspaceFrame companion={workspaceCompanion} jump={jump} label={location => locationLabel(location, c)}
              locale={locale} notes={workspaceNotes} onSourcePaneChange={setReadingPane} reader={workspaceReader} source={selected} sourcePane={readingPane} />
          </>}
        </main>
      </div>}
    </div>
  </section>
}
