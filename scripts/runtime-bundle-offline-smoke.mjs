import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** This guard is private to the native smoke process. It permits loopback API
 * traffic and rejects Python's outbound sockets and external DNS resolution. */
const offlineGuard = `import errno, ipaddress, socket
def _local(host):
    if host is None or host == 'localhost': return True
    try: return ipaddress.ip_address(host).is_loopback
    except ValueError: return False
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_getaddrinfo = socket.getaddrinfo
def connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and not _local(address[0]):
        raise PermissionError('runtime smoke disallows external network')
    return _connect(self, address)
def connect_ex(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and not _local(address[0]): return errno.EACCES
    return _connect_ex(self, address)
def getaddrinfo(host, *args, **kwargs):
    if not _local(host): raise PermissionError('runtime smoke disallows external network')
    return _getaddrinfo(host, *args, **kwargs)
socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.getaddrinfo = getaddrinfo
socket._hermes_offline_guard = True
`

export function runtimeSmokeEnvironment(root, home, manifest) {
  fs.mkdirSync(home, { recursive: true })
  const guard = path.join(home, 'network-guard')
  fs.mkdirSync(guard, { recursive: true })
  fs.writeFileSync(path.join(guard, 'sitecustomize.py'), offlineGuard)
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(?:PATH$|PYTHON|VIRTUAL_ENV$|CONDA|HERMES_|APEX_|DYLD_|LD_)/i.test(name) ||
        /(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|AUTHORIZATION)/i.test(name)) delete env[name]
  }
  const venv = path.join(root, 'venv', manifest.os === 'win' ? 'Scripts' : 'bin')
  const node = path.join(root, '.runtime', 'node', ...(manifest.os === 'win' ? [] : ['bin']))
  const paths = [venv, node, path.join(root, '.runtime', 'bin')]
  env.HOME = home
  if (manifest.os === 'win') {
    paths.push(...['cmd', 'bin', 'usr/bin'].map(part => path.join(root, '.runtime', 'git', ...part.split('/'))))
    paths.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'))
    env.USERPROFILE = home
    env.APPDATA = path.join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local')
    env.HERMES_GIT_BASH_PATH = path.join(root, '.runtime', 'git', 'bin', 'bash.exe')
  } else {
    paths.push('/usr/bin', '/bin')
  }
  env.PATH = paths.join(path.delimiter)
  env.HERMES_HOME = path.join(home, '.hermes')
  env.PYTHONPATH = [guard, root].join(path.delimiter)
  env.PYTHONDONTWRITEBYTECODE = '1'
  // Native package managers do not pass through Python's socket guard.
  env.UV_OFFLINE = '1'
  env.PIP_NO_INDEX = '1'
  // Readiness/import probes must not start optional dependency installers.
  env.HERMES_DISABLE_LAZY_INSTALLS = '1'
  const temporary = path.join(home, 'tmp')
  fs.mkdirSync(temporary, { recursive: true })
  env.TMPDIR = temporary
  env.TEMP = temporary
  env.TMP = temporary
  env.TZ = 'UTC'
  env.LANG = 'C.UTF-8'
  return env
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitForOwnedClose(closed, timeoutMs) {
  let timer
  try {
    return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

/** Only generated, caller-owned trees. Transient native file locks get a
 * bounded retry budget; an unreleased lock still fails the verification. */
export function removeOwnedRuntimeTree(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

export async function terminateOwnedSmokeProcess(child, closed) {
  // A failed spawn never owns a PID, and its close event may already have fired.
  if (!child.pid) return
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      // Keep the root alive until taskkill enumerates its owned descendants.
      // A venv launcher or optional uv child can otherwise outlive Python and
      // retain executable locks. Never target an exited/reused PID or an image.
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      try {
        await execute(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 })
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          const rootClosed = await waitForOwnedClose(closed, 5000)
          throw new Error(`Owned Windows process tree ${child.pid} did not terminate (root closed: ${rootClosed}): ${error.message}`)
        }
      }
    } else {
      child.kill('SIGTERM')
      if (!await waitForOwnedClose(closed, 5000)) child.kill('SIGKILL')
    }
  }
  if (!await waitForOwnedClose(closed, 5000)) throw new Error(`Owned smoke process ${child.pid} did not close within 5 seconds`)
}

/** Launch only the extracted interpreter's real CLI serve path. No --stop,
 * process-table scans or shared HOME; cleanup targets only this spawned root
 * and, on Windows, the descendants enumerated while that root is still live. */
export async function probeBundledBackend(root, manifest, env, log = () => {}) {
  const port = await freePort()
  const python = path.join(root, 'venv', manifest.os === 'win' ? 'Scripts/python.exe' : 'bin/python')
  const child = spawn(python, ['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', String(port), '--isolated', '--skip-build'], {
    cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  let output = ''
  let spawnError
  child.on('error', error => { spawnError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-65536) })
  try {
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Bundled backend exited before readiness: ${spawnError?.message || child.exitCode}\n${output}`)
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
        const health = response.ok ? await response.json() : null
        if (health?.ok === true && typeof health.version === 'string') {
          log(`offline-backend-ok pid=${child.pid} port=${port} version=${health.version}`)
          return { pid: child.pid, port, health, minimal_path: env.PATH, python_outbound_network_blocked: true }
        }
      } catch { /* bounded readiness polling */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`Bundled backend did not become ready within 90 seconds\n${output}`)
  } finally {
    await terminateOwnedSmokeProcess(child, closed)
  }
}
