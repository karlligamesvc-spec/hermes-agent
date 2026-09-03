import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkflowRunView } from '@/app/business-workspace/workflow-run-view'
import { AccountPanel } from '@/app/chat/sidebar/account-panel'
import { APEX_PRIMARY_NAVIGATION } from '@/app/routes'
import { Intro } from '@/components/chat/intro'
import { DesktopLoginScreen } from '@/components/desktop-login-screen'
import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { type I18nConfigClient, I18nProvider } from '@/i18n/context'
import { $authState } from '@/store/auth'
import { BUSINESS_SIDEBAR_NAV_CONTRACT, BUSINESS_WORKSPACE_FLAG_KEY } from '@/store/business-workspace'
import { $desktopOnboarding, requestManagedReSignIn, skipManagedForByok } from '@/store/onboarding'

// hc-589 identity-layer guard.
//
// The v0.19.0 port rebased onto the upstream desktop tree and the product's
// FACE came with it: the app opened in English, wore upstream's palette, and
// introduced itself with upstream's icon. Every individual loss was invisible
// to the existing suite — nothing asserted "this still looks like our app" —
// so the whole layer went green while being wrong on a real machine.
//
// This file is that missing assertion, and it is deliberately mixed-mode: the
// behavioral half proves the mechanisms still WORK, the source-contract half
// proves they are still WIRED at the one call site that can silently vanish in
// a rebase (a mount prop, an asset path, a token block). A behavioral test
// alone would not have caught main.tsx losing initialLocale, because the
// provider itself kept working — it just stopped being told what we prefer.

const DESKTOP_ROOT = resolve(__dirname, '..')
const readSource = (...parts: string[]) => readFileSync(join(DESKTOP_ROOT, ...parts), 'utf8')

afterEach(cleanup)

describe('identity: the app opens in Chinese', () => {
  it('falls back to the shell default when the install has no saved language', async () => {
    // A fresh sandbox install: config exists, display.language does not. This
    // is the exact state Kael's packaged first-run was in, and upstream's
    // provider resolves it to the universal `en`.
    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue({ display: { skin: 'mono' } }),
      saveConfig: vi.fn()
    }

    render(
      <I18nProvider configClient={configClient} initialLocale="zh">
        <DesktopLoginScreen requestGateway={vi.fn() as never} />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByRole('heading', { name: '开始使用' })).toBeTruthy())
    expect(configClient.saveConfig).not.toHaveBeenCalled()
  })

  it('keeps main.tsx telling the provider which language we prefer', () => {
    // The provider's fallback is only as good as the preference handed to it.
    // Losing this one prop is what turned the whole app English while every
    // i18n unit test stayed green.
    expect(readSource('src', 'main.tsx')).toContain('<I18nProvider initialLocale="zh">')
  })
})

