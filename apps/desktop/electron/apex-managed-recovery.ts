import { canApplyManagedRenewal } from './apex-account-boundary'

/** Boot, catalog and renderer recovery share one attempt per credential lifetime. */
export class ManagedRelayRecoveryCoordinator {
  private readonly inFlight = new Map<number, Promise<unknown>>()

  run<T>(generation: number, recover: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(generation)

    if (existing) {return existing as Promise<T>}

    const pending = Promise.resolve().then(recover)
    this.inFlight.set(generation, pending)
    void pending.finally(() => {
      if (this.inFlight.get(generation) === pending) {this.inFlight.delete(generation)}
    }).catch(() => undefined)

    return pending
  }
}

/** JWT sliding retains the owner/key lifetime; login, logout and key writes advance it. */
export class ManagedCredentialLifetime {
  private generation = 0

  current(): number {return this.generation}

  persist(write: () => void, renewal = false): number {
    write()

    if (!renewal) {this.generation++}

    return this.generation
  }
}

/** The network receipt is committed only by the account that started it. */
export async function provisionManagedRelayForCurrentAccount<T>(args: {
  request: () => Promise<T | null>
  isCurrent: () => boolean
  commit: (provisioned: T) => number
  unavailable: (error: unknown) => void
}): Promise<
  | { ok: true; hasRelayKey: true; credentialGeneration: number; provisionStatus?: never }
  | { ok: boolean; hasRelayKey: false; provisionStatus?: number; credentialGeneration?: never }
> {
  let provisioned: T | null = null
  let provisionStatus: number | undefined

  try {
    provisioned = await args.request()
  } catch (error) {
    const status = (error as { statusCode?: unknown })?.statusCode
    provisionStatus = typeof status === 'number' ? status : undefined
    args.unavailable(error)
  }

  if (!args.isCurrent()) {return { ok: false, hasRelayKey: false, provisionStatus }}

  if (!provisioned) {return { ok: true, hasRelayKey: false, provisionStatus }}

  return { ok: true, hasRelayKey: true, credentialGeneration: args.commit(provisioned) }
}

export function managedProvisionCommitToken(requestToken: string, currentToken: string, purpose: 'sign-in' | 'recovery'): string {
  if (purpose === 'sign-in') {return requestToken}

  return canApplyManagedRenewal(requestToken, requestToken, currentToken) ? currentToken : requestToken
}
