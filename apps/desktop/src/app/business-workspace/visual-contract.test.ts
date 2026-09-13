import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const desktopRoot = resolve(__dirname, '../../..')

const sha256 = (...parts: string[]) =>
  createHash('sha256').update(readFileSync(resolve(desktopRoot, ...parts))).digest('hex')

describe('hc-825 approved visual assets', () => {
  it.each([
    ['apex-mark-minimal.png', '65414554f5d8ab564193c45c306a1735958e2038eca0d1a420878bf9702feb85'],
    ['workflow-commerce-minimal.png', 'f21167b5be6f4741b39fb4aa489f153d378e8b49c9e2ff757be0d61b4ed06be9'],
    ['workflow-geo-minimal.png', 'b43d753c879ba3bf4d6c284dcc8f764104b23e25e875e519136c7fee45b0bb60'],
    ['workflow-content-minimal.png', '50b61c9b6853bc0679ccb0a3987f58fad552f0f9045cec28dded6e2faa419849']
  ])('keeps %s byte-identical to the approved source', (name, expected) => {
    expect(sha256('public', 'assets', name)).toBe(expected)
  })
})
