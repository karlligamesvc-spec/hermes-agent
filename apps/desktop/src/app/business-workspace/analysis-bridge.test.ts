import { afterEach, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'

import { analysisDocumentsBridge } from './analysis-bridge'
import type { AnalysisDocumentsBridge } from './analysis-types'
import { $workflowDomainRevision } from './api/read-revision'

const initialAuth = $authState.get()
afterEach(() => {$authState.set(initialAuth)})

function install(methods: Record<string, unknown>) {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { analysisDocuments: methods } })

  return analysisDocumentsBridge()!
}

it('invalidates for each successful source write, leaves rejected writes and all reads unchanged, and suppresses repeated outcomes', async () => {
  const writes: (keyof AnalysisDocumentsBridge)[] = [
    'importFile', 'importLink', 'transcribeVideoLink', 'uploadVideo', 'authorizeFeishu', 'pollFeishu', 'forgetFeishu',
    'importDeepReport', 'prepareDeepWorkspace', 'recordDeepChat', 'updateDeepChatOutcome', 'collectDeepReport', 'reviewDeepReport',
    'deleteDeepReport', 'saveOverview', 'saveAnswer', 'ask', 'addNote', 'deleteNote', 'retry', 'delete'
  ]

  for (const name of writes) {
    const response = { ok: true, status: 'authorized', item: { outcome: { status: 'complete' } } }

    const native = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: false, code: 'permission_denied' })
      .mockRejectedValueOnce(new Error('connection failed'))

    const wrapped = install({ [name]: native })
    const before = $workflowDomainRevision.get()
    const method = wrapped[name] as (...args: unknown[]) => Promise<unknown>
    expect(await method('source', 'A', 'rev')).toEqual(response)
    expect(native).toHaveBeenCalledWith('source', 'A', 'rev')
    expect($workflowDomainRevision.get()).toBe(before + 1)
    expect(await method()).toEqual({ ok: false, code: 'permission_denied' })
    await expect(method()).rejects.toThrow('connection failed')
    expect($workflowDomainRevision.get()).toBe(before + 1)
  }

  const reads: (keyof AnalysisDocumentsBridge)[] = ['policy', 'list', 'get', 'resolveVideoLink', 'readDeepChat',
    'transcriptForDraft', 'overviewContext', 'questionContext', 'openSource', 'previewPdf']

  for (const name of reads) {
    const native = vi.fn(async () => ({ ok: true }))
    const wrapped = install({ [name]: native })
    const before = $workflowDomainRevision.get()
    await (wrapped[name] as () => Promise<unknown>)()
    expect(native).toHaveBeenCalledTimes(1)
    expect($workflowDomainRevision.get()).toBe(before)
  }

  const wrapped = install({ pollFeishu: vi.fn(async () => ({ ok: true, status: 'pending' })),
    updateDeepChatOutcome: vi.fn(async () => ({ ok: true, item: { outcome: { status: 'running' } } })) })

  const before = $workflowDomainRevision.get()
  await wrapped.pollFeishu('flow')
  await wrapped.updateDeepChatOutcome!('source', 'A', 'rev', { outcome: { status: 'running' } } as never, 'running')
  expect($workflowDomainRevision.get()).toBe(before)
})

it.each(['account', 'auth'] as const)('rejects an old %s write acknowledgment before it can invalidate or populate the current workspace', async boundary => {
  $authState.set({ ...$authState.get(), accountId: 'A', status: 'signed-in', enabled: true })
  let finish!: (value: { ok: true; item: { body: string } }) => void
  const wrapped = install({ addNote: vi.fn(() => new Promise(resolve => {finish = resolve})) })
  const pending = wrapped.addNote('source', 'Private A', null)
  $authState.set({ ...$authState.get(), ...(boundary === 'account' ? { accountId: 'B' } : { status: 'disabled' as const }) })
  const before = $workflowDomainRevision.get()
  finish({ ok: true, item: { body: 'Private A' } })
  expect(await pending).toEqual({ ok: false, code: 'account_changed' })
  expect($workflowDomainRevision.get()).toBe(before)
})
