/**
 * hc-1086 identity harness: what the single-thread shell asks the engine and
 * writes to this install's storage while it is open, with no relay (接力) in
 * play. Uses only APIs fork main aa8e554e already has, so the same file
 * records on main and checks on the branch.
 */

import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'

import type { RequestGateway } from '@/app/single-thread/composer-middleware'
import { useSingleThreadShell } from '@/app/single-thread/use-single-thread-shell'
import { MAIN_THREAD_TITLE } from '@/store/main-thread'

/** Two assistants: APEX (`default`, thread `apex-root`) and 小红书文案 (`writer`, thread `writer-root`). */
const THREADS: Record<string, string> = { default: 'apex-root', writer: 'writer-root' }

function answer(method: string, params: Record<string, unknown> | undefined): unknown {
  if (method === 'session.list') {
    const id = THREADS[String(params?.profile)]

    return { sessions: id ? [{ id, title: MAIN_THREAD_TITLE }] : [] }
  }

  if (method === 'profiles.list') {
    return {
      profiles: [
        { is_default: true, name: 'default' },
        { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }
      ]
    }
  }

  if (method === 'profiles.describe') {
    return { soul: '你是小红书文案。' }
  }

  return {}
}

function Shell({ request }: { request: RequestGateway }) {
  useSingleThreadShell(request)

  return null
}

export interface ShellTrace {
  /** Every engine request, in order: method and params. */
  requests: [string, unknown][]
  /** Every storage key written, in order of first write. */
  storage: string[]
}

/** Mount the shell, let it settle and run `ticks` roster refreshes (20 s each), then unmount. */
export async function traceShell(ticks: number): Promise<ShellTrace> {
  const requests: [string, unknown][] = []
  const storage: string[] = []
  const setItem = Storage.prototype.setItem

  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (!storage.includes(key)) {
      storage.push(key)
    }

    setItem.call(this, key, value)
  })

  const request = (async (method: string, params?: Record<string, unknown>) => {
    requests.push([method, params ?? null])

    return answer(method, params)
  }) as RequestGateway

  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })

  try {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Shell request={request} />
      </MemoryRouter>
    )

    for (let tick = 0; tick <= ticks; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(tick === 0 ? 0 : 20_000)
      })
    }

    cleanup()
  } finally {
    vi.useRealTimers()
    spy.mockRestore()
  }

  return { requests, storage }
}

export function traceJson(trace: ShellTrace): string {
  return `${JSON.stringify(trace, null, 2)}\n`
}
