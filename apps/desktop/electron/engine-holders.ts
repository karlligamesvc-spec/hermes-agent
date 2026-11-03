/**
 * hc-1094: what holds the APEX engine while an update waits on `engine_holders`, in terms a user
 * can act on, and which of those processes APEX may end itself.
 *
 * Only a process APEX started and then lost is endable: the exact command line Desktop spawns for
 * its messaging gateway or a local engine (`-m hermes_cli.main [--profile P] gateway run --replace`
 * or `... serve --host 127.0.0.1 --port 0`), run by the engine's own interpreter, whose parent is
 * gone (re-parented to pid 1 on macOS, no live parent on Windows). A holder whose parent is such a
 * leftover belongs to it: the Windows venv redirector's Python worker, or a tool the leftover
 * started. Everything else is only named, never ended: a hermes command under a shell is the
 * user's terminal, a descendant of this Desktop is its own work, anything else is another program
 * by its process name.
 *
 * hc-1117: a background command the engine started and then lost is such a leftover too. It runs
 * the engine's own interpreter or a bundled tool (`venv/`, `.runtime/`), is no hermes command, and
 * its parent is gone, or only shells stand between it and the missing parent: the engine runs
 * these as `<shell> -lic "set +m; <command>"`, and bash or a pipeline keeps that shell alive. What
 * else it runs does not matter.
 */

import { runtimeUpdateBusyReason } from './runtime-update-busy'

type LeftoverKind = 'leftover_child' | 'leftover_engine' | 'leftover_gateway'

export type EngineHolderKind = 'apex_running' | 'other' | 'terminal_hermes' | LeftoverKind

/** One holder as the idle scan reports it (argv already redacted). */
export interface EngineHolderDetail {
  name: string
  ppid: number
  exe: string
  argv: string[]
  /** psutil create_time: with the PID, the process identity an end request must match. */
  created?: number
  /** The live parent's PID; null when the parent is gone. */
  parent?: null | number
  /** The executable (or argv[0]) lies inside the scanned engine. */
  engineExe?: boolean
  /** The executable (or argv[0]) is the engine's own: in its `venv/` or `.runtime/`. */
  engineRuntime?: boolean
  /** Nearest ancestors first, up to four. */
  ancestors?: { pid: number; name: string }[]
}

export interface EngineHolderClass {
  kind: EngineHolderKind
  endable: boolean
  /** For a holder that belongs to a leftover: that leftover's PID. */
  leftover?: number
}

export type ClassifiedHolder = EngineHolderDetail & EngineHolderClass

/** What the renderer shows for one holder. */
export interface EngineHolderSummary {
  pid: number
  kind: EngineHolderKind
  name: null | string
  created: null | number
  endable: boolean
}

export interface EngineHolderIdentity {
  pid: number
  created: number
}

const DESKTOP_COMMANDS: [kind: 'leftover_engine' | 'leftover_gateway', words: string[]][] = [
  ['leftover_gateway', ['gateway', 'run', '--replace']],
  ['leftover_engine', ['serve', '--host', '127.0.0.1', '--port', '0']]
]

// Shells, and the multiplexers and login wrappers a shell runs under. A terminal app always runs
// one of these between itself and the command, so the app itself need not be listed.
const SHELLS = new Set(['bash', 'cmd', 'csh', 'dash', 'elvish', 'fish', 'ksh', 'login', 'nu', 'powershell', 'pwsh', 'screen', 'sh', 'sshd', 'tcsh', 'tmux', 'xonsh', 'zsh'])

