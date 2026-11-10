/**
 * hc-1210: a sent file is copied into the session's attachments/ once.
 *
 * A file chip is staged by the drop-time (eager) upload as soon as a session
 * exists, and by the send if that has not happened. Each extra `file.attach`
 * leaves another copy (作品列表.xlsx, then 作品列表-2.xlsx) and the model is
 * handed whichever ref the send ends up with. These cases drive the real
 * shapes: the composer clears its chips before the send, a send of several
 * files waits on them one by one, and a new chat's first send creates its
 * session with the chips still in the composer (the Start page).
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $composerAttachments, type ComposerAttachment } from '@/store/composer'
import { $connection, $currentCwd } from '@/store/session'

import { clearSingleFlightSessionResumeState } from './single-flight-resume'
import type { SubmitTextOptions } from './utils'

import { usePromptActions } from '.'

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

const SESSION = 'rt-staging'

type RequestGateway = ReturnType<typeof vi.fn<(method: string, params?: Record<string, unknown>) => Promise<never>>>

/**
 * The engine's file.attach as the desktop sees it: every call that succeeds
 * copies the file in once more (作品列表.xlsx, then 作品列表-2.xlsx). A name's
 * first call is held until released, so a send can start while it is in
 * flight; later calls answer at once, so a duplicate shows up as an extra call
 * instead of a hung test. A name in `failFirst` has its first call refused
 * instead (nothing is copied).
 */
function stagingGateway({ failFirst = [] as string[] } = {}) {
  const attached: string[] = []
  const copies = new Map<string, number>()
  const held = new Map<string, () => void>()
  const prompts: string[] = []

  const requestGateway: RequestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'file.attach') {
      const name = String(params?.name)
      const call = attached.filter(item => item === name).length + 1

      attached.push(name)

      if (call === 1 && failFirst.includes(name)) {
        throw new Error('[Errno 13] Permission denied')
      }

      if (call === 1 && !failFirst.length) {
        await new Promise<void>(resolve => held.set(name, resolve))
      }

      const copy = (copies.get(name) ?? 0) + 1

      copies.set(name, copy)

      const dot = name.lastIndexOf('.')
      const staged = copy === 1 ? name : `${name.slice(0, dot)}-${copy}${name.slice(dot)}`

      return { attached: true, ref_text: `@file:attachments/${staged}` } as never
    }

    if (method === 'prompt.submit') {
      prompts.push(String(params?.text))
    }

    return {} as never
  })

  const release = (name: string) => {
    const resolve = held.get(name)

    expect(resolve, `${name} is not being staged`).toBeTypeOf('function')
    resolve!()
  }

  return { attached, prompts, release, requestGateway }
}

const pickedFile = (name: string): ComposerAttachment => ({
  id: `file:/Users/me/Downloads/${name}`,
  kind: 'file',
  label: name,
  path: `/Users/me/Downloads/${name}`,
  refText: `@file:\`/Users/me/Downloads/${name}\``
})

/** What the composer's Enter does with its chips: clone them, clear the composer, send the clones. */
function takeComposerChips() {
  const chips = $composerAttachments.get().map(chip => ({ ...chip }))

  $composerAttachments.set([])

  return chips
}

const flush = () => act(async () => await new Promise(resolve => setTimeout(resolve, 0)))

type Submit = (text: string, options?: SubmitTextOptions) => Promise<boolean>

/**
 * usePromptActions over a chat that already has a session, or (`newChat`) over
 * a new chat whose first send creates one and makes it active, as the app's
 * $activeSessionId does. `effectFirst`: the drop-time effect starts on the
 * chips before the send stages them, and the Start → chat hand-off then
 * stashes the chips out of the composer.
 */
