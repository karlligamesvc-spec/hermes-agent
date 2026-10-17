// hc-906 (Kael 2026-10-17): Hermes v0.22 defaults sessions.auto_prune to true, which deletes ended
// sessions idle for 90 days at backend startup. APEX keeps history until it ships archive/export.
//
// Every local profile has its own config.yaml and its own state.db, and the product-defaults guard
// only heals the default home. Profiles that predate 0.17.58, or were created without cloning the
// default one (hermes-bots members among them), would still prune their own history. This fills that
// single key, add-only, in every local home; a value the user set (true or false) stays theirs. It
// runs inside guardConfigYamlProductBlocks, so the boot pass lands before any backend starts.

import fs from 'node:fs'
import path from 'node:path'

import { ensureProductDefaultsYaml } from './apex-managed'

export const SESSION_RETENTION_DEFAULTS = Object.freeze({ 'sessions.auto_prune': false })

type Write = (configPath: string, expected: string, next: string) => boolean

function localHomesSync(hermesHome: string) {
  let profiles: string[] = []

  try {
    profiles = fs.readdirSync(path.join(hermesHome, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(hermesHome, 'profiles', entry.name))
  } catch {
    // no profiles directory: the default home only
  }

  return [hermesHome, ...profiles]
}

/** Fills the key wherever it is missing; returns the config.yaml paths it filled. Never throws. */
export function keepSessionHistoryInEveryProfile(hermesHome: string, log: (line: string) => void = () => {},
  write: Write = writeConfigIfUnchanged) {
  const filled: string[] = []

  for (const home of localHomesSync(hermesHome)) {
    const configPath = path.join(home, 'config.yaml')

    try {
      const raw = fs.readFileSync(configPath, 'utf8')
      const result = ensureProductDefaultsYaml(raw, SESSION_RETENTION_DEFAULTS)

      if (result.changed && write(configPath, raw, result.next)) {
        filled.push(configPath)
        log(`[config-guard] sessions.auto_prune: false filled in ${configPath}`)
      }
    } catch (error: any) {
      // A missing config.yaml is normal (the seed or the profile's first write carries the key).
      if (error?.code !== 'ENOENT') {
        log(`[config-guard] session retention fill skipped ${configPath}: ${error?.message || error}`)
      }
    }
  }

  return filled
}

// A running backend or the user may have rewritten the file since it was read: skip rather than
// clobber, and the next guard pass fills it. Keeps the file's mode (config.yaml carries credentials).
export function writeConfigIfUnchanged(configPath: string, expected: string, next: string) {
  if (fs.readFileSync(configPath, 'utf8') !== expected) {
    return false
  }

  const tmp = `${configPath}.${process.pid}.session-retention.tmp`
  fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: fs.statSync(configPath).mode & 0o777 })
  fs.renameSync(tmp, configPath)

  return true
}
