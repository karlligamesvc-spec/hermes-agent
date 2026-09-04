import type { GatewayWsUrlResult } from '@hermes/shared'
import type { TranslucencyState } from '@hermes/shared/translucency'

import type { WakeIndicatorState } from './lib/wake-indicator'
import type {
  PetOverlayBounds,
  PetOverlayControl,
  PetOverlayOpenRequest,
  PetOverlayStatePayload
} from './store/pet-overlay'
import type { QuickEntryStatePush, QuickEntryStatus, QuickEntrySubmitPayload } from './store/quick-entry'

export {}

declare global {
  interface Window {
    hermesDesktop: {
      // Resolve a backend connection. Omit `profile` (or pass the primary) for
      // the window's backend; pass a named profile to lazily spawn/reuse that
      // profile's backend from the pool.
      getConnection: (profile?: string | null) => Promise<HermesConnection>
      // Registry-scoped backend resolution: dial (connectionId, profile). An
      // empty/local connectionId delegates to the legacy getConnection path.
      getConnectionFor?: (payload: {
        connectionId?: null | string
        profile?: null | string
      }) => Promise<HermesConnection>
      // Registry-scoped fresh WS URL (same result contract as getGatewayWsUrl).
      getGatewayWsUrlFor?: (payload: {
        connectionId?: null | string
        profile?: null | string
      }) => Promise<GatewayWsUrlResult>
      // Union agent roster across every registered connection.
      getAgentRoster?: () => Promise<DesktopAgentRoster>
      // Credential-free routes across the union connection registry. The
      // optional profile list is used only by the single-local v1 fallback;
      // endpoint and auth material never crosses the IPC boundary.
      getProfileRoutes: (profiles: string[]) => Promise<DesktopPluginProfileRoute[]>
      // Reconnect-after-wake recovery: liveness-probe the cached PRIMARY backend
      // and drop it if a remote one has gone unreachable, so the next
      // getConnection() rebuilds a reachable descriptor instead of the renderer
      // re-dialing a dead remote forever. No-op for local backends (they
      // self-heal via the child 'exit' handler). `rebuilt` is true when a stale
      // remote cache was dropped.
      revalidateConnection: () => Promise<{ ok: boolean; rebuilt: boolean }>
      // Keepalive: mark a pool profile backend as recently used so the idle
      // reaper spares it while its chat is active.
      touchBackend: (profile?: string | null) => Promise<{ ok: boolean }>
      getGatewayWsUrl: (profile?: null | string) => Promise<GatewayWsUrlResult>
      // Open (or focus) a standalone OS window for a single chat session so
      // the user can work with multiple chats side by side. Returns ok:false
      // with an error code when the sessionId is empty/invalid. `watch` opens
      // a spectator window (lazy resume — no agent build) for live-streaming
      // a running subagent's session.
      openSessionWindow: (sessionId: string, opts?: { watch?: boolean }) => Promise<{ ok: boolean; error?: string }>
      // Resume this session in the user's own terminal emulator (`hermes --tui
      // --resume <id>`) — the external terminal, not the in-app pane.
      openSessionInTerminal: (
        sessionId: string,
        opts?: { cwd?: string; profile?: string }
      ) => Promise<{ ok: boolean; error?: string }>
      // Open a new full-chrome app window — a peer instance of the primary that
      // renders the complete app against the shared backend, so the user can run
      // multiple GUI windows at once.
      openWindow: () => Promise<{ ok: boolean; error?: string }>
      // Pop the in-app Browser (webview + address bar) into its own OS window.
      // `tabId` is the `$previewTabs` id; closing the window fires
      // `onBrowserPopoutClosed` so the caller can dock the tab again.
      openBrowserWindow: (tabId: string) => Promise<{ ok: boolean; error?: string }>
      onBrowserPopoutClosed: (callback: (tabId: string) => void) => () => void
      // Claim a one-shot cross-window ambient cue (turn-end sound / spoken
      // reply). Resolves true for the first window to claim a key, false for
      // peers — so N open windows don't all fire the same cue.
      claimAmbientCue: (key: string) => Promise<boolean>
      wakeIndicator?: {
        getState: () => Promise<WakeIndicatorState>
        setState: (state: WakeIndicatorState) => void
        onState: (callback: (state: WakeIndicatorState) => void) => () => void
      }
      // The pop-out pet overlay: a transparent always-on-top window hosting only
      // the mascot. The main renderer drives it (open/close/drag + state push);
      // the overlay sends control messages back (pop-in, composer submit).
      petOverlay: {
        open: (request: PetOverlayOpenRequest) => Promise<{ ok: boolean; bounds?: PetOverlayBounds }>
        close: () => Promise<{ ok: boolean }>
        setBounds: (bounds: PetOverlayBounds) => void
        setIgnoreMouse: (ignore: boolean) => void
        setFocusable: (focusable: boolean) => void
        pushState: (payload: PetOverlayStatePayload) => void
        control: (payload: PetOverlayControl) => void
        onState: (callback: (payload: PetOverlayStatePayload) => void) => () => void
        onControl: (callback: (payload: PetOverlayControl) => void) => () => void
      }
      // HUD mode: the chrome-free floating chat. A FULL app renderer with its
      // own gateway (like an instance window), sized and skinned as a floating
      // bar — so it mounts the real composer rather than a lookalike. Main
      // owns the window; `onChanged` keeps every window's toggle truthful.
      hud?: {
        nativeDrag: boolean
        windowing?: {
          clientPlacement: boolean
          controlDrag: boolean
          nativeDrag: boolean
          solid: boolean
          workspaceTransfer: boolean
        }
        open: (request?: { sessionId?: null | string; profile?: null | string }) => Promise<{ ok: boolean }>
        close: () => Promise<{ ok: boolean }>
        setIgnoreMouse: (ignore: boolean) => void
        beginMove: () => void
        endMove: () => void
        moveBy: (delta: { width: number; height: number }) => void
        setWorkspaceTransfer?: (transferring: boolean) => void
        setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
        resetLayout: () => Promise<{ ok: boolean }>
        setFrost: (showing: boolean) => Promise<{ ok: boolean }>
        setSession: (sessionId: null | string) => void
        onGoto: (callback: (sessionId: string) => void) => () => void
        onChanged: (callback: (state: { open: boolean; sessionId: null | string }) => void) => () => void
        onCursor: (callback: (point: { x: number; y: number } | null) => void) => () => void
        onGameOverlay: (callback: (state: { active: boolean; app: string }) => void) => () => void
      }
      // Quick Entry: a global-hotkey mini composer window. Main owns the OS
      // shortcut registration + the persisted preference (it must restore the
      // shortcut on a cold launch without the renderer visiting Settings), so
      // the renderer reads/writes it here and adopts the authoritative reply.
      quickEntry: {
        getSettings: () => Promise<QuickEntryStatus>
        // Returns the resulting state — including `registered: false` +
        // `error: 'taken'` when another app already owns the chord, so a failed
        // registration surfaces in Settings instead of failing silently.
        setSettings: (patch: { enabled?: boolean; shortcut?: string }) => Promise<QuickEntryStatus>
        // Quick window → main: send this payload (main forwards it to the
        // primary renderer, which routes it to the target session and submits
        // through the normal prompt path) and hide.
        submit: (payload: QuickEntrySubmitPayload) => void
        // Quick window → main: hide without sending (Escape / blur).
        dismiss: () => void
        // Primary renderer → main → quick window: gateway connection state +
        // the recent-session options. Main caches the latest push and replays
        // it to a quick window spawned later.
        pushState: (payload: QuickEntryStatePush) => void
        // Quick window subscribes to those pushes.
        onState: (callback: (payload: QuickEntryStatePush) => void) => () => void
        // Primary renderer subscribes to submits captured by the quick window.
        onSubmit: (callback: (payload: QuickEntrySubmitPayload | string) => void) => () => void
        // Quick window subscribes to "you were just summoned" so it can reset
        // its draft and re-focus the input on every open.
        onShown: (callback: () => void) => () => void
      }
      getBootProgress: () => Promise<DesktopBootProgress>
      getConnectionConfig: (profile?: null | string) => Promise<DesktopConnectionConfig>
      saveConnectionConfig: (payload: DesktopConnectionConfigInput) => Promise<DesktopConnectionConfig>
      applyConnectionConfig: (payload: DesktopConnectionConfigInput) => Promise<DesktopConnectionConfig>
      testConnectionConfig: (payload: DesktopConnectionConfigInput) => Promise<DesktopConnectionTestResult>
      // Opt-in OS-keychain encryption for stored gateway secrets (default
      // off). `get` never touches the OS keychain; `set` re-encodes stored
      // secrets and can throw when the keychain is unusable.
      getSecretStorageEncryption: () => Promise<{ on: boolean }>
      setSecretStorageEncryption: (on: boolean) => Promise<{ on: boolean }>
      // v2 multi-connection registry: named agent sources, all persisted
      // together (local + any number of remote/cloud/ssh instances).
      connections: {
        list: () => Promise<DesktopConnectionsRegistry>
        save: (
          payload: DesktopRegistryConnectionInput
        ) => Promise<{ ok: boolean; connection: DesktopRegistryConnection; registry: DesktopConnectionsRegistry }>
        remove: (id: string) => Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }>
        setPrimary: (id: string) => Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }>
        setLaunchMode?: (
          mode: 'last-used' | 'primary'
        ) => Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }>
        setLastUsed?: (id: string) => Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }>
        test: (id: string) => Promise<DesktopConnectionTestResult>
        // Drain/update/restore one Desktop-managed SSH install. External URL
        // and cloud sources are refused without touching their processes.
        updateManaged?: (id: string) => Promise<DesktopManagedConnectionUpdateResult>
        // Fan out `hermes update` to every eligible registered connection;
        // cloud entries are skipped (platform-managed), each row independent.
        // excludeIds skips connections the caller updates through another
        // path (the everything-update flow's active backend + local client).
        updateAll?: (options?: {
          excludeIds?: string[]
        }) => Promise<{ ok: boolean; results: DesktopConnectionUpdateResult[] }>
        // Registry lifecycle push: fired when a connection is removed or
        // materially edited so the renderer can dispose (and re-dial) the
        // secondary gateways scoped to it. Optional: older Electron mains
        // don't emit it.
        onChanged?: (
          callback: (payload: { connectionId: string; reason: 'removed' | 'saved' | 'updated' }) => void
        ) => () => void
      }
      sshConfigHosts: () => Promise<DesktopSshHostsResult>
      sshResolveHost: (host: string) => Promise<DesktopSshResolveResult>
      probeConnectionConfig: (remoteUrl: string) => Promise<DesktopConnectionProbeResult>
      oauthLoginConnectionConfig: (remoteUrl: string) => Promise<DesktopOauthLoginResult>
      oauthLogoutConnectionConfig: (remoteUrl: string) => Promise<DesktopOauthLogoutResult>
      // Hermes Cloud: one portal login powers discovery + silent per-agent
      // sign-in (cloud-auto-discovery Phase 3).
      cloud: {
        status: () => Promise<DesktopCloudStatus>
        login: () => Promise<DesktopCloudStatus & { ok: boolean }>
        logout: () => Promise<DesktopCloudStatus & { ok: boolean }>
        discover: (org?: string) => Promise<DesktopCloudDiscoverResult>
        agentSignIn: (dashboardUrl: string) => Promise<DesktopCloudAgentSignInResult>
      }
      profile: {
        get: () => Promise<DesktopActiveProfile>
        // Persists the profile used on the next Desktop launch without
        // interrupting the live gateway workspace switch.
        remember: (name: string | null) => Promise<DesktopActiveProfile>
        // Persists the desktop's profile choice and relaunches the local
        // backend under the new HERMES_HOME (reloads the window). Pass null to
        // clear the preference.
        set: (name: string | null) => Promise<DesktopActiveProfile>
      }
      // ApexNodes managed-LLM (zero-key) default path. Routes the local
      // runtime's inference through the ApexNodes relay using the signed-in
      // user's cloud account. See electron/apex-managed.cjs.
      managed: {
        status: () => Promise<DesktopManagedStatus>
        // hc-512: live relay model-catalog state for the model menu. Optional:
        // an older main process may not expose it yet. `refresh: true`
        // re-probes now (menu open / user retry); a 401 kicks the key
        // self-heal chain before reporting.
        relayCatalog?: (opts?: { refresh?: boolean }) => Promise<DesktopRelayCatalogState>
        signIn: (payload: { email: string; password: string }) => Promise<DesktopManagedSignInResult>
        // Browser (loopback) sign-in: "用 Google 登录" / "用 APEX 登录". Opens
        // the system browser, catches the loopback redirect, and resolves with
        // the same managed assignment shape the email/password flow returns.
        browserSignIn: (payload: { provider: 'apex' | 'google' }) => Promise<DesktopManagedSignInResult>
        // hc-530: web handoff sign-in. Exchange the one-time code delivered via the
        // apexnodes://login deep link for the same managed assignment shape.
        // Optional: an older main process may not expose it.
        deepLinkSignIn?: (payload: { code: string }) => Promise<DesktopManagedSignInResult>
        signOut: () => Promise<{ ok: boolean }>
        // On-demand relay-key self-heal after a chat turn hit a relay auth error
        // (HTTP 401/403). Optional: an older main process may not expose it.
        selfHeal?: () => Promise<DesktopManagedSelfHealResult>
      }
      // hc-795: authenticated workflow business-domain bridge. The main
      // process owns the reusable platform JWT; only typed domain data crosses
      // into the renderer. Optional for compatibility with older shells.
      workflowDomain?: {
        access: () => Promise<DesktopWorkflowDomainAccess>
        startGoal: (payload: DesktopWorkflowDomainStartGoalInput) => Promise<DesktopWorkflowDomainStartResult>
        listProjects?: (options?: {
          cursor?: string
          limit?: number
          status?: string
        }) => Promise<DesktopWorkflowDomainProjectListResult>
        listWorkflows?: (options?: {
          cursor?: string
          limit?: number
          projectId?: string
          status?: string
        }) => Promise<DesktopWorkflowDomainWorkflowListResult>
        getCatalog?: () => Promise<DesktopWorkflowDomainCatalogResult>
        getRun: (runId: string) => Promise<DesktopWorkflowDomainRunResult>
        cancelRun: (runId: string) => Promise<DesktopWorkflowDomainMutationResult>
        reviewDeliverable: (payload: {
          deliverableId: string
          status: 'approved' | 'changes_requested'
        }) => Promise<DesktopWorkflowDomainMutationResult>
      }
      // hc-444: desktop ↔ cloud Feishu bridge. Mirrors the signed-in user's OWN
      // Feishu app credential (from the cloud agent_entries) down to the local
      // runtime so the Feishu adapter + lark doc/drive tools light up. No secret
      // ever crosses to the renderer. Optional: an older main process may not
      // expose the bridge yet. See electron/apex-feishu.cjs.
      feishu?: {
        // Read-only local state for the settings card (no network, no secret).
        status: () => Promise<DesktopFeishuStatus>
        // Fetch the cloud credential (authed with the stored login JWT), persist
        // it encrypted, and re-home the backend so the adapter comes alive.
        sync: () => Promise<DesktopFeishuSyncResult>
        // Forget the local credential (cloud entry untouched) + restart backend.
        disconnect: () => Promise<{ ok: boolean }>
        // Open the cloud web binding flow in the system browser (unbound users).
        openBind: () => Promise<{ ok: boolean; url: string }>
      }
      // hc-447: 更新日志 (changelog) entry point. Reads the hc-446 announcement
      // feed (same "you can now…" copy the web /app/whats-new page shows) with
      // the stored login JWT — no secret crosses to the renderer. Optional: an
      // older main process may not expose the bridge yet. See
      // electron/apex-announcements.cjs.
      announcements?: {
        list: () => Promise<DesktopAnnouncementsListResult>
        // Best-effort read receipt; the renderer does not gate its UI on this.
        markRead: (announcementId: string) => Promise<{ ok: boolean }>
      }
      // hc-417: Desktop IM 入口 — connect the local agent to an IM platform by
      // scanning a QR / pasting one code. feishu issues an INDEPENDENT app via a
      // cloud device-code flow (renderer owns the polling loop). No secret ever
      // crosses to the renderer. Optional: an older main process may not expose
      // the bridge yet. See electron/apex-im-entry.cjs.
      imEntry?: {
        // Local bound channels (display fields only, no network, no secret).
        list: () => Promise<DesktopImEntryListResult>
        // Start the feishu provisioning flow → scan link + provision_id handle.
        feishuIssue: () => Promise<DesktopImEntryIssueResult>
        // One provisioning status check; on 'success' main fetches + persists
        // the credential (encrypted) + restarts the backend (reloads the window).
        feishuPoll: (provisionId: string) => Promise<DesktopImEntryPollResult>
        // hc-538 WeChat (iLink) — same contract as feishuIssue/feishuPoll
        // against the /desktop/weixin/* cloud leg.
        weixinIssue: () => Promise<DesktopImEntryIssueResult>
        weixinPoll: (provisionId: string) => Promise<DesktopImEntryPollResult>
        // Revoke the cloud binding (feishu/weixin, best-effort), forget the
        // local binding + restart the backend.
        unbind: (channelId: string) => Promise<{ ok: boolean }>
      }
      // hc-533 本机 Agent 调度 — the A2A daemon leg. Toggles the reverse-connect
      // daemon (default off) that lets the user's cloud assistant dispatch a task
      // to a local coding agent on this machine. No secret ever crosses to the
      // renderer: status carries only display fields; the device token is stored
      // encrypted in main. Optional: an older main process may not expose it.
      // See electron/apex-daemon.cjs.
      daemon?: {
        // Read-only status for the settings block (no network, no secret).
        status: () => Promise<DesktopDaemonStatus>
        // The on/off toggle. Enabling registers + starts the loops; disabling
        // goes dormant but keeps the registration for an instant re-enable.
        setEnabled: (enabled: boolean) => Promise<DesktopDaemonMutationResult>
        // Rename this device (re-registers to update the cloud row when live).
        setDeviceName: (name: string) => Promise<DesktopDaemonMutationResult>
        // Forget this device locally + go dormant (cloud row goes offline on its
        // own once heartbeats stop).
        unregister: () => Promise<DesktopDaemonMutationResult>
        // Subscribe to live status pushed on connection transitions.
        onStatus: (callback: (status: DesktopDaemonStatus) => void) => () => void
      }
      // hc-545 coding-agent account connection — three-state detection + in-app
      // OAuth hosting for the user's own claude/codex CLIs. No secret crosses to
      // the renderer. Optional: an older main process may not expose it.
      agentAuth?: {
        // Detect logged_out / unreachable / ready for both families (headless).
        status: () => Promise<DesktopAgentAuthStatus>
        // Host the CLI's own OAuth login (opens the browser / degrades to a
        // guided terminal command). The renderer then polls status().
        connect: (family: DesktopAgentFamily) => Promise<DesktopAgentConnectResult>
      }
      // hc-545 coding-agent network proxy — auto (follow system) / custom / off.
      agentProxy?: {
        get: () => Promise<DesktopAgentProxyState>
        set: (payload: { mode: DesktopAgentProxyMode; customUrl?: string }) => Promise<DesktopAgentProxyState>
      }
      // Platform client-config sync — the cloud serves a versioned client
      // config the main process caches at boot / after sign-in and applies to
      // config.yaml pre-gateway (main.cjs applyClientConfigToRuntime). `get`
      // reads the cached state from disk (no network), informational only.
      // Optional: an older main process may not expose the bridge yet.
      clientConfig?: {
        get: () => Promise<DesktopClientConfigState>
      }
      // Continuous auth gate: fires when a backend call returns 401 (login lost)
      // or 403 account_disabled (account abnormal). The renderer clears auth and
      // returns to the login screen. See electron/main.cjs broadcastAuthGate.
      onAuthGate?: (callback: (payload: DesktopAuthGateEvent) => void) => () => void
      // Runtime 3-end consistency — desktop opt-in engine update (R5/R6).
      // checkUpdate compares the installed engine (bootstrap marker) against the
      // admin-set default; applyUpdate re-points the pin and re-runs bootstrap
      // (renderer reloads when reloadRequired is true). Both are safe no-ops
      // offline. Backed by electron/apex-runtime-latest.cjs (do not change the
      // mechanism here — this is the IPC surface only). See main.cjs handlers
      // hermes:runtime:check-update / hermes:runtime:apply-update.
      runtime: {
        // R6: installed engine version, read locally from the bootstrap marker
        // (no network, no state change). Used to show the engine version on
        // About-panel open without triggering an opt-in update check.
        getVersion: () => Promise<DesktopRuntimeVersion>
        checkUpdate: () => Promise<DesktopRuntimeUpdateCheck>
        applyUpdate: () => Promise<DesktopRuntimeUpdateApply>
        onUpdateProgress: (callback: (progress: DesktopRuntimeUpdateProgress) => void) => () => void
      }
      // 壳(Electron 应用本体)自更新 — electron-updater 通道,和 runtime(引擎)
      // 更新互不相扰。机制全在主进程(electron/shell-updater.cjs):启动延迟
      // 静默检查 + autoDownload;renderer 只订状态、在 downloaded 时出
      // 「重启以更新」胶囊,install 触发 quitAndInstall。Optional:旧壳的主
      // 进程没有这个桥。
      shellUpdate?: {
        getState: () => Promise<DesktopShellUpdateState>
        check: () => Promise<{ ok: boolean; error?: string; state: DesktopShellUpdateState }>
        install: () => Promise<{ ok: boolean; error?: string }>
        onEvent: (callback: (state: DesktopShellUpdateState) => void) => () => void
      }
      updateCenter?: {
        getPlan: () => Promise<DesktopUpdatePlan | null>
        setRuntimeAfterShell: (payload: {
          currentRuntimeKey?: string | null
          currentRuntimeVersion?: string | null
          targetRuntimeKey?: string | null
          targetShellVersion: string | null
          targetRuntimeVersion: string | null
        }) => Promise<{ ok: boolean; error?: string; plan?: DesktopUpdatePlan }>
        setShellOnly: (payload: {
          currentRuntimeKey?: string | null
          currentRuntimeVersion?: string | null
          targetRuntimeKey?: string | null
          targetShellVersion: string | null
          targetRuntimeVersion?: string | null
        }) => Promise<{ ok: boolean; error?: string; plan?: DesktopUpdatePlan }>
        transitionPlan: (payload: {
          phase: DesktopUpdatePlanPhase
          lastError?: string | null
          incrementAttempt?: boolean
        }) => Promise<{ ok: boolean; error?: string; plan?: DesktopUpdatePlan }>
        clearPlan: () => Promise<{ ok: boolean }>
      }
      api: <T>(request: HermesApiRequest) => Promise<T>
      notify: (payload: HermesNotification) => Promise<boolean>
      requestMicrophoneAccess: () => Promise<boolean>
      /** read_window_below tool: metadata for the OS window directly underneath this one (never pixels). */
      readWindowBelow?: () => Promise<{
        frontmost: { app: string; title: string } | null
        note?: string
        platform: string
        window: {
          app: string
          bounds: { height: number; width: number; x: number; y: number }
          id: number
          title: string
        } | null
      } | null>
      readFileDataUrl: (filePath: string) => Promise<string>
      /** Remote non-image attach: higher dedicated cap than preview/Settings default. */
      readFileDataUrlForAttach?: (filePath: string) => Promise<string>
      /** Settings → Chat: max size for local files loaded as data URLs (attach/preview). */
      dataUrlReadMax?: {
        get: () => Promise<{ defaultMaxMb: number; maxBytes: number; maxMb: number }>
        set: (maxMb: number) => Promise<{ defaultMaxMb: number; maxBytes: number; maxMb: number }>
      }
      readFileText: (filePath: string) => Promise<HermesReadFileTextResult>
      /** Full-source read for runtime desktop plugins (readFileText truncates
       *  at the 512 KiB preview cap). Absent on older shells — callers fall
       *  back to readFileText and must reject a `truncated` result. */
      readPluginSource?: (filePath: string) => Promise<HermesReadFileTextResult>
      selectPaths: (options?: HermesSelectPathsOptions) => Promise<string[]>
      /** Native save dialog; returns the chosen path or null on cancel. */
      selectSavePath?: (options?: {
        defaultPath?: string
        filters?: Array<{ extensions: string[]; name: string }>
        title?: string
      }) => Promise<null | string>
      writeClipboard: (text: string) => Promise<boolean>
      readClipboard: () => Promise<string>
      saveGatewayFile?: (payload: {
        connectionId?: null | string
        path: string
        profile?: null | string
        suggestedName?: string
      }) => Promise<{
        canceled?: boolean
        path?: string
        saved: boolean
      }>
      saveImageFromUrl: (url: string) => Promise<boolean>
      /** Edit verb against the window's focused element (the custom context
       *  menu's Cut/Copy/Paste/Select all). */
      contextMenuEdit?: (command: 'copy' | 'cut' | 'paste' | 'selectAll') => Promise<void>
      /** Copy the image under the LAST context-menu gesture (Chromium tracks
       *  its coordinates on the main-process context-menu event). */
      contextMenuCopyImage?: () => Promise<void>
      /** Replace the misspelled word or add it to the dictionary. */
      contextMenuSpellcheck?: (action: { kind: 'add' | 'replace'; word: string }) => Promise<void>
      /** Add a word to the spell-check dictionary of a webview guest's
       *  session (the tag exposes no session API). */
      contextMenuGuestAddWord?: (payload: { webContentsId: number; word: string }) => Promise<void>
      /** Spell-check facts for the gesture that opened the current menu;
       *  fires shortly after the DOM contextmenu event. */
      onContextMenuSpellcheck?: (
        callback: (payload: { misspelledWord: string; suggestions: string[] }) => void
      ) => () => void
      saveImageBuffer: (data: ArrayBuffer | Uint8Array, ext: string) => Promise<string>
      saveClipboardImage: () => Promise<string>
      getPathForFile: (file: File) => string
      normalizePreviewTarget: (target: string, baseDir?: string) => Promise<HermesPreviewTarget | null>
      watchPreviewFile: (url: string) => Promise<HermesPreviewWatch>
      /** Watch a directory for entry churn (disk-plugin door); same watcher
       *  registry + onPreviewFileChanged channel as watchPreviewFile. Optional:
       *  older Electron shells predate it and fall back to the readdir poll. */
      watchDirectory?: (dir: string) => Promise<HermesPreviewWatch>
      stopPreviewFileWatch: (id: string) => Promise<boolean>
      setActiveWork?: (payload: HermesActiveWork) => void
      setTitleBarTheme?: (payload: HermesTitleBarTheme) => void
      setNativeTheme?: (mode: 'dark' | 'light' | 'system') => void
      /** Main-process fact: this OS can back glass with a native material. */
      glassSupported?: boolean
      /** Main-process fact: this OS can do any translucency at all (not Linux). */
      translucencySupported?: boolean
      setTranslucency?: (payload: TranslucencyState) => void
      setKeepAwake?: (on: boolean) => void
      setDisableF12?: (blocked: boolean) => void
      setPreviewShortcutActive?: (active: boolean) => void
      openExternal: (url: string) => Promise<void>
      /** One-shot loopback callback listener for MCP OAuth against remote
       *  backends (electron/mcp-oauth-callback-ipc.ts): bind on THIS machine,
       *  pass redirectUri as client_redirect_uri to mcp.servers.oauth.start,
       *  await the provider redirect, relay code/state via oauth.callback. */
      mcpOauth?: {
        listen: () => Promise<{ id: string; redirectUri: string }>
        wait: (
          id: string,
          timeoutMs?: number
        ) => Promise<{ code: null | string; error: null | string; state: null | string }>
        cancel: (id: string) => Promise<boolean>
      }
      openPreviewInBrowser?: (url: string) => Promise<void>
      fetchLinkTitle: (url: string) => Promise<string>
      /** A site's icon as a data URL, or '' when it has none we can read.
       *  Resolved and cached in the main process (electron/favicon.ts). */
      resolveFavicon?: (url: string) => Promise<string>
      sanitizeWorkspaceCwd: (cwd?: null | string) => Promise<{ cwd: string; sanitized: boolean }>
      // hc-517 — create a new empty project folder <parentDir>/<name> to bind as
      // a fresh session's cwd (the picker's "New blank project"). Validates the
      // name to a single, traversal-free segment and never clobbers an existing
      // entry. Optional: an older main process may not expose it.
      createProjectDir?: (parentDir: string, name: string) => Promise<HermesCreateProjectResult>
      settings: {
        getDefaultProjectDir: () => Promise<{ defaultLabel: string; dir: null | string; resolvedCwd: string }>
        pickDefaultProjectDir: () => Promise<{ canceled: boolean; dir: null | string }>
        setDefaultProjectDir: (dir: null | string) => Promise<{ dir: null | string }>
      }
      zoom?: {
        get: () => Promise<{ level: number; percent: number }>
        /** Synchronous zoom factor of this window (1 = 100%). */
        factor?: () => number
        setPercent: (percent: number) => void
        onChanged: (callback: (payload: { level: number; percent: number }) => void) => () => void
      }
      revealLogs: () => Promise<{ ok: boolean; path: string; error?: string }>
      getRecentLogs: () => Promise<{ path: string; lines: string[] }>
      /** Persist a renderer error-boundary catch to desktop.log (fire-and-forget). */
      reportRendererError?: (report: {
        label: string
        boundary: string
        message: string
        componentStack: string
      }) => void
      readDir: (path: string) => Promise<HermesReadDirResult>
      gitRoot?: (path: string) => Promise<string | null>
      // Resolve git-worktree identity for a batch of session cwds, reading git's
      // on-disk metadata locally. Returns null per cwd that isn't inside a
      // checkout (or can't be read — e.g. a remote backend's path).
      worktrees?: (cwds: string[]) => Promise<Record<string, HermesWorktreeInfo | null>>
      // Reveal a path in the OS file manager (Finder / Explorer).
      revealPath?: (path: string) => Promise<boolean>
      // Open a DIRECTORY (created if missing) in the OS file manager.
      openDir?: (path: string) => Promise<{ ok: boolean; error?: string }>
      // Local Desktop runtime-plugin root (<HERMES_HOME>/desktop-plugins),
      // resolved by Electron independently of the connected backend (#66899).
      // Created on demand; returns the normalized absolute path.
      desktopPluginsRoot?: () => Promise<string>
      /** LOCAL `<HERMES_HOME>/logs` (profile-aware) — error card "Open Logs". */
      logsRoot?: () => Promise<string>
      // Local AGENT-plugin root (<HERMES_HOME>/plugins), same Electron-local
      // resolution. The disk door also scans it for `<name>/desktop/plugin.js`
      // so one agent-plugin package can ship a desktop UI half. Optional:
      // older Electron shells predate it — the scanner then skips this root.
      agentPluginsRoot?: () => Promise<string>
      // Rename a file/folder in place (new base name, same parent dir).
      renamePath?: (path: string, newName: string) => Promise<{ path: string }>
      // Write a small UTF-8 text file (hardened path, parent must exist).
      writeTextFile?: (path: string, content: string) => Promise<{ path: string }>
      // Move a file/folder to the OS trash (recoverable).
      trashPath?: (path: string) => Promise<boolean>
      // Git-driven worktree management for the "Start work" flow.
      git?: {
        worktreeList: (repoPath: string) => Promise<HermesGitWorktree[]>
        worktreeAdd: (
          repoPath: string,
          options?: { name?: string; branch?: string; base?: string; existingBranch?: string }
        ) => Promise<{ path: string; branch: string; repoRoot: string }>
        worktreeRemove: (
          repoPath: string,
          worktreePath: string,
          options?: { force?: boolean }
        ) => Promise<{ removed: string }>
        branchSwitch: (repoPath: string, branch: string) => Promise<{ branch: string }>
        // The local branches, plus the remote-tracking refs that have no local
        // branch, for the "convert a branch into a worktree" picker.
        branchList: (repoPath: string) => Promise<HermesGitBranch[]>
        // Local + remote-tracking branches for the "base branch" picker in the
        // new-worktree dialog. The remote default (origin/HEAD) is flagged so
        // the UI can preselect it.
        baseBranchList: (repoPath: string) => Promise<HermesGitBaseBranch[]>
        // Compact working-tree status for the composer coding rail. Null on a
        // non-repo / remote backend (where the Electron probe can't run).
        repoStatus: (repoPath: string) => Promise<HermesRepoStatus | null>
        // Working-tree-vs-HEAD unified diff for one file (the preview's diff
        // view). Empty string when the file is unchanged or not in a repo.
        fileDiff: (repoPath: string, filePath: string) => Promise<string>
        // Codex-style review pane: changed files per scope, per-file diff, and
        // stage / unstage / revert.
        review: {
          list: (repoPath: string, scope: HermesReviewScope, baseRef?: null | string) => Promise<HermesReviewList>
          diff: (
            repoPath: string,
            filePath: string,
            scope: HermesReviewScope,
            baseRef?: null | string,
            staged?: boolean
          ) => Promise<string>
          stage: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
          unstage: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
          revert: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
          revParse: (repoPath: string, ref?: null | string) => Promise<null | string>
          commit: (repoPath: string, message: string, push: boolean) => Promise<{ ok: boolean }>
          // Diff (staged-or-all) + recent commit subjects for drafting a
          // commit message. Reads only; empty strings off-repo.
          commitContext: (repoPath: string) => Promise<{ diff: string; recent: string }>
          push: (repoPath: string) => Promise<{ ok: boolean }>
          shipInfo: (repoPath: string) => Promise<HermesReviewShipInfo>
          // The PR on each of the given branches — plus any known only by
          // number — for badging a list of sessions in one request instead of
          // one `pr view` per checkout.
          prList: (repoPath: string, branches: string[], numbers?: number[]) => Promise<HermesRepoPullRequests>
          // A pasted PR review/issue comment URL resolved to its structured
          // context (author, body, file + line anchor, diff hunk). Null when
          // gh can't answer — the paste stays a plain URL.
          fetchPrComment: (repoPath: string, url: string) => Promise<HermesPrComment | null>
          createPr: (repoPath: string) => Promise<{ url: string }>
        }
        // Repo-first discovery: scan bounded roots for git repos (depth-capped).
        scanRepos: (
          roots: string[],
          options?: { maxDepth?: number; enabled?: boolean; excludePaths?: string[] }
        ) => Promise<{ root: string; label: string }[]>
      }
      terminal: {
        /** Best-effort current working directory of the live PTY child (POSIX
         *  only; null on Windows or when unavailable). Used to reopen a tab
         *  where the user last `cd`'d. */
        cwd: (id: string) => Promise<string | null>
        dispose: (id: string) => Promise<boolean>
        onData: (id: string, callback: (payload: string) => void) => () => void
        onExit: (id: string, callback: (payload: HermesTerminalExit) => void) => () => void
        resize: (id: string, size: { cols: number; rows: number }) => Promise<boolean>
        start: (options?: { cols?: number; cwd?: string; rows?: number }) => Promise<HermesTerminalSession>
        write: (id: string, data: string) => Promise<boolean>
      }
      reachPreviewUrl?: (url: string) => Promise<string>
      setActiveConnectionRoute?: (
        route: {
          connectionId?: null | string
          profile?: string
          registryScoped?: boolean
        } | null
      ) => void
      onClosePreviewRequested?: (callback: () => void) => () => void
      onPreviewNav?: (callback: (command: 'back' | 'forward' | 'reload') => void) => () => void
      onOpenFolderRequested?: (callback: () => void) => () => void
      onOpenUpdatesRequested?: (callback: () => void) => () => void
      onDeepLink?: (
        callback: (payload: { kind: string; name: string; params: Record<string, string> }) => void
      ) => () => void
      signalDeepLinkReady?: () => Promise<{ ok: boolean }>
      probePluginRepo?: (payload: { identifier?: string; repo?: string }) => Promise<{
        ok: boolean
        agent: boolean
        desktop: boolean
        agentName?: string | null
        desktopName?: string | null
        warnings?: string[]
        insecure?: boolean
        error?: string
      }>
      installDesktopPlugin?: (payload: {
        identifier?: string
        repo?: string
        force?: boolean
      }) => Promise<{ ok: boolean; pluginName?: string; path?: string; error?: string }>
      onWindowStateChanged?: (callback: (payload: HermesWindowState) => void) => () => void
      onFocusSession?: (callback: (sessionId: string) => void) => () => void
      onNotificationAction?: (callback: (payload: { actionId: string; sessionId?: string }) => void) => () => void
      /** Plugin (and other session-less) notification body/action activation. */
      onNotificationActivate?: (
        callback: (payload: { actionId?: string; activate?: string; notifyId?: string; tag?: string }) => void
      ) => () => void
      onPreviewFileChanged: (callback: (payload: HermesPreviewFileChanged) => void) => () => void
      onBackendExit: (callback: (payload: BackendExit) => void) => () => void
      // Soft gateway-mode apply: primary backend was torn down without a window
      // reload. Wipe session lists (skeletons) and re-dial.
      onConnectionApplied?: (callback: () => void) => () => void
      onPowerResume?: (callback: () => void) => () => void
      getOnBattery?: () => Promise<boolean>
      onBatteryChanged?: (callback: (onBattery: boolean) => void) => () => void
      onBootProgress: (callback: (payload: DesktopBootProgress) => void) => () => void
      getBootstrapState: () => Promise<DesktopBootstrapState>
      continueBootstrapLocal: () => Promise<{ ok: boolean }>
      resetBootstrap: () => Promise<{ ok: boolean }>
      repairBootstrap: () => Promise<{ ok: boolean }>
      cancelBootstrap: () => Promise<{ ok: boolean; cancelled: boolean }>
      onBootstrapEvent: (callback: (payload: DesktopBootstrapEvent) => void) => () => void
      getVersion: () => Promise<DesktopVersionInfo>
      getRemoteDisplayReason?: () => Promise<string | null>
      updates: {
        check: () => Promise<DesktopUpdateStatus>
        apply: (opts?: DesktopUpdateApplyOptions) => Promise<DesktopUpdateApplyResult>
        getBranch: () => Promise<{ branch: string }>
        setBranch: (name: string) => Promise<{ branch: string }>
        onProgress: (callback: (payload: DesktopUpdateProgress) => void) => () => void
      }
      uninstall: {
        summary: () => Promise<DesktopUninstallSummary>
        run: (mode: DesktopUninstallMode) => Promise<DesktopUninstallResult>
      }
      themes: {
        // Download a VS Code Marketplace extension and return the raw color
        // theme files it contributes. The renderer converts + persists them.
        fetchMarketplace: (id: string) => Promise<DesktopMarketplaceThemeResult>
        // Search the Marketplace for color-theme extensions. An empty query
        // returns the most-installed themes.
        searchMarketplace: (query: string) => Promise<DesktopMarketplaceSearchItem[]>
      }
      // hc-554 场景目录 — the desktop scenario shelf + ✦ menu read the shared
      // catalog (cloud GET /media/scenario-catalog, agent-key auth + TTL) here.
      // Main owns the agent key + TTL cache; the renderer gets the raw JSON and
      // normalizes it. Returns null on any failure so the renderer falls back
      // to its built-in catalog. Optional: an older main may not expose it.
      scenarioCatalog?: {
        get: () => Promise<unknown>
      }
      // Find-in-page: delegates to Electron's webContents.findInPage on the
      // IPC sender's window so Cmd+F from a secondary session window
      // searches that window (not the primary). `onFoundInPage` returns the
      // unsubscribe fn; the renderer wires it via `initFindInPageListener`
      // in store/find-in-page.ts and tears it down when the FindBar unmounts.
      findInPage: (query: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<{ count: number }>
      stopFindInPage: () => Promise<void>
      onFoundInPage: (callback: (result: { activeMatchOrdinal: number; count: number }) => void) => () => void
      // Main-process `before-input-event` forwards Ctrl/Cmd+F here so the
      // renderer can still open the FindBar when the OS compositor has
      // already grabbed the chord (#81727, e.g. Pop!_OS / GNOME).
      onOpenFindBarRequested: (callback: () => void) => () => void
    }
  }
}

