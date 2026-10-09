import { describe, expect, it, vi } from 'vitest'

import { managedCaptureArgs } from '../../../apex_overlay/hypit_capture.mjs'
import { hypitEnvironment } from '../../../apex_overlay/hypit_environment.mjs'

describe('Hypit managed browser routing', () => {
  it('preserves system command discovery with mixed-case inherited PATH keys', () => {
    const inherited = { Path: 'system-tools', PATH: 'extra-tools', PYTHONPATH: 'python-tools' }
    const env = hypitEnvironment(inherited, '/runtime', '/runtime/node/node', 'https://cos/registry')
    expect(Object.keys(env).filter(key => key.toUpperCase() === 'PATH')).toEqual(['PATH'])
    expect(env.PATH).toContain('system-tools')
    expect(env.PATH).toContain('extra-tools')
    expect(env.PYTHONPATH).toContain('python-tools')
    expect(env.npm_config_registry).toBe('https://cos/registry')
    expect(inherited.Path).toBe('system-tools')
  })
  it('uses COS browser for screenshot and installs without calling the upstream downloader', async () => {
    const resolve = vi.fn(async () => '/cache/Chrome Browser')
    expect(await managedCaptureArgs(['capture', 'screenshot', 'page.html', '--to', 'page.png'], resolve))
      .toEqual({ args: ['capture', 'screenshot', 'page.html', '--to', 'page.png', '--browser', '/cache/Chrome Browser'] })
    expect(await managedCaptureArgs(['capture', 'install-browser'], resolve)).toEqual({ installed: '/cache/Chrome Browser' })
  })
  it('preserves script arguments and explicit browser choices', async () => {
    const resolve = vi.fn(async () => '/managed/chrome')
    expect((await managedCaptureArgs(['capture', 'run', 'script.mjs', '--', '--browser', 'script-value'], resolve)).args)
      .toEqual(['capture', 'run', 'script.mjs', '--browser', '/managed/chrome', '--', '--browser', 'script-value'])
    resolve.mockClear()

    for (const args of [['capture', '--help'], ['capture', 'run', 'x.mjs', '--browser=/custom'], ['runtime', 'up']]) {
      expect(await managedCaptureArgs(args, resolve)).toEqual({ args })
    }

    expect(resolve).not.toHaveBeenCalled()
  })
  it('propagates mirror failures instead of falling through to upstream downloads', async () => {
    await expect(managedCaptureArgs(['capture', 'screenshot', 'page.html'], async () => { throw new Error('checksum') }))
      .rejects.toThrow('checksum')
  })
})
