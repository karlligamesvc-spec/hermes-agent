/**
 * hc-1177: `openfilm` in the engine (apex_overlay/openfilm_cli.mjs), spawned for real against a stand-in for the
 * engine's Python (`film_project env`, as APEX_PYTHON) and a stand-in OpenFilm CLI that prints what it received.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { NODE_COMMANDS, runtimeNodeShims } from '../../../scripts/runtime-node-shims.mjs'

const wrapper = resolve(__dirname, '../../../apex_overlay/openfilm_cli.mjs')
const engineRoot = resolve(__dirname, '../../..')

describe('the openfilm command', () => {
  let root = ''

  afterEach(() => {
    if (root) {
      rmSync(root, { force: true, recursive: true })
    }
  })

  /** A stand-in `$APEX_PYTHON -m apex_overlay.film_project env`: exits with `code`, else answers with a fake CLI. */
  function stand(code = 0) {
    root = mkdtempSync(join(tmpdir(), 'apex-openfilm-cli-'))
    const cli = join(root, 'openfilm.mjs')
    writeFileSync(
      cli,
      'console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.OPENFILM_HOME, noBrowser: process.env.OPENFILM_NO_BROWSER, chromium: process.env.OPENFILM_CHROMIUM, path: process.env.PATH }))\nprocess.exit(process.argv.includes("fail") ? 5 : 0)\n'
    )
    const said = JSON.stringify({
      cli,
      env: { OPENFILM_HOME: '/apex/openfilm/home', OPENFILM_NO_BROWSER: '1', OPENFILM_CHROMIUM: '/apex/chrome' }
    })
    const python = join(root, 'python')
    writeFileSync(
      python,
      code === 0
        ? `#!/bin/sh\n[ "$*" = "-m apex_overlay.film_project env" ] || exit 9\necho '${said}'\n`
        : `#!/bin/sh\necho 'APEX 的剪辑编辑器没开：这台电脑上不做 OpenFilm 工程' >&2\nexit ${code}\n`
    )
    chmodSync(python, 0o755)

    return python
  }

  const run = (python: string, args: string[]) =>
    spawnSync(process.execPath, [wrapper, ...args], {
      encoding: 'utf8',
      env: { ...process.env, APEX_PYTHON: python, PATH: '/usr/bin' }
    })

  test.skipIf(process.platform === 'win32')(
    'runs OpenFilm’s CLI with the editor folders, no browser, the agent browser, APEX’s ffmpeg first, and its exit code',
    () => {
      const python = stand()
      const result = run(python, ['look', '--all'])

      expect(result.status).toBe(0)
      const said = JSON.parse(result.stdout)
      expect(said).toMatchObject({
        args: ['look', '--all'],
        home: '/apex/openfilm/home',
        noBrowser: '1',
        chromium: '/apex/chrome'
      })
      expect(said.path.split(delimiter)[0]).toBe(join(engineRoot, '.runtime', 'bin'))
      expect(run(python, ['render', 'fail']).status).toBe(5)
    }
  )

  test.skipIf(process.platform === 'win32')('off: says so and runs nothing, with the setup’s own exit code', () => {
    const result = run(stand(2), ['look'])

    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('剪辑编辑器没开')
  })
})

// The bundle writes these into the engine's Node bin folder (scripts/build-runtime-bundle.mjs).
describe('the commands the engine’s Node puts on PATH', () => {
  let root = ''

  afterEach(() => {
    if (root) {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test('hypit is written exactly as before', () => {
    expect(runtimeNodeShims('mac').find(s => s.file === 'hypit')).toEqual({
      file: 'hypit',
      content: "#!/usr/bin/env node\nimport '../../../apex_overlay/hypit_cli.mjs'\n",
      mode: 0o755
    })
    expect(runtimeNodeShims('win').filter(s => s.file.startsWith('hypit'))).toEqual([
      { file: 'hypit', content: "#!/usr/bin/env node\nimport '../../apex_overlay/hypit_cli.mjs'\n", mode: 0o755 },
      { file: 'hypit.cmd', content: '@echo off\r\n"%~dp0node.exe" "%~dp0..\\..\\apex_overlay\\hypit_cli.mjs" %*\r\n' }
    ])
  })

  test('openfilm sits beside it on every target, a .cmd too on Windows', () => {
    expect(runtimeNodeShims('mac').map(s => s.file)).toEqual(['hypit', 'openfilm'])
    expect(runtimeNodeShims('win').map(s => s.file)).toEqual(['hypit', 'hypit.cmd', 'openfilm', 'openfilm.cmd'])
    expect(runtimeNodeShims('win').find(s => s.file === 'openfilm.cmd')?.content).toBe(
      '@echo off\r\n"%~dp0node.exe" "%~dp0..\\..\\apex_overlay\\openfilm_cli.mjs" %*\r\n'
    )
  })

  test.skipIf(process.platform === 'win32')(
    'each command, written where the bundle writes it, reaches its entry',
    () => {
      root = mkdtempSync(join(tmpdir(), 'apex-node-shims-'))
      const bin = join(root, '.runtime', 'node', 'bin')
      mkdirSync(bin, { recursive: true })
      mkdirSync(join(root, 'apex_overlay'))

      for (const entry of Object.values(NODE_COMMANDS) as string[]) {
        writeFileSync(
          join(root, 'apex_overlay', entry),
          `console.log(${JSON.stringify(entry)}, process.argv.slice(2).join(' '))\n`
        )
      }

      for (const shim of runtimeNodeShims('mac')) {
        writeFileSync(join(bin, shim.file), shim.content, { mode: shim.mode })
      }

      for (const [name, entry] of Object.entries(NODE_COMMANDS) as Array<[string, string]>) {
        const ran = spawnSync(process.execPath, [join(bin, name), 'look'], { encoding: 'utf8' })

        expect(ran.stdout.trim()).toBe(`${entry} look`)
      }
    }
  )
})
