/**
 * hc-1010: the managed default the shell WRITES to config.yaml
 * (electron/apex-managed.ts) is the renderer's default tier alias, so every
 * display surface reads a fresh APEX install as that tier — "Flash" in tier
 * mode, "APEX Flash" outside it — never a vendor model id and never the
 * `apex-flash-APEX` concatenation the old `-APEX` seed rule would produce.
 */

import { describe, expect, it } from 'vitest'

import { displayModelName, modelDisplayParts } from '@/lib/model-status-label'
import { assistantModelChoice, DEFAULT_MODEL_TIER, MODEL_TIER_ALIAS, modelTierDisplayName } from '@/lib/model-tiers'
import { MANAGED_PROVIDER_SLUG } from '@/lib/provider-allowlist'
import { isModelTierMode } from '@/store/model-tiers'

import { buildManagedModelConfig, MANAGED_MODEL_DISPLAY } from '../../electron/apex-managed'

const written = (env: Record<string, string> = {}) => buildManagedModelConfig('sk-test', env).default

describe('the managed default model, as the renderer shows it', () => {
  it('is the renderer’s default tier alias, tiers on or off', () => {
    expect(MANAGED_MODEL_DISPLAY).toBe(MODEL_TIER_ALIAS[DEFAULT_MODEL_TIER])
    expect(written()).toBe(MODEL_TIER_ALIAS[DEFAULT_MODEL_TIER])
    expect(written({ APEXNODES_MODEL_TIERS: '1' })).toBe(MODEL_TIER_ALIAS[DEFAULT_MODEL_TIER])
  })

  it('reads as Flash, not as a legacy id, in tier mode', () => {
    for (const provider of ['custom', MANAGED_PROVIDER_SLUG]) {
      expect(assistantModelChoice(written(), provider)).toEqual({ kind: 'tier', legacy: false, tier: 'flash' })
      expect(modelTierDisplayName(written(), provider)).toBe('Flash')
    }
  })

  it('reads as APEX Flash outside tier mode, with no second APEX tag', () => {
    expect(displayModelName(written())).toBe('APEX Flash')
    expect(modelDisplayParts(written())).toEqual({ name: 'APEX Flash', tag: '' })
  })

  it('leaves a BYOK user (managed disabled) on the full model names', () => {
    expect(isModelTierMode({ enabled: false, modelTiers: true, status: 'signed-in' })).toBe(false)
    expect(isModelTierMode({ enabled: true, modelTiers: true, status: 'signed-in' })).toBe(true)
  })
})
