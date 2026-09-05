const MAC_TARGET_FLAGS = new Map([
  ['--arm64', 'arm64'],
  ['--x64', 'x64'],
  ['--universal', 'universal']
])

export function requestedMacTargetArch(args) {
  const requested = args.filter(arg => MAC_TARGET_FLAGS.has(arg)).map(arg => MAC_TARGET_FLAGS.get(arg))

  if (new Set(requested).size > 1) {
    throw new Error(`Conflicting macOS target architecture flags: ${requested.join(', ')}`)
  }

  return requested[0] ?? null
}

export function canReuseInstalledElectronDist({ args, hostArch, platform }) {
  if (platform !== 'darwin') return true

  const targetArch = requestedMacTargetArch(args)
  return targetArch === null || targetArch === hostArch
}
