import { type ApprovalMode, setApprovalModeForProfile } from '@/store/approval-mode'
import { $gateway } from '@/store/gateway'
import { $activeSessionId, setYoloActive } from '@/store/session'

export type GatewayRequester = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

/**
 * Toggle per-session YOLO (approval bypass) via gateway `config.set` — the same
 * session-scoped flag as the TUI's Shift+Tab. It does NOT touch the global
 * `approvals.mode` config, so CLI / TUI / cron behavior is unaffected.
 */
export async function setSessionYolo(
  requestGateway: GatewayRequester,
  sessionId: string,
  enabled: boolean
): Promise<boolean> {
  const result = await requestGateway<{ value?: string }>('config.set', {
    key: 'yolo',
    session_id: sessionId,
    value: enabled ? '1' : '0'
  })

  const active = result?.value === '1'

  setYoloActive(active)

  return active
}

/**
 * Toggle GLOBAL YOLO (approval bypass) via gateway `config.set` with
 * `scope: 'global'`. This flips the persistent `approvals.mode` in config.yaml
 * between `off` (bypass on) and `manual` (bypass off), affecting every session,
 * the CLI, the TUI, and cron — and it survives restarts. Triggered by
 * Shift+clicking the status-bar zap.
 */
export async function setGlobalYolo(requestGateway: GatewayRequester, enabled: boolean): Promise<boolean> {
  const result = await requestGateway<{ value?: string }>('config.set', {
    key: 'yolo',
    scope: 'global',
    value: enabled ? '1' : '0'
  })

  const active = result?.value === '1'

  setYoloActive(active)

  return active
}

/**
 * Persist a GLOBAL gating approvals.mode — the two RESTRICTIVE tiers of the
 * composer's approval pill (hc-514):
 *   manual → gate only detected-dangerous commands
 *   smart  → LLM risk judge decides when to ask
 * Persistent and profile-global (approvals.mode has no per-session form), so it
 * also changes the CLI / TUI / cron default for that profile. `off` is
 * deliberately NOT accepted here: the desktop must never persist an
 * unrestricted global default — the pill's 完全访问 tier arms the session-scoped
 * `setSessionYolo` override instead (temporary, dies with the session). The
 * narrowed parameter type IS the guarantee, which is the only reason this
 * wrapper exists instead of calling setApprovalModeForProfile directly.
 */
export async function applyApprovalMode(
  requestGateway: GatewayRequester,
  profile: string,
  mode: Exclude<ApprovalMode, 'off'>
): Promise<ApprovalMode> {
  return setApprovalModeForProfile(requestGateway, profile, mode)
}

/**
 * Set YOLO to an explicit state from a surface that has no React context — the
 * ⌘K rows. `useSlashCommand` keeps its own `requestGateway` (it already holds
 * one, with the reconnect handling), so this reaches the active gateway
 * directly rather than growing a second requester abstraction.
 *
 * With no session yet the flag is armed locally; the session-create path
 * (use-session-actions) applies it on the first message, exactly as a bare
 * `/yolo` in a fresh draft does.
 */
export async function setYoloEnabled(enabled: boolean): Promise<boolean> {
  const sessionId = $activeSessionId.get()

  if (!sessionId) {
    setYoloActive(enabled)

    return enabled
  }

  const gateway = $gateway.get()

  if (!gateway) {
    throw new Error('Hermes gateway unavailable')
  }

  return setSessionYolo((method, params) => gateway.request(method, params), sessionId, enabled)
}
