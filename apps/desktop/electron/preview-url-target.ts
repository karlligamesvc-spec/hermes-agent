/**
 * The preview target for a web address (`hermes:normalizePreviewTarget`): only
 * a server on this machine opens in the preview pane, and 0.0.0.0 is read as
 * 127.0.0.1. Moved out of main.ts unchanged, to make room there.
 *
 * Electron-free: unit-tested with `vitest --project electron`.
 */

const LOCAL_PREVIEW_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::1', '[::1]', 'localhost'])

function previewLabelForUrl(url) {
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
}

export function previewUrlTarget(rawTarget) {
  const raw = String(rawTarget || '').trim()
  const url = new URL(raw)

  if (!['http:', 'https:'].includes(url.protocol)) {
    return null
  }

  if (!LOCAL_PREVIEW_HOSTS.has(url.hostname.toLowerCase())) {
    return null
  }

  if (url.hostname === '0.0.0.0') {
    url.hostname = '127.0.0.1'
  }

  return {
    kind: 'url',
    label: previewLabelForUrl(url),
    source: raw,
    url: url.toString()
  }
}
