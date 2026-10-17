/** Optional desktop bridge; failures never affect conversation/audio. */
export function diagnosticFact(code: string, duration?: number) {
  try {
    window.hermesDesktop?.diagnostics?.fact?.(code, duration)
  } catch { /* diagnostics is best effort at the renderer boundary */ }
}