export interface DesktopMarketplaceSearchItem {
  extensionId: string
  displayName: string
  publisher: string
  description: string
  installs: number
}

export interface DesktopMarketplaceThemeFile {
  label: string
  /** VS Code's `uiTheme` for this entry (vs-dark / vs / hc-black). */
  uiTheme?: string
  /** Raw theme JSON (JSONC) text, parsed + converted by the renderer. */
  contents: string
}

export interface DesktopMarketplaceThemeResult {
  extensionId: string
  displayName: string
  themes: DesktopMarketplaceThemeFile[]
}

export interface HermesTerminalSession {
  cwd: string
  id: string
  shell: string
}

export interface HermesTerminalExit {
  code: number | null
  signal: string | null
}

export interface DesktopVersionInfo {
  appVersion: string
  engineVersion: string
  electronVersion: string
  nodeVersion: string
  platform: string
  hermesRoot: string
  /** True when the running renderer bundle predates desktop changes in the
   *  installed source tree (runtime updated, app binary not rebuilt/swapped). */
  bundleOutOfSync?: boolean
  /** Commits under apps/desktop/ the running bundle is missing (null unknown). */
  bundleCommitsBehind?: null | number
}

export type DesktopUninstallMode = 'full' | 'gui' | 'lite'

export interface DesktopUninstallSummary {
  hermes_home: string
  agent_installed: boolean
  gui_installed: boolean
  source_built_artifacts: string[]
  packaged_app_paths: string[]
  userdata_dir: string
  userdata_exists: boolean
  platform: string
  running_app_path?: null | string
  probe?: string
}