function Harness({
  effectFirst = false,
  newChat = false,
  onReady,
  requestGateway
}: {
  effectFirst?: boolean
  newChat?: boolean
  onReady: (submit: Submit) => void
  requestGateway: RequestGateway
}) {
  const [activeSessionId, setActiveSessionId] = useState<null | string>(newChat ? null : SESSION)
  const activeSessionIdRef = useRef<null | string>(newChat ? null : SESSION)
  const state = useRef({ awaitingResponse: false, busy: false, messages: [], streamId: null, turnStartedAt: null })

  const createBackendSessionForSend = async () => {
    activeSessionIdRef.current = SESSION
    setActiveSessionId(SESSION)

    if (effectFirst) {
      await waitFor(() => expect(requestGateway.mock.calls.some(([method]) => method === 'file.attach')).toBe(true))
      $composerAttachments.set([])
    }

    return SESSION
  }

  const { submitText } = usePromptActions({
    activeSessionId,
    activeSessionIdRef,
    branchCurrentSession: async () => true,
    busyRef: { current: false },
    createBackendSessionForSend,
    getRoutedStoredSessionId: () => null,
    getRuntimeIdForStoredSession: () => null,
    getRouteToken: () => 'token',
    handleSkinCommand: () => '',
    openMemoryGraph: () => undefined,
    refreshSessions: async () => undefined,
    requestGateway: requestGateway as never,
    resumeStoredSession: () => undefined,
    runtimeIdByStoredSessionIdRef: { current: newChat ? new Map() : new Map([[SESSION, SESSION]]) },
    selectedStoredSessionIdRef: { current: newChat ? null : SESSION },
    startFreshSessionDraft: () => undefined,
    sttEnabled: false,
    updateSessionState: (_sessionId, updater) => {
      state.current = updater(state.current as never) as never

      return state.current as never
    }
  })

  useEffect(() => {
    onReady(submitText)
  }, [onReady, submitText])

  return null
}

async function mount(props: Omit<Parameters<typeof Harness>[0], 'onReady'>): Promise<{ submit: () => Submit }> {
  let submit: null | Submit = null

  await act(async () => {
    render(<Harness {...props} onReady={ready => (submit = ready)} />)
  })
  await waitFor(() => expect(submit).not.toBeNull())

  return { submit: () => submit! }
}

beforeEach(() => {
  clearSingleFlightSessionResumeState()
  $composerAttachments.set([])
})

afterEach(() => {
  cleanup()
  $composerAttachments.set([])
  $connection.set(null)
  $currentCwd.set('')
  vi.restoreAllMocks()
})

