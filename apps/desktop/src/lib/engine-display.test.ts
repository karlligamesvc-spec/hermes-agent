import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'
import { LOCALE_OPTIONS } from '@/i18n/languages'

import { formatEngineDisplayVersion } from './engine-display'

// The exact per-locale word the prefix must resolve to -- zh and zh-hant
// legitimately share the identical characters ("引擎"; neither 引 nor 擎 has a
// distinct traditional form), so this cannot be a "must all be distinct" check.
const EXPECTED_ENGINE_PREFIX: Record<(typeof LOCALE_OPTIONS)[number]['id'], string> = {
  ar: 'Engine',
  en: 'Engine',
  zh: '引擎',
  'zh-hant': '引擎',
  ja: 'エンジン'
}

// hc-591: Kael's ask was specific -- the raw calver+fork engine pin (e.g.
// `v2026.7.25-fork.b0a720a5`) must never reach a user-facing surface verbatim.
// These tests pin the formatter's contract table-driven, per
// AGENTS.md's "确定性表驱动测试" convention: exact input -> exact output, no
// randomness, no loose "is truthy" assertions.
afterEach(() => {
  setRuntimeI18nLocale('en')
})

describe('formatEngineDisplayVersion', () => {
  describe('calver+fork strings (the exact shape Kael flagged)', () => {
    it.each([
      ['v2026.7.25-fork.b0a720a5', 'Engine 2026.7.25'],
      ['v2026.7.1-fork.3ab3eabf', 'Engine 2026.7.1'],
      ['v2026.12.31-fork.0000000000000000000000000000000000000000', 'Engine 2026.12.31'],
      // The captured calver core is passed through verbatim -- no numeric
      // normalization, so a zero-padded month/day stays zero-padded.
      ['v2026.07.05-fork.abc1234', 'Engine 2026.07.05']
    ])('%s -> %s', (raw, expected) => {
      expect(formatEngineDisplayVersion(raw)).toBe(expected)
    })

    it('never leaves the `-fork.` segment in the output', () => {
      expect(formatEngineDisplayVersion('v2026.7.25-fork.b0a720a5')).not.toContain('-fork.')
      expect(formatEngineDisplayVersion('v2026.7.25-fork.b0a720a5')).not.toContain('b0a720a5')
    })
  })

  describe('pure calver (no -fork suffix)', () => {
    it.each([
      ['v2026.7.25', 'Engine 2026.7.25'],
      // A leading `v` is optional -- a bare calver string is recognized too.
      ['2026.7.25', 'Engine 2026.7.25']
    ])('%s -> %s', (raw, expected) => {
      expect(formatEngineDisplayVersion(raw)).toBe(expected)
    })
  })

  describe('displayName override', () => {
    it('wins outright when non-empty, ignoring version entirely', () => {
      expect(formatEngineDisplayVersion('v2026.7.25-fork.b0a720a5', 'Nous Turbo')).toBe('Nous Turbo')
    })

    it('is ignored when null, undefined, or blank -- falls through to the version parse', () => {
      expect(formatEngineDisplayVersion('v2026.7.25-fork.b0a720a5', null)).toBe('Engine 2026.7.25')
      expect(formatEngineDisplayVersion('v2026.7.25-fork.b0a720a5', undefined)).toBe('Engine 2026.7.25')
      expect(formatEngineDisplayVersion('v2026.7.25-fork.b0a720a5', '   ')).toBe('Engine 2026.7.25')
    })
  })

  describe('unparseable strings fail open (returned verbatim, never throw)', () => {
    it.each([
      // A raw commit sha (e.g. the check.latest.key fallback) -- not a calver.
      ['b0a720a52e1179b42d3148074d3750454ff'],
      // A branch name.
      ['main'],
      // The hermes-agent pip package version (plain semver, no 4-digit year) --
      // this is a DIFFERENT versioning scheme (gateway /api/status), never the
      // ApexNodes engine pin, so it must never gain an "Engine " prefix either.
      ['0.19.0'],
      ['v0.19.0'],
      // A calver core with a suffix we don't explicitly recognize.
      ['v2026.7.25-beta.1'],
      ['v2026.7.25-rc1'],
      ['dev'],
      ['']
    ])('%s is returned unchanged', raw => {
      expect(formatEngineDisplayVersion(raw)).toBe(raw)
    })

    it('never throws on a non-string runtime value despite the string type', () => {
      // A defensive guard for an IPC-sourced `any` slipping past the TS type --
      // must fail open, not crash the renderer.
      const notAString = null as unknown as string

      expect(() => formatEngineDisplayVersion(notAString)).not.toThrow()
      expect(formatEngineDisplayVersion(notAString)).toBe(notAString)
    })
  })

  describe('locale coverage (4 languages, compile-time enforced via i18n/types.ts)', () => {
    it.each(LOCALE_OPTIONS.map(({ id }) => [id, `${EXPECTED_ENGINE_PREFIX[id]} 2026.7.25`] as const))(
      'locale %s prefixes with the localized engine noun (%s)',
      (locale, expected) => {
        setRuntimeI18nLocale(locale)
        expect(formatEngineDisplayVersion('v2026.7.25-fork.b0a720a5')).toBe(expected)
      }
    )

    // Belt-and-braces against the `defineLocale()` silent-fallback gap: zh-hant
    // and ja are defined as PARTIAL overrides merged onto English (see
    // i18n/define-locale.ts), so a missing key there compiles fine and just
    // falls back to the English string at runtime -- tsc alone can't catch
    // that for those two locales. This reads the catalog directly (no
    // translateNow/runtime-locale plumbing) as an independent check that every
    // supported locale carries its OWN translation, not a silent English
    // fallback.
    it.each(LOCALE_OPTIONS.map(({ id }) => [id] as const))(
      'locale %s carries its own catalog entry, not an English fallback',
      locale => {
        expect(TRANSLATIONS[locale].common.engineVersionPrefix).toBe(EXPECTED_ENGINE_PREFIX[locale])
      }
    )
  })
})
