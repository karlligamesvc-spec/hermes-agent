import { EventEmitter } from 'node:events'

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'

import type { HermesNotification } from './notification-types'

const host = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  shown: [] as (EventEmitter & { options: { title?: string } })[]
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: host.fromWebContents },
  ipcMain: { handle: host.handle },
  Notification: class extends EventEmitter {
    static isSupported() {
      return true
    }

    constructor(readonly options: { title?: string }) {
      super()
    }

    show() {
      host.shown.push(this)
    }
  }
}))

import { registerNativeNotifications } from './notification-ipc'

function windowStub() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() }
  }
}

beforeEach(() => {
  host.handle.mockReset()
  host.fromWebContents.mockReset()
  host.shown.length = 0
})

// hc-919 F1: the hc-844 merge took upstream's notification-ipc.ts verbatim, so an
// untitled notification said 'Hermes' again (AGENTS.md rule #11, identity layer).
it.each([undefined, ''])('titles an untitled notification with the host product name (title=%j)', title => {
  host.fromWebContents.mockReturnValue(windowStub())
  registerNativeNotifications({ appName: 'APEX', getMainWindow: () => null, focusWindow: vi.fn() })
  const notify = host.handle.mock.calls[0][1] as (event: IpcMainInvokeEvent, payload: HermesNotification) => boolean

  expect(notify({ sender: {} } as unknown as IpcMainInvokeEvent, { kind: 'turn-complete', title, body: 'done' })).toBe(
    true
  )
  expect(host.shown[0].options.title).toBe('APEX')
})

it('returns native clicks and approval actions to the emitting window, not the primary', () => {
  const primary = windowStub()
  const source = windowStub()
  host.fromWebContents.mockReturnValue(source)
  const focusWindow = vi.fn()
  registerNativeNotifications({
    appName: 'APEX',
    getMainWindow: () => primary as unknown as BrowserWindow,
    focusWindow
  })
  const notify = host.handle.mock.calls[0][1] as (event: IpcMainInvokeEvent, payload: HermesNotification) => boolean

  const payload = {
    kind: 'approval',
    sessionId: 'runtime-source',
    focusSessionId: 'stored-source',
    title: 'Approval',
    actions: [
      { id: 'approve', text: 'Approve' },
      { id: 'reject', text: 'Reject' }
    ]
  }

  expect(notify({ sender: source.webContents } as unknown as IpcMainInvokeEvent, payload)).toBe(true)
  expect(focusWindow).not.toHaveBeenCalled()
  expect(primary.webContents.send).not.toHaveBeenCalled()
  host.shown[0].emit('click')
  expect(focusWindow).toHaveBeenCalledWith(source)
  expect(source.webContents.send).toHaveBeenCalledWith('hermes:focus-session', payload.focusSessionId)
  host.shown[0].emit('action', { actionIndex: 1 }, undefined)
  expect(source.webContents.send).toHaveBeenCalledWith('hermes:notification-action', {
    sessionId: payload.sessionId,
    actionId: 'reject'
  })
  expect(primary.webContents.send).not.toHaveBeenCalled()

  // A response must never jump to another window's gateway after its owner closes.
  source.isDestroyed.mockReturnValue(true)
  host.shown[0].emit('action', { actionIndex: 0 }, undefined)
  expect(primary.webContents.send).not.toHaveBeenCalled()
  host.shown[0].emit('click')
  expect(primary.webContents.send).toHaveBeenCalledWith('hermes:focus-session', payload.focusSessionId)
})

it('delivers plugin callbacks to their source and falls back only for navigation after it closes', () => {
  const primary = windowStub()
  const source = windowStub()
  host.fromWebContents.mockReturnValue(source)
  const focusWindow = vi.fn()
  registerNativeNotifications({
    appName: 'APEX',
    getMainWindow: () => primary as unknown as BrowserWindow,
    focusWindow
  })
  const notify = host.handle.mock.calls[0][1] as (event: IpcMainInvokeEvent, payload: HermesNotification) => boolean
  notify({ sender: source.webContents } as unknown as IpcMainInvokeEvent, {
    kind: 'plugin',
    notifyId: 'source-callback',
    activate: '/plugin',
    actions: [{ id: 'open', text: 'Open', activate: '/plugin/detail' }]
  })
  host.shown[0].emit('action', { actionIndex: 0 }, undefined)
  expect(source.webContents.send).toHaveBeenCalledWith(
    'hermes:notification-activate',
    expect.objectContaining({
      actionId: 'open',
      notifyId: 'source-callback',
      activate: '/plugin/detail'
    })
  )
  expect(primary.webContents.send).not.toHaveBeenCalled()
  source.isDestroyed.mockReturnValue(true)
  host.shown[0].emit('click')
  expect(primary.webContents.send).toHaveBeenCalledWith(
    'hermes:notification-activate',
    expect.objectContaining({
      activate: '/plugin',
      notifyId: undefined
    })
  )
})
