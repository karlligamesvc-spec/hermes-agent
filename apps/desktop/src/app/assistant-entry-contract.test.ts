import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const desktopRoot = resolve(__dirname, '../..')
const readSource = (...parts: string[]) => readFileSync(join(desktopRoot, ...parts), 'utf8')

describe('hc-828 assistant entry identity', () => {
  it('uses the shared APEX application mark in the sidebar', () => {
    const sidebar = readSource('src', 'app', 'chat', 'sidebar', 'index.tsx')

    expect(sidebar).toContain("import { BrandMark } from '@/components/brand-mark'")
    expect(sidebar).toContain('<BrandMark aria-hidden="true"')
    expect(sidebar).not.toContain("assets/apex-mark-minimal.png")
  })

  it('names the primary Chinese tab as 会话 and localizes the assistant pane title', () => {
    const controller = readSource('src', 'app', 'contrib', 'controller.tsx')
    const plugin = readSource('src', 'plugins', 'hermes-bots', 'plugin.tsx')
    const roster = readSource('src', 'plugins', 'hermes-bots', 'roster-pane.tsx')

    expect(controller).toContain('tabTitle: () => <SessionsPaneTabTitle />')
    expect(controller).toContain('const SessionsPaneTabTitle = () => <>{useI18n().t.sidebar.sessions}</>')
    expect(readSource('src', 'i18n', 'zh.ts')).toMatch(/sessions: '会话'/)
    expect(plugin).toContain('tabTitle: () => <BotsPaneTabTitle />')
    expect(plugin).toContain('const BotsPaneTabTitle = () => <>{useBots().roster.title}</>')
    expect(roster).toContain('{b.roster.title}')
  })

  it('keeps the create-group entry enabled and routes a shortage to an honest recovery dialog', () => {
    const roster = readSource('src', 'plugins', 'hermes-bots', 'roster-pane.tsx')
    const dialog = readSource('src', 'plugins', 'hermes-bots', 'create-dialog.tsx')

    expect(roster).toContain('<DropdownMenuItem onSelect={() => setGroupCreateOpen(true)}>')
    expect(roster).not.toContain('disabled={activeSourceRoster.length < 2}')
    expect(roster).toContain('onAddAssistant={() => {')
    expect(dialog).toContain('{b.group.minimumMembers(selectableRoster.length)}')
    expect(dialog).toContain('{b.group.addAssistant}')
    expect(dialog).toContain('disabled={!canCreate}')
  })
})
