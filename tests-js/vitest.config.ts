import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.mjs'],
    // ApexNodes hc-911: drives upstream Desktop modules the APEX Desktop baseline does not carry.
    exclude: ['**/node_modules/**', 'scripts/desktop-smoke.test.ts'],
  },
})
