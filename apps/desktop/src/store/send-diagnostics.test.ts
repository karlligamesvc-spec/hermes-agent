import { afterEach, describe, expect, it, vi } from 'vitest'

import { $sendDiagnostics, confirmSendDiagnostics, dismissSendDiagnostics, requestSendDiagnostics } from './send-diagnostics'
const original = window.hermesDesktop

function bridge(send: () => Promise<unknown>) {
  const getRecentLogs = vi.fn()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { diagnostics: { send }, getRecentLogs } })

  return getRecentLogs
}

afterEach(() => {
  dismissSendDiagnostics()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: original })
})
describe('APEX diagnostics handoff', () => {
  it('sends only through native APEX bridge after confirmation, without context or logs', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, uploadId: 'record-1' })
    const logs = bridge(send)
    requestSendDiagnostics('SECRET_ERROR_CONTEXT')
    expect(send).not.toHaveBeenCalled()
    await confirmSendDiagnostics(); await confirmSendDiagnostics()
    expect(send).toHaveBeenCalledExactlyOnceWith()
    expect(logs).not.toHaveBeenCalled()
    expect($sendDiagnostics.get()?.result?.uploadId).toBe('record-1')
    expect($sendDiagnostics.get()?.phase).toBe('done')
  })
  it('does not fall back to upstream when the bridge is absent', async () => {
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: undefined })
    requestSendDiagnostics(); await confirmSendDiagnostics()
    expect($sendDiagnostics.get()?.phase).toBe('error')
  })
  it('shows failure and does not resurrect a dismissed dialog', async () => {
    bridge(async () => ({ ok: false, error: 'offline' }))
    requestSendDiagnostics(); await confirmSendDiagnostics()
    expect($sendDiagnostics.get()?.error).toBe('offline')

    let resolve: (value: unknown) => void = () => {}
    bridge(() => new Promise(r => { resolve = r }))
    requestSendDiagnostics(); const pending = confirmSendDiagnostics()
    dismissSendDiagnostics(); resolve({ ok: true })
    await pending
    expect($sendDiagnostics.get()).toBeNull()
  })
})
