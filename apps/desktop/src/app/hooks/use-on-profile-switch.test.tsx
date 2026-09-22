import { act, cleanup, render } from '@testing-library/react'
import type { WritableAtom } from 'nanostores'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/profile', async () => {
  const { atom } = await import('nanostores')

  return { $activeGatewayProfile: atom('default') }
})

import { $activeGatewayProfile } from '@/store/profile'

import { useOnProfileSwitch } from './use-on-profile-switch'

const activeProfile = $activeGatewayProfile as WritableAtom<string>

function Harness({ onSwitch }: { onSwitch: () => void }) {
  useOnProfileSwitch(onSwitch)

  return null
}

afterEach(() => {
  cleanup()
  activeProfile.set('default')
})

describe('useOnProfileSwitch', () => {
  it('does not report StrictMode mount replay as a profile switch', () => {
    const onSwitch = vi.fn()

    render(
      <StrictMode>
        <Harness onSwitch={onSwitch} />
      </StrictMode>
    )

    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('reports each actual profile change exactly once', () => {
    const onSwitch = vi.fn()

    render(
      <StrictMode>
        <Harness onSwitch={onSwitch} />
      </StrictMode>
    )

    act(() => activeProfile.set('research'))

    expect(onSwitch).toHaveBeenCalledTimes(1)
  })
})
