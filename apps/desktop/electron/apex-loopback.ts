/**
 * apex-loopback.ts
 *
 * Minimal loopback HTTP server for the APEX Desktop browser-login flows
 * ("用 Google 登录" / "用 APEX 登录", Desktop V0.2). Electron-free (uses only
 * `node:http` + `node:crypto`) so it unit-tests with `vitest run --project electron`, same pattern
 * as apex-managed.ts / connection-config.ts.
 *
 * Why a new server (not the existing OAuth loopback): the desktop's remote-gateway
 * "connect to dashboard" OAuth does NOT run an Electron-side listener — the
 * *backend* binds 127.0.0.1 and the renderer polls a session. The managed-LLM
 * browser flows here have no backend session to poll: the system browser is
 * redirected straight back to the desktop with `?token=<JWT>&state=<s>`, so the
 * desktop itself must catch that redirect. Per the shared contract we add this
 * minimal listener only because none exists to reuse.
 *
 * Security:
 *   - Binds 127.0.0.1 only (never 0.0.0.0) so nothing off-box can hit it.
 *   - A random `state` is generated per flow and validated on the callback
 *     (CSRF). The token is only surfaced on an exact /cb + matching-state hit.
 *   - The server self-closes the moment it resolves (success or first failure),
 *     and a watchdog timeout tears it down if the user never returns.
 */

import crypto from 'node:crypto'
import http from 'node:http'

import { parseLoopbackCallback } from './apex-managed'

// How long to wait for the browser to redirect back before giving up. The user
// has to sign in in a browser tab, so this is generous.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// Tabler Icons 3.44.0, already used by Desktop. Kept as data-image assets so
// the loopback page remains self-contained and never depends on a CDN.
const SUCCESS_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjIgMiAyMCAyMCI+PHBhdGggZmlsbD0iIzAwYzg5NiIgZD0iTTcgMy4zNGExMCAxMCAwIDEgMSAtNC45OTUgOC45ODRsLS4wMDUgLS4zMjRsLjAwNSAtLjMyNGExMCAxMCAwIDAgMSA0Ljk5NSAtOC4zMzZ6Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTE1LjcwNyA5LjI5M2ExIDEgMCAwIDAgLTEuMzIgLS4wODNsLS4wOTQgLjA4M2wtMy4yOTMgMy4yOTJsLTEuMjkzIC0xLjI5MmwtLjA5NCAtLjA4M2ExIDEgMCAwIDAgLTEuNDAzIDEuNDAzbC4wODMgLjA5NGwyIDJsLjA5NCAuMDgzYTEgMSAwIDAgMCAxLjIyNiAwbC4wOTQgLS4wODNsNCAtNGwuMDgzIC0uMDk0YTEgMSAwIDAgMCAtLjA4MyAtMS4zMnoiLz48L3N2Zz4='

const FAILURE_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjIgMiAyMCAyMCI+PHBhdGggZmlsbD0iI2ZmNWM3MCIgZD0iTTcgMy4zNGExMCAxMCAwIDEgMSAtNC45OTUgOC45ODRsLS4wMDUgLS4zMjRsLjAwNSAtLjMyNGExMCAxMCAwIDAgMSA0Ljk5NSAtOC4zMzZ6Ii8+PHBhdGggZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgZD0iTTE4IDZsLTEyIDEyTTYgNmwxMiAxMiIvPjwvc3ZnPg=='

const OPEN_ICON =
  'data:image/svg+xml;base64,PHN2ZwogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIKICB2aWV3Qm94PSIwIDAgMjQgMjQiCiAgZmlsbD0ibm9uZSIKICBzdHJva2U9IiMxODE4MWIiCiAgc3Ryb2tlLXdpZHRoPSIyIgogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIKICBzdHJva2UtbGluZWpvaW49InJvdW5kIgo+PHBhdGggc3Ryb2tlPSJub25lIiBkPSJNMCAwaDI0djI0SDB6IiBmaWxsPSJub25lIiAvPjxwYXRoIGQ9Ik0xMiA2aC02YTIgMiAwIDAgMCAtMiAydjEwYTIgMiAwIDAgMCAyIDJoMTBhMiAyIDAgMCAwIDIgLTJ2LTYiIC8+PHBhdGggZD0iTTExIDEzbDkgLTkiIC8+PHBhdGggZD0iTTE1IDRoNXY1IiAvPjwvc3ZnPg=='

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  )
}

