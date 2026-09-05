import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  APEX_DESKTOP_PROTOCOL,
  createDesktopDeepLinkRouter,
  type DesktopDeepLinkPayload,
  findDesktopDeepLink,
  registerApexDesktopProtocol
} from './desktop-deep-link'

function recorder() {
  const delivered: DesktopDeepLinkPayload[] = []

  const router = createDesktopDeepLinkRouter({
    deliver(payload) {
      delivered.push(payload)

      return true
    }
  })

  return { delivered, router }
}

test('the packaged app claims only the APEX protocol name', () => {
  const calls: unknown[][] = []

  const registered = registerApexDesktopProtocol({
    setAsDefaultProtocolClient(...args) {
      calls.push(args)

      return true
    }
  })

  assert.equal(APEX_DESKTOP_PROTOCOL, 'apexnodes')
  assert.equal(registered, true)
  assert.deepEqual(calls, [['apexnodes']])
})

test('development registration keeps the APEX scheme and launch namespace', () => {
  const calls: unknown[][] = []

  registerApexDesktopProtocol(
    {
      setAsDefaultProtocolClient(...args) {
        calls.push(args)

        return true
      }
    },
    { entryScript: '/repo/electron/main.js', executable: '/electron' }
  )

  assert.deepEqual(calls, [['apexnodes', '/electron', ['/repo/electron/main.js']]])
})

test('cold-start argv finds an APEX login link', () => {
  assert.equal(
    findDesktopDeepLink(['APEX.exe', '--flag', 'apexnodes://login?code=cold-code']),
    'apexnodes://login?code=cold-code'
  )
})

test('macOS open-url delivers an APEX login after renderer readiness', () => {
  const { delivered, router } = recorder()
  router.markRendererReady()

  const result = router.accept('apexnodes://login?code=mac-code', 'macos-open-url')

  assert.deepEqual(result, {
    accepted: true,
    disposition: 'delivered',
    payload: { kind: 'login', name: '', params: { code: 'mac-code' } }
  })
  assert.deepEqual(delivered, [{ kind: 'login', name: '', params: { code: 'mac-code' } }])
})

test('Windows second-instance delivers the URL extracted from argv', () => {
  const { delivered, router } = recorder()
  router.markRendererReady()
  const url = findDesktopDeepLink(['APEX.exe', 'apexnodes://login?code=win-code'])

  assert.equal(router.accept(url, 'second-instance').accepted, true)
  assert.equal(delivered[0]?.params.code, 'win-code')
})

test('a login received during startup is queued and flushed exactly once', () => {
  const { delivered, router } = recorder()

  assert.deepEqual(router.accept('apexnodes://login?code=queued-code', 'cold-start'), {
    accepted: true,
    disposition: 'queued',
    payload: { kind: 'login', name: '', params: { code: 'queued-code' } }
  })
  assert.equal(router.pendingCount(), 1)
  assert.equal(router.markRendererReady(), 1)
  assert.equal(router.markRendererReady(), 0)
  assert.equal(router.pendingCount(), 0)
  assert.equal(delivered.length, 1)
})

test('login rejects a foreign or compatibility scheme, missing code, repeated query code and replayed code', () => {
  const { router } = recorder()
  router.markRendererReady()

  assert.deepEqual(router.accept('https://login?code=x'), { accepted: false, reason: 'unsupported-scheme' })
  assert.deepEqual(router.accept('hermes://login?code=x'), { accepted: false, reason: 'unsupported-scheme' })
  assert.deepEqual(router.accept('apexnodes://login'), { accepted: false, reason: 'missing-code' })
  assert.deepEqual(router.accept('apexnodes://login?code=x&code=y'), { accepted: false, reason: 'missing-code' })
  assert.equal(router.accept('apexnodes://login?code=once').accepted, true)
  assert.deepEqual(router.accept('apexnodes://login?code=once'), { accepted: false, reason: 'duplicate-code' })
})

test('legacy Hermes blueprint links remain parse-compatible without becoming the registered scheme', () => {
  const { delivered, router } = recorder()
  router.markRendererReady()

  assert.equal(router.accept('hermes://blueprint/morning-brief?time=08%3A00').accepted, true)
  assert.deepEqual(delivered, [{ kind: 'blueprint', name: 'morning-brief', params: { time: '08:00' } }])
})
