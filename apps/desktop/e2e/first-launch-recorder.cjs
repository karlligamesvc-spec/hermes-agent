// hc-1127: loaded with `electron -r` by first-launch-product-mode.spec.ts, ahead of the app,
// and again as a preload in every window, which is the one place that sees a window's first
// document: Playwright only attaches after the app is ready.
//
// In main it records when the app became ready and when the main window was created and shown.
// In a window it records which shell the page showed at every DOM change, read back through
// `window.hc1127Frames()`. Text counts only where it can be seen: a login screen or a boot
// overlay over the old shell is not the old shell showing.

/* global document, MutationObserver, NodeFilter */

const electron = require('electron')

if (process.type === 'browser') {
  // Only here: a sandboxed preload cannot load node modules.
  const fs = require('node:fs')
  const path = require('node:path')

  const { app, BrowserWindow, session } = electron

  // A dev build would otherwise take over apexnodes:// links from the installed app.
  app.setAsDefaultProtocolClient = () => false

  const marks = []
  const marksFile = process.env.E2E_FIRST_LAUNCH_MARKS

  const mark = name => {
    marks.push({ name, at: Date.now() })

    if (marksFile) {
      fs.writeFileSync(marksFile, JSON.stringify({ processStart: process.getCreationTime(), marks }))
    }
  }

  const framesDir = process.env.E2E_FIRST_LAUNCH_FRAMES

  Object.assign(globalThis, { hc1127Marks: marks })

  app.once('ready', () => {
    mark('app-ready')
    session.defaultSession.registerPreloadScript({ id: 'hc1127-recorder', type: 'frame', filePath: __filename })
  })

  const load = BrowserWindow.prototype.loadURL

  BrowserWindow.prototype.loadURL = function (...args) {
    // The shell's own URL has no `?win=` kind: more than one of these is a second main window.
    if (!String(args[0]).includes('?win=')) {
      mark('shell-load')
    }

    if (!marks.some(entry => entry.name === 'window-created')) {
      mark('window-created')
      this.once('show', () => mark('window-shown'))

      // Timing runs start the app without Playwright: this is how they see the login screen.
      if (marksFile) {
        const poll = setInterval(() => {
          if (this.isDestroyed()) {
            clearInterval(poll)

            return
          }

          void this.webContents
            .executeJavaScript(`(document.body?.textContent ?? '').includes('登录 APEX')`)
            .then(up => {
              if (up && !marks.some(entry => entry.name === 'login-up')) {
                clearInterval(poll)
                mark('login-up')
              }
            })
            .catch(() => undefined)
        }, 50)
      }

      if (framesDir) {
        fs.mkdirSync(framesDir, { recursive: true })
        const { debugger: cdp } = this.webContents
        let count = 0

        cdp.attach('1.3')
        cdp.on('message', (_message, method, params) => {
          if (method === 'Page.screencastFrame') {
            count += 1
            fs.writeFileSync(
              path.join(framesDir, `${Date.now()}-${String(count).padStart(4, '0')}.jpg`),
              Buffer.from(params.data, 'base64')
            )
            void cdp.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined)
          }
        })
        void cdp.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 55 }).catch(() => undefined)
      }
    }

    return load.apply(this, args)
  }
} else {
  const { contextBridge } = electron
  const frames = []
  const OLD = ['今天想推进什么业务', '沉浸式分析']
  const PRODUCT = ['在微信里找 APEX', '你好，我是 APEX']

  const seen = marker => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.includes(marker)) {
        continue
      }

      const range = document.createRange()
      range.selectNodeContents(node)
      const box = range.getBoundingClientRect()

      if (box.width <= 0 || box.height <= 0) {
        continue
      }

      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)

      if (hit && (node.parentElement.contains(hit) || hit.contains(node.parentElement))) {
        return true
      }
    }

    return false
  }

  let last = ''

  const record = () => {
    if (!document.body) {
      return
    }

    const entry = {
      old: OLD.filter(seen),
      product: PRODUCT.some(seen),
      login: (document.body.textContent || '').includes('登录 APEX'),
      visibility: document.visibilityState
    }

    const key = JSON.stringify(entry)

    if (key !== last) {
      last = key
      frames.push({ at: Date.now(), ...entry })
    }
  }

  new MutationObserver(record).observe(document, { childList: true, subtree: true, characterData: true })
  document.addEventListener('visibilitychange', record)
  contextBridge.exposeInMainWorld('hc1127Frames', () => frames)
}
