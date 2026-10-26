import path from 'node:path'

// Desktop main writes this from desktop_features.hypihub_apex (default off) before the engine spawns.
export function hostedHypit(env) { return env.APEX_HYPIHUB_ACTIVE === '1' }

export function hypitEnvironment(source, root, node, registry) {
  const env = { ...source, npm_config_registry: registry,
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    PUPPETEER_SKIP_DOWNLOAD: 'true' }
  // Node selects a single case-insensitive PATH entry on Windows. Keeping both
  // Path and PATH can discard the inherited PowerShell/system-tool directories.
  const keys = Object.keys(env).filter(key => key.toUpperCase() === 'PATH')
  const inherited = keys.map(key => env[key]).filter(Boolean)
  for (const key of keys) delete env[key]
  env.PATH = [path.join(root, '.runtime/bin'), path.dirname(node), ...inherited].join(path.delimiter)
  env.PYTHONPATH = [root, env.PYTHONPATH].filter(Boolean).join(path.delimiter)
  // The hosted Profile's env Store slot. CLI and the Worker it starts inherit it; it is
  // the engine's platform-tool credential (hc-604), never read from or written to a file.
  if (hostedHypit(env) && env.TOOLS_GATEWAY_KEY) env.APEX_HYPIHUB_TOKEN = env.TOOLS_GATEWAY_KEY
  return env
}
