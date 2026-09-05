import assert from 'node:assert/strict'

import type { App, IpcMain } from 'electron'
import { test } from 'vitest'

import { registerDesktopVersionIpc, showFreshAboutPanel } from './desktop-version'

test('version IPC reports the Electron shell separately from the managed engine', async () => {
  let handler: (() => unknown) | undefined

  const ipcMain = {
    handle(channel: string, listener: () => unknown) {
      assert.equal(channel, 'hermes:version')
      handler = listener
    }
  } as unknown as Pick<IpcMain, 'handle'>

  registerDesktopVersionIpc(ipcMain, {
    app: { getVersion: () => '0.17.18' },
    electronVersion: '38.7.2',
    engineVersion: () => '0.17.17',
    hermesRoot: () => '/tmp/hermes-agent',
    nodeVersion: '22.22.1',
    platform: 'darwin'
  })

  assert.ok(handler)
  assert.deepEqual(await handler(), {
    appVersion: '0.17.18',
    engineVersion: '0.17.17',
    electronVersion: '38.7.2',
    nodeVersion: '22.22.1',
    platform: 'darwin',
    hermesRoot: '/tmp/hermes-agent'
  })
})

test('native About panel identifies the Electron shell', () => {
  let options: Electron.AboutPanelOptionsOptions | undefined
  let shown = false

  const app = {
    getVersion: () => '0.17.18',
    setAboutPanelOptions(next: Electron.AboutPanelOptionsOptions) {
      options = next
    },
    showAboutPanel() {
      shown = true
    }
  } as Pick<App, 'getVersion' | 'setAboutPanelOptions' | 'showAboutPanel'>

  showFreshAboutPanel({
    app,
    applicationName: 'APEX',
    copyright: 'Copyright © 2026 ApexNodes'
  })

  assert.deepEqual(options, {
    applicationName: 'APEX',
    applicationVersion: '0.17.18',
    copyright: 'Copyright © 2026 ApexNodes'
  })
  assert.equal(shown, true)
})
