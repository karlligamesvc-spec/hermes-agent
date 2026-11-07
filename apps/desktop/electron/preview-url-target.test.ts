/**
 * The web-address preview target, as main.ts built it before the move.
 *
 * Run with: npx vitest run electron/preview-url-target.test.ts --project electron
 */

import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { previewUrlTarget } from './preview-url-target'

describe('a web address in the preview pane', () => {
  test.each([
    [
      'http://localhost:5173/',
      { kind: 'url', label: 'localhost:5173', source: 'http://localhost:5173/', url: 'http://localhost:5173/' }
    ],
    [
      '  http://127.0.0.1:8000/app/index.html?x=1  ',
      {
        kind: 'url',
        label: '127.0.0.1:8000/app/index.html',
        source: 'http://127.0.0.1:8000/app/index.html?x=1',
        url: 'http://127.0.0.1:8000/app/index.html?x=1'
      }
    ],
    [
      'http://0.0.0.0:3000/',
      { kind: 'url', label: '127.0.0.1:3000', source: 'http://0.0.0.0:3000/', url: 'http://127.0.0.1:3000/' }
    ],
    [
      'https://[::1]:4443/',
      { kind: 'url', label: '[::1]:4443', source: 'https://[::1]:4443/', url: 'https://[::1]:4443/' }
    ],
    [
      'HTTP://LOCALHOST:9/',
      { kind: 'url', label: 'localhost:9', source: 'HTTP://LOCALHOST:9/', url: 'http://localhost:9/' }
    ]
  ])('this machine’s %s opens', (raw, expected) => {
    assert.deepEqual(previewUrlTarget(raw), expected)
  })

  test.each([
    ['https://example.com/'],
    ['http://192.168.1.5:8000/'],
    ['ftp://localhost/'],
    ['file:///Users/me/x.html']
  ])('%s does not', raw => {
    assert.equal(previewUrlTarget(raw), null)
  })

  test('a malformed address throws, as before (the caller turns that into no target)', () => {
    assert.throws(() => previewUrlTarget('not a url'))
  })
})
