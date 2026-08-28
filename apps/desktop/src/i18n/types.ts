// Desktop i18n type contract.
//
// `Translations` is the single source of truth for every translatable string
// surface. Fully translated locale files may satisfy this interface directly;
// partial locales should use `defineLocale()` so missing desktop-only strings
// fall back to English while new keys remain type-checked.

interface UninstallOptionCopy {
  title: string
  description: string
  consequence: string
}

export type Locale = 'en' | 'zh' | 'zh-hant' | 'ja' | 'ar'

export type ToolTitleKey =
  | 'browser_click'
  | 'browser_fill'
  | 'browser_navigate'
  | 'browser_snapshot'
  | 'browser_take_screenshot'
  | 'browser_type'
  | 'clarify'
  | 'cronjob'
  | 'edit_file'
  | 'execute_code'
  | 'image_generate'
  | 'list_files'
  | 'memory'
  | 'patch'
  | 'read_file'
  | 'search_files'
  | 'session_search_recall'
  | 'terminal'
  | 'todo'
  | 'vision_analyze'
  | 'web_extract'
  | 'web_search'
  | 'write_file'

interface ToolTitleCopy {
  done: string
  pending: string
  pendingAction: string
}

interface ModeOptionCopy {
  label: string
  description: string
}

interface AuxTaskCopy {
  label: string
  hint: string
}

export interface Translations {
  common: {
    apply: string
    back: string
    save: string
    saving: string
    cancel: string
    change: string
    choose: string
    clear: string
    close: string
    collapse: string
    confirm: string
    connect: string
    connecting: string
    continue: string
    copied: string
    copy: string
    copyFailed: string
    delete: string
    docs: string
    done: string
    error: string
    expand: string
    failed: string
    formatJson: string
    free: string
    loading: string
    notSet: string
    refresh: string
    remove: string
    replace: string
    retry: string
    run: string
    send: string
    set: string
    skip: string
    update: string
    tryHint: (term: string) => string
    on: string
    off: string
    // hc-591: the localized noun used to prefix a humanized engine (runtime)
    // version for display, e.g. "Engine 2026.7.25" / "引擎 2026.7.25" — see
    // lib/engine-display.ts::formatEngineDisplayVersion. Kept as a bare word
    // (no trailing space) so the call site controls the join.
    engineVersionPrefix: string
  }

  fileMenu: {
    revealFinder: string
    revealExplorer: string
    revealFileManager: string
    revealInSidebar: string
    copyPath: string
    copyRelativePath: string
    rename: string
    delete: string
    renameTitle: string
    renameLabel: string
    deleteTitle: (name: string) => string
    deleteBody: string
    pathCopied: string
  }

  boot: {
    ready: string
    desktopBootFailedWithMessage: (message: string) => string
    steps: {
      connectingGateway: string
      loadingSettings: string
      loadingSessions: string
      startingDesktopConnection: string
      startingHermesDesktop: string
    }
    errors: {
      backgroundExited: string
      backgroundExitedDuringStartup: string
      backendStopped: string
      desktopBootFailed: string
      gatewayConnectionLost: string
      gatewaySignInRequired: string
      ipcBridgeUnavailable: string
    }
    failure: {
      title: string
      description: string
      remoteTitle: string
      remoteDescription: string
      retry: string
      repairInstall: string
      useLocalGateway: string
      gatewaySettings: string
      back: string
      openLogs: string
      repairHint: string
      remoteSignInHint: (signInLabel: string) => string
      signOutAndSignIn: string
      remoteFailureHint: string
      hideRecentLogs: string
      showRecentLogs: string
      signedInTitle: string
      signedInMessage: string
      signInIncompleteTitle: string
      signInIncompleteMessage: string
      signInFailed: string
      signInToRemoteGateway: string
      signInWithProvider: (provider: string) => string
      identityProvider: string
      // Friendly, user-facing replacements for common raw bootstrap errors
      // (the raw transcript stays available behind the "show recent logs"
      // expander). `unknown` is the generic fallback when no pattern matches.
      errorMap: {
        cancelled: string
        prerequisites: string
        network: string
        unknown: string
      }
    }
  }

  notifications: {
    region: string
    hide: string
    show: string
    more: (count: number) => string
    clearAll: string
    dismiss: string
    details: string
    copyDetail: string
    copyDetailFailed: string
    backendOutOfDateTitle: string
    backendOutOfDateMessage: string
    installMethodUnsupportedTitle: string
    updateHermes: string
    updateReadyTitle: string
    updateReadyMessage: (count: number) => string
    seeWhatsNew: string
    errors: {
      elevenLabsNeedsKey: string
      elevenLabsRejectedKey: string
      diskFull: string
      gatewayAuthFailed: string
      methodNotAllowed: string
      microphonePermission: string
      openaiRejectedApiKey: string
      openaiRejectedApiKeyWithStatus: (status: string) => string
      openaiTtsNeedsKey: string
    }
    voice: {
      configureSpeechToText: string
      couldNotStartSession: string
      microphoneAccessDenied: string
      microphoneConstraintsUnsupported: string
      microphoneFailed: string
      microphoneInUse: string
      microphonePermissionDenied: string
      microphoneStartFailed: string
      microphoneUnsupported: string
      noMicrophone: string
      noSpeechDetected: string
      playbackFailed: string
      recordingFailed: string
      sayStopToEnd: (phrase: string) => string
      transcriptionFailed: string
      transcriptionUnavailable: string
      tryRecordingAgain: string
      unavailable: string
    }
    // Native OS notification copy (titles + generic fallback bodies). Dynamic
    // bodies (the agent's reply, a command, an error) are passed through raw.
    native: {
      approvalTitle: string
      approveAction: string
      rejectAction: string
      inputTitle: string
      inputBody: string
      turnDoneTitle: string
      turnDoneBody: string
      turnErrorTitle: string
      backgroundDoneTitle: string
      backgroundFailedTitle: string
      creditsTitle: string
    }
  }

  remoteDisplayBanner: {
    message: (reason: string) => string
  }

  billingBlock: {
    titleNous: string
    titleProvider: (provider: string) => string
    fallbackMessage: string
    openBilling: string
    addCredits: string
    dismiss: string
  }

  titlebar: {
    hideSidebar: string
    showSidebar: string
    search: string
    searchTitle: string
    swapSidebarSides: string
    hideRightSidebar: string
    showRightSidebar: string
    muteHaptics: string
    unmuteHaptics: string
    openSettings: string
    openStarmap: string
    openKeybinds: string
    layoutEditor: string
    layoutEditorTitle: string
  }

  keybinds: {
    title: string
    subtitle: (open: string) => string
    search: string
    rebind: string
    reset: string
    resetAll: string
    pressKey: string
    set: string
    conflictWith: (label: string) => string
    categories: Record<string, string>
    actions: Record<string, string>
  }

  // Find-in-page bar (⌘F). `close` reuses common.close.
  findInPage: {
    next: string
    previous: string
  }

  language: {
    label: string
    description: string
    saving: string
    saveError: string
    switchTo: string
    searchPlaceholder: string
    noResults: string
  }

