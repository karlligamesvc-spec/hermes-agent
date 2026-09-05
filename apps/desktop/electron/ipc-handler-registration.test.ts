import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

test('main startup registers every literal IPC handler channel exactly once', () => {
  const startupSources = [
    'main.ts',
    'fs-ipc.ts',
    'git-ipc.ts',
    'hud-ipc.ts',
    'mcp-oauth-callback-ipc.ts',
    'pet-overlay-ipc.ts',
    'shell-updater.ts',
    'terminal-ipc.ts'
  ].map(file => fs.readFileSync(path.join(here, file), 'utf8'))

  const channels = startupSources.flatMap(source =>
    [...source.matchAll(/ipcMain\.handle\(\s*(['"])([^'"]+)\1/g)].map(match => match[2])
  )

  const duplicates = [...new Set(channels.filter((channel, index) => channels.indexOf(channel) !== index))]

  expect(duplicates).toEqual([])
})
