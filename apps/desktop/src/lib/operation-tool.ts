// Shared model for browser / computer-use "operation" tools (hc-418).
//
// The runtime exposes two families of tools that drive a real surface the user
// can't otherwise see:
//   • browser_*      — a headless/remote Chromium session (tools/browser_tool.py)
//   • computer_use   — the real desktop, via cua-driver (tools/computer_use/)
//
// This module turns a single tool-call part (name + args + result) into a
// normalized `OperationInfo` used by both the in-thread operation card and the
// global status-stack indicator. Keeping the classification in one place means
// the card and the chip can never disagree about whether an operation is live.
//
// Screenshot honesty: browser_vision returns a `screenshot_path` (a local file
// path — rendered via the hermes-media stream scheme), and computer_use capture
// results may carry a base64 `data:image/...` URL. We only surface an image when
// one of those is actually present; otherwise the card is a text card. We never
// fabricate a preview.

export type OperationSurface = 'browser' | 'computer'

export interface OperationInfo {
  /** browser vs computer-use — drives the copy and the warning severity. */
  surface: OperationSurface
  /** Localized-agnostic action key, e.g. 'navigate', 'click', 'type', 'capture'. */
  action: string
  /** Human target line: a hostname (browser), an element/coordinate/app
   *  (computer), or a typed value — already trimmed, may be empty. */
  target: string
  /** Full URL when the operation is about a page (browser_navigate). */
  url: string
  /** A renderable screenshot source (data: URL or a local file path) when the
   *  tool produced one, else ''. The caller resolves file paths to a URL. */
  screenshot: string
  /** True while the tool is still running (result not yet in). */
  running: boolean
  /** True when the completed tool reported an error. */
  error: boolean
}

const BROWSER_PREFIX = 'browser_'
const COMPUTER_TOOL = 'computer_use'

/** Whether a tool name is one of the operation tools this feature visualizes. */
export function isOperationTool(toolName: string | undefined): boolean {
  if (!toolName) {
    return false
  }

  return toolName === COMPUTER_TOOL || toolName.startsWith(BROWSER_PREFIX)
}

export function operationSurface(toolName: string): OperationSurface {
  return toolName === COMPUTER_TOOL ? 'computer' : 'browser'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  return {}
}

function str(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

const URL_RE = /https?:\/\/[^\s'"<>)\]]+/i

function hostname(value: string): string {
  try {
    const url = new URL(value)

    return `${url.hostname}${url.pathname && url.pathname !== '/' ? url.pathname : ''}`
  } catch {
    return value
  }
}

function truncate(value: string, max = 64): string {
  const line = value.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// A data: image URL can be inlined directly. A bare filesystem path (browser_vision
// screenshot_path) is surfaced too — the card resolves it via the media scheme.
function screenshotFrom(result: Record<string, unknown>): string {
  const dataUrl = deepFindDataImage(result)

  if (dataUrl) {
    return dataUrl
  }

  const path = str(result, ['screenshot_path', 'screenshot', 'image_path'])

  // Only accept things that look like an image file path; never a snapshot blob.
  if (path && /\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) {
    return path
  }

  return ''
}

// computer_use capture results can nest the base64 image inside a content array
// ({type:'image_url', image_url:{url:'data:image/...'}}). Walk shallowly to find
// the first data:image URL without pulling in unrelated fields.
function deepFindDataImage(value: unknown, depth = 0): string {
  if (depth > 4) {
    return ''
  }

  if (typeof value === 'string') {
    return value.startsWith('data:image/') ? value : ''
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindDataImage(item, depth + 1)

      if (found) {
        return found
      }
    }

    return ''
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = deepFindDataImage(item, depth + 1)

      if (found) {
        return found
      }
    }
  }

  return ''
}

function browserAction(toolName: string): string {
  // browser_navigate -> navigate, browser_get_images -> get_images, etc.
  return toolName.slice(BROWSER_PREFIX.length) || 'navigate'
}

function browserTarget(action: string, args: Record<string, unknown>, result: Record<string, unknown>): {
  target: string
  url: string
} {
  if (action === 'navigate' || action === 'vision' || action === 'get_images' || action === 'back') {
    const url =
      str(args, ['url', 'target']) ||
      str(result, ['url']) ||
      str(args, ['url']).match(URL_RE)?.[0] ||
      ''

    return { target: url ? hostname(url) : '', url }
  }

  if (action === 'click') {
    const ref = str(result, ['clicked']) || str(args, ['ref', 'target'])

    return { target: ref, url: '' }
  }

  if (action === 'type') {
    const field = str(args, ['ref', 'label', 'field', 'target'])
    const value = str(args, ['text', 'value'])

    return { target: [field, value && `"${truncate(value, 40)}"`].filter(Boolean).join(' '), url: '' }
  }

  if (action === 'scroll') {
    return { target: str(args, ['direction']), url: '' }
  }

  if (action === 'press') {
    return { target: str(args, ['key']), url: '' }
  }

  return { target: str(args, ['ref', 'target', 'url']), url: str(args, ['url']) }
}

function computerTarget(action: string, args: Record<string, unknown>): string {
  const app = str(args, ['app'])
  const appLabel = app ? `${app}` : ''

  const detail = ((): string => {
    if (action === 'type') {
      return `"${truncate(str(args, ['text']), 40)}"`
    }

    if (action === 'key') {
      return str(args, ['keys'])
    }

    if (action === 'scroll') {
      return str(args, ['direction'])
    }

    if (action === 'set_value') {
      return `"${truncate(str(args, ['value']), 40)}"`
    }

    if (action === 'focus_app' || action === 'capture') {
      return ''
    }

    const element = args.element
    const coord = Array.isArray(args.coordinate) ? args.coordinate : null

    if (typeof element === 'number') {
      return `#${element}`
    }

    if (coord && coord.length === 2) {
      return `(${coord[0]}, ${coord[1]})`
    }

    return ''
  })()

  return [appLabel, detail].filter(Boolean).join(' · ')
}

/**
 * Normalize a tool-call part into an OperationInfo. Returns null when the tool
 * is not an operation tool (so callers can no-op cleanly).
 */
export function operationInfo(
  toolName: string,
  args: unknown,
  result: unknown,
  { running, error }: { running: boolean; error: boolean }
): null | OperationInfo {
  if (!isOperationTool(toolName)) {
    return null
  }

  const argsRecord = asRecord(args)
  const resultRecord = asRecord(result)
  const surface = operationSurface(toolName)

  if (surface === 'computer') {
    const action = String(argsRecord.action || 'capture').trim().toLowerCase() || 'capture'

    return {
      surface,
      action,
      target: computerTarget(action, argsRecord),
      url: '',
      screenshot: screenshotFrom(resultRecord),
      running,
      error
    }
  }

  const action = browserAction(toolName)
  const { target, url } = browserTarget(action, argsRecord, resultRecord)

  return {
    surface,
    action,
    target,
    url,
    screenshot: screenshotFrom(resultRecord),
    running,
    error
  }
}
