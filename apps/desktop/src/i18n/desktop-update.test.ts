import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { describeDesktopUpdateError, DESKTOP_UPDATE_COPY } from './desktop-update'

const DESKTOP_ROOT = resolve(__dirname, '../..')
const zh = DESKTOP_UPDATE_COPY.zh
const en = DESKTOP_UPDATE_COPY.en

// hc-1030: every code the update stores and the shell updater can leave in the
// overlay. A new code without a sentence would silently read as `generic`.
const CODE_SOURCES = ['src/store/desktop-update.ts', 'src/store/shell-update.ts', 'src/store/runtime-update.ts', 'electron/shell-updater.ts']

const CODE_PATTERNS = [/new Error\('([a-z]+(?:_[a-z]+)+)'\)/g, /new Error\([^)]*\|\| '([a-z]+(?:_[a-z]+)*)'\)/g, /error: '([a-z]+(?:_[a-z]+)*)'/g, /error: state\.error \|\| '([a-z_]+)'/g]

function surfacedCodes(): string[] {
  const codes = new Set<string>()

  for (const file of CODE_SOURCES) {
    const source = readFileSync(join(DESKTOP_ROOT, file), 'utf8')

    for (const pattern of CODE_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        codes.add(match[1])
      }
    }
  }

  return [...codes].sort()
}

describe('desktop update copy (hc-1030)', () => {
  it('has a sentence for every code the update flow can surface', () => {
    const codes = surfacedCodes()

    expect(codes).toEqual(expect.arrayContaining(['shell_update_not_ready', 'runtime_target_not_active', 'install_failed', 'disabled']))
    expect(codes.filter(code => !Object.hasOwn(zh.errors, code))).toEqual([])
  })

  it.each([
    ['shell_update_not_ready', zh.errors.shell_update_not_ready],
    ['shell_target_not_running', zh.errors.shell_target_not_running],
    ['net::ERR_TIMED_OUT', zh.errors.network],
    ['Error: net::ERR_PROXY_CONNECTION_FAILED', zh.errors.network],
    ['Could not verify existing engine workers.', zh.errors.generic],
    ['toString', zh.errors.generic]
  ])('reads %s as its sentence', (code, sentence) => {
    expect(describeDesktopUpdateError(zh, code)).toBe(sentence)
  })

  it('leaves no error as no sentence', () => {
    expect(describeDesktopUpdateError(zh, null)).toBeNull()
    expect(describeDesktopUpdateError(zh, undefined)).toBeNull()
  })

  it('writes every Chinese sentence in Chinese, not the English fallback', () => {
    for (const locale of ['zh', 'zh-hant'] as const) {
      const copy = DESKTOP_UPDATE_COPY[locale]
      const lines = [...Object.values(copy.errors), ...Object.values(copy.deferred), copy.errorCode('x')]

      expect(lines.filter(line => !/[一-鿿]/.test(line))).toEqual([])
      expect(Object.keys(copy.errors).sort()).toEqual(Object.keys(en.errors).sort())
    }
  })
})
