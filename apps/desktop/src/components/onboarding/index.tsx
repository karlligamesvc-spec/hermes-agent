import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { getGlobalModelOptions } from '@/hermes'
import { useI18n } from '@/i18n'
import { Check, ChevronDown, ChevronLeft, KeyRound, Loader2 } from '@/lib/icons'
import { isProviderSetupErrorMessage } from '@/lib/provider-setup-errors'
import { cn } from '@/lib/utils'
import { $authState, returnToManagedLogin } from '@/store/auth'
import { $desktopBoot, type DesktopBootState } from '@/store/boot'
import {
  $desktopOnboarding,
  clearPendingProviderOAuth,
  closeManualOnboarding,
  confirmOnboardingModel,
  DEFAULT_MANUAL_ONBOARDING_REASON,
  DEFAULT_ONBOARDING_REASON,
  dismissFirstRunOnboarding,
  exitByokFromLogin,
  managedBrowserSignIn,
  managedSignIn,
  type OnboardingContext,
  peekPendingProviderOAuth,
  refreshOnboarding,
  saveOnboardingApiKey,
  setOnboardingMode,
  skipManagedForByok,
  startProviderOAuth
} from '@/store/onboarding'
import type { ModelOptionProvider, OAuthProvider } from '@/types/hermes'

import { DocsLink, FlowPanel, Status } from './flow'
import {
  FeaturedProviderRow,
  FireworksProviderRow,
  OpenRouterProviderRow,
  ProviderRow,
  sortProviders
} from './providers'

export {
  FeaturedProviderRow,
  FireworksProviderRow,
  KeyProviderRow,
  OpenRouterProviderRow,
  ProviderRow,
  providerTitle,
  sortProviders
} from './providers'

interface DesktopOnboardingOverlayProps {
  enabled: boolean
  onCompleted?: () => void
  profile?: string
  requestGateway: OnboardingContext['requestGateway']
}

export interface ApiKeyOption {
  description?: string
  docsUrl: string
  envKey: string
  id: string
  name: string
  placeholder?: string
  short?: string
}

// Curated order mirrors CANONICAL_PROVIDERS: Fireworks sits #2 overall (after
// Nous Portal OAuth), ahead of OpenRouter and the rest of the key catalog.
const API_KEY_OPTIONS: ApiKeyOption[] = [
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    docsUrl: 'https://app.fireworks.ai/settings/users/api-keys'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    docsUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    docsUrl: 'https://aistudio.google.com/app/apikey'
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    envKey: 'XAI_API_KEY',
    docsUrl: 'https://console.x.ai/'
  },
  {
    id: 'local',
    name: 'Local / custom endpoint',
    envKey: 'OPENAI_BASE_URL',
    docsUrl: 'https://github.com/NousResearch/hermes-agent#bring-your-own-endpoint',
    placeholder: 'http://127.0.0.1:8000/v1'
  }
]

// Build the FULL API-key provider catalog from the backend model options so the
// onboarding / Providers key form lists every `api_key` provider `hermes model`
// knows about — not just the hand-curated five. Curated entries keep their
// richer copy + placeholders and float to the top (recommended defaults); every
// other api_key provider is appended with a generic "paste {KEY}" affordance.
// OAuth / external providers are intentionally excluded here — they go through
// the OAuth picker / sign-in flow, not a pasted key.
function useApiKeyCatalog(): ApiKeyOption[] {
  const [rows, setRows] = useState<ModelOptionProvider[]>([])

  useEffect(() => {
    let cancelled = false

    // Best-effort — on failure the curated defaults still render. Wrapped in
    // Promise.resolve().then so a synchronous throw (e.g. no desktop bridge in
    // tests) is funneled into the same .catch instead of escaping.
    void Promise.resolve()
      .then(() => getGlobalModelOptions({ includeUnconfigured: true, explicitOnly: false }))
      .then(res => {
        if (!cancelled) {
          setRows(res.providers ?? [])
        }
      })
      .catch(() => {
        // Ignore — fall back to the curated API_KEY_OPTIONS only.
      })

    return () => {
      cancelled = true
    }
  }, [])

  return useMemo(() => {
    const curatedByEnv = new Map(API_KEY_OPTIONS.map(o => [o.envKey, o]))
    const derived: ApiKeyOption[] = []
    const seenEnv = new Set<string>(API_KEY_OPTIONS.map(o => o.envKey))

    for (const row of rows) {
      // Only api_key providers can be activated with a pasted key. Skip OAuth /
      // external / managed flows and anything missing an env var to write to.
      if (row.auth_type && row.auth_type !== 'api_key') {
        continue
      }

      const envKey = row.key_env

      if (!envKey || seenEnv.has(envKey)) {
        continue
      }

      seenEnv.add(envKey)
      derived.push({
        id: row.slug,
        name: row.name,
        envKey,
        description: `Direct API access to ${row.name}.`,
        docsUrl: ''
      })
    }

    // Curated first (recommended order), then the rest alphabetically so the
    // long tail is scannable.
    derived.sort((a, b) => a.name.localeCompare(b.name))

    return [...API_KEY_OPTIONS.filter(o => curatedByEnv.has(o.envKey)), ...derived]
  }, [rows])
}

