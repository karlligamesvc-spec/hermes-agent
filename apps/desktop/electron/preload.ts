import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'

// Which translucency the OS can back. Asked synchronously because the renderer
// needs it before its first paint, and answered by main because deciding it
// needs `os.release()` — a sandboxed preload may only require electron, events,
// timers and url, so importing node:os here throws before contextBridge runs
// and takes the ENTIRE bridge down with it (window.hermesDesktop undefined =>
// "Desktop IPC bridge is unavailable"). No reply means no glass, which degrades
// to an ordinary opaque window rather than a page thinned over nothing.
const translucencySupport = ipcRenderer.sendSync('hermes:translucency:support')
const hudWindowing = ipcRenderer.sendSync('hermes:hud:windowing')
const hudNativeDrag = hudWindowing?.nativeDrag === true

contextBridge.exposeInMainWorld('hermesDesktop', {
  glassSupported: translucencySupport?.glass === true,
  translucencySupported: translucencySupport?.translucency === true,
  getConnection: profile => ipcRenderer.invoke('hermes:connection', profile),
  // Registry-scoped backend resolution: { connectionId, profile } → descriptor.
  getConnectionFor: payload => ipcRenderer.invoke('hermes:connection:for', payload),
  getProfileRoutes: profiles => ipcRenderer.invoke('hermes:plugin-profile-routes', profiles),
  revalidateConnection: () => ipcRenderer.invoke('hermes:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('hermes:backend:touch', profile),
  getGatewayWsUrl: profile => ipcRenderer.invoke('hermes:gateway:ws-url', profile),
  // Registry-scoped fresh WS URL: { connectionId, profile } → result shape of
  // getGatewayWsUrl, minted against that connection's backend.
  getGatewayWsUrlFor: payload => ipcRenderer.invoke('hermes:gateway:ws-url-for', payload),
  // Union agent roster across every registered connection.
  getAgentRoster: () => ipcRenderer.invoke('hermes:agents:roster'),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('hermes:window:openSession', sessionId, opts),
  openSessionInTerminal: (sessionId, opts) => ipcRenderer.invoke('hermes:window:openInTerminal', sessionId, opts),
  openWindow: () => ipcRenderer.invoke('hermes:window:openInstance'),
  openBrowserWindow: tabId => ipcRenderer.invoke('hermes:window:openBrowser', tabId),
  onBrowserPopoutClosed: callback => {
    const listener = (_event, tabId) => callback(tabId)
    ipcRenderer.on('hermes:browser-popout:closed', listener)

    return () => ipcRenderer.removeListener('hermes:browser-popout:closed', listener)
  },
  claimAmbientCue: key => ipcRenderer.invoke('hermes:ambient:claim', key),
  openNewSessionWindow: () => ipcRenderer.invoke('hermes:window:openNewSession'),
  wakeIndicator: {
    getState: () => ipcRenderer.invoke('hermes:wake-indicator:get'),
    setState: state => ipcRenderer.send('hermes:wake-indicator:set', state),
    onState: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('hermes:wake-indicator:state', listener)

      return () => ipcRenderer.removeListener('hermes:wake-indicator:state', listener)
    }
  },
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ bounds, screen }`; resolves with the screen bounds it actually used.
    open: request => ipcRenderer.invoke('hermes:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('hermes:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('hermes:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('hermes:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('hermes:pet-overlay:set-focusable', focusable),
    // Main renderer → overlay (forwarded by main): push the latest pet state.
    pushState: payload => ipcRenderer.send('hermes:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer submit.
    control: payload => ipcRenderer.send('hermes:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:state', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:control', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:control', listener)
    }
  },
  // HUD mode: the chrome-free floating chat. A full app renderer (own gateway)
  // sized as a floating bar, so it mounts the real composer. Main owns the
  // window; `onChanged` keeps every window's toggle truthful.
  hud: {
    nativeDrag: hudNativeDrag,
    windowing: {
      clientPlacement: hudWindowing?.clientPlacement !== false,
      controlDrag: hudWindowing?.controlDrag === true,
      nativeDrag: hudNativeDrag,
      solid: hudWindowing?.solid === true,
      workspaceTransfer: hudWindowing?.workspaceTransfer === true
    },
    open: request => ipcRenderer.invoke('hermes:hud:open', request),
    close: () => ipcRenderer.invoke('hermes:hud:close'),
    setIgnoreMouse: ignore => ipcRenderer.send('hermes:hud:ignore-mouse', ignore),
    beginMove: () => ipcRenderer.send('hermes:hud:begin-move'),
    endMove: () => ipcRenderer.send('hermes:hud:end-move'),
    moveBy: delta => ipcRenderer.send('hermes:hud:move-by', delta),
    setWorkspaceTransfer: transferring => ipcRenderer.send('hermes:hud:workspace-transfer', transferring),
    setBounds: bounds => ipcRenderer.send('hermes:hud:set-bounds', bounds),
    resetLayout: () => ipcRenderer.invoke('hermes:hud:reset-layout'),
    // Whether the band covers the window below the bar. Main pairs it with the
    // user's translucency setting to decide the native frost (macOS vibrancy /
    // Windows 11 DWM backdrop) — see hudFrostFor.
    setFrost: showing => ipcRenderer.invoke('hermes:hud:frost', showing),
    // The HUD tells main which session it is on; main hands that back to the
    // app window when the HUD closes, so the app can re-home onto it.
    setSession: sessionId => ipcRenderer.send('hermes:hud:session', sessionId),
    onGoto: callback => {
      const listener = (_event, sessionId) => callback(sessionId)
      ipcRenderer.on('hermes:hud:goto', listener)

      return () => ipcRenderer.removeListener('hermes:hud:goto', listener)
    },
    onChanged: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('hermes:hud:changed', listener)

      return () => ipcRenderer.removeListener('hermes:hud:changed', listener)
    },
    // Linux only, and silent elsewhere: where the cursor is, in page
    // coordinates, or null when it has left the window. Stands in for the
    // mousemove that `setIgnoreMouseEvents(true, { forward: true })` delivers on
    // macOS and Windows but not here.
    onCursor: callback => {
      const listener = (_event, point) => callback(point)
      ipcRenderer.on('hermes:hud:cursor', listener)

      return () => ipcRenderer.removeListener('hermes:hud:cursor', listener)
    },
    // Main's game-overlay watch: whether a fullscreen app (a game) is under
    // the HUD, so the renderer can step back to the low-opacity overlay
    // treatment while one owns the screen.
    onGameOverlay: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('hermes:hud:game-overlay', listener)

      return () => ipcRenderer.removeListener('hermes:hud:game-overlay', listener)
    }
  },
  // Quick Entry: the global-hotkey mini composer window. Main owns the OS
  // shortcut + the persisted preference; the quick window only captures text
  // and hands it back, and the primary renderer submits it through the normal
  // prompt path.
  quickEntry: {
    getSettings: () => ipcRenderer.invoke('hermes:quick-entry:settings:get'),
    setSettings: patch => ipcRenderer.invoke('hermes:quick-entry:settings:set', patch),
    submit: payload => ipcRenderer.send('hermes:quick-entry:submit', payload),
    dismiss: () => ipcRenderer.send('hermes:quick-entry:dismiss'),
    pushState: payload => ipcRenderer.send('hermes:quick-entry:state', payload),
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:quick-entry:state', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:state', listener)
    },
    onSubmit: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:quick-entry:submit', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:submit', listener)
    },
    onShown: callback => {
      const listener = () => callback()
      ipcRenderer.on('hermes:quick-entry:shown', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:shown', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('hermes:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('hermes:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:test', payload),
  // Opt-in OS-keychain encryption for stored gateway secrets (default off —
  // see secret-storage-policy.ts). get never touches the OS keychain.
  getSecretStorageEncryption: () => ipcRenderer.invoke('hermes:secret-storage:get'),
  setSecretStorageEncryption: (on: boolean) => ipcRenderer.invoke('hermes:secret-storage:set', on),
  // v2 multi-connection registry: named agent sources (local / remote / cloud / ssh).
  connections: {
    list: () => ipcRenderer.invoke('hermes:connections:list'),
    save: payload => ipcRenderer.invoke('hermes:connections:save', payload),
    remove: id => ipcRenderer.invoke('hermes:connections:remove', id),
    setPrimary: id => ipcRenderer.invoke('hermes:connections:set-primary', id),
    setLaunchMode: mode => ipcRenderer.invoke('hermes:connections:set-launch-mode', mode),
    setLastUsed: id => ipcRenderer.invoke('hermes:connections:set-last-used', id),
    test: id => ipcRenderer.invoke('hermes:connections:test', id),
    updateManaged: id => ipcRenderer.invoke('hermes:connections:update-managed', id),
    // Fan out `hermes update` to every eligible registered connection.
    // Optional excludeIds skips rows the caller updates through another path.
    updateAll: options => ipcRenderer.invoke('hermes:connections:update-all', options),
    // Registry lifecycle push (main → renderer): a connection was removed or
    // materially edited, so secondaries scoped to it must be disposed (and,
    // for edits, re-dialed at the new target).
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:connections:changed', listener)

      return () => ipcRenderer.removeListener('hermes:connections:changed', listener)
    }
  },
  sshConfigHosts: () => ipcRenderer.invoke('hermes:ssh-config:hosts'),
  sshResolveHost: host => ipcRenderer.invoke('hermes:ssh-config:resolve', host),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:oauth-logout', remoteUrl),
  // Hermes Cloud: one portal login powers discovery + silent per-agent sign-in
  // (cloud-auto-discovery Phase 3).
  cloud: {
    status: () => ipcRenderer.invoke('hermes:cloud:status'),
    login: () => ipcRenderer.invoke('hermes:cloud:login'),
    logout: () => ipcRenderer.invoke('hermes:cloud:logout'),
    discover: org => ipcRenderer.invoke('hermes:cloud:discover', org),
    agentSignIn: dashboardUrl => ipcRenderer.invoke('hermes:cloud:agent-sign-in', dashboardUrl)
  },
  profile: {
    get: () => ipcRenderer.invoke('hermes:profile:get'),
    remember: name => ipcRenderer.invoke('hermes:profile:remember', name),
    set: name => ipcRenderer.invoke('hermes:profile:set', name)
  },
  // ApexNodes managed-LLM (zero-key) default path. See electron/apex-managed.cjs.
  managed: {
    status: () => ipcRenderer.invoke('hermes:managed:status'),
    // hc-512: live relay model-catalog state for the model menu ('ok' |
    // 'unauthorized' | 'unreachable' | 'unknown'); { refresh: true } re-probes.
    relayCatalog: opts => ipcRenderer.invoke('hermes:managed:relayCatalog', opts),
    signIn: payload => ipcRenderer.invoke('hermes:managed:signIn', payload),
    browserSignIn: payload => ipcRenderer.invoke('hermes:managed:browserSignIn', payload),
    // hc-530: web → desktop one-click login. Exchange the one-time handoff code
    // (from the apexnodes://login deep link) for a session — same result shape as
    // browserSignIn.
    deepLinkSignIn: payload => ipcRenderer.invoke('hermes:managed:deepLinkSignIn', payload),
    signOut: () => ipcRenderer.invoke('hermes:managed:signOut'),
    // On-demand relay-key self-heal after a chat turn hit a relay auth error
    // (HTTP 401/403): re-provision + report whether it healed or the user must
    // sign in again. See electron/main.cjs hermes:managed:selfHeal.
    selfHeal: () => ipcRenderer.invoke('hermes:managed:selfHeal')
  },
  workflowDomain: {
    access: () => ipcRenderer.invoke('hermes:workflowDomain:access'),
    startGoal: payload => ipcRenderer.invoke('hermes:workflowDomain:startGoal', payload),
    listProjects: options => ipcRenderer.invoke('hermes:workflowDomain:listProjects', options),
    listWorkflows: options => ipcRenderer.invoke('hermes:workflowDomain:listWorkflows', options),
    getCatalog: () => ipcRenderer.invoke('hermes:workflowDomain:getCatalog'),
    getRun: runId => ipcRenderer.invoke('hermes:workflowDomain:getRun', runId),
    cancelRun: runId => ipcRenderer.invoke('hermes:workflowDomain:cancelRun', runId),
    reviewDeliverable: payload => ipcRenderer.invoke('hermes:workflowDomain:reviewDeliverable', payload)
  },
  // hc-444: desktop ↔ cloud Feishu bridge — mirror the signed-in user's own
  // Feishu app credential down to light up the Feishu adapter + lark tools. See
  // electron/apex-feishu.cjs. No secret crosses to the renderer: status returns
  // only display fields; sync/disconnect return status objects.
  feishu: {
    status: () => ipcRenderer.invoke('hermes:feishu:status'),
    sync: () => ipcRenderer.invoke('hermes:feishu:sync'),
    disconnect: () => ipcRenderer.invoke('hermes:feishu:disconnect'),
    openBind: () => ipcRenderer.invoke('hermes:feishu:openBind')
  },
  // hc-447: 更新日志 (changelog) entry point — reads the hc-446 announcement
  // feed (same content the web /app/whats-new page shows), scoped to the
  // signed-in ApexNodes account. Read-only: list + a best-effort read
  // receipt. See electron/apex-announcements.cjs.
  announcements: {
    list: () => ipcRenderer.invoke('hermes:announcements:list'),
    markRead: announcementId => ipcRenderer.invoke('hermes:announcements:markRead', announcementId)
  },
  // hc-417: Desktop IM 入口 — connect the local agent to an IM platform by
  // scanning a QR / pasting one code. feishu registers an INDEPENDENT app via
  // the cloud v2 provisioning flow (renderer owns the polling loop: issue →
  // poll* → success; main fetches + stores the credential on success). No
  // secret crosses to the renderer: list returns display fields; the credential
  // is persisted encrypted + injected into the backend spawn env.
  // See electron/apex-im-entry.cjs.
  imEntry: {
    list: () => ipcRenderer.invoke('hermes:imEntry:list'),
    feishuIssue: () => ipcRenderer.invoke('hermes:imEntry:feishuIssue'),
    feishuPoll: provisionId => ipcRenderer.invoke('hermes:imEntry:feishuPoll', provisionId),
    weixinIssue: () => ipcRenderer.invoke('hermes:imEntry:weixinIssue'),
    weixinPoll: provisionId => ipcRenderer.invoke('hermes:imEntry:weixinPoll', provisionId),
    unbind: channelId => ipcRenderer.invoke('hermes:imEntry:unbind', channelId)
  },
  // hc-533 本机 Agent 调度 — the A2A daemon leg. The settings block toggles the
  // reverse-connect daemon (default off), names the device, and unregisters. No
  // secret crosses to the renderer: status returns only display fields; the
  // device token is stored encrypted in main. onStatus subscribes to the live
  // status main pushes on connection transitions. See electron/apex-daemon.cjs.
  daemon: {
    status: () => ipcRenderer.invoke('hermes:daemon:status'),
    setEnabled: enabled => ipcRenderer.invoke('hermes:daemon:setEnabled', enabled),
    setDeviceName: name => ipcRenderer.invoke('hermes:daemon:setDeviceName', name),
    unregister: () => ipcRenderer.invoke('hermes:daemon:unregister'),
    onStatus: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:daemon:status', listener)

      return () => ipcRenderer.removeListener('hermes:daemon:status', listener)
    }
  },
  // hc-545 coding-agent account connection — the three-state (logged_out /
  // unreachable / ready) detector for the user's own claude/codex CLIs plus the
  // in-app OAuth hosting. No secret ever crosses to the renderer: status returns
  // only display fields; OAuth credentials land in each CLI's own store, never
  // in main or the renderer. See electron/apex-agent-auth.cjs.
  agentAuth: {
    status: () => ipcRenderer.invoke('hermes:agentAuth:status'),
    connect: family => ipcRenderer.invoke('hermes:agentAuth:connect', family)
  },
  // hc-545 coding-agent network proxy — auto (follow macOS system proxy) /
  // custom / off. Governs the HTTP(S)_PROXY fragment injected into the agent's
  // env (with a mainland-China NO_PROXY whitelist). See electron/apex-agent-proxy.cjs.
  agentProxy: {
    get: () => ipcRenderer.invoke('hermes:agentProxy:get'),
    set: payload => ipcRenderer.invoke('hermes:agentProxy:set', payload)
  },
  // Platform client-config sync — informational read of the cached versioned
  // config (no network). Application happens in the MAIN process pre-gateway
  // (main.cjs applyClientConfigToRuntime); the renderer no longer applies.
  clientConfig: {
    get: () => ipcRenderer.invoke('hermes:clientConfig:get')
  },
  // Continuous auth gate: main broadcasts when a backend call returns 401
  // (login lost) or 403 account_disabled (account abnormal). The renderer
  // clears auth and returns to the login screen. See main.cjs broadcastAuthGate.
  onAuthGate: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:auth-gate', listener)

    return () => ipcRenderer.removeListener('hermes:auth-gate', listener)
  },
  // Runtime 3-end consistency — desktop opt-in engine update (R5). checkUpdate
  // compares the installed runtime against the admin-set default; applyUpdate
  // re-points the pin and re-runs bootstrap (renderer reloads when
  // reloadRequired is true). Both are safe no-ops offline.
  runtime: {
    // R6: installed engine version, read locally from the bootstrap marker.
    // No network / no state change — the About panel calls this on open.
    getVersion: () => ipcRenderer.invoke('hermes:runtime:version'),
    checkUpdate: () => ipcRenderer.invoke('hermes:runtime:check-update'),
    applyUpdate: () => ipcRenderer.invoke('hermes:runtime:apply-update'),
    onUpdateProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:runtime-update:progress', listener)

      return () => ipcRenderer.removeListener('hermes:runtime-update:progress', listener)
    }
  },
  // 壳(Electron 应用本体)自更新 — electron-updater,和上面的引擎(runtime)
  // 更新是两条通道。机制全在主进程(electron/shell-updater.cjs):静默检查+
  // 下载,状态经 onEvent 推给侧栏胶囊;install = quitAndInstall(应用退出重装)。
  shellUpdate: {
    getState: () => ipcRenderer.invoke('hermes:shell-update:get'),
    check: () => ipcRenderer.invoke('hermes:shell-update:check'),
    install: () => ipcRenderer.invoke('hermes:shell-update:install'),
    onEvent: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:shell-update:event', listener)

      return () => ipcRenderer.removeListener('hermes:shell-update:event', listener)
    }
  },
  updateCenter: {
    getPlan: () => ipcRenderer.invoke('hermes:update-center:plan:get'),
    setRuntimeAfterShell: payload => ipcRenderer.invoke('hermes:update-center:plan:set-runtime-after-shell', payload),
    setShellOnly: payload => ipcRenderer.invoke('hermes:update-center:plan:set-shell-only', payload),
    transitionPlan: payload => ipcRenderer.invoke('hermes:update-center:plan:transition', payload),
    clearPlan: () => ipcRenderer.invoke('hermes:update-center:plan:clear')
  },
  api: request => ipcRenderer.invoke('hermes:api', request),
  notify: payload => ipcRenderer.invoke('hermes:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('hermes:requestMicrophoneAccess'),
  readWindowBelow: () => ipcRenderer.invoke('hermes:window:readBelow'),
  readFileDataUrl: filePath => ipcRenderer.invoke('hermes:readFileDataUrl', filePath),
  readFileDataUrlForAttach: filePath => ipcRenderer.invoke('hermes:readFileDataUrlForAttach', filePath),
  dataUrlReadMax: {
    get: () => ipcRenderer.invoke('hermes:data-url-read-max:get'),
    set: maxMb => ipcRenderer.invoke('hermes:data-url-read-max:set', maxMb)
  },
  readFileText: filePath => ipcRenderer.invoke('hermes:readFileText', filePath),
  readPluginSource: (filePath: string) => ipcRenderer.invoke('hermes:readPluginSource', filePath),
  selectPaths: options => ipcRenderer.invoke('hermes:selectPaths', options),
  selectSavePath: options => ipcRenderer.invoke('hermes:selectSavePath', options),
  writeClipboard: text => ipcRenderer.invoke('hermes:writeClipboard', text),
  readClipboard: () => ipcRenderer.invoke('hermes:readClipboard'),
  saveGatewayFile: payload => ipcRenderer.invoke('hermes:saveGatewayFile', payload),
  saveImageFromUrl: url => ipcRenderer.invoke('hermes:saveImageFromUrl', url),
  contextMenuEdit: command => ipcRenderer.invoke('hermes:context-menu:edit', command),
  contextMenuCopyImage: () => ipcRenderer.invoke('hermes:context-menu:copy-image'),
  contextMenuSpellcheck: action => ipcRenderer.invoke('hermes:context-menu:spellcheck', action),
  contextMenuGuestAddWord: payload => ipcRenderer.invoke('hermes:context-menu:guest-add-word', payload),
  onContextMenuSpellcheck: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:context-menu-spellcheck', listener)

    return () => ipcRenderer.removeListener('hermes:context-menu-spellcheck', listener)
  },
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('hermes:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('hermes:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('hermes:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('hermes:watchPreviewFile', url),
  watchDirectory: dir => ipcRenderer.invoke('hermes:watchDirectory', dir),
  stopPreviewFileWatch: id => ipcRenderer.invoke('hermes:stopPreviewFileWatch', id),
  setActiveWork: payload => ipcRenderer.send('hermes:active-work', payload),
  setTitleBarTheme: payload => ipcRenderer.send('hermes:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('hermes:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('hermes:translucency', payload),
  setKeepAwake: on => ipcRenderer.send('hermes:keep-awake', on),
  setDisableF12: blocked => ipcRenderer.send('hermes:devtools:disable-f12', blocked),
  setPreviewShortcutActive: active => ipcRenderer.send('hermes:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('hermes:openExternal', url),
  mcpOauth: {
    // One-shot loopback listener for MCP OAuth against remote backends: bind
    // on this machine, hand redirectUri to mcp.servers.oauth.start, then wait
    // for the provider redirect and relay code/state via oauth.callback.
    listen: () => ipcRenderer.invoke('hermes:mcp-oauth:listen'),
    wait: (id, timeoutMs) => ipcRenderer.invoke('hermes:mcp-oauth:wait', id, timeoutMs),
    cancel: id => ipcRenderer.invoke('hermes:mcp-oauth:cancel', id)
  },
  openPreviewInBrowser: url => ipcRenderer.invoke('hermes:openPreviewInBrowser', url),
  reachPreviewUrl: url => ipcRenderer.invoke('hermes:preview:reach', url),
  setActiveConnectionRoute: route => ipcRenderer.send('hermes:connection:active-route', route),
  fetchLinkTitle: url => ipcRenderer.invoke('hermes:fetchLinkTitle', url),
  resolveFavicon: url => ipcRenderer.invoke('hermes:resolveFavicon', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('hermes:workspace:sanitize', cwd),
  createProjectDir: (parentDir, name) => ipcRenderer.invoke('hermes:workspace:createDir', parentDir, name),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('hermes:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:pick')
  },
  zoom: {
    // Current zoom of this window, as { level, percent }.
    get: () => ipcRenderer.invoke('hermes:zoom:get'),
    // Synchronous zoom factor (1 = 100%). Coordinate math needs it in the
    // same tick as the event it converts, so no IPC round-trip here.
    factor: () => webFrame.getZoomFactor(),
    setPercent: percent => ipcRenderer.send('hermes:zoom:set-percent', percent),
    // Fires on every zoom change, including the Ctrl/Cmd +/-/0 shortcuts,
    // so the settings UI can stay in sync with the keyboard.
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:zoom:changed', listener)

      return () => ipcRenderer.removeListener('hermes:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('hermes:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('hermes:logs:recent'),
  // Fire-and-forget: persists a renderer error-boundary catch (with component
  // stack) to desktop.log so crashes survive the window (#79428).
  reportRendererError: report => ipcRenderer.send('hermes:logs:renderer-error', report),
  readDir: dirPath => ipcRenderer.invoke('hermes:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('hermes:fs:gitRoot', startPath),
  worktrees: cwds => ipcRenderer.invoke('hermes:fs:worktrees', cwds),
  revealPath: targetPath => ipcRenderer.invoke('hermes:fs:reveal', targetPath),
  openDir: dirPath => ipcRenderer.invoke('hermes:fs:openDir', dirPath),
  desktopPluginsRoot: () => ipcRenderer.invoke('hermes:fs:desktopPluginsRoot'),
  logsRoot: () => ipcRenderer.invoke('hermes:fs:logsRoot'),
  agentPluginsRoot: () => ipcRenderer.invoke('hermes:fs:agentPluginsRoot'),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('hermes:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('hermes:fs:writeText', filePath, content),
  trashPath: targetPath => ipcRenderer.invoke('hermes:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('hermes:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('hermes:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('hermes:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('hermes:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('hermes:git:branchList', repoPath),
    baseBranchList: repoPath => ipcRenderer.invoke('hermes:git:baseBranchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('hermes:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('hermes:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('hermes:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('hermes:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('hermes:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('hermes:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('hermes:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('hermes:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('hermes:git:review:shipInfo', repoPath),
      prList: (repoPath, branches, numbers) =>
        ipcRenderer.invoke('hermes:git:review:prList', repoPath, branches, numbers),
      fetchPrComment: (repoPath, url) => ipcRenderer.invoke('hermes:git:review:fetchPrComment', repoPath, url),
      createPr: repoPath => ipcRenderer.invoke('hermes:git:review:createPr', repoPath)
    }
  },
  terminal: {
    cwd: id => ipcRenderer.invoke('hermes:terminal:cwd', id),
    dispose: id => ipcRenderer.invoke('hermes:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('hermes:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('hermes:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('hermes:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `hermes:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `hermes:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:close-preview-requested', listener)

    return () => ipcRenderer.removeListener('hermes:close-preview-requested', listener)
  },
  onPreviewNav: callback => {
    const listener = (_event, command) => callback(command)
    ipcRenderer.on('hermes:preview-nav', listener)

    return () => ipcRenderer.removeListener('hermes:preview-nav', listener)
  },
  onOpenFolderRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-folder-requested', listener)

    return () => ipcRenderer.removeListener('hermes:open-folder-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-updates', listener)

    return () => ipcRenderer.removeListener('hermes:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:deep-link', listener)

    return () => ipcRenderer.removeListener('hermes:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('hermes:deep-link-ready'),
  probePluginRepo: payload => ipcRenderer.invoke('hermes:plugin:probe', payload),
  installDesktopPlugin: payload => ipcRenderer.invoke('hermes:plugin:installDesktop', payload),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:window-state-changed', listener)

    return () => ipcRenderer.removeListener('hermes:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('hermes:focus-session', listener)

    return () => ipcRenderer.removeListener('hermes:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:notification-action', listener)

    return () => ipcRenderer.removeListener('hermes:notification-action', listener)
  },
  onNotificationActivate: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:notification-activate', listener)

    return () => ipcRenderer.removeListener('hermes:notification-activate', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:preview-file-changed', listener)

    return () => ipcRenderer.removeListener('hermes:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:backend-exit', listener)

    return () => ipcRenderer.removeListener('hermes:backend-exit', listener)
  },
  // Soft gateway-mode apply finished tearing down the primary backend. Renderer
  // should wipe session lists + re-dial without a window reload.
  onConnectionApplied: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:connection:applied', listener)

    return () => ipcRenderer.removeListener('hermes:connection:applied', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:power-resume', listener)

    return () => ipcRenderer.removeListener('hermes:power-resume', listener)
  },
  getOnBattery: () => ipcRenderer.invoke('hermes:power-battery:get'),
  onBatteryChanged: callback => {
    const listener = (_event, onBattery) => callback(Boolean(onBattery))
    ipcRenderer.on('hermes:power-battery', listener)

    return () => ipcRenderer.removeListener('hermes:power-battery', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:boot-progress', listener)

    return () => ipcRenderer.removeListener('hermes:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.ts (apps/desktop/electron/bootstrap-runner.ts).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('hermes:bootstrap:get'),
  continueBootstrapLocal: () => ipcRenderer.invoke('hermes:bootstrap:continue-local'),
  resetBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:bootstrap:event', listener)

    return () => ipcRenderer.removeListener('hermes:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('hermes:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('hermes:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('hermes:uninstall:summary'),
    run: mode => ipcRenderer.invoke('hermes:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('hermes:updates:check'),
    apply: opts => ipcRenderer.invoke('hermes:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('hermes:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('hermes:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:updates:progress', listener)

      return () => ipcRenderer.removeListener('hermes:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('hermes:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('hermes:vscode-theme:search', query)
  },
  findInPage: (query, options) => ipcRenderer.invoke('hermes:find-in-page', query, options),
  stopFindInPage: () => ipcRenderer.invoke('hermes:stop-find-in-page'),
  onFoundInPage: callback => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('hermes:found-in-page', listener)

    return () => ipcRenderer.removeListener('hermes:found-in-page', listener)
  },
  // hc-554 场景目录 — the desktop scenario shelf + ✦ menu read the shared catalog
  // (cloud GET /media/scenario-catalog, agent-key auth + TTL) via main, which
  // owns the key + cache. Returns the catalog JSON or null (renderer falls back
  // to its built-in catalog). See electron/apex-scenario-catalog.cjs.
  scenarioCatalog: {
    get: () => ipcRenderer.invoke('hermes:scenarioCatalog:get')
  },
  // Main-process `before-input-event` forwards Ctrl/Cmd+F here so renderer
  // can open the FindBar even when the GTK compositor has already grabbed
  // the chord at the windowing layer (#81727).
  onOpenFindBarRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-find-bar', listener)

    return () => ipcRenderer.removeListener('hermes:open-find-bar', listener)
  }
})
