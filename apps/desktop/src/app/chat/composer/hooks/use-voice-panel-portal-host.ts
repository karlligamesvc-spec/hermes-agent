import { useEffect, useState } from 'react'

const ROUTE_OVERLAY = '[data-overlay-surface]'

/** Route dialogs trap focus and disable pointer input outside their content.
 * Keep call controls inside the active dialog's interaction boundary, while
 * the call owner and panel position remain mounted across navigation. */
export function useVoicePanelPortalHost(): HTMLElement {
  const activeHost = () =>
    Array.from(document.querySelectorAll<HTMLElement>(ROUTE_OVERLAY)).at(-1) ?? document.body

  const [host, setHost] = useState(activeHost)

  useEffect(() => {
    const observer = new MutationObserver(records => {
      const overlayChanged = records.some(record =>
        [...record.addedNodes, ...record.removedNodes].some(
          node => node instanceof Element && (node.matches(ROUTE_OVERLAY) || node.querySelector(ROUTE_OVERLAY))
        )
      )

      if (overlayChanged) {
        setHost(activeHost())
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
    setHost(activeHost())

    return () => observer.disconnect()
  }, [])

  return host
}
