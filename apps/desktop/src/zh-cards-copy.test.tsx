import '@/store/suggestion-providers/github'
import '@/store/suggestion-providers/skill'

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowStarterCard } from '@/app/business-workspace/components/workflow-starter-card'
import {
  businessHomeStarters,
  type BusinessStarterCard,
  businessWorkflowStarters,
  videoWorkflowStarters
} from '@/app/business-workspace/view-model/workflow-starters'
import { SuggestionPills } from '@/app/chat/composer/suggestion-pills'
import { I18nProvider, type Locale, setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'
import { randomIdeaTemplates } from '@/lib/project-idea-templates'
import { $composerSuggestionsBySession, clearDraftSuggestions, sampleComposerDraft } from '@/store/composer-suggestions'
import { englishWords, readableText } from '@/test/zh-copy'

// hc-953: the cards a Chinese user is offered (Start cards, project idea
// pills, composer suggestion pills, the question card's labels) and the copy
// behind the process rows carry no English, and no tool code name or skill slug
// stands in for a name. The rendered checks live beside their components
// (thread/zh-process-copy, zh-clarify-copy); this file holds the catalog sweep
// that catches a key zh lacks (it would silently fall back to English) and the
// card surfaces.

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getGhAuthStatus: vi.fn(async () => ({ authenticated: false })),
  getSkills: vi.fn(async () => [
    { category: 'apexnodes', description: '', enabled: true, name: 'topic-research' },
    { category: 'apexnodes', description: '', enabled: true, name: 'a-skill-nobody-named-yet' }
  ])
}))

const CHINESE_LOCALES: Locale[] = ['zh', 'zh-hant']
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

// Function entries are called the way their call sites call them; anything not
// listed gets Chinese stand-ins, so only the copy itself can produce a Latin word.
const CALLS: Record<string, unknown[][]> = {
  'assistant.tool.countLabel': [
    [4, 'result', 'results'],
    [2, 'video', 'videos'],
    [3, 'noun-without-a-measure-word', 'nouns-without-a-measure-word']
  ],
  'assistant.tool.formatDuration': [
    ['33', 'ms'],
    ['3.2', 's'],
    ['2', 'm'],
    ['1', 'h']
  ],
  'assistant.tool.skillNameFallback': [['a-skill-nobody-named-yet']],
  'assistant.tool.skillTarget': [
    ['选题研究', 'references/launch-playbook.md'],
    ['', 'references/launch-playbook.md']
  ],
  'assistant.tool.detail.exitCode': [[1]],
  'assistant.tool.detail.snapshotStats': [[3, 2, 1]]
}

// Copy behind the suggestion cards and the process area. Each entry is a
// subtree of the catalog, swept whole.
const SCOPE = [
  'assistant.clarify',
  'assistant.tool',
  'assistant.thread.thinking',
  'assistant.thread.thought',
  'assistant.thread.thoughtBriefly',
  'assistant.thread.thoughtFor',
  'assistant.thread.turnDuration',
  'assistant.thread.processingPrompt',
  'assistant.thread.loadingLocalModel',
  'assistant.thread.working',
  'assistant.thread.agentMessaging',
  'assistant.thread.agentMessaged',
  'assistant.thread.agentMessageFrom',
  'assistant.thread.agentShowMessage',
  'composer.cronSuggestions',
  'composer.githubSuggestions',
  'composer.mcpSuggestions',
  'composer.repairSuggestions',
  'composer.skillSuggestions',
  'home.primaryPaths',
  'businessWorkspace.workflows.homePaths',
  'businessWorkspace.workflows.videoStages'
]

function at(tree: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree)
}

/** Every rendered string under `path`, labelled with where it came from. */
function renderedCopy(locale: Locale, path: string): [string, string][] {
  const node = at(TRANSLATIONS[locale], path)

  if (typeof node === 'string') {
    return [[path, node]]
  }

  if (typeof node === 'function') {
    const calls = CALLS[path] ?? [['示例', '示例', '示例']]

    return calls.map(args => [path, String((node as (...a: unknown[]) => unknown)(...args))])
  }

  if (node && typeof node === 'object') {
    return Object.keys(node).flatMap(key => renderedCopy(locale, `${path}.${key}`))
  }

  throw new Error(`${path} is missing from the ${locale} catalog`)
}

/** Tool names the APEX platform plugins register: each plugin's manifest plus
 *  the cross-repo tool contract, which lists tools a manifest has not caught up on. */
