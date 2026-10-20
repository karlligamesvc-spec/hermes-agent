import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ErrorBoundary, RootErrorFallback } from '@/components/error-boundary'
import { I18nProvider } from '@/i18n/context'
import { storedQuickEntryLocale } from '@/i18n/quick-entry'
import { ThemeProvider } from '@/themes/context'

import { QuickEntryApp } from './quick-entry-app'

/**
 * The window's whole tree. There is no I18nProvider around it: the window reads
 * its language itself (see i18n/quick-entry). The crash fallback is the app's
 * own, so it gets a provider of its own, set to the language the main window
 * shows at the moment it fails; without one it would read the context default,
 * English.
 */
export function QuickEntryRoot() {
  return (
    <ErrorBoundary
      fallback={props => (
        <I18nProvider configClient={null} initialLocale={storedQuickEntryLocale()}>
          <RootErrorFallback {...props} />
        </I18nProvider>
      )}
      label="quick-entry"
    >
      <ThemeProvider>
        <QuickEntryApp />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

/**
 * Boot the Quick Entry window. Loaded by the same bundle as the main app but via
 * `?win=quick`, so it shares CSS/theme tokens while mounting a minimal capture
 * surface (no app shell, no gateway, no router).
 *
 * The index.html boot script paints an OPAQUE themed background to avoid a flash
 * in normal windows; this window is a floating card on a transparent backdrop,
 * so force the host layers see-through (same trick as the pet overlay).
 */
export function mountQuickEntry(): void {
  const style = document.createElement('style')
  style.textContent = 'html,body,#root{background:transparent !important;}'
  document.head.appendChild(style)

  const root = document.getElementById('root')

  if (!root) {
    return
  }

  createRoot(root).render(
    <StrictMode>
      <QuickEntryRoot />
    </StrictMode>
  )
}