// What the engine's background commands run under. No window opens these directly and none is a
// multiplexer or login wrapper, so with no parent left there is no terminal behind them either.
const COMMAND_SHELLS = new Set(['bash', 'csh', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh'])

// How many ancestors the scan reports for a holder (packaged-runtime.ts).
const SCANNED_ANCESTORS = 4

// How much of a holder's command line the deferral log keeps.
const LOGGED_ARGS = 8
const LOGGED_ARG_CHARS = 80

/** Which Desktop spawn this exact command line is, if any. */
function desktopCommand(argv: string[]): 'leftover_engine' | 'leftover_gateway' | null {
  if (argv[1] !== '-m' || argv[2] !== 'hermes_cli.main') {
    return null
  }

  const rest = argv[3] === '--profile' && argv[4] ? argv.slice(5) : argv.slice(3)
  const match = DESKTOP_COMMANDS.find(([, words]) => rest.length === words.length && words.every((word, index) => rest[index] === word))

  return match ? match[0] : null
}

/** A hermes command in any spelling: the console script, the module, or its main file. */
function runsHermes(argv: string[]): boolean {
  return argv.some(
    (arg, index) =>
      /(?:^|[\\/])hermes(?:\.exe|\.cmd)?$/i.test(arg) ||
      /(?:^|[\\/])hermes_cli[\\/]main\.py$/.test(arg) ||
      (arg === '-m' && /^hermes_cli(?:\.|$)/.test(argv[index + 1] ?? ''))
  )
}

function bareName(name: string): string {
  return name.replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase()
}

function underShell(detail: EngineHolderDetail): boolean {
  return (detail.ancestors ?? []).some(({ name }) => SHELLS.has(bareName(name)))
}

/** The parent is gone: a null parent everywhere, or launchd/init adopting the orphan on POSIX. */
function orphaned(detail: EngineHolderDetail, platform: NodeJS.Platform): boolean {
  return detail.parent === null || (platform !== 'win32' && detail.parent === 1)
}

/** Only command shells stand between this process and its missing parent. */
function detachedUnderShells(detail: EngineHolderDetail, platform: NodeJS.Platform): boolean {
  // On macOS the kernel (pid 0) is listed above launchd.
  const ancestors = (detail.ancestors ?? []).filter(ancestor => ancestor.pid !== 0)
  const adopted = platform !== 'win32' && ancestors.at(-1)?.pid === 1
  const shells = adopted ? ancestors.slice(0, -1) : ancestors
  const reachedTheTop = platform === 'win32' ? ancestors.length < SCANNED_ANCESTORS : adopted

  return reachedTheTop && shells.length > 0 && shells.every(({ name }) => COMMAND_SHELLS.has(bareName(name)))
}

/** Nobody owns this process any more: no parent, or nothing but command shells up to the missing one. */
function detached(detail: EngineHolderDetail, platform: NodeJS.Platform): boolean {
  return orphaned(detail, platform) || detachedUnderShells(detail, platform)
}

/** A leftover by itself, before parents are followed. */
function leftoverRoot(detail: EngineHolderDetail, platform: NodeJS.Platform): LeftoverKind | null {
  if (!Number.isFinite(detail.created)) {
    return null
  }

  const command = desktopCommand(detail.argv)

  if (command) {
    return detail.engineExe === true && orphaned(detail, platform) ? command : null
  }

  return detail.engineRuntime === true && !runsHermes(detail.argv) && detached(detail, platform) ? 'leftover_child' : null
}

/** The holders above this one, nearest first. */
function holdersAbove(detail: EngineHolderDetail, holders: Record<number, EngineHolderDetail | undefined>): number[] {
  return [detail.parent, ...(detail.ancestors ?? []).map(ancestor => ancestor.pid)].filter((pid): pid is number => typeof pid === 'number' && pid in holders)
}

/**
 * Sort every holder into a kind. `desktopPid` is this Desktop's own process: its descendants are
 * its running work, never a leftover.
 */
export function classifyEngineHolders(
  holders: Record<number, EngineHolderDetail | undefined>,
  context: { desktopPid: number; platform: NodeJS.Platform }
): Record<number, EngineHolderClass> {
  const result: Record<number, EngineHolderClass> = {}

  // A command shell a leftover child runs under may hold the engine too, by its working directory.
  // It goes with that child, and so does whatever else runs under it (`command | tee log`).
  const wrappers = new Map<number, number>()

  for (const [key, detail] of Object.entries(holders)) {
    if (detail && leftoverRoot(detail, context.platform) === 'leftover_child') {
      for (const { pid } of detail.ancestors ?? []) {
        const shell = holders[pid]

        if (shell && !wrappers.has(pid) && COMMAND_SHELLS.has(bareName(shell.name)) && Number.isFinite(shell.created)) {
          wrappers.set(pid, Number(key))
        }
      }
    }
  }

  // A holder belongs to the leftover it descends from through other holders (the redirector's
  // worker, a tool the leftover started). The walk stops at a holder already seen (a PID cycle).
  const leftoverOf = (pid: number, seen: Set<number>): { kind: LeftoverKind; pid: number } | null => {
    const detail = holders[pid]

    if (!detail || seen.has(pid)) {
      return null
    }

    seen.add(pid)
    const own = leftoverRoot(detail, context.platform)

    if (own) {
      return { kind: own, pid }
    }

    const wrapped = wrappers.get(pid)

    if (wrapped !== undefined) {
      return { kind: 'leftover_child', pid: wrapped }
    }

    if (!Number.isFinite(detail.created)) {
      return null
    }

    for (const above of holdersAbove(detail, holders)) {
      const found = leftoverOf(above, seen)

      if (found) {
        return found
      }
    }

    return null
  }

  for (const key of Object.keys(holders)) {
    const pid = Number(key)
    const detail = holders[pid]

    if (!detail) {
      result[pid] = { kind: 'other', endable: false }

      continue
    }

    const leftover = leftoverOf(pid, new Set())

    if (leftover) {
      result[pid] = { kind: leftover.kind, endable: true, ...(leftover.pid === pid ? {} : { leftover: leftover.pid }) }
    } else if ((detail.ancestors ?? []).some(ancestor => ancestor.pid === context.desktopPid)) {
      result[pid] = { kind: 'apex_running', endable: false }
    } else if (runsHermes(detail.argv) && underShell(detail)) {
      result[pid] = { kind: 'terminal_hermes', endable: false }
    } else {
      result[pid] = { kind: 'other', endable: false }
    }
  }

  return result
}

function idleProofHolders(error: unknown): Record<string, ClassifiedHolder | undefined> {
  return (error as { idleProof?: { holders?: Record<string, ClassifiedHolder | undefined> } } | null)?.idleProof?.holders ?? {}
}

/** A path as the log says it: no user name. */
function withoutHome(text: string): string {
  return text.replace(/(?:[A-Za-z]:\\Users\\|\/(?:Users|home)\/)[^\\/\s]+/g, '~')
}

/**
 * hc-1117: what a holder runs, for the log, so a stuck machine needs no `ps`. Only for what runs on
 * the engine or belongs to a leftover: any other program's command line and a command the user
 * typed in a terminal are none of this log's business. The scan already masked named secrets
 * (argv-redaction.ts); this also drops home directories and whatever looks like a bare token, and
 * keeps only the start of it.
 */
function loggedArgv(detail: ClassifiedHolder): string {
  const engineRun = detail.engineExe === true && detail.kind !== 'terminal_hermes'

  if (!(engineRun || detail.kind?.startsWith('leftover_')) || !detail.argv?.length) {
    return ''
  }

  return ` argv=[${detail.argv
    .slice(0, LOGGED_ARGS)
    .map(arg => withoutHome(arg).replace(/[\w-]{32,}/g, '[REDACTED]').slice(0, LOGGED_ARG_CHARS))
    .join(' ')}]`
}

/**
 * hc-1030's one-line deferral reason, with each holder's kind (hc-1094) and what it runs (hc-1117):
 * `<reason>: <message> [<pid> <name> (<exe>) <kind>[ endable][ of <leftover pid>][ argv=[...]]; ...]`.
 */
export function describeRuntimeUpdateBusy(error: unknown): string {
  const holders = Object.entries(idleProofHolders(error)).map(([pid, detail]) => {
    const kind = detail?.kind ? ` ${detail.kind}${detail.endable ? ' endable' : ''}${detail.leftover ? ` of ${detail.leftover}` : ''}` : ''

    return `${pid} ${detail?.name || '?'}${detail?.exe ? ` (${withoutHome(detail.exe)})` : ''}${kind}${detail ? loggedArgv(detail) : ''}`
  })

  return `${runtimeUpdateBusyReason(error)}: ${(error as Error | null)?.message || 'busy'}${holders.length ? ` [${holders.join('; ')}]` : ''}`
}

/**
 * The holders a deferral names, for the renderer; null when the gate did not classify them. A
 * hermes command is named `hermes`, not by its interpreter.
 */
export function summarizeEngineHolders(error: unknown): EngineHolderSummary[] | null {
  if (runtimeUpdateBusyReason(error) !== 'engine_holders') {
    return null
  }

  const entries = Object.entries(idleProofHolders(error))

  if (!entries.length || entries.some(([, detail]) => detail && !detail.kind)) {
    return null
  }

  return entries.map(([pid, detail]) => ({
    pid: Number(pid),
    kind: detail?.kind ?? 'other',
    name: detail && runsHermes(detail.argv) ? 'hermes' : detail?.name || null,
    created: Number.isFinite(detail?.created) ? detail!.created! : null,
    endable: detail?.endable === true
  }))
}

/** Identities from the renderer: only whole PID + start-time pairs count. */
export function engineHolderIdentities(value: unknown): EngineHolderIdentity[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(item => {
    const { pid, created } = (item ?? {}) as Partial<EngineHolderIdentity>

    return Number.isSafeInteger(pid) && Number(pid) > 0 && Number.isFinite(created) ? [{ pid: Number(pid), created: Number(created) }] : []
  })
}

/**
 * The holders a confirmed end request may touch: endable in this fresh scan and confirmed by the
 * user with the same PID and start time. Leftover roots come first, so a leftover is asked to exit
 * before the processes that belong to it.
 */
export function endableTargets(holders: Record<string, ClassifiedHolder | undefined>, confirmed: EngineHolderIdentity[]) {
  return Object.entries(holders)
    .flatMap(([pid, detail]) =>
      detail?.endable && confirmed.some(item => item.pid === Number(pid) && item.created === detail.created)
        ? [{ pid: Number(pid), created: detail.created!, exe: detail.exe, kind: detail.kind, leftover: detail.leftover }]
        : []
    )
    .sort((left, right) => Number(Boolean(left.leftover)) - Number(Boolean(right.leftover)))
}
