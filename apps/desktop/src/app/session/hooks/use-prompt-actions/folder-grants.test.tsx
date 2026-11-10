/**
 * hc-1207: a folder chip outside the working directory is granted to the session at send.
 *
 * Main signs only a folder the user handed over this launch (window.hermesDesktop.folderGrants);
 * the engine's `folder.attach` checks that and answers the ref to submit. Everything else keeps
 * the old path: a folder main will not sign, a remote session, an engine without the method, and
 * every `@folder:` / `@file:` the user typed or took from the @ completions (those are text, not
 * chips, so nothing is ever asked about them).
 */

import { JsonRpcGatewayError } from '@hermes/shared'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import { folderGrantRefusalNow } from '@/i18n/folder-grant'
import type { ComposerAttachment } from '@/store/composer'
import { $composerAttachments } from '@/store/composer'
import { $connection, $currentCwd } from '@/store/session'

import { clearSingleFlightSessionResumeState } from './single-flight-resume'

import { uploadComposerAttachment, usePromptActions } from '.'

vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getSession: vi.fn(),
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS: 1_800_000,
  setApiRequestProfile: vi.fn(),
  transcribeAudio: vi.fn()
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn()
}))

const SESSION = 'rt-folder'
const FOLDER = '/Users/alice/Downloads/素材 一批'
const CHIP_REF = '@folder:`/Users/alice/Downloads/素材 一批`'
const GRANTED_REF = '@folder:`/private/Users/alice/Downloads/素材 一批`'

type Call = { method: string; params?: Record<string, unknown> }

function folderChip(): ComposerAttachment {
  return { detail: FOLDER, id: `folder:${FOLDER}`, kind: 'folder', label: '素材 一批', path: FOLDER, refText: CHIP_REF }
}

function gateway(answers: Record<string, (params?: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = []

  const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params })

    return (answers[method]?.(params) ?? {}) as never
  })

  return { calls, requestGateway }
}

function bridge(grants: Record<string, string>) {
  const folderGrants = vi.fn(async () => grants)

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { folderGrants } })

  return folderGrants
}

interface Sent {
  messages: () => Array<{ error?: string }>
  submit: (text: string, attachments?: ComposerAttachment[]) => Promise<boolean>
}

function Harness({ onReady, requestGateway }: { onReady: (sent: Sent) => void; requestGateway: ReturnType<typeof gateway>['requestGateway'] }) {
  const activeSessionIdRef = useRef<null | string>(SESSION)
  const state = useRef({ awaitingResponse: false, busy: false, messages: [], streamId: null, turnStartedAt: null } as never)

  const actions = usePromptActions({
    activeSessionId: SESSION,
    activeSessionIdRef,
    branchCurrentSession: async () => true,
    busyRef: { current: false },
    createBackendSessionForSend: async () => SESSION,
    getRoutedStoredSessionId: () => null,
    getRuntimeIdForStoredSession: () => null,
    getRouteToken: () => 'token',
    handleSkinCommand: () => '',
    openMemoryGraph: () => undefined,
    refreshSessions: async () => undefined,
    requestGateway: requestGateway as never,
    resumeStoredSession: () => undefined,
    runtimeIdByStoredSessionIdRef: { current: new Map([[SESSION, SESSION]]) },
    selectedStoredSessionIdRef: { current: SESSION },
    startFreshSessionDraft: () => undefined,
    sttEnabled: false,
    updateSessionState: (_sessionId, updater) => {
      state.current = updater(state.current) as never

      return state.current
    }
  })

  const { submitText } = actions

  useEffect(() => {
    onReady({
      messages: () => (state.current as unknown as { messages: Array<{ error?: string }> }).messages,
      submit: (text, attachments) => act(async () => submitText(text, { attachments })) as Promise<boolean>
    })
  }, [onReady, submitText])

  return null
}

async function harness(requestGateway: ReturnType<typeof gateway>['requestGateway']): Promise<Sent> {
  let sent: null | Sent = null

  await act(async () => {
    render(<Harness onReady={ready => (sent = ready)} requestGateway={requestGateway} />)
  })

  return sent!
}

beforeEach(() => {
  clearSingleFlightSessionResumeState()
  $connection.set({ mode: 'local' } as never)
  $currentCwd.set('/Users/alice/.apexnodes/profiles/apex-bot-2')
  setRuntimeI18nLocale('zh')
})

afterEach(() => {
  cleanup()
  $composerAttachments.set([])
  $connection.set(null)
  $currentCwd.set('')
  Reflect.deleteProperty(window, 'hermesDesktop')
  vi.restoreAllMocks()
})

