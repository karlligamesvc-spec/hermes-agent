import { describe, expect, it } from 'vitest'

import afterPack from './after-pack.mjs'

describe('afterPack Windows identity gate', () => {
  it('does nothing for non-Windows packages', async () => {
    await expect(afterPack({ electronPlatformName: 'darwin' })).resolves.toBeUndefined()
  })

  it('fails packaging when the Windows executable cannot be stamped', async () => {
    await expect(
      afterPack({
        electronPlatformName: 'win32',
        appOutDir: '/definitely-not-an-electron-package',
        packager: { appInfo: { productFilename: 'APEX' } }
      })
    ).rejects.toThrow(/target exe not found.*APEX\.exe/)
  })
})