  settings: {
    closeSettings: string
    exportConfig: string
    importConfig: string
    resetToDefaults: string
    resetConfirm: string
    exportFailed: string
    resetFailed: string
    nav: {
      providers: string
      providerAccounts: string
      providerApiKeys: string
      providerCustomEndpoints: string
      gateway: string
      apiKeys: string
      keybinds: string
      keysTools: string
      keysSettings: string
      mcp: string
      archivedChats: string
      about: string
      billing: string
      notifications: string
      plugins: string
    }
    plugins: {
      title: string
      blurb: string
      count: (n: number) => string
      openFolder: string
      rescan: string
      reveal: string
      enable: string
      disable: string
      failed: string
      empty: string
      kinds: { bundled: string; disk: string; runtime: string }
    }
    notifications: {
      title: string
      intro: string
      enableAll: string
      enableAllDesc: string
      focusedHint: string
      kinds: Record<
        'approval' | 'backgroundDone' | 'credits' | 'input' | 'turnDone' | 'turnError',
        { label: string; description: string }
      >
      test: string
      testTitle: string
      testBody: string
      testSent: string
      testUnsupported: string
      completionSoundTitle: string
      completionSoundDesc: string
      completionSoundPreview: string
    }
    sections: Record<string, string>
    searchPlaceholder: Record<'about' | 'config' | 'gateway' | 'keys' | 'mcp' | 'sessions', string>
    modeOptions: Record<'light' | 'dark' | 'system', ModeOptionCopy>
    appearance: {
      title: string
      intro: string
      colorMode: string
      colorModeDesc: string
      toolViewTitle: string
      toolViewDesc: string
      uiScaleTitle: string
      uiScaleDesc: (percent: number) => string
      terminalFontTitle: string
      terminalFontDesc: string
      terminalFontPlaceholder: string
      terminalFontPreview: string
      terminalFontReset: string
      translucencyTitle: string
      translucencyDesc: string
      backdropTitle: string
      backdropDesc: string
      reactionsTitle: string
      reactionsDesc: string
      embedsTitle: string
      embedsDesc: string
      embedsAsk: string
      embedsAlways: string
      embedsOff: string
      embedsReset: (count: number) => string
      product: string
      productDesc: string
      technical: string
      technicalDesc: string
      themeTitle: string
      themeDesc: string
      themeProfileNote: (profile: string) => string
      installTitle: string
      installDesc: string
      installPlaceholder: string
      installButton: string
      installing: string
      installError: string
      installed: (name: string) => string
      removeTheme: string
      importedBadge: string
      pet: {
        title: string
        intro: string
        restartHint: string
        on: string
        off: string
        scaleTitle: string
        scaleDesc: string
        roamTitle: string
        roamDesc: string
        chooseTitle: string
        chooseDesc: string
        searchPlaceholder: string
        unreachable: string
        noMatch: (query: string) => string
        installedTag: string
        generatedTag: string
        countCapped: (cap: number, total: number) => string
        count: (n: number) => string
        uninstall: (name: string) => string
        delete: (name: string) => string
        deleteTitle: (name: string) => string
        deleteBody: string
        deleteConfirm: string
        rename: (name: string) => string
        renameTitle: string
        renamePlaceholder: string
        renameSave: string
        exportPet: (name: string) => string
        adoptFailed: (slug: string) => string
        uninstallFailed: (slug: string) => string
        renameFailed: (slug: string) => string
        exportFailed: (slug: string) => string
        noneAvailable: string
        turnOnFailed: string
        turnOffFailed: string
      }
    }
    fieldLabels: Record<string, string>
    fieldDescriptions: Record<string, string>
    about: {
      heading: string
      version: (value: string) => string
      versionUnavailable: string
      updates: string
      checkNow: string
      checking: string
      seeWhatsNew: string
      updateNow: string
      releaseNotes: string
      onLatest: string
      installing: string
      cantUpdate: string
      cantReach: string
      tapCheck: string
      updateReady: (count: number) => string
      lastChecked: (age: string) => string
      justNowSuffix: string
      automaticUpdates: string
      automaticUpdatesDesc: string
      branchCommit: (branch: string, commit: string) => string
      never: string
      justNow: string
      minAgo: (count: number) => string
      hoursAgo: (count: number) => string
      daysAgo: (count: number) => string
      // Engine (runtime) opt-in update — R5/R6 of runtime 3-end consistency.
      // hc-591: `value` on engineVersion/engineFound/engineConfirmBody/
      // engineUpdateNeededDetail (and localAgent.engineOutdated below) is now
      // ALREADY display-formatted by formatEngineDisplayVersion before it
      // reaches these functions — e.g. "Engine 2026.7.25", not the raw
      // "v2026.7.25-fork.b0a720a5" pin. Because that formatted value already
      // carries the localized "engine" noun, these four templates (across all
      // locales) had their own immediately-adjacent "engine"/"引擎"/"エンジン"
      // word removed to avoid a doubled-up "Engine version Engine 2026.7.25"
      // read — see each locale file's value for the exact wording.
      engineSection: string
      engineVersion: (value: string) => string
      engineVersionUnavailable: string
      engineCheck: string
      engineChecking: string
      engineUpToDate: string
      engineTapCheck: string
      engineFound: (value: string) => string
      engineFoundGeneric: string
      engineDesktopUpgradeRequired: (value: string) => string
      engineCompatNotes: string
      engineApply: string
      engineApplying: string
      engineCantReach: string
      engineConfirmTitle: string
      engineConfirmBody: (value: string) => string
      engineConfirmBodyGeneric: string
      engineConfirmApply: string
      // hc-532 (gate 1): shown when the installed engine is older than the
      // shell's declared minimum (package.json apexnodes.minEngineVersion).
      // Non-blocking — points the user at the opt-in engine update below.
      engineUpdateNeeded: string
      engineUpdateNeededDetail: (value: string) => string
      // hc-543: shown when the bootstrap marker's version disagrees with the
      // source tree actually on disk (a botched .git-less update stamped a new
      // version over unchanged files). The version label is NOT trustworthy;
      // re-running the engine update re-extracts the correct tree.
      engineTreeMismatch: string
      engineTreeMismatchDetail: string
      // hc-447: 更新日志 (changelog) entry — reads the hc-446 announcement feed.
      changelogTitle: string
      changelogIntro: string
      changelogView: string
      changelogEmpty: string
      changelogLoadError: string
      changelogNeedsSignIn: string
    }
    config: {
      none: string
      noneParen: string
      builtinOnly: string
      notSet: string
      commaSeparated: string
      searchPlaceholder: string
      noResults: string
      systemDefault: string
      loading: string
      emptyTitle: string
      emptyDesc: string
      failedLoad: string
      autosaveFailed: string
      imported: string
      invalidJson: string
      keepAwakeTitle: string
      keepAwakeDesc: string
      attachmentSizeTitle: string
      attachmentSizeDesc: string
      attachmentSizeUnit: string
      attachmentSizeLabel: string
    }
    quickEntry: {
      enabledTitle: string
      enabledDesc: string
      shortcutTitle: string
      shortcutDesc: string
      active: string
      takenBy: string
      invalidShortcut: string
    }
    credentials: {
      pasteKey: string
      pasteLabelKey: (label: string) => string
      optional: string
      enterValueFirst: string
      couldNotSave: string
      remove: string
      getKey: string
      saving: string
    }
    envActions: {
      actions: string
      manageInKeys: string
      docs: string
      hideValue: string
      revealValue: string
      replace: string
      set: string
      clear: string
    }
    gateway: {
      loading: string
      unavailableTitle: string
      unavailableDesc: string
      title: string
      envOverride: string
      intro: string
      appliesTo: string
      allProfiles: string
      defaultConnection: string
      profileConnection: (profile: string) => string
      envOverrideTitle: string
      envOverrideDesc: string
      modeTitle: string
      localTitle: string
      localDesc: string
      inheritTitle: string
      inheritDesc: string
      remoteTitle: string
      remoteDesc: string
      remoteAuthHint: string
      cloudTitle: string
      cloudDesc: string
      cloudSignInTitle: string
      cloudSignIn: string
      cloudSignedIn: string
      cloudNeedsSignIn: string
      cloudSignedInDesc: string
      cloudAgentsTitle: string
      cloudOrgPickerTitle: string
      cloudOrgSelect: string
      cloudOrgChange: string
      cloudOrgRole: (role: string) => string
      cloudLoadingAgents: string
      cloudNoAgents: { before: string; linkText: string; after: string }
      cloudRefresh: string
      cloudConnect: string
      cloudConnecting: string
      cloudDiscoverFailed: string
      cloudConnectFailed: string
      cloudSignInFailed: string
      cloudSignedOutTitle: string
      cloudSignedOutMessage: string
      cloudConnectedTitle: string
      cloudConnectedPill: string
      cloudConnectedTo: (name: string) => string
      cloudAgentProvisioning: string
      cloudStatusLabel: (status: string) => string
      remoteUrlTitle: string
      remoteUrlDesc: string
      probing: string
      probeError: string
      signedIn: string
      signIn: string
      signOut: string
      signInWith: (provider: string) => string
      authTitle: string
      authSignedInPassword: string
      authSignedInOauth: string
      authNeedsPassword: string
      authNeedsOauth: (provider: string) => string
      tokenTitle: string
      tokenDesc: string
      existingToken: (value: string) => string
      savedToken: string
      pasteSessionToken: string
      testRemote: string
      saveForRestart: string
      saveAndReconnect: string
      diagnostics: string
      diagnosticsDesc: string
      openLogs: string
      incompleteTitle: string
      incompleteSignIn: string
      incompleteToken: string
      incompleteSignInTest: string
      incompleteTokenTest: string
      enterUrlFirst: string
      restartingTitle: string
      savedTitle: string
      restartingMessage: string
      savedMessage: string
      connectedTo: (baseUrl: string, version?: string) => string
      reachableTitle: string
      signedOutTitle: string
      signedOutMessage: string
      failedLoad: string
      signInFailed: string
      signOutFailed: string
      testFailed: string
      applyFailed: string
      saveFailed: string
      sshTitle: string
      sshDesc: string
      sshTrustHint: string
      sshHostTitle: string
      sshHostDesc: string
      sshHostPick: string
      sshHostPickTitle: string
      sshHostPickDesc: string
      sshHostCustom: string
      sshUserTitle: string
      sshUserDesc: string
      sshUserPlaceholder: string
      sshPortTitle: string
      sshPortDesc: string
      sshKeyTitle: string
      sshKeyDesc: string
      sshHermesPathTitle: string
      sshHermesPathDesc: string
      sshHermesPathPlaceholder: string
      sshRemoteProfileTitle: string
      sshRemoteProfileDesc: string
      sshTestConnection: string
      sshConnect: string
      sshButtonsHint: string
      sshReachable: (host: string, platform: string) => string
      sshIncompleteHost: string
      sshErrUnreachable: string
      sshErrAuth: string
      sshErrHostKey: string
      sshErrNotInstalled: string
      sshErrPlatform: string
      sshErrTimeout: string
      sshErrUpdateRequired: string
      sshErrUnknown: string
    }
    keys: {
      loading: string
      failedLoad: string
      empty: string
    }
    mcp: {
      loading: string
      failedLoad: string
      nameRequiredTitle: string
      nameRequiredMessage: string
      objectRequired: string
      invalidJson: string
      saveFailed: string
      removeFailed: string
      gatewayUnavailableTitle: string
      gatewayUnavailableMessage: string
      reloadedTitle: string
      reloadedMessage: string
      reloadFailed: string
      savedTitle: string
      savedMessage: (name: string) => string
      newServer: string
      reload: string
      reloading: string
      emptyTitle: string
      emptyDesc: string
      disabled: string
      editServer: string
      name: string
      serverJson: string
      remove: string
      saveServer: string
      test: string
      testing: string
      testOk: (count: number) => string
      testFailed: string
      enableServer: (name: string) => string
      disableServer: (name: string) => string
      serverEnabled: (name: string) => string
      serverDisabled: (name: string) => string
      toggleFailed: (name: string, enabled: boolean) => string
      tabServers: string
      tabCatalog: string
      catalogLoading: string
      catalogLoadFailed: string
      catalogEmpty: string
      catalogInstalled: string
      catalogEnabled: string
      catalogNeedsInstall: string
      catalogInstall: string
      catalogInstalling: string
      catalogInstallStarted: (name: string) => string
      catalogInstallFailed: (name: string) => string
      catalogEnvPrompt: (name: string) => string
      catalogEnvRequired: string
      capabilitySummary: (tools: number, prompts: number, resources: number) => string
      statusConnecting: string
      statusNeedsAuth: string
      statusError: string
      statusOff: string
      allServers: string
      authenticatedTitle: string
      authenticatedMessage: (server: string, count: number) => string
      waitingForBrowser: string
      authenticate: string
      unsavedConnect: string
      enableTool: (tool: string) => string
      disableTool: (tool: string) => string
      noOutput: string
    }
    model: {
      selectTitle: string
      selectHint: string
      selectedShort: (count: number) => string
      selectedSummary: (count: number) => string
      loading: string
      appliesDesc: string
      provider: string
      model: string
      applying: string
      defaultsLabel: string
      reasoning: string
      reasoningOff: string
      defaultsFailed: string
      auxiliaryTitle: string
      resetAllToMain: string
      auxiliaryDesc: string
      setToMain: string
      change: string
      autoUseMain: string
      providerDefault: string
      fallbackAdd: string
      fallbackEmpty: string
      notInCatalog: string
      requestFailed: string
      staleAux: (count: number, names: string, provider: string) => string
      staleAuxOtherProviders: string
      byoTitle: string
      byoHint: string
      byoMixNote: string
      noModels: string
      tasks: Record<string, AuxTaskCopy>
    }
    uninstall: {
      dangerZone: string
      checking: string
      title: string
      chooseDesc: string
      confirmTitle: string
      confirmBody: (consequence: string) => string
      appPath: (path: string) => string
      uninstalling: string
      confirmYes: string
      startFailed: string
      options: {
        gui: UninstallOptionCopy
        lite: UninstallOptionCopy
        full: UninstallOptionCopy
      }
    }
    providers: {
      connectAccount: string
      haveApiKey: string
      intro: string
      connected: string
      collapse: string
      connectAnother: string
      otherProviders: string
      disconnect: string
      disconnectInTerminal: string
      removeConfirm: (provider: string) => string
      removeExternalGeneric: (provider: string) => string
      removeKeyManaged: (provider: string) => string
      removeTerminalConfirm: (provider: string, command: string) => string
      removeTerminalRunning: (provider: string) => string
      removedTitle: string
      removedMessage: (provider: string) => string
      failedRemove: (provider: string) => string
      noProviderKeys: string
      searchKeys: string
      noKeysMatch: string
      localEndpoint: {
        title: string
        description: string
      }
      loading: string
    }
    sessions: {
      loading: string
      archivedTitle: string
      archivedIntro: string
      emptyArchivedTitle: string
      emptyArchivedDesc: string
      unarchive: string
      deletePermanently: string
      messages: (count: number) => string
      restored: string
      deleteConfirm: (title: string) => string
      autoArchiveTitle: string
      autoArchiveDesc: string
      autoArchiveDaysLabel: string
      autoArchiveDaysUnit: string
      autoArchiveFailed: string
      defaultDirTitle: string
      defaultDirDesc: string
      defaultDirUpdated: string
      defaultsTo: (label: string) => string
      change: string
      choose: string
      clear: string
      notSet: string
      failedLoad: string
      unarchiveFailed: string
      deleteFailed: string
      updateDirFailed: string
      clearDirFailed: string
    }
    toolsets: {
      loadingConfig: string
      savedTitle: string
      savedMessage: (key: string) => string
      removedTitle: string
      removedMessage: (key: string) => string
      failedSave: (key: string) => string
      failedRemove: (key: string) => string
      failedReveal: (key: string) => string
      removeConfirm: (key: string) => string
      set: string
      notSet: string
      selectedTitle: string
      selectedMessage: (provider: string) => string
      failedSelect: (provider: string) => string
      failedLoad: string
      noProviderOptions: string
      noProviders: string
      ready: string
      needsSignIn: string
      needsSetup: string
      activeBackend: string
      activeBackendHint: string
      useBackend: string
      nousIncluded: string
      nousAuthNeededTitle: string
      nousAuthNeededMessage: (provider: string) => string
      nousAuthSignIn: string
      nousAuthDoneTitle: string
      nousAuthDoneMessage: string
      nousAuthFailed: string
      noApiKeyRequired: string
      postSetupHint: (step: string) => string
      postSetupInstalledHint: string
      postSetupRun: string
      postSetupRerun: string
      postSetupInstalled: string
      postSetupRunning: string
      postSetupStarting: string
      postSetupCompleteTitle: string
      postSetupCompleteMessage: (step: string) => string
      postSetupErrorTitle: string
      postSetupErrorMessage: (step: string) => string
      postSetupFailed: (step: string) => string
      webSearchActive: (backend: string) => string
      webExtractActive: (backend: string) => string
      webCapabilityUnset: string
      webUseForSearch: string
      webUseForExtract: string
      webUsedForSearch: string
      webUsedForExtract: string
      webCapabilitySelectedMessage: (provider: string, capability: string) => string
      failedSelectCapability: (provider: string) => string
      loadingModels: string
      modelSectionTitle: string
      modelCount: (count: number) => string
      modelInUse: string
      modelDefault: string
      modelInactiveHint: string
      modelSelectedTitle: string
      modelSelectedMessage: (model: string) => string
      failedSelectModel: (model: string) => string
      terminalBackend: {
        sectionTitle: string
        loading: string
        failedLoad: string
        ready: string
        needsSetup: string
        unavailable: string
        inUse: string
        selectedTitle: string
        selectedMessage: (backend: string) => string
        failedSelect: (backend: string) => string
        needsSetupHint: string
      }
    }
    // hc-545: coding-agent account connection card. Detects the three-state
    // login status of the user's own claude/codex CLIs (the passthrough/daemon
    // legs drive them) and hosts an in-app OAuth + system-proxy autopilot.
    agentAuth: {
      title: string
      intro: string
      checking: string
      refresh: string
      // Per-state one-liners (the anti-conflation core — logged_out ≠ unreachable).
      stateReady: string
      stateReadyEmail: (email: string) => string
      stateLoggedOut: string
      stateUnreachable: string
      stateNoCli: string
      stateUnknown: string
      // Action buttons per state.
      connect: string
      reconnect: string
      fixNetwork: string
      // no_cli install hints.
      installHint: string
      // OAuth follow-up.
      opening: string
      waitingBrowser: string
      completed: string
      // Honest degrade: run this command in a terminal.
      guideIntro: string
      copyCommand: string
      copied: string
      // Network proxy sub-block.
      proxyTitle: string
      proxyIntro: string
      proxyModeAuto: string
      proxyModeAutoHint: string
      proxyModeCustom: string
      proxyModeOff: string
      proxyModeOffHint: string
      proxyDetected: (url: string) => string
      proxyNone: string
      proxyCustomLabel: string
      proxyCustomPlaceholder: string
      proxyInvalid: string
      save: string
      saved: string
    }
    localAgent: {
      title: string
      intro: string
      enableLabel: string
      enableHint: string
      statusLabel: string
      statusDormant: string
      statusConnecting: string
      statusOnline: string
      statusOffline: string
      statusError: string
      deviceNameLabel: string
      deviceNamePlaceholder: string
      unregister: string
      unregisterConfirm: string
      signInFirst: string
      saved: string
      enableFailed: string
      // hc-532 (gate 1): shown in the daemon block when the installed engine is
      // older than the shell's declared minimum — the daemon's tool leg would
      // silently fail on a stale engine, so surface it explicitly here.
      engineOutdated: (value: string) => string
    }
    // 个性化 — the consumer landing section (人格 picker + SOUL.md + the former
    // About content).
    personalization: {
      personalityTitle: string
      personalityIntro: string
      soulTitle: string
      soulIntro: string
    }
    // hc-444: "Connect Feishu" card copy.
    feishu: {
      title: string
      intro: string
      connectedTitle: string
      connectedTo: (agent: string) => string
      connectedGeneric: string
      statusOk: string
      statusExpired: string
      statusInvalid: string
      statusStale: string
      sync: string
      resync: string
      syncing: string
      disconnect: string
      disconnectConfirm: string
      signInFirstTitle: string
      signInFirst: string
      noEntryTitle: string
      noEntry: string
      openBind: string
      afterBind: string
      syncedTitle: string
      syncedMessage: string
      disconnectedTitle: string
      disconnectedMessage: string
      syncFailed: string
      sessionExpired: string
      loading: string
    }
  }