describe('hc-1210 a sent file is staged once', () => {
  it('reuses the drop-time upload when the composer cleared its chips before the send (a menu pick into an open chat)', async () => {
    // The real Enter: the composer clears its chips and passes clones, so the
    // in-flight upload's result never reaches the store. Re-reading the store
    // after the join found nothing and staged the sheet again (作品列表-2.xlsx,
    // and the model was handed the -2 copy).
    const gateway = stagingGateway()
    const { submit } = await mount({ requestGateway: gateway.requestGateway })

    $composerAttachments.set([pickedFile('作品列表.xlsx')])
    await waitFor(() => expect(gateway.attached).toEqual(['作品列表.xlsx']))

    const submitting = submit()('复盘这张表', { attachments: takeComposerChips() })
    gateway.release('作品列表.xlsx')

    await expect(submitting).resolves.toBe(true)
    expect(gateway.attached).toEqual(['作品列表.xlsx'])
    expect(gateway.prompts).toHaveLength(1)
    expect(gateway.prompts[0]).toContain('@file:attachments/作品列表.xlsx')
    expect(gateway.prompts[0]).not.toContain('作品列表-2')
  })

  it('reuses a drop-time upload that finished while an earlier chip of the same send was still staging', async () => {
    // Two picks, Enter while both upload. The send waits on the sheet; the
    // video finishes first and leaves the in-flight map. Looked up only when
    // the loop reached it, the video was staged a second time.
    const gateway = stagingGateway()
    const { submit } = await mount({ requestGateway: gateway.requestGateway })

    $composerAttachments.set([pickedFile('作品列表.xlsx'), pickedFile('口播.webm')])
    await waitFor(() => expect(gateway.attached).toEqual(['作品列表.xlsx', '口播.webm']))

    const submitting = submit()('两个一起看', { attachments: takeComposerChips() })
    gateway.release('口播.webm')
    await flush()
    gateway.release('作品列表.xlsx')

    await expect(submitting).resolves.toBe(true)
    expect(gateway.attached).toEqual(['作品列表.xlsx', '口播.webm'])
    expect(gateway.prompts[0]).toContain('@file:attachments/作品列表.xlsx')
    expect(gateway.prompts[0]).toContain('@file:attachments/口播.webm')
    expect(gateway.prompts[0]).not.toMatch(/-2\.(xlsx|webm)/)
  })

  // A new chat's first send with its chips still in the composer (the Start
  // page sends without clearing them): creating the session makes it active,
  // and the drop-time effect starts on those chips while the send stages them.
  it.each([
    { effectFirst: false, files: ['口播第一条.webm'], order: 'the send stages first' },
    { effectFirst: true, files: ['口播第一条.webm'], order: 'the drop-time upload starts first' },
    // The effect starts on every chip in the composer at once, including the
    // ones the send has not reached yet.
    { effectFirst: false, files: ['口播第一条.webm', '口播第二条.webm'], order: 'the send stages first, two files' }
  ])('stages each file of a new chat’s first send once when $order', async ({ effectFirst, files }) => {
    const gateway = stagingGateway()

    $composerAttachments.set(files.map(pickedFile))

    const { submit } = await mount({ effectFirst, newChat: true, requestGateway: gateway.requestGateway })

    expect(gateway.attached).toEqual([])

    const submitting = submit()('帮我转逐字稿')

    for (const file of files) {
      await waitFor(() => expect(gateway.attached).toContain(file))
      // Let the re-render for the new session and its effects run while this
      // upload is still held.
      await flush()
      await flush()
      gateway.release(file)
    }

    await expect(submitting).resolves.toBe(true)
    expect(gateway.attached).toEqual(files)

    for (const file of files) {
      expect(gateway.prompts[0]).toContain(`@file:attachments/${file}`)
    }

    expect(gateway.prompts[0]).not.toMatch(/-2\.webm/)
  })

  it('hands a failed send’s other chips back, so the drop-time upload and the next send can stage them', async () => {
    // The first file cannot be read: the send stops there with both chips
    // still claimed. Unless it lets them go, the drop-time effect skips them
    // for good.
    const gateway = stagingGateway({ failFirst: ['口播第一条.webm'] })

    $composerAttachments.set([pickedFile('口播第一条.webm'), pickedFile('口播第二条.webm')])

    const { submit } = await mount({ newChat: true, requestGateway: gateway.requestGateway })

    await expect(submit()('帮我转逐字稿')).resolves.toBe(false)
    expect(gateway.attached).toEqual(['口播第一条.webm'])

    // The session exists now, so the drop-time upload takes both chips.
    await waitFor(() => expect(gateway.attached).toEqual(['口播第一条.webm', '口播第一条.webm', '口播第二条.webm']))
    await waitFor(() =>
      expect($composerAttachments.get().map(chip => chip.attachedSessionId)).toEqual([SESSION, SESSION])
    )

    await expect(submit()('帮我转逐字稿')).resolves.toBe(true)
    expect(gateway.attached).toHaveLength(3)
    expect(gateway.prompts).toHaveLength(1)
    expect(gateway.prompts[0]).toContain('@file:attachments/口播第一条.webm')
    expect(gateway.prompts[0]).toContain('@file:attachments/口播第二条.webm')
    expect(gateway.prompts[0]).not.toMatch(/-2\.webm/)
  })
})