export interface DesktopUninstallResult {
  ok: boolean
  mode?: DesktopUninstallMode
  willRemoveAppBundle?: boolean
  scriptPath?: string
  error?: string
  message?: string
}

export interface DesktopUpdateCommit {
  sha: string
  summary: string
  author: string
  at: number
}

export interface DesktopUpdateStatus {
  supported: boolean
  updateAvailable?: boolean
  branch?: string
  currentBranch?: string
  reason?: string
  message?: string
  error?: string
  /** Exact commits behind. null = update available, but the count is
   *  unknowable (shallow clone without a merge-base) — never render it as a
   *  literal number. */
  behind?: number | null
  currentSha?: string
  /** Backend only: the version string the backend reports for itself. */
  currentVersion?: string
  targetSha?: string
  commits?: DesktopUpdateCommit[]
  dirty?: boolean
  fetchedAt?: number
}

export type DesktopUpdateDirtyStrategy = 'abort' | 'stash' | 'force'

export interface DesktopUpdateBlocker {
  pid: number
  name: string
  cmdline: string
  kind: 'local-preview' | 'other'
  safeToStop: boolean
  label?: string
  port?: number
  createTime?: number
}

export interface DesktopUpdateApplyOptions {
  dirtyStrategy?: DesktopUpdateDirtyStrategy
  /** User confirmed that Desktop may stop freshly re-scanned safe local preview servers. */
  stopSafeBlockers?: boolean
}

