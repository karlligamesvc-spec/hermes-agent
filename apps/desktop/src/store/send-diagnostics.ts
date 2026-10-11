import { atom } from 'nanostores'

export interface SendDiagnosticsResult {
  expiresAt?: string
  uploadId?: string
  viewUrl?: string
}

export interface SendDiagnosticsState {
  /** Local UI context only; never sent with diagnostic telemetry. */
  errorContext?: string
  error?: string
  phase: 'consent' | 'done' | 'error' | 'uploading'
  result?: SendDiagnosticsResult
}

export const $sendDiagnostics = atom<SendDiagnosticsState | null>(null)

// Generation token: bumped on every open AND every dismiss. An in-flight
// upload captures the generation it started under and only writes its
// completion back when the token still matches — so dismissing mid-upload is
// immediate and a stale completion can't resurrect or overwrite the dialog.
// Request cancellation stays best-effort (the native request runs to completion
// server-side; we just ignore the result).
let generation = 0

/** Open the consent modal. No network I/O happens until the user confirms. */
export function requestSendDiagnostics(errorContext?: string): void {
  generation += 1
  $sendDiagnostics.set({ errorContext, phase: 'consent' })
}

export function dismissSendDiagnostics(): void {
  generation += 1
  $sendDiagnostics.set(null)
}

/** User confirmed — run the upload. Transitions consent → uploading → done/error. */
export async function confirmSendDiagnostics(): Promise<void> {
  const current = $sendDiagnostics.get()

  if (!current || current.phase !== 'consent') {
    return
  }

  const startedGeneration = generation

  // Only write back while the dialog the upload belongs to is still open.
  const stillCurrent = () => generation === startedGeneration

  $sendDiagnostics.set({ ...current, phase: 'uploading' })

  try {
    const response = await window.hermesDesktop?.diagnostics?.send()

    if (!response) {throw new Error('APEX diagnostics unavailable')}

    if (!stillCurrent()) {
      return
    }

    if (!response.ok) {
      throw new Error(response.error || 'upload failed')
    }

    $sendDiagnostics.set({
      ...current,
      phase: 'done',
      result: {
        uploadId: response.uploadId
      }
    })
  } catch (error) {
    if (!stillCurrent()) {
      return
    }

    $sendDiagnostics.set({
      ...current,
      error: error instanceof Error ? error.message : String(error),
      phase: 'error'
    })
  }
}
