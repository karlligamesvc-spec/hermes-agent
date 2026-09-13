import assert from 'node:assert/strict'

import type { ContextMenuParams, WebContents } from 'electron'
import { describe, test } from 'vitest'

import { contextMenuPointFor, installContextMenuBridge } from './context-menu-bridge'

interface SentMessage {
  channel: string
  payload: unknown
}

class FakeWebContents {
  readonly sent: SentMessage[] = []
  private contextMenuListener: ((event: unknown, params: ContextMenuParams) => void) | null = null
  private destroyedListener: (() => void) | null = null

  constructor(readonly id: number) {}

  on(event: string, listener: (event: unknown, params: ContextMenuParams) => void): this {
    assert.equal(event, 'context-menu')
    assert.equal(this.contextMenuListener, null, 'the bridge must install exactly one gesture listener')
    this.contextMenuListener = listener

    return this
  }

  once(event: string, listener: () => void): this {
    assert.equal(event, 'destroyed')
    this.destroyedListener = listener

    return this
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }

  emitContextMenu(overrides: Partial<ContextMenuParams> = {}): void {
    assert.ok(this.contextMenuListener, 'bridge listener was not installed')
    this.contextMenuListener({}, {
      dictionarySuggestions: [],
      editFlags: {
        canCopy: false,
        canCut: false,
        canDelete: false,
        canEditRichly: false,
        canPaste: false,
        canRedo: false,
        canSelectAll: false,
        canTranspose: false,
        canUndo: false
      },
      frameCharset: '',
      frameURL: '',
      hasImageContents: false,
      inputFieldType: 'none',
      isEditable: false,
      linkText: '',
      linkURL: '',
      mediaFlags: {
        canLoop: false,
        canMute: false,
        canPrint: false,
        canRotate: false,
        canSave: false,
        canShowControls: false,
        isPaused: false,
        isMuted: false,
        isInError: false,
        isControlsVisible: false,
        isLooping: false
      },
      mediaType: 'none',
      misspelledWord: '',
      pageURL: '',
      referrerPolicy: 'default',
      selectionText: '',
      srcURL: '',
      titleText: '',
      x: 12,
      y: 34,
      ...overrides
    } as ContextMenuParams)
  }

  destroy(): void {
    this.destroyedListener?.()
  }
}

describe('renderer-owned context-menu bridge', () => {
  const gestureCases: Array<readonly [string, Partial<ContextMenuParams>, number]> = [
    ['blank shell', {}, 1],
    ['selected text', { selectionText: 'selected' }, 2],
    ['editable input', { isEditable: true }, 3],
    ['link', { linkURL: 'https://example.test' }, 4],
    ['image', { hasImageContents: true, srcURL: 'https://example.test/image.png' }, 5],
    ['terminal canvas', { pageURL: 'file:///terminal' }, 6],
    ['standalone Radix trigger', { pageURL: 'file:///radix' }, 7],
    ['guest bridge gesture', { pageURL: 'https://guest.example.test' }, 8]
  ]

  test.each(gestureCases)('records facts without opening a native popup for %s', (_name, overrides, id) => {
    const contents = new FakeWebContents(id)

    installContextMenuBridge(contents as unknown as WebContents)
    contents.emitContextMenu(overrides)

    assert.deepEqual(contextMenuPointFor(contents.id), { x: 12, y: 34 })
    assert.deepEqual(contents.sent, [])
  })

  test('forwards only editable spellcheck facts to the renderer', () => {
    const contents = new FakeWebContents(1_000_001)

    installContextMenuBridge(contents as unknown as WebContents)
    contents.emitContextMenu({
      dictionarySuggestions: ['corrected'],
      isEditable: true,
      misspelledWord: 'corected',
      x: 44,
      y: 55
    })

    assert.deepEqual(contents.sent, [
      {
        channel: 'hermes:context-menu-spellcheck',
        payload: { misspelledWord: 'corected', suggestions: ['corrected'] }
      }
    ])
    assert.deepEqual(contextMenuPointFor(contents.id), { x: 44, y: 55 })
  })

  test('installs once when shared window wiring is repeated for one WebContents', () => {
    const contents = new FakeWebContents(1_000_002)

    installContextMenuBridge(contents as unknown as WebContents)
    installContextMenuBridge(contents as unknown as WebContents)
    contents.emitContextMenu({ isEditable: true, misspelledWord: 'corected' })

    assert.equal(contents.sent.length, 1)
    assert.deepEqual(contextMenuPointFor(contents.id), { x: 12, y: 34 })
  })

  test('keeps primary and secondary window gesture coordinates isolated and releases destroyed windows', () => {
    const primary = new FakeWebContents(1_000_003)
    const secondary = new FakeWebContents(1_000_004)

    installContextMenuBridge(primary as unknown as WebContents)
    installContextMenuBridge(secondary as unknown as WebContents)
    primary.emitContextMenu({ x: 10, y: 20 })
    secondary.emitContextMenu({ x: 30, y: 40 })

    assert.deepEqual(contextMenuPointFor(primary.id), { x: 10, y: 20 })
    assert.deepEqual(contextMenuPointFor(secondary.id), { x: 30, y: 40 })

    primary.destroy()
    assert.equal(contextMenuPointFor(primary.id), undefined)
    assert.deepEqual(contextMenuPointFor(secondary.id), { x: 30, y: 40 })
  })
})
