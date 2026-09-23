import assert from 'node:assert/strict'

import { test } from 'vitest'

import { checkLocalVideoReadiness, type LocalVideoTool } from './apex-hypit-readiness'

test('reports the exact missing local media prerequisites without claiming render readiness', async () => {
  const seen: LocalVideoTool[] = []

  const result = await checkLocalVideoReadiness(async tool => {
    seen.push(tool)

    return tool === 'node' || tool === 'npm'
  })

  assert.deepEqual(seen, ['node', 'npm', 'ffmpeg', 'ffprobe'])
  assert.deepEqual(result, {
    basicToolsReady: false,
    missing: ['ffmpeg', 'ffprobe'],
    renderVerified: false
  })
})

test('a passing PATH probe still does not certify Hypit project or browser setup', async () => {
  assert.deepEqual(await checkLocalVideoReadiness(async () => true), {
    basicToolsReady: true,
    missing: [],
    renderVerified: false
  })
})
