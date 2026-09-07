import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('developer outlets preserved by the account-surface pass', () => {
  it('keeps terminal and file panes registered in the production contribution shell', () => {
    const controller = readSource('./app/contrib/controller.tsx')

    expect(controller.match(/id: 'terminal'/g)).toHaveLength(1)
    expect(controller.match(/id: 'files'/g)).toHaveLength(1)
    expect(controller).toContain("id: 'logs.toggle'")
  })

  it('keeps terminal and file-tree actions reachable without promoting them into account Settings', () => {
    const actions = readSource('./lib/keybinds/actions.ts')
    const titlebar = readSource('./app/shell/titlebar-controls.tsx')

    expect(actions).toContain("id: 'view.showTerminal'")
    expect(actions).toContain("id: 'view.newTerminal'")
    expect(actions).toContain("id: 'view.showFiles'")
    expect(actions).toContain("id: 'view.toggleRightSidebar'")
    expect(titlebar).toContain("actionId: 'view.toggleRightSidebar'")
  })

  it('keeps the technical profile manager distinct from the customer Profile route', () => {
    const routes = readSource('./app/routes.ts')

    expect(routes).toContain("export const PROFILES_ROUTE = '/profiles'")
    expect(routes).toContain("export const PROFILE_STATS_ROUTE = '/profile'")
    expect(routes).toContain("{ id: 'profiles', path: PROFILES_ROUTE, view: 'profiles' }")
    expect(routes).toContain("{ id: 'profile', path: PROFILE_STATS_ROUTE, view: 'profile' }")
  })
})