describe('identity: the first screen is ours', () => {
  const renderLoginScreen = () =>
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <DesktopLoginScreen requestGateway={vi.fn() as never} />
      </I18nProvider>
    )

  it('shows our sign-in, not upstream’s get-started panel', () => {
    renderLoginScreen()

    expect(screen.getByRole('heading', { name: '开始使用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '登录 APEX 账户' })).toBeTruthy()

    // The three strings Kael read off the packaged build. They are the English
    // rendering of THIS screen, so their presence means the locale default is
    // broken even though the component is right.
    for (const upstream of ['Get started', 'Continue with Google', 'Signing in…']) {
      expect(screen.queryByText(upstream)).toBeNull()
    }
  })

  it('shows the APEX mark, never the upstream mascot', () => {
    const { container } = renderLoginScreen()
    const logo = container.querySelector('img')

    expect(logo?.getAttribute('src')).toContain('apple-touch-icon.png')
  })

  it('keeps both auth-gate surfaces opaque when window glass is enabled', () => {
    const { container } = renderLoginScreen()
    const authGate = readSource('src', 'app', 'desktop-auth-gate.tsx')

    expect(container.firstElementChild?.hasAttribute('data-glass-opaque')).toBe(true)
    expect(authGate.match(/data-glass-opaque/g)).toHaveLength(1)
  })

  it('keeps the managed login ahead of upstream’s provider picker', () => {
    // Boot order is what stops upstream's Nous Portal / Google panel from ever
    // being the first thing a managed user sees: the auth gate blocks the
    // window, and onboarding only mounts once the gate has let them through.
    const wiring = readSource('src', 'app', 'contrib', 'wiring.tsx')
    const legacyController = readSource('src', 'app', 'desktop-controller.tsx')

    expect(wiring).toContain('<DesktopAuthGate')
    expect(wiring).toContain('canMountDesktopOnboarding(authState, onboardingRequested)')
    expect(legacyController).toContain('canMountDesktopOnboarding(authState, onboardingRequested)')
    expect(wiring.indexOf('<DesktopAuthGate')).toBeLessThan(wiring.indexOf('<DesktopOnboardingOverlay'))

    // …and when onboarding does open on a managed build, OUR panel leads it.
    // Matched loosely (identifier + gate, any formatting) so a prettier reflow
    // can't fail this for the wrong reason.
    const onboarding = readSource('src', 'components', 'onboarding', 'index.tsx')

    expect(onboarding).toContain('<ManagedSignInPanel')
    expect(onboarding).toContain('onboarding.managedAvailable === true')
  })
})

describe('identity: brand assets and chrome', () => {
  it('names the window APEX', () => {
    expect(readSource('index.html')).toContain('<title>APEX</title>')
  })

  it('pins every brand asset against a silent rebase swap', () => {
    // scripts/assert-icon.cjs holds the sha256 of the four brand images. It
    // exists precisely because this drifts, but it only protects anything if
    // `build` still runs it — the v0.19.0 package.json rewrite dropped the
    // call, which is how the upstream mascot reached a shipped bundle.
    const guard = readSource('scripts', 'assert-icon.cjs')

    for (const asset of ['assets/icon.png', 'assets/icon.icns', 'assets/icon.ico', 'public/apple-touch-icon.png']) {
      expect(guard).toContain(`'${asset}'`)
    }

    expect(JSON.parse(readSource('package.json')).scripts.build).toContain('scripts/assert-icon.cjs')
  })

  it('never points a rendered surface at the upstream mascot art', () => {
    // The files stay in public/ to keep the rebase surface small; what matters
    // is that nothing the user can see reaches for them.
    const brandMark = readSource('src', 'components', 'brand-mark.tsx')

    expect(brandMark).toContain("assetPath('apple-touch-icon.png')")
    expect(brandMark).not.toContain("assetPath('nous-girl.jpg')")
  })

  it('keeps every packaged-app lookup on the APEX artifact name', () => {
    // The visible package was renamed before every updater/install/E2E lookup
    // was migrated. electron-builder correctly emitted APEX.app/APEX.exe while
    // those callers still searched only for Hermes.*, so builds went green and
    // the update/first-run chain failed after packaging. Keep all six exits
    // pinned; legacy Hermes candidates may remain only as upgrade fallbacks.
    const pkg = JSON.parse(readSource('package.json'))
    const main = readSource('electron', 'main.ts')
    const packageProbe = readSource('scripts', 'test-desktop.mjs')
    const e2e = readSource('e2e', 'fixtures.ts')
    const installSh = readSource('..', '..', 'scripts', 'install.sh')
    const installPs1 = readSource('..', '..', 'scripts', 'install.ps1')
    const cli = readSource('..', '..', 'hermes_cli', 'main.py')

    expect(pkg.productName).toBe('APEX')
    expect(pkg.build.productName).toBe('APEX')
    expect(pkg.build.executableName).toBe('APEX')
    expect(packageProbe).toContain('`${PRODUCT_NAME}.app`')
    expect(packageProbe).toContain('`${EXECUTABLE_NAME}.exe`')
    expect(e2e).toContain('`${PACKAGED_PRODUCT_NAME}.app`')
    expect(e2e).toContain('`${PACKAGED_EXECUTABLE_NAME}.exe`')
    // v0.21 removed the legacy in-process macOS bundle swap. The current
    // handoff no longer searches a staged .app here; if that lookup returns in
    // a future refactor, it must not regress to the upstream artifact name.
    expect(main).not.toContain("'Hermes.app'")
    expect(installSh).toContain('/mac-arm64/APEX.app')
    expect(installPs1).toContain('\\release\\win-unpacked\\APEX.exe')
    expect(cli).toContain('mac*/APEX.app/Contents/MacOS/APEX')
    expect(cli).toContain('"APEX.exe"')
  })

  it('uses the APEX name for every native window and default notification', () => {
    const main = readSource('electron', 'main.ts')
    const bootE2e = readSource('e2e', 'boot.spec.ts')
    const onboarding = readSource('src', 'store', 'onboarding.ts')

    const gatewayEvents = readSource(
      'src',
      'app',
      'session',
      'hooks',
      'use-message-stream',
      'gateway-event',
      'status.ts'
    )

    const reactions = readSource('src', 'components', 'assistant-ui', 'thread', 'message-reactions.tsx')

    expect((main.match(/title: APP_NAME/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(main).not.toMatch(/title: (?:payload\?\.title \|\| )?['"]Hermes['"]/)
    expect(main).toContain("title: silent ? 'Connecting to APEX Cloud agent…' : 'Sign in to APEX'")
    expect(main).toContain("title: 'Sign in to APEX Cloud'")
    expect(bootE2e).toContain("expect(title).toContain('APEX')")
    expect(onboarding).toContain("title: 'APEX is ready'")
    expect(gatewayEvents).toContain("title: 'APEX error'")
    expect(reactions).toContain('title="Reacted by APEX"')
  })

  it('keeps shell and AI engine updates behind one desktop update path (hc-690)', () => {
    // v0.20 made the shell and runtime independently updatable, but exposing
    // their old actions together made users install and restart twice. Pin the
    // three production surfaces to the shared orchestrator so a future rebase
    // cannot silently wire one of them back to a component-specific updater.
    const sidebar = readSource('src', 'app', 'chat', 'sidebar', 'index.tsx')
    const about = readSource('src', 'app', 'settings', 'about-settings.tsx')
    const commandCenter = readSource('src', 'app', 'command-center', 'index.tsx')
    const commandPalette = readSource('src', 'app', 'command-palette', 'index.tsx')
    const contributionShell = readSource('src', 'app', 'contrib', 'hooks', 'use-desktop-integrations.ts')
    const legacyShell = readSource('src', 'app', 'desktop-controller.tsx')

    expect((sidebar.match(/<DesktopUpdatePill/g) || []).length).toBe(1)
    expect(sidebar).not.toContain('<ShellUpdatePill')
    expect(sidebar).not.toContain('<RuntimeUpdatePill')

    for (const surface of [about, commandCenter]) {
      expect(surface).toContain('applyDesktopUpdates')
      expect(surface).not.toContain('applyRuntimeUpdate')
      expect(surface).not.toContain('installShellUpdate')
    }

    expect(commandCenter).toContain('checkDesktopUpdates')
    expect(commandCenter).not.toContain('updateHermes')
    expect(commandPalette).toContain('run: go(`${COMMAND_CENTER_ROUTE}?section=system`)')
    expect(commandPalette).not.toContain('requestActiveUpdate')

    // Help > Check for Updates is emitted by the Electron main process. Both
    // renderer shells must land on the unified update center; the old
    // openUpdatesWindow path only knows how to update source/git installs.
    for (const shell of [contributionShell, legacyShell]) {
      expect(shell).toContain('onOpenUpdatesRequested')
      expect(shell).toContain('navigate(`${COMMAND_CENTER_ROUTE}?section=system`)')
      expect(shell).not.toContain('openUpdatesWindow')
    }
  })
})

// hc-589 leg 8c — zero-setup first run.
//
// Kael's sandbox first-install landed on upstream's BYOK provider-card screen
// ("开始设置 APEX" + provider cards + an API-key box). The product is托管零钥匙:
// sign in, the platform issues the relay key, chat opens. The picker is an
// escape hatch, so it may only appear when the user asks for it by name.
//
// These are behavioral: they render the real overlay against a mocked bridge and
// assert what a user would see, because every wrong route here ends in a
// rendered card screen — the exact thing a source check can't see.
describe('zero setup: a managed user is never asked to pick a provider', () => {
  // Anything the BYOK surface puts on screen. Deliberately several markers: the
  // picker has two faces (OAuth rows and the key form) and onboarding can land
  // on either depending on which probe disagreed.
  const BYOK_ON_SCREEN = ['连接模型提供方', '我有 API 密钥', '获取密钥', 'Fireworks AI', 'Nous Portal']

  const byokMarkersOnScreen = () => BYOK_ON_SCREEN.filter(marker => screen.queryAllByText(marker).length > 0)

  const notReadyGateway = (providerConfigured: boolean) => async (method: string) => {
    if (method === 'setup.status') {
      return { provider_configured: providerConfigured } as never
    }

    if (method === 'setup.runtime_check') {
      return { ok: false, error: 'Selected runtime is not available.' } as never
    }

    return undefined as never
  }

  const installBridge = (managedStatus: { enabled: boolean; signedIn: boolean }, oauthProviders: unknown[] = []) => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        api: async ({ path }: { path: string }) => {
          if (path === '/api/providers/oauth') {
            return { providers: oauthProviders }
          }

          return { providers: [] }
        },
        managed: { status: async () => managedStatus }
      }
    })
  }

  const renderOnboarding = (gateway = notReadyGateway(true)) =>
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <DesktopOnboardingOverlay enabled requestGateway={gateway as never} />
      </I18nProvider>
    )

  const freshInstall = () => {
    window.localStorage.clear()
    $desktopOnboarding.set({
      configured: null,
      flow: { status: 'idle' },
      mode: 'oauth',
      providers: null,
      reason: null,
      requested: false,
      firstRunSkipped: false,
      manual: false,
      localEndpoint: false,
      needsCredential: false,
      managedAvailable: null,
      managedError: null,
      managedSubmitting: false,
      managedSyncing: false,
      byokFromLogin: false
    })
    $authState.set({
      account: { email: '', name: '', plan: '' },
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })
  }

  afterEach(() => {
    cleanup()
    freshInstall()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('holds our own waiting state while the relay key reaches the runtime', async () => {
    // The race behind Kael's screenshot: signed in (the platform issued a key),
    // but the runtime hasn't picked it up yet, so setup.status and the runtime
    // check disagree. That used to fall straight through to the key form.
    freshInstall()
    installBridge({ enabled: true, signedIn: true })
    renderOnboarding()

    await waitFor(() => expect(screen.getByText('正在准备你的 APEX 助手…')).toBeTruthy())
    expect(byokMarkersOnScreen()).toEqual([])
    expect($desktopOnboarding.get().managedSyncing).toBe(true)
  })

  it('leads a signed-out managed install with our sign-in, not the picker', async () => {
    freshInstall()
    installBridge({ enabled: true, signedIn: false }, [
      { cli_command: '', docs_url: '', flow: 'pkce', id: 'nous', name: 'Nous Portal', status: { logged_in: false } }
    ])
    renderOnboarding()

    await waitFor(() => expect(screen.getByText('登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。')).toBeTruthy())
    expect(byokMarkersOnScreen()).toEqual([])
  })

  it('lets a "choose later" user into the app instead of a card screen', async () => {
    freshInstall()
    installBridge({ enabled: true, signedIn: true })
    const { container } = renderOnboarding()

    await waitFor(() => expect(screen.getByText('正在准备你的 APEX 助手…')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '稍后再选择提供方' }))

    await waitFor(() => expect(container.textContent).toBe(''))
    expect(byokMarkersOnScreen()).toEqual([])
  })

  it('stays out of the way on the next launch of a signed-in install', async () => {
    // Second start: the relay key is on disk and onboarding is cached done. Even
    // if the readiness probe answers "not ready" mid-boot, the app must not
    // demote a returning user to an overlay — they land straight in chat.
    freshInstall()
    window.localStorage.setItem('hermes-desktop-onboarded-v1', '1')
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: true })
    installBridge({ enabled: true, signedIn: true })
    const { container } = renderOnboarding()

    await waitFor(() => expect($desktopOnboarding.get().managedSyncing).toBe(true))
    expect(container.textContent).toBe('')
    expect($desktopOnboarding.get().configured).toBe(true)
    expect(window.localStorage.getItem('hermes-desktop-onboarded-v1')).toBe('1')
  })

  it('still re-asks for sign-in when the key on disk is dead (hc-511)', async () => {
    // A dead relay key is still a key FILE, so the bridge reports signedIn=true.
    // That must not be mistaken for "the key is on its way" — the caller asked
    // for a re-sign-in, so the sign-in panel stays up rather than a wait that
    // would end by dropping the user into a chat where every send 401s.
    freshInstall()
    installBridge({ enabled: true, signedIn: true })
    requestManagedReSignIn('登录已失效,请重新登录')
    renderOnboarding()

    await waitFor(() => expect(screen.getByText('登录 APEX 账号即可直接开始对话 —— 无需填写 API Key。')).toBeTruthy())
    expect(screen.queryByText('正在准备你的 APEX 助手…')).toBeNull()
    expect(byokMarkersOnScreen()).toEqual([])
  })

  it('opens the picker only when the user asks for it by name, and keeps a way back', async () => {
    // The escape hatch: "使用自己的密钥" on the login screen. This is the ONE
    // route to the provider cards on a managed build — and once there, "返回登录"
    // has to work, or the hatch is a trap.
    freshInstall()
    installBridge({ enabled: true, signedIn: true })
    skipManagedForByok()
    renderOnboarding()

    await waitFor(() => expect(screen.getByPlaceholderText('粘贴 API 密钥')).toBeTruthy())
    expect(byokMarkersOnScreen().length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '返回登录' }))

    expect($desktopOnboarding.get().byokFromLogin).toBe(false)
    expect($authState.get().status).toBe('signed-out')
    expect($authState.get().enabled).toBe(true)
  })

  it('offers that escape hatch on the login screen', () => {
    freshInstall()
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <DesktopLoginScreen requestGateway={vi.fn() as never} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: '使用自己的密钥' }))

    // Marked as an explicit BYOK detour, and the account gate steps aside so the
    // picker (which only mounts past the gate) can take the window.
    expect($desktopOnboarding.get().byokFromLogin).toBe(true)
    expect($authState.get().enabled).toBe(false)
  })
})

