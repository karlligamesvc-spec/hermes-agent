/**
 * apex-profile-config.ts — the APEX corrections to config.yaml, run in every
 * home apex-profile-homes.ts lists (hc-1080).
 *
 * Moved out of main.ts (healConfigYamlProductBlocks, syncManagedRelayKeyToConfig)
 * so the boot / watch / sign-in / self-heal passes can repeat them per home:
 * the root exactly as before, then each named profile on the managed relay.
 * Every step stays what it was: add-only for blocks and keys, a rewrite only of
 * the managed relay key, the managed model tier and a global MoA leak — so a
 * profile's own choices survive, and a profile on another provider is never
 * listed, never read past its anchors, never written.
 *
 * Electron-free: main passes the managed credential, endpoints, env and the
 * relay's tier listing in; files are read and written with plain fs.
 */

import fs from 'node:fs'

import {
  ensurePluginsEnabledYaml,
  ensureProductDefaultsYaml,
  ensureSkillsDisabledYaml,
  ensureWebGatewayYaml,
  migrateApexBudgetDefaultsYaml,
  modelDisabledProvidersYaml
} from './apex-managed'
import { healManagedModelTier } from './apex-model-tiers'
import { type ApexProfileHome, DEFAULT_PROFILE } from './apex-profile-homes'
import {
  MANAGED_PROVIDER_NAME,
  managedCustomProviderEntryYaml,
  maskRelayKey,
  persistRelayKeyToConfigYaml,
  type PersistResult,
  syncManagedRelayConfigYaml
} from './apex-relay-key-anchors'

export interface ProductBlocksContext {
  /** The signed-in managed credential (resolveManagedConfig). Empty when signed out. */
  managed: { baseUrl?: string; key?: string }
  /** resolveApexEndpoints(process.env): the default relay and its display model. */
  endpoints: { modelDisplay: string; relayBaseUrl: string }
  /** The launch env (tier / single-thread switches). */
  env: Record<string, string | undefined>
  /** The tiers the relay last listed for this key (RelayTierMemo); null = unknown. */
  entitled: null | readonly string[]
}

export type HealOutcome = 'absent' | 'clean' | 'error' | 'healed' | 'stale'

type Log = (line: string) => void

/** ` profile <name>` for a named home, '' for the root, so root log lines read as before. */
function profileTag(home: ApexProfileHome): string {
  return home.profile === DEFAULT_PROFILE ? '' : ` profile ${home.profile}`
}

// The relay half: key + catalog discovery, the registered endpoint entry, a
// global MoA leak and the managed tier. Only runs with a managed credential.
function healRelayBlocks(raw: string, ctx: ProductBlocksContext, fixed: string[]): string {
  const { managed, endpoints } = ctx

  // hc-705: upgrade/setting-save guard for the Windows 0.17.16 stale shape.
  // Managed relay discovery is a platform invariant; endpoints on other URLs
  // remain untouched because the helper requires the exact managed URL and
  // current credential. This pass is live, so a settings full-record save
  // cannot re-persist the collapsed one-model catalog for the rest of the run.
  if (managed.key && managed.baseUrl) {
    const relayHeal = syncManagedRelayConfigYaml(raw, managed.baseUrl, managed.key)

    if (relayHeal.changed) {
      raw = relayHeal.next

      const keyAnchors = relayHeal.key.anchors.filter(anchor => anchor.status !== 'in-sync').map(anchor => anchor.path)

      const catalogAnchors = relayHeal.catalog.anchors
        .filter(anchor => anchor.status !== 'in-sync')
        .map(anchor => anchor.path)

      if (keyAnchors.length) {
        fixed.push(`managed-key(${keyAnchors.join(' ')})`)
      }

      if (catalogAnchors.length) {
        fixed.push(`managed-discovery(${catalogAnchors.join(' ')})`)
      }
    }
  }

  // hc-602: rendered by the SAME producer the first-run seed uses. This healer
  // used to hand-roll a column-0 list lead while the seed emitted a two-space
  // one — both valid YAML, and the relay-key patcher understood only one of
  // them, which is how Kael's custom_providers entry sat on a dead key for a
  // week while every log line said the sync had succeeded.
  const relayEntryLines = managedCustomProviderEntryYaml({
    name: MANAGED_PROVIDER_NAME,
    base_url: managed.baseUrl,
    api_key: managed.key,
    model: endpoints.modelDisplay
  })

  if (managed.key && managed.baseUrl && !/^custom_providers:/m.test(raw)) {
    raw = raw.replace(/\n*$/, '\n') + 'custom_providers:\n' + relayEntryLines
    fixed.push('custom_providers')
  } else if (
    managed.key &&
    managed.baseUrl &&
    // Header present but NO list entry under it (a wiper once left the bare
    // header behind — the earlier existence check sailed right past it).
    /^custom_providers:[ \t]*\n(?![ \t]|- )/m.test(raw)
  ) {
    raw = raw.replace(/^custom_providers:[ \t]*\n/m, 'custom_providers:\n' + relayEntryLines)
    fixed.push('custom_providers(empty-header)')
  }

  // A /moa toggle has been observed persisting itself as the GLOBAL default
  // (model.provider: moa + base_url: moa://local) — every new chat then
  // opens on MoA (slow + expensive), violating selective routing, and the
  // relay URL is clobbered. MoA is per-session only on managed installs:
  // heal the model block back to the relay default.
  if (managed.key && managed.baseUrl && /^model:[\s\S]*?^\s{2}provider:\s*moa\s*$/m.test(raw)) {
    raw = raw
      .replace(/^(\s{2}provider:\s*)moa\s*$/m, `$1custom`)
      .replace(/^(\s{2}base_url:\s*)moa:\/\/local\s*$/m, `$1${managed.baseUrl}`)
      .replace(/^(\s{2}default:\s*)\S.*$/m, `$1${endpoints.modelDisplay}`)
    fixed.push('model(moa-global)')
  }

  // hc-960, hc-1072. The relay lists tiers per account, so every managed
  // profile settles by the same rule against the same listing.
  return healManagedModelTier(raw, managed, endpoints.relayBaseUrl, ctx.env, fixed, ctx.entitled)
}

