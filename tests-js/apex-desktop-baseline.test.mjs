/**
 * ApexNodes hc-911: guard the tests-js half of the APEX Desktop baseline skip list.
 *
 * vitest.config.ts excludes upstream tests that drive upstream Desktop modules apps/desktop does
 * not carry. Each entry must name a real test file and cite only apps/desktop paths that are still
 * absent: a ported path means the upstream test can run again, so its entry has to go.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

import { APEX_DESKTOP_BASELINE } from './vitest.config.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('..', import.meta.url))

test('every excluded test file still exists', () => {
  const missing = Object.keys(APEX_DESKTOP_BASELINE).filter(file => !existsSync(here + file))
  expect(missing).toEqual([])
})

test('every cited upstream Desktop path is still absent', () => {
  const stale = Object.entries(APEX_DESKTOP_BASELINE).flatMap(([file, paths]) => {
    expect(paths.length, file).toBeGreaterThan(0)
    expect(paths.every(path => path.startsWith('apps/desktop/')), file).toBe(true)
    return paths.filter(path => existsSync(repo + path)).map(path => `${file}: ${path}`)
  })
  expect(stale).toEqual([])
})
