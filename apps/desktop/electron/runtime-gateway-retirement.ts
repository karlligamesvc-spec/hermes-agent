import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { buildDesktopBackendEnv } from './backend-env'
import { RuntimeUpdateBusy } from './runtime-update-busy'

const exec = promisify(execFile)

// Use the verified replacement's identity-aware gateway shutdown implementation.
// An arbitrary process holding the engine directory is never a shutdown target.
export const RETIRE_GATEWAYS = String.raw`
import json, os, pathlib, sys, time, uuid
import psutil
from gateway.drain_control import write_drain_request, clear_drain_request, read_drain_request
from gateway.status import get_running_pid, take_over_scoped_lock_holder, _validated_scoped_lock_gateway_owner, looks_like_gateway_runtime_command_line
try:
    from gateway.status import (read_runtime_status, get_runtime_status_running_pid, _snapshot_gateway_children,
        write_takeover_marker, clear_takeover_marker, _terminate_verified_owner, reap_gateway_children)
except ImportError:  # an older engine: only gateways with a gateway.pid are retired
    read_runtime_status = None

active, home, desktop_pid = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve(), int(sys.argv[3])
inspect_only = len(sys.argv) > 4 and sys.argv[4] == 'inspect'
roots = {os.path.abspath(active), os.path.realpath(active)}
def under_root(value):
    if not value or not os.path.isabs(value):
        return False
    return any(os.path.normcase(os.path.abspath(value)) == os.path.normcase(root) or
        os.path.normcase(os.path.abspath(value)).startswith(os.path.normcase(root) + os.sep) for root in roots)
def is_redirector(process):
    argv = process.cmdline()
    return looks_like_gateway_runtime_command_line(' '.join(argv)) and any(under_root(p) for p in [process.exe(), *argv])
def gone(process):
    try:
        return not process.is_running() or process.status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return True
def wait_gone(processes, seconds):
    deadline = time.monotonic() + seconds
    while not all(gone(p) for p in processes) and time.monotonic() < deadline:
        time.sleep(.05)
    return [p for p in processes if not gone(p)]

def owned_gateway(target):
    # (record, pid, from_pid_file) for this home's live gateway, else None. gateway.pid first; hc-1031: when it
    # is gone or names another life, the same identity (pid, start_time, home, argv) in gateway_state.json.
    pid_path = target / 'gateway.pid'
    if pid_path.is_file():
        record = json.loads(pid_path.read_text())
        pid = get_running_pid(pid_path, cleanup_stale=False)
        if (pathlib.Path(record.get('hermes_home', '')).resolve() == target and pid and pid == record.get('pid')
                and _validated_scoped_lock_gateway_owner(record) is not None):
            return record, pid, True
    if read_runtime_status is None:
        return None
    record = read_runtime_status(target / 'gateway_state.json')
    # The takeover binds to PID + creation time, so a record without a start time proves nothing.
    if not isinstance(record, dict) or not isinstance(record.get('start_time'), int):
        return None
    # Checks the state, the live PID and its start time, the record's home and the live command line.
    pid = get_runtime_status_running_pid(record, expected_home=target)
    return (record, pid, False) if pid else None
def take_over_runtime_owner(record, pid, target):
    # take_over_scoped_lock_holder for a gateway proven by gateway_state.json alone: the same takeover
    # marker, PID + creation-time bound SIGTERM-then-SIGKILL and child reaping.
    children = _snapshot_gateway_children(pid)
    if not write_takeover_marker(pid, target_home=target, target_start_time=record['start_time']):
        return None
    try:
        stopped = _terminate_verified_owner(pid, record['start_time'], graceful_attempts=10, force_attempts=4)
    finally:
        clear_takeover_marker(target)
    if stopped is not None:
        reap_gateway_children(children, parent_pid=pid)
    return stopped

homes = [home]
profiles = home / 'profiles'
if profiles.is_dir() and not profiles.is_symlink():
    homes += [p.resolve() for p in profiles.iterdir() if p.is_dir() and p.resolve().parent == profiles.resolve()]
retired = []
for target in homes:
    try:
        owned = owned_gateway(target)
        if owned is None:
            continue
        record, pid, from_pid_file = owned
        process = psutil.Process(pid)
        # Preserve a gateway owned by another still-running app/CLI instance.
        parent = process.parent()
        # Windows venv uses a redirector between Electron and the Python worker. It holds the
        # engine like its worker does, so it is exempt while inspecting and waited out on retirement.
        redirectors = []
        for _ in range(2):
            if parent is None or parent.pid in (1, desktop_pid):
                break
            if not is_redirector(parent):
                break
            redirectors.append(parent)
            parent = parent.parent()
        if parent is not None and parent.pid not in (1, desktop_pid):
            continue
        if not any(under_root(p) for p in [process.exe(), process.cwd(), *process.cmdline()]):
            continue
        # Absence of activity evidence must not be interpreted as an idle IM turn.
        try:
            state = json.loads((target / 'gateway_state.json').read_text())
        except (OSError, ValueError):
            state = {}
        if (state.get('pid') != pid or state.get('start_time') != record.get('start_time')
                or state.get('active_agents') != 0 or state.get('gateway_state') != 'running'):
            raise RuntimeError('APEX_RUNTIME_UPDATE_BUSY')
        if inspect_only:
            retired.extend([pid, *[child.pid for child in process.children(recursive=True)], *[r.pid for r in redirectors]])
            continue
        # Revalidates PID, creation time, canonical command and home record at
        # every signal; marks intentional shutdown and also reaps owned children.
        descendants = process.children(recursive=True) if os.name == 'nt' else []
        # Ask the live gateway to fence new turns before the final idle proof.
        # Never overwrite another controller's drain request.
        if read_drain_request(home=target) is not None:
            raise RuntimeError('APEX_RUNTIME_UPDATE_BUSY')
        principal = 'desktop-update-' + str(uuid.uuid4())
        write_drain_request(principal=principal, suppress_notification=True, home=target)
        try:
            for attempt in range(30):
                try:
                    state = json.loads((target / 'gateway_state.json').read_text())
                except (OSError, ValueError):
                    state = {}
                if (state.get('pid') == pid and state.get('start_time') == record.get('start_time')
                        and state.get('gateway_state') == 'draining' and state.get('active_agents') == 0):
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('APEX_RUNTIME_UPDATE_BUSY')
            stopped = (take_over_scoped_lock_holder(record, graceful_attempts=10, force_attempts=4) if from_pid_file
                       else take_over_runtime_owner(record, pid, target))
            if stopped is None:
                raise RuntimeError('Gateway identity could not be retired: PID ' + str(pid))
        finally:
            current_request = read_drain_request(home=target)
            if current_request and current_request.get('principal') == principal:
                clear_drain_request(home=target)
        # SIGTERM is TerminateProcess on Windows: the root may disappear before
        # taskkill /T can discover descendants. Retain psutil creation identities.
        for child in descendants:
            try:
                if child.is_running():
                    child.kill()
            except psutil.NoSuchProcess:
                pass
        if descendants and psutil.wait_procs(descendants, timeout=5)[1]:
            raise RuntimeError('Gateway descendants did not exit: PID ' + str(pid))
        # A redirector exits with its worker. One that outlives it is ended only while it still is
        # the same process (PID + creation time) running a gateway command under the engine.
        for redirector in wait_gone(redirectors, 5):
            try:
                if is_redirector(redirector):
                    redirector.kill()
            except psutil.NoSuchProcess:
                pass
        if wait_gone(redirectors, 5):
            raise RuntimeError('Gateway redirector did not exit: PID ' + str(pid))
        retired.extend([stopped, *[r.pid for r in redirectors]])
    except (psutil.NoSuchProcess, FileNotFoundError):
        continue
print(json.dumps(retired))
`