// hc-589 leg 8d — the zero state is ours.
//
// The rebase handed the empty home screen back to upstream: a giant
// `HERMES AGENT` wordmark filling the width, under it a rotating line from
// intro-copy.jsonl written for a CODING agent ("Search the repo, edit files, run
// tests, open PRs"). Kael read it off the packaged build. It is the first thing
// a user sees, in English, describing a product we do not sell — and no test
// noticed, because upstream's own intro test only checked that copy was picked.
//
// Behavioral, against the real component tree: the greeting and the active
// start shelf have to coexist, the hc-554 catalog remains the explicit rollback
// path, and the upstream surface has to be gone from what actually renders —
// not merely unimported.
describe('identity: the home zero-state is ours', () => {
  const renderIntro = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <I18nProvider configClient={null} initialLocale="zh">
            <Intro />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  it('greets in Chinese and offers the real business start shelf', () => {
    const originalBridge = window.hermesDesktop

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { api: vi.fn(async () => new Promise(() => undefined)) }
    })

    try {
      const { container } = renderIntro()

      expect(screen.getByRole('heading', { name: '今天想推进什么业务？' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '开始一个目标' })).toBeTruthy()
      expect(screen.getByRole('textbox', { name: '业务目标' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '开始执行' })).toBeTruthy()
      expect(screen.getByRole('button', { name: /从市场机会到上架素材/ })).toBeTruthy()
      expect(container.querySelector('[data-business-start-evidence]')).toBeTruthy()
      expect(screen.getByRole('button', { name: '打开任务' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '打开交付物' })).toBeTruthy()
    } finally {
      Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalBridge })
    }
  })

  it('restores the scenario catalog through the business-workspace rollback seam', () => {
    window.localStorage.setItem(BUSINESS_WORKSPACE_FLAG_KEY, '0')

    try {
      renderIntro()
      expect(screen.getByRole('button', { name: /热榜/ })).toBeTruthy()
    } finally {
      window.localStorage.removeItem(BUSINESS_WORKSPACE_FLAG_KEY)
    }
  })

  it('never renders the upstream wordmark or its coding-agent pitch', () => {
    const { container } = renderIntro()
    const rendered = container.textContent || ''

    expect(rendered).not.toContain('HERMES AGENT')
    // The aria-label carried the wordmark too — a screen reader heard it even
    // when the fit-text CSS hid the glyphs.
    expect(container.querySelector('[aria-label*="HERMES"]')).toBeNull()

    for (const upstream of ['Search the repo', 'open PRs', 'run tests', 'APEX look at']) {
      expect(rendered).not.toContain(upstream)
    }
  })

  it('keeps the intro off the upstream copy corpus entirely', () => {
    // intro-copy.jsonl stays on disk (small rebase surface, same call as the
    // upstream mascot art). What must never come back is the import — that one
    // line is the whole difference between our zero state and theirs.
    const intro = readSource('src', 'components', 'chat', 'intro.tsx')

    expect(intro).toContain('<BusinessStartHome')
    expect(intro).toContain('<ScenarioShelf />')
    expect(intro).not.toMatch(/^import .*intro-copy\.jsonl/m)
    expect(intro).not.toContain('WORDMARK')
  })

  it('wires the goal launcher to the canonical chat submit path', () => {
    const chat = readSource('src', 'app', 'chat', 'index.tsx')
    const startHome = readSource('src', 'app', 'business-workspace', 'pages', 'start-page.tsx')
    const startShelf = readSource('src', 'app', 'business-workspace', 'components', 'start-shelf.tsx')
    const workflows = readSource('src', 'app', 'business-workspace', 'pages', 'workflows-page.tsx')

    expect(chat).toContain('onSubmitGoal: onSubmit')
    expect(chat).toContain('goalDisabled: !gatewayOpen || busy')
    expect(startHome).toContain('<BusinessStartShelf onSelectWorkflow={selectWorkflow} />')
    expect(startHome).toContain('draft={goalDraft}')
    expect(startShelf).toContain('businessWorkflowStarters(c.workflows)')
    expect(workflows).toContain('businessWorkflowStarters(c)')
  })
})

