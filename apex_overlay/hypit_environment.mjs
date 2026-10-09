import path from 'node:path'

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
  return env
}