  skills: {
    tabSkills: string
    tabToolsets: string
    tabMcp: string
    tabHub: string
    all: string
    searchSkills: string
    searchToolsets: string
    refresh: string
    refreshing: string
    loading: string
    noSkillsTitle: string
    noSkillsDesc: string
    noToolsetsTitle: string
    noToolsetsDesc: string
    noDescription: string
    configured: string
    needsKeys: string
    visionModelHint: string
    visionModelLink: string
    toolsetsEnabled: (enabled: number, total: number) => string
    configureToolset: (label: string) => string
    toggleToolset: (label: string, enabled: boolean) => string
    skillsLoadFailed: string
    toolsetsRefreshFailed: string
    skillEnabled: string
    skillDisabled: string
    toolsetEnabled: string
    toolsetDisabled: string
    appliesToNewSessions: (name: string) => string
    failedToUpdate: (name: string) => string
    sortMostUsed: string
    sortAlpha: string
    sortMostUsedDesc: string
    sortLeastUsedAsc: string
    enableAll: string
    disableAll: string
    disableUnused: string
    bulkUpdated: (count: number) => string
    bulkNoChange: string
    usageCount: (count: number | string) => string
    provenance: Record<'agent' | 'bundled' | 'hub', string>
    emptyNoneFound: (noun: string) => string
    emptyNothingMatches: (query: string) => string
    emptyNoneAvailable: (noun: string) => string
    changesApplyNewSessions: string
    skillUpdated: string
    edit: string
    archive: string
    skillArchivedTitle: string
    skillArchivedMessage: string
    hub: {
      searchPlaceholder: string
      search: string
      searching: string
      connectingHubs: string
      connectedHubs: string
      featured: string
      landingHint: string
      noResults: string
      resultCount: (count: number, ms: number | null) => string
      timedOut: (sources: string) => string
      installed: string
      install: string
      installing: string
      uninstall: string
      uninstalling: string
      updateAll: string
      updating: string
      preview: string
      scan: string
      scanning: string
      close: string
      files: string
      noReadme: string
      trust: Record<string, string>
      verdictSafe: string
      verdictCaution: string
      verdictDangerous: string
      policyAllow: string
      policyAsk: string
      policyBlock: string
      findings: (count: number) => string
      noFindings: string
      installStarted: (name: string) => string
      uninstallStarted: (name: string) => string
      updateStarted: string
      actionFailed: string
      actionLog: string
      loadFailed: string
      previewFailed: string
      scanFailed: string
      searchFailed: string
    }
  }