describe('identity: the brand skin survives', () => {
  it('seeds the ApexNodes violet rather than the upstream blue', () => {
    // presets.ts is the runtime truth (applyTheme repaints the seeds from it);
    // styles.css is the boot-paint fallback. Both have to say the same thing,
    // and the rebase flipped BOTH — checking only one would have passed.
    expect(readSource('src', 'themes', 'presets.ts')).toContain("const APEX_VIOLET = '#7E6CEF'")

    const styles = readSource('src', 'styles.css')

    expect(styles).toContain('--theme-primary: #7e6cef;')
    expect(styles).not.toContain('--theme-primary: #0053fd;')
  })

  it('keeps the P5 settings design system that ~40 call sites render against', () => {
    // This block was deleted outright while every `p5-*` className stayed in
    // the JSX, so Settings / 个人资料 / the update capsules rendered unstyled
    // and nothing failed.
    const styles = readSource('src', 'styles.css')

    for (const cls of ['.p5-settings', '.p5-card', '.p5-profile-heatmap', '.p5-update-pill']) {
      expect(styles).toContain(cls)
    }
  })
})

describe('identity: the APEX business shell stays user-facing', () => {
  it('pins all seven primary destinations in order and names the long-term surface assistant', () => {
    expect(APEX_PRIMARY_NAVIGATION.map(item => item.id)).toEqual([
      'start',
      'projects',
      'workflows',
      'scheduled-runs',
      'deliverables',
      'assistant',
      'history'
    ])
    expect(APEX_PRIMARY_NAVIGATION.map(item => item.path)).toEqual([
      '/',
      '/projects',
      '/workflows',
      '/cron',
      '/deliverables',
      '/assistant',
      '/history'
    ])
    expect(APEX_PRIMARY_NAVIGATION.some(item => ['accounts', 'agents', 'bots'].includes(item.id))).toBe(false)
    expect(BUSINESS_SIDEBAR_NAV_CONTRACT.map(item => item.id)).toEqual(APEX_PRIMARY_NAVIGATION.map(item => item.id))
    expect(BUSINESS_SIDEBAR_NAV_CONTRACT.map(item => item.route)).toEqual(
      APEX_PRIMARY_NAVIGATION.map(item => item.path)
    )
  })

  it('keeps Profile and Settings behind the bottom account control', async () => {
    const previousAuthState = $authState.get()

    $authState.set({
      account: { email: 'kael@example.com', name: 'Kael', plan: '' },
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })

    try {
      render(
        <MemoryRouter>
          <I18nProvider configClient={null} initialLocale="zh">
            <AccountPanel />
          </I18nProvider>
        </MemoryRouter>
      )

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Kael' }), { button: 0, ctrlKey: false })

      expect(await screen.findByRole('menuitem', { name: '个人资料' })).toBeTruthy()
      expect(screen.getByRole('menuitem', { name: '设置' })).toBeTruthy()
    } finally {
      $authState.set(previousAuthState)
    }
  })

  it('renders Hermes as the only production executor and offers no DSH picker', async () => {
    const originalBridge = window.hermesDesktop

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        ...originalBridge,
        workflowDomain: {
          getRun: vi.fn().mockResolvedValue({
            ok: true,
            overview: {
              deliverables: [],
              events: [],
              run: {
                attempt: 1,
                createdAt: '2026-09-03T00:00:00Z',
                errorMessage: null,
                executorType: 'hermes',
                id: 'run-identity',
                maxAttempts: 1,
                status: 'succeeded',
                triggerRef: 'Verify identity'
              }
            }
          })
        }
      }
    })

    try {
      render(
        <MemoryRouter initialEntries={['/workflow-runs/run-identity']}>
          <I18nProvider configClient={null} initialLocale="zh">
            <Routes>
              <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
            </Routes>
          </I18nProvider>
        </MemoryRouter>
      )

      expect(await screen.findByText('hermes')).toBeTruthy()
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.queryByText(/DeepSeek Harness|DSH/i)).toBeNull()
    } finally {
      Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalBridge })
    }
  })
})

