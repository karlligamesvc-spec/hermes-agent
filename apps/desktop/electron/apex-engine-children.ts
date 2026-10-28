/**
 * apex-engine-children.ts — quitting APEX ends what its engines started
 * (hc-1100).
 *
 * The quit teardown stops every local engine (`hermes serve`, primary and
 * pooled) with SIGTERM to its process group, then SIGKILL. That group is not
 * everything an engine runs. A background command (`terminal` with
 * `background=true`, which is how a long ffmpeg render runs) is started in a
 * session of its own so it can outlive a turn, and a turn's foreground command
 * gets its own group too. Neither hears the signal: the engine dies, the shell
 * and its ffmpeg are re-parented to pid 1 and keep going, and nothing ever
 * reports on them again (`hermes serve` never re-adopts them; only the
 * messaging gateway recovers processes from its checkpoint).
 *
 * So the teardown takes a snapshot of every engine's descendants before it
 * stops the engines, and once they are down ends whatever in the snapshot is
 * still alive: SIGTERM to the process group the descendant leads (or to the
 * process alone when it leads none), then SIGKILL after a grace period. A
 * process is only signalled while its pid AND start time still match the
 * snapshot, so a recycled pid is never hit.
 *
 * Left alone on purpose:
 * - The messaging gateway (`hermes_cli.main [--profile P] gateway …`) and
 *   everything under it: it has its own stop on quit (hc-1031).
 * - This Desktop and its process group.
 * - Windows: the teardown already ends each engine with `taskkill /T /F`,
 *   which walks the same parent tree (backend-child.ts), so there is nothing
 *   left to snapshot.
 *
 * hc-1094 (engine-holders.ts) names what still holds the engine when an update
 * waits, and ends only APEX's own orphaned engine or gateway and what descends
 * from it. This sweep runs earlier, at quit, while the engines are still alive
 * and their children can be told apart by parentage; what it ends never
 * becomes one of those holders.
 */

import { execFileSync } from 'node:child_process'

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  /** `ps -o lstart` text: with the pid, the identity a later signal must match. */
  started: string
  command: string
}

export interface EngineChild {
  pid: number
  /** True when the child leads its own process group: the group is signalled. */
  leadsGroup: boolean
  started: string
  /** The executable's base name, for the log line. */
  name: string
}

export interface EngineChildrenDeps {
  platform: NodeJS.Platform
  selfPid: number
  /** `ps -A -ww -o pid=,ppid=,pgid=,lstart=,args=` output. */
  listProcesses: () => string
  kill: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
}

/** How long ended children get to go before SIGKILL. */
export const ENGINE_CHILD_GRACE_MS = 1500

/** This process's view. `LC_ALL=C` keeps `lstart` in the English form ROW parses on a Chinese system. */
export function nodeEngineChildrenDeps(): EngineChildrenDeps {
  return {
    kill: (pid, signal) => process.kill(pid, signal),
    listProcesses: () =>
      execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,lstart=,args='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 3000
      }),
    platform: process.platform,
    selfPid: process.pid,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
  }
}

const POLL_MS = 100

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/

export function parseProcessRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []

  for (const line of text.split('\n')) {
    const match = ROW.exec(line)

    if (match) {
      const [, pid, ppid, pgid, started, command] = match
      rows.push({ command, pgid: Number(pgid), pid: Number(pid), ppid: Number(ppid), started })
    }
  }

  return rows
}

/** The messaging gateway in any spelling Desktop or the engine launches it. */
export function isMessagingGateway(command: string): boolean {
  const words = command.split(/\s+/)
  const module = words.findIndex((word, index) => word === 'hermes_cli.main' && words[index - 1] === '-m')
  const script = words.findIndex(word => /(?:^|\/)hermes$/.test(word))
  const start = module >= 0 ? module + 1 : script >= 0 ? script + 1 : -1

  if (start < 0) {
    return false
  }

  const rest = words.slice(start)
  const sub = rest[0] === '--profile' || rest[0] === '-p' ? rest[2] : rest[0]

  return sub === 'gateway'
}

function baseName(command: string): string {
  const first = command.split(/\s+/)[0] ?? ''

  return first.slice(first.lastIndexOf('/') + 1) || first
}

/** Every descendant of `roots`, minus the messaging gateway's subtree and this Desktop's own group. */
export function engineDescendants(
  rows: readonly ProcessRow[],
  roots: readonly number[],
  selfPid: number
): EngineChild[] {
  const byParent = new Map<number, ProcessRow[]>()
  const self = rows.find(row => row.pid === selfPid)

  for (const row of rows) {
    byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row])
  }

  const found: EngineChild[] = []
  const seen = new Set<number>(roots)
  const queue = [...roots]

  while (queue.length > 0) {
    for (const row of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(row.pid) || row.pid <= 1 || row.pid === selfPid || isMessagingGateway(row.command)) {
        continue
      }

      seen.add(row.pid)
      queue.push(row.pid)

      if (self && row.pgid === self.pgid) {
        continue
      }

      found.push({ leadsGroup: row.pgid === row.pid, name: baseName(row.command), pid: row.pid, started: row.started })
    }
  }

  return found
}

/** The children of the given engine processes right now; [] on Windows or when `ps` fails. */
export function snapshotEngineChildren(
  engines: readonly unknown[],
  deps: EngineChildrenDeps = nodeEngineChildrenDeps()
): EngineChild[] {
  if (deps.platform === 'win32') {
    return []
  }

  const roots = engines
    .map(engine => (engine as { pid?: unknown } | null | undefined)?.pid)
    .filter((pid): pid is number => Number.isInteger(pid) && (pid as number) > 1)

  if (roots.length === 0) {
    return []
  }

  try {
    return engineDescendants(parseProcessRows(deps.listProcesses()), roots, deps.selfPid)
  } catch {
    return []
  }
}

function stillRunning(children: readonly EngineChild[], deps: EngineChildrenDeps): EngineChild[] {
  let rows: ProcessRow[]

  try {
    rows = parseProcessRows(deps.listProcesses())
  } catch {
    return []
  }

  const alive = new Map(rows.map(row => [row.pid, row.started]))

  return children.filter(child => alive.get(child.pid) === child.started)
}

function signal(children: readonly EngineChild[], name: NodeJS.Signals, deps: EngineChildrenDeps) {
  for (const child of children) {
    try {
      deps.kill(child.leadsGroup ? -child.pid : child.pid, name)
    } catch {
      // Gone between the check and the signal.
    }
  }
}

/** End the snapshot's survivors and log them; returns the ones that had to be ended. */
export async function endEngineChildren(
  children: readonly EngineChild[],
  log: (line: string) => void = () => undefined,
  deps: EngineChildrenDeps = nodeEngineChildrenDeps(),
  graceMs: number = ENGINE_CHILD_GRACE_MS
): Promise<EngineChild[]> {
  const survivors = children.length > 0 ? stillRunning(children, deps) : []

  if (survivors.length === 0) {
    return []
  }

  log(
    `[quit] ending ${survivors.length} process(es) the engines started: ${survivors.map(child => `${child.name}(${child.pid})`).join(', ')}`
  )
  signal(survivors, 'SIGTERM', deps)

  for (let waited = 0; waited < graceMs; waited += POLL_MS) {
    await deps.sleep(POLL_MS)

    if (stillRunning(survivors, deps).length === 0) {
      return survivors
    }
  }

  signal(stillRunning(survivors, deps), 'SIGKILL', deps)

  return survivors
}
