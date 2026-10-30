/**
 * hc-1094 identity guard (hard rule 11): the update entry looks exactly as it
 * did before hc-1094 in every state but one.
 *
 * The goldens under `__identity__/desktop-update/` were recorded on fork main
 * aa8e554e38, before any hc-1094 code was written: the sidebar update pill
 * (preparing, downloading, ready for the app, the app and the engine, or the
 * engine alone, and a requested install waiting for each of the five busy
 * reasons), its install confirmation, the About page's update section ready and
 * waiting, and the kept-back engine notice after a busy switch. hc-1094 only
 * changes what a wait on engine holders says when the gate names them; that
 * state is not recorded here, so a diff here means another state moved.
 *
 * hc-1117 adds states and pins them in their own goldens (`*-holders-*`,
 * `*-wait-*`, `*-engine-waiting-*`, `zh-kept-back-busy`), recorded on its branch.
 * It changes none of the goldens above.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EngineUpdateSection } from '@/app/settings/about-settings'
import type { DesktopEngineHolder, DesktopRuntimeUpdateCheck, DesktopRuntimeVersion, DesktopShellUpdateState } from '@/global'
import { I18nProvider } from '@/i18n'
import { applyDesktopUpdates } from '@/store/desktop-update'
import { $shellUpdate } from '@/store/shell-update'
import { $runtimeUpdateWait } from '@/store/update-wait'
import { $desktopVersion } from '@/store/updates'

import { DesktopUpdatePill } from './app/chat/sidebar/desktop-update-pill'

vi.mock('@/store/desktop-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $desktopUpdateProgress: atom({
      active: false,
      completedStages: [],
      currentStage: null,
      error: null,
      stages: [],
      targetVersion: null
    }),
    applyDesktopUpdates: vi.fn(),
    checkDesktopUpdates: vi.fn()
  }
})

vi.mock('@/store/runtime-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $runtimeUpdateApplying: atom(false),
    $runtimeUpdateCheck: atom<DesktopRuntimeUpdateCheck | null>(null),
    $runtimeUpdateChecking: atom(false),
    $runtimeVersion: atom<DesktopRuntimeVersion | null>(null),
    applyRuntimeUpdate: vi.fn(),
    checkRuntimeUpdate: vi.fn(async () => null),
    loadRuntimeVersion: vi.fn(async () => null),
    switchToBundledEngine: vi.fn(async () => ({ ok: true, deferred: true }))
  }
})

import { $runtimeUpdateCheck, $runtimeVersion } from '@/store/runtime-update'

const GOLDEN = './__identity__/desktop-update'

const REASONS = ['active_work', 'activity_unknown', 'engine_holders', 'gateway_busy', 'previous_worker'] as const

const SHELL_READY: DesktopShellUpdateState = {
  error: null,
  percent: 100,
  phase: 'downloaded',
  releaseNotes: null,
  version: '0.17.67'
}

const RUNTIME_UPDATE: DesktopRuntimeUpdateCheck = {
  current: { key: 'old', version: 'v2026.10.23-fork.a2e1a4b5' },
  latest: { compatibilityNotes: null, key: 'new', version: 'v2026.10.28-fork.aa8e554e' },
  ok: true,
  updateAvailable: true
}

/** React's generated ids differ by render order; they are not what the guard is about. */
function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

function inLocale(locale: 'en' | 'zh', node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  )
}

beforeEach(() => {
  $shellUpdate.set(null)
  $runtimeUpdateWait.set(null)
  $runtimeUpdateCheck.set(null)
  $runtimeVersion.set(null)
  $desktopVersion.set({ appVersion: '0.17.66' } as never)
})

afterEach(() => cleanup())

describe.each(['zh', 'en'] as const)('update pill (%s)', locale => {
  const pill = async (name: string) => {
    const view = inLocale(locale, <DesktopUpdatePill />)

    await expect(normalized(view.container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/${locale}-pill-${name}.html`)
  }

  it('preparing, downloading and ready', async () => {
    $shellUpdate.set({ ...SHELL_READY, phase: 'available', percent: null })
    await pill('available')
    cleanup()

    $shellUpdate.set({ ...SHELL_READY, phase: 'downloading', percent: 42.6 })
    await pill('downloading')
    cleanup()

    $shellUpdate.set(SHELL_READY)
    await pill('ready-app')
    cleanup()

    $shellUpdate.set({ ...SHELL_READY, deferred: false, deferredReason: null })
    await pill('ready-app-not-deferred')
    cleanup()

    $runtimeUpdateCheck.set(RUNTIME_UPDATE)
    await pill('ready-app-engine')
    cleanup()

    $shellUpdate.set(null)
    await pill('ready-engine')
  })

  it.each(REASONS)('a requested install waiting on %s', async reason => {
    $shellUpdate.set({ ...SHELL_READY, deferred: true, deferredReason: reason })
    await pill(`deferred-${reason}`)
  })

  it('the install confirmation', async () => {
    $shellUpdate.set({ ...SHELL_READY, deferred: true, deferredReason: 'active_work' })
    inLocale(locale, <DesktopUpdatePill />)
    fireEvent.click(screen.getByRole('button'))

    await expect(normalized(screen.getByRole('dialog').outerHTML)).toMatchFileSnapshot(
      `${GOLDEN}/${locale}-pill-confirm.html`
    )
  })
})

describe('About update section (zh)', () => {
  const section = async (name: string) => {
    const view = inLocale('zh', <EngineUpdateSection />)

    await expect(normalized(view.container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/zh-about-${name}.html`)
  }

  it('ready and waiting', async () => {
    $shellUpdate.set(SHELL_READY)
    await section('ready')
    cleanup()

    $shellUpdate.set({ ...SHELL_READY, deferred: true, deferredReason: 'engine_holders' })
    await section('deferred-engine_holders')
  })

  it('the kept-back engine notice after a busy switch', async () => {
    $runtimeVersion.set({
      ok: true,
      version: null,
      commit: null,
      branch: null,
      key: null,
      keptBack: { reason: 'upgrade-failed', bundledVersion: 'v2026.10.28-fork.aa8e554e' }
    })
    inLocale('zh', <EngineUpdateSection />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '换成自带引擎' }))
    })

    await expect(normalized(screen.getByTestId('engine-kept-back-banner').outerHTML)).toMatchFileSnapshot(
      `${GOLDEN}/zh-kept-back-deferred.html`
    )
  })
})

