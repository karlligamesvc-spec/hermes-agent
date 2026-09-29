import type { Page } from '@playwright/test'

interface ErrorHistoryWindow extends Window {
  __HC901_ERROR_HISTORY__?: string[]
  __HC901_ERROR_OBSERVER_INSTALLED__?: boolean
}

function installHistory() {
  const current = window as ErrorHistoryWindow
  const seen = current.__HC901_ERROR_HISTORY__ ?? []

  current.__HC901_ERROR_HISTORY__ = seen

  if (current.__HC901_ERROR_OBSERVER_INSTALLED__) {return}
  current.__HC901_ERROR_OBSERVER_INSTALLED__ = true

  const capture = () => {
    for (const alert of document.querySelectorAll('[role="alert"]')) {
      const message = alert.textContent?.trim()

      if (message && !seen.includes(message)) {seen.push(message)}
    }
  }

  capture()
  new MutationObserver(capture).observe(document, { childList: true, subtree: true, characterData: true })
}

/** Electron firstWindow can already be loaded, so guard both this document and future ones. */
export async function pageErrorHistory(page: Page): Promise<() => Promise<string[]>> {
  const seen = new Set<string>()

  await page.addInitScript(installHistory)
  await page.evaluate(installHistory)

  return async () => {
    if (!page.isClosed()) {
      const history = await page.evaluate(() => (window as ErrorHistoryWindow).__HC901_ERROR_HISTORY__ ?? [])
      const current = await page.locator('[role="alert"]').allTextContents()

      for (const message of [...history, ...current].map(text => text.trim()).filter(Boolean)) {seen.add(message)}
    }

    return [...seen]
  }
}
