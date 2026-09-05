export const APEX_DESKTOP_PROTOCOL = 'apexnodes'
export const HERMES_COMPAT_PROTOCOL = 'hermes'

export type DesktopDeepLinkSource = 'cold-start' | 'macos-open-url' | 'second-instance' | 'unknown'

export interface DesktopDeepLinkPayload {
  kind: string
  name: string
  params: Record<string, string>
}

type RejectedDesktopDeepLink = {
  accepted: false
  reason: 'duplicate-code' | 'malformed' | 'missing-code' | 'unsupported-scheme'
}

export type DesktopDeepLinkResult =
  { accepted: true; disposition: 'delivered' | 'queued'; payload: DesktopDeepLinkPayload } | RejectedDesktopDeepLink

interface DesktopDeepLinkRouterDependencies {
  deliver: (payload: DesktopDeepLinkPayload) => boolean
  log?: (message: string) => void
}

interface DesktopProtocolRegistrar {
  setAsDefaultProtocolClient: (scheme: string, executable?: string, args?: string[]) => boolean
}

interface DesktopProtocolDevelopmentLaunch {
  entryScript: string
  executable: string
}

interface ParsedDesktopDeepLink {
  loginCode: string | null
  payload: DesktopDeepLinkPayload
}

function parseDesktopDeepLink(rawUrl: string): ParsedDesktopDeepLink | RejectedDesktopDeepLink {
  let parsed: URL

  try {
    parsed = new URL(rawUrl)
  } catch {
    return { accepted: false, reason: 'malformed' }
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()

  if (scheme !== APEX_DESKTOP_PROTOCOL && scheme !== HERMES_COMPAT_PROTOCOL) {
    return { accepted: false, reason: 'unsupported-scheme' }
  }

  const kind = parsed.hostname.toLowerCase()
  const params: Record<string, string> = {}
  parsed.searchParams.forEach((value, key) => {
    params[key] = value
  })

  if (kind === 'login') {
    // Login handoffs are an APEX product credential. The legacy Hermes scheme
    // remains parse-compatible only for non-auth links and is never claimed by
    // this app at the OS layer.
    if (scheme !== APEX_DESKTOP_PROTOCOL) {
      return { accepted: false, reason: 'unsupported-scheme' }
    }

    const codes = parsed.searchParams.getAll('code')
    const code = codes.length === 1 ? codes[0]?.trim() : ''

    if (!code) {
      return { accepted: false, reason: 'missing-code' }
    }

    params.code = code

    return { loginCode: code, payload: { kind, name: '', params } }
  }

  let name = ''

  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  } catch {
    return { accepted: false, reason: 'malformed' }
  }

  return { loginCode: null, payload: { kind, name, params } }
}

export function findDesktopDeepLink(argv: readonly unknown[]): string | null {
  if (!Array.isArray(argv)) {
    return null
  }

  return (argv.find(
    value =>
      typeof value === 'string' &&
      (value.toLowerCase().startsWith(`${APEX_DESKTOP_PROTOCOL}://`) ||
        value.toLowerCase().startsWith(`${HERMES_COMPAT_PROTOCOL}://`))
  ) ?? null) as string | null
}

/** Register APEX at the OS boundary. Hermes remains parser compatibility only. */
export function registerApexDesktopProtocol(
  registrar: DesktopProtocolRegistrar,
  developmentLaunch?: DesktopProtocolDevelopmentLaunch
): boolean {
  if (developmentLaunch) {
    return registrar.setAsDefaultProtocolClient(APEX_DESKTOP_PROTOCOL, developmentLaunch.executable, [
      developmentLaunch.entryScript
    ])
  }

  return registrar.setAsDefaultProtocolClient(APEX_DESKTOP_PROTOCOL)
}

export function createDesktopDeepLinkRouter({ deliver, log = () => {} }: DesktopDeepLinkRouterDependencies) {
  const queued: DesktopDeepLinkPayload[] = []
  const consumedLoginCodes = new Set<string>()
  let rendererReady = false

  const deliverOrQueue = (payload: DesktopDeepLinkPayload): 'delivered' | 'queued' => {
    if (rendererReady && deliver(payload)) {
      log(`[deeplink] delivered ${payload.kind}/${payload.name}`)

      return 'delivered'
    }

    queued.push(payload)
    log(`[deeplink] queued ${payload.kind}/${payload.name}`)

    return 'queued'
  }

  return {
    accept(rawUrl: unknown, source: DesktopDeepLinkSource = 'unknown'): DesktopDeepLinkResult {
      if (typeof rawUrl !== 'string' || !rawUrl) {
        log(`[deeplink] rejected ${source}: malformed`)

        return { accepted: false, reason: 'malformed' }
      }

      const parsed = parseDesktopDeepLink(rawUrl)

      if ('accepted' in parsed) {
        log(`[deeplink] rejected ${source}: ${parsed.reason}`)

        return parsed
      }

      if (parsed.loginCode) {
        if (consumedLoginCodes.has(parsed.loginCode)) {
          log(`[deeplink] rejected ${source}: duplicate-code`)

          return { accepted: false, reason: 'duplicate-code' }
        }

        // Reserve before queuing/delivery so two OS callbacks in the same tick
        // cannot submit the same one-time credential twice.
        consumedLoginCodes.add(parsed.loginCode)
      }

      const disposition = deliverOrQueue(parsed.payload)

      return { accepted: true, disposition, payload: parsed.payload }
    },

    markRendererReady(): number {
      rendererReady = true
      let delivered = 0

      while (queued.length > 0) {
        const payload = queued[0]

        if (!deliver(payload)) {
          break
        }

        queued.shift()
        delivered += 1
        log(`[deeplink] delivered queued ${payload.kind}/${payload.name}`)
      }

      return delivered
    },

    markRendererUnavailable(): void {
      rendererReady = false
    },

    pendingCount(): number {
      return queued.length
    }
  }
}
