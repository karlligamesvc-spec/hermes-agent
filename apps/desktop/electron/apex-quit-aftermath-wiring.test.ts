// hc-1100 wiring guards: where main.ts and the preload hook up what a quit
// leaves behind. The behaviour itself is tested in apex-engine-children.test.ts
// and apex-turn-ledger.test.ts; these pin the order main.ts runs it in, which
// those modules cannot see: the snapshot must come before any engine is
// stopped (afterwards the descendants already hang off pid 1), and the sweep
// must be awaited inside the teardown the quit waits for.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, test } from 'vitest'

const stripComments = (source: string) => source.replace(/\/\/.*$/gm, '')
const main = stripComments(readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8'))
const preload = stripComments(readFileSync(join(import.meta.dirname, 'preload.ts'), 'utf8'))

function quitTeardown(): string {
  const start = main.indexOf('const backendShutdown = createBackendShutdownCoordinator(async () => {')

  assert.ok(start >= 0, 'backendShutdown is missing from main.ts')

  return main.slice(start, main.indexOf('\n})\n', start))
}

describe('the quit teardown in main.ts', () => {
  test('snapshots every owned engine before the first stop, and ends the survivors after the engines are down', () => {
    const teardown = quitTeardown()

    const at = (needle: string) => {
      const index = teardown.indexOf(needle)

      assert.ok(index >= 0, `${needle} is missing from the quit teardown`)

      return index
    }

    const snapshot = at('= snapshotEngineChildren(localBackendLifecycle.ownedChildren())')

    const firstStop = Math.min(
      at('localBackendLifecycle.shutdown()'),
      at('stopBackendChild(primary)'),
      at('stopAllPoolBackends()')
    )

    const engines = at('await waitForTeardown([')
    const sweep = at('await endEngineChildren(engineChildren, rememberLog)')

    assert.ok(snapshot < firstStop, 'the snapshot runs after an engine was already told to stop')
    assert.ok(engines < sweep, 'the sweep runs before the engines are down')
  })

  test('the ledger freezes on the local engines’ quit signal and listens to the windows’ reports', () => {
    assert.match(
      main,
      /\nregisterTurnLedger\(ipcMain, turnLedgerStoreIn\(\(\) => app\.getPath\('userData'\)\), localBackendLifecycle\.signal\)\n/
    )
  })

  test('the preload exposes the read and the settle on the ledger’s channels', () => {
    assert.match(preload, /interruptedTurns: \(\) => ipcRenderer\.invoke\('hermes:interrupted-turns'\)/)
    assert.match(preload, /settleInterruptedTurns: ids => ipcRenderer\.send\('hermes:interrupted-turns:settle', ids\)/)
  })

  test('product-mode ⌘W closes the sender’s own window through win.close(), not destroy()', () => {
    assert.match(
      main,
      /\nipcMain\.on\('hermes:close-window', event => BrowserWindow\.fromWebContents\(event\.sender\)\?\.close\(\)\)\n/
    )
    assert.match(preload, /closeWindow: \(\) => ipcRenderer\.send\('hermes:close-window'\)/)
  })
})
