import { translateNow } from '@/i18n'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * User-friendly step label from browser_exec code's leading `# …` comment.
 * Mirrors agent/display.py:_browser_exec_step_label (CLI/TUI) so every
 * surface derives the same label from the same convention.
 */
export function browserExecStepLabel(code: string, maxChars = 80): null | string {
  const first = code.trim().split('\n', 1)[0]?.trim() ?? ''

  if (!first.startsWith('#')) {
    return null
  }

  const label = first.replace(/^#+/, '').trim()

  if (!label) {
    return null
  }

  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label
}

export function compactPreview(value: unknown, max = 72): string {
  let raw: unknown

  if (typeof value === 'string') {
    raw = value
  } else {
    raw = parseMaybeObject(value).context
  }

  if (typeof raw !== 'string') {
    if (raw == null) {
      raw = ''
    } else {
      try {
        raw = JSON.stringify(raw)
      } catch {
        raw = String(raw)
      }
    }
  }

  const line = (raw as string).replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function contextValue(value: unknown): string {
  const row = parseMaybeObject(value)

  if (typeof row.context === 'string') {
    return row.context
  }

  if (typeof row.preview === 'string') {
    return row.preview
  }

  return typeof value === 'string' ? value : ''
}

// Each tool result is server-capped (~100KB), but a turn over a big directory
// stacks many rows; painting/serializing them all floods the renderer (freeze,
// then OOM). Clamp every inline-painted payload to a bounded slice — the row's
// Copy button still reads the uncapped `view.detail` for the full output.
export const MAX_TOOL_RENDER_CHARS = 20_000

export function clampForDisplay(value: string, max = MAX_TOOL_RENDER_CHARS): string {
  if (value.length <= max) {
    return value
  }

  const omitted = value.length - max

  return `${value.slice(0, max)}\n\n${translateNow('assistant.tool.detail.truncated', omitted.toLocaleString())}`
}

export function prettyJson(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2)

  return clampForDisplay(raw ?? '')
}

export function parseMaybeObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value
  }

  if (typeof value !== 'string' || !value.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(value)

    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function unwrapToolPayload(value: unknown): unknown {
  const record = parseMaybeObject(value)

  for (const key of ['data', 'result', 'output', 'response', 'payload']) {
    const payload = record[key]

    if (payload !== undefined && payload !== null) {
      return payload
    }
  }

  return value
}

export function numberValue(value: unknown): null | number {
  const n = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(n) ? n : null
}

// Units come from the active locale: "2m 5s" in English, 「2 分 5 秒」 in Chinese.
const unit = (value: number | string, name: 'h' | 'm' | 'ms' | 's') =>
  translateNow('assistant.tool.formatDuration', String(value), name)

const joinUnits = (...parts: string[]) => parts.join(translateNow('assistant.tool.durationSeparator'))

export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return ''
  }

  if (seconds < 1) {
    return unit(Math.max(1, Math.round(seconds * 1000)), 'ms')
  }

  if (seconds < 60) {
    return unit(seconds.toFixed(seconds >= 10 ? 0 : 1), 's')
  }

  const wholeSeconds = Math.round(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remSeconds = wholeSeconds % 60

  if (minutes < 60) {
    return remSeconds ? joinUnits(unit(minutes, 'm'), unit(remSeconds, 's')) : unit(minutes, 'm')
  }

  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60

  return remMinutes ? joinUnits(unit(hours, 'h'), unit(remMinutes, 'm')) : unit(hours, 'h')
}
