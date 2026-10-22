import { ModelMutationError } from './desktop-model-mutations'

// Server refusals that retrying cannot fix get their own sign-in copy
// (src/i18n/managed-sign-in.ts). Every other failure, including
// `desktop_provision_superseded` on the same 409, stays MANAGED_PROVISION_UNAVAILABLE.
const PROVISION_REFUSAL_MARKERS = new Map([['desktop_device_key_limit_reached', 'MANAGED_DEVICE_LIMIT_REACHED']])

/** `detail.code` of an ApexNodes HTTP error, whose message reads `${status}: ${body}` (main.ts apexAuthPostJson). */
function provisionServerCode(error: any): string | undefined {
  const message = typeof error?.statusCode === 'number' && typeof error?.message === 'string' ? error.message : ''

  try {
    const code = JSON.parse(message.slice(message.indexOf(': ') + 2))?.detail?.code

    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

export class ManagedProvisionError extends Error {
  readonly code: string

  constructor(public statusCode?: number, public serverCode?: string) {
    super((serverCode && PROVISION_REFUSAL_MARKERS.get(serverCode)) || 'MANAGED_PROVISION_UNAVAILABLE')
    this.code = this.message
  }
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
    throw new ManagedProvisionError(error?.statusCode, provisionServerCode(error))
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
    throw new ManagedProvisionError(error?.statusCode, provisionServerCode(error))
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
