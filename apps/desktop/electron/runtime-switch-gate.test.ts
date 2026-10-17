import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createRuntimeSwitchGate } from './runtime-switch-gate'
import { isRuntimeUpdateBusy, RuntimeUpdateBusy } from './runtime-update-busy'

// The native halves run for real elsewhere: the Python gateway retirement in
// runtime-gateway-retirement.test.ts, the psutil idle scan in packaged-runtime.test.ts.
const retire = vi.hoisted(() => vi.fn())
const assertIdle = vi.hoisted(() => vi.fn())

vi.mock('./runtime-gateway-retirement', () => ({ retirePackagedGateways: retire }))
vi.mock('./packaged-runtime', () => ({ assertPackagedRuntimeIdle: assertIdle }))

interface Child {
  exitCode: null | number
  pid?: number
  signalCode: NodeJS.Signals | null
}

const PREVIOUS_OWNER = JSON.stringify([{ nonce: 'n', pid: 4242, profile: 'default', startMarker: 's' }])

function harness(
  options: { children?: Child[]; ownership?: null | string; owner?: boolean | undefined; reporters?: number; work?: number[] } = {}
) {
  const events: string[] = []
  const running = [...(options.work ?? [0])]
  const fence = { drain: vi.fn(async () => void events.push('drain')), release: vi.fn(() => void events.push('release')) }

  const deps = {
    activeRoot: '/engine',
    hermesHome: '/home',
    activeWork: () => ({ reporters: options.reporters ?? 1, running: running.length > 1 ? running.shift()! : running[0]! }),
    lifecycle: {
      fenceForUpdate: vi.fn(() => {
        events.push('fence')

        return fence
      }),
      ownedChildren: () => options.children ?? []
    },
    reapOrphanedBackends: vi.fn(async () => void events.push('reap')),
    stopMessagingGateway: vi.fn(async () => void events.push('stop-messaging')),
    readOwnership: () => options.ownership ?? null,
    identityMatches: vi.fn(async () => options.owner),
    log: vi.fn()
  }

  return { deps, events, fence, gate: createRuntimeSwitchGate(deps) }
}

beforeEach(() => {
  retire.mockReset().mockResolvedValue([])
  assertIdle.mockReset().mockResolvedValue({})
})

describe('preflight', () => {
  it('turns live work into a busy deferral before probing anything', async () => {
    const { deps, gate } = harness({ work: [1] })

    await expect(gate.preflight()).rejects.toSatisfy(isRuntimeUpdateBusy)
    expect(deps.reapOrphanedBackends).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
    expect(assertIdle).not.toHaveBeenCalled()
  })

  it('waits while an owned backend runs and no window has reported its activity', async () => {
    const owned = [{ exitCode: null, pid: 7, signalCode: null }]

    await expect(harness({ children: owned, reporters: 0 }).gate.preflight()).rejects.toThrow(
      'Waiting for Desktop activity state.'
    )
    await expect(harness({ children: owned, reporters: 1 }).gate.preflight()).resolves.toBeUndefined()
  })

  it('only inspects gateways and exempts the live owned backends and the gateways the switch retires', async () => {
    const children = [
      { exitCode: null, pid: 7, signalCode: null },
      { exitCode: 0, pid: 8, signalCode: null },
      { exitCode: null, pid: 9, signalCode: 'SIGTERM' as const }
    ]

    const { deps, gate } = harness({ children })

    retire.mockResolvedValue([55])

    await gate.preflight('/verified')

    expect(retire).toHaveBeenCalledExactlyOnceWith('/engine', '/verified', '/home', true)
    expect(assertIdle).toHaveBeenCalledExactlyOnceWith('/engine', '/verified', { ownedBackendPids: [7], retiringGatewayPids: [55] })
    expect(deps.lifecycle.fenceForUpdate).not.toHaveBeenCalled()
    expect(deps.stopMessagingGateway).not.toHaveBeenCalled()

    await gate.preflight()
    expect(retire).toHaveBeenLastCalledWith('/engine', '/engine', '/home', true)
  })
})

describe('prepare', () => {
  it('preflights, fences, drains, retires, then runs a strict scan and hands back the held fence', async () => {
    const { events, fence, gate } = harness()

    retire.mockImplementation(async (...args: unknown[]) => {
      events.push(args[3] ? 'inspect-gateways' : 'retire-gateways')

      return []
    })
    assertIdle.mockImplementation(async (...args: unknown[]) => void events.push(args[2] ? 'scan-with-exemptions' : 'strict-scan'))

    await expect(gate.prepare('/verified')).resolves.toBe(fence)
    expect(events).toEqual([
      'reap',
      'inspect-gateways',
      'scan-with-exemptions',
      'fence',
      'drain',
      'retire-gateways',
      'stop-messaging',
      'reap',
      'strict-scan'
    ])
    expect(assertIdle).toHaveBeenLastCalledWith('/engine', '/verified')
    expect(fence.release).not.toHaveBeenCalled()
  })

  it('work that starts during the preflight is busy before any fence is taken', async () => {
    const { deps, gate } = harness({ work: [0, 1] })

    await expect(gate.prepare('/verified')).rejects.toSatisfy(isRuntimeUpdateBusy)
    expect(deps.lifecycle.fenceForUpdate).not.toHaveBeenCalled()
  })

  it.each([
    [true, true],
    [undefined, true],
    [false, false]
  ])('a previous owner whose identity check says %s is busy=%s', async (owner, busy) => {
    const { fence, gate } = harness({ ownership: PREVIOUS_OWNER, owner })
    const outcome = await gate.prepare('/verified').then(() => 'ready', error => (isRuntimeUpdateBusy(error) ? 'busy' : error))

    expect(outcome).toBe(busy ? 'busy' : 'ready')
    expect(fence.release).toHaveBeenCalledTimes(busy ? 1 : 0)
  })

  it('unreadable ownership fails without masquerading as busy and releases the fence', async () => {
    const { fence, gate } = harness({ ownership: '{' })
    const failure = await gate.prepare('/verified').catch(error => error)

    expect(failure).toBeInstanceOf(Error)
    expect(isRuntimeUpdateBusy(failure)).toBe(false)
    expect(fence.release).toHaveBeenCalledOnce()
  })

  it('a holder found by the strict scan releases the fence', async () => {
    const { fence, gate } = harness()

    assertIdle.mockResolvedValueOnce({}).mockRejectedValueOnce(new RuntimeUpdateBusy('Waiting for engine workers: 77'))

    await expect(gate.prepare('/verified')).rejects.toSatisfy(isRuntimeUpdateBusy)
    expect(fence.release).toHaveBeenCalledOnce()
  })
})
