/**
 * hc-1087 多助手二期 R2: what each assistant handles, for our `@` list (L10,
 * K4) — the 「主要帮用户」 line hc-1079 writes into the assistant's own
 * SOUL.md 「分工」 section. Read the way the engine reads it for its relay
 * section (hc-1088 apex_overlay/handoff.py `parse_division`, pinned by the
 * `division` cases in shared/apex-handoff-cases.json), so the list and the
 * assistant's own idea of who does what agree.
 *
 * The SOULs come from `profiles.describe` through the engine on screen (any
 * profile's engine describes every profile), read only while relay is on, at
 * most once a minute per assistant.
 */

import { atom } from 'nanostores'

import { normalizeProfileKey } from '@/store/profile'

import { BOT_INTAKE_COPY } from '../bot-intake-copy'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const HEADINGS = [...new Set(Object.values(BOT_INTAKE_COPY).map(copy => copy.soul.heading))]
const ROLE_PREFIXES = [...new Set(Object.values(BOT_INTAKE_COPY).map(copy => copy.soul.role('')))]

// The heading on a line of its own, then everything up to the next H2 or the end (the engine's _DIVISION_RE).
const SECTION = new RegExp(
  `(?:^|\\n)(?:${HEADINGS.map(escapeRegExp).join('|')})[ \\t]*(?:\\n([\\s\\S]*?))?(?=\\n## |$)`
)

/** The role a SOUL's 「分工」 names; null when it names none. */
export function soulRole(soul: null | string | undefined): null | string {
  const match = SECTION.exec(String(soul ?? '').replace(/\r\n?/g, '\n'))

  for (const raw of (match?.[1] ?? '').split('\n')) {
    const line = raw.trimEnd()
    const prefix = ROLE_PREFIXES.find(candidate => line.startsWith(candidate))
    const role = prefix ? line.slice(prefix.length).trim() : ''

    if (role) {
      return role
    }
  }

  return null
}

/** Per profile: the role read from its SOUL (null: it names none) and when. */
export const $botRoles = atom<Readonly<Record<string, { at: number; role: null | string }>>>({})

const ROLE_RECHECK_MS = 60_000
const reading = new Set<string>()

type DescribeRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

/** Read the roles not read in the last minute. A failed read keeps what is known. */
export async function refreshBotRoles(request: DescribeRequest, profiles: readonly string[]): Promise<void> {
  const now = Date.now()

  const due = profiles
    .map(normalizeProfileKey)
    .filter(profile => !reading.has(profile) && now - ($botRoles.get()[profile]?.at ?? -Infinity) >= ROLE_RECHECK_MS)

  await Promise.all(
    due.map(async profile => {
      reading.add(profile)

      try {
        const described = await request<{ soul?: unknown }>('profiles.describe', { name: profile })
        const role = soulRole(typeof described?.soul === 'string' ? described.soul : '')

        $botRoles.set({ ...$botRoles.get(), [profile]: { at: Date.now(), role } })
      } catch {
        // Keep the last role: an engine that did not answer is not a SOUL without one.
      } finally {
        reading.delete(profile)
      }
    })
  )
}

/** Tests only. */
export function resetBotRolesForTest(roles: Readonly<Record<string, null | string>> = {}): void {
  reading.clear()
  $botRoles.set(Object.fromEntries(Object.entries(roles).map(([profile, role]) => [profile, { at: Date.now(), role }])))
}
