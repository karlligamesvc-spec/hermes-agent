import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const MACH_HEADERS = new Map([
  ['feedface', 'BE'], ['feedfacf', 'BE'], ['cefaedfe', 'LE'], ['cffaedfe', 'LE']
])

/** Read Mach-O's file type, including the first architecture of a fat binary.
 * A Java .class also starts with cafebabe, so that magic alone is insufficient. */
export function machOFileType(bytes) {
  if (bytes.length < 16) return null
  const magic = bytes.subarray(0, 4).toString('hex')
  const endian = MACH_HEADERS.get(magic)
  if (endian) return bytes[`readUInt32${endian}`](12)
  if (magic !== 'cafebabe' && magic !== 'cafebabf') return null
  if (bytes.length < 32) return null
  const count = bytes.readUInt32BE(4)
  if (count < 1 || count > 20) return null
  const offset = magic === 'cafebabe' ? bytes.readUInt32BE(16) : Number(bytes.readBigUInt64BE(16))
  if (!Number.isSafeInteger(offset) || offset < 8 || offset + 16 > bytes.length) return null
  return machOFileType(bytes.subarray(offset))
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024, shell: false
  })
  // Arguments can include the Apple key file path. Keep them out of errors.
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || result.status}`)
  }
  return result.stdout
}

function* files(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) yield* files(absolute)
    else if (entry.isFile()) yield absolute
  }
}

function header(file) {
  const fd = fs.openSync(file, 'r')
  const bytes = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 65536))
  try {
    fs.readSync(fd, bytes, 0, bytes.length, 0)
    const magic = bytes.subarray(0, 4).toString('hex')
    if (bytes.length >= 32 && ['cafebabe', 'cafebabf'].includes(magic) && bytes.readUInt32BE(4) >= 1 && bytes.readUInt32BE(4) <= 20) {
      const offset = magic === 'cafebabe' ? bytes.readUInt32BE(16) : Number(bytes.readBigUInt64BE(16))
      if (Number.isSafeInteger(offset) && offset >= bytes.length && offset + 16 <= fs.fstatSync(fd).size) {
        const inner = Buffer.alloc(16)
        fs.readSync(fd, inner, 0, inner.length, offset)
        return inner
      }
    }
  } finally { fs.closeSync(fd) }
  return bytes
}

export function signMacRuntimePayload(root, identity) {
  if (process.platform !== 'darwin') throw new Error('Mac payload signing requires a native macOS host')
  if (!identity) throw new Error('Mac payload signing requires a Developer ID identity')
  const entitlements = path.join(root, '.runtime', 'native-entitlements.plist')
  fs.writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`)
  const nativeFiles = []
  let signed = 0
  let executables = 0
  let detachedHardlinks = 0
  for (const file of files(root)) {
    const stat = fs.statSync(file)
    const fileType = machOFileType(header(file))
    if (![2, 6, 8].includes(fileType)) continue
    // Signing may replace an inode. Detach package/cache hardlinks first so
    // every shipped pathname receives its own signature and host caches stay
    // untouched, then verify all paths again after the final signing pass.
    if (stat.nlink > 1) {
      const copy = `${file}.signing-${process.pid}`
      fs.copyFileSync(file, copy)
      fs.chmodSync(copy, stat.mode)
      fs.renameSync(copy, file)
      detachedHardlinks++
    }
    const args = ['--force', '--sign', identity, '--options', 'runtime', '--timestamp']
    // Entitlements belong to executables, never extension modules or dylibs.
    if (fileType === 2) { args.push('--entitlements', entitlements); executables++ }
    run('codesign', [...args, file])
    run('codesign', ['--verify', '--strict', file])
    nativeFiles.push(file)
    signed++
  }
  for (const file of nativeFiles) run('codesign', ['--verify', '--strict', file])
  if (!signed || !executables) throw new Error('Mac runtime payload has no signed native executables')
  return { identity, macho_files: signed, executables, detached_hardlinks: detachedHardlinks, hardened_runtime: true }
}

export function notarizeMacRuntimePayload(root, outDir) {
  const key = process.env.APPLE_API_KEY
  const keyId = process.env.APPLE_API_KEY_ID
  const issuer = process.env.APPLE_API_ISSUER
  if (!key || !fs.existsSync(key) || !keyId || !issuer) {
    throw new Error('Mac runtime payload notarization requires the Apple API key file, key ID and issuer')
  }
  const zip = path.join(outDir, 'runtime-payload-notary.zip')
  const auth = ['--key', key, '--key-id', keyId, '--issuer', issuer]
  try {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', root, zip])
    const submission = JSON.parse(run('xcrun', [
      'notarytool', 'submit', zip, ...auth, '--wait', '--timeout', '30m', '--output-format', 'json'
    ], { capture: true }))
    const log = submission.id ? JSON.parse(run('xcrun', [
      'notarytool', 'log', submission.id, ...auth
    ], { capture: true })) : null
    fs.writeFileSync(path.join(outDir, 'runtime-payload-notary.json'), JSON.stringify({ submission, log }, null, 2) + '\n')
    if (submission.status !== 'Accepted' || !log || log.status !== 'Accepted' || (log.issues || []).length) {
      throw new Error(`Mac runtime payload notarization rejected: ${submission.status || 'missing status'}`)
    }
    // Bare CLI executables cannot be stapled. Acceptance and native Gatekeeper
    // assessment are separate gates, followed by the outer App's notarization.
    return { status: submission.status, submission_id: submission.id, issues: log.issues || [] }
  } finally {
    fs.rmSync(zip, { force: true })
  }
}