export async function retirePackagedGateways(activeRoot: string, verifiedRoot: string, hermesHome: string, inspectOnly = false): Promise<number[]> {
  if (!fs.existsSync(activeRoot)) {return []}
  const python = path.join(verifiedRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const inherited: NodeJS.ProcessEnv = {}

  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP', 'LANG']) {
    if (process.env[key]) {inherited[key] = process.env[key]}
  }

  const { stdout } = await exec(python, ['-c', RETIRE_GATEWAYS, activeRoot, hermesHome, String(process.pid), inspectOnly ? 'inspect' : 'retire'], {
    cwd: os.tmpdir(), windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024,
    env: { ...inherited, ...buildDesktopBackendEnv({ runtimeRoot: verifiedRoot, hermesHome, venvRoot: path.join(verifiedRoot, 'venv'), pythonPathEntries: [verifiedRoot], currentEnv: inherited }), PYTHONDONTWRITEBYTECODE: '1', HERMES_DISABLE_LAZY_INSTALLS: '1' }
  }).catch(error => {
    if (String(error.stderr).includes('APEX_RUNTIME_UPDATE_BUSY')) {throw new RuntimeUpdateBusy('Waiting for the messaging gateway to finish its turns.', 'gateway_busy')}
    throw error
  })

  const pids: unknown = JSON.parse(stdout.trim())

  if (!Array.isArray(pids) || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error('Invalid gateway retirement receipt')
  }

  return pids
}
