import { afterEach, describe, expect, it } from 'vitest'

import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { resetTitlebarState, titlebarHtml, type TitlebarState } from './__identity__/titlebar/render'

/**
 * hc-1085 identity guard (hard rule 11) for the titlebar's fixed clusters.
 *
 * The goldens under `__identity__/titlebar/` were recorded on fork main
 * aa8e554e38 with the same harness (render.tsx), before hc-1085 folded any
 * titlebar control: single_thread off, developer mode and product mode, with
 * the app actions on either side, the sessions moved right, and the right side
 * open.
 */

const GOLDEN = './__identity__/titlebar'

afterEach(() => {
  resetTitlebarState()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

const CASES: [string, boolean, 'product' | 'technical', TitlebarState][] = [
  ['switch-off', false, 'product', {}],
  ['switch-off-flipped', false, 'product', { flipped: true }],
  ['developer', true, 'technical', {}],
  ['developer-actions-left', true, 'technical', { appActions: 'left' }],
  ['developer-flipped', true, 'technical', { flipped: true }],
  ['developer-right-open', true, 'technical', { rightOpen: true }],
  ['product', true, 'product', {}],
  ['product-actions-left', true, 'product', { appActions: 'left' }],
  ['product-flipped', true, 'product', { flipped: true }],
  ['product-right-open', true, 'product', { rightOpen: true }]
]

describe.each(CASES)('%s: the titlebar', (name, singleThread, toolView, state) => {
  it('both fixed clusters', async () => {
    setSingleThreadFlagForTest(singleThread)
    setToolViewMode(toolView)

    await expect(titlebarHtml(state)).toMatchFileSnapshot(`${GOLDEN}/${name}.html`)
  })
})
