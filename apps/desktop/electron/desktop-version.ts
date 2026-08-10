import type { App, IpcMain } from 'electron'

export interface DesktopVersionInfo {
  appVersion: string
  engineVersion: string
  electronVersion: string
  nodeVersion: string
  platform: NodeJS.Platform
  hermesRoot: string
}

interface DesktopVersionDependencies {
  app: Pick<App, 'getVersion'>
  electronVersion: string
  engineVersion: () => string
  hermesRoot: () => string
  nodeVersion: string
  platform: NodeJS.Platform
}

interface AboutPanelDependencies {
  app: Pick<App, 'getVersion' | 'setAboutPanelOptions' | 'showAboutPanel'>
  applicationName: string
  copyright: string
}

export function registerDesktopVersionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  dependencies: DesktopVersionDependencies
): void {
  ipcMain.handle('hermes:version', async () => ({
    // The shell and managed engine update on separate clocks. Keep their
    // identities distinct so a post-update readback compares the frozen shell
    // target with the running Electron package, not with the engine version.
    appVersion: dependencies.app.getVersion(),
    engineVersion: dependencies.engineVersion(),
    electronVersion: dependencies.electronVersion,
    nodeVersion: dependencies.nodeVersion,
    platform: dependencies.platform,
    hermesRoot: dependencies.hermesRoot()
  }) satisfies DesktopVersionInfo)
}

export function configureShellAboutPanel(dependencies: AboutPanelDependencies): void {
  dependencies.app.setAboutPanelOptions({
    applicationName: dependencies.applicationName,
    applicationVersion: dependencies.app.getVersion(),
    copyright: dependencies.copyright
  })
}

export function showFreshAboutPanel(dependencies: AboutPanelDependencies): void {
  configureShellAboutPanel(dependencies)
  dependencies.app.showAboutPanel()
}
