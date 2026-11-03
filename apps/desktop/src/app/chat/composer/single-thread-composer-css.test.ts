/**
 * hc-1060: single-thread-composer.css restyles the composer only where the
 * single-thread actions row is mounted. vitest hands back an empty string for
 * a CSS import, so the file is read from disk: every selector must carry the
 * row's marker, the row's module must import the file, and the cascade must
 * reach the composer only around that row and never on the popped-out one.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const MARKER = '[data-single-thread-composer]'
const css = readFileSync(join(__dirname, 'single-thread-composer.css'), 'utf8')

/** Every selector of every rule, comments stripped, split on top-level commas. */
function selectors(source: string): string[] {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '')

  return [...bare.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(match =>
    match[1]!
      .split(/,(?![^(]*\))/)
      .map(selector => selector.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  )
}

function composer({ marker, poppedOut = false }: { marker: boolean; poppedOut?: boolean }) {
  const host = window.document.createElement('div')

  host.innerHTML = `
    <div data-slot="composer-dock"${poppedOut ? ' data-popped-out=""' : ''}>
      <form data-slot="composer-root"${poppedOut ? ' data-popped-out=""' : ''}>
        <div class="apex-composer-surface">
          <div data-slot="composer-layout">
            <div data-slot="composer-toolbar-end">${marker ? `<div ${MARKER.slice(1, -1)}=""></div>` : ''}</div>
          </div>
        </div>
      </form>
    </div>`
  window.document.body.append(host)

  return host
}

const width = (host: HTMLElement) =>
  getComputedStyle(host.querySelector<HTMLElement>('[data-slot="composer-dock"]')!)
    .getPropertyValue('--composer-width')
    .trim()

afterEach(() => {
  window.document.head.innerHTML = ''
  window.document.body.innerHTML = ''
})

describe('single-thread-composer.css', () => {
  it('scopes every selector to the single-thread row', () => {
    const all = selectors(css)

    expect(all.length).toBeGreaterThan(5)
    expect(all.filter(selector => !selector.includes(MARKER))).toEqual([])
  })

  it('is imported by the row that carries the marker', () => {
    const source = readFileSync(join(__dirname, 'single-thread-actions.tsx'), 'utf8')

    expect(source).toMatch(/^import '\.\/single-thread-composer\.css'$/m)
    expect(source).toContain('data-single-thread-composer=""')
  })

  it('reaches the docked composer around the row, and nothing else', () => {
    const style = window.document.createElement('style')

    style.textContent = css
    window.document.head.append(style)

    expect(width(composer({ marker: true }))).toBe('664px')
    expect(width(composer({ marker: false }))).toBe('')
    expect(width(composer({ marker: true, poppedOut: true }))).toBe('')
  })
})