  starmap: {
    title: string
    subtitle: (nodes: number, clusters: number) => string
    close: string
    refresh: string
    memory: string
    filterAll: string
    filterUsed: string
    filterLearned: string
    viewGraph: string
    loadFailed: string
    loading: string
    emptyTitle: string
    emptyDesc: string
    share: string
    shareHint: string
    shareTitle: string
    sharePlaceholder: string
    copy: string
    copied: string
    importMap: string
    importBtn: string
    importEmpty: string
    importSuccess: (nodes: number) => string
    importedBadge: string
    resetToMine: string
  }
  agents: {
    close: string
    title: string
    subtitle: string
    emptyTitle: string
    emptyDesc: string
    running: string
    failed: string
    done: string
    streaming: string
    files: string
    moreFiles: (count: number) => string
    delegation: (index: number) => string
    workers: (count: number) => string
    workersActive: (count: number) => string
    agentsCount: (count: number) => string
    activeCount: (count: number) => string
    failedCount: (count: number) => string
    toolsCount: (count: number) => string
    filesCount: (count: number) => string
    updatedAgo: (age: string) => string
    ageNow: string
    ageSeconds: (seconds: number) => string
    ageMinutes: (minutes: number) => string
    ageHours: (hours: number) => string
    ageDays: (days: number) => string
    durationSeconds: (seconds: string) => string
    durationMinutes: (minutes: number, seconds: number) => string
    tokens: (value: number | string) => string
  }

  commandCenter: {
    close: string
    paletteTitle: string
    back: string
    searchPlaceholder: string
    goTo: string
    goToSession: string
    branches: string
    projects: string
    openFolder: string
    openFolderAt: (path: string) => string
    newSessionInProject: (project: string) => string
    commands: string
    startInBranch: (branch: string) => string
    commandCenter: string
    appearance: string
    settings: string
    changeTheme: string
    changeColorMode: string
    pets: {
      title: string
      placeholder: string
      loading: string
      error: string
      staleBackend: string
      empty: string
      turnOff: string
      turnOn: string
      installed: string
      generatedTag: string
      adoptFailed: string
      toggleFailed: (enabled: boolean) => string
      noneAvailable: string
    }
    generatePet: {
      title: string
      placeholder: string
      promptHint: string
      readyHint: string
      generate: string
      generating: string
      retry: string
      hatch: string
      spawning: string
      hatching: string
      hatchingSub: string
      hatched: string
      hatchRow: (state: string, done: number, total: number) => string
      hatchComposing: string
      hatchSaving: string
      namePlaceholder: string
      staleBackend: string
      backgroundHint: string
      slowProviderHint: string
      remix: string
      remixConfirmTitle: string
      remixConfirmBody: string
      genericError: string
      referenceImageTooLarge: string
      referenceImageInvalid: string
      adopt: string
      startOver: string
    }
    installTheme: {
      title: string
      pageTitle: string
      placeholder: string
      loading: string
      error: string
      empty: string
      install: string
      installing: string
      installed: string
      installs: (count: string) => string
    }
    settingsFields: string
    mcpServers: string
    archivedChats: string
    sections: Record<'maintenance' | 'sessions' | 'system' | 'usage', string>
    sectionDescriptions: Record<'maintenance' | 'sessions' | 'system' | 'usage', string>
    nav: Record<'newChat' | 'settings' | 'skills' | 'messaging' | 'artifacts', { title: string; detail: string }>
    sectionEntries: Record<'sessions' | 'system' | 'usage', { title: string; detail: string }>
    providerNavigate: string
    providerSessions: string
    refresh: string
    refreshing: string
    noResults: string
    pinSession: string
    unpinSession: string
    exportSession: string
    deleteSession: string
    noSessions: string
    gatewayRunning: string
    gatewayStopped: string
    hermesActiveSessions: (version: string, count: number) => string
    restartGateway: string
    gatewayRestartFailed: string
    checkDesktopUpdate: string
    checkingDesktopUpdate: string
    desktopUpdateReady: string
    desktopUpdatePreparing: string
    desktopUpdateNeedsShell: string
    desktopUpdateCheckFailed: string
    desktopUpToDate: string
    actionRunning: string
    actionDone: string
    actionFailed: string
    actionStartedWaiting: string
    loadingStatus: string
    recentLogs: string
    noLogs: string
    days: (count: number) => string
    statSessions: string
    statApiCalls: string
    statTokens: string
    statCost: string
    actualCost: (cost: string) => string
    loadingUsage: string
    noUsage: (period: number) => string
    retry: string
    dailyTokens: string
    input: string
    output: string
    noDailyActivity: string
    topModels: string
    noModelUsage: string
    topSkills: string
    noSkillActivity: string
    actions: (count: string) => string
    logFile: string
    logLevel: string
    logSearchPlaceholder: string
    maintenance: {
      runOps: string
      doctor: string
      doctorDesc: string
      securityAudit: string
      securityAuditDesc: string
      backup: string
      backupDesc: string
      debugShare: string
      debugShareDesc: string
      debugShareRunning: string
      debugShareLinks: string
      debugShareFailed: string
      copyLink: string
      linkCopied: string
      curator: string
      curatorDesc: string
      curatorPaused: string
      curatorActive: string
      curatorDisabled: string
      curatorLastRun: (when: string) => string
      curatorNeverRan: string
      pause: string
      resume: string
      runNow: string
      memoryData: string
      memoryDataDesc: string
      memoryProvider: (name: string) => string
      builtinMemory: string
      memoryFile: string
      userFile: string
      bytes: (size: string) => string
      empty: string
      resetMemory: string
      resetUser: string
      resetAll: string
      resetConfirm: (target: string) => string
      resetDone: (files: string) => string
      resetFailed: string
      actionStarted: (name: string) => string
      actionFailed: (name: string) => string
      running: string
      viewLog: string
    }
  }

  messaging: {
    search: string
    loading: string
    loadFailed: string
    states: Record<string, string>
    unknown: string
    hintPendingRestart: string
    hintGatewayStopped: string
    credentialsSet: string
    needsSetup: string
    gatewayStopped: string
    getCredentials: string
    openSetupGuide: string
    required: string
    recommended: string
    advanced: (count: number) => string
    noTokenNeeded: string
    enabled: string
    disabled: string
    unsavedChanges: string
    saving: string
    saveChanges: string
    saved: string
    replaceValue: string
    openDocs: string
    clearField: (key: string) => string
    enableAria: (name: string) => string
    disableAria: (name: string) => string
    platformEnabled: (name: string) => string
    platformDisabled: (name: string) => string
    restartToApply: string
    setupSaved: (name: string) => string
    restartToReconnect: string
    keyCleared: (key: string) => string
    setupUpdated: (name: string) => string
    failedUpdate: (name: string) => string
    failedSave: (name: string) => string
    failedClear: (key: string) => string
    pendingRequests: (count: number) => string
    pendingAria: (count: number) => string
    approvedUsers: (count: number) => string
    approve: string
    approving: string
    revoke: string
    revoking: string
    revokeAria: (name: string) => string
    revokeTitle: string
    revokeDesc: (name: string) => string
    approvedUser: (name: string) => string
    approvedHint: string
    revokedUser: (name: string) => string
    failedApprove: (name: string) => string
    failedRevoke: (name: string) => string
    pairingLockedOut: string
    waitingSince: (minutes: number) => string
    fieldCopy: Record<string, { label?: string; help?: string; placeholder?: string }>
    platformIntro: Record<string, string>
  }

  webhooks: {
    search: string
    loading: string
    loadFailed: string
    subscriptions: (count: number) => string
    hint: string
    empty: string
    disabledTitle: string
    disabledBody: string
    enable: string
    enabling: string
    enabled: (name: string) => string
    disabled: (name: string) => string
    enableRow: string
    disableRow: string
    delete: string
    deleting: string
    deleted: string
    deleteTitle: string
    deleteDescPrefix: string
    deleteDescSuffix: string
    deleteFailed: (name: string) => string
    toggleFailed: (name: string, enabled: boolean) => string
    newSubscription: string
    restarting: string
    restartNeeded: string
    restartGateway: string
    restartingGateway: string
    restartFailed: (detail: string) => string
    enabledRestarting: string
    all: string
    deliverOnly: string
    createdTitle: string
    createdSecretHint: string
    webhookUrl: string
    secretOnce: string
    done: string
    fieldName: string
    fieldNamePlaceholder: string
    fieldDescription: string
    fieldDescriptionPlaceholder: string
    fieldEvents: string
    fieldEventsPlaceholder: string
    fieldSkills: string
    fieldSkillsPlaceholder: string
    fieldDeliver: string
    fieldDeliverOnly: string
    fieldPrompt: string
    fieldPromptPlaceholder: string
    nameRequired: string
    create: string
    creating: string
    created: string
    createFailed: (detail: string) => string
    copy: string
    deliverOptions: Record<string, string>
  }

  profiles: {
    close: string
    nameHint: string
    title: string
    count: (count: number) => string
    search: string
    loading: string
    newProfile: string
    allProfiles: string
    showAllProfiles: string
    switchToProfile: (name: string) => string
    manageProfiles: string
    actions: string
    color: string
    colorFor: string
    setColor: (color: string) => string
    autoColor: string
    noProfiles: string
    selectPrompt: string
    refresh: string
    refreshing: string
    default: string
    skills: (count: number) => string
    env: string
    defaultBadge: string
    rename: string
    renameMenu: string
    editSoul: string
    copySetup: string
    copying: string
    modelLabel: string
    skillsLabel: string
    notSet: string
    soulDesc: string
    soulOptional: string
    soulPlaceholder: (mode: string) => string
    soulPlaceholderCloned: string
    soulPlaceholderEmpty: string
    unsavedChanges: string
    loadingSoul: string
    emptySoul: string
    saving: string
    saveSoul: string
    deleteTitle: string
    deleteDescPrefix: string
    deleteDescMid: string
    deleteDescSuffix: string
    deleting: string
    createDesc: string
    nameLabel: string
    cloneFrom: string
    cloneFromNone: string
    cloneFromDesc: string
    cloneFromDefault: string
    cloneFromDefaultDesc: string
    invalidName: (hint: string) => string
    nameRequired: string
    creating: string
    createAction: string
    renameTitle: string
    renameDescPrefix: string
    renameDescSuffix: string
    newNameLabel: string
    renaming: string
    created: string
    renamed: string
    deleted: string
    setupCopied: string
    soulSaved: string
    failedLoad: string
    failedDelete: string
    failedCopy: string
    failedLoadSoul: string
    failedSaveSoul: string
    failedCreate: string
    failedRename: string
  }

