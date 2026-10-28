import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createRuntimeSwitchGate } from './runtime-switch-gate'
import { isRuntimeUpdateBusy, RuntimeUpdateBusy } from './runtime-update-busy'

// The native halves run for real elsewhere: the Python gateway retirement in
// runtime-gateway-retirement.test.ts, the psutil idle scan in packaged-runtime.test.ts.
const retire = vi.hoisted(() => vi.fn())
const assertIdle = vi.hoisted(() => vi.fn())
const endHolders = vi.hoisted(() => vi.fn())

vi.mock('./runtime-gateway-retirement', () => ({ retirePackagedGateways: retire }))
vi.mock('./packaged-runtime', () => ({ assertPackagedRuntimeIdle: assertIdle, endEngineHolders: endHolders }))

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
  endHolders.mockReset().mockImplementation(async (_root: string, targets: { pid: number }[]) => Object.fromEntries(targets.map(target => [target.pid, 'terminated'])))
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

  it('names what each busy answer waits for (hc-1030)', async () => {
    const owned = [{ exitCode: null, pid: 7, signalCode: null }]

    await expect(harness({ work: [1] }).gate.preflight()).rejects.toMatchObject({ reason: 'active_work' })
    await expect(harness({ children: owned, reporters: 0 }).gate.preflight()).rejects.toMatchObject({
      reason: 'activity_unknown'
    })
    await expect(harness({ ownership: PREVIOUS_OWNER, owner: true }).gate.prepare('/verified')).rejects.toMatchObject({
      reason: 'previous_worker'
    })
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

describe('endLeftovers (hc-1094)', () => {
  const gateway = { name: 'python3.11', ppid: 1, exe: '/engine/venv/bin/python', argv: [], created: 7.5, kind: 'leftover_gateway', endable: true }

  const busyWith = (holders: Record<number, unknown>) =>
    Object.assign(new RuntimeUpdateBusy('Waiting for engine workers', 'engine_holders'), { idleProof: { holders } })

  it('rescans without exemptions and ends only confirmed leftovers, leftover roots first', async () => {
    assertIdle.mockRejectedValue(
      busyWith({
        1400: { ...gateway, name: 'node', exe: '/usr/bin/node', created: 9.5, leftover: 1347 },
        1347: gateway,
        2001: { ...gateway, created: 8.5, kind: 'terminal_hermes', endable: false },
        2100: { ...gateway, created: 3.5 }
      })
    )
    const { deps, gate } = harness()

    const ended = await gate.endLeftovers([
      { pid: 1347, created: 7.5 },
      { pid: 1400, created: 9.5 },
      { pid: 2001, created: 8.5 },
      { pid: 2100, created: 4.5 }
    ])

    expect(assertIdle).toHaveBeenCalledExactlyOnceWith('/engine', '/engine')
    expect(endHolders).toHaveBeenCalledExactlyOnceWith('/engine', [
      { pid: 1347, created: 7.5, exe: '/engine/venv/bin/python', kind: 'leftover_gateway', leftover: undefined },
      { pid: 1400, created: 9.5, exe: '/usr/bin/node', kind: 'leftover_gateway', leftover: 1347 }
    ])
    expect(ended).toEqual({ 1347: 'terminated', 1400: 'terminated' })
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(
      '[engine-holders] end requested for 1347, 1400, 2001, 2100: 1347 leftover_gateway terminated; 1400 leftover_gateway of 1347 terminated; left alone: 2001 terminal_hermes; 2100 leftover_gateway'
    )
  })

  it('ends nothing when the engine is already idle', async () => {
    const { deps, gate } = harness()

    await expect(gate.endLeftovers([{ pid: 1347, created: 7.5 }])).resolves.toEqual({})
    expect(endHolders).toHaveBeenCalledExactlyOnceWith('/engine', [])
    expect(deps.log).toHaveBeenCalledExactlyOnceWith('[engine-holders] end requested for 1347: nothing endable')
  })

  it('a scan that fails without being busy fails the request and ends nothing', async () => {
    assertIdle.mockRejectedValue(new Error('Could not verify existing engine workers.'))
    const { gate } = harness()

    await expect(gate.endLeftovers([{ pid: 1347, created: 7.5 }])).rejects.toThrow('Could not verify existing engine workers.')
    expect(endHolders).not.toHaveBeenCalled()
  })
})