export interface DesktopUpdateApplyResult {
  ok: boolean
  branch?: string
  error?: string
  message?: string
  blockers?: DesktopUpdateBlocker[]
  /** True when no staged updater exists (CLI install) and the user should run
   *  `hermes update` themselves. `command` is the exact line to run. */
  manual?: boolean
  command?: string
  hermesRoot?: string
  /** True when the backend was updated but the GUI couldn't be relaunched in
   *  place (AppImage / dev run): the new version loads on next launch. */
  backendUpdated?: boolean
  /** False when the running GUI package was NOT replaced by this update
   *  (Linux GUI/backend skew, or a sandbox-blocked relaunch). Distinguishes
   *  "backend only" outcomes from a real in-place GUI relaunch. (#45205) */
  guiUpdated?: boolean
  /** True for the Linux GUI/backend-skew terminal state: backend updated but
   *  the running AppImage/.deb/.rpm shell is unchanged and must be
   *  reinstalled. Renders a closeable "update the desktop app" message. */
  guiSkew?: boolean
  /** True when the update finished but the app must be quit + reopened by hand
   *  (e.g. the rebuilt sandbox helper isn't launchable): keep a working
   *  window, don't auto-quit into a dead app. (#45205) */
  manualRestart?: boolean
  /** True when the auto-relaunch was skipped specifically because the rebuilt
   *  chrome-sandbox helper is not launchable (not root:root + setuid). */
  sandboxBlocked?: boolean
  /** True when a detached relauncher took over (macOS bundle swap / Linux
   *  re-exec): the app is about to quit and reopen itself. */
  handedOff?: boolean
}

