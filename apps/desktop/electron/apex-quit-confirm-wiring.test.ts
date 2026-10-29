// hc-1104 wiring guards: how main.ts feeds apex-quit-confirm.ts, and the engine
// route it reads. The behaviour is tested in apex-quit-confirm.test.ts; these
// pin what that module cannot see: the confirmation runs before any teardown
// (the turn ledger freezes when the teardown stops the engines, so "Keep
// Running" must come first), it asks the local engines through the read-only
// idle snapshot, never the retirement fence, and the session-end sources are
// watched once the app is ready.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

import { ENGINE_IDLE_PATH } from './apex-quit-confirm'

const stripComments = (source: string) => source.replace(/\/\/.*$/gm, '')
const main = stripComments(readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8'))
const engineSource = (file: string) => readFileSync(join(import.meta.dirname, '../../../hermes_cli', file), 'utf8')

function block(start: string, end: string): string {
  const from = main.indexOf(start)

  assert.ok(from >= 0, `${start} is missing from main.ts`)

  return main.slice(from, main.indexOf(end, from))
}

describe('the quit confirmation in main.ts', () => {
  test('before-quit asks first, ahead of every teardown step', () => {
    const handler = block("app.on('before-quit', event => {", "\napp.on('window-all-closed'")
    const hold = handler.indexOf('if (quitConfirm.hold(event)) {\n    return\n  }')

    assert.ok(hold >= 0, 'before-quit no longer returns on a held quit')

    for (const step of ['sshBootstrapCoordinator.shutdown()', 'quitTeardown.begin(', 'backendShutdown.run()']) {
      const at = handler.indexOf(step)

      assert.ok(at > hold, `${step} runs before the quit confirmation`)
    }
  })

  test('it reads the windows’ reports, the engines Desktop runs, and skips a hand-off quit', () => {
    const wiring = block('const quitConfirm = createQuitConfirm({', '\n})\n')

    assert.match(wiring, /isMac: IS_MAC,/)
    assert.match(wiring, /skip: \(\) => SKIP_QUIT_CONFIRM \|\| isQuittingForHandoff,/)
    assert.match(
      wiring,
      /reporters: activeWorkByWebContents\.size, work: mergeActiveWork\(activeWorkByWebContents\.values\(\)\)/
    )
    assert.match(wiring, /owned: backendConnectionState\.getProcess\(\) !== null \}, backendPool\.values\(\)\)/)
    assert.match(
      wiring,
      /connection: backendConnectionState\.getPendingPromise\(\) \? null : backendConnectionState\.getPromise\(\)/
    )
  })

  test('the engines are asked with a GET on the idle snapshot, never the retirement fence', () => {
    const probe = block('  probe: engine =>', '\n  showMessageBox:')

    assert.match(
      probe,
      /fetchJson\(`\$\{engine\.baseUrl\}\$\{ENGINE_IDLE_PATH\}`, engine\.token, \{ timeoutMs: ENGINE_PROBE_DEADLINE_MS \}\)/
    )
    assert.doesNotMatch(probe, /method|retirement/)
    assert.equal(ENGINE_IDLE_PATH, '/api/health/idle')
  })

  test('the logout / shutdown notice and the update install are watched once the app is ready', () => {
    const listeners = block('function registerPowerResumeListeners() {', '\n}\n')

    assert.match(
      listeners,
      /quitConfirm\.watchSessionEnd\(\{ updater: nativeAutoUpdater, workspace: IS_MAC \? systemPreferences : undefined \}\)/
    )
    assert.match(block('import {\n  app,', "} from 'electron'"), /\n {2}autoUpdater as nativeAutoUpdater,\n/)
  })
})

describe('the engine side of GET /api/health/idle', () => {
  test('answers ok plus the idle proof, behind the session token', () => {
    const route = engineSource('web_routers/status.py')
    const at = route.indexOf('@router.get("/api/health/idle")')

    assert.ok(at >= 0, 'the idle route is gone')

    const handler = route.slice(at, route.indexOf('@router.', at + 1))

    assert.match(handler, /_require_token\(request\)/)
    assert.match(handler, /return \{"ok": True, \*\*idle_proof\(\)\}/)
  })

  test('names busy chats as session:<id>,<id>', () => {
    assert.match(
      engineSource('web_server_idle_exit.py'),
      /return "session:" \+ ",".join\(str\(sid\) for sid in busy_sessions\)/
    )
  })
})
