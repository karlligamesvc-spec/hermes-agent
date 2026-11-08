import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { registerApexDesktopProtocol } from './desktop-deep-link'
import {
  applyMacDockIcon,
  type DesktopLaunchProcess,
  DEV_PROTOCOL_OPT_IN_ENV,
  DEV_PROTOCOL_SKIPPED_LOG,
  planApexDesktopProtocol
} from './desktop-dev-launch'

const ELECTRON_DIR = __dirname

const MAC_APP = '/Applications/APEX.app/Contents/MacOS/APEX'
const WIN_APP = 'C:\\Users\\me\\AppData\\Local\\Programs\\APEX\\APEX.exe'
const DEV_ELECTRON = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'

function launch(
  defaultApp: boolean | undefined,
  argv: string[],
  env: Record<string, string> = {}
): DesktopLaunchProcess {
  return { argv, defaultApp, env, execPath: argv[0] }
}

function recordingRegistrar() {
  const calls: unknown[][] = []

  return {
    calls,
    registrar: {
      setAsDefaultProtocolClient(...args: unknown[]) {
        calls.push(args)

        return true
      }
    }
  }
}

// The registration main.ts runs: plan first, then the one registrar call.
function registerLikeMain(
  process: DesktopLaunchProcess,
  registrar: ReturnType<typeof recordingRegistrar>['registrar']
) {
  const { developmentLaunch, register } = planApexDesktopProtocol(process)

  return register ? registerApexDesktopProtocol(registrar, developmentLaunch) : false
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('apexnodes:// registration', () => {
  test.each<[string, DesktopLaunchProcess, unknown[][]]>([
    ['packaged macOS app', launch(undefined, [MAC_APP]), [['apexnodes']]],
    [
      'packaged Windows app opened by a link',
      launch(undefined, [WIN_APP, 'apexnodes://login?code=c']),
      [['apexnodes']]
    ],
    [
      'packaged app ignores the development opt-in',
      launch(undefined, [MAC_APP], { [DEV_PROTOCOL_OPT_IN_ENV]: '1' }),
      [['apexnodes']]
    ],
    ['packaged app with defaultApp false', launch(false, [MAC_APP, '--flag']), [['apexnodes']]],
    ['development launch, no opt-in', launch(true, [DEV_ELECTRON, '/repo/apps/desktop']), []],
    [
      'development launch, opt-in "true"',
      launch(true, [DEV_ELECTRON, '/repo/apps/desktop'], { [DEV_PROTOCOL_OPT_IN_ENV]: 'true' }),
      []
    ],
    [
      'development launch, opt-in "0"',
      launch(true, [DEV_ELECTRON, '/repo/apps/desktop'], { [DEV_PROTOCOL_OPT_IN_ENV]: '0' }),
      []
    ],
    [
      'development launch, opt-in empty',
      launch(true, [DEV_ELECTRON, '/repo/apps/desktop'], { [DEV_PROTOCOL_OPT_IN_ENV]: '' }),
      []
    ],
    [
      'development launch, opted in',
      launch(true, [DEV_ELECTRON, '/repo/apps/desktop'], { [DEV_PROTOCOL_OPT_IN_ENV]: '1' }),
      [['apexnodes', DEV_ELECTRON, [path.resolve('/repo/apps/desktop')]]]
    ],
    [
      'development launch, opted in, no entry script',
      launch(true, [DEV_ELECTRON], { [DEV_PROTOCOL_OPT_IN_ENV]: '1' }),
      [['apexnodes']]
    ]
  ])('%s', (_name, process, expectedCalls) => {
    const { calls, registrar } = recordingRegistrar()

    const registered = registerLikeMain(process, registrar)

    assert.deepEqual(calls, expectedCalls)
    assert.equal(registered, expectedCalls.length === 1)
  })

  test('the skipped-registration log names the opt-in', () => {
    expect(DEV_PROTOCOL_SKIPPED_LOG).toContain('HERMES_DESKTOP_DEV_PROTOCOL=1')
    expect(DEV_PROTOCOL_SKIPPED_LOG.startsWith('[deeplink] ')).toBe(true)
  })
})

describe('macOS Dock icon', () => {
  test.each<[string, boolean | undefined, string | undefined, string[]]>([
    ['packaged app sets the APEX icon', undefined, '/app/icon.png', ['/app/icon.png']],
    ['packaged app with defaultApp false sets it', false, '/app/icon.png', ['/app/icon.png']],
    ['development launch keeps the Electron icon', true, '/app/icon.png', []],
    ['packaged app without a decodable icon leaves the Dock alone', undefined, undefined, []]
  ])('%s', (_name, defaultApp, icon, expected) => {
    const set: string[] = []

    applyMacDockIcon({ setIcon: value => set.push(value) }, icon, { defaultApp })

    assert.deepEqual(set, expected)
  })

  test('no Dock (Windows, Linux) is a no-op', () => {
    expect(() => applyMacDockIcon(undefined, '/app/icon.png', { defaultApp: undefined })).not.toThrow()
  })
})

describe('every OS identity call goes through the development-launch seam', () => {
  const sources = fs
    .readdirSync(ELECTRON_DIR)
    .filter(name => /\.(ts|cts|mts)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name))
    .map(name => ({ code: codeOnly(fs.readFileSync(path.join(ELECTRON_DIR, name), 'utf8')), name }))

  const callers = (pattern: RegExp) => sources.filter(({ code }) => pattern.test(code)).map(({ name }) => name)

  test('only desktop-deep-link.ts calls setAsDefaultProtocolClient', () => {
    assert.deepEqual(callers(/\.setAsDefaultProtocolClient\(/), ['desktop-deep-link.ts'])
  })

  test('only desktop-dev-launch.ts sets the Dock icon', () => {
    assert.deepEqual(callers(/\bdock\??\.setIcon\(/), ['desktop-dev-launch.ts'])
  })

  test('main.ts registers through the plan and sets the Dock icon through the seam', () => {
    const main = sources.find(({ name }) => name === 'main.ts')?.code ?? ''

    assert.equal(main.match(/planApexDesktopProtocol\(process\)/g)?.length, 1)
    assert.equal(main.match(/registerApexDesktopProtocol\(/g)?.length, 1)
    assert.match(main, /register \? registerApexDesktopProtocol\(app, developmentLaunch\) : false/)
    assert.match(main, /if \(!register\) \{\s*rememberLog\(DEV_PROTOCOL_SKIPPED_LOG\)/)
    assert.equal(main.match(/applyMacDockIcon\(app\.dock, icon, process\)/g)?.length, 1)
  })
})
