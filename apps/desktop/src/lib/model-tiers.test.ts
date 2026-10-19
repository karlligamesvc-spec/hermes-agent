import { describe, expect, it, vi } from 'vitest'

import {
  assistantModelChoice,
  availableModelTiers,
  maskModelNamesInText,
  MODEL_TIER_ALIAS,
  modelTierDisplayName,
  modelTierForAlias,
  nextModelTier,
  retryTierFromReloadConfig,
  retryTierReloadConfig,
  switchSessionToModelTier
} from './model-tiers'
import { APEX_PUBLIC_LLM_MODELS, MANAGED_PROVIDER_SLUG } from './provider-allowlist'

describe('tier aliases', () => {
  it.each([
    ['apex-flash', 'flash'],
    ['APEX-PRO', 'pro'],
    ['custom:apex-nodes.com/apex-max', 'max'],
    ['apex-flash-APEX', null],
    ['deepseek-flash', null],
    ['', null]
  ] as const)('%s → %s', (model, tier) => {
    expect(modelTierForAlias(model)).toBe(tier)
  })

  it('steps up one tier at a time and stops at Max', () => {
    expect(nextModelTier('flash')).toBe('pro')
    expect(nextModelTier('pro')).toBe('max')
    expect(nextModelTier('max')).toBeNull()
  })

  it('reads availability only from the aliases the relay listed', () => {
    expect([...availableModelTiers(['apex-flash', 'deepseek-flash', 'apex-pro'])]).toEqual(['flash', 'pro'])
    expect(availableModelTiers([...APEX_PUBLIC_LLM_MODELS]).size).toBe(0)
    expect(availableModelTiers(undefined).size).toBe(0)
  })
})

describe('what an assistant’s configured model means in tier terms', () => {
  it.each([
    ['a tier alias', 'apex-pro', MANAGED_PROVIDER_SLUG, { kind: 'tier', legacy: false, tier: 'pro' }],
    ['no model yet (inherits the default)', '', '', { kind: 'tier', legacy: false, tier: 'flash' }],
    ['the pre-tier -APEX seed', 'deepseek-flash-APEX', 'custom', { kind: 'tier', legacy: true, tier: 'flash' }],
    [
      'an old shelf pick on the relay',
      'kimi-k2.7-code',
      MANAGED_PROVIDER_SLUG,
      { kind: 'tier', legacy: true, tier: 'flash' }
    ],
    ['an old shelf id on bare custom', 'mimo-v2.6-pro', 'custom', { kind: 'tier', legacy: true, tier: 'flash' }],
    ['the user’s own DeepSeek key', 'deepseek-chat', 'deepseek', { kind: 'own' }],
    ['the user’s own endpoint', 'llama-3.3-70b', 'custom:my-box', { kind: 'own' }]
  ] as const)('%s', (_label, model, provider, expected) => {
    expect(assistantModelChoice(model, provider)).toEqual(expected)
  })

  it('never shows a model id as a tier label', () => {
    for (const model of APEX_PUBLIC_LLM_MODELS) {
      expect(['Flash', 'Pro', 'Max']).toContain(modelTierDisplayName(model, 'custom'))
    }

    expect(modelTierDisplayName('deepseek-chat', 'deepseek')).toBe('')
  })
})

describe('backend text in tier mode', () => {
  const copy = { lineLabel: '档位', ownModel: '自己的模型服务' }

  it('rewrites the /status Model line to the tier', () => {
    const status = [
      'Hermes TUI Status',
      '',
      'Session ID: 20261019_101010_abcdef',
      'Model: apex-pro (custom:apex-nodes.com)',
      'Tokens: 1,234'
    ].join('\n')

    const masked = maskModelNamesInText(status, copy)

    expect(masked).toContain('档位: Pro')
    expect(masked).not.toMatch(/apex-pro|custom:apex-nodes/)
    expect(masked).toContain('Tokens: 1,234')
  })

  it.each([
    ['the -APEX seed', 'Model: deepseek-flash-APEX (custom)', '档位: Flash'],
    ['the user’s own model', 'Model: deepseek-chat (deepseek)', '档位: 自己的模型服务']
  ])('maps %s', (_label, line, expected) => {
    expect(maskModelNamesInText(line, copy)).toBe(expected)
  })

  it('replaces stray APEX ids anywhere in the text, as whole tokens only', () => {
    const masked = maskModelNamesInText('switched to kimi-k2.7-code, then apex-max; my-kimi-k2.7-code-fork stays', copy)

    expect(masked).toBe('switched to Flash, then Max; my-kimi-k2.7-code-fork stays')
  })
})

describe('换更强的再答一次', () => {
  // The gateway request is generic in its reply; a canned reply stands in.
  type GatewayRequest = Parameters<typeof switchSessionToModelTier>[0]

  it('round-trips the stronger tier through the reload run config', () => {
    expect(retryTierFromReloadConfig(retryTierReloadConfig('pro'))).toBe('pro')
    expect(retryTierFromReloadConfig({ parentId: 'm1', runConfig: {} })).toBeNull()
    expect(retryTierFromReloadConfig({ runConfig: { custom: { apexTier: 'ultra' } } })).toBeNull()
    expect(retryTierFromReloadConfig(undefined)).toBeNull()
  })

  it('switches only the session, on the managed relay', async () => {
    const request = vi.fn(async () => ({ model: MODEL_TIER_ALIAS.pro, provider: MANAGED_PROVIDER_SLUG }))

    await expect(switchSessionToModelTier(request as unknown as GatewayRequest, 'rt-1', 'pro')).resolves.toEqual({
      model: 'apex-pro',
      provider: MANAGED_PROVIDER_SLUG
    })
    expect(request).toHaveBeenCalledWith('config.set', {
      key: 'model',
      session_id: 'rt-1',
      value: `apex-pro --provider ${MANAGED_PROVIDER_SLUG} --session`
    })
  })

  it('refuses to regenerate on a guarded switch it did not apply', async () => {
    const request = vi.fn(async () => ({ confirm_message: 'Max costs more', confirm_required: true }))

    await expect(switchSessionToModelTier(request as unknown as GatewayRequest, 'rt-1', 'max')).rejects.toThrow(
      'Max costs more'
    )
  })
})
