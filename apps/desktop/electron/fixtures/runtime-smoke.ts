// Fixtures shared by the native unit tests and the release-only consumer smoke
// (scripts/bundled-runtime-consumer-smoke.mts). The smoke runs only inside the
// signed release builds, so a private copy of these drifted unnoticed when #386
// changed the idle gate and gateway retirement. electron/runtime-smoke-contract.test.ts
// keeps both consumers on this one copy and the anchor on the product line.

/** The exact holder filter in assertPackagedRuntimeIdle that the Windows smoke reverses. */
export const IDLE_PID_FILTER_ANCHOR = 'const holderPids = result.holders.filter((pid: number) => pid !== ownedProbePid && !options.retiringGatewayPids?.includes(pid))'

/** The reversal: every scanned PID, including the scanner's own redirector, counts as a holder. */
export const IDLE_PID_FILTER_REVERSED = 'const holderPids = result.holders'

const GATEWAY_DESCENDANT_CODE = "import json,os,pathlib,psutil,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(os.environ['HERMES_HOME'],'descendant.pid').write_text(json.dumps(dict(pid=os.getpid(),created=psutil.Process().create_time()))); time.sleep(120)"

/**
 * A gateway that owns the runtime lock and a SIGTERM-ignoring descendant, and answers the
 * desktop update's drain request the way the real watcher does (gateway_state -> draining).
 * The caller writes gateway_state.json: its absence or active_agents > 0 must keep it alive.
 * With APEX_FIXTURE_REDIRECTOR=<seconds> the process first acts as the Windows venv launcher
 * does: it re-runs its own command line as a child, waits for it, lingers, then exits.
 */
export function gatewayFixtureScript({ wedged }: { wedged: boolean }): string {
  return [
    'import json,os,pathlib,psutil,signal,subprocess,sys,time',
    "if 'APEX_FIXTURE_REDIRECTOR' in os.environ:",
    "    linger=float(os.environ.pop('APEX_FIXTURE_REDIRECTOR')); code=subprocess.call([sys.executable,*sys.argv]); time.sleep(linger); sys.exit(code)",
    'from gateway.status import acquire_gateway_runtime_lock,write_pid_file',
    'from utils import atomic_json_write',
    'assert acquire_gateway_runtime_lock()',
    'write_pid_file()',
    "pathlib.Path(os.environ['HERMES_HOME'],'owner.pid').write_text(json.dumps(dict(pid=os.getpid(),created=psutil.Process().create_time())))",
    `subprocess.Popen([sys.executable,'-c',${JSON.stringify(GATEWAY_DESCENDANT_CODE)}])`,
    "while not pathlib.Path(os.environ['HERMES_HOME'],'descendant.pid').exists(): time.sleep(.01)",
    ...(wedged ? ['signal.signal(signal.SIGTERM,signal.SIG_IGN)'] : []),
    "print('ready',flush=True)",
    'while True:',
    "    if pathlib.Path(os.environ['HERMES_HOME'],'.drain_request.json').exists():",
    "        status=pathlib.Path(os.environ['HERMES_HOME'],'gateway_state.json'); state=json.loads(status.read_text()); state['gateway_state']='draining'; atomic_json_write(status,state)",
    '    time.sleep(.05)'
  ].join('\n')
}

/** gateway_state.json for the fixture's own PID record: serving, with `activeAgents` IM turns in flight. */
export function gatewayRuntimeState(record: Record<string, unknown>, activeAgents: number) {
  return { ...record, gateway_state: 'running', active_agents: activeAgents }
}
