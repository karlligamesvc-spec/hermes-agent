/**
 * apex-disabled-toolsets.ts — the toolsets no APEX Desktop session carries (`agent.disabled_toolsets`).
 *
 * hc-1275: the engine folds the `catalog` toolset (manage_catalog) into every Desktop session. Its
 * install action asks for consent through a connection card (`connection.request`) that this
 * renderer never draws, so a call waited out OPERATION_DEADLINE_SECONDS (10 minutes) and installed
 * nothing, while its search put the 1,050-entry community plugin catalog in front of the model.
 * The engine subtracts `agent.disabled_toolsets` from that fold-in
 * (tui_gateway/agent_factory.py `_with_session_toolsets`) and from the agent's own tool list.
 *
 * The first-install seed carries the list (SEED_PRODUCT_DEFAULTS_BLOCK in apex-managed.ts); this
 * healer is the upgrade path, run on every boot/watch pass in every profile home
 * (apex-profile-config.ts). Same ADD-ONLY contract as the skills.disabled healer: entries already
 * there stay, a missing managed name comes back.
 */

import { ensureListBlockYaml } from './apex-managed'

export const SEED_DISABLED_TOOLSETS: readonly string[] = Object.freeze(['catalog'])

/** The whole `agent:` block, for a config.yaml that has none. */
export function seedToolsetsBlockYaml(toolsets: readonly string[] = SEED_DISABLED_TOOLSETS): string {
  return `agent:\n  disabled_toolsets:\n${toolsets.map(name => `    - ${name}\n`).join('')}`
}

/** Union every managed name into `agent.disabled_toolsets`; `added` lists what was missing. */
export function ensureToolsetsDisabledYaml(
  raw: string,
  toolsets: readonly string[] = SEED_DISABLED_TOOLSETS
): { added: string[]; changed: boolean; next: string } {
  return ensureListBlockYaml(raw, {
    blockKey: 'agent',
    listKey: 'disabled_toolsets',
    wanted: [...toolsets],
    seedBlock: seedToolsetsBlockYaml
  })
}
