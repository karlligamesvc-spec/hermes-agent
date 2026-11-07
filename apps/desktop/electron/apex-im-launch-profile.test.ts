/**
 * hc-1171: Desktop hands the IM 入口's Feishu / WeChat credentials to the
 * messaging gateway through its environment only. With several profiles the
 * engine's APEX overlay (apex_overlay/im_launch_profile.py) gives exactly the
 * names in IM_ENV_NAMES to the profile the gateway was started for. A name
 * Desktop injects that the tuple does not list would silently stay out of that
 * profile's platform config.
 *
 * Run with: npx vitest run electron/apex-im-launch-profile.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { test } from 'vitest'

import { buildFeishuBackendEnv } from './apex-feishu'
import { CHANNEL_ENV_DESCRIPTORS } from './apex-im-entry'

const OVERLAY = resolve(__dirname, '../../../apex_overlay/im_launch_profile.py')

function overlayNames(): string[] {
  const blocks = [...readFileSync(OVERLAY, 'utf8').matchAll(/^IM_ENV_NAMES = \(([^)]*)\)/gm)]

  assert.equal(blocks.length, 1, 'IM_ENV_NAMES should be defined once')

  return [...blocks[0][1].matchAll(/"([A-Z0-9_]+)"/g)].map(match => match[1])
}

test('the overlay gives the gateway profile every IM name Desktop injects, and only those', () => {
  const feishu = Object.keys(buildFeishuBackendEnv({ appId: 'app', appSecret: 'secret', domain: 'feishu' }))

  const imEntry = Object.values(CHANNEL_ENV_DESCRIPTORS).flatMap((descriptor: any) =>
    descriptor.fields.map((field: any) => field.key)
  )

  const names = overlayNames()

  assert.equal(new Set(names).size, names.length, 'a name is listed twice')
  assert.deepEqual([...new Set([...feishu, ...imEntry])].sort(), [...names].sort())
})