export type DesktopUpdateStage =
  | 'idle'
  | 'prepare'
  | 'fetch'
  | 'pull'
  | 'pydeps'
  | 'update'
  | 'rebuild'
  | 'restart'
  | 'done'
  | 'manual'
  /** Backend updated but the running GUI package (AppImage/.deb/.rpm) was NOT
   *  changed — the user must update/reinstall the desktop app. Terminal,
   *  closeable; never claims the GUI was updated. (#45205) */
  | 'guiSkew'
  | 'error'

export interface DesktopUpdateProgress {
  stage: DesktopUpdateStage
  message: string
  percent: number | null
  error: string | null
  at: number
}

export interface DesktopPluginProfileRoute {
  // Registry source identity. Pair with profile; profile names are not unique
  // across sources.
  connectionId: string
  mode: 'local' | 'remote'
  profile: string
  targetProfile: string
}

export interface HermesConnection {
  baseUrl: string
  darwinMajor?: number
  isFullscreen: boolean
  // The live, RESOLVED connection mode. Only ever 'local' or 'remote' — a
  // 'cloud' saved-config entry resolves to a 'remote' connection under the hood
  // (cloud-auto-discovery Q3/Q6), so this never carries 'cloud'.
  mode?: 'local' | 'remote'
  authMode?: 'oauth' | 'token'
  remoteHost?: string
  remoteIdentity?: string
  remoteKind?: 'cloud' | 'ssh' | 'url'
  remoteHermesVersion?: string
  nativeOverlayWidth: number
  source?: 'env' | 'local' | 'settings'
  token: string
  wsUrl: string
  logs: string[]
  // Set for pool (non-primary) backends so the renderer knows which profile a
  // connection belongs to.
  profile?: string
  // The registry connection this descriptor resolves to. Registry-scoped
  // secondaries carry it directly; legacy primary remotes preserve it from
  // their selected stored route before dialing.
  connectionId?: string
  // True only when getConnectionFor explicitly resolved a v2 registry route.
  // An inferred connectionId identifies the visible source but its v1 profile
  // name may still be a client-side routing alias rather than a backend profile.
  registryScoped?: boolean
  // True only when `profile` is a request scope on the shared primary backend.
  // A pooled backend also carries `profile`, so presence alone cannot identify
  // the shared-primary routing case.
  sharedPrimary?: boolean
  // True when `profile` is a request scope on a SHARED registry remote/cloud
  // backend (one host, many profiles) — the registry analogue of sharedPrimary.
  sharedRemote?: boolean
  windowButtonPosition: { x: number; y: number } | null
}

export interface HermesTitleBarTheme {
  background: string
  foreground: string
}

/** Turns in flight, so the main process can confirm before a quit kills them. */
export interface HermesActiveWork {
  count: number
  titles: string[]
}

export interface HermesWindowState {
  darwinMajor?: number
  isFullscreen: boolean
  isMinimized?: boolean
  isVisible?: boolean
  nativeOverlayWidth: number
  windowButtonPosition: { x: number; y: number } | null
}

export interface DesktopActiveProfile {
  // The desktop's stored profile preference, or null when unset (legacy launch
  // that defers to the sticky active_profile / default).
  profile: string | null
}

export interface DesktopConnectionConfig {
  envOverride: boolean
  // The saved connection mode. 'cloud' is a Hermes Cloud connection: it carries
  // a remote-shaped block (remoteUrl = the selected agent's dashboardUrl,
  // remoteAuthMode 'oauth') but is remembered as cloud so settings reopens into
  // the cloud picker. Resolution treats cloud exactly as remote
  // (cloud-auto-discovery Q3/Q6).
  mode: 'local' | 'remote' | 'cloud' | 'ssh'
  // The profile this config describes, or null for the global/default
  // connection. Per-profile entries let a profile point at its own backend.
  profile: null | string
  remoteAuthMode: 'oauth' | 'token'
  remoteOauthConnected: boolean
  remoteTokenPreview: string | null
  remoteTokenSet: boolean
  // Whether OS-keychain-backed encryption (Electron safeStorage) is currently
  // available on this machine. When false, a persisted remote token can only be
  // stored as plain text on disk (with an explicit opt-in).
  secureTokenStorage: boolean
  // Whether the currently-persisted remote token is stored with encoding
  // 'plain' (i.e. plain text on disk in connection.json), which happens when
  // the user opted in on a machine without secure storage.
  remoteTokenPlainText: boolean
  remoteUrl: string
  // For a 'cloud' connection: the persisted Hermes Cloud org (slug or id) the
  // connected instance was discovered under, so Settings → Gateway can reopen
  // into that org. Empty string for remote/local.
  cloudOrg: string
  sshHost: string
  sshUser: string
  sshPort: number | null
  sshKeyPath: string
  sshRemoteHermesPath: string
  sshRemoteProfile: string
}

export interface DesktopConnectionConfigInput {
  mode: 'local' | 'remote' | 'cloud' | 'ssh'
  // When set, the save/apply/test targets this profile's per-profile remote
  // override instead of the global connection.
  profile?: null | string
  remoteAuthMode?: 'oauth' | 'token'
  remoteToken?: string
  // When true and secure (OS-keychain) storage is unavailable, persist the
  // remote token as plain text on disk instead of failing. Requires an explicit
  // user opt-in from the renderer.
  allowPlainTextToken?: boolean
  remoteUrl?: string
  // For a 'cloud' connection: the selected Hermes Cloud org (slug or id) to
  // persist so Settings can reopen into it. Ignored for remote/local modes.
  cloudOrg?: string
  sshHost?: string
  sshUser?: string
  sshPort?: number | null
  sshKeyPath?: string
  sshRemoteHermesPath?: string
  sshRemoteProfile?: string
}

export interface DesktopConnectionTestResult {
  baseUrl?: string
  ok?: boolean
  version?: string | null
  reachable?: boolean
  sshError?:
    | 'auth-failed'
    | 'hermes-not-found'
    | 'host-key-changed'
    | 'timeout'
    | 'unreachable'
    | 'unsupported-platform'
    | 'update-required'
    | 'unknown'
    | null
  error?: string | null
  host?: string
  remoteHermesPath?: string
  remoteHermesVersion?: string
  remotePlatform?: string
}

// ── v2 multi-connection registry (named agent sources) ─────────────────────

export type DesktopConnectionKind = 'cloud' | 'local' | 'remote' | 'ssh'

// A registered agent source as the renderer sees it: token bytes never cross
// the IPC boundary (preview + set flag instead, like DesktopConnectionConfig).
export interface DesktopRegistryConnection {
  id: string
  kind: DesktopConnectionKind
  // Required, registry-unique device name ("Homelab", "Work laptop").
  label: string
  url?: string
  authMode?: 'oauth' | 'token'
  org?: string
  host?: string
  user?: string
  port?: number
  keyPath?: string
  remoteHermesPath?: string
  remoteProfile?: string
  tokenSet: boolean
  tokenPreview: null | string
  // Names of the stored extra gateway headers (Cloudflare Access etc.);
  // header VALUES are secrets and never cross the IPC boundary. Optional so
  // fixtures/older payloads without the field remain valid.
  headerNames?: string[]
  // Last-known stable backend identity (the /api/status `install_id`).
  // Present once a roster enumeration or connection test has seen it; two
  // connections sharing it are one physical backend registered under two
  // addresses (display-only "Same backend as …" hint in Settings).
  installId?: string
}

export interface DesktopConnectionsRegistry {
  version: number
  // id of the connection that owns the window/primary backend.
  primary: string
  // Preserve old installs by defaulting to the explicit primary; users may
  // instead resume the last successfully opened source.
  launchMode?: 'last-used' | 'primary'
  // Last source the Sessions workspace opened successfully. Optional for
  // compatibility with an older Electron main during a rolling app update.
  lastUsed?: string
  // Whether OS-keychain-backed encryption (Electron safeStorage) is available;
  // false drives the plain-text token opt-in on keyring-less Linux.
  secureTokenStorage: boolean
  connections: DesktopRegistryConnection[]
}

export interface DesktopRegistryConnectionInput {
  // Present for edits; omitted on create (the main process mints the id).
  id?: string
  kind: DesktopConnectionKind
  label: string
  url?: string
  authMode?: 'oauth' | 'token'
  // Plaintext token to store (encrypted at rest); omit to keep the saved one.
  token?: string
  allowPlainTextToken?: boolean
  // Extra gateway headers for remote/cloud entries (access proxies such as
  // Cloudflare Access). The map is authoritative when present: name → new
  // plaintext value (encrypted at rest), or null to keep the stored secret
  // for that name. Omit the field entirely to keep the saved set unchanged.
  headers?: Record<string, null | string>
  org?: string
  host?: string
  user?: string
  port?: null | number
  keyPath?: string
  remoteHermesPath?: string
  remoteProfile?: string
}

// One agent in the union roster: a profile on a registered source, with the
// pre-computed @name-device handle for duplicate profile names.
export interface DesktopRosterAgent {
  connectionId: string
  connectionKind: DesktopConnectionKind
  connectionLabel: string
  profile: string
  targetProfile?: string
  handle: string
}

export interface DesktopAgentRoster {
  agents: DesktopRosterAgent[]
  sources: {
    connectionId: string
    label: string
    kind: DesktopConnectionKind
    reachable: boolean
    error?: string
    // Stable backend identity (/api/status install_id) when known.
    installId?: string
  }[]
}

// Per-connection result row from the update fan-out.
export interface DesktopConnectionUpdateResult {
  connectionId: string
  label: string
  kind: DesktopConnectionKind
  ok: boolean
  skipped?: boolean
  reason?: string
  detail?: string
  error?: string
}

export type DesktopManagedConnectionUpdateOutcome =
  'updated' | 'update-failed' | 'restore-failed' | 'update-and-restore-failed' | 'refused'

export interface DesktopManagedUpdateReceipt {
  correlationId: string
  // Additive receipt outcomes remain forward-compatible with newer updater
  // kernels instead of making an older renderer reject their proof.
  outcome: string
  startedAt?: string
  finishedAt?: string
  preSha?: string
  postSha?: string
  preVersion?: string
  postVersion?: string
  stopReason?: string
}

export interface DesktopManagedConnectionUpdateResult {
  connectionId: string
  correlationId: string
  ok: boolean
  updateOk: boolean
  restoreOk: boolean
  outcome: DesktopManagedConnectionUpdateOutcome
  exitCode: number | null
  receipt: DesktopManagedUpdateReceipt | null
  scopes: Array<{ profile: string; restored: boolean; error?: string }>
  error?: string
  message?: string
}

export interface DesktopSshResolveResult {
  hostname: string | null
  identityFile: string | null
  port: number | null
  user: string | null
}

export interface DesktopSshHostsResult {
  hosts: string[]
}

export interface DesktopAuthProvider {
  name: string
  displayName: string
  // True when this provider authenticates with a username + password
  // (the gateway's /login page renders a credential form) rather than an
  // OAuth redirect. The session/cookie/ws-ticket machinery is identical;
  // only the login-page form and the desktop's button copy differ.
  supportsPassword?: boolean
}

export interface DesktopConnectionProbeResult {
  baseUrl: string
  reachable: boolean
  authMode: 'oauth' | 'token' | 'unknown'
  providers: DesktopAuthProvider[]
  version: string | null
  error: string | null
}

