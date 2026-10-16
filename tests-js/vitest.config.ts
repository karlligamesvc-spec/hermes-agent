import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// ApexNodes hc-911: apps/desktop stays on the APEX baseline (paired Mac arm64/x64 + Windows x64
// NSIS release), which does not carry these upstream Desktop modules. A test file is excluded only
// while EVERY path it cites is absent, so porting one brings the test back
// (apex-desktop-baseline.test.mjs also fails on a stale entry).
const repo = fileURLToPath(new URL('..', import.meta.url))
const PRODUCT_IDENTITY = 'apps/desktop/product-identity.cjs'

export const APEX_DESKTOP_BASELINE: Record<string, string[]> = {
  'scripts/desktop-smoke.test.ts': ['apps/desktop/electron/backend-discovery.ts', 'apps/desktop/electron/data-paths.mjs'],
  'desktop-builder.test.mjs': ['apps/desktop/scripts/build.mjs', PRODUCT_IDENTITY],
  'bundle-smoke-metadata.test.mjs': [PRODUCT_IDENTITY],
  'desktop-mac-usage-descriptions.test.ts': ['apps/desktop/electron-builder.config.cjs'],
  'macos-bundled-helpers.test.mjs': ['apps/desktop/update-feed.cjs'],
  'macos-publish-config.test.mjs': ['apps/desktop/update-feed.cjs', 'apps/desktop/electron-builder.config.cjs'],
  'renderer-syntax-node.test.mjs': ['apps/desktop/scripts/check-chunks-parse.mjs'],
  // APEX's own notarize.mjs predates upstream's notarytool wait/resume recovery, which this tests.
  'notarize.test.mjs': [PRODUCT_IDENTITY],
}

const baselineExcludes = Object.entries(APEX_DESKTOP_BASELINE)
  .filter(([, paths]) => paths.every(path => !existsSync(repo + path)))
  .map(([file]) => file)

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.mjs'],
    exclude: ['**/node_modules/**', ...baselineExcludes],
  },
})
