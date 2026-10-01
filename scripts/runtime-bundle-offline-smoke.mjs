import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

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

async function terminateOwned(child, closed) {
  // A failed spawn never owns a PID, and its close event may already have fired.
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  let timer
  const stopped = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000) })])
  clearTimeout(timer)
  if (!stopped) {
    child.kill('SIGKILL')
    await closed
  }
}

/** Launch only the extracted interpreter's real CLI serve path. No --stop,
 * process-table scans or shared HOME; cleanup signals only this child handle. */
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
    await terminateOwned(child, closed)
  }
}
