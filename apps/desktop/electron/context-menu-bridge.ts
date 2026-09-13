import type { ContextMenuParams, WebContents } from 'electron'

export interface ContextMenuPoint {
  x: number
  y: number
}

interface SpellcheckPayload {
  misspelledWord: string
  suggestions: string[]
}

type ContextMenuBridgeContents = Pick<WebContents, 'id' | 'on' | 'once' | 'send'>

/**
 * Chromium-only facts captured for the renderer-owned context menu.
 *
 * This module deliberately has no native Menu dependency. The renderer owns
 * every popup (DOM, terminal, Radix and guest); Electron only supplies facts a
 * DOM contextmenu event cannot expose: the image gesture coordinates and
 * spellcheck suggestions. Keeping that ownership boundary in a dependency-free
 * module also makes an accidental native popup observable in the behavior test.
 */
const lastContextMenuPoint = new Map<number, ContextMenuPoint>()
const installedContents = new WeakSet<ContextMenuBridgeContents>()

export function installContextMenuBridge(contents: ContextMenuBridgeContents): void {
  if (installedContents.has(contents)) {
    return
  }

  installedContents.add(contents)

  contents.on('context-menu', (_event, params: ContextMenuParams) => {
    lastContextMenuPoint.set(contents.id, { x: params.x, y: params.y })

    if (params.isEditable && params.misspelledWord) {
      const payload: SpellcheckPayload = {
        misspelledWord: params.misspelledWord,
        suggestions: Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : []
      }

      contents.send('hermes:context-menu-spellcheck', payload)
    }
  })

  contents.once('destroyed', () => {
    lastContextMenuPoint.delete(contents.id)
  })
}

export function contextMenuPointFor(webContentsId: number): ContextMenuPoint | undefined {
  return lastContextMenuPoint.get(webContentsId)
}
