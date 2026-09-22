import type { ModelOptionProvider } from '@hermes/shared'
import { describe, expect, it } from 'vitest'

import {
  APEX_PUBLIC_LLM_MODELS,
  dropAliasedCustomRow,
  filterApexLlmShelf,
  filterPickerProviders,
  isPickerVisibleProvider,
  providerDisplayName
} from './provider-allowlist'

const provider = (slug: string): ModelOptionProvider => ({ name: slug, slug, models: ['m'] })

describe('provider-allowlist', () => {
  it('keeps the APEX-NODES.COM managed relay and custom BYOK endpoints', () => {
    // Managed relay is a named custom provider (custom_provider_slug('Apex-nodes.com')).
    expect(isPickerVisibleProvider('custom:apex-nodes.com')).toBe(true)
    // A user's own OpenAI-compatible endpoint (bare or named).
    expect(isPickerVisibleProvider('custom')).toBe(true)
    expect(isPickerVisibleProvider('custom:my-local')).toBe(true)
  })

  it('keeps domestic (国产) providers for BYOK', () => {
    for (const slug of [
      'deepseek',
      'zai',
      'kimi-coding',
      'kimi-coding-cn',
      'alibaba',
      'alibaba-coding-plan',
      'qwen-oauth',
      'minimax',
      'minimax-oauth',
      'minimax-cn',
      'stepfun',
      'xiaomi',
      'tencent-tokenhub'
    ]) {
      expect(isPickerVisibleProvider(slug)).toBe(true)
    }
  })

  it('hides GitHub Copilot and every foreign provider', () => {
    for (const slug of [
      'copilot',
      'copilot-acp',
      'openai',
      'openai-api',
      'openai-codex',
      'anthropic',
      'xai',
      'xai-oauth',
      'gemini',
      'google-gemini-cli',
      'mistral',
      'cohere',
      'openrouter',
      'nous',
      'bedrock',
      'azure-foundry',
      'nvidia',
      'huggingface',
      'ollama-cloud',
      'groq',
      'together',
      'fireworks'
    ]) {
      expect(isPickerVisibleProvider(slug)).toBe(false)
    }
  })

  it('is case-insensitive and rejects empty slugs', () => {
    expect(isPickerVisibleProvider('DeepSeek')).toBe(true)
    expect(isPickerVisibleProvider('Custom:Apex-Nodes.com')).toBe(true)
    expect(isPickerVisibleProvider('')).toBe(false)
    expect(isPickerVisibleProvider('   ')).toBe(false)
  })

  it('filters a provider list while preserving order', () => {
    const input = [
      provider('copilot'),
      provider('deepseek'),
      provider('openai'),
      provider('custom:apex-nodes.com'),
      provider('zai'),
      provider('anthropic')
    ]

    expect(filterPickerProviders(input).map(p => p.slug)).toEqual(['deepseek', 'custom:apex-nodes.com', 'zai'])
  })
})

describe('filterApexLlmShelf', () => {
  const managed: ModelOptionProvider = {
    name: 'Apex-nodes.com',
    slug: 'custom:apex-nodes.com',
    models: [
      'kimi-k3',
      'glm-5.2',
      'qwen3.7-max',
      'deepseek-v4-pro-APEX',
      ...APEX_PUBLIC_LLM_MODELS
    ],
    featured_models: ['kimi-k3', 'deepseek-flash'],
    unavailable_models: ['glm-5.2', 'hy4-preview'],
    capabilities: {
      'kimi-k3': { fast: false, reasoning: true },
      'deepseek-flash': { fast: true, reasoning: true }
    },
    pricing: {
      'qwen3.7-max': { input: '', output: '', free: true },
      'deepseek-flash': { input: '', output: '', free: true }
    }
  }

  it('publishes exactly the ordered hc-845 shelf and strips legacy metadata', () => {
    const [result] = filterApexLlmShelf([managed])

    expect(result?.models).toEqual(APEX_PUBLIC_LLM_MODELS)
    expect(result?.featured_models).toEqual(['deepseek-flash'])
    expect(result?.unavailable_models).toEqual(['hy4-preview'])
    expect(Object.keys(result?.capabilities ?? {})).toEqual(['deepseek-flash'])
    expect(Object.keys(result?.pricing ?? {})).toEqual(['deepseek-flash'])
    expect(result?.total_models).toBe(9)
  })

  it('prefers the managed row so matching BYOK ids do not duplicate the shelf', () => {
    const deepseek = {
      name: 'DeepSeek',
      slug: 'deepseek',
      models: ['deepseek-flash', 'deepseek-v4-pro']
    }

    expect(filterApexLlmShelf([deepseek, managed]).map(row => row.slug)).toEqual([
      'custom:apex-nodes.com'
    ])
  })

  it('preserves domestic BYOK providers when the managed row is unavailable', () => {
    const fallback = filterApexLlmShelf([
      { name: 'DeepSeek', slug: 'deepseek', models: ['deepseek-chat', 'deepseek-flash'] },
      { name: 'Qwen', slug: 'alibaba', models: ['qwen3.7-max', 'qwen3.8-flash'] }
    ])

    expect(fallback.map(row => row.models)).toEqual([
      ['deepseek-chat', 'deepseek-flash'],
      ['qwen3.7-max', 'qwen3.8-flash']
    ])
  })
})

