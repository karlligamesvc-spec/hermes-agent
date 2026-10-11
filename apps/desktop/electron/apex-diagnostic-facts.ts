import type { Fact } from './apex-diagnostics'

/** Renderer can emit only these product facts. No text, path, IDs or arbitrary fields. */
const FACTS: Record<string, Fact> = {
  'preview.docx_ready': { operation: 'preview', name: 'docx_body', status: 'success' },
  'preview.docx_empty': { operation: 'preview', name: 'docx_body', status: 'failure', error_code: 'invalid_output' },
  'preview.docx_failed': { operation: 'preview', name: 'docx_body', status: 'failure', error_code: 'invalid_output' },
  'voice.connected': { operation: 'voice', name: 'connect', status: 'success' },
  'voice.connect_failed': { operation: 'voice', name: 'connect', status: 'failure', error_code: 'unknown' },
  'voice.error': { operation: 'voice', name: 'session', status: 'failure', error_code: 'unknown' },
  'voice.closed': { operation: 'voice', name: 'session', status: 'success' },
  'voice.disconnected': { operation: 'voice', name: 'session', status: 'failure', error_code: 'network' },
  'voice.first_audio': { operation: 'voice', name: 'first_audio', status: 'success' },
  'voice.delegation_failed': { operation: 'voice', name: 'delegation', status: 'failure', error_code: 'unknown' }
}

export function rendererDiagnosticFact(code: unknown, duration: unknown): Fact | null {
  if (typeof code !== 'string' || !Object.hasOwn(FACTS, code)) {return null}
  const fact = { ...FACTS[code] }

  if (typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0 && duration <= 1e12) {
    fact.duration_ms = duration
  }

  return fact
}
