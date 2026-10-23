/**
 * hc-1029: the account analysis transcribe routes as submit + poll.
 *
 * `/api/v1/account/analysis/video-links/transcribe` and `/upload-transcribe` used to
 * hold one request open while the server downloaded, extracted audio and waited on ASR
 * (up to 1850 s). On 2026-10-22 silent requests like that lost their answers on the
 * mainland broadband → Tencent HK/SG path (hc-978): the server sent the answer, the
 * client never saw it and waited out its timeout. Chromium already turns on TCP
 * keepalive for these sockets, but that reaches only the first proxy and only helps if
 * the middlebox counts probes, so the request itself must stop being long and silent.
 *
 * The submit carries `Prefer: respond-async`. A server with hc-1029 answers 202 with a
 * job id and we poll `jobs/<id>` next to the submit route; an older server ignores the
 * header and returns the whole result from the submit, exactly as before.
 */

export type AnalysisFetcher = (input: string, init: RequestInit) => Promise<Response>

export interface AnalysisJobTiming {
  /** An older server answers the submit only after ASR, so this stays as long as before. */
  submitTimeoutMs: number
  pollTimeoutMs: number
  /** How long polls may keep failing in a row before we stop and say so. */
  unreachableMs: number
  /** Total wait from the submit; nginx and the server give up at 1800 s. */
  maxWaitMs: number
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export const ANALYSIS_JOB_TIMING: AnalysisJobTiming = {
  submitTimeoutMs: 1_850_000,
  pollTimeoutMs: 30_000,
  unreachableMs: 120_000,
  maxWaitMs: 1_850_000,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now()
}

export interface AnalysisJobRequest {
  submitUrl: string
  bearer: string
  body: string | FormData
  headers?: Record<string, string>
  redirect: RequestRedirect
  fetcher: AnalysisFetcher
  timing?: Partial<AnalysisJobTiming>
}

export interface AnalysisJobResult {
  body: any
  renewedToken: string | null
}

type HttpError = Error & { statusCode?: number }

function httpError(status: number, text: string): HttpError {
  // Same shape as before (`<status>: <body>`): analysisIpcError reads detail.code from it.
  const error: HttpError = new Error(`${status}: ${text.slice(0, 1000)}`)
  error.statusCode = status

  return error
}

function parseJson(text: string): any {
  try { return JSON.parse(text) } catch { return undefined }
}

// Worth another poll: the answer was lost or the platform is restarting behind nginx.
const TRANSIENT_POLL_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

type PollOutcome = { state: 'lost' } | { state: 'running'; pollAfterSeconds: number } | { state: 'done'; body: any }

/** One poll answer (null: the request or its answer was lost). A failed job throws
 *  exactly what the synchronous route would have answered. */
function readPoll(poll: { status: number; text: string } | null): PollOutcome {
  if (poll && poll.status >= 300 && !TRANSIENT_POLL_STATUSES.has(poll.status)) {
    throw httpError(poll.status, poll.text) // 404 analysis_job_not_found, 401, 403
  }

  const job = poll && poll.status < 300 ? parseJson(poll.text) : undefined

  if (job === undefined) {return { state: 'lost' }}

  if (job?.status === 'running') {return { state: 'running', pollAfterSeconds: Number(job.poll_after_seconds) || 0 }}

  if (job?.status === 'done') {return { state: 'done', body: job }}

  if (job?.status === 'failed') {
    throw httpError(Number(job.error?.status_code) || 500, JSON.stringify({ detail: job.error?.detail ?? null }))
  }

  throw new Error('analysis_invalid_response')
}

export async function runAnalysisAsrJob(request: AnalysisJobRequest): Promise<AnalysisJobResult> {
  const timing = { ...ANALYSIS_JOB_TIMING, ...request.timing }
  const started = timing.now()
  let bearer = request.bearer
  let renewedToken: string | null = null

  const send = async (url: string, init: RequestInit, timeoutMs: number) => {
    const response = await request.fetcher(url, {
      ...init,
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', ...(init.headers as Record<string, string>) },
      redirect: request.redirect,
      signal: AbortSignal.timeout(timeoutMs)
    })

    const text = await response.text()
    const renewed = response.headers.get('x-apex-renewed-token')

    // hc-529 slides the login JWT on any authed answer; later polls use the new one.
    if (renewed) {
      renewedToken = renewed
      bearer = renewed
    }

    return { status: response.status, text }
  }

  const submit = await send(request.submitUrl, {
    method: 'POST',
    headers: { ...request.headers, Prefer: 'respond-async' },
    body: request.body
  }, timing.submitTimeoutMs)

  if (submit.status >= 400) {throw httpError(submit.status, submit.text)}
  const accepted = parseJson(submit.text)

  if (accepted === undefined) {throw new Error('analysis_invalid_response')}

  // An older server ignored the preference and already answered in full.
  if (submit.status !== 202 || accepted?.status !== 'running' || typeof accepted?.job_id !== 'string') {
    return { body: accepted, renewedToken }
  }

  const pollUrl = new URL(`jobs/${encodeURIComponent(accepted.job_id)}`, request.submitUrl).toString()
  let pollAfterSeconds = Number(accepted.poll_after_seconds) || 5
  let lastAnswer = timing.now()

  for (;;) {
    await timing.sleep(Math.min(15, Math.max(1, pollAfterSeconds)) * 1000)

    if (timing.now() - started > timing.maxWaitMs) {throw new Error('analysis_job_timeout')}

    const outcome = readPoll(await send(pollUrl, { method: 'GET' }, timing.pollTimeoutMs).catch(() => null))

    if (outcome.state === 'done') {return { body: outcome.body, renewedToken }}

    if (outcome.state === 'running') {
      lastAnswer = timing.now()
      pollAfterSeconds = outcome.pollAfterSeconds || pollAfterSeconds
    } else if (timing.now() - lastAnswer > timing.unreachableMs) {
      throw new Error('analysis_job_unreachable')
    }
  }
}

export function transcribeAnalysisVideoLink(
  apiBase: string,
  bearer: string,
  url: string,
  storageMode: 'local' | 'cloud',
  fetcher: AnalysisFetcher,
  timing?: Partial<AnalysisJobTiming>
): Promise<AnalysisJobResult> {
  return runAnalysisAsrJob({
    submitUrl: `${apiBase}/api/v1/account/analysis/video-links/transcribe`,
    bearer,
    body: JSON.stringify({ url, storage_mode: storageMode }),
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    fetcher,
    timing
  })
}
