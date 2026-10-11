import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ApexDiagnostics, type Fact } from './apex-diagnostics'
const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })))
})

async function home() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-diag-'))
  homes.push(value)

  return value
}

describe('durable APEX diagnostics', () => {
  it('retains offline records over restart, isolates accounts and removes only acknowledged events', async () => {
    const dir = await home()
    let key = 'A'

    const failed = new ApexDiagnostics(
      dir,
      () => key,
      '0.17.56',
      async () => {
        throw Error('offline')
      }
    )

    await failed.initialize()
    const a = await failed.record({ operation: 'startup', status: 'failure' })
    expect(await failed.flush()).toBe(false)
    const sent: any[] = []

    const client = new ApexDiagnostics(
      dir,
      () => key,
      '0.17.56',
      async (_url, request) => {
        const body = JSON.parse(String(request?.body))
        sent.push({ key: (request?.headers as any).Authorization, ...body })

        return new Response(JSON.stringify({ accepted: body.events.map((e: any) => e.event_id) }))
      }
    )

    key = 'B'
    const b = await client.record({ operation: 'preview', status: 'success' })
    await client.flush()
    expect(sent[0].key).toBe('Bearer B')
    expect(sent[0].events.map((e: any) => e.event_id)).toEqual([b])
    key = 'A'
    await client.flush()
    await client.flush()
    expect(sent).toHaveLength(2)
    expect(sent[1].events.map((e: any) => e.event_id)).toEqual([a])
  })
  it('never stores caller content and keeps opted-out accounts opted out after initialization', async () => {
    const dir = await home()
    let calls = 0

    const client = new ApexDiagnostics(
      dir,
      () => 'KEY_SECRET',
      '0.17.56',
      async () => {
        calls++
        throw Error('offline')
      }
    )

    await client.initialize()
    await client.record({
      operation: 'renderer',
      status: 'failure',
      name: '/Users/private',
      message: 'SECRET_TEXT',
      error_code: 'raw-secret'
    } as unknown as Fact)
    const disk = await fs.readFile(path.join(dir, 'diagnostics/desktop.json'), 'utf8')

    for (const secret of ['SECRET_TEXT', '/Users/private', 'KEY_SECRET', 'raw-secret'])
      {expect(disk).not.toContain(secret)}

    await client.setEnabled(false)
    await client.initialize()
    await client.flush()
    expect(await client.enabled()).toBe(false)
    expect(calls).toBe(0)
    expect(JSON.parse(await fs.readFile(path.join(dir, 'diagnostics/desktop.json'), 'utf8'))).toEqual([])
  })
  it('does not label cancelled or failed downloads successful and preserves thrown errors', async () => {
    const dir = await home()
    const client = new ApexDiagnostics(dir, () => 'key', '0.17.56')
    await client.initialize()
    await client.measure('download', 'file', async () => ({ canceled: true }))
    await client.measure('download', 'file', async () => ({ saved: false }))
    const error = new Error('not found')
    await expect(
      client.measure('preview', 'text', async () => {
        throw error
      })
    ).rejects.toBe(error)
    await client.record({ operation: 'diagnostics', status: 'success' }) // drain queued writes
    const rows = JSON.parse(await fs.readFile(path.join(dir, 'diagnostics/desktop.json'), 'utf8'))
    expect(rows.slice(0, 3).map((row: any) => row.event.status)).toEqual(['cancelled', 'failure', 'failure'])
  })
})
