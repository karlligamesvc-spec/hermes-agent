import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { checkLocalVideoReadiness, type LocalVideoTool, probeLocalVideoTool } from './apex-hypit-readiness'
import { buildDesktopBackendPath } from './backend-env'

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

test.skipIf(process.platform === 'win32')('native probes find bundled tools and use each CLI version flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-media-readiness-'))
  const bin = path.join(root, '.runtime', 'bin')
  fs.mkdirSync(bin, { recursive: true })

  try {
    for (const tool of ['node', 'npm', 'ffmpeg', 'ffprobe'] as const) {
      const flag = tool.startsWith('ff') ? '-version' : '--version'
      fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = "${flag}" ]\n`, { mode: 0o755 })
    }

    const executablePath = buildDesktopBackendPath({ runtimeRoot: root, currentPath: '' })
    assert.deepEqual(await checkLocalVideoReadiness(tool => probeLocalVideoTool(tool, executablePath)), {
      basicToolsReady: true, missing: [], renderVerified: false
    })
    fs.writeFileSync(path.join(bin, 'ffprobe'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    assert.deepEqual((await checkLocalVideoReadiness(tool => probeLocalVideoTool(tool, executablePath))).missing, ['ffprobe'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
