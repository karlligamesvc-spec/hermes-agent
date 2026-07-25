import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DesktopLoginScreen } from '@/components/desktop-login-screen'
import { type I18nConfigClient, I18nProvider } from '@/i18n/context'

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

  it('keeps the managed login ahead of upstream’s provider picker', () => {
    // Boot order is what stops upstream's Nous Portal / Google panel from ever
    // being the first thing a managed user sees: the auth gate blocks the
    // window, and onboarding only mounts once the gate has let them through.
    const wiring = readSource('src', 'app', 'contrib', 'wiring.tsx')

    expect(wiring).toContain('<DesktopAuthGate')
    expect(wiring).toContain("authState.enabled === false || authState.status === 'signed-in'")
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
