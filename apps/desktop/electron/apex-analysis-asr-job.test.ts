import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { type AnalysisJobTiming, runAnalysisAsrJob, transcribeAnalysisVideoLink } from './apex-analysis-asr-job'

const API = 'https://api.apex-nodes.com'
const SUBMIT = `${API}/api/v1/account/analysis/video-links/transcribe`
const POLL = `${API}/api/v1/account/analysis/video-links/jobs/job-1`
const PARSED = { filename: 'douyin-transcript.srt', srt: '1\n00:00:00,000 --> 00:00:01,000\n真话\n' }

type Step = Response | Error | (() => Response | Error)

// A clock that only moves when the job sleeps or a request "takes time".
function fakeTiming(overrides: Partial<AnalysisJobTiming> = {}) {
  let now = 0
  const sleeps: number[] = []

  const timing: Partial<AnalysisJobTiming> = {
    now: () => now,
    // Yield to the event loop so a job that never stops still lets the test time out.
    sleep: async ms => { sleeps.push(ms); now += ms; await new Promise(resolve => setImmediate(resolve)) },
    ...overrides
  }

  return { timing, sleeps, advance: (ms: number) => { now += ms }, elapsed: () => now }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function scripted(steps: Step[], onCall?: (url: string, init: RequestInit) => void) {
  const calls: Array<{ url: string; init: RequestInit }> = []

  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    onCall?.(url, init)
    const step = steps.length > 1 ? steps.shift()! : steps[0]
    const value = typeof step === 'function' ? step() : step

    if (value instanceof Error) {throw value}

    return value.clone()
  })

  return { fetcher, calls }
}

const running = (pollAfter = 5) => json(202, { ok: true, job_id: 'job-1', status: 'running', elapsed_seconds: 0, poll_after_seconds: pollAfter })
const done = (extra: Record<string, unknown> = {}) => json(200, { ok: true, job_id: 'job-1', status: 'done', elapsed_seconds: 42, parsed: PARSED, ...extra })

it('asks a current server for a job and polls the sibling jobs route until the result is ready', async () => {
  const { timing, sleeps } = fakeTiming()
  const { fetcher, calls } = scripted([running(), running(), done()])

  const result = await transcribeAnalysisVideoLink(API, 'jwt-1', 'https://v.douyin.com/abc/', 'local', fetcher, timing)

  expect(result).toEqual({ body: expect.objectContaining({ status: 'done', parsed: PARSED }), renewedToken: null })
  expect(calls.map(call => [call.init.method, call.url])).toEqual([['POST', SUBMIT], ['GET', POLL], ['GET', POLL]])
  expect(calls[0].init.headers).toEqual({
    Authorization: 'Bearer jwt-1', Accept: 'application/json', 'Content-Type': 'application/json', Prefer: 'respond-async'
  })
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: 'https://v.douyin.com/abc/', storage_mode: 'local' })
  expect(calls[1].init.headers).toEqual({ Authorization: 'Bearer jwt-1', Accept: 'application/json' })
  // Every request is short: polls never carry the old 1850 s budget.
  expect(sleeps).toEqual([5000, 5000])
})

it('takes the whole answer from an older server that ignores the preference', async () => {
  const { timing } = fakeTiming()
  const { fetcher, calls } = scripted([json(200, { parsed: PARSED }, { 'x-apex-renewed-token': 'jwt-2' })])

  const result = await transcribeAnalysisVideoLink(API, 'jwt-1', 'https://v.douyin.com/abc/', 'cloud', fetcher, timing)

  expect(result).toEqual({ body: { parsed: PARSED }, renewedToken: 'jwt-2' })
  expect(calls).toHaveLength(1)
})

it('reports a failed job with the same error the synchronous route gives', async () => {
  const detail = { code: 'timed_evidence_unavailable' }
  const { fetcher: oldServer } = scripted([json(422, { detail })])
  const { fetcher: newServer } = scripted([running(), json(200, { ok: false, job_id: 'job-1', status: 'failed', error: { status_code: 422, detail } })])

  const syncError = await transcribeAnalysisVideoLink(API, 'jwt', 'u', 'local', oldServer, fakeTiming().timing).catch(error => error)
  const jobError = await transcribeAnalysisVideoLink(API, 'jwt', 'u', 'local', newServer, fakeTiming().timing).catch(error => error)

  expect(jobError.statusCode).toBe(422)
  expect([jobError.message, jobError.statusCode]).toEqual([syncError.message, syncError.statusCode])
  // main.ts analysisIpcError reads the code from the JSON after the status.
  expect(JSON.parse(jobError.message.slice(jobError.message.indexOf('{'))).detail.code).toBe('timed_evidence_unavailable')
})

it('keeps polling through lost answers and restarts, then returns the result', async () => {
  const { timing } = fakeTiming()

  const { fetcher } = scripted([
    running(),
    new TypeError('fetch failed'),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    json(502, { detail: 'bad gateway' }),
    new Response('{"ok": tru', { status: 202 }), // answer cut off mid-body
    done()
  ])

  await expect(runAnalysisAsrJob({ submitUrl: SUBMIT, bearer: 'jwt', body: '{}', redirect: 'follow', fetcher, timing }))
    .resolves.toMatchObject({ body: { status: 'done', parsed: PARSED } })
})

