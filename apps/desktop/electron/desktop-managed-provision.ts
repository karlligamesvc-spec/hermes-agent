import { ModelMutationError } from './desktop-model-mutations'

export class ManagedProvisionError extends Error {
  readonly code = 'MANAGED_PROVISION_UNAVAILABLE'
  constructor(public statusCode?: number) {super('MANAGED_PROVISION_UNAVAILABLE')}
}

/** Login and logout share one ordered device-key mutation capability. */
export async function requestRevisionedManagedKeyMutation(args: {
  capabilities: () => Promise<unknown>
  nextRevision: () => number
  issue: (revision: number) => Promise<any>
  isCurrent: () => boolean
  beginMutation: () => (() => void)
  recordUnknownMutation: () => void
  validateResponse?: (response: any) => void
}): Promise<any> {
  const assertCurrent = () => {
    if (!args.isCurrent()) {throw new ModelMutationError('MODEL_MUTATION_SUPERSEDED')}
  }

  assertCurrent()
  let capability: unknown

  try {capability = await args.capabilities()} catch (error: any) {
    assertCurrent()
    throw new ManagedProvisionError(error?.statusCode)
  }

  assertCurrent()

  if ((capability as { version?: unknown })?.version !== 1) {throw new ManagedProvisionError()}
  const revision = args.nextRevision()

  if (!Number.isSafeInteger(revision) || revision <= 0) {throw new ManagedProvisionError()}
  assertCurrent()
  const rollback = args.beginMutation()
  assertCurrent()
  let response: any

  try {response = await args.issue(revision)} catch (error: any) {
    assertCurrent()

    // Explicit auth/validation/superseded responses are rejected before mutation.
    // Timeouts, proxy errors and malformed success do not prove a key unchanged.
    if ([401, 403, 409, 422].includes(error?.statusCode)) {rollback()} else {args.recordUnknownMutation()}
    throw new ManagedProvisionError(error?.statusCode)
  }

  assertCurrent()

  if (response?.provision_revision !== revision) {
    args.recordUnknownMutation()
    throw new ManagedProvisionError()
  }

  try {args.validateResponse?.(response)} catch {
    args.recordUnknownMutation()
    throw new ManagedProvisionError()
  }

  return response
}
