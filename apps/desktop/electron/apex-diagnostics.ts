/** hc-908. Structured facts only; never accept error messages, paths or tool output. */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export type Fact = {
  operation:
    'startup' | 'update' | 'renderer' | 'process' | 'preview' | 'download' | 'diagnostics' | 'model_catalog' | 'voice'
  status: 'start' | 'success' | 'failure' | 'cancelled' | 'unknown'
  name?: string
  error_code?:
    | 'timeout'
    | 'network'
    | 'permission'
    | 'not_found'
    | 'authentication'
    | 'rate_limit'
    | 'exit_nonzero'
    | 'invalid_output'
    | 'crash'
    | 'unknown'
  duration_ms?: number
}
type Event = Fact & {
  event_id: string
  device_id: string
  occurred_at: string
  producer: string
  schema_version: number
  app_version: string
  platform: string
  arch: string
}
type Row = { owner: string; event: Event }
const ENDPOINT = 'https://api.apex-nodes.com/api/v1/runtime/diagnostics/events'

const OPERATIONS = new Set([
  'startup',
  'update',
  'renderer',
  'process',
  'preview',
  'download',
  'diagnostics',
  'model_catalog',
  'voice'
])

const STATUSES = new Set(['start', 'success', 'failure', 'cancelled', 'unknown'])

const ERRORS = new Set([
  'timeout',
  'network',
  'permission',
  'not_found',
  'authentication',
  'rate_limit',
  'exit_nonzero',
  'invalid_output',
  'crash',
  'unknown'
])

const MAX_ROWS = 2000
const MAX_AGE = 7 * 86400_000

export class ApexDiagnostics {
  private serial: Promise<unknown> = Promise.resolve()
  private flushing = false
  private readonly directory: string
  constructor(
    private home: string,
    private key: () => string | undefined,
    private version: string,
    private transport: typeof fetch = fetch
  ) {
    this.directory = path.join(home, 'diagnostics')
  }
  private transact<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(run)
    this.serial = next.catch(() => undefined)

