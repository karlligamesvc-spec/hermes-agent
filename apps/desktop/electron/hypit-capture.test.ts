import { describe, expect, it, vi } from 'vitest'
import { managedCaptureArgs } from '../../../apex_overlay/hypit_capture.mjs'

describe('Hypit managed browser routing', () => {
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