export interface DesktopOauthLoginResult {
  ok: boolean
  baseUrl: string
  connected: boolean
}

export interface DesktopOauthLogoutResult {
  ok: boolean
  connected: boolean
}

// --- Hermes Cloud (cloud-auto-discovery Phase 3) ---

export interface DesktopCloudStatus {
  // The portal base URL the desktop talks to (default or env-overridden).
  portalBaseUrl: string
  // Whether the OAuth partition holds a live Nous portal (Privy) session — the
  // portal authenticates via Privy, so this reflects the privy-token cookie, NOT
  // the hermes gateway session cookies. See cookiesHavePrivySession.
  signedIn: boolean
}

// A discovered Hermes Cloud agent — the trimmed DTO from NAS GET /api/agents.
export interface DesktopCloudAgent {
  id: string
  name: string
  status: string
  // null until the agent has a provisioned dashboard (show "provisioning…").
  dashboardUrl: string | null
  // "active" | "degraded" | "down" | "unknown".
  dashboardGatewayState: string
}

// An org the signed-in user belongs to — for the org picker shown when a
// multi-org user's discovery call needs disambiguation (NAS 409).
export interface DesktopCloudOrg {
  id: string
  slug: string | null
  name: string
  isPersonal: boolean
  // "OWNER" | "MEMBER".
  role: string
}

// Discovery result: either the agent list, OR a request to pick an org first
// (multi-org user, no org chosen yet). The renderer shows a picker on the
// latter and re-calls discover(org). On the agents branch, `org` echoes the
// authoritatively-resolved org the list was scoped to (from NAS), so the
// desktop persists it without relying on transient picker state.
export type DesktopCloudDiscoverResult =
  | { agents: DesktopCloudAgent[]; org?: DesktopCloudOrg | null; needsOrgSelection?: false }
  | { needsOrgSelection: true; orgs: DesktopCloudOrg[] }

export interface DesktopCloudAgentSignInResult {
  // The agent gateway base URL the silent sign-in targeted.
  baseUrl: string
  // Whether the agent's gateway session cookie landed (silent cascade done).
  connected: boolean
}

export interface DesktopBootProgress {
  error: string | null
  fakeMode: boolean
  /** True when the boot failure is a Nous Cloud agent that is down (HTTP 502/503/504). */
  isCloudBackendDown?: boolean
  message: string
  phase: string
  progress: number
  /**
   * True when the boot failure carried by `error` was a TRANSIENT remote
   * failure (dropped SSH/HTTP registered connection, mint timeout) that the
   * renderer may retry automatically. Absent/false on success updates,
   * local failures, and confirmed reauth rejections.
   */
  retryable?: boolean
  running: boolean
  /** Structured HTTP status when the boot failure carried one (e.g. 503). */
  statusCode?: number | null
  timestamp: number
}

// First-launch install ("bootstrap") event types -- emitted by
// electron/bootstrap-runner.ts and observed by the renderer install overlay.
// Mirrors the event shapes emitted by runBootstrap()'s onEvent callback.

export interface DesktopBootstrapStageDescriptor {
  name: string
  title?: string
  category?: string
  needs_user_input?: boolean
}

export type DesktopBootstrapStageState = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed'

export interface DesktopBootstrapStageResult {
  state: DesktopBootstrapStageState
  durationMs: number | null
  startedAt: number | null
  // hc-569: skip_code is the installer's machine-readable "why was this stage
  // skipped" (e.g. deps_unchanged, prereq_cached); the overlay maps it to a
  // localized reason and falls back to the raw `reason` string when unknown.
  json: { ok: boolean; skipped?: boolean; reason?: string | null; skip_code?: string | null; stage: string } | null
  error: string | null
}

export interface DesktopBootstrapUnsupportedPlatform {
  platform: string
  activeRoot: string
  installCommand: string
  docsUrl: string
}

export interface DesktopBootstrapSetupChoice {
  platform: string
  activeRoot: string
}

export interface DesktopBootstrapState {
  active: boolean
  manifest: {
    type: 'manifest'
    stages: DesktopBootstrapStageDescriptor[]
    protocolVersion: number | null
    // hc-452: see DesktopBootstrapUpdateInfo below -- distinguishes an opt-in
    // runtime version update from a genuine first install.
    updateInfo: DesktopBootstrapUpdateInfo
  } | null
  stages: Record<string, DesktopBootstrapStageResult>
  error: string | null
  log: Array<{ ts: number; stage: string | null; line: string; stream?: 'stdout' | 'stderr' }>
  startedAt: number | null
  completedAt: number | null
  setupChoice: DesktopBootstrapSetupChoice | null
  unsupportedPlatform: DesktopBootstrapUnsupportedPlatform | null
}

export type DesktopBootstrapEvent =
  | { type: 'dismissed' }
  | {
      type: 'setup-choice'
      active: boolean
      platform?: string
      activeRoot?: string
    }
  | {
      type: 'manifest'
      stages: DesktopBootstrapStageDescriptor[]
      protocolVersion: number | null
      updateInfo?: DesktopBootstrapUpdateInfo
    }
  | {
      type: 'stage'
      name: string
      state: DesktopBootstrapStageState
      durationMs?: number
      json?: DesktopBootstrapStageResult['json']
      error?: string | null
    }
  | { type: 'log'; stage?: string | null; line: string; stream?: 'stdout' | 'stderr' }
  | { type: 'complete'; marker: Record<string, unknown> }
  | { type: 'failed'; stage?: string | null; error: string }
  | {
      type: 'unsupported-platform'
      platform: string
      activeRoot: string
      installCommand: string
      docsUrl: string
    }

export interface HermesApiRequest {
  path: string
  method?: string
  body?: unknown
  // Single-file multipart upload (FastAPI UploadFile endpoints). Mutually
  // exclusive with `body`; bytes transfer over IPC as a structured-clone
  // ArrayBuffer. Token-mode backends only.
  upload?: { filename: string; contentType?: string; bytes: ArrayBuffer }
  timeoutMs?: number
  // Route this REST call to a specific profile's backend. Omit for the primary
  // (window) backend. Read-only cross-profile data is served by the primary, so
  // this is only needed for profile-scoped live/settings calls.
  profile?: string | null
  // Route this REST call to a specific REGISTERED gateway connection (v2
  // registry). Data owned by a remote gateway — cron jobs and their run
  // sessions — lives in that host's state.db, so requests for it must resolve
  // through the owning connection, not the local profile pool. Omit / '' to
  // keep the legacy profile-routed path; explicit 'local' forces this device.
  connectionId?: string | null
}

export interface HermesNotification {
  title?: string
  body?: string
  silent?: boolean
  kind?: string
  sessionId?: string
  /** Dedupe discriminator for session-less notifications (e.g. plugin id). */
  tag?: string
  /** Absolute icon path for Electron `Notification`. */
  icon?: string
  /** Resolved hash-router path opened on body click (plugin / deeplink-compatible). */
  activate?: string
  /** Renderer handle for onActivate / onAction callbacks. */
  notifyId?: string
  actions?: { id: string; text: string; activate?: string }[]
}

export interface HermesPreviewTarget {
  binary?: boolean
  byteSize?: number
  kind: 'file' | 'url'
  label: string
  large?: boolean
  language?: string
  mimeType?: string
  path?: string
  previewKind?: 'binary' | 'html' | 'image' | 'pdf' | 'text'
  renderMode?: 'preview' | 'source'
  source: string
  url: string
}

export interface HermesReadFileTextResult {
  binary?: boolean
  byteSize?: number
  language?: string
  mimeType?: string
  path: string
  text: string
  truncated?: boolean
}

export interface HermesPreviewWatch {
  id: string
  path: string
}

// A real git worktree as reported by `git worktree list` (source of truth for
// the "Start work" flow), as opposed to the session-cwd-derived grouping above.
export interface HermesGitWorktree {
  path: string
  branch: null | string
  isMain: boolean
  detached: boolean
  locked: boolean
}

// A branch that the "convert a branch into a worktree" picker offers: the local
// heads, plus the remote-tracking refs that have no local branch yet.
// `checkedOut` means that a selection opens that checkout. `isDefault` means
// that a selection switches the main checkout, and does not make
// `.worktrees/main`. `isRemote` means that a selection first makes a local
// branch that tracks the remote one.
export interface HermesGitBranch {
  name: string
  checkedOut: boolean
  isDefault: boolean
  isRemote: boolean
  worktreePath: null | string
}

// A branch the new worktree can be based on: local heads + remote-tracking
// refs. `isRemote` distinguishes `origin/main` from a local `main` (the UI
// may show a remote glyph); `isDefault` flags origin/HEAD so the dialog can
// preselect it.
export interface HermesGitBaseBranch {
  name: string
  isRemote: boolean
  isDefault: boolean
}

