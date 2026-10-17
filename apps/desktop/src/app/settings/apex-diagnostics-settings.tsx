import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'

import { ToggleRow } from './primitives'

export function ApexDiagnosticsSettings() {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    void window.hermesDesktop?.diagnostics
      ?.get()
      .then(value => {
        if (active) {setEnabled(value.enabled)}
      })
      .catch(() => {
        if (active) {setError(true)}
      })
      .finally(() => {
        if (active) {setBusy(false)}
      })

    return () => {
      active = false
    }
  }, [])

  if (!window.hermesDesktop?.diagnostics) {return null}

  return (
    <div>
      <ToggleRow
        checked={enabled}
        description={t.apexDiagnostics.description}
        disabled={busy}
        label={t.apexDiagnostics.title}
        onChange={value => {
          setBusy(true)
          setError(false)
          void window
            .hermesDesktop!.diagnostics!.set(value)
            .then(result => setEnabled(result.enabled))
            .catch(() => setError(true))
            .finally(() => setBusy(false))
        }}
      />
      {error ? <p role="alert">{t.apexDiagnostics.error}</p> : null}
    </div>
  )
}
