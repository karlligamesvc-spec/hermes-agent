import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// hc-1086: the relay dispatcher asks whether one assistant's engine is up in
// this window (openSecondaryCount(profile)) before it would start one; the
// hover prewarm keeps asking how many pool sockets are open in all.

vi.mock('@/hermes', () => ({
  setApiRequestConnection: vi.fn(),
  HermesGateway: class {
    connectionState = 'closed'
    connect = async (): Promise<void> => {
      this.connectionState = 'open'
    }
    close = (): void => {
      this.connectionState = 'closed'
    }
    onEvent = vi.fn(() => () => {})
    onState = vi.fn(() => () => {})
  }
}))
vi.mock('@/store/session', () => ({ setConnection: vi.fn(), setGatewayState: vi.fn() }))
vi.mock('@/store/notify-baseline', () => ({ markNativeNotifyBaseline: vi.fn() }))

const {
  closeSecondaryGateways,
  configureGatewayRegistry,
  openGatewayForProfile,
  openSecondaryCount,
  setPrimaryGateway
} = await import('./gateway')

const localConnection = (profile: string) => ({
  authMode: 'token',
  baseUrl: 'http://127.0.0.1:9',
  mode: 'local',
  profile,
  token: 'fake-test-token',
  wsUrl: `ws://127.0.0.1:9/api/ws?token=fake-test-token&profile=${profile}`
})

beforeEach(() => {
  configureGatewayRegistry({ onEvent: vi.fn() })
  setPrimaryGateway({ connectionState: 'open' } as never, 'default')
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    getConnection: vi.fn(async (profile: string) => localConnection(profile))
  }
})

afterEach(() => {
  closeSecondaryGateways()
  vi.clearAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('openSecondaryCount', () => {
  it('counts every open pool socket, or only one profile’s', async () => {
    await openGatewayForProfile('writer')
    await openGatewayForProfile('editor')

    expect(openSecondaryCount()).toBe(2)
    expect(openSecondaryCount('writer')).toBe(1)
    expect(openSecondaryCount(' writer ')).toBe(1)
    expect(openSecondaryCount('titles')).toBe(0)
    // The primary is never a pool socket.
    expect(openSecondaryCount('default')).toBe(0)
  })

  it('a closed socket is not an engine that is up', async () => {
    await openGatewayForProfile('writer')
    closeSecondaryGateways()

    expect(openSecondaryCount('writer')).toBe(0)
    expect(openSecondaryCount()).toBe(0)
  })
})