// A single changed path from `git status --porcelain=v2`, classified by state
// so the coding rail / switcher can group + open the right diff.
export interface HermesRepoStatusFile {
  path: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

// Compact working-tree status for the composer coding rail (parsed from
// `git status --porcelain=v2 --branch`).
export interface HermesRepoStatus {
  branch: null | string
  // The repo's trunk ("main" / "master" / …), so the UI can offer "branch off
  // the default" from anywhere. Null when no trunk is detected.
  defaultBranch: null | string
  detached: boolean
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  // Total distinct changed paths (tracked modified + conflicts + untracked).
  changed: number
  // +/- line counts of tracked changes vs HEAD (staged + unstaged). Untracked
  // files aren't in the diff, so they don't contribute lines.
  added: number
  removed: number
  // Capped changed-file list (REPO_STATUS_FILE_CAP) for the diff/open actions.
  files: HermesRepoStatusFile[]
}

// Diff scope for the review pane, mirroring Codex: uncommitted working-tree
// changes, all changes vs the branch base, or everything since the current
// turn began.
export type HermesReviewScope = 'branch' | 'lastTurn' | 'uncommitted'

// One changed file in the review pane (status letter, +/- lines, staged flag).
export interface HermesReviewFile {
  path: string
  added: number
  removed: number
  // M(odified) A(dded) D(eleted) R(enamed) C(opied) U(nmerged) ?(untracked)
  status: string
  staged: boolean
}

export interface HermesReviewList {
  files: HermesReviewFile[]
  // The resolved base ref the scope diffed against (branch merge-base / turn
  // baseline), or null for the uncommitted scope.
  base: null | string
}

// The branch's PR (if any) as reported by `gh pr view`.
export interface HermesReviewPr {
  url: string
  state: string
  number: number
}

// One repo's PRs as reported by `gh pr list`, each tied to the branch it was
// opened from — how a session row finds its own PR.
export interface HermesBranchPullRequest {
  branch: string
  draft: boolean
  number: number
  /** `open` | `closed` | `merged`, lowercased from gh. */
  state: string
  title: string
  url: string
}

export interface HermesRepoPullRequests {
  ghReady: boolean
  prs: HermesBranchPullRequest[]
}

// A PR review/issue comment resolved from a pasted GitHub URL — the composer's
// review-comment attachment context. `path`/`line`/`diffHunk` are empty for
// conversation-tab (issue) comments; `line` is null when the comment is
// outdated and only `original_line` remained.
export interface HermesPrComment {
  author: string
  body: string
  diffHunk: string
  kind: 'issue' | 'review'
  line: null | number
  path: string
  prNumber: number
  startLine: null | number
  url: string
}
// gh availability/auth + the current branch's PR — drives the review pane's PR
// button (disabled when gh isn't ready, "Open PR" vs "Create PR" otherwise).
export interface HermesReviewShipInfo {
  ghReady: boolean
  pr: HermesReviewPr | null
}

export interface HermesReadDirEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface HermesReadDirResult {
  entries: HermesReadDirEntry[]
  error?: string
}

export interface HermesPreviewFileChanged {
  id: string
  path: string
  url: string
}

export interface HermesSelectPathsOptions {
  title?: string
  defaultPath?: string
  directories?: boolean
  multiple?: boolean
  /** Backend profile that produced defaultPath; Electron uses it for WSL gating. */
  profile?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface BackendExit {
  code: number | null
  signal: string | null
}

// ---------------------------------------------------------------------------
// ApexNodes fork-only IPC contracts. The Window bridge above already declares
// the matching namespaces (managed / feishu / announcements / imEntry / daemon
// / agentAuth / runtime / shellUpdate / worktrees); these are the payload
// shapes the renderer imports from '@/global'.
// ---------------------------------------------------------------------------

export interface DesktopManagedStatus {
  // The relay base_url the managed config points at (e.g.
  // https://apex-nodes.com/relay/v1).
  baseUrl: string
  // Signed-in user's email, for the account panel. '' when unknown / signed out.
  // Display-only — never a secret (the relay key stays encrypted on disk).
  email: string
  // True when the managed-LLM default path is enabled for this build.
  enabled: boolean
  // hc-519 rollback switch (default true): whether relay-auth loss drives the
  // global login state (account-card degrade + startup/catalog self-heal).
  // Optional so an older main process (no field) reads as undefined → treated as
  // enabled (fail-safe to the new single-source-of-truth behavior).
  loginStateTruth?: boolean
  // Real routed model id (e.g. deepseek-v4-pro).
  model: string
  // UI display label for the model (e.g. deepseek-v4-pro-APEX).
  modelDisplay: string
  // Signed-in user's display name, if the backend/JWT provided one. '' otherwise.
  name: string
  // Signed-in user's plan/tier label (e.g. 'free', 'pro'), if available. ''
  // otherwise — the account panel omits the plan badge when empty.
  plan: string
  // Runtime provider slug used for the relay (custom).
  provider: string
  // True when a relay key is on disk (user already signed in to managed).
  signedIn: boolean
  // True only when a reusable login JWT is on disk — a real cloud sign-in that
  // can self-heal a rotated/expired relay key. A seeded/env key (a `*.local`
  // release account or a CI test key) is signedIn=true but hasToken=false: the
  // UI can then show an honest "not connected to platform" state. Optional so an
  // older main process (no field) reads as undefined rather than a hard error.
  hasToken?: boolean
}

export interface DesktopWorkflowDomainAccess {
  available: boolean
  code?: 'request_failed' | 'sign_in' | 'unavailable'
}

export interface DesktopWorkflowDomainStartGoalInput {
  objective: string
  starter: {
    description: string
    id: string
    name: string
    slug: string
    version: number
  }
}

export interface DesktopWorkflowDomainProjectSummary {
  attention: 'failed' | 'none' | 'review'
  currentRunId: null | string
  currentRunStatus: null | string
  currentStepTitle: null | string
  deliverableCount: number
  stepCompleted: number
  stepTotal: number
}

export interface DesktopWorkflowDomainProject {
  createdAt: string
  id: string
  name: string
  objective: string
  status: string
  summary: DesktopWorkflowDomainProjectSummary
  updatedAt: string
}

export interface DesktopWorkflowDomainWorkflow {
  createdAt: string
  description: null | string
  id: string
  name: string
  projectId: string
  slug: string
  status: string
  updatedAt: string
  version: null | number
}

export interface DesktopWorkflowDomainCatalogItem {
  businessPath: string
  id: string
  position: number
  recommended: boolean
  slug: string
  version: number
}

export interface DesktopWorkflowDomainProjectListResult {
  code?: 'request_failed' | 'sign_in' | 'unavailable'
  items?: DesktopWorkflowDomainProject[]
  limit?: number
  nextCursor?: null | string
  offset?: number
  ok: boolean
  total?: number
}

export interface DesktopWorkflowDomainWorkflowListResult {
  code?: 'request_failed' | 'sign_in' | 'unavailable'
  items?: DesktopWorkflowDomainWorkflow[]
  limit?: number
  nextCursor?: null | string
  ok: boolean
}

export interface DesktopWorkflowDomainCatalogResult {
  code?: 'request_failed' | 'sign_in' | 'unavailable'
  items?: DesktopWorkflowDomainCatalogItem[]
  ok: boolean
  version?: string
}

export interface DesktopWorkflowDomainRun {
  attempt: number
  completedAt: null | string
  createdAt: string
  errorCode: null | string
  errorMessage: null | string
  executorType: string
  id: string
  maxAttempts: number
  startedAt: null | string
  status: string
  triggerRef: null | string
  updatedAt: string
}

export interface DesktopWorkflowDomainEvent {
  eventKey: string
  eventType: string
  happenedAt: string
  id: string
  payload: Record<string, unknown>
  sequence: number
}

export interface DesktopWorkflowDomainReview {
  createdAt: string
  deliverableId: string
  id: string
  notes: null | string
  roundNumber: number
  status: 'approved' | 'changes_requested' | 'rejected'
}

export interface DesktopWorkflowDomainDeliverable {
  createdAt: string
  evidenceManifest: Array<Record<string, unknown>>
  id: string
  kind: string
  payload: Record<string, unknown>
  reviews: DesktopWorkflowDomainReview[]
  status: string
  title: string
  updatedAt: string
}

export interface DesktopWorkflowDomainOverview {
  deliverables: DesktopWorkflowDomainDeliverable[]
  events: DesktopWorkflowDomainEvent[]
  run: DesktopWorkflowDomainRun
}

export interface DesktopWorkflowDomainStartResult {
  code?: 'request_failed' | 'sign_in' | 'unavailable'
  ok: boolean
  run?: DesktopWorkflowDomainRun
}

export interface DesktopWorkflowDomainRunResult {
  code?: 'request_failed' | 'sign_in' | 'unavailable'
  ok: boolean
  overview?: DesktopWorkflowDomainOverview
}

export interface DesktopWorkflowDomainMutationResult {
  code?: 'request_failed' | 'sign_in' | 'unavailable'
  ok: boolean
}

// Result of hermesDesktop.managed.selfHeal() — an on-demand relay-key recovery.
// relayUnauthorized=false means the relay accepted the key (the failure was not
// a managed-relay auth problem). healed=true means a fresh key is on disk and
// `assignment` should be applied via /api/model/set before retrying. needsSignIn
// =true means recovery is impossible without a re-login (no token, or an expired
// JWT) — surface the sign-in flow rather than retry into another silent 401.
export interface DesktopManagedSelfHealResult {
  ok: boolean
  relayUnauthorized: boolean
  healed: boolean
  needsSignIn: boolean
  assignment: DesktopManagedSignInResult['assignment']
}

// hc-512: state of the relay's live model catalog (`GET {base_url}/v1/models`
// with the stored relay key — the same listing the runtime's picker builds the
// APEX group from). 'unauthorized' = the stored key is dead (re-login is the
// fix); 'unreachable' = transient network/relay failure (retry is the fix);
// 'unknown' = never probed / not a managed install.
export interface DesktopRelayCatalogState {
  checkedAt: number
  status: 'ok' | 'unauthorized' | 'unreachable' | 'unknown'
}

// hc-444: local Feishu bridge state for the settings card. No secret fields —
// the app_secret never leaves the main process.
export interface DesktopFeishuStatus {
  // True when an injectable Feishu credential is stored locally (adapter will
  // light up on the next backend boot).
  connected: boolean
  // True when a managed sign-in exists (the prerequisite for sync — sync auths
  // with the stored login JWT). When false the card prompts sign-in first.
  signedIn: boolean
  // Display-only: the bound agent's name ('' when unknown / not connected).
  agentName: string
  // 'feishu' (China) or 'lark' (International); '' when not connected.
  domain: string
  // hc-190 probe verdict (ok / expired / invalid / '' when never probed) so the
  // card can warn the credential the platform mirrored is already known-dead.
  credentialStatus: string
  // Epoch ms of the last successful sync, or null.
  syncedAt: number | null
}

// Result of a Feishu sync/openBind action. `hasEntry:false` means the user has
// no bound Feishu app in the cloud yet → the card opens the web binding flow.
// `needsSignIn:true` means the stored login JWT is missing/expired → sign in
// first. `message` is a stable marker code the renderer maps to Chinese copy.
export interface DesktopFeishuSyncResult {
  ok: boolean
  hasEntry?: boolean
  needsSignIn?: boolean
  agentName?: string
  domain?: string
  credentialStatus?: string
  message?: string
}

// hc-447: one published product-update announcement (hc-446 content source —
// admin-authored "you can now…" copy, never hc numbers/jargon). `level`
// only affects upstream delivery cadence (major=instant, normal=monthly
// batch), not display; the desktop renders both the same way.
export interface DesktopAnnouncementItem {
  id: string
  title: string
  body: string
  level: 'major' | 'normal'
  // ISO 8601, or null (should not happen for a published row, but the main
  // process normalizer degrades a missing/malformed value to null rather
  // than guessing).
  publishedAt: string | null
  read: boolean
}

// Result of announcements.list(). `needsSignIn:true` means the stored login
// JWT is missing/expired — the panel shows a sign-in prompt instead of an
// error. An empty `items` array with ok:true is a normal, expected state (no
// published announcements yet) — never treated as an error.
export interface DesktopAnnouncementsListResult {
  ok: boolean
  items: DesktopAnnouncementItem[]
  needsSignIn?: boolean
  message?: string
}

// hc-417: one locally-bound IM 入口 channel (display-only — no secret). `boundAt`
// is epoch ms; `domain` is the non-secret feishu/lark routing value ('' if none).
export interface DesktopImEntryBinding {
  channelId: string
  boundAt: number | null
  domain: string
}

export interface DesktopImEntryListResult {
  channels: DesktopImEntryBinding[]
}

// Result of imEntry.feishuIssue() — the provisioning START (cloud v2:
// POST /api/v1/desktop/feishu/provision). On ok:true it carries the scan LINK
// (qrUrl — render it as a QR locally) + a poll handle (provisionId + cadence).
// On ok:false, `message` is a stable marker the renderer maps to copy:
// NOT_SIGNED_IN / SESSION_EXPIRED (→ sign in) · SERVICE_UNAVAILABLE (endpoint
// not deployed → coming soon) · RATE_LIMITED (another flow in flight) ·
// REQUEST_FAILED (transient → retry).
export interface DesktopImEntryIssueResult {
  ok: boolean
  needsSignIn?: boolean
  message?: string
  provisionId?: string
  qrUrl?: string
  intervalMs?: number
  expiresInMs?: number
}

// Result of imEntry.feishuPoll() — one status check (cloud v2:
// GET /api/v1/desktop/feishu/provision/{id}). `status` is one of
// pending | success | denied | expired. On success the main process has already
// fetched + stored the credential and is restarting the backend; when the
// automatic restart failed, `restartFailed` is set and the binding is still
// saved (the user restarts manually). KEYCHAIN_UNAVAILABLE means secure storage
// is off, so the credential was NOT saved (never written in plaintext) — the
// user must enable OS keychain access.
export interface DesktopImEntryPollResult {
  ok: boolean
  status?: 'denied' | 'expired' | 'pending' | 'success'
  restartFailed?: boolean
  needsSignIn?: boolean
  message?: string
}

// hc-533 本机 Agent 调度 daemon status (display-only; no secret). `status` is
// the single label the settings block shows; the booleans back it.
export interface DesktopDaemonStatus {
  status: 'connecting' | 'dormant' | 'error' | 'offline' | 'online'
  enabled: boolean
  deviceName: string
  deviceId: string
  registered: boolean
  connected: boolean
  lastError: string
}

// Result of a daemon mutation (setEnabled / setDeviceName / unregister) — the
// fresh status snapshot + an ok flag (+ an optional message, e.g. keychain).
export interface DesktopDaemonMutationResult {
  ok: boolean
  message?: string
  snapshot: DesktopDaemonStatus
}

// hc-545 coding-agent account connection ------------------------------------
export type DesktopAgentFamily = 'claude' | 'codex'

// The three-state result (+ no_cli / unknown) from the anti-conflation detector.
// `logged_out` and `unreachable` are DELIBERATELY distinct — different fixes
// (sign in vs configure a proxy). See electron/apex-agent-auth.cjs.
export type DesktopAgentAuthState = 'logged_out' | 'no_cli' | 'ready' | 'unknown' | 'unreachable'

export interface DesktopAgentAuthResult {
  family: DesktopAgentFamily
  state: DesktopAgentAuthState
  email: string
  plan: string
}

export interface DesktopAgentAuthStatus {
  ok: boolean
  claude: DesktopAgentAuthResult
  codex: DesktopAgentAuthResult
}

// Outcome of hosting a CLI login. `mode` tells the renderer how to follow up:
// browser/started → poll status(); completed → already signed in; guide/no_cli →
// show `guideCommand` for the user to run in a terminal (honest degrade).
export interface DesktopAgentConnectResult {
  ok: boolean
  mode: 'browser' | 'completed' | 'guide' | 'no_cli' | 'started'
  url?: string
  reason?: string
  guideCommand: string
}

export type DesktopAgentProxyMode = 'auto' | 'custom' | 'off'

export interface DesktopAgentProxyState {
  ok: boolean
  mode: DesktopAgentProxyMode
  customUrl: string
  // Display-safe (credentials stripped) description of the resolved proxy.
  detected: { active: boolean; url: string }
}

// Payload of the continuous auth-gate broadcast (hermes:auth-gate). `reason`
// distinguishes a lost/expired login (401) from an abnormal account (403
// account_disabled) so the login screen can show the right message.
export interface DesktopAuthGateEvent {
  reason: 'account_disabled' | 'unauthorized'
  statusCode: number
}

export interface DesktopManagedSignInResult {
  // The model assignment to apply via /api/model/set (POST), present only when
  // hasRelayKey is true. Mirrors the ModelAssignmentRequest shape the BYOK
  // local-endpoint flow uses, so applying managed reuses that exact path.
  assignment: {
    api_key: string
    base_url: string
    model: string
    provider: string
    scope: 'main'
  } | null
  // True when sign-in succeeded AND a relay-valid key was provisioned. False
  // means login worked but the backend relay-key endpoint isn't deployed yet —
  // the caller falls back to the BYOK onboarding.
  hasRelayKey?: boolean
  message?: string
  ok: boolean
}

// Cached platform client-config state, as returned by
// hermesDesktop.clientConfig.get() (a local disk read — no network). version 0
// / payload null means nothing has been fetched yet. payload carries the
// server contract's fields (v1: config_yaml — a dotted-key → scalar map);
// unknown fields ride along for forward compat and are ignored.
export interface DesktopClientConfigState {
  version: number
  payload: Record<string, unknown> | null
  appliedVersion: number
}

// One side (installed or admin-latest) of an engine version, as derived by
// electron/apex-runtime-latest.cjs. `version` is the human label; `key` is the
// install.sh COS/source key (commit or branch) used to compare installed vs
// latest. Both can be null on an older marker that didn't record them.
export interface DesktopRuntimeVersionRef {
  version: string | null
  key: string | null
}

// Result of hermesDesktop.runtime.getVersion() (R6) — the installed engine
// version read locally from the bootstrap marker. `ok:false` only on an
// unexpected read error (all fields null). No network is involved.
export interface DesktopRuntimeVersion {
  ok: boolean
  version: string | null
  commit: string | null
  branch: string | null
  key: string | null
  // hc-532 (gate 1): the shell's declared minimum engine (package.json
  // apexnodes.minEngineVersion), and whether the installed engine satisfies it.
  // meetsMinEngine FAILS OPEN — it is false ONLY when the engine is positively
  // behind the floor; unparseable/absent versions read true. The renderer uses
  // false to surface a non-blocking "engine needs update" prompt.
  minEngineVersion?: string | null
  meetsMinEngine?: boolean
  // hc-543: the commit the on-disk source tree was actually extracted at
  // (.hermes-source-commit provenance stamp), and whether it agrees with the
  // marker's pinnedCommit. treeMatchesMarker === false means the marker LIES —
  // the version label reflects an update that never landed on disk. null when
  // there is no stamp to check (git checkout / legacy tree) — treat as unknown.
  treeCommit?: string | null
  treeMatchesMarker?: boolean | null
}

// Result of hermesDesktop.runtime.checkUpdate(). ok:false only on an unexpected
// throw; an offline / no-admin-latest check resolves ok:true with
// updateAvailable:false and latest:null (no nagging).
export interface DesktopRuntimeUpdateCheck {
  ok: boolean
  updateAvailable: boolean
  current: DesktopRuntimeVersionRef
  latest: (DesktopRuntimeVersionRef & { compatibilityNotes?: string | null; minDesktopVersion?: string | null }) | null
  // hc-475 (F4): present only when a newer engine exists but this desktop shell
  // is too old to run it (min_desktop_version gate). updateAvailable is false in
  // that case (no clickable offer); the UI prompts the user to upgrade the app.
  desktopUpgradeRequired?: { minDesktopVersion: string | null; currentDesktopVersion: string | null } | null
  // Present only when ok is false (defensive — the handler swallows errors).
  error?: string
}

// Result of hermesDesktop.runtime.applyUpdate(). On success the pin is
// re-armed and the renderer must reload (reloadRequired) to drive bootstrap.
// `applied:false` with `alreadyCurrent` means the installed engine already
// matches admin-latest. On failure, `error` is a stable code such as
// 'no_admin_latest_available' or 'update_artifact_unreachable'.
export interface DesktopRuntimeUpdateApply {
  ok: boolean
  applied?: boolean
  alreadyCurrent?: boolean
  reloadRequired?: boolean
  latest?: (DesktopRuntimeVersionRef & { compatibilityNotes?: string | null; minDesktopVersion?: string | null }) | null
  error?: string
  // hc-475 (F4): on error==='min_desktop_version', the engine's required minimum
  // desktop version and the current shell version (for the upgrade prompt).
  required?: string | null
  current?: string | null
  message?: string
  freeBytes?: number
  requiredBytes?: number
}

export type DesktopRuntimeUpdateProgressPhase = 'activating' | 'complete' | 'downloading' | 'preflight' | 'verifying'

export interface DesktopRuntimeUpdateProgress {
  phase: DesktopRuntimeUpdateProgressPhase
  received?: number
  total?: number | null
  attempt?: number
}

// 壳自更新状态机快照(electron/shell-updater.cjs 推送/查询的同一形状)。
// disabled = dev/未打包停用;downloading 全程静默(UI 不渲染);downloaded =
// 新壳就位等重启(侧栏胶囊唯一渲染的相位);error 只记日志,下轮周期检查自愈。
export type DesktopShellUpdatePhase = 'available' | 'checking' | 'disabled' | 'downloaded' | 'downloading' | 'error' | 'idle'

export interface DesktopShellUpdateState {
  phase: DesktopShellUpdatePhase
  // electron-updater 的裸 semver(如 0.16.1);idle/checking 阶段为 null。
  version: string | null
  // 下载进度 0-100;非下载阶段 null。
  percent: number | null
  error: string | null
  // hc-447: human-readable release notes carried through from electron-updater's
  // UpdateInfo (sourced from latest.yml's `releaseNotes:` field, hand-authored at
  // release time per NEXT-TAG-BUMP-CHECKLIST.md). null when the release shipped
  // with no authored notes — not an error state, the capsule just shows the bare
  // version in that case (same as before hc-447).
  releaseNotes: string | null
}

export interface DesktopUpdatePlan {
  schemaVersion: 1
  planId: string | null
  kind: DesktopUpdatePlanKind
  phase: DesktopUpdatePlanPhase
  requestedAt: string
  createdAt: string
  updatedAt: string
  currentShellVersion: string | null
  targetShellVersion: string | null
  currentRuntimeKey: string | null
  currentRuntimeVersion: string | null
  targetRuntimeKey: string | null
  targetRuntimeVersion: string | null
  attempts: number
  lastError: string | null
}

export type DesktopUpdatePlanKind = 'runtime-after-shell' | 'shell-only'
export type DesktopUpdatePlanPhase = 'failed' | 'ready-to-restart' | 'resuming'

// hc-452: distinguishes a re-bootstrap for an opt-in runtime version UPDATE
// (main.cjs's hermes:runtime:apply-update dropped the marker and re-runs the
// bootstrap against a pending pin override) from a genuine first-ever
// install (no prior runtime on disk). The install overlay uses this to show
// "updating to vX" instead of "APEX needs a one-time install" -- both are
// literally the same 10-stage bootstrap protocol underneath, but a runtime
// update is not a "one-time setup" and calling it that on every version bump
// misleads the user (hc-452 origin: Kael real-machine 2026-07-08 report).
export interface DesktopBootstrapUpdateInfo {
  isUpdate: boolean
  // The version being installed. Populated once bootstrapStamp resolves in
  // main.cjs (before that -- e.g. the eager synthetic manifest emitted while
  // the network fetch for the manifest is still in flight -- this is null).
  toVersion: string | null
  // The version being replaced, when known (from the runtime-pin override's
  // previousMarker snapshot). null for a first install, or when the prior
  // marker didn't carry a version label.
  fromVersion: string | null
}

export interface HermesWorktreeInfo {
  // Main repo root — the shared grouping key for a checkout and all its linked
  // worktrees.
  repoRoot: string
  // This cwd's own worktree root.
  worktreeRoot: string
  // True when this is the repo's primary checkout (.git is a directory).
  isMainWorktree: boolean
  // Current branch (or short detached-HEAD sha), null when unreadable.
  branch: null | string
}

// Result of hermesDesktop.createProjectDir(). `ok:true` carries the absolute
// `path` of the freshly created folder; on failure `code` is a stable marker
// (invalid-name / invalid-path / ENOENT / ENOTDIR / EEXIST / mkdir-error) and
// `error` a human message.
export interface HermesCreateProjectResult {
  ok: boolean
  path: null | string
  error: null | string
  code: null | string
}