// Exit choreography, mirroring the gateway "connecting" overlay's timing:
// text-out (360ms: CONNECTED fades down, rest scrambles+fades) → hold (300ms)
// → surface-out (520ms, held back by [transition-delay:660ms]). Finalize after.
const ONBOARDING_EXIT_MS = 1180

export function DesktopOnboardingOverlay({
  enabled,
  onCompleted,
  profile = 'default',
  requestGateway
}: DesktopOnboardingOverlayProps) {
  const { t } = useI18n()
  const onboarding = useStore($desktopOnboarding)
  const auth = useStore($authState)
  const boot = useStore($desktopBoot)
  const ctxRef = useRef<OnboardingContext>({ requestGateway, onCompleted, profile })
  ctxRef.current = { requestGateway, onCompleted, profile }

  const ctx = useMemo<OnboardingContext>(
    () => ({
      requestGateway: (...args) => ctxRef.current.requestGateway(...args),
      onCompleted: () => ctxRef.current.onCompleted?.(),
      get profile() {
        return ctxRef.current.profile
      }
    }),
    []
  )

  // Cinematic exit on "Begin": dissolve the panel + overlay (revealing the chat
  // behind), THEN finalize so the unmount lands after the fade — mirrors the
  // connecting overlay's exit choreography instead of cutting instantly.
  const [leaving, setLeaving] = useState(false)

  const finalizeOnboarding = () => {
    if (leaving) {
      return
    }

    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    if (reduce) {
      confirmOnboardingModel(ctx)

      return
    }

    setLeaving(true)
    window.setTimeout(() => confirmOnboardingModel(ctx), ONBOARDING_EXIT_MS)
  }

  useEffect(() => {
    if (enabled || onboarding.requested) {
      void refreshOnboarding(ctx)
    }
  }, [ctx, enabled, onboarding.requested])

  // When the Providers settings page asked to connect a specific provider, the
  // store stashed its id. Once the provider list has loaded and we're back at
  // an idle picker, launch that exact OAuth flow so the user lands directly in
  // sign-in instead of the picker they just came from.
  useEffect(() => {
    if (!onboarding.manual || onboarding.providers === null || onboarding.flow.status !== 'idle') {
      return
    }

    const pendingId = peekPendingProviderOAuth()

    if (!pendingId) {
      return
    }

    const provider = onboarding.providers.find(p => p.id === pendingId)

    if (provider) {
      // Only clear once we've committed to launching it, so a failed/empty
      // provider fetch doesn't silently drop the hand-off.
      clearPendingProviderOAuth()
      void startProviderOAuth(provider, ctx)
    } else if (onboarding.providers.length > 0) {
      // The list loaded but the id isn't a real provider — drop the stale
      // hand-off. An empty list means the fetch isn't ready yet, so keep it
      // and let a later refresh retry.
      clearPendingProviderOAuth()
    }
  }, [ctx, onboarding.flow.status, onboarding.manual, onboarding.providers])

  // Mount from frame 1 so we replace the boot overlay seamlessly. The
  // configured field stays null until the runtime check resolves; only then
  // do we know whether to dismiss (true) or surface the picker (false).
  // EXCEPTION: manual mode (user opened the selector from a working app to
  // add/switch a provider) shows the overlay regardless of configured state.
  if (onboarding.configured === true && !onboarding.manual) {
    return null
  }

  // The user chose "I'll choose a provider later" on first run. Stay out of the
  // way on every subsequent launch — they re-enter via Settings → Providers
  // (manual mode), which sets manual=true and bypasses this gate.
  if (onboarding.firstRunSkipped && !onboarding.manual) {
    return null
  }

  const { flow } = onboarding
  // Show the launch reason only when it's a meaningful, caller-supplied prompt —
  // suppress the generic defaults (useless noise) and provider-setup errors
  // (those are surfaced by FlowPanel, not as a banner).
  const rawReason = onboarding.reason?.trim() || null

  const reason =
    rawReason &&
    !isProviderSetupErrorMessage(rawReason) &&
    rawReason !== DEFAULT_ONBOARDING_REASON &&
    rawReason !== DEFAULT_MANUAL_ONBOARDING_REASON
      ? rawReason
      : null

  // In manual mode the app is already configured, so the flow is "ready"
  // immediately — no runtime gate needed. Otherwise wait for the readiness
  // check (configured === false) before showing the picker.
  const ready = onboarding.manual || (enabled && onboarding.configured === false)
  const showPicker = flow.status === 'idle' || flow.status === 'success'
  // The final "you're in" screen drops the card chrome and floats centered on
  // the surface — same bare, cinematic treatment as the connecting overlay.
  const bare = ready && !showPicker && flow.status === 'confirming_model'

  // This window belongs to a managed account: the account gate is in play
  // (auth.enabled !== false) and the user has not stepped out of it — the BYOK
  // escape hatch flips the gate off, and Settings → Providers opens onboarding
  // in manual mode. Such a user has NOTHING to configure, so no BYOK surface may
  // be drawn for them, not even the "connect a provider" header, and not for the
  // one frame before a probe answers. That frame was the bug: onboarding
  // finishing and the gate opening are different events (the gate re-probes on
  // every gateway reconnect, and the relay key is already on disk by then), so
  // the overlay routinely renders with configured === null and nothing decided.
  const managedAccount = auth.enabled !== false && !onboarding.manual && !onboarding.byokFromLogin

  // Which of the five surfaces this overlay is showing. Named rather than
  // nested-ternaried because two things read it: what to render, and which
  // header to wear.
  const surface = managedAccount
    ? onboarding.managedAvailable === true
      ? 'managed-signin'
      : 'managed-preparing'
    : onboarding.managedSyncing
      ? 'managed-preparing'
      : !ready
        ? 'booting'
        : showPicker
          ? 'picker'
          : 'flow'

  return (
    <div
      className={cn(
        'fixed inset-0 z-(--z-onboarding) flex items-center justify-center bg-(--ui-chat-surface-background) p-6 transition-opacity duration-[520ms] ease-out',
        // On the bare confirm screen, hold the surface (text-out + hold) so the
        // per-element exit plays before it dissolves.
        bare && leaving ? '[transition-delay:660ms]' : '',
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      // Masks the whole app until onboarding finishes — must stay filled under
      // window glass or the shell shows through. Contract:
      // `[data-glass-opaque]` in styles.css.
      data-glass-opaque=""
    >
      <div
        className={cn(
          'relative w-full max-w-[45rem] transition-all duration-500 ease-out',
          bare
            ? ''
            : 'overflow-hidden rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous',
          // Bare confirm screen orchestrates its own per-element exit; the
          // carded states use the simple lift/blur dissolve.
          leaving && !bare
            ? '-translate-y-1 scale-[0.985] opacity-0 blur-[2px]'
            : 'translate-y-0 scale-100 opacity-100 blur-0'
        )}
      >
        {/* The header sells "connect a provider" — the right promise for the
            BYOK surfaces and the wrong one for a zero-key user, whose panels
            introduce themselves. */}
        {surface === 'picker' || surface === 'booting' ? <Header /> : null}
        {onboarding.manual ? (
          <Button
            aria-label={t.common.close}
            className="absolute right-3 top-3 z-10 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
            onClick={() => closeManualOnboarding()}
            size="icon-sm"
            variant="ghost"
          >
            <Codicon name="close" size="1rem" />
          </Button>
        ) : null}
        <div className="grid gap-3 p-5">
          {reason ? <ReasonNotice reason={reason} /> : null}
          {/* Managed-LLM builds lead with our own surfaces: a one-tap sign-in
              (zero key) before login, and a branded wait while the relay key
              reaches the runtime. Without them a managed build falls through to
              upstream's picker, whose featured row is Nous Portal — the foreign
              sign-in surface standing where ours belongs. */}
          {surface === 'managed-preparing' ? (
            <ManagedPreparingPanel />
          ) : surface === 'managed-signin' ? (
            <ManagedSignInPanel ctx={ctx} />
          ) : surface === 'picker' ? (
            <Picker ctx={ctx} />
          ) : surface === 'booting' ? (
            <Preparing boot={boot} />
          ) : (
            <FlowPanel ctx={ctx} flow={flow} leaving={leaving} onBegin={finalizeOnboarding} />
          )}
        </div>
      </div>
    </div>
  )
}

// The launch reason is a prompt ("why am I seeing this"), not an error. Only
// rendered for meaningful caller-supplied reasons (defaults are filtered out
// upstream), so it never shows the generic "no provider configured" noise.
function ReasonNotice({ reason }: { reason: string }) {
  return (
    <div className="rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-4 py-3 text-sm text-muted-foreground">
      {reason}
    </div>
  )
}

function Preparing({ boot }: { boot: DesktopBootState }) {
  const { t } = useI18n()
  const progress = Math.max(2, Math.min(100, Math.round(boot.progress)))
  const hasError = Boolean(boot.error)
  const installing = boot.phase.startsWith('runtime.')

  return (
    <div className="grid gap-3" role="status">
      <p className="text-sm text-muted-foreground">
        {installing ? t.onboarding.preparingInstall : t.onboarding.starting}
      </p>
      <Progress
        aria-label={installing ? t.onboarding.preparingInstall : t.onboarding.starting}
        destructive={hasError}
        size="lg"
        value={progress / 100}
      />
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">{boot.message}</span>
        <span>{progress}%</span>
      </div>
      {hasError ? <p className="text-xs text-destructive">{boot.error}</p> : null}
    </div>
  )
}

// Signed in, zero-key, waiting for the runtime to see the relay key the platform
// just issued. The whole point of this panel is that it is NOT the BYOK picker:
// the user has nothing to configure, so they get our name, a spinner, and a way
// to stop waiting — never a provider grid.
function ManagedPreparingPanel() {
  const { t } = useI18n()
  const m = t.onboarding.managed

  return (
    <div className="grid gap-3" role="status">
      <div className="flex items-center gap-2.5">
        <Loader2 className="size-4 animate-spin text-(--theme-primary)" />
        <p className="text-sm font-medium">{m.preparing}</p>
      </div>
      <p className="text-[0.8125rem] leading-5 text-(--ui-text-tertiary)">{m.preparingHint}</p>
      <div className="flex justify-end pt-1">
        <ChooseLaterLink />
      </div>
    </div>
  )
}

function Header() {
  const { t } = useI18n()

  return (
    <div className="bg-(--ui-chat-bubble-background) px-5 pt-5 pb-1">
      <h2 className="text-[0.9375rem] font-semibold tracking-tight">{t.onboarding.headerTitle}</h2>
      <p className="mt-1 max-w-xl text-[0.8125rem] leading-5 text-(--ui-text-tertiary)">{t.onboarding.headerDesc}</p>
    </div>
  )
}

export const FEATURED_ID = 'nous'
const SHOW_ALL_KEY = 'hermes-onboarding-show-all-v1'

// "返回登录" out of the BYOK escape hatch: forget the detour, then put the account
// gate — and with it the login screen — back in front of the window.
const leaveByokForLogin = () => {
  exitByokFromLogin()
  returnToManagedLogin()
}

const readShowAll = () => {
  try {
    return window.localStorage.getItem(SHOW_ALL_KEY) === '1'
  } catch {
    return false
  }
}

const persistShowAll = (value: boolean) => {
  try {
    window.localStorage.setItem(SHOW_ALL_KEY, value ? '1' : '0')
  } catch {
    // localStorage unavailable — degrade silently.
  }

  return value
}

export function Picker({ ctx }: { ctx: OnboardingContext }) {
  const { t } = useI18n()
  const { byokFromLogin, localEndpoint, manual, mode, providers } = useStore($desktopOnboarding)
  const [showAll, setShowAll] = useState(readShowAll)
  // Which key-form option to preselect when we flip to 'apikey' mode. The
  // OpenRouter row selects its key; the generic link lands on the first option.
  const [apiKeyInitialEnv, setApiKeyInitialEnv] = useState<string | undefined>(undefined)

  const openKeyForm = (envKey?: string) => {
    setApiKeyInitialEnv(envKey)
    setOnboardingMode('apikey')
  }

  const ordered = useMemo(() => (providers ? sortProviders(providers) : []), [providers])
  const hasOauth = ordered.length > 0
  const apiKeyOptions = useApiKeyCatalog()

  // localEndpoint forces the key form regardless of `mode` (which a manual
  // provider refresh may flip back to 'oauth'); it preselects the local option
  // and hides the "back to sign in" link since the user came specifically to
  // configure a custom endpoint.
  if (localEndpoint || mode === 'apikey' || !hasOauth) {
    return (
      <div className="grid gap-3">
        <ApiKeyForm
          // One back control per level, always pointing one step out: to the
          // OAuth list when there is one, otherwise straight to the login screen
          // the user came from. Never a dead end.
          canGoBack={(hasOauth || byokFromLogin === true) && !localEndpoint}
          initialEnvKey={localEndpoint ? 'OPENAI_BASE_URL' : apiKeyInitialEnv}
          onBack={() => (hasOauth ? setOnboardingMode('oauth') : leaveByokForLogin())}
          onSave={(envKey, value, name, apiKey) => saveOnboardingApiKey(envKey, value, name, ctx, apiKey)}
          options={apiKeyOptions}
        />
        {manual ? null : (
          <div className="flex justify-center pt-1">
            <ChooseLaterLink />
          </div>
        )}
      </div>
    )
  }

  if (providers === null) {
    return <Status>{t.onboarding.lookingUpProviders}</Status>
  }

  const select = (p: OAuthProvider) => void startProviderOAuth(p, ctx)
  const featured = ordered.find(p => p.id === FEATURED_ID) ?? null
  const rest = featured ? ordered.filter(p => p.id !== FEATURED_ID) : ordered
  // Collapse the secondary providers behind a disclosure whenever Nous Portal
  // is present to anchor the choice — otherwise show the full list. The
  // Fireworks/OpenRouter key rows always live behind the disclosure, so the
  // toggle is warranted even when there are no other OAuth providers.
  const collapsible = Boolean(featured)
  const showRest = !collapsible || showAll

  return (
    <div className="grid gap-2">
      {/* The picker is an escape hatch on a managed build, so it always keeps a
          door back to the login screen the user stepped out of. */}
      {byokFromLogin ? (
        <Button
          className="-mt-1 self-start font-medium"
          onClick={leaveByokForLogin}
          size="xs"
          type="button"
          variant="text"
        >
          <ChevronLeft className="size-3" />
          {t.onboarding.backToSignIn}
        </Button>
      ) : null}
      <div className="grid max-h-[60dvh] gap-2 overflow-y-auto p-1">
        {featured ? <FeaturedProviderRow onSelect={select} provider={featured} /> : null}
        {showRest ? (
          <>
            {/* Fireworks leads the expanded list, matching CANONICAL_PROVIDERS
                (Nous → Fireworks), but stays hidden until the user opens it. */}
            <FireworksProviderRow onClick={() => openKeyForm('FIREWORKS_API_KEY')} />
            {rest.map(p => (
              <ProviderRow key={p.id} onSelect={select} provider={p} />
            ))}
            <OpenRouterProviderRow onClick={() => openKeyForm('OPENROUTER_API_KEY')} />
          </>
        ) : null}
      </div>
      {collapsible ? (
        <Button
          className="mt-1 self-center font-medium"
          onClick={() => setShowAll(persistShowAll(!showAll))}
          size="xs"
          type="button"
          variant="text"
        >
          {showAll ? t.onboarding.collapse : t.onboarding.otherProviders}
          <ChevronDown className={cn('size-3.5 transition', showAll && 'rotate-180')} />
        </Button>
      ) : null}
      <div className="flex items-center justify-between gap-3 pt-1">
        {/* First run only: let the user defer the choice and land in the app.
            In manual mode the overlay already has a close affordance, so the
            "choose later" escape would be redundant — hide it. */}
        {manual ? <span /> : <ChooseLaterLink />}
        <Button className="-mr-2 font-medium" onClick={() => openKeyForm()} size="xs" type="button" variant="text">
          {t.onboarding.haveApiKey}
        </Button>
      </div>
    </div>
  )
}

// "I'll choose a provider later" — dismisses the first-run picker and persists
// the skip so it never re-nags. The user connects a provider any time from
// Settings → Providers. Rendered only on the unconfigured first-run flow.
function ChooseLaterLink() {
  const { t } = useI18n()

  return (
    <Button className="font-medium" onClick={() => dismissFirstRunOnboarding()} size="xs" type="button" variant="text">
      {t.onboarding.chooseLater}
    </Button>
  )
}

// First-run managed-LLM panel (zero-key): the user signs in once with their
// ApexNodes account and the local runtime is wired to the hosted relay — no API
// key to paste. Escape hatches to BYOK ("use my own provider") and to "choose
// later" so it never traps a user who has their own key or wants to defer.
function ManagedSignInPanel({ ctx }: { ctx: OnboardingContext }) {
  const { t } = useI18n()
  const m = t.onboarding.managed
  const { managedError, managedSubmitting } = useStore($desktopOnboarding)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const canSubmit = email.trim().length > 0 && password.length > 0 && !managedSubmitting

  const submit = () => {
    if (!canSubmit) {
      return
    }

    void managedSignIn(email, password, ctx)
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{m.subtitle}</p>
      <Input
        autoComplete="email"
        autoFocus
        onChange={event => setEmail(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            submit()
          }
        }}
        placeholder={m.emailPlaceholder}
        type="email"
        value={email}
      />
      <Input
        autoComplete="current-password"
        onChange={event => setPassword(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            submit()
          }
        }}
        placeholder={m.passwordPlaceholder}
        type="password"
        value={password}
      />
      {managedError ? <div className="text-xs text-destructive">{managedError}</div> : null}
      <Button className="w-full" disabled={!canSubmit} onClick={submit} type="button">
        {managedSubmitting && <Loader2 className="size-3.5 animate-spin" />}
        {managedSubmitting ? m.signingIn : m.signIn}
      </Button>

      {/* Divider, then the two browser (loopback) sign-in options. The
          email/password form above stays — these are additional one-tap paths. */}
      <div className="flex items-center gap-3 py-0.5 text-[0.6875rem] uppercase tracking-wider text-(--ui-text-tertiary)">
        <span className="h-px flex-1 bg-(--ui-stroke-tertiary)" />
        {m.dividerOr}
        <span className="h-px flex-1 bg-(--ui-stroke-tertiary)" />
      </div>
      <div className="grid gap-2">
        <Button
          className="w-full"
          disabled={managedSubmitting}
          onClick={() => void managedBrowserSignIn('google', ctx)}
          type="button"
          variant="outline"
        >
          {m.signInGoogle}
        </Button>
        <Button
          className="w-full"
          disabled={managedSubmitting}
          onClick={() => void managedBrowserSignIn('apex', ctx)}
          type="button"
          variant="outline"
        >
          {m.signInApex}
        </Button>
      </div>

      <div className="flex items-center justify-between border-t border-(--ui-stroke-tertiary) pt-3">
        <Button className="font-medium" onClick={() => skipManagedForByok()} size="xs" type="button" variant="text">
          {m.useOwnProvider}
        </Button>
        <ChooseLaterLink />
      </div>
    </div>
  )
}