// hc-598: the managed relay is registered under the BARE `custom` slug with a
// named `custom_providers` entry beside it, so the runtime lists the endpoint
// as `custom:apex-nodes.com` and then synthesizes a SECOND, anonymous row for
// the "missing" bare slug (hermes_cli/inventory.py `_append_unconfigured_rows`).
describe('dropAliasedCustomRow', () => {
  const relay: ModelOptionProvider = {
    name: 'Apex-nodes.com',
    slug: 'custom:apex-nodes.com',
    api_url: 'https://apex-nodes.com/relay/v1',
    models: ['deepseek-v4-pro-APEX', 'glm-5.2']
  }

  const alias: ModelOptionProvider = {
    name: 'Custom endpoint',
    slug: 'custom',
    models: ['deepseek-v4-pro-APEX'],
    authenticated: false
  }

  it('drops the anonymous bare-custom alias when a named endpoint is listed', () => {
    expect(dropAliasedCustomRow([relay, alias]).map(p => p.slug)).toEqual(['custom:apex-nodes.com'])
  })

  it('keeps the bare row when it is the only representation of the endpoint', () => {
    // A user's own OpenAI-compatible endpoint configured as `model.provider:
    // custom` with no `custom_providers` entry — this row IS the endpoint.
    const own: ModelOptionProvider = {
      name: 'Custom endpoint',
      slug: 'custom',
      api_url: 'http://127.0.0.1:11434/v1',
      models: ['qwen3']
    }

    expect(dropAliasedCustomRow([provider('deepseek'), own]).map(p => p.slug)).toEqual(['deepseek', 'custom'])
  })

  it('never drops a named custom endpoint — two real endpoints stay two rows', () => {
    const mine: ModelOptionProvider = { name: 'My proxy', slug: 'custom:my-proxy', models: ['glm-5.2'] }

    expect(dropAliasedCustomRow([relay, mine, alias]).map(p => p.slug)).toEqual([
      'custom:apex-nodes.com',
      'custom:my-proxy'
    ])
  })

  it('is applied by filterPickerProviders, so no picker surface sees the alias', () => {
    expect(filterPickerProviders([provider('copilot'), relay, alias, provider('deepseek')]).map(p => p.slug)).toEqual([
      'custom:apex-nodes.com',
      'deepseek'
    ])
  })
})

describe('providerDisplayName', () => {
  const fallback = 'Your endpoint'

  it.each([
    // A real name always wins — the relay, a user's own label, a vendor.
    [{ name: 'Apex-nodes.com', slug: 'custom:apex-nodes.com' }, 'Apex-nodes.com'],
    [{ name: 'My Ollama', slug: 'custom:my-ollama' }, 'My Ollama'],
    [{ name: 'DeepSeek', slug: 'deepseek' }, 'DeepSeek'],
    // The runtime's implementation labels are replaced by the endpoint's own
    // address — what the user typed, and no translation needed.
    [{ name: 'Custom endpoint', slug: 'custom', api_url: 'https://apex-nodes.com/relay/v1' }, 'apex-nodes.com'],
    [{ name: 'custom', slug: 'custom', api_url: 'http://127.0.0.1:11434/v1' }, '127.0.0.1:11434'],
    [{ name: 'Custom Endpoint', slug: 'custom', api_url: '127.0.0.1:8081/v1' }, '127.0.0.1:8081'],
    // Unnamed AND address-less — the translated product word, never `custom`.
    [{ name: 'Custom endpoint', slug: 'custom' }, 'Your endpoint'],
    [{ name: 'custom', slug: 'custom', api_url: '' }, 'Your endpoint'],
    [{ name: '', slug: 'custom' }, 'Your endpoint']
  ])('names %j for the user', (row, expected) => {
    expect(providerDisplayName(row as ModelOptionProvider, fallback)).toBe(expected)
  })

  it('never renders the implementation word on any row', () => {
    const rows: ModelOptionProvider[] = [
      { name: 'Custom endpoint', slug: 'custom' },
      { name: 'custom', slug: 'custom', api_url: 'https://apex-nodes.com/relay/v1' },
      { name: 'Apex-nodes.com', slug: 'custom:apex-nodes.com' }
    ]

    for (const row of rows) {
      expect(providerDisplayName(row, fallback).toLowerCase()).not.toContain('custom endpoint')
    }
  })
})
