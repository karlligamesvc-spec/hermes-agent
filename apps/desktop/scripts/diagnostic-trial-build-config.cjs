'use strict'

function createDiagnosticTrialBuildConfig({ baseBuild, packageJson, runtimeSourceCommit, trialPolicy }) {
  if (!/^[0-9a-f]{40}$/.test(runtimeSourceCommit)) {
    throw new Error(`diagnostic Runtime source commit must be a full SHA: ${runtimeSourceCommit || '<missing>'}`)
  }

  const embeddedPolicy = { ...trialPolicy, runtimeSourceCommit }

  return {
    ...baseBuild,
    appId: trialPolicy.appId,
    productName: trialPolicy.productName,
    executableName: trialPolicy.executableName,
    artifactName: trialPolicy.artifactName,
    directories: { ...baseBuild.directories, output: 'release-diagnostic-trial' },
    publish: [],
    protocols: [],
    extraMetadata: {
      name: 'apex-diagnostic-trial',
      productName: trialPolicy.productName,
      apexnodes: {
        ...(packageJson.apexnodes || {}),
        desktopTrial: embeddedPolicy
      }
    },
    mac: {
      ...baseBuild.mac,
      identity: '-',
      extendInfo: {
        ...baseBuild.mac.extendInfo,
        CFBundleDisplayName: trialPolicy.productName,
        CFBundleExecutable: trialPolicy.executableName,
        CFBundleName: trialPolicy.productName,
        CFBundleURLTypes: []
      }
    },
    dmg: {
      ...baseBuild.dmg,
      title: `Run ${trialPolicy.productName}`
    },
    win: {
      ...baseBuild.win,
      legalTrademarks: trialPolicy.productName
    },
    nsis: {
      ...baseBuild.nsis,
      shortcutName: trialPolicy.productName,
      uninstallDisplayName: trialPolicy.productName
    }
  }
}

module.exports = { createDiagnosticTrialBuildConfig }
