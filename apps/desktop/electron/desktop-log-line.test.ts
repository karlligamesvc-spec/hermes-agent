import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CREDENTIAL_QUERY_PARAMS, formatDesktopLogLine, maskCredentialQueryParams } from './desktop-log-line'

describe('formatDesktopLogLine', () => {
  it('prefixes each line with an ISO-8601 timestamp and the hermes tag', () => {
    const line = formatDesktopLogLine('[boot] Resolving Hermes backend')

    // Shape contract (not a snapshot): every desktop log line starts with
    // an ISO timestamp so multi-surface logs are chronologically readable.
    // See #84405.
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[hermes\] \[boot\] Resolving Hermes backend$/
    )
  })

  it('keeps the message verbatim after the prefix', () => {
    const line = formatDesktopLogLine('Hermes backend exited (0)')

    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[hermes\] Hermes backend exited \(0\)$/)
  })
})

// hc-1174: the Feishu SDK prints its websocket address, credentials included, and a
// child's stdout lands in desktop.log through this function.
describe('credential query parameters', () => {
  const url =
    'wss://msg-frontier.feishu.cn/ws/v2?fpid=493&aid=552564&device_id=7570123456789' +
    '&access_key=f0e1d2c3b4a5968778695a4b3c2d1e0f&service_id=33554678&ticket=7a1c9e2b-3d4f-4a6b-8c0d-1e2f3a4b5c6d'

  it('masks access_key and ticket in a Feishu SDK line and keeps the rest', () => {
    const line = formatDesktopLogLine(
      `[Lark] [2026-11-07 19:00:00,000] [INFO] connected to ${url} [conn_id=7570123456789]`
    )

    expect(line).not.toContain('f0e1d2c3b4a5968778695a4b3c2d1e0f')
    expect(line).not.toContain('7a1c9e2b-3d4f-4a6b-8c0d-1e2f3a4b5c6d')
    expect(line).toMatch(
      /\[hermes\] \[Lark\] .* connected to wss:\/\/msg-frontier\.feishu\.cn\/ws\/v2\?fpid=493&aid=552564&device_id=7570123456789&access_key=\*\*\*&service_id=33554678&ticket=\*\*\* \[conn_id=7570123456789\]$/
    )
  })

  it.each([
    ['wss://h/ws?access_key=abc', 'wss://h/ws?access_key=***'],
    ['wss://h/ws?TICKET=t-1&fpid=1', 'wss://h/ws?TICKET=***&fpid=1'],
    ["url='wss://h/ws?ticket=t-1'", "url='wss://h/ws?ticket=***'"],
    ['wss://h/ws?my_ticket=keep&service_id=2', 'wss://h/ws?my_ticket=keep&service_id=2'],
    ['Hermes backend exited (0)', 'Hermes backend exited (0)']
  ])('%s', (text, expected) => {
    expect(maskCredentialQueryParams(text)).toBe(expected)
  })

  it('masks every line of a chunk, not just the first', () => {
    const lines = ['a', `connected to ${url}`, `disconnected to ${url}`].map(text => formatDesktopLogLine(text))

    expect(lines.join('\n')).not.toMatch(/access_key=(?!\*\*\*)|ticket=(?!\*\*\*)/)
  })

  it('masks the same names the engine masks at the SDK logger', () => {
    const overlay = readFileSync(resolve(__dirname, '../../../apex_overlay/lark_log_redaction.py'), 'utf8')
    const blocks = [...overlay.matchAll(/^CREDENTIAL_PARAMS = \(([^)]*)\)/gm)]

    expect(blocks).toHaveLength(1)
    expect([...blocks[0][1].matchAll(/"([a-z_]+)"/g)].map(match => match[1])).toEqual([...CREDENTIAL_QUERY_PARAMS])
  })
})
