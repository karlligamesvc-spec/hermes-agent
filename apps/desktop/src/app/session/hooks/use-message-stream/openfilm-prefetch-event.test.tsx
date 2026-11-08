/**
 * hc-1176: a video tool an agent starts (tool.start, in any session) has main
 * install the editor's toolkit in the background; other tools do not.
 */
import type { GatewayEvent } from '@hermes/shared'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $openfilmStudioOn } from '@/lib/openfilm-studio'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

const SID = 'session-1'

let stream: MessageStreamHarness

function emit(type: GatewayEvent['type'], payload: GatewayEvent['payload'] = {}, sessionId = SID) {
  act(() => stream.handleEvent({ payload, session_id: sessionId, type }))
}

describe('the editor toolkit and video tools', () => {
  const original = window.hermesDesktop
  const prefetch = vi.fn(async () => 'started' as const)

  beforeEach(() => {
    prefetch.mockClear()
    window.hermesDesktop = {
      ...(window.hermesDesktop ?? {}),
      openfilmStudio: {
        open: vi.fn(),
        prefetch,
        status: vi.fn(async () => ({ on: true, ready: false, preparing: false }))
      }
    } as Window['hermesDesktop']
    $openfilmStudioOn.set(true)
    stream = renderMessageStream(SID)
  })

  afterEach(() => {
    cleanup()
    $openfilmStudioOn.set(false)
    window.hermesDesktop = original
  })

  it('starts the install when an agent starts a video tool, also in a background session', () => {
    emit('tool.start', { name: 'terminal', tool_id: 'tool-1' })
    expect(prefetch).not.toHaveBeenCalled()

    emit('tool.start', { name: 'generate_video', tool_id: 'tool-2' })
    emit('tool.start', { name: 'video_generate', tool_id: 'tool-3' }, 'session-2')

    expect(prefetch).toHaveBeenCalledTimes(2)
  })
})
