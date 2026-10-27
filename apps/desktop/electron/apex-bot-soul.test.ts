/**
 * hc-1078 (multi-bot M2): a new assistant's SOUL is APEX's identity with its own name, written by
 * the renderer at create time. The hc-1042 boot step swaps only SOULs that upstream seeded by itself,
 * so it must leave this one alone, on every launch.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import { composeApexBotSoul } from '../shared/apex-bot-soul'

import { ensureApexDesktopSouls, normalizedSoul, upgradeProfileSouls, upstreamSeededSoul } from './apex-default-soul'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

describe('a new assistant SOUL at boot', () => {
  test('is not an upstream seed and is not taken for the APEX default', () => {
    const soul = `${composeApexBotSoul({ name: '剪辑助手' })}\n## 分工\n\n你主要帮我做这些：\n- 剪辑出片\n`

    assert.equal(upstreamSeededSoul(soul), null)
    assert.notEqual(normalizedSoul(soul).split('\n')[0], 'You are APEX, an intelligent AI assistant from ApexNodes HK.')
  })

  test('survives the boot SOUL step byte for byte', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-bot-soul-'))
    roots.push(home)
    const soulPath = path.join(home, 'profiles', 'apex-bot-2', 'SOUL.md')
    const soul = composeApexBotSoul({ name: '小红书文案' })
    fs.mkdirSync(path.dirname(soulPath), { recursive: true })
    fs.writeFileSync(soulPath, soul, 'utf8')

    assert.deepEqual(upgradeProfileSouls(home), { 'apex-bot-2': { kind: 'kept' } })
    ensureApexDesktopSouls(home)
    assert.equal(fs.readFileSync(soulPath, 'utf8'), soul)
  })
})