it('stops about two minutes after the platform stops answering, instead of waiting out 1850 s', async () => {
  const { timing, elapsed } = fakeTiming()
  const { fetcher, calls } = scripted([running(), new TypeError('fetch failed')])

  await expect(runAnalysisAsrJob({ submitUrl: SUBMIT, bearer: 'jwt', body: '{}', redirect: 'follow', fetcher, timing }))
    .rejects.toThrow('analysis_job_unreachable')
  expect(elapsed()).toBeGreaterThan(120_000)
  expect(elapsed()).toBeLessThanOrEqual(130_000)
  expect(calls.length).toBeGreaterThan(20) // it did retry, every 5 s
})

it('says so when the platform no longer knows the job, without polling again', async () => {
  const { timing } = fakeTiming()
  const { fetcher, calls } = scripted([running(), json(404, { detail: { code: 'analysis_job_not_found' } })])

  const error = await runAnalysisAsrJob({ submitUrl: SUBMIT, bearer: 'jwt', body: '{}', redirect: 'follow', fetcher, timing }).catch(e => e)

  expect(error.statusCode).toBe(404)
  expect(error.message).toBe('404: {"detail":{"code":"analysis_job_not_found"}}')
  expect(calls).toHaveLength(2)
})

it('stops a job that is still running after the total budget', async () => {
  const { timing, elapsed } = fakeTiming({ maxWaitMs: 60_000 })
  const { fetcher } = scripted([running(15)])

  await expect(runAnalysisAsrJob({ submitUrl: SUBMIT, bearer: 'jwt', body: '{}', redirect: 'follow', fetcher, timing }))
    .rejects.toThrow('analysis_job_timeout')
  expect(elapsed()).toBeLessThanOrEqual(60_000 + 15_000)
})

it('polls with a renewed login token and hands it back for persisting', async () => {
  const { timing } = fakeTiming()
  const { fetcher, calls } = scripted([json(202, { status: 'running', job_id: 'job-1', poll_after_seconds: 1 }, { 'x-apex-renewed-token': 'jwt-2' }), done()])

  const result = await runAnalysisAsrJob({ submitUrl: SUBMIT, bearer: 'jwt-1', body: '{}', redirect: 'follow', fetcher, timing })

  expect(result.renewedToken).toBe('jwt-2')
  expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-2')
})

it('passes sign-in failures straight through', async () => {
  const { timing } = fakeTiming()
  const { fetcher } = scripted([running(), json(401, { detail: 'Not authenticated' })])

  await expect(runAnalysisAsrJob({ submitUrl: SUBMIT, bearer: 'jwt', body: '{}', redirect: 'follow', fetcher, timing }))
    .rejects.toMatchObject({ statusCode: 401 })
})

const servers: http.Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

it('cannot hang on a real connection whose poll answers never arrive', async () => {
  // The 2026-10-22 failure on a real socket: the server takes the request and the
  // answer never reaches us. Only short, bounded polls get the client out.
  const seen: string[] = []

  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)

    if (request.method === 'POST') {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'running', job_id: 'job-1', poll_after_seconds: 1 }))
    }
    // GET: accepted and never answered
  })

  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const started = Date.now()

  await expect(transcribeAnalysisVideoLink(base, 'jwt', 'u', 'local', (url, init) => fetch(url, init), {
    pollTimeoutMs: 200, unreachableMs: 1_000, sleep: () => new Promise(resolve => setTimeout(resolve, 20))
  })).rejects.toThrow('analysis_job_unreachable')

  expect(Date.now() - started).toBeLessThan(5_000)
  expect(seen[0]).toBe('POST /api/v1/account/analysis/video-links/transcribe')
  expect(seen.filter(line => line === 'GET /api/v1/account/analysis/video-links/jobs/job-1').length).toBeGreaterThan(1)
}, 15_000)

it('leaves main.ts no direct call to either transcribe route', () => {
  const source = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // Both routes now go through runAnalysisAsrJob: the link one by name, the upload one
  // through uploadAnalysisVideo, so neither can fall back to one long silent request.
  expect(source.match(/video-links\/transcribe/g) ?? []).toEqual([])
  expect(source.match(/video-links\/upload-transcribe/g)).toHaveLength(1)
  expect(source).toMatch(/uploadAnalysisVideo\(\s*`\$\{context\.apiBase\}\/api\/v1\/account\/analysis\/video-links\/upload-transcribe`/)
  expect(source).toMatch(/transcribeAnalysisVideoLink\(context\.apiBase, context\.bearer, url, context\.policy\.mode,/)
  expect(source).toMatch(/transcribeAnalysisVideoLink\([^\n]*\)\)\n\s*persistRenewedLoginToken\(renewedToken, context\.bearer\)/)
  expect(source).not.toMatch(/1_850_000/)
})