// Self-contained browser result page. The custom-scheme CTA returns focus to
// the installed app; it deliberately uses `open`, never the one-time login
// route, so it cannot replay or manufacture an auth callback.
function resultPage({ title, body, success }: { title: string; body: string; success: boolean }) {
  const safeTitle = escapeHtml(title)
  const safeBody = escapeHtml(body)
  const statusIcon = success ? SUCCESS_ICON : FAILURE_ICON

  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${safeTitle} · APEX</title>` +
    '<style>:root{color-scheme:dark;font-family:Inter,"SF Pro Display","Segoe UI",' +
    '"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#151515;color:#f7f7f7}' +
    '*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:48px 40px}' +
    'main{width:min(688px,100%);text-align:center;transform:translateY(-12px)}' +
    '.status{display:block;width:72px;height:72px;margin:0 auto 28px}' +
    'h1{margin:0;font-size:32px;line-height:1.25;font-weight:750;letter-spacing:-.02em}' +
    'p{margin:23px auto 0;max-width:680px;color:#9b9b9f;font-size:27px;line-height:1.8;font-weight:600}' +
    'a{margin-top:78px;width:100%;min-height:72px;border-radius:15px;display:flex;align-items:center;' +
    'justify-content:center;gap:16px;background:#f1f1f2;color:#18181b;text-decoration:none;font-size:28px;' +
    'line-height:1;font-weight:700;transition:background-color .16s ease,transform .16s ease}' +
    'a:hover{background:#fff}a:active{transform:scale(.99)}a:focus-visible{outline:3px solid #00c896;' +
    'outline-offset:4px}.open-icon{width:29px;height:29px}' +
    '@media(max-width:620px){body{padding:32px 24px}.status{width:64px;height:64px;margin-bottom:28px}' +
    'h1{font-size:28px}p{font-size:20px;line-height:1.65}a{margin-top:48px;min-height:64px;font-size:22px}}' +
    '@media(prefers-reduced-motion:reduce){a{transition:none}}</style>' +
    `</head><body><main><img class="status" src="${statusIcon}" alt="">` +
    `<h1>${safeTitle}</h1><p>${safeBody}</p>` +
    `<a href="apexnodes://open?source=login-complete"><img class="open-icon" src="${OPEN_ICON}" alt="">` +
    '<span>打开 APEX</span></a></main></body></html>'
  )
}

const SUCCESS_HTML = resultPage({
  title: '登录已完成',
  body: '授权结果正在同步到 APEX 桌面端，请返回 App 等待登录完成。',
  success: true
})

const FAILURE_HTML = resultPage({
  title: '登录未完成',
  body: '授权结果未能同步，请返回 APEX 桌面端重新登录。',
  success: false
})

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
}

/**
 * Generate a URL-safe random state token for CSRF protection.
 * @returns {string}
 */
function generateState() {
  return crypto.randomBytes(24).toString('base64url')
}

/**
 * Start a loopback listener and resolve with the token once the browser is
 * redirected back to `/cb?token=<JWT>&state=<state>` (validated). The returned
 * object exposes the bound `redirectUri` (to pass to the start URL builders),
 * the `state`, a `result` promise, and a `close()` to abort early.
 *
 * The `result` promise:
 *   - resolves `{ token }` on a valid callback,
 *   - rejects with an Error (code in `.reason`) on state mismatch / missing
 *     token / explicit ?error= / timeout / socket error.
 *
 * Non-/cb requests (e.g. the browser's automatic /favicon.ico) get a 204 and do
 * NOT resolve or reject — only the real callback settles the flow.
 *
 * @param {{ host?: string, timeoutMs?: number, path?: string }} [options]
 * @returns {Promise<{ redirectUri: string, state: string, port: number,
 *                      result: Promise<{ token: string }>, close: () => void }>}
 */
function startLoopbackLogin(options: any = {}): Promise<any> {
  const host = options.host || '127.0.0.1'
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const callbackPath = options.path || '/cb'
  const state = generateState()

  return new Promise((resolveStart, rejectStart) => {
    let settled = false
    let resolveResult
    let rejectResult

    const result = new Promise((res, rej) => {
      resolveResult = res
      rejectResult = rej
    })

    let watchdog = null

    const cleanup = () => {
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }

      // Force-drop any lingering keep-alive sockets first so close() can release
      // the handle immediately (a browser may hold the connection open after the
      // redirect; without this the listener — and a test runner's event loop —
      // would wait for the idle socket to time out). closeAllConnections is
      // Node 18.2+; guard it for safety. close() is idempotent.
      try {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections()
        }
      } catch {
        // best effort
      }

      try {
        server.close()
      } catch {
        // already closing / closed
      }
    }

    const fail = reason => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      const err: any = new Error(`Loopback login failed: ${reason}`)
      err.reason = reason
      rejectResult(err)
    }

    const succeed = token => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolveResult({ token })
    }

    const server = http.createServer((req, res) => {
      const outcome = parseLoopbackCallback(req.url, state)

      if (outcome.ok) {
        res.writeHead(200, HTML_HEADERS)
        res.end(SUCCESS_HTML)
        succeed(outcome.token)

        return
      }

      // A failed parse that ISN'T the callback (favicon, stray path) must not
      // settle the flow — answer quietly and keep waiting for the real /cb.
      if (!outcome.isCallback) {
        res.statusCode = 204
        res.end()

        return
      }

      // The /cb callback came back but is invalid (state mismatch, missing
      // token, explicit ?error=) — show the failure page and reject the flow.
      res.writeHead(400, HTML_HEADERS)
      res.end(FAILURE_HTML)
      fail(outcome.reason)
    })

    server.on('error', error => {
      if (!settled) {
        // A bind error before we ever started → reject the *start* promise.
        if (!server.listening) {
          rejectStart(error)

          return
        }

        fail(error && error.message ? error.message : String(error))
      }
    })

    // Port 0 → OS assigns a free ephemeral port, returned via address().
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0

      if (!port) {
        try {
          server.close()
        } catch {
          // ignore
        }

        rejectStart(new Error('Loopback server did not bind a port.'))

        return
      }

      watchdog = setTimeout(() => fail('timeout'), timeoutMs)

      // Don't let the watchdog keep the event loop / app alive.
      if (typeof watchdog.unref === 'function') {
        watchdog.unref()
      }

      const redirectUri = `http://${host}:${port}${callbackPath}`
      resolveStart({
        redirectUri,
        state,
        port,
        result,
        close: () => fail('aborted')
      })
    })
  })
}

export { DEFAULT_TIMEOUT_MS, generateState, startLoopbackLogin }