describe('identity: hc-795 uses the authenticated workflow domain without exposing credentials', () => {
  it('keeps the platform JWT in Electron and exposes only typed workflow operations', () => {
    const main = readSource('electron', 'main.ts')
    const preload = readSource('electron', 'preload.ts')

    expect(main).toContain('import {\n  cancelWorkflowDomainRun,')
    expect(main).toContain("const bearer = String(managed.accessToken || '').trim()")
    expect(main).toContain("ipcMain.handle('hermes:workflowDomain:startGoal'")
    expect(main).toContain("ipcMain.handle('hermes:workflowDomain:reviewDeliverable'")

    expect(preload).toContain('workflowDomain: {')
    expect(preload).toContain("ipcRenderer.invoke('hermes:workflowDomain:getRun', runId)")
    expect(preload).not.toContain('accessToken')
  })

  it('pins the first real P2B loop from Start to Run review while retaining the dark-launch fallback', () => {
    const startHome = readSource('src', 'app', 'business-workspace', 'pages', 'start-page.tsx')
    const client = readSource('src', 'app', 'business-workspace', 'api', 'adapters.ts')
    const surfaces = readSource('src', 'app', 'contrib', 'surfaces.tsx')
    const runView = readSource('src', 'app', 'business-workspace', 'pages', 'workflow-run-page.tsx')

    expect(startHome).toContain('const outcome = await startWorkflowGoal(')
    expect(startHome).toContain("slug: 'desktop-goal'")
    expect(startHome).toContain('navigate(workflowRunRoute(outcome.runId), {')
    expect(startHome).toContain('state: routeDrawerNavigationState(location)')
    expect(startHome).toContain('return (await onSubmitGoal?.(goal)) ?? false')
    expect(client).toContain('access = await bridge.access()')
    expect(client).toContain("return { mode: 'unavailable' }")
    expect(surfaces).toContain('path="workflow-runs/:runId"')
    expect(runView).toContain("review(deliverable.id, 'approved')")
    expect(runView).toContain("review(deliverable.id, 'changes_requested')")
  })
})