describe('a handed-over folder at send', () => {
  it('is granted to the session first, and the granted ref is what is submitted', async () => {
    const folderGrants = bridge({ [FOLDER]: 'signed-by-main' })
    const { calls, requestGateway } = gateway({ 'folder.attach': () => ({ attached: true, ref_text: GRANTED_REF }) })
    const sent = await harness(requestGateway)

    expect(await sent.submit('看看这个文件夹', [folderChip()])).toBe(true)
    expect(folderGrants).toHaveBeenCalledExactlyOnceWith([FOLDER])
    expect(calls).toEqual([
      { method: 'folder.attach', params: { grant: 'signed-by-main', path: FOLDER, session_id: SESSION } },
      { method: 'prompt.submit', params: { session_id: SESSION, text: `${GRANTED_REF}\n\n看看这个文件夹` } }
    ])
  })

  it('keeps its own ref and asks the engine nothing when main will not sign it', async () => {
    bridge({})
    const { calls, requestGateway } = gateway()
    const sent = await harness(requestGateway)

    expect(await sent.submit('看看', [folderChip()])).toBe(true)
    expect(calls).toEqual([{ method: 'prompt.submit', params: { session_id: SESSION, text: `${CHIP_REF}\n\n看看` } }])
  })

  it('asks for no grant on a remote session, whose engine cannot see this machine', async () => {
    $connection.set({ mode: 'remote' } as never)
    const folderGrants = bridge({ [FOLDER]: 'signed-by-main' })
    const { calls, requestGateway } = gateway()
    const sent = await harness(requestGateway)

    expect(await sent.submit('看看', [folderChip()])).toBe(true)
    expect(folderGrants).not.toHaveBeenCalled()
    expect(calls.map(call => call.method)).toEqual(['prompt.submit'])
  })

  it('keeps its own ref on an engine that has no folder.attach', async () => {
    bridge({ [FOLDER]: 'signed-by-main' })

    const { calls, requestGateway } = gateway({
      'folder.attach': () => {
        throw new JsonRpcGatewayError('unknown method: folder.attach', { code: -32601 })
      }
    })

    const sent = await harness(requestGateway)

    expect(await sent.submit('看看', [folderChip()])).toBe(true)
    expect(calls.at(-1)).toEqual({ method: 'prompt.submit', params: { session_id: SESSION, text: `${CHIP_REF}\n\n看看` } })
  })

  it.each(['too_broad', 'sensitive', 'not_found'])(
    'stops the send when the engine refuses it (%s), saying why in the window language',
    async reason => {
      bridge({ [FOLDER]: 'signed-by-main' })

      const { calls, requestGateway } = gateway({
        'folder.attach': () => ({ attached: false, message: 'engine words', reason })
      })

      const sent = await harness(requestGateway)

      expect(await sent.submit('看看', [folderChip()])).toBe(false)
      expect(calls.map(call => call.method)).toEqual(['folder.attach'])
      expect(sent.messages().at(-1)?.error).toBe(folderGrantRefusalNow(reason, '素材 一批'))
      expect(folderGrantRefusalNow(reason, '素材 一批')).toContain('「素材 一批」')
    }
  )
})

describe('references that are text, not chips', () => {
  it.each([
    ['typed', `看看 @folder:${FOLDER.replaceAll(' ', '\\ ')}`],
    ['from the @ completions', '看看 @folder:`../../../Downloads/素材 一批`'],
    ['a file typed by hand', `读 @file:\`${FOLDER}/作品列表.xlsx\``]
  ])('a %s reference asks nobody for a grant and is sent as written', async (_how, text) => {
    const folderGrants = bridge({ [FOLDER]: 'signed-by-main' })
    const { calls, requestGateway } = gateway()
    const sent = await harness(requestGateway)

    expect(await sent.submit(text)).toBe(true)
    expect(folderGrants).not.toHaveBeenCalled()
    expect(calls).toEqual([{ method: 'prompt.submit', params: { session_id: SESSION, text } }])
  })
})

describe('the shared funnel (edit-message composer drops)', () => {
  it('hands back the granted ref for a folder', async () => {
    bridge({ [FOLDER]: 'signed-by-main' })
    const { calls, requestGateway } = gateway({ 'folder.attach': () => ({ attached: true, ref_text: GRANTED_REF }) })

    const uploaded = await uploadComposerAttachment(folderChip(), {
      backendCwd: '/Users/alice/.apexnodes/profiles/apex-bot-2',
      remote: false,
      requestGateway: requestGateway as never,
      sessionId: SESSION
    })

    expect(uploaded).toMatchObject({ attachedSessionId: SESSION, refText: GRANTED_REF })
    expect(calls.map(call => call.method)).toEqual(['folder.attach'])
  })

  it('leaves a Windows folder alone when a local backend runs in WSL/Docker (it cannot see the path)', async () => {
    const folderGrants = bridge({ 'C:\\Users\\alice\\Downloads\\素材': 'signed-by-main' })
    const { calls, requestGateway } = gateway()
    const chip = { ...folderChip(), path: 'C:\\Users\\alice\\Downloads\\素材' }

    expect(
      await uploadComposerAttachment(chip, {
        backendCwd: '/root',
        remote: false,
        requestGateway: requestGateway as never,
        sessionId: SESSION
      })
    ).toBe(chip)
    expect(folderGrants).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