/** Reassess an Accepted payload without accepting a different file or signature. */
export async function verifyNotarizedMacExecutable(executable, notarization, {
  env = process.env,
  execute = spawnSync,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  onDiagnostic = () => {}
} = {}) {
  const timeout = 30000
  const receipt = { executable, accepted_submission: notarization?.submission_id, timeout_ms: timeout,
    verifier: '/usr/bin/codesign', requirement: ['--verify', '--strict', '-R=notarized', '--check-notarization'],
    attempts: [], status: 'failed' }
  const command = args => execute('/usr/bin/codesign', args, {
    env, encoding: 'utf8', shell: false, timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
  })
  const bytes = () => {
    const realpath = fs.realpathSync(executable)
    if (!fs.statSync(realpath).isFile()) throw new Error('Mac notarization target is not a regular file')
    return { realpath, sha256: createHash('sha256').update(fs.readFileSync(realpath)).digest('hex') }
  }
  const identity = () => {
    const before = bytes()
    receipt.observed_identity = before
    const strict = command(['--verify', '--strict', executable])
    if (strict.error || strict.status !== 0) {
      receipt.signature_failure = { exit: strict.status, error_code: strict.error?.code || null, stderr: String(strict.stderr || '').slice(0, 8192) }
      throw new Error(`Mac strict signature verification failed: ${strict.error?.code || strict.status}`)
    }
    const displayed = command(['--display', '--verbose=4', executable])
    const cdHash = `${displayed.stdout || ''}\n${displayed.stderr || ''}`.match(/^CDHash=([a-f\d]{40,64})$/im)?.[1]?.toLowerCase()
    if (displayed.error || displayed.status !== 0 || !cdHash) {
      receipt.signature_failure = { exit: displayed.status, error_code: displayed.error?.code || null, stderr: String(displayed.stderr || '').slice(0, 8192) }
      throw new Error('Mac signature CDHash could not be verified')
    }
    const after = bytes()
    receipt.observed_identity = { ...after, cdHash }
    if (before.realpath !== after.realpath || before.sha256 !== after.sha256) {
      receipt.same_bytes = false
      throw new Error('Mac notarization executable bytes changed during signature verification')
    }
    return { ...after, cdHash }
  }
  const sameIdentity = (expected, actual) => {
    if (expected.realpath !== actual.realpath || expected.sha256 !== actual.sha256 || expected.cdHash !== actual.cdHash) {
      receipt.same_bytes = false
      receipt.observed_identity = actual
      throw new Error('Mac notarization executable bytes or signature changed')
    }
  }
  try {
    if (notarization?.status !== 'Accepted' || !notarization.submission_id || !Array.isArray(notarization.issues) || notarization.issues.length) {
      throw new Error('Mac executable assessment requires an Accepted submission with no issues')
    }
    const original = identity()
    Object.assign(receipt, original, { same_bytes: true })
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await wait(attempt === 2 ? 5000 : 15000)
      sameIdentity(original, identity())
      const started = Date.now()
      const result = command(['--verify', '--strict', '-R=notarized', '--check-notarization', executable])
      receipt.attempts.push({ attempt, started_at: new Date(started).toISOString(), duration_ms: Date.now() - started,
        exit: result.status, signal: result.signal || null,
        error_code: result.error?.code || null, stderr: String(result.stderr || '').slice(0, 8192) })
      if (result.error || !Number.isInteger(result.status)) throw new Error(`Mac notarization verifier did not complete: ${result.error?.code || result.signal || 'missing exit'}`)
      sameIdentity(original, identity())
      if (result.status === 0) {
        receipt.status = 'verified'
        return receipt
      }
      if (result.status !== 3 || !/code failed to satisfy specified code requirement/i.test(result.stderr || '')) {
        throw new Error(`Mac notarization verifier failed without a retryable requirement result (exit ${result.status})`)
      }
    }
    throw new Error(`Mac executable notarization failed after 3 assessments (exit ${receipt.attempts.at(-1).exit})`)
  } catch (error) {
    receipt.failure = error.message
    throw error
  } finally {
    onDiagnostic(receipt)
  }
}
