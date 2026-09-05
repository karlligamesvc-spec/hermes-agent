import { describe, expect, it } from 'vitest'

import {
  createDesktopLifecycleContext,
  formatLifecycleEvent,
  httpFailureLifecycleFields,
  processGoneLifecycleFields,
  sanitizeLifecycleArgv
} from './lifecycle-diagnostics'

describe('desktop lifecycle diagnostics', () => {
  it('records a stable process identity and the effective userData namespace', () => {
    const context = createDesktopLifecycleContext({
      argv: ['APEX.exe', '--user-data-dir=C:\\isolated'],
      parentPid: 7,
      pid: 42,
      userData: 'C:\\isolated',
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      randomUUID: () => 'instance-a'
    })

    expect(context).toEqual({
      argv: ['APEX.exe', '--user-data-dir=C:\\isolated'],
      instanceNonce: 'instance-a',
      parentPid: 7,
      pid: 42,
      startedAt: '2026-09-05T00:00:00.000Z',
      userData: 'C:\\isolated'
    })
    expect(
      formatLifecycleEvent(
        'electron.single_instance_lock',
        context,
        { acquired: true },
        () => new Date('2026-09-05T00:00:01.000Z')
      )
    ).toContain('"eventAt":"2026-09-05T00:00:01.000Z"')
  })

  it('does not let call-site fields forge the event or process identity', () => {
    const context = createDesktopLifecycleContext({
      argv: ['APEX.exe'],
      parentPid: 7,
      pid: 42,
      userData: 'C:\\isolated',
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      randomUUID: () => 'instance-a'
    })
    const line = formatLifecycleEvent(
      'electron.quit',
      context,
      { event: 'forged', eventAt: 'forged', instanceNonce: 'forged', pid: 999 },
      () => new Date('2026-09-05T00:00:02.000Z')
    )

    expect(JSON.parse(line.slice('[lifecycle] '.length))).toMatchObject({
      event: 'electron.quit',
      eventAt: '2026-09-05T00:00:02.000Z',
      instanceNonce: 'instance-a',
      pid: 42
    })
  })

  it('keeps launch flags visible while redacting one-time login credentials', () => {
    expect(
      sanitizeLifecycleArgv([
        'APEX.exe',
        '--remote-debugging-port=9229',
        '--token',
        'cli-secret',
        '--access-token=inline-secret',
        'apexnodes://login?code=secret-code&state=visible'
      ])
    ).toEqual([
      'APEX.exe',
      '--remote-debugging-port=9229',
      '--token',
      '<redacted>',
      '--access-token=<redacted>',
      'apexnodes://login?code=%3Credacted%3E&state=visible'
    ])
  })

  it('records the method, path, status, and renderer page for an HTTP failure', () => {
    expect(
      httpFailureLifecycleFields({
        method: 'post',
        path: '/api/model/set',
        pageUrl: 'file:///app/index.html#/settings?token=secret',
        statusCode: 405
      })
    ).toEqual({
      method: 'POST',
      path: '/api/model/set',
      pageUrl: 'file:///app/index.html#/settings?token=%3Credacted%3E',
      statusCode: 405
    })
  })

  it('normalizes Electron child and renderer exit details', () => {
    expect(
      processGoneLifecycleFields({
        exitCode: -1073741819,
        name: 'GPU Process',
        reason: 'crashed',
        serviceName: 'audio.mojom.AudioService',
        type: 'GPU'
      })
    ).toEqual({
      exitCode: -1073741819,
      name: 'GPU Process',
      reason: 'crashed',
      serviceName: 'audio.mojom.AudioService',
      type: 'GPU'
    })
  })
})
