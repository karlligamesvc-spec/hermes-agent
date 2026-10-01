import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

import { download } from '../../../scripts/build-runtime-bundle.mjs'

function systemPython() {
  if (process.platform !== 'win32') return '/usr/bin/python3'
  const result = spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function fixtureServer(root, mode) {
  const script = path.join(root, 'partial-server.py')
  fs.writeFileSync(script, `import http.server, json, sys
payload = b'complete-native-tool-payload' * 32
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        offset = int((self.headers.get('Range') or 'bytes=0-').split('=')[1].split('-')[0])
        if offset == 0:
            self.send_response(200)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload[:13])
        else:
            valid = sys.argv[1] == 'resumable'
            self.send_response(206 if valid else 200)
            if valid: self.send_header('Content-Range', f'bytes {offset}-{len(payload)-1}/{len(payload)}')
            self.send_header('Content-Length', str(len(payload)-offset if valid else len(payload)))
            self.end_headers()
            try: self.wfile.write(payload[offset:] if valid else payload)
            except BrokenPipeError: pass
        self.close_connection = True
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
print(json.dumps({'port':server.server_port}), flush=True)
server.handle_request()
server.handle_request()
server.server_close()
`)
  const child = spawn(systemPython(), [script, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('partial HTTP fixture did not bind')), 10000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.stdout.on('data', bytes => {
      buffer += bytes
      if (buffer.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(buffer.split('\n')[0]).port) }
    })
  })
  return { child, url: `http://127.0.0.1:${port}/native-tool.tar.gz` }
}

test('a interrupted real HTTP body resumes from its preserved bytes and rejects a server that ignores Range', async () => {
  for (const mode of ['resumable', 'ignores-range']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-resume-'))
    const server = await fixtureServer(root, mode)
    try {
      const dest = path.join(root, 'tool.tar.gz')
      const operation = download(server.url, dest, { attempts: 2, timeoutSec: 10,
        env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } })
      if (mode === 'resumable') {
        assert.equal(await operation, dest)
        assert.equal(fs.readFileSync(dest, 'utf8'), 'complete-native-tool-payload'.repeat(32))
        const proof = JSON.parse(fs.readFileSync(`${dest}.download-proof.json`, 'utf8'))
        assert.equal(proof[0].received, 13)
        assert.equal(proof[0].curl_exit, 18)
        assert.equal(proof[1].offset, 13)
        assert.equal(proof[1].status, 206)
        assert.equal(proof[1].content_range, `bytes 13-${fs.statSync(dest).size - 1}/${fs.statSync(dest).size}`)
        assert.equal(proof[1].resumed, true)
      } else {
        await assert.rejects(operation, /did not honor the requested Range/)
        assert.equal(fs.existsSync(dest), false)
        assert.equal(fs.statSync(`${dest}.part`).size, 13)
      }
    } finally {
      server.child.kill()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})