  cron: {
    close: string
    title: string
    count: (count: number) => string
    search: string
    loading: string
    states: Record<string, string>
    deliveryLabels: Record<string, string>
    scheduleLabels: Record<string, string>
    scheduleHints: Record<string, string>
    days: Record<string, string>
    dayFallback: (value: string) => string
    everyDayAt: (time: string) => string
    weekdaysAt: (time: string) => string
    everyDayOfWeekAt: (day: string, time: string) => string
    monthlyOnDayAt: (dayOfMonth: string, time: string) => string
    topOfHour: string
    everyHourAt: (minute: string) => string
    newCron: string
    emptyDescNew: string
    emptyDescSearch: string
    emptyTitleNew: string
    emptyTitleSearch: string
    last: string
    next: string
    noRuns: string
    manage: string
    showRuns: string
    hideRuns: string
    runHistory: string
    actionsTitle: string
    resume: string
    pause: string
    resumeTitle: string
    pauseTitle: string
    triggerNow: string
    edit: string
    deleteTitle: string
    deleteDescPrefix: string
    deleteDescSuffix: string
    deleting: string
    resumed: string
    paused: string
    triggered: string
    deleted: string
    created: string
    updated: string
    failedLoad: string
    failedUpdate: string
    failedTrigger: string
    failedDelete: string
    failedSave: string
    editTitle: string
    createTitle: string
    editDesc: string
    createDesc: string
    nameLabel: string
    namePlaceholder: string
    promptLabel: string
    promptPlaceholder: string
    frequencyLabel: string
    deliverLabel: string
    deliverNeedsHomeChannel: string
    modelLabel: string
    modelDefault: string
    customScheduleLabel: string
    customPlaceholder: string
    customHint: string
    optional: string
    promptRequired: string
    promptScheduleRequired: string
    scheduleRequired: string
    scriptOnlyEditHint: string
    saveChanges: string
    createAction: string
    tabs: {
      jobs: string
      blueprints: string
    }
    blueprints: {
      tab: string
      startFrom: string
      custom: string
      subtitle: string
      dialogDesc: string
      scheduleIt: string
      scheduling: string
      scheduled: string
      loading: string
      failedLoad: string
      emptyTitle: string
      emptyDesc: string
    }
  }

  artifacts: {
    search: string
    refresh: string
    refreshing: string
    indexing: string
    tabAll: string
    tabImages: string
    tabFiles: string
    tabLinks: string
    noArtifactsTitle: string
    noArtifactsDesc: string
    failedLoad: string
    openFailed: string
    itemsImage: string
    itemsLink: string
    itemsFile: string
    itemsGeneric: string
    zero: string
    rangeOf: (start: number, end: number, total: number) => string
    goToPage: (itemLabel: string, page: number) => string
    colTitleLink: string
    colTitleFile: string
    colTitleDefault: string
    colLocationLink: string
    colLocationFile: string
    colLocationDefault: string
    colSession: string
    kindImage: string
    kindFile: string
    kindLink: string
    chat: string
    copyUrl: string
    copyPath: string
  }

  artifactCard: {
    kind: Record<'code' | 'html' | 'svg', string>
    generating: (lines: number) => string
    versionBadge: (count: number) => string
    open: string
  }

  artifactPreview: {
    versionOf: (current: number, total: number) => string
    olderVersion: string
    newerVersion: string
    latest: string
    copyContent: string
    download: string
    openInBrowser: string
    openInBrowserFailed: string
    missingTitle: string
    missingBody: string
  }

  sidebar: {
    nav: Record<string, string>
    searchAria: string
    searchPlaceholder: string
    clearSearch: string
    noMatch: (query: string) => string
    results: string
    pinned: string
    sessions: string
    cronJobs: string
    groupAriaGrouped: string
    groupAriaUngrouped: string
    showProjects: string
    showSessions: string
    groupTitleGrouped: string
    groupTitleUngrouped: string
    allPinned: string
    shiftClickHint: string
    noWorkspace: string
    projectEmpty: string
    noSessions: string
    projects: {
      sectionLabel: string
      home: string
      newButton: string
      createTitle: string
      createDesc: string
      renameTitle: string
      addFolderTitle: string
      namePlaceholder: string
      foldersLabel: string
      ideaLabel: string
      ideaPlaceholder: string
      ideaGenerate: string
      ideaGenerating: string
      ideaShuffle: string
      noFolders: string
      addFolder: string
      primaryBadge: string
      removeFolder: string
      create: string
      menu: string
      menuRename: string
      menuAppearance: string
      noColor: string
      menuAddFolder: string
      menuSetActive: string
      menuDelete: string
      reveal: string
      copyPath: string
      removeFromSidebar: string
      createFailed: string
      staleBackend: string
      deleteConfirm: string
      startWork: string
      newWorktreeTitle: string
      newWorktreeDesc: string
      branchPlaceholder: string
      branchOff: () => { after: string; before: string }
      baseBranchPlaceholder: string
      baseBranchNone: string
      startWorkFailed: string
      convertBranch: string
      convertBranchTitle: string
      convertBranchDesc: string
      convertBranchPlaceholder: string
      convertBranchInstead: string
      branchOpenExisting: string
      branchSwitchHome: string
      branchCreateWorktree: string
      branchesLoading: string
      noBranches: string
      removeWorktree: string
      removeWorktreeFailed: string
      removeWorktreeConfirm: string
      removeWorktreeDirty: string
      forceRemove: string
      enter: (label: string) => string
      reorder: (label: string) => string
      toggle: (label: string, open: boolean) => string
      back: string
    }
    newSessionIn: (label: string) => string
    showMoreIn: (count: number, label: string) => string
    loading: string
    loadMore: string
    loadCount: (step: number) => string
    row: {
      pin: string
      unpin: string
      copyId: string
      export: string
      branchFrom: string
      rename: string
      archive: string
      newWindow: string
      hideTabBar: string
      openInNewTab: string
      openInSplit: string
      copyIdFailed: string
      sessionActions: string
      sessionRunning: string
      needsInput: string
      waitingForAnswer: string
      finishedUnread: string
      backgroundRunning: string
      handoffOrigin: (platform: string) => string
      ownedByProfile: (profile: string) => string
      renamed: string
      renameFailed: string
      renameTitle: string
      renameDesc: string
      untitledPlaceholder: string
      untitledChat: (id: string) => string
      ageNow: string
      ageDay: string
      ageHour: string
      ageMin: string
    }
    engineUpdate: {
      found: string
      updating: string
      failedRolledBack: string
    }
    // 壳(应用本体)更新胶囊,三态各自可辨(hc-605):发现新版本 → 正在下载 →
    // 已就绪。installsOnQuit 是这组文案的要害:electron-updater 下载完只是把安装
    // 包放进 pending/,真正的安装发生在进程退出时——应用一直开着就永远装不上。
    // 不说这一句,用户会反复报「更新了还是老样子」(0728 连撞两次的真实事故)。
    shellUpdate: {
      foundTitle: (version: string) => string
      downloadingTitle: (version: string) => string
      downloadingInBackground: string
      downloadedPercent: (percent: number) => string
      readyTitle: (version: string) => string
      installsOnQuit: string
      restartNow: string
      restarting: string
    }
    desktopUpdate: {
      preparingTitle: (version: string) => string
      downloadedPercent: (percent: number) => string
      readyTitle: string
      appAndEngine: (appVersion: string, engineVersion: string) => string
      appOnly: (version: string) => string
      engineOnly: (version: string) => string
      installRestart: string
      installing: string
      confirmTitle: string
      confirmBody: string
      confirmApply: string
    }
    dateDivider: {
      today: string
      yesterday: string
      thisWeek: string
      lastWeek: string
      thisMonth: string
    }
  }

  composer: {
    message: string
    wakingProfile: (profile: string) => string
    placeholderStarting: string
    placeholderReconnecting: string
    placeholderFollowUp: string
    newSessionPlaceholders: readonly string[]
    followUpPlaceholders: readonly string[]
    startVoice: string
    openDirective: string
    queueMessage: string
    steer: string
    stop: string
    send: string
    speaking: string
    transcribing: string
    thinking: string
    muted: string
    listening: string
    muteMic: string
    unmuteMic: string
    stopListening: string
    stopShort: string
    endConversation: string
    endShort: string
    stopDictation: string
    transcribingDictation: string
    voiceDictation: string
    speakReplies: string
    stopSpeakingReplies: string
    wakeWordListening: (phrase: string) => string
    wakeWordOff: (phrase: string) => string
    wakeWordPausedVoice: (phrase: string) => string
    lookupLoading: string
    lookupNoMatches: string
    lookupTry: string
    lookupOr: string
    commonCommands: string
    hotkeys: string
    helpFooter: string
    commandDescs: Record<string, string>
    hotkeyDescs: Record<string, string>
    attachUrlTitle: string
    attachUrlDesc: string
    urlPlaceholder: string
    urlHintPre: string
    attach: string
    queued: (count: number) => string
    queuedPaused: (count: number) => string
    attachmentOnly: string
    emptyTurn: string
    attachments: (count: number) => string
    editingInComposer: string
    editingQueuedInComposer: string
    queueEdit: string
    queueSendNext: string
    queueSend: string
    queueDelete: string
    queueResume: string
    queueResumeTip: string
    queueStuckTitle: string
    queueStuckBody: string
    previewUnavailable: string
    previewLabel: (label: string) => string
    couldNotPreview: (label: string) => string
    removeAttachment: (label: string) => string
    dictating: string
    preparingAudio: string
    speakingResponse: string
    readingAloud: string
    themeSuggestions: string
    noMatchingThemes: string
    themeTryPre: string
    themeTryPost: string
    attachLabel: string
    files: string
    folder: string
    images: string
    pasteImage: string
    url: string
    promptSnippets: string
    tipPre: string
    tipPost: string
    snippetsTitle: string
    snippetsDesc: string
    snippets: Record<string, { label: string; description: string; text: string }>
    dropFiles: string
    dropSession: string
    approvalMode: {
      label: string
      manual: { label: string; desc: string }
      smart: { label: string; desc: string }
      full: { label: string; desc: string }
    }
    projectPicker: {
      label: string
      select: string
      searchPlaceholder: string
      recentHeading: string
      noRecent: string
      noMatches: string
      useExisting: string
      newBlank: string
      newTitle: string
      namePlaceholder: string
      locationLabel: string
      chooseParent: string
      create: string
      back: string
      useExistingTitle: string
      chooseParentTitle: string
      pickFailed: string
      createFailed: string
    }
    capabilities: {
      enabledLabel: string
      unused: string
      connectors: string
      connectorsHint: string
      noneEnabled: string
      browseDesc: string
      browseDescEnabled: string
      searchPlaceholder: string
      allEnabled: string
      loading: string
      toggle: (name: string) => string
      disable: (name: string) => string
      generateLabel: string
      generateImage: string
      generateVideo: string
      generateImageStarter: string
      generateVideoStarter: string
    }
  }