function platformToolNames(): string[] {
  const names = new Set<string>()
  const plugins = join(REPO_ROOT, 'plugins')

  for (const entry of readdirSync(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('apexnodes-')) {
      continue
    }

    const manifest = readFileSync(join(plugins, entry.name, 'plugin.yaml'), 'utf8')
    const block = /^provides_tools:\n((?:\s+- \S+\n?)+)/m.exec(manifest)?.[1] ?? ''

    for (const match of block.matchAll(/- (\S+)/g)) {
      names.add(match[1])
    }
  }

  const contract = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/contracts/plugin_tools_contract.json'), 'utf8')) as {
    plugins: Record<string, string[]>
  }

  for (const tools of Object.values(contract.plugins)) {
    tools.forEach(name => names.add(name))
  }

  return [...names].sort()
}

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
})

describe.each(CHINESE_LOCALES)('the %s catalog behind cards and process rows', locale => {
  it('has no English, and no key it lacks', () => {
    const leaks = SCOPE.flatMap(path => renderedCopy(locale, path))
      .map(([path, text]) => [path, englishWords(text)] as const)
      .filter(([, words]) => words.length > 0)

    expect(leaks).toEqual([])
  })

  it('names every APEX platform tool', () => {
    const named = TRANSLATIONS[locale].assistant.tool.toolNames
    const tools = platformToolNames()

    expect(tools.length).toBeGreaterThan(20)
    expect(tools.filter(name => !named[name])).toEqual([])
  })

  it('never shows a skill slug, even for a skill nobody named', () => {
    const copy = TRANSLATIONS[locale].assistant.tool

    expect(copy.skillNames['douyin-account-launch']).toBeTruthy()
    expect(copy.skillNameFallback('a-skill-nobody-named-yet')).toBe('')
  })
})

describe('Start cards in Chinese', () => {
  it('reads every starter card in Chinese, with the Start page overrides applied', () => {
    const t = TRANSLATIONS.zh

    const primary: Record<string, { summary: string; title: string }> = {
      'content-review': t.home.primaryPaths.content,
      'geo-brand-audit': t.home.primaryPaths.geo,
      'market-launch': t.home.primaryPaths.commerce
    }

    const cards: BusinessStarterCard[] = [
      ...businessHomeStarters(t.businessWorkspace.workflows),
      ...businessWorkflowStarters(t.businessWorkspace.workflows).map(card => ({ ...card, ...primary[card.id] })),
      ...videoWorkflowStarters(t.businessWorkspace.workflows)
    ]

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        {cards.map(card => (
          <WorkflowStarterCard action="开始" key={card.id} onSelect={() => {}} starter={card} variant="shelf" />
        ))}
      </I18nProvider>
    )

    expect(container.querySelectorAll('[data-workflow-starter]')).toHaveLength(cards.length)
    expect(englishWords(readableText(container))).toEqual([])
  })
})

describe('project idea pills in Chinese', () => {
  it.each(CHINESE_LOCALES)('offers %s ideas in the user’s language', locale => {
    setRuntimeI18nLocale(locale)
    const ideas = randomIdeaTemplates(100)

    expect(ideas.length).toBeGreaterThan(10)
    expect(ideas.flatMap(idea => englishWords(`${idea.label}\n${idea.idea}`))).toEqual([])
  })
})

describe('composer suggestion pills in Chinese', () => {
  const sessionId = 'session-pills-zh'

  beforeEach(() => setRuntimeI18nLocale('zh'))

  afterEach(() => clearDraftSuggestions(sessionId))

  it('names the skill in Chinese and keeps every phase of the pill Chinese', async () => {
    sampleComposerDraft(sessionId, '帮我用 topic-research 找几个选题，再看看 github 上的项目')

    await waitFor(() => expect($composerSuggestionsBySession.get()[sessionId]).toHaveLength(2), { timeout: 3000 })
    const offered = $composerSuggestionsBySession.get()[sessionId]!

    expect(offered.map(pill => pill.label).sort()).toEqual(['使用技能：选题研究', '设置 GitHub'].sort())

    for (const pill of offered) {
      const copy = [pill.label, pill.tip, pill.workingLabel, pill.workingTip, pill.doneLabel, pill.doneTip].join('\n')

      expect(englishWords(copy)).toEqual([])
    }

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <SuggestionPills sessionId={sessionId} />
      </I18nProvider>
    )

    expect(englishWords(readableText(container))).toEqual([])
  })

  it('never puts an unnamed skill’s slug on the pill', async () => {
    sampleComposerDraft(sessionId, '试试 a-skill-nobody-named-yet 这个技能')

    await waitFor(() => expect($composerSuggestionsBySession.get()[sessionId]).toHaveLength(1), { timeout: 3000 })
    const [pill] = $composerSuggestionsBySession.get()[sessionId]!

    expect(pill!.label).toBe('使用这个技能')
    expect([pill!.label, pill!.tip, pill!.doneLabel].join('\n')).not.toContain('a-skill-nobody-named-yet')
  })
})
