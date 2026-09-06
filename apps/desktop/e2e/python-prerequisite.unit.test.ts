import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { packagedE2ePythonCandidates, resolvePackagedE2ePython } from './python-prerequisite'

const tempRoots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-packaged-python-'))

  tempRoots.push(root)

  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

describe('packaged source-runtime Python prerequisite', () => {
  it('prefers and verifies the explicit override', () => {
    const repoRoot = tempRoot()
    const explicit = path.join(repoRoot, 'python-explicit')

    expect(
      resolvePackagedE2ePython({
        explicit,
        probe: candidate => (candidate === explicit ? null : 'unexpected fallback'),
        repoRoot
      })
    ).toBe(explicit)
  })

  it('finds the primary checkout venv from a worktree without a machine-specific path', () => {
    const primary = tempRoot()
    const repoRoot = path.join(primary, 'worktree')
    const gitDir = path.join(primary, '.git', 'worktrees', 'hc820')
    const expected = path.join(primary, '.venv', 'bin', 'python')

    fs.mkdirSync(repoRoot, { recursive: true })
    fs.mkdirSync(gitDir, { recursive: true })
    fs.writeFileSync(path.join(repoRoot, '.git'), `gitdir: ${gitDir}\n`, 'utf8')

    expect(packagedE2ePythonCandidates(repoRoot, 'darwin')).toEqual([
      path.join(repoRoot, '.venv', 'bin', 'python'),
      expected
    ])
    expect(
      resolvePackagedE2ePython({
        platform: 'darwin',
        probe: candidate => (candidate === expected ? null : 'not found'),
        repoRoot
      })
    ).toBe(expected)
  })

  it('fails before launch with a clear prerequisite when no repo Python is compatible', () => {
    const repoRoot = tempRoot()

    expect(() =>
      resolvePackagedE2ePython({
        platform: 'darwin',
        probe: () => 'Python 3.9 is older than 3.10',
        repoRoot
      })
    ).toThrow(/requires Python 3\.10\+.*Set HERMES_DESKTOP_PYTHON/s)
  })

  it('does not silently replace an incompatible explicit override', () => {
    const repoRoot = tempRoot()

    expect(() =>
      resolvePackagedE2ePython({
        explicit: '/usr/bin/python3',
        probe: () => 'Python 3.9 is older than 3.10',
        repoRoot
      })
    ).toThrow(/HERMES_DESKTOP_PYTHON is not compatible.*Python 3\.9/s)
  })
})