  statusStack: {
    agents: string
    background: (count: number) => string
    goalActive: string
    goalDone: string
    goalPaused: string
    goalWaiting: string
    subagents: (count: number) => string
    todos: (done: number, total: number) => string
    running: string
    stop: string
    dismiss: string
    exit: (code: number) => string
    coding: {
      title: string
      noBranch: string
      detached: string
      clean: string
      changed: (count: number) => string
      ahead: (count: number) => string
      behind: (count: number) => string
      review: string
      close: string
      openChanges: string
      openFile: string
      stage: string
      unstage: string
      stageAll: string
      viewAsTree: string
      viewAsList: string
      revert: string
      revertAll: string
      revertConfirm: string
      revertAllConfirm: string
      staged: string
      noChanges: string
      notRepo: string
      noDiff: string
      scopeUncommitted: string
      scopeBranch: string
      scopeLastTurn: string
      commit: string
      commitAndPush: string
      commitPlaceholder: string
      generateCommitMessage: string
      stopGenerating: string
      createPr: string
      openPr: string
      ghMissing: string
      agentShip: string
      agentShipPrompt: string
      newBranch: string
      branchOffFrom: (base: string) => string
      switchTo: (branch: string) => string
      switchFailed: (branch: string) => string
      worktrees: string
    }
  }

  updates: {
    stages: Record<string, string>
    checking: string
    checkFailedTitle: string
    tryAgain: string
    notAvailableTitle: string
    unsupportedMessage: string
    connectionRetry: string
    latestBody: string
    latestBodyBackend: string
    allSetTitle: string
    availableTitle: string
    availableBody: string
    availableTitleBackend: string
    availableBodyBackend: string
    availableBodyNoChangelog: string
    updateNow: string
    maybeLater: string
    moreChanges: (count: number) => string
    manualTitle: string
    manualBody: string
    manualPickedUp: string
    /** GUI/backend skew (#45205): backend updated but the running desktop app
     *  package (AppImage/.deb/.rpm) was not changed and must be reinstalled. */
    guiSkewTitle: string
    guiSkewBody: string
    copy: string
    copied: string
    done: string
    applyingBody: string
    applyingBodyBackend: string
    applyingClose: string
    errorTitle: string
    errorBody: string
    notNow: string
    applyStatus: {
      preparing: string
      pulling: string
      restarting: string
      notAvailable: string
      failed: string
      noReturn: string
    }
  }

  install: {
    stageStates: Record<string, string>
    /** hc-569: localized reasons for skipped stages, keyed by the installer's
     *  machine-readable skip_code (deps_unchanged, prereq_cached, …). Codes
     *  with no entry fall back to the installer's raw reason string. */
    skipReasons: Record<string, string>
    oneTimeTitle: string
    unsupportedDesc: (platform: string) => string
    installCommand: string
    copyCommand: string
    viewDocs: string
    installTo: string
    retryAfterRun: string
    setupChoiceTitle: string
    setupChoiceDesc: string
    connectExistingTitle: string
    connectExistingShort: string
    connectExistingDesc: string
    installLocalTitle: string
    installLocalDesc: string
    localStartUnavailable: string
    remoteSetupTitle: string
    remoteSetupDesc: string
    remoteUrlTitle: string
    remoteUrlDesc: string
    remoteUrlPlaceholder: string
    probing: string
    probeError: string
    identityProvider: string
    authTitle: string
    authNeedsOauth: (provider: string) => string
    authSignedIn: string
    connected: string
    signIn: string
    signInWith: (provider: string) => string
    enterUrlFirst: string
    signInIncomplete: string
    tokenTitle: string
    tokenDesc: string
    pasteSessionToken: string
    incompleteSignInTest: string
    incompleteTokenTest: string
    testConnection: string
    testSucceeded: (baseUrl: string, version?: string) => string
    applyRemote: string
    backToSetup: string
    failedTitle: string
    settingUpTitle: string
    /** hc-452: shown instead of settingUpTitle when this run is an opt-in
     *  runtime version update rather than a first-ever install. `version` may
     *  be null before the target version resolves. */
    settingUpTitleUpdate: (version: string | null) => string
    finishingTitle: string
    failedDesc: string
    activeDesc: string
    /** hc-452: update-flow counterpart to activeDesc -- must NOT claim this is
     *  a one-time thing or that future launches skip this step (both false
     *  for a recurring runtime update). `version` may be null; see
     *  settingUpTitleUpdate. */
    activeDescUpdate: (version: string | null) => string
    progress: (completed: number, total: number) => string
    currentStage: (stage: string) => string
    fetchingManifest: string
    error: string
    hideOutput: string
    showOutput: string
    lines: (count: number) => string
    noOutput: string
    cancelling: string
    cancelInstall: string
    transcriptSaved: string
    copiedOutput: string
    copyOutput: string
    reloadRetry: string
    // Localized labels for the installer's known stage ids (Prerequisites,
    // Repository, Venv, …). Keyed by the raw stage name from the bootstrap
    // protocol; unknown ids fall back to formatStageName() in the overlay.
    stageLabels: Record<string, string>
    /** hc-452: rough per-step duration hint shown next to a PENDING stage row
     *  (first-install ballpark; an incremental update skips most of these).
     *  Same key space as stageLabels; an id with no entry renders no hint. */
    stageDurationHints: Record<string, string>
  }

  onboarding: {
    headerTitle: string
    headerDesc: string
    preparingInstall: string
    starting: string
    lookingUpProviders: string
    collapse: string
    otherProviders: string
    haveApiKey: string
    chooseLater: string
    recommended: string
    connected: string
    featuredPitch: string
    fireworksPitch: string
    openRouterPitch: string
    apiKeyOptions: Record<string, { short: string; description: string }>
    backToSignIn: string
    getKey: string
    replaceCurrent: string
    pasteApiKey: string
    localApiKeyPlaceholder: string
    couldNotSave: string
    connecting: string
    update: string
    flowSubtitles: Record<string, string>
    startingSignIn: (provider: string) => string
    verifyingCode: (provider: string) => string
    connectedProvider: (provider: string) => string
    connectedPicking: (provider: string) => string
    signInFailed: string
    pickDifferentProvider: string
    signInWith: (provider: string) => string
    openedBrowser: (provider: string) => string
    authorizeThere: string
    copyAuthCode: string
    pasteAuthCode: string
    reopenAuthPage: string
    autoBrowser: (provider: string) => string
    reopenSignInPage: string
    waitingAuthorize: string
    externalPending: (provider: string) => string
    signedIn: string
    deviceCodeOpened: (provider: string) => string
    reopenVerification: string
    copy: string
    defaultModel: string
    freeTier: string
    pro: string
    free: string
    price: (input: string, output: string) => string
    change: string
    startChatting: string
    docs: (provider: string) => string
    /** Clean prompt shown when a provider is seeded (DeepSeek) but its key is
     *  missing — replaces the raw "no usable credentials" runtime error. */
    addKeyToStart: string
    /** "More — needs VPN" disclosure label hiding the international providers. */
    moreProvidersVpn: string
    /** ApexNodes managed-LLM (zero-key) first-run sign-in panel. */
    managed: {
      subtitle: string
      emailPlaceholder: string
      passwordPlaceholder: string
      signIn: string
      signingIn: string
      useOwnProvider: string
      /** Divider between the email/password form and the browser-login buttons. */
      dividerOr: string
      /** "用 Google 登录" browser (loopback) sign-in button. */
      signInGoogle: string
      /** "用 APEX 登录" browser (loopback) sign-in button. */
      signInApex: string
      /** Waiting line for a signed-in zero-key user while the runtime picks up
       *  the relay key the platform just issued. Stands in for the BYOK picker,
       *  which such a user must never see. */
      preparing: string
      /** Second line under `preparing` — why the wait is short and harmless. */
      preparingHint: string
    }
  }

  modelPicker: {
    title: string
    current: string
    unknown: string
    search: string
    noModels: string
    addProvider: string
    loadFailed: string
    noAuthenticatedProviders: string
    pro: string
    proNeedsSubscription: string
    free: string
    freeTier: string
    priceTitle: string
    wasPrice: string
  }

  modelVisibility: {
    title: string
    search: string
    noAuthenticatedProviders: string
    addProvider: string
  }

