import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

type PythonProbe = (candidate: string, repoRoot: string) => string | null

function venvPython(root: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python')
}

function primaryCheckoutRoot(repoRoot: string): string | null {
  const gitEntry = path.join(repoRoot, '.git')

  if (!fs.existsSync(gitEntry) || fs.statSync(gitEntry).isDirectory()) {
    return null
  }

  const match = fs
    .readFileSync(gitEntry, 'utf8')
    .trim()
    .match(/^gitdir:\s*(.+)$/)

  if (!match) {
    return null
  }

  const gitDir = path.resolve(repoRoot, match[1])
  const worktreesDir = path.dirname(gitDir)

  if (path.basename(worktreesDir) !== 'worktrees') {
    return null
  }

  return path.dirname(path.dirname(worktreesDir))
}

export function packagedE2ePythonCandidates(repoRoot: string, platform: NodeJS.Platform = process.platform): string[] {
  const roots = [repoRoot, primaryCheckoutRoot(repoRoot)].filter((root): root is string => Boolean(root))

  return [...new Set(roots.map(root => venvPython(root, platform)))]
}

function verifyPackagedE2ePython(candidate: string, repoRoot: string): string | null {
  if (!fs.existsSync(candidate)) {
    return 'not found'
  }

  const result = spawnSync(
    candidate,
    [
      '-c',
      [
        'import sys',
        "assert sys.version_info >= (3, 10), f'Python {sys.version.split()[0]} is older than 3.10'",
        'import hermes_cli.main'
      ].join('; ')
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000
    }
  )

  if (result.status === 0) {
    return null
  }

  return (result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim()
}

export function resolvePackagedE2ePython(options: {
  explicit?: string
  platform?: NodeJS.Platform
  probe?: PythonProbe
  repoRoot: string
}): string {
  const probe = options.probe ?? verifyPackagedE2ePython
  const explicit = options.explicit?.trim()

  if (explicit) {
    const candidate = path.resolve(explicit)
    const failure = probe(candidate, options.repoRoot)

    if (!failure) {
      return candidate
    }

    throw new Error(
      `HERMES_DESKTOP_PYTHON is not compatible with the packaged source-runtime E2E: ${candidate}\n${failure}`
    )
  }

  const failures: string[] = []

  for (const candidate of packagedE2ePythonCandidates(options.repoRoot, options.platform)) {
    const failure = probe(candidate, options.repoRoot)

    if (!failure) {
      return candidate
    }

    failures.push(`${candidate}: ${failure}`)
  }

  throw new Error(
    [
      'Packaged source-runtime E2E requires Python 3.10+ with the Hermes runtime dependencies.',
      'Set HERMES_DESKTOP_PYTHON to a compatible interpreter before running Playwright.',
      `Checked repo venvs:\n${failures.map(failure => `- ${failure}`).join('\n')}`
    ].join('\n')
  )
}
