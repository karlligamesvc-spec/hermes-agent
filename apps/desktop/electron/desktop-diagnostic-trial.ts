import path from 'node:path'

import diagnosticTrialPolicy from '../diagnostic-trial-policy.json'

import { resolveUserDataDir } from './user-data-dir'

export const PRODUCTION_DESKTOP_IDENTITY = Object.freeze({
  appId: 'com.apexnodes.desktop',
  productName: 'APEX'
})

export const DIAGNOSTIC_TRIAL_ROOT_ENV = 'APEX_DESKTOP_DIAGNOSTIC_ROOT'
export const DIAGNOSTIC_TRIAL_MARKER = '.apex-diagnostic-trial.json'

interface DiagnosticTrialPolicy {
  appId: string
  artifactName: string
  executableName: string
  mode: 'isolated-diagnostic'
  productName: string
  protocolRegistration: 'disabled'
  runtimeSourceCommit: string
  runtimeUpdates: 'disabled'
  schemaVersion: 1
  shellUpdater: 'disabled'
}

interface ProductionDesktopPolicy {
  appId: string
  mode: 'production'
  productName: string
  protocolRegistration: 'enabled'
  runtimeUpdates: 'enabled'
  shellUpdater: 'enabled'
}

interface InvalidDesktopPolicy {
  error: string
  mode: 'invalid'
}

export type DesktopLaunchPolicy = DiagnosticTrialPolicy | ProductionDesktopPolicy

type ResolvedDesktopPolicy = DesktopLaunchPolicy | InvalidDesktopPolicy

interface DiagnosticTrialMarker {
  appId: string
  mode: 'isolated-diagnostic'
  runtimeSourceCommit: string
  schemaVersion: 1
}

interface DesktopLaunchInitializationDependencies {
  additionalProtectedRoots?: Array<string | null | undefined>
  appDataDir: string
  canonicalizePath: (candidate: string) => string | null
  directoryExists: (candidate: string) => boolean
  env: Record<string, string | undefined>
  fileExists: (candidate: string) => boolean
  homeDir: string
  localAppDataDir?: string
  mkdirUserData: (candidate: string) => void
  packageJson: unknown
  platform: NodeJS.Platform
  readRuntimeBinding: (
    pythonPath: string,
    runtimeRoot: string,
    hermesHome: string
  ) => { modulePath: string } | null
  readDiagnosticMarker: (candidate: string) => unknown
  readRuntimeCommit: (runtimeRoot: string) => string | null
  setUserDataPath: (candidate: string) => void
  runtimeAppName?: string
}

export type DesktopLaunchInitialization =
  | {
      diagnosticRoot: null
      hermesHome: null
      mode: 'production'
      ok: true
      policy: ProductionDesktopPolicy
      pythonPath: null
      runtimeRoot: null
      userDataDir: string
      workingDirectory: null
    }
  | {
      diagnosticRoot: string
      hermesHome: string
      mode: 'isolated-diagnostic'
      ok: true
      policy: DiagnosticTrialPolicy
      pythonPath: string
      runtimeRoot: string
      userDataDir: string
      workingDirectory: string
    }
  | {
      error: string
      message: string
      mode: 'refused'
      ok: false
    }

const EXPECTED_DIAGNOSTIC_KEYS = Object.freeze(
  [...Object.keys(diagnosticTrialPolicy), 'runtimeSourceCommit'].sort()
)

