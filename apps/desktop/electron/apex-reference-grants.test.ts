// hc-1207: main signs a folder grant only for a folder a trusted source handed over during this
// launch: the native open dialog's answer, or a dropped/pasted File's path that preload reports.
// The engine (apex_overlay/folder_grants.py) checks the same signature.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, test } from 'vitest'

import {
  createReferenceGrants,
  REFERENCE_GRANT_KEY_ENV,
  registerReferenceGrantIpc,
  signFolderGrant
} from './apex-reference-grants'

const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index))

let root = ''

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-folder-grants-')))
})

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true })
})

function folder(name: string): string {
  const target = path.join(root, name)

  fs.mkdirSync(target, { recursive: true })

  return target
}

type Listener = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc() {
  const handlers = new Map<string, Listener>()
  const listeners = new Map<string, Listener>()

  return {
    handle: (channel: string, listener: Listener) => void handlers.set(channel, listener),
    on: (channel: string, listener: Listener) => void listeners.set(channel, listener),
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { getType: () => 'window' } }, ...args),
    send: (channel: string, senderType: string, ...args: unknown[]) =>
      listeners.get(channel)!({ sender: { getType: () => senderType } }, ...args)
  }
}

function fakeDialog(answer: { canceled: boolean; filePaths: string[] }) {
  const calls: Array<{ options: any; window: unknown }> = []

  return {
    calls,
    dialog: {
      showOpenDialog: async (window: unknown, options: any) => {
        calls.push({ options, window })

        return answer
      }
    }
  }
}

function deps(dialog: ReturnType<typeof fakeDialog>['dialog'], isWindows = false) {
  return {
    dialog,
    isWindows,
    mainWindow: () => 'main-window',
    resolvePickerDefaultPath: (target: string) => `C:\\bridged\\${path.basename(target)}`
  }
}

describe('folder grant signatures', () => {
  // The same vectors pin apex_overlay/folder_grants.py sign(): the two signers are twins.
  test.each([
    ['/Users/me/Downloads/素材 一批', '3df70a3b88a4a444918e1aeac32b2e3e3d69c2b8fff4e323899e4d78edbda5be'],
    ['C:\\Users\\me\\Downloads\\素材', '7d2eee05da52b5768a603851e6c8cf07f2343e97f88c917ff63ecc76841cd8ea']
  ])('match the engine for %s', (target, signature) => {
    assert.equal(signFolderGrant(KEY, target), signature)
  })
})

describe('the hand-over ledger', () => {
  test('signs a folder that was handed over, and nothing it was only asked about', () => {
    const grants = createReferenceGrants(KEY)
    const handed = folder('Downloads/素材 一批')
    const other = folder('Other')

    grants.note([handed])

    assert.deepEqual(grants.grantsFor([handed, other, '/etc']), { [handed]: signFolderGrant(KEY, handed) })
  })

  test('signs no file, no relative path and no folder that has gone', () => {
    const grants = createReferenceGrants(KEY)
    const gone = folder('gone')
    const file = path.join(folder('docs'), 'a.xlsx')

    fs.writeFileSync(file, 'x')
    grants.note([file, 'Downloads', gone, 42, null])
    fs.rmSync(gone, { recursive: true })

    assert.deepEqual(grants.grantsFor([file, 'Downloads', gone]), {})
    assert.deepEqual(grants.grantsFor('not a list'), {})
  })

  test('gives every engine the one key it signs with', () => {
    const grants = createReferenceGrants(KEY)
    const handed = folder('clips')

    grants.note([handed])

    const env = grants.spawnEnv()
    assert.deepEqual(Object.keys(env), [REFERENCE_GRANT_KEY_ENV])
    assert.equal(grants.grantsFor([handed])[handed], signFolderGrant(Buffer.from(env[REFERENCE_GRANT_KEY_ENV], 'hex'), handed))
    assert.deepEqual(grants.spawnEnv(), env)
  })

  test('two launches never share a key', () => {
    assert.notEqual(createReferenceGrants().spawnEnv()[REFERENCE_GRANT_KEY_ENV], createReferenceGrants().spawnEnv()[REFERENCE_GRANT_KEY_ENV])
  })
})

describe('the IPC', () => {
  test("the open dialog's answer is handed over; a cancel hands over nothing", async () => {
    const picked = folder('picked')
    const ipc = fakeIpc()
    const grants = createReferenceGrants(KEY)

    registerReferenceGrantIpc(ipc, deps(fakeDialog({ canceled: true, filePaths: [picked] }).dialog), grants)
    assert.deepEqual(await ipc.invoke('hermes:selectPaths', { directories: true }), [])
    assert.deepEqual(await ipc.invoke('hermes:folderGrants', [picked]), {})

    registerReferenceGrantIpc(ipc, deps(fakeDialog({ canceled: false, filePaths: [picked] }).dialog), grants)
    assert.deepEqual(await ipc.invoke('hermes:selectPaths', { directories: true }), [picked])
    assert.deepEqual(await ipc.invoke('hermes:folderGrants', [picked]), { [picked]: signFolderGrant(KEY, picked) })
  })

  test('opens the dialog as main.ts always did', async () => {
    const ipc = fakeIpc()
    const { calls, dialog } = fakeDialog({ canceled: false, filePaths: [] })

    registerReferenceGrantIpc(ipc, deps(dialog), createReferenceGrants(KEY))
    await ipc.invoke('hermes:selectPaths', { defaultPath: root, title: '选择要添加的文件' })
    await ipc.invoke('hermes:selectPaths', { directories: true, multiple: false, filters: [{ extensions: ['png'], name: '图片' }] })
    await ipc.invoke('hermes:selectPaths')

    assert.deepEqual(
      calls.map(call => [call.window, call.options]),
      [
        ['main-window', { defaultPath: root, filters: undefined, properties: ['openFile', 'multiSelections'], title: '选择要添加的文件' }],
        ['main-window', { defaultPath: undefined, filters: [{ extensions: ['png'], name: '图片' }], properties: ['openDirectory'], title: 'Add context' }],
        ['main-window', { defaultPath: undefined, filters: undefined, properties: ['openFile', 'multiSelections'], title: 'Add context' }]
      ]
    )
  })

  test('bridges a default path on Windows', async () => {
    const ipc = fakeIpc()
    const { calls, dialog } = fakeDialog({ canceled: false, filePaths: [] })

    registerReferenceGrantIpc(ipc, deps(dialog, true), createReferenceGrants(KEY))
    await ipc.invoke('hermes:selectPaths', { defaultPath: '/home/me/work', profile: 'apex-bot-2' })

    assert.equal(calls[0].options.defaultPath, path.resolve('C:\\bridged\\work'))
  })

  test("preload's dropped paths are handed over; a <webview> guest's are not", async () => {
    const ipc = fakeIpc()
    const dropped = folder('dropped')
    const guest = folder('guest')

    registerReferenceGrantIpc(ipc, deps(fakeDialog({ canceled: true, filePaths: [] }).dialog), createReferenceGrants(KEY))
    ipc.send('hermes:noteHandedOverPaths', 'webview', [guest])
    ipc.send('hermes:noteHandedOverPaths', 'window', [dropped])

    assert.deepEqual(await ipc.invoke('hermes:folderGrants', [dropped, guest]), { [dropped]: signFolderGrant(KEY, dropped) })
  })
})
