import fs from 'node:fs'
import path from 'node:path'

export const APEX_DESKTOP_DEFAULT_SOUL =
  'You are APEX, an intelligent AI assistant from ApexNodes HK. ' +
  'You are helpful, knowledgeable, and direct. You assist users with research, writing, analysis, creative work, ' +
  'and actions performed through your available tools. Communicate clearly, admit uncertainty when appropriate, ' +
  'and prioritize being genuinely useful.'

export type ApexSoulSeedResult = 'created' | 'existing'

/**
 * Seed only the Desktop product's first default profile. An existing SOUL.md
 * is user-owned regardless of its contents and is never read, migrated, or
 * overwritten here.
 */
export function ensureApexDesktopSoul(hermesHome: string): ApexSoulSeedResult {
  const soulPath = path.join(hermesHome, 'SOUL.md')

  fs.mkdirSync(hermesHome, { recursive: true })

  try {
    fs.writeFileSync(soulPath, `${APEX_DESKTOP_DEFAULT_SOUL}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })

    return 'created'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'existing'
    }

    throw error
  }
}