const DIAGNOSTIC_RUNTIME_NAMES = new Set([
  'apex-diagnostic-trial',
  diagnosticTrialPolicy.productName
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function invalidPolicy(error: string): InvalidDesktopPolicy {
  return Object.freeze({ error, mode: 'invalid' })
}

/**
 * The formal build carries no desktopTrial field and keeps the shipping APEX
 * behavior. A diagnostic package must carry the complete, exact policy: a
 * partial or future/unknown shape refuses instead of silently becoming APEX.
 */
export function resolveDesktopLaunchPolicy(
  packageJson: unknown,
  { runtimeAppName }: { runtimeAppName?: string } = {}
): ResolvedDesktopPolicy {
  const apexnodes = isRecord(packageJson) && isRecord(packageJson.apexnodes) ? packageJson.apexnodes : null
  const raw = apexnodes?.desktopTrial
  const packageBuild = isRecord(packageJson) && isRecord(packageJson.build) ? packageJson.build : null

  const carriesDiagnosticIdentity =
    (isRecord(packageJson) &&
      (packageJson.name === 'apex-diagnostic-trial' || packageJson.productName === diagnosticTrialPolicy.productName)) ||
    packageBuild?.appId === diagnosticTrialPolicy.appId ||
    (typeof runtimeAppName === 'string' && DIAGNOSTIC_RUNTIME_NAMES.has(runtimeAppName))

  if (raw === undefined) {
    if (carriesDiagnosticIdentity) {
      return invalidPolicy('diagnostic package is missing desktopTrial metadata')
    }

    return Object.freeze({
      ...PRODUCTION_DESKTOP_IDENTITY,
      mode: 'production' as const,
      protocolRegistration: 'enabled' as const,
      runtimeUpdates: 'enabled' as const,
      shellUpdater: 'enabled' as const
    })
  }

  if (!isRecord(raw)) {
    return invalidPolicy('desktopTrial metadata must be an object')
  }

  const keys = Object.keys(raw).sort()

  if (keys.length !== EXPECTED_DIAGNOSTIC_KEYS.length || keys.some((key, index) => key !== EXPECTED_DIAGNOSTIC_KEYS[index])) {
    return invalidPolicy(`desktopTrial metadata keys are not recognized: ${keys.join(', ') || '<none>'}`)
  }

  for (const key of Object.keys(diagnosticTrialPolicy)) {
    if (raw[key] !== diagnosticTrialPolicy[key]) {
      return invalidPolicy(`desktopTrial metadata field ${key} is not the approved value`)
    }
  }

  if (typeof raw.runtimeSourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(raw.runtimeSourceCommit)) {
    return invalidPolicy('desktopTrial runtimeSourceCommit must be a full lowercase SHA')
  }

  if (
    !carriesDiagnosticIdentity ||
    (runtimeAppName !== undefined && !DIAGNOSTIC_RUNTIME_NAMES.has(runtimeAppName))
  ) {
    return invalidPolicy('desktopTrial metadata is not paired with the diagnostic package identity')
  }

  return Object.freeze({ ...diagnosticTrialPolicy, runtimeSourceCommit: raw.runtimeSourceCommit }) as DiagnosticTrialPolicy
}

function normalizeForComparison(candidate: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(candidate)

  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSameOrInside(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const normalizedCandidate = normalizeForComparison(candidate, platform)
  const normalizedRoot = normalizeForComparison(root, platform)
  const relative = path.relative(normalizedRoot, normalizedCandidate)

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolve symlinks even when the final path does not exist yet. This walks to
 * the closest existing parent, realpaths that parent, then restores the
 * missing suffix. It keeps the pre-write overlap check meaningful for a
 * launcher-created directory whose parent is a symlink into production data.
 */
export function canonicalizePathThroughExistingParent(
  candidate: string,
  dependencies: {
    exists: (candidate: string) => boolean
    realpath: (candidate: string) => string
  }
): string | null {
  let current = path.resolve(candidate)
  const missingSegments: string[] = []

  while (!dependencies.exists(current)) {
    const parent = path.dirname(current)

    if (parent === current) {
      return null
    }

    missingSegments.unshift(path.basename(current))
    current = parent
  }

  try {
    return path.join(dependencies.realpath(current), ...missingSegments)
  } catch {
    return null
  }
}

export function productionHermesHomeFromEnvironment(
  environmentHome: string | undefined,
  diagnosticRoot: string | undefined
): string | null | undefined {
  if (!environmentHome || !diagnosticRoot || !path.isAbsolute(diagnosticRoot)) {
    return environmentHome
  }

  const derivedDiagnosticHome = path.join(path.resolve(diagnosticRoot), 'hermes-home')

  return path.resolve(environmentHome) === derivedDiagnosticHome ? null : environmentHome
}

function requiredAbsolutePath(
  value: string | undefined,
  label: string
): { ok: true; value: string } | { error: string; ok: false } {
  const trimmed = typeof value === 'string' ? value.trim() : ''

  if (!trimmed) {
    return { error: `${label} is required`, ok: false }
  }

  if (!path.isAbsolute(trimmed)) {
    return { error: `${label} must be an absolute path`, ok: false }
  }

  return { ok: true, value: path.resolve(trimmed) }
}

function markerMatchesPolicy(marker: unknown, policy: DiagnosticTrialPolicy): marker is DiagnosticTrialMarker {
  return (
    isRecord(marker) &&
    marker.schemaVersion === policy.schemaVersion &&
    marker.mode === policy.mode &&
    marker.appId === policy.appId &&
    marker.runtimeSourceCommit === policy.runtimeSourceCommit
  )
}

function refused(error: string): DesktopLaunchInitialization {
  return {
    error,
    message:
      `This diagnostic APEX build only runs through its paired isolated launcher. ${error}. ` +
      'No APEX user data or Runtime fallback was opened.',
    mode: 'refused',
    ok: false
  }
}

/**
 * Synchronous pre-ready gate. No write callback is invoked until the embedded
 * policy, marker, isolated directories, exact Runtime commit and interpreter
 * all pass. main.ts executes this before its first app.setPath/userData write.
 */
export function initializeDesktopLaunchEnvironment(
  dependencies: DesktopLaunchInitializationDependencies
): DesktopLaunchInitialization {
  const policy = resolveDesktopLaunchPolicy(dependencies.packageJson, {
    runtimeAppName: dependencies.runtimeAppName
  })

  if (policy.mode === 'invalid') {
    return refused(policy.error)
  }

  if (policy.mode === 'production') {
    const userDataDir = resolveUserDataDir(
      dependencies.appDataDir,
      dependencies.env.HERMES_DESKTOP_USER_DATA_DIR
    )

    dependencies.mkdirUserData(userDataDir)
    dependencies.setUserDataPath(userDataDir)

    return {
      diagnosticRoot: null,
      hermesHome: null,
      mode: policy.mode,
      ok: true,
      policy,
      pythonPath: null,
      runtimeRoot: null,
      userDataDir,
      workingDirectory: null
    }
  }

  const rootResult = requiredAbsolutePath(dependencies.env[DIAGNOSTIC_TRIAL_ROOT_ENV], DIAGNOSTIC_TRIAL_ROOT_ENV)

  if (rootResult.ok === false) {
    return refused(rootResult.error)
  }

  if (!dependencies.directoryExists(rootResult.value)) {
    return refused(`diagnostic root does not exist: ${rootResult.value}`)
  }

  const diagnosticRoot = dependencies.canonicalizePath(rootResult.value)

  if (!diagnosticRoot) {
    return refused(`diagnostic root cannot be resolved: ${rootResult.value}`)
  }

  const requestedUserDataDir = path.join(diagnosticRoot, 'user-data')
  const requestedHermesHome = path.join(diagnosticRoot, 'hermes-home')
  const requestedWorkingDirectory = path.join(diagnosticRoot, 'workspace')

  const runtimeResult = requiredAbsolutePath(
    dependencies.env.HERMES_DESKTOP_HERMES_ROOT,
    'HERMES_DESKTOP_HERMES_ROOT'
  )

  if (runtimeResult.ok === false) {
    return refused(runtimeResult.error)
  }

  const pythonResult = requiredAbsolutePath(dependencies.env.HERMES_DESKTOP_PYTHON, 'HERMES_DESKTOP_PYTHON')

  if (pythonResult.ok === false) {
    return refused(pythonResult.error)
  }

  const requestedRuntimeRoot = runtimeResult.value
  const requestedPythonPath = pythonResult.value

  for (const [label, candidate] of [
    ['isolated userData', requestedUserDataDir],
    ['isolated HERMES_HOME', requestedHermesHome],
    ['isolated workspace', requestedWorkingDirectory],
    ['paired Runtime', requestedRuntimeRoot]
  ] as const) {
    if (!dependencies.directoryExists(candidate)) {
      return refused(`${label} directory does not exist: ${candidate}`)
    }
  }

  if (!dependencies.fileExists(requestedPythonPath)) {
    return refused(`paired Runtime Python does not exist: ${requestedPythonPath}`)
  }

  const userDataDir = dependencies.canonicalizePath(requestedUserDataDir)
  const hermesHome = dependencies.canonicalizePath(requestedHermesHome)
  const workingDirectory = dependencies.canonicalizePath(requestedWorkingDirectory)
  const runtimeRoot = dependencies.canonicalizePath(requestedRuntimeRoot)
  const pythonPath = dependencies.canonicalizePath(requestedPythonPath)

  if (!userDataDir || !hermesHome || !workingDirectory || !runtimeRoot || !pythonPath) {
    return refused('one or more diagnostic paths cannot be resolved through the filesystem')
  }

  const productionUserData = resolveUserDataDir(dependencies.appDataDir, undefined)

  const protectedRoots = [
    productionUserData,
    path.join(dependencies.homeDir, '.apexnodes'),
    path.join(dependencies.homeDir, '.hermes'),
    ...(dependencies.additionalProtectedRoots || []).filter((candidate): candidate is string => Boolean(candidate))
  ]

  if (dependencies.localAppDataDir) {
    protectedRoots.push(path.join(dependencies.localAppDataDir, 'apexnodes'))
  }

  const canonicalProtectedRoots = protectedRoots
    .map(root => dependencies.canonicalizePath(root))
    .filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of [diagnosticRoot, userDataDir, hermesHome, workingDirectory, runtimeRoot]) {
    const protectedRoot = canonicalProtectedRoots.find(root => isSameOrInside(candidate, root, dependencies.platform))

    if (protectedRoot) {
      return refused(`diagnostic path ${candidate} overlaps protected APEX data ${protectedRoot}`)
    }
  }

  if (!markerMatchesPolicy(dependencies.readDiagnosticMarker(path.join(diagnosticRoot, DIAGNOSTIC_TRIAL_MARKER)), policy)) {
    return refused(`diagnostic marker is missing or does not match the embedded policy`)
  }

  if (!dependencies.fileExists(path.join(runtimeRoot, 'hermes_cli', 'main.py'))) {
    return refused(`paired Runtime is not a Hermes source tree: ${runtimeRoot}`)
  }

  const runtimeCommit = dependencies.readRuntimeCommit(runtimeRoot)

  if (runtimeCommit !== policy.runtimeSourceCommit) {
    return refused(
      `paired Runtime commit ${runtimeCommit || '<unreadable>'} does not match ${policy.runtimeSourceCommit}`
    )
  }

  const binding = dependencies.readRuntimeBinding(requestedPythonPath, runtimeRoot, hermesHome)
  const modulePath = binding?.modulePath && dependencies.canonicalizePath(binding.modulePath)

  if (!modulePath || !isSameOrInside(modulePath, runtimeRoot, dependencies.platform)) {
    return refused('paired Python did not resolve hermes_cli.main from the verified Runtime')
  }

  // These are the first write-capable calls in this function. Every refusal
  // above returns without touching userData or HERMES_HOME.
  dependencies.mkdirUserData(userDataDir)
  dependencies.setUserDataPath(userDataDir)

  return {
    diagnosticRoot,
    hermesHome,
    mode: policy.mode,
    ok: true,
    policy,
    pythonPath: requestedPythonPath,
    runtimeRoot,
    userDataDir,
    workingDirectory
  }
}

export function registerOsLoginProtocolForPolicy(
  policy: DesktopLaunchPolicy,
  register: () => boolean
): { attempted: boolean; registered: boolean } {
  if (policy.protocolRegistration !== 'enabled') {
    return { attempted: false, registered: false }
  }

  return { attempted: true, registered: register() }
}

export function updatesAllowedByPolicy(policy: DesktopLaunchPolicy): boolean {
  return policy.shellUpdater === 'enabled' && policy.runtimeUpdates === 'enabled'
}

export async function runDesktopMaintenanceForPolicy<T>(
  policy: DesktopLaunchPolicy,
  operation: string,
  run: () => Promise<T> | T
): Promise<T | { error: 'diagnostic-trial-maintenance-disabled'; ok: false; operation: string }> {
  if (policy.mode !== 'production') {
    return {
      error: 'diagnostic-trial-maintenance-disabled',
      ok: false,
      operation
    }
  }

  return run()
}
