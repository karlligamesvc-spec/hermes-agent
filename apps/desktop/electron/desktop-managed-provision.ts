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

/** main.ts apexAuthBodylessJson. */
type BodylessGet = (method: 'GET', url: string, options: { bearer: null | string | undefined }) => Promise<unknown>

const capabilityReads = new Map<string, Promise<unknown>>()

function readCapabilities(provisionKeyUrl: string, bearer: null | string | undefined, get: BodylessGet): Promise<unknown> {
  const forget = () => {
    if (capabilityReads.get(provisionKeyUrl) === pending) {capabilityReads.delete(provisionKeyUrl)}
  }

  const pending = get('GET', `${provisionKeyUrl}/capabilities`, { bearer }).then(
    answer => {
      if ((answer as { version?: unknown })?.version !== 1) {forget()}

      return answer
    },
    error => {
      forget()
      throw error
    }
  )

  capabilityReads.set(provisionKeyUrl, pending)

  return pending
}

/**
 * hc-1142: the provision-key capabilities, read once per run. A sign-out used
 * to GET them right before its revoke: one more round trip to apex-nodes.com
 * while the window waited. They say whether the server takes ordered device-key
 * mutations (version 1), a fact about the server rather than the account, so
 * one version-1 answer is kept for that URL for the rest of the run and a read
 * still in flight is joined. Anything else, or a failure, is asked again next
 * time; a joined read that failed is retried once on the spot.
 *
 * What proves a mutation is still its own response: the echoed revision
 * (requestRevisionedManagedKeyMutation) and, for a sign-out, `revoked: true`.
 */
export function provisionKeyCapabilities(provisionKeyUrl: string, bearer: null | string | undefined, get: BodylessGet): Promise<unknown> {
  const shared = capabilityReads.get(provisionKeyUrl)

  return shared
    ? shared.catch(() => readCapabilities(provisionKeyUrl, bearer, get))
    : readCapabilities(provisionKeyUrl, bearer, get)
}

/** The account menu opened: have the capabilities ready before 退出登录 is clicked. Never throws. */
export function warmProvisionKeyCapabilities(provisionKeyUrl: string, bearer: null | string | undefined, get: BodylessGet) {
  if (bearer) {
    provisionKeyCapabilities(provisionKeyUrl, bearer, get).catch(() => undefined)
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