// Presentational two-column key picker. Onboarding feeds it its curated
// options + a ctx-bound save; the Providers settings page feeds it the full
// provider catalog + a setEnvVar-backed save (plus `isSet`/`onClear` so it can
// double as a manage surface). Keep it free of store/ctx coupling so both
// surfaces render the identical form.
export function ApiKeyForm({
  canGoBack,
  initialEnvKey,
  isSet,
  onBack,
  onClear,
  onSave,
  options = API_KEY_OPTIONS,
  redactedValue
}: {
  canGoBack: boolean
  /** Preselect a specific option by env key (e.g. 'OPENAI_BASE_URL' to land on
   *  the local / custom endpoint form). Falls back to the first option. */
  initialEnvKey?: string
  isSet?: (envKey: string) => boolean
  onBack: () => void
  onClear?: (envKey: string) => void
  onSave: (envKey: string, value: string, name: string, apiKey?: string) => Promise<{ message?: string; ok: boolean }>
  options?: ApiKeyOption[]
  redactedValue?: (envKey: string) => null | string | undefined
}) {
  const { t } = useI18n()

  const [option, setOption] = useState<ApiKeyOption>(() => options.find(o => o.envKey === initialEnvKey) ?? options[0])

  const [value, setValue] = useState('')
  // Optional endpoint API key, only used by the local / custom endpoint option
  // (whose `value` is the base URL). Cleared whenever the option changes.
  const [localKey, setLocalKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)
  // `options` can change at runtime when callers filter the catalog (e.g. the
  // Providers page wiring its search into this grid). Keep the selection valid
  // by snapping back to the first remaining option when the current one drops.
  useEffect(() => {
    if (options.length > 0 && !options.some(o => o.envKey === option.envKey)) {
      setOption(options[0])
      setValue('')
      setLocalKey('')
      setError(null)
    }
  }, [option.envKey, options])
  // The catalog grid can be tall, leaving the entry field far below the fold.
  // On selection we scroll the field into view and focus it so it's always
  // obvious where to paste next.
  const entryRef = useRef<HTMLDivElement>(null)

  const pick = (o: ApiKeyOption) => {
    setOption(o)
    setValue('')
    setLocalKey('')
    setError(null)
    requestAnimationFrame(() => {
      entryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      entryRef.current?.querySelector('input')?.focus()
    })
  }

  const isLocal = option.envKey === 'OPENAI_BASE_URL'
  const alreadySet = isSet?.(option.envKey) ?? false
  // When set, surface the backend's redacted value (e.g. "sk-12…wxyz") as the
  // placeholder so users can eyeball that the right key is in place.
  const currentRedacted = alreadySet ? (redactedValue?.(option.envKey) ?? null) : null
  // Only require a non-empty value — no length/format validation, so a short
  // or unusual key can't block the user from continuing.
  const canSave = value.trim().length >= 1
  const optionCopy = t.onboarding.apiKeyOptions[option.id]
  const optionDescription = optionCopy?.description ?? option.description

  const submit = async () => {
    if (!canSave || saving) {
      return
    }

    setSaving(true)
    setError(null)
    const result = await onSave(option.envKey, value, option.name, isLocal ? localKey : undefined)

    if (result.ok) {
      setValue('')
      setLocalKey('')
    } else {
      setError(result.message ?? t.onboarding.couldNotSave)
    }

    setSaving(false)
  }

  return (
    <div className="grid gap-4">
      {canGoBack ? (
        <Button className="-mt-1 self-start font-medium" onClick={onBack} size="xs" type="button" variant="text">
          <ChevronLeft className="size-3" />
          {t.onboarding.backToSignIn}
        </Button>
      ) : null}

      <div className="grid max-h-[42dvh] gap-2 overflow-y-auto p-1 sm:grid-cols-2">
        {options.map(o => (
          <button
            className={cn(
              'rounded-2xl border bg-background/60 p-3 text-left transition hover:bg-accent/50',
              option.envKey === o.envKey ? 'border-primary ring-2 ring-primary/20' : 'border-transparent'
            )}
            key={o.envKey}
            onClick={() => pick(o)}
            type="button"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{o.name}</span>
              {isSet?.(o.envKey) ? <Check className="size-3.5 text-muted-foreground" /> : null}
            </div>
            {(t.onboarding.apiKeyOptions[o.id]?.short ?? o.short) ? (
              <p className="mt-1 text-xs text-muted-foreground">{t.onboarding.apiKeyOptions[o.id]?.short ?? o.short}</p>
            ) : null}
          </button>
        ))}
      </div>

      <div className="grid scroll-mt-4 gap-2" ref={entryRef}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm leading-6 text-muted-foreground">{optionDescription}</p>
          {option.docsUrl ? <DocsLink href={option.docsUrl}>{t.onboarding.getKey}</DocsLink> : null}
        </div>
        <Input
          autoComplete="off"
          autoFocus
          className="font-mono"
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && void submit()}
          placeholder={
            currentRedacted ??
            (alreadySet ? t.onboarding.replaceCurrent : option.placeholder || t.onboarding.pasteApiKey)
          }
          type={isLocal ? 'text' : 'password'}
          value={value}
        />
        {isLocal ? (
          <Input
            autoComplete="off"
            className="font-mono"
            onChange={e => setLocalKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && void submit()}
            placeholder={t.onboarding.localApiKeyPlaceholder}
            type="password"
            value={localKey}
          />
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          {alreadySet && onClear ? (
            <Button onClick={() => onClear(option.envKey)} size="sm" variant="ghost">
              {t.common.remove}
            </Button>
          ) : null}
        </div>
        <Button disabled={!canSave || saving} onClick={() => void submit()}>
          {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {saving ? t.onboarding.connecting : alreadySet ? t.onboarding.update : t.common.connect}
        </Button>
      </div>
    </div>
  )
}