// The product half: add-only list and scalar blocks, credential-independent.
function healProductBlocks(raw: string, fixed: string[]): string {
  // Skills: union the managed disabled names back in — add-only, so a user's
  // enable-toggles (names they removed) survive. This is BOTH the "block was
  // wiped entirely" heal AND the hc-406 UPGRADE path: an install seeded under
  // v0.17 keeps its old 49-name skills.disabled after a bump to v0.18, so the
  // newly-graded-OFF bundled skills (huggingface-hub / maps / plan) would ship
  // ACTIVE without this reconcile. seedSkillsBlockYaml is the append when the
  // block is wholly absent (ensureSkillsDisabledYaml delegates to it).
  const skillsHeal = ensureSkillsDisabledYaml(raw)

  if (skillsHeal.changed) {
    raw = skillsHeal.next
    fixed.push(`skills.disabled(+${skillsHeal.added.length})`)
  }

  // hc-837: APEX previously pinned lower 90/50 budgets than Hermes. Migrate
  // only those exact legacy defaults once per config; custom values remain
  // untouched and the version marker prevents the watcher from fighting a
  // user who deliberately chooses 90/50 after the upgrade.
  const budgetDefaultsMigration = migrateApexBudgetDefaultsYaml(raw)

  if (budgetDefaultsMigration.changed) {
    raw = budgetDefaultsMigration.next
    fixed.push(
      budgetDefaultsMigration.migrated.length
        ? `budget-defaults(${budgetDefaultsMigration.migrated.join(' ')})`
        : 'budget-defaults(version)'
    )
  }

  // APEX product defaults as scalar keys (display.language,
  // display.show_reasoning, agent.image_input_mode, timezone). Same add-only
  // contract as the list healers: a key the file already carries is the
  // user's answer and is never rewritten — this only fills keys the file
  // does not mention, where the runtime's merged default would otherwise
  // decide (config.yaml has no display.language → /api/config still answers
  // `en`, and the shell's China-first fallback never fires). This is also the
  // catch-up path for every install seedDefaultModelConfig never ran on: it
  // fires only on the bootstrap-needed branch and bails when config.yaml
  // already exists.
  const defaultsHeal = ensureProductDefaultsYaml(raw)

  if (defaultsHeal.changed) {
    raw = defaultsHeal.next
    fixed.push(`product-defaults(${defaultsHeal.added.join(' ')})`)
  }

  const webHeal = ensureWebGatewayYaml(raw)

  if (webHeal.changed) {
    raw = webHeal.next
    fixed.push('web.search_backend')
  }

  // hc-392 China profile: losing model.disabled_providers silently re-enables
  // the Copilot provider probe — GitHub is near-unreachable from the
  // mainland, so its probe saturates the gateway RPC pool (slow model list,
  // spinning @-completions). Re-pin it whenever the model block loses it.
  if (/^model:/m.test(raw) && !/^\s{2}disabled_providers:/m.test(raw)) {
    raw = raw.replace(/^(model:\n)/m, `$1${modelDisabledProvidersYaml()}`)
    fixed.push('model.disabled_providers')
  }

  // Standalone plugins are opt-in: a config.yaml without (or with an
  // emptied) plugins.enabled list silently disables apex-overlay + the
  // apexnodes-* tool plugins on the next backend start. Union the managed
  // names back in — add-only, so user-added plugin entries survive. This
  // boot-time pass is also the UPGRADE path for installs seeded before the
  // plugins block existed.
  const pluginsHeal = ensurePluginsEnabledYaml(raw)

  if (pluginsHeal.changed) {
    raw = pluginsHeal.next
    fixed.push(`plugins.enabled(+${pluginsHeal.added.length})`)
  }

  return raw
}