describe.each(['zh', 'en'] as const)('hc-1117: what a named wait looks like (%s)', locale => {
  const CHILD = { pid: 4242, kind: 'leftover_child', name: 'python3.14', created: 7.5, endable: true } as const
  const OTHER = { pid: 3001, kind: 'other', name: 'python3.14', created: 1.5, endable: false } as const
  const TERMINAL = { pid: 2001, kind: 'terminal_hermes', name: 'hermes', created: 8.5, endable: false } as const
  const RUNNING = { pid: 2002, kind: 'apex_running', name: 'python3.14', created: 8.5, endable: false } as const

  const held = (holders: DesktopEngineHolder[]): DesktopShellUpdateState => ({ ...SHELL_READY, deferred: true, deferredReason: 'engine_holders', deferredHolders: holders })

  const waitDialog = async (name: string, state: DesktopShellUpdateState) => {
    $shellUpdate.set(SHELL_READY)
    vi.mocked(applyDesktopUpdates).mockImplementationOnce(async () => {
      $shellUpdate.set(state)

      return true
    })
    inLocale(locale, <DesktopUpdatePill />)
    fireEvent.click(screen.getByRole('button'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '安装更新' : 'Install update' }))
    })

    await expect(normalized(screen.getByRole('dialog').outerHTML)).toMatchFileSnapshot(`${GOLDEN}/${locale}-wait-${name}.html`)
  }

  it('the card, and the confirmation to end a leftover', async () => {
    $shellUpdate.set(held([CHILD]))
    const view = inLocale(locale, <DesktopUpdatePill />)

    await expect(normalized(view.container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/${locale}-pill-holders-leftover_child.html`)
    fireEvent.click(screen.getByTestId('engine-holders-end'))
    await expect(normalized(screen.getByRole('dialog').outerHTML)).toMatchFileSnapshot(`${GOLDEN}/${locale}-pill-holders-leftover_child-confirm.html`)
  })

  it.each<[string, DesktopEngineHolder[]]>([
    ['leftover_child', [CHILD]],
    ['other', [OTHER]],
    ['terminal_hermes', [TERMINAL]],
    ['apex_running', [RUNNING]]
  ])('the answer to a confirmed install held by %s', async (name, holders) => {
    await waitDialog(name, held(holders))
  })

  it.each(REASONS)('the answer to a confirmed install waiting on %s', async reason => {
    await waitDialog(`reason-${reason}`, { ...SHELL_READY, deferred: true, deferredReason: reason })
  })

  it('an engine update that waits, on the card', async () => {
    $runtimeUpdateCheck.set(RUNTIME_UPDATE)
    $runtimeUpdateWait.set({ reason: 'active_work', holders: null })
    const view = inLocale(locale, <DesktopUpdatePill />)

    await expect(normalized(view.container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/${locale}-pill-engine-waiting-active_work.html`)
    cleanup()

    $runtimeUpdateWait.set({ reason: 'engine_holders', holders: [CHILD] })
    const held = inLocale(locale, <DesktopUpdatePill />)

    await expect(normalized(held.container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/${locale}-pill-engine-waiting-leftover_child.html`)
  })
})

describe('hc-1117: the kept-back notice while a boot install waits (zh)', () => {
  it('says the engine is in use and what to click', async () => {
    $runtimeVersion.set({ ok: true, version: null, commit: null, branch: null, key: null, keptBack: { reason: 'busy', bundledVersion: 'v2026.10.28-fork.aa8e554e' } })
    inLocale('zh', <EngineUpdateSection />)

    await expect(normalized(screen.getByTestId('engine-kept-back-banner').outerHTML)).toMatchFileSnapshot(`${GOLDEN}/zh-kept-back-busy.html`)
  })
})