  shell: {
    windowControls: string
    paneControls: string
    appControls: string
    modelMenu: {
      search: string
      noModels: string
      editModels: string
      refreshModels: string
      fast: string
      minimal: string
      low: string
      medium: string
      high: string
      xhigh: string
      max: string
      ultra: string
      /** Group label for a custom endpoint with neither a name nor a
       *  resolvable address — never the implementation word "custom". */
      unnamedEndpoint: string
    }
    modelOptions: {
      noOptions: string
      options: string
      thinking: string
      fast: string
      effort: string
      minimal: string
      low: string
      medium: string
      high: string
      xhigh: string
      max: string
      ultra: string
      updateFailed: string
      fastFailed: string
    }
    gatewayMenu: {
      gateway: string
      connected: string
      connecting: string
      offline: string
      inferenceReady: string
      inferenceNotReady: string
      checkingInference: string
      disconnected: string
      openSystem: string
      connection: (label: string) => string
      recentActivity: string
      viewAllLogs: string
      messagingPlatforms: string
    }
    approvalMode: {
      title: string
      ariaLabel: (mode: string) => string
      manual: string
      manualDescription: string
      smart: string
      smartDescription: string
      off: string
      offDescription: string
    }
    statusbar: {
      unknown: string
      restart: string
      update: string
      updateInProgress: string
      commitsBehind: (count: number, branch: string) => string
      desktopVersion: (version: string) => string
      backendVersion: (version: string) => string
      clientLabel: (version: string) => string
      connectionSsh: (host: string) => string
      connectionRemote: (host: string) => string
      connectionCloud: (host: string) => string
      connectionCloudTooltip: (host: string) => string
      connectionSshTooltip: (host: string) => string
      connectionRemoteTooltip: (host: string) => string
      backendLabel: (version: string) => string
      commit: (sha: string) => string
      branch: (branch: string) => string
      closeCommandCenter: string
      openCommandCenter: string
      showTerminal: string
      hideTerminal: string
      gateway: string
      gatewayReady: string
      gatewayNeedsSetup: string
      gatewayChecking: string
      gatewayConnecting: string
      gatewayOffline: string
      gatewayRestarting: string
      gatewayTitle: string
      customizeTitle: string
      hideStatusbar: string
      toggleApprovalMode: string
      toggleBackendVersion: string
      toggleCommandCenter: string
      toggleContextUsage: string
      toggleRunningTimer: string
      toggleSessionTimer: string
      toggleTerminal: string
      toggleVersion: string
      toggleWorkspace: string
      agents: string
      closeAgents: string
      openAgents: string
      subagents: (count: number) => string
      failed: (count: number) => string
      running: (count: number) => string
      cron: string
      openCron: string
      webhooks: string
      openWebhooks: string
      starmap: string
      openStarmap: string
      turnRunning: string
      currentTurnElapsed: string
      contextUsage: string
      contextUsagePanel: {
        categories: {
          conversation: string
          mcp: string
          memory: string
          rules: string
          skills: string
          subagent_definitions: string
          system_prompt: string
          tool_definitions: string
        }
        empty: string
        loading: string
        percentFull: (percent: number) => string
        title: string
        tokenSummary: (used: string, max: string) => string
      }
      openContextUsage: string
      session: string
      runtimeSessionElapsed: string
      yoloOn: string
      yoloOff: string
      modelNone: string
      noModel: string
      switchModel: string
      openModelPicker: string
      modelPinned: string
      modelTitle: (provider: string, model: string) => string
      providerModelTitle: (provider: string, model: string) => string
    }
  }

  rightSidebar: {
    aria: string
    panelsAria: string
    files: string
    terminal: string
    noFolderSelected: string
    changeCwdTitle: string
    remotePickerTitle: string
    remotePickerDescription: string
    remotePickerSelect: string
    folderTip: (cwd: string) => string
    openFolder: string
    refreshTree: string
    collapseAll: string
    previewUnavailable: string
    couldNotPreview: (path: string) => string
    noProjectTitle: string
    noProjectBody: string
    noProjectOpen: string
    noDiffs: string
    unreadableTitle: string
    unreadableBody: (error: string) => string
    emptyTitle: string
    emptyBody: string
    treeErrorTitle: string
    treeErrorBody: string
    tryAgain: string
    loadingTree: string
    loadingFiles: string
    terminalHide: string
    terminalsAria: string
    terminalNew: string
    terminalCloseOthers: string
    terminalCloseAll: string
    addToChat: string
  }

  preview: {
    tab: string
    closeTab: (label: string) => string
    closeOthers: string
    closeToRight: string
    closeAll: string
    closePane: string
    loading: string
    unavailable: string
    opening: string
    hide: string
    openPreview: string
    openInBrowser: string
    linkHint: string
    sourceLineTitle: string
    source: string
    renderedPreview: string
    diff: string
    unknownSize: string
    binaryTitle: string
    binaryBody: (label: string) => string
    largeTitle: string
    largeBody: (label: string, size: string) => string
    previewAnyway: string
    truncated: string
    noInlineTitle: string
    noInlineBody: (mimeType: string) => string
    edit: string
    editing: string
    unsavedChanges: string
    saveFailed: (message: string) => string
    diskChangedTitle: string
    diskChangedBody: string
    overwrite: string
    discardReload: string
    console: {
      deselect: string
      select: string
      copyFailed: string
      copyEntry: string
      sendEntry: string
      messages: (count: number) => string
      resize: string
      title: string
      selected: (count: number) => string
      sendToChat: string
      copySelected: string
      copyAll: string
      copy: string
      clear: string
      empty: string
      promptHeader: string
      sentTitle: string
      sentMessage: (count: number) => string
    }
    web: {
      appFailedToBoot: string
      serverNotFound: string
      failedToLoad: string
      tryAgain: string
      restarting: string
      askRestart: string
      lookingRestart: (taskId: string) => string
      restartingTitle: string
      restartingMessage: string
      startRestartFailed: (message: string) => string
      restartFailed: string
      hideConsole: string
      showConsole: string
      hideDevTools: string
      openDevTools: string
      finishedRestarting: (message?: string) => string
      failedRestarting: (message: string) => string
      unknownError: string
      restartedTitle: string
      reloadingNow: string
      restartFailedTitle: string
      restartFailedMessage: string
      stillWorking: string
      workspaceReloading: string
      fileChanged: (url: string) => string
      filesChanged: (count: number, url: string) => string
      watchFailed: (message: string) => string
      moduleMimeDescription: string
      loadFailedConsole: (code: number | undefined, message: string) => string
      unreachableDescription: string
      openTarget: (url: string) => string
      fallbackTitle: string
    }
  }

  zones: {
    showHeader: string
    hideHeader: string
    minimize: string
    restore: string
    closeRunningTitle: string
    closeRunningBody: string
    closeRunningConfirm: string
    reload: string
    closeOthers: string
    closeToRight: string
    closeAll: string
    newSessionTab: string
    pluginDisabled: (pluginId: string) => string
    pluginDisabledBody: string
    missingPane: (paneId: string) => string
    editTitle: string
    editHint: string
    reset: string
    templates: string
    custom: string
    newGridLayout: string
    saveCurrentAs: string
    nameLayoutPlaceholder: string
    deletePreset: (name: string) => string
    zoneEditorTitle: string
    editorHintPre: string
    editorHintPost: string
    templateColumns: string
    templateRows: string
    templateGrid: string
    templatePriority: string
    zoneTag: (index: number) => string
    mergeZones: (count: number) => string
    customZoneName: (count: number) => string
    layoutNamePlaceholder: (fallback: string) => string
    saveApply: string
    notExpressible: string
    zoneCount: (count: number) => string
  }

  assistant: {
    thread: {
      loadingSession: string
      showEarlier: string
      loadingResponse: string
      resumeWhenBackgroundDone: (count: number) => string
      thinking: string
      thought: string
      thoughtBriefly: string
      thoughtFor: (duration: string) => string
      today: (time: string) => string
      yesterday: (time: string) => string
      copy: string
      refresh: string
      moreActions: string
      branchNewChat: string
      react: string
      dismissError: string
      filesChanged: (count: number) => string
      reviewChanges: string
      readAloudFailed: string
      preparingAudio: string
      stopReading: string
      readAloud: string
      editMessage: string
      expandMessage: string
      scrollToBottom: string
      stop: string
      restorePrevious: string
      restoreCheckpoint: string
      restoreFromHere: string
      restoreTitle: string
      restoreBody: string
      restoreConfirm: string
      restoreNext: string
      goForward: string
      sendEdited: string
      attachingFile: string
      compacting: string
      steered: string
      processOutput: string
      timeline: string
    }
    approval: {
      gatewayDisconnected: string
      sendFailed: string
      run: string
      command: string
      moreOptions: string
      allowSession: string
      alwaysAllowMenu: string
      jumpToApproval: string
      reject: string
      alwaysTitle: string
      alwaysDescription: (pattern: string) => string
      alwaysAllow: string
    }
    clarify: {
      notReady: string
      gatewayDisconnected: string
      sendFailed: string
      loadingQuestion: string
      other: string
      placeholder: string
      skip: string
      skipped: string
      continueLabel: string
      lateAnswer: (question: string, choice: string) => string
      lateAnswerTip: string
      lateAnswerHint: string
    }
    tool: {
      copyCode: string
      renderingImage: string
      copyOutput: string
      copyCommand: string
      copyContent: string
      copyUrl: string
      copyResults: string
      copyQuery: string
      copyFile: string
      copyPath: string
      outputAlt: string
      rawResponse: string
      copyActivity: string
      recoveredOne: string
      recoveredMany: (count: number) => string
      failedOne: string
      failedMany: (count: number) => string
      statusRunning: string
      statusError: string
      statusRecovered: string
      statusDone: string
      /** Over-budget / rejected memory write title — not "Saved to memory". */
      memoryWriteNoted: string
      actions: {
        read: string
        reading: string
        opened: string
        opening: string
        failedToOpen: string
        searched: string
        searching: string
        ran: string
        running: string
        ranCode: string
        runningCode: string
      }
      prefixes: {
        browser: string
        web: string
      }
      titleTemplates: {
        actionCommand: (action: string, command: string) => string
        actionQuoted: (action: string, value: string) => string
        actionTarget: (action: string, target: string) => string
        prefixedDone: (prefix: string, action: string) => string
        runningPrefixedTool: (prefix: string, action: string) => string
        runningTool: (action: string) => string
      }
      titles: Record<ToolTitleKey, ToolTitleCopy>
      searchResults: string
      stdoutLabel: string
      stderrLabel: string
    }
  }

  prompts: {
    gatewayDisconnected: string
    sudoSendFailed: string
    secretSendFailed: string
    sudoTitle: string
    sudoDesc: string
    sudoPlaceholder: string
    secretTitle: string
    secretDesc: string
    secretPlaceholder: string
  }

