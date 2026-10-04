import { afterEach, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/api/client'
import { fetchVoiceLiveStatus, type VoiceLiveStatus } from '@/lib/voice-live'

import { $voiceLiveStatus, refreshVoiceLiveStatus } from './voice-live'

vi.mock('@/lib/voice-live', () => ({ fetchVoiceLiveStatus: vi.fn() }))

const status: VoiceLiveStatus = {
  mode: 'qwen-realtime',
  available: true,
  reason: null,
  model: 'Flash',
  voice: 'longanqian'
}

afterEach(() => {
  setApiRequestConnection(null)
  setApiRequestProfile(null)
  vi.clearAllMocks()
})

it('a late status from the previous account/connection cannot replace the active scope', async () => {
  let resolvePrevious: ((value: VoiceLiveStatus) => void) | undefined
  vi.mocked(fetchVoiceLiveStatus).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolvePrevious = resolve
      })
  )
  setApiRequestConnection('previous')
  setApiRequestProfile('previous-user')
  const old = refreshVoiceLiveStatus()
  setApiRequestConnection('current')
  setApiRequestProfile('current-user')
  vi.mocked(fetchVoiceLiveStatus).mockResolvedValueOnce(status)
  await refreshVoiceLiveStatus()
  resolvePrevious?.({ ...status, available: false })
  await expect(old).resolves.toBeNull()
  expect($voiceLiveStatus.get()).toEqual(status)
})
