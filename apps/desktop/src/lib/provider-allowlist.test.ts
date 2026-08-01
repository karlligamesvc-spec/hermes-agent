import { describe, expect, it } from 'vitest'

import type { ModelOptionProvider } from '@/types/hermes'

import {
  dropAliasedCustomRow,
  filterPickerProviders,
  isPickerVisibleModelProvider,
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

    // hc-638: built-in vendor rows no longer reach the picker — only the managed
    // relay and the user's own endpoints do. Order among survivors is preserved.
    expect(filterPickerProviders(input).map(p => p.slug)).toEqual(['custom:apex-nodes.com'])
  })

  it('keeps the user\'s own custom endpoints beside the managed relay', () => {
    // The escape hatch: dropping the built-in rows must not drop a BYO endpoint
    // the user configured themselves. That is the whole shape of hc-638 —
    // "we chose it for you" rows go, "you chose it" rows stay.
    const input = [provider('deepseek'), provider('custom:my-ollama'), provider('custom:apex-nodes.com')]

    expect(filterPickerProviders(input).map(p => p.slug)).toEqual(['custom:my-ollama', 'custom:apex-nodes.com'])
  })

  it('leaves the SHARED predicate alone — settings still sees domestic vendors', () => {
    // isPickerVisibleProvider answers a different question and has two other
    // consumers: providers-settings.tsx renders OAuth sign-in rows from it, and
    // pairs it with DOMESTIC_PROVIDER_SLUGS to decide which vendors get a
    // key-entry card. Narrowing it would have removed the ability to CONFIGURE
    // or SIGN IN TO DeepSeek, not just to pick its models. Three questions,
    // one name — this pins them apart.
    expect(isPickerVisibleProvider('deepseek')).toBe(true)
    expect(isPickerVisibleModelProvider('deepseek')).toBe(false)
    expect(isPickerVisibleProvider('openai')).toBe(false)
    expect(isPickerVisibleModelProvider('openai')).toBe(false)
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
      'custom:apex-nodes.com'
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