  desktop: {
    audioReadFailed: string
    sessionUnavailable: string
    createSessionFailed: string
    promptFailed: string
    providerCredentialRequired: string
    emptySlashCommand: string
    desktopCommands: string
    skillCommandsAvailable: (count: number) => string
    warningLine: (message: string) => string
    yoloArmed: string
    yoloOff: string
    yoloSystem: (active: boolean) => string
    yoloTitle: string
    yoloToggleFailed: string
    profileStatus: (current: string) => string
    unknownProfile: string
    noProfileNamed: (target: string, available: string) => string
    newChatsProfile: (name: string) => string
    setProfileFailed: string
    sttDisabled: string
    stopFailed: string
    regenerateFailed: string
    editFailed: string
    resumeFailed: string
    resumeStrandedTitle: string
    resumeStrandedBody: string
    resumeRetry: string
    nothingToBranch: string
    branchNeedsChat: string
    sessionBusy: string
    branchStopCurrent: string
    branchNoText: string
    branchTitle: (n: number) => string
    branchFailed: string
    deleteFailed: string
    archived: string
    archiveFailed: string
    cwdChangeFailed: string
    cwdStagedTitle: string
    cwdStagedMessage: string
    modelSwitchFailed: string
    sessionExported: string
    sessionExportFailed: string
    imageSaved: string
    downloadStarted: string
    restartToUseSaveImage: string
    restartToSaveImages: string
    imageDownloadFailed: string
    openImage: string
    downloadImage: string
    savingImage: string
    imagePreviewFailed: string
    imageAttach: string
    imageWriteFailed: string
    imageAttachFailed: string
    attachImages: string
    clipboard: string
    noClipboardImage: string
    clipboardPasteFailed: string
    dropFiles: string
    handoff: {
      pickPlatform: string
      success: (platform: string) => string
      systemNote: (platform: string) => string
      failed: (error: string) => string
      timedOut: string
    }
  }

  errors: {
    genericFailure: string
    boundaryTitle: string
    boundaryDesc: string
    reloadWindow: string
    openLogs: string
  }

  ui: {
    search: {
      clear: string
    }
    pagination: {
      label: string
      previous: string
      previousAria: string
      next: string
      nextAria: string
    }
    sidebar: {
      title: string
      description: string
      toggle: (open: boolean) => string
    }
  }

  // hc-554 场景入口 — zero-state scenario shelf, the composer ✦ menu, the
  // scenario detail overlay, and the sidebar channel-status manifestation.
  scenarios: {
    // Composer ✦ button + two-level menu (screen ②).
    button: string
    menuAria: string
    searchPlaceholder: string
    noMatches: string
    comingSoon: string
    // Zero-state shelf (screen ①).
    allScenarios: string
    sample: string
    // Scenario detail overlay (样例 → preview before use).
    detailHeading: string
    labelCommand: string
    labelInput: string
    labelOutput: string
    inputNone: string
    use: string
    // ① manifestation: sidebar channel status + "connect your agent" strip.
    channelsTitle: string
    connectTitle: string
    phoneRemote: string
    remoteOn: string
    bindCta: string
    // ④ manifestation: direct-connect banner + delegated/direct task card +
    // connection-guidance (unconnected onboarding).
    remoteBannerTitle: string
    remoteBannerApproval: string
    taskTargetCloud: string
    taskTargetLocal: string
    taskStatus: { running: string; done: string; failed: string; queued: string }
    /** Relative "heartbeat N ago" for a task card. */
    heartbeatAgo: (seconds: number) => string
  }

  // hc-417 "IM 入口" — consumer page to connect the local agent to an IM
  // platform by scanning a QR / pasting one code. Deliberately jargon-free.
  imEntry: {
    title: string
    intro: string
    loading: string
    connect: string
    manage: string
    comingSoon: string
    connectedBadge: string
    availableHeading: string
    comingSoonHeading: string
    boundHeading: string
    boundEmpty: string
    connectedOn: (when: string) => string
    unbind: string
    unbindConfirm: (name: string) => string
    unbindDoneTitle: string
    unbindDoneMessage: string
    // Live connection state merged from /api/messaging/platforms.
    liveState: { connected: string; pending: string; error: string; connecting: string; unknown: string }
    // Per-channel display copy. Keyed by runtime Platform id.
    channels: Record<string, { name: string; tagline: string }>
    dialog: {
      connectTitle: (name: string) => string
      signInFirstTitle: string
      signInFirst: string
      issuing: string
      scanPrompt: string
      scanHint: (name: string) => string
      openLink: string
      // hc-538: WeChat expectation-gap note — the bound identity is a NEW iLink
      // bot contact, not the user's own WeChat being taken over.
      weixinBotNote: string
      connecting: string
      authorizedTitle: string
      authorizedMessage: string
      // Shown instead of authorizedMessage when the binding saved but the
      // automatic backend restart failed — restart the app manually.
      authorizedRestartHint: string
      retry: string
      cancel: string
      close: string
      comingSoonTitle: string
      comingSoonBody: string
      // paste-code template (framework; no available channel uses it yet).
      pasteHeading: string
      pasteLabel: string
      pastePlaceholder: string
      pasteSubmit: string
      advanced: string
      errors: {
        sign_in: string
        service_unavailable: string
        rate_limited: string
        expired: string
        denied: string
        request_failed: string
        keychain: string
      }
    }
    // hc-417 收口: Settings → 提供方 card summary + CTA (im-entry-settings.tsx).
    // title/intro/boundEmpty above are reused verbatim for the card; these are
    // the two settings-card-only additions.
    settingsCard: {
      boundSummary: (count: number) => string
      openCta: string
    }
  }

  home: {
    title: string
    description: string
  }

  businessWorkspace: {
    goalLauncher: {
      label: string
      placeholder: string
      hint: string
      submit: string
    }
    projects: {
      eyebrow: string
      title: string
      description: string
      emptyTitle: string
      emptyDescription: string
      action: string
      tasksAction: string
      recentConversations: string
      openHistory: string
      taskProgress: string
      openTasks: string
      deliverables: string
      openArtifacts: string
      untitled: string
      noPreview: string
      needsInput: string
      running: string
      failed: string
      done: string
      steps: (completed: number, total: number) => string
      loadingHistory: string
      noConversations: string
      noTasks: string
      progressUnavailable: string
      taskProgressUnavailable: string
      taskProgressLoading: string
      loadingEvidence: string
      noArtifacts: string
      partialEvidence: string
      evidenceUnavailableTitle: string
      evidenceUnavailableDescription: string
      toolActivity: (count: number) => string
      toolStatusDetail: string
      latestOutput: string
    }
    workflows: {
      eyebrow: string
      title: string
      description: string
      use: string
      commerce: { title: string; summary: string; prompt: string }
      insight: { title: string; summary: string; prompt: string }
      content: { title: string; summary: string; prompt: string }
    }
    workflowDomain: {
      startFailed: string
      run: {
        actionFailed: string
        approve: string
        attempt: string
        cancel: string
        cancelling: string
        created: string
        deliverables: string
        evidence: (count: number) => string
        event: (eventType: string) => string
        executor: string
        eyebrow: string
        loadFailedDescription: string
        loadFailedTitle: string
        loading: string
        noDeliverablesDescription: string
        noDeliverablesTitle: string
        noEvents: string
        noObjective: string
        requestChanges: string
        retry: string
        status: (status: string) => string
        timeline: string
        title: string
        waitingForEvents: string
      }
    }
  }

  /** Desktop auth boot-gate: the full-window login screen + bottom-left account
   *  panel (Codex-faithful, minimal). Chinese-first (China-first Desktop V0.2). */
  auth: {
    /** Login screen. */
    login: {
      /** Hero line under the logo ("开始使用"). */
      title: string
      /** Primary button — sign in with the Apex account. */
      signInApex: string
      /** Secondary button — quick sign-in with Google. */
      signInGoogle: string
      /** In-flight label while a browser sign-in is pending. */
      signingIn: string
      /** Generic sign-in failure line. */
      failed: string
      /** Account-abnormal (403 account_disabled) message shown on the gate. */
      accountDisabled: string
      /** Session-expired / login-lost (401) message shown on the gate. */
      sessionExpired: string
      /** Quiet escape hatch out of the zero-key default and into BYOK — the only
       *  entrance to the provider picker on a managed build. */
      useOwnKey: string
    }
    /** Bottom-left account panel + its popover menu. */
    account: {
      /** Fallback display name when no email/name is known (e.g. "账户"). */
      fallbackName: string
      /** Menu item — open profile. */
      profile: string
      /** Menu item — open settings. */
      settings: string
      /** Menu item — remaining usage / quota. */
      usage: string
      /** Menu item — sign out. */
      logout: string
      /** hc-519: title of the degraded card when the relay session expired and
       *  self-heal failed (e.g. "登录已失效"). */
      sessionExpiredTitle: string
      /** hc-519: call-to-action subtitle on the degraded card (e.g.
       *  "点击重新登录"). */
      sessionExpiredAction: string
    }
  }

  // Goal-mode long-running tasks (one-shot cron jobs surfaced on /tasks).
  tasks: {
    newTask: string
    tabRunning: string
    tabDone: string
    emptyRunning: string
    emptyDone: string
    emptyDetail: string
    pending: string
    started: string
    runAgain: string
    goalLabel: string
    goalPlaceholder: string
    stuckHint: string
    stuckDetail: string
    waitingToStart: string
    progressLabel: string
    stepsOf: (completed: number, total: number) => string
    currentStepLabel: string
    latestOutputLabel: string
    runHistory: string
    noRuns: string
    phases: Record<'done' | 'failed' | 'running', string>
    newTaskTitle: string
    newTaskDesc: string
    goalRequired: string
    timeRequired: string
    whenLabel: string
    whenNow: string
    whenIn: string
    whenAt: string
    delayLabel: string
    atLabel: string
    persistNote: string
    startTask: string
    created: string
    startedNow: string
    failedStart: string
    deleted: string
    failedDelete: string
    deleting: string
    deleteTitle: string
    deleteDescPrefix: string
    deleteDescSuffix: string
    // Native OS notification copy fired by the task notifier (store/tasks.ts).
    notify: {
      doneTitle: string
      failedTitle: string
    }
  }

  // 个人资料 — the profile stats page (avatar header + usage stats off the
  // local analytics API). Distinct from `profiles` (the multi-profile manager).
  profileStats: {
    close: string
    signedOut: string
    loading: string
    failedLoad: string
    emptyTitle: string
    emptyDesc: string
    stats: {
      sessions: string
      tokens: string
      apiCalls: string
      activeDays: string
      skillsUsed: string
    }
    heatmap: {
      title: string
      daily: string
      weekly: string
      cumulative: string
      less: string
      more: string
      cellTitle: (date: string, tokens: string) => string
    }
    insights: {
      title: string
      busiestDay: string
      avgPerActiveDay: string
      topModel: string
      longestStreak: string
      streakDays: (days: number) => string
      estimatedCost: string
    }
    topSkills: {
      title: string
      uses: (count: string) => string
    }
  }

  operationStatus: {
    browserActive: string
    computerActive: string
    computerWarning: string
    running: string
    stop: string
  }
}
