import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

test('main process registers every literal IPC handler channel exactly once', () => {
  const source = fs.readFileSync(path.join(here, 'main.ts'), 'utf8')
  const channels = [...source.matchAll(/ipcMain\.handle\(\s*(['"])([^'"]+)\1/g)].map(match => match[2])
  const duplicates = [...new Set(channels.filter((channel, index) => channels.indexOf(channel) !== index))]

  expect(duplicates).toEqual([])
})
