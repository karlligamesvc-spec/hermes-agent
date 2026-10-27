/**
 * apex-profile-homes.ts — which Hermes homes carry the APEX setup (hc-1080).
 *
 * One assistant is one Hermes profile: the default profile is the root
 * HERMES_HOME itself, a named one lives in `<root>/profiles/<name>/` with its
 * own config.yaml, .env, SOUL.md and skills/. A profile created with
 * `clone_from: default` starts as a copy of the root, so every APEX writer that
 * only touches the root (relay key, product blocks, tier heal, platform skills)
 * leaves it holding a snapshot that drifts: a key rotation turns that profile
 * into a 401 loop.
 *
 * This module answers one question for every such writer: which homes should
 * APEX keep in step? The answer is the root, always, plus each named profile
 * that routes through the managed relay. A profile on the user's own provider
 * is not ours to touch, and neither is a directory that is not a profile.
 *
 * Reused by hc-1081 (platform skills per profile) and hc-1078 (create / delete
 * an assistant). Electron-free: plain fs, injectable for tests.
 */

import fs from 'node:fs'
import path from 'node:path'

import { locateManagedKeyAnchors } from './apex-relay-key-anchors'

/** The name Hermes gives the root home's profile. */
export const DEFAULT_PROFILE = 'default'

export interface ApexProfileHome {
  /** `default` for the root, else the directory name under `profiles/`. */
  profile: string
  /** That profile's HERMES_HOME: the root itself, or `<root>/profiles/<name>`. */
  home: string
  /** `<home>/config.yaml`. */
  configPath: string
}

function homeOf(profile: string, home: string): ApexProfileHome {
  return { profile, home, configPath: path.join(home, 'config.yaml') }
}

/**
 * The root, then every named profile, in directory order. A named profile is a
 * directory under `profiles/` holding a SOUL.md — the same marker the engine
 * (hermes_cli/container_boot.py) and hc-1042's SOUL upgrade use. Hidden
 * entries are clone staging dirs (`profiles/.<name>.staging-<pid>`) and are
 * never listed. Never throws: an unreadable `profiles/` means the root only.
 */
export function listProfileHomes(root: string): ApexProfileHome[] {
  const homes = [homeOf(DEFAULT_PROFILE, root)]
  let entries: fs.Dirent[]

  try {
    entries = fs.readdirSync(path.join(root, 'profiles'), { withFileTypes: true })
  } catch {
    return homes
  }

  for (const entry of entries) {
    const home = path.join(root, 'profiles', entry.name)

    if (entry.isDirectory() && !entry.name.startsWith('.') && fs.existsSync(path.join(home, 'SOUL.md'))) {
      homes.push(homeOf(entry.name, home))
    }
  }

  return homes
}

/**
 * True when this config.yaml routes through the managed relay at `baseUrl`:
 * at least one registered relay-key anchor — `model`, `custom_providers[]` or
 * `providers.*` (apex-relay-key-anchors.ts MANAGED_KEY_ANCHORS) — points at it.
 * That is exactly the set the relay-key writer would touch, so a profile is
 * "managed" if and only if it holds a relay key that can go stale.
 */
export function configUsesManagedRelay(raw: string, baseUrl: string): boolean {
  return locateManagedKeyAnchors(String(raw ?? ''), baseUrl).length > 0
}

/**
 * The homes APEX keeps in step: the root first, unconditionally (it has always
 * been healed, managed or BYOK, and stays exactly as before), then each named
 * profile whose config.yaml uses the managed relay at `baseUrl`. A named profile
 * without a readable config.yaml, or on another provider, is left out, so APEX
 * never writes a byte into it.
 */
export function managedProfileHomes(
  root: string,
  baseUrl: string,
  read: (configPath: string) => string = configPath => fs.readFileSync(configPath, 'utf8')
): ApexProfileHome[] {
  const [rootHome, ...named] = listProfileHomes(root)

  return [
    rootHome,
    ...named.filter(home => {
      try {
        return configUsesManagedRelay(read(home.configPath), baseUrl)
      } catch {
        return false
      }
    })
  ]
}
