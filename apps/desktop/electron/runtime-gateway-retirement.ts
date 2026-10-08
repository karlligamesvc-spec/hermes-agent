import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { buildDesktopBackendEnv } from './backend-env'

const exec = promisify(execFile)

// Use the verified replacement's identity-aware gateway shutdown implementation.
// An arbitrary process holding the engine directory is never a shutdown target.
export const RETIRE_GATEWAYS = String.raw`
import json, os, pathlib, sys
import psutil
from gateway.status import get_running_pid, take_over_scoped_lock_holder, _validated_scoped_lock_gateway_owner, looks_like_gateway_runtime_command_line

active, home, desktop_pid = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve(), int(sys.argv[3])
roots = {os.path.abspath(active), os.path.realpath(active)}
def under_root(value):
    if not value or not os.path.isabs(value):
        return False
    return any(os.path.normcase(os.path.abspath(value)) == os.path.normcase(root) or
        os.path.normcase(os.path.abspath(value)).startswith(os.path.normcase(root) + os.sep) for root in roots)

homes = [home]
profiles = home / 'profiles'
if profiles.is_dir() and not profiles.is_symlink():
    homes += [p.resolve() for p in profiles.iterdir() if p.is_dir() and p.resolve().parent == profiles.resolve()]
retired = []
for target in homes:
    pid_path = target / 'gateway.pid'
    if not pid_path.is_file():
        continue
    try:
        record = json.loads(pid_path.read_text())
        if pathlib.Path(record.get('hermes_home', '')).resolve() != target:
            continue
        pid = get_running_pid(pid_path, cleanup_stale=False)
        if not pid or pid != record.get('pid') or _validated_scoped_lock_gateway_owner(record) is None:
            continue
        process = psutil.Process(pid)
        # Preserve a gateway owned by another still-running app/CLI instance.
        parent = process.parent()
        # Windows venv uses a redirector between Electron and the Python worker.
        for _ in range(2):
            if parent is None or parent.pid in (1, desktop_pid):
                break
            argv = parent.cmdline()
            if not looks_like_gateway_runtime_command_line(' '.join(argv)) or not any(under_root(p) for p in [parent.exe(), *argv]):
                break
            parent = parent.parent()
        if parent is not None and parent.pid not in (1, desktop_pid):
            continue
        if not any(under_root(p) for p in [process.exe(), process.cwd(), *process.cmdline()]):
            continue
        # Revalidates PID, creation time, canonical command and home record at
        # every signal; marks intentional shutdown and also reaps owned children.
        stopped = take_over_scoped_lock_holder(record, graceful_attempts=10, force_attempts=4)
        if stopped is None:
            raise RuntimeError('Gateway identity could not be retired: PID ' + str(pid))
        retired.append(stopped)
    except (psutil.NoSuchProcess, FileNotFoundError):
        continue
print(json.dumps(retired))
`

export async function retirePackagedGateways(activeRoot: string, verifiedRoot: string, hermesHome: string): Promise<number[]> {
  if (!fs.existsSync(activeRoot)) {return []}
  const python = path.join(verifiedRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const inherited: NodeJS.ProcessEnv = {}

  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP', 'LANG']) {
    if (process.env[key]) {inherited[key] = process.env[key]}
  }

  const { stdout } = await exec(python, ['-c', RETIRE_GATEWAYS, activeRoot, hermesHome, String(process.pid)], {
    cwd: os.tmpdir(), windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024,
    env: { ...inherited, ...buildDesktopBackendEnv({ runtimeRoot: verifiedRoot, hermesHome, venvRoot: path.join(verifiedRoot, 'venv'), pythonPathEntries: [verifiedRoot], currentEnv: inherited }), PYTHONDONTWRITEBYTECODE: '1', HERMES_DISABLE_LAZY_INSTALLS: '1' }
  })

  const pids: unknown = JSON.parse(stdout.trim())

  if (!Array.isArray(pids) || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error('Invalid gateway retirement receipt')
  }

  return pids
}
