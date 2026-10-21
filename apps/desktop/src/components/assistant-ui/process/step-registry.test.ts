import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { type Locale, setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'
import { englishWords } from '@/test/zh-copy'

import { stepCopyFor } from './turn-process'

// hc-973: every tool a Desktop user can meet reads as a step in their words —
// what it says while it runs, its name in the finished chain, what it came back
// with. A tool missing from the table would fall back to 「处理」 at best; this
// fails instead, naming it.

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..')
const LOCALES: Locale[] = ['en', 'zh', 'zh-hant']

/** Tools the APEX platform plugins register: each manifest, plus the
 *  cross-repo contract, which lists tools a manifest has not caught up on. */
function platformTools(): string[] {
  const names: string[] = []
  const plugins = join(REPO_ROOT, 'plugins')

  for (const entry of readdirSync(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('apexnodes-')) {
      continue
    }

    const manifest = readFileSync(join(plugins, entry.name, 'plugin.yaml'), 'utf8')
    const block = /^provides_tools:\n((?:\s+- \S+\n?)+)/m.exec(manifest)?.[1] ?? ''

    names.push(...[...block.matchAll(/- (\S+)/g)].map(match => match[1]))
  }

  const contract = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/contracts/plugin_tools_contract.json'), 'utf8')) as {
    plugins: Record<string, string[]>
  }

  return [...names, ...Object.values(contract.plugins).flat()]
}

/** The core toolset every platform bundle carries, and the Feishu document
 *  tools, read from the source of truth rather than copied here. */
function coreTools(): string[] {
  const toolsets = readFileSync(join(REPO_ROOT, 'toolsets.py'), 'utf8')

  return ['_HERMES_CORE_TOOLS', '_FEISHU_TOOLS'].flatMap(list => {
    const body = new RegExp(`^${list} = \\[([\\s\\S]*?)\\n\\]`, 'm').exec(toolsets)?.[1] ?? ''

    return [...body.matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1])
  })
}

/** Every tool some locale already has a display name for (hc-953's tables). */
function namedTools(): string[] {
  const tool = TRANSLATIONS.zh.assistant.tool

  return [...Object.keys(TRANSLATIONS.en.assistant.tool.titles), ...Object.keys(tool.toolNames)]
}

const ALL_TOOLS = [...new Set([...platformTools(), ...coreTools(), ...namedTools()])].sort()

afterEach(() => setRuntimeI18nLocale('en'))

describe('the tools a step table must cover', () => {
  it('are read from the plugins, the core toolset and the name tables', () => {
    // Guards the readers themselves: a regex that stopped matching would make
    // every check below pass on an empty list.
    expect(platformTools().length).toBeGreaterThan(20)
    expect(coreTools()).toEqual(expect.arrayContaining(['terminal', 'web_search', 'delegate_task', 'feishu_doc_read']))
    expect(ALL_TOOLS.length).toBeGreaterThan(100)
  })
})

describe.each(LOCALES)('the %s step table', locale => {
  const steps = TRANSLATIONS[locale].assistant.tool.process.steps

  it('has a step for every tool', () => {
    expect(ALL_TOOLS.filter(name => !steps[name])).toEqual([])
  })

  it('gives every step a running text, a title and a summary', () => {
    const incomplete = ALL_TOOLS.filter(name => {
      const step = steps[name]

      return !step?.running.trim() || !step.title.trim() || typeof step.done({ calls: 1 }) !== 'string'
    })

    expect(incomplete).toEqual([])
  })
})

describe.each(['zh', 'zh-hant'] as const)('the %s step table', locale => {
  it('names no step in English and never by its code name', () => {
    const steps = TRANSLATIONS[locale].assistant.tool.process.steps

    const leaks = ALL_TOOLS.flatMap(name => {
      const step = steps[name]
      const text = [step.running, step.title, step.done({ calls: 1 }), step.done({ calls: 3, count: 12 })].join('\n')

      return englishWords(text).length > 0 || text.includes(name) ? [name] : []
    })

    expect(leaks).toEqual([])
  })
})

describe('a tool nobody named', () => {
  it('reads as plain work in every language, never as its code name', () => {
    for (const locale of LOCALES) {
      setRuntimeI18nLocale(locale)

      const step = stepCopyFor('mcp_shop__create_order')
      const text = [step.running, step.title, step.done({ calls: 1 })].join('\n')

      expect(step).toBe(TRANSLATIONS[locale].assistant.tool.process.unknownStep)
      expect(text).not.toMatch(/mcp|shop|create|order/i)
    }

    setRuntimeI18nLocale('zh')
    expect(stepCopyFor('mcp_shop__create_order').running).toBe('正在处理')
  })
})