    return next
  }
  private async write(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`

    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  async enabled(): Promise<boolean> {
    if (/^(off|0|false|disabled)$/i.test(process.env.APEXNODES_TELEMETRY || '')) {return false}

    try {
      return JSON.parse(await fs.readFile(path.join(this.home, '.apex-diagnostics.json'), 'utf8')).enabled === true
    } catch {
      return false
    }
  }
  /** Called only for managed APEX accounts. Existing opt-out survives upgrades. */
  async initialize() {
    if (!this.key()) {return}
    await fs.mkdir(this.home, { recursive: true })
    await fs
      .writeFile(path.join(this.home, '.apex-diagnostics.json'), '{"enabled":true}', { flag: 'wx', mode: 0o600 })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {throw error}
      })
  }
  async setEnabled(value: boolean) {
    return this.transact(async () => {
      await this.write(path.join(this.home, '.apex-diagnostics.json'), { enabled: value })

      if (!value) {await this.write(path.join(this.directory, 'desktop.json'), [])}

      return { enabled: await this.enabled() }
    })
  }
  private async read(): Promise<Row[]> {
    try {
      const filename = path.join(this.directory, 'desktop.json')

      if ((await fs.stat(filename)).size > 4 * 1024 * 1024) {return []}
      const rows: Row[] = JSON.parse(await fs.readFile(filename, 'utf8'))

      return Array.isArray(rows)
        ? rows.filter(row => Date.parse(row.event?.occurred_at) > Date.now() - MAX_AGE).slice(-MAX_ROWS)
        : []
    } catch {
      return []
    }
  }
  record(fact: Fact): Promise<string | undefined> {
    return this.transact(async () => {
      if (!(await this.enabled())) {return}
      const key = this.key()

      if (!key || !OPERATIONS.has(fact.operation) || !STATUSES.has(fact.status)) {return}
      const owner = createHash('sha256').update(key).digest('hex')
      const identityPath = path.join(this.directory, 'desktop-instance.json')
      let device: string

      try {
        device = JSON.parse(await fs.readFile(identityPath, 'utf8')).id
      } catch {
        device = randomUUID()
        await this.write(identityPath, { id: device })
      }

      const event: Event = {
        schema_version: 1,
        event_id: randomUUID(),
        device_id: device,
        occurred_at: new Date().toISOString(),
        producer: 'desktop',
        operation: fact.operation,
        status: fact.status,
        app_version: this.version,
        platform:
          ({ darwin: 'mac', win32: 'win', linux: 'linux' } as Record<string, string>)[process.platform] || 'unknown',
        arch: ['arm64', 'x64'].includes(process.arch) ? process.arch : 'unknown'
      }

      // Explicit projection: caller extras cannot enter storage or network.
      if (fact.name && /^[a-zA-Z0-9_.:-]{1,80}$/.test(fact.name) && !/^(sk-|bearer|eyj|ghp_|gho_)/i.test(fact.name))
        {event.name = fact.name}

      if (fact.error_code && ERRORS.has(fact.error_code)) {event.error_code = fact.error_code}

      if (Number.isSafeInteger(fact.duration_ms) && fact.duration_ms! >= 0 && fact.duration_ms! <= 1e12)
        {event.duration_ms = fact.duration_ms}

      const rows = await this.read()
      rows.push({ owner, event })

      while (rows.length > MAX_ROWS) {
        const index = rows.findIndex(row => row.event.status === 'start')
        rows.splice(index < 0 ? 0 : index, 1)
      }

      await this.write(path.join(this.directory, 'desktop.json'), rows)

      return event.event_id
    }).catch(() => undefined)
  }
  async flush(priorityId?: string): Promise<boolean> {
    if (this.flushing) {return false}
    this.flushing = true

    try {
      const batch = await this.transact(async () => {
        if (!(await this.enabled())) {return null}
        const key = this.key()

        if (!key) {return null}
        const owner = createHash('sha256').update(key).digest('hex')

        return { key, owner, rows: (await this.read()).filter(row => row.owner === owner).sort((a, b) => Number(b.event.event_id === priorityId) - Number(a.event.event_id === priorityId)).slice(0, 100) }
      })

      if (!batch?.rows.length) {return !priorityId}

      const response = await this.transport(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${batch.key}` },
        body: JSON.stringify({ events: batch.rows.map(row => row.event) })
      })

      if (!response.ok) {return false}
      const reply = (await response.json()) as { accepted?: string[]; rejected?: string[] }
      const ack = new Set([...(reply.accepted || []), ...(reply.rejected || [])])
      const sent = new Set(batch.rows.map(row => row.event.event_id))
      await this.transact(async () => {
        const rows = await this.read()
        await this.write(
          path.join(this.directory, 'desktop.json'),
          rows.filter(row => row.owner !== batch.owner || !sent.has(row.event.event_id) || !ack.has(row.event.event_id))
        )
      })

      return priorityId ? batch.rows.some(row => row.event.event_id === priorityId && (reply.accepted || []).includes(priorityId)) : batch.rows.every(row => ack.has(row.event.event_id))
    } catch {
      return false
    } finally {
      this.flushing = false
    }
  }
  async measure<T>(operation: Fact['operation'], name: string, run: () => Promise<T>): Promise<T> {
    const started = performance.now()

    try {
      const result = await run()

      const outcome =
        result && typeof result === 'object'
          ? (result as { canceled?: boolean; cancelled?: boolean; ok?: boolean; saved?: boolean })
          : null

      const status =
        outcome?.canceled || outcome?.cancelled
          ? 'cancelled'
          : outcome?.ok === false || outcome?.saved === false
            ? 'failure'
            : 'success'

      void this.record({ operation, name, status, duration_ms: Math.round(performance.now() - started) })

      return result
    } catch (error) {
      void this.record({
        operation,
        name,
        status: 'failure',
        error_code: 'unknown',
        duration_ms: Math.round(performance.now() - started)
      })
      throw error
    }
  }
}
