/**
 * hc-1079: the slice of the engine's `profiles.*` methods a new assistant's
 * first-open questions use (tui_gateway/methods_profiles.py), over in-memory
 * profiles: `profiles.list` rows with `ui_meta`, `profiles.describe` with the
 * SOUL text, and `profiles.configure` writing `soul` and key-wise `ui_meta`
 * independently, each reported in `applied`.
 */

export interface FakeProfile {
  soul: string
  uiMeta: Record<string, unknown>
}

export interface FakeProfileEngine {
  calls: { method: string; params: Record<string, unknown> }[]
  /** The next `profiles.configure` of this section reports it was not applied. */
  failNext: (section: 'soul' | 'ui_meta') => void
  profiles: Map<string, FakeProfile>
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  /** The configure writes, in order: `soul` or `ui_meta`. */
  writes: () => string[]
}

export function fakeProfileEngine(profiles: Record<string, Partial<FakeProfile>>): FakeProfileEngine {
  const store = new Map(Object.entries(profiles).map(([name, profile]) => [name, { soul: '', uiMeta: {}, ...profile }]))

  const calls: FakeProfileEngine['calls'] = []
  const failing = new Set<string>()

  const request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params })
    const profile = store.get(String(params.name ?? ''))

    if (method === 'profiles.list') {
      return {
        profiles: [...store].map(([name, row]) => ({
          name,
          ...(Object.keys(row.uiMeta).length ? { ui_meta: structuredClone(row.uiMeta) } : {})
        }))
      } as T
    }

    if (!profile) {
      throw new Error(`profile not found: ${String(params.name)}`)
    }

    if (method === 'profiles.describe') {
      return { name: params.name, soul: profile.soul } as T
    }

    if (method === 'profiles.configure') {
      const applied: Record<string, boolean> = {}

      if (params.ui_meta && typeof params.ui_meta === 'object') {
        applied.ui_meta = !failing.delete('ui_meta')

        if (applied.ui_meta) {
          for (const [key, value] of Object.entries(params.ui_meta as Record<string, unknown>)) {
            if (value === null) {
              delete profile.uiMeta[key]
            } else {
              profile.uiMeta[key] = structuredClone(value)
            }
          }
        }
      }

      if (typeof params.soul === 'string') {
        applied.soul = !failing.delete('soul')

        if (applied.soul) {
          profile.soul = params.soul
        }
      }

      return { applied, ok: Object.values(applied).every(Boolean) } as T
    }

    throw new Error(`unexpected method ${method}`)
  }

  return {
    calls,
    failNext: section => void failing.add(section),
    profiles: store,
    request,
    writes: () =>
      calls
        .filter(call => call.method === 'profiles.configure')
        .map(call => (typeof call.params.soul === 'string' ? 'soul' : 'ui_meta'))
  }
}