/** Every APEX correction to one config.yaml text; `fixed` names what moved (empty = already in step). */
export function healProductBlocksYaml(raw: string, ctx: ProductBlocksContext): { fixed: string[]; next: string } {
  const fixed: string[] = []
  const next = healProductBlocks(healRelayBlocks(raw, ctx, fixed), fixed)

  return { fixed, next }
}

/**
 * One home's heal pass. Compare-and-swap against what it read: a file that
 * changed under it yields 'stale' rather than overwriting whatever just landed,
 * and the caller recomputes on the new content.
 */
export function healProductBlocksInHome(
  home: ApexProfileHome,
  ctx: ProductBlocksContext,
  reason: string,
  log: Log
): HealOutcome {
  try {
    if (!fs.existsSync(home.configPath)) {
      return 'absent'
    }

    // The runtime saves config.yaml atomically (utils.atomic_yaml_write — temp
    // file + rename), so we can never READ a half-written file; the live risk is
    // the reverse, that it lands a whole new version between this read and our
    // write and our plain writeFileSync silently reverts it.
    const readBack = fs.readFileSync(home.configPath, 'utf8')
    const { fixed, next } = healProductBlocksYaml(readBack, ctx)
    const where = `${reason}${profileTag(home) ? `;${profileTag(home)}` : ''}`

    if (!fixed.length) {
      return 'clean'
    }

    if (fs.readFileSync(home.configPath, 'utf8') !== readBack) {
      log(`[config-guard] config.yaml changed mid-pass; recomputing ${fixed.join(', ')} (${where})`)

      return 'stale'
    }

    // In place, NOT a rename: watchConfigYamlProductBlocks holds an fs.watch on
    // the root file, and a rename-over swaps the inode out from under it.
    fs.writeFileSync(home.configPath, next, { encoding: 'utf8' })
    log(`[config-guard] restored missing block(s): ${fixed.join(', ')} (${where})`)

    return 'healed'
  } catch (err: any) {
    log(`[config-guard] skipped${profileTag(home)}: ${err && err.message ? err.message : err}`)

    return 'error'
  }
}

/**
 * The guard over every home: up to three passes each, because a pass that loses
 * a race recomputes against the new file. The healers are add-only and
 * idempotent, so re-running on someone else's fresh file is always safe; three
 * losses in a row means a writer is hammering the file, and the next pass (the
 * root watcher, the next boot or sign-in) picks the heal back up.
 */
export function guardProductBlocksInHomes(
  homes: ApexProfileHome[],
  ctx: ProductBlocksContext,
  reason: string,
  log: Log
) {
  const outcomes: Record<string, HealOutcome> = {}

  for (const home of homes) {
    let outcome: HealOutcome = 'stale'

    for (let attempt = 0; attempt < 3 && outcome === 'stale'; attempt += 1) {
      outcome = healProductBlocksInHome(home, ctx, reason, log)
    }

    if (outcome === 'stale') {
      log(
        `[config-guard] deferred to the watcher after 3 racing passes (${reason}${profileTag(home) ? `;${profileTag(home)}` : ''})`
      )
    }

    outcomes[home.profile] = outcome
  }

  return outcomes
}

/**
 * Write the managed relay key into every anchor of one home's config.yaml and
 * prove it by reading back (persistRelayKeyToConfigYaml). In place, for the same
 * watcher reason as the heal. The root's log lines are unchanged.
 */
export function persistRelayKeyInHome(
  home: ApexProfileHome,
  managed: { baseUrl: string; key: string },
  reason: string,
  log: Log
): PersistResult {
  const result = persistRelayKeyToConfigYaml({
    read: () => (fs.existsSync(home.configPath) ? fs.readFileSync(home.configPath, 'utf8') : null),
    write: next => fs.writeFileSync(home.configPath, next, { encoding: 'utf8' }),
    baseUrl: managed.baseUrl,
    key: managed.key
  })

  const subject = `${profileTag(home) ? `${profileTag(home).trim()} ` : ''}config.yaml`

  if (result.ok && result.changed) {
    // Per-anchor, by path — "custom_providers=0/0" was true on every one of
    // Kael's boots and read as "nothing to do" rather than "I cannot see the
    // entry I wrote myself".
    const detail = (result.anchors || []).map(anchor => `${anchor.path}:${anchor.status}`).join(' ')
    log(
      `[apexnodes] ${subject} relay key refreshed (${reason}) to ${maskRelayKey(managed.key)} — ${detail || 'no anchors'}`
    )
  } else if (!result.ok) {
    log(
      `[apexnodes] ${subject} relay key write FAILED (${reason}): ${result.reason} — ` +
        'chat will keep failing with 401 until this is resolved.'
    )
  }

  return result
}
