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

describe('the answer to a confirmed install that waits (hc-1117)', () => {
  it.each(['zh', 'zh-hant'] as const)('%s says all of it in Chinese', locale => {
    const copy = DESKTOP_UPDATE_COPY[locale]
    const lines = [copy.wait.title, copy.wait.close, copy.wait.closeProgram, copy.wait.ownWork, copy.holders.childNote, ...Object.values(copy.wait.next)]

    expect(lines.filter(line => !/[一-鿿]/.test(line))).toEqual([])
    expect(Object.keys(copy.wait.next).sort()).toEqual(Object.keys(copy.deferred).sort())
  })

  it('leaves the zh sentences hc-1095 compares word for word alone', () => {
    expect(zh.deferred).toEqual({
      active_work: '有任务在进行，做完后自动安装更新。',
      activity_unknown: '正在确认 APEX 是否空闲，确认后自动安装更新。',
      engine_holders: '有别的程序在用 APEX 引擎，它退出后自动安装更新。',
      gateway_busy: '消息渠道还在回复消息，回复完自动安装更新。',
      previous_worker: '上次的 APEX 引擎进程还在退出，退出后自动安装更新。'
    })
  })
})

describe('engine holder copy (hc-1094)', () => {
  const KINDS = ['apex_running', 'leftover_child', 'leftover_engine', 'leftover_gateway', 'terminal_hermes'] as const

  it.each(['zh', 'zh-hant'] as const)('%s says every holder line in Chinese', locale => {
    const copy = DESKTOP_UPDATE_COPY[locale].holders

    const lines = [
      ...KINDS.map(kind => copy.names[kind]),
      copy.names.other(null),
      copy.names.other('Code Helper'),
      copy.waiting('x', false),
      copy.waiting('x', true),
      copy.endable(false),
      copy.endable(true),
      copy.terminal,
      copy.endAction.install,
      copy.endAction.switch,
      copy.confirmTitle,
      copy.confirmBody('x', 'install'),
      copy.confirmBody('x', 'switch'),
      copy.gatewayNote,
      copy.ending,
      copy.endFailed
    ]

    expect(lines.filter(line => !/[一-鿿]/.test(line))).toEqual([])
    expect(new Set(KINDS.map(kind => copy.names[kind])).size).toBe(KINDS.length)
  })

  it.each(['en', 'zh', 'zh-hant'] as const)('%s names each kind apart and joins a list', locale => {
    const copy = DESKTOP_UPDATE_COPY[locale].holders

    expect(new Set([...KINDS.map(kind => copy.names[kind]), copy.names.other(null)]).size).toBe(KINDS.length + 1)
    expect(copy.join(['a'])).toBe('a')
    expect(copy.withPids('a', [1, 2])).toMatch(/1.+2/)
  })

  it('puts a space between a Latin name and the Chinese after it, and none after Chinese', () => {
    expect(zh.holders.waiting('终端里运行的 hermes', false)).toBe('终端里运行的 hermes 在用 APEX 引擎，它退出后自动安装更新。')
    expect(zh.holders.waiting('其他程序（Code Helper）', false)).toBe('其他程序（Code Helper）在用 APEX 引擎，它退出后自动安装更新。')
    expect(en.holders.join(['a', 'b', 'c'])).toBe('a, b, and c')
    expect(en.holders.join(['a', 'b'])).toBe('a and b')
  })
})
