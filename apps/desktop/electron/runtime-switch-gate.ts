import { type BackendOwnershipEntry, parseBackendOwnershipDetailed } from './backend-ownership'
import { type ClassifiedHolder, endableTargets, type EngineHolderIdentity } from './engine-holders'
import { assertPackagedRuntimeIdle, endEngineHolders } from './packaged-runtime'
import { retirePackagedGateways } from './runtime-gateway-retirement'
import { isRuntimeUpdateBusy, RuntimeUpdateBusy } from './runtime-update-busy'

interface OwnedChild {
  exitCode: null | number
  pid?: number
  signalCode: NodeJS.Signals | null
}

interface UpdateFence {
  drain: () => Promise<unknown>
  release: () => void
}

export interface RuntimeSwitchGateDeps<Fence extends UpdateFence> {
  activeRoot: string
  hermesHome: string
  /** Turns running across windows, and how many windows have reported activity at all. */
  activeWork: () => { reporters: number; running: number }
  lifecycle: { fenceForUpdate: () => Fence; ownedChildren: () => OwnedChild[] }
  reapOrphanedBackends: () => Promise<unknown>
  stopMessagingGateway: () => Promise<unknown>
  readOwnership: () => null | string
  /** `false` only when the recorded worker is proven gone or foreign. */
  identityMatches: (entry: BackendOwnershipEntry) => Promise<boolean | undefined>
  log: (message: string) => void
}

/**
 * The gate every engine switch passes: the packaged install, the bundle set and
 * the native shell install. Occupancy is RuntimeUpdateBusy, a deferred
 * transaction rather than a failure.
 *
 * `preflight` only inspects. Live work, an owned backend whose activity is not
 * reported yet, or any other engine holder is busy; messaging gateways are
 * inspected, never stopped, and the ones the switch will retire are exempt.
 * `prepare` repeats it, fences new backends, drains owned ones, retires the
 * gateways and runs a strict scan with no exemptions. It returns the fence;
 * the caller releases it after activation or rollback.
 */
export function createRuntimeSwitchGate<Fence extends UpdateFence>(deps: RuntimeSwitchGateDeps<Fence>) {
  async function preflight(verifiedRoot = deps.activeRoot) {
    const work = deps.activeWork()

    if (work.running > 0) {
      throw new RuntimeUpdateBusy()
    }

    const ownedBackendPids = deps.lifecycle
      .ownedChildren()
      .filter(child => child.exitCode === null && child.signalCode === null && child.pid)
      .map(child => child.pid!)

    if (ownedBackendPids.length && work.reporters === 0) {
      throw new RuntimeUpdateBusy('Waiting for Desktop activity state.', 'activity_unknown')
    }

    await deps.reapOrphanedBackends()
    const retiringGatewayPids = await retirePackagedGateways(deps.activeRoot, verifiedRoot, deps.hermesHome, true)
    await assertPackagedRuntimeIdle(deps.activeRoot, verifiedRoot, { ownedBackendPids, retiringGatewayPids })
  }

  async function prepare(verifiedRoot: string) {
    // Preserve the usable backend until external holders and active work are clear.
    // A second, strict scan under the spawn fence still gates the actual switch.
    await preflight(verifiedRoot)

    if (deps.activeWork().running > 0) {
      throw new RuntimeUpdateBusy()
    }

    const fence = deps.lifecycle.fenceForUpdate()

    try {
      await fence.drain()
      const retired = await retirePackagedGateways(deps.activeRoot, verifiedRoot, deps.hermesHome)
      await deps.stopMessagingGateway()

      if (retired.length) {
        deps.log(`[bundled-engine] retired owned messaging gateways: ${retired.join(', ')}`)
      }

      // The ownership reaper already validates both parent and child identity.
      // A remaining live/unknown record may belong to another Desktop; never kill it.
      await deps.reapOrphanedBackends()
      const ownership = parseBackendOwnershipDetailed(deps.readOwnership())

      if (ownership.corrupt) {
        throw new Error('Could not verify previous Desktop engine ownership. Retry after closing its local workers.')
      }

      for (const entry of ownership.entries) {
        if ((await deps.identityMatches(entry)) !== false) {
          throw new RuntimeUpdateBusy('Waiting for a previous Desktop engine worker.', 'previous_worker')
        }
      }

      await assertPackagedRuntimeIdle(deps.activeRoot, verifiedRoot)

      return fence
    } catch (error) {
      fence.release()
      throw error
    }
  }

  /**
   * hc-1094: end the APEX leftovers a user confirmed (PID + start time) after a fresh scan proves
   * they still are leftovers; whatever else holds the engine is left alone and only logged. The
   * caller retries its install or switch afterwards, through the usual gate.
   */
  async function endLeftovers(confirmed: EngineHolderIdentity[]) {
    let holders: Record<string, ClassifiedHolder | undefined> = {}

    try {
      await assertPackagedRuntimeIdle(deps.activeRoot, deps.activeRoot)
    } catch (error) {
      if (!isRuntimeUpdateBusy(error)) {
        throw error
      }

      holders = (error as { idleProof?: { holders?: typeof holders } }).idleProof?.holders ?? {}
    }

    const targets = endableTargets(holders, confirmed)
    const ended = await endEngineHolders(deps.activeRoot, targets)
    const left = Object.entries(holders).filter(([pid]) => !(pid in ended)).map(([pid, detail]) => `${pid} ${detail?.kind ?? 'other'}`)

    deps.log(`[engine-holders] end requested for ${confirmed.map(item => item.pid).join(', ') || 'none'}: ${
      targets.map(target => `${target.pid} ${target.kind}${target.leftover ? ` of ${target.leftover}` : ''} ${ended[target.pid]}`).join('; ') || 'nothing endable'
    }${left.length ? `; left alone: ${left.join('; ')}` : ''}`)

    return ended
  }

  return { preflight, prepare, endLeftovers }
}
