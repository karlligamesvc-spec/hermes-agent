import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIPO_ARCH = Object.freeze({ arm64: 'arm64', x64: 'x86_64' })

function walkFiles(root) {
  if (!existsSync(root)) return []

  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export function packageArchitectureTargets(appPath) {
  const macOSDir = join(appPath, 'Contents', 'MacOS')
  const appExecutables = existsSync(macOSDir)
    ? readdirSync(macOSDir)
        .map(name => join(macOSDir, name))
        .filter(path => statSync(path).isFile())
    : []

  if (appExecutables.length !== 1) {
    throw new Error(`Expected exactly one main app executable in ${macOSDir}, found ${appExecutables.length}`)
  }

  const binaryCandidates = walkFiles(join(appPath, 'Contents')).filter(path => {
    const mode = statSync(path).mode
    return (mode & 0o111) !== 0 || ['.node', '.dylib'].includes(extname(path))
  })

  return [...new Set([...appExecutables, ...binaryCandidates])]
}

export function parseLipoArchitectures(stdout) {
  return String(stdout).trim().split(/\s+/).filter(Boolean)
}

export function assertMacPackageArchitecture({ appPath, expectedArch, readArchitectures }) {
  const expectedLipoArch = LIPO_ARCH[expectedArch]
  if (!expectedLipoArch) {
    throw new Error(`Unsupported expected macOS architecture: ${expectedArch}`)
  }

  const inspect =
    readArchitectures ??
    (path => {
      const fileResult = spawnSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' })
      if (fileResult.status !== 0) {
        throw new Error(`file failed for ${path}: ${String(fileResult.stderr).trim()}`)
      }
      if (!String(fileResult.stdout).includes('Mach-O')) return null

      const result = spawnSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' })
      if (result.status !== 0) {
        throw new Error(`lipo failed for ${path}: ${String(result.stderr).trim()}`)
      }
      return parseLipoArchitectures(result.stdout)
    })

  const targets = packageArchitectureTargets(appPath)
  const mainExecutable = targets[0]
  const inspected = targets
    .map(path => ({ path, architectures: inspect(path) }))
    .filter(item => item.architectures !== null || item.path === mainExecutable)
  const mismatches = inspected.filter(item => {
    if (!Array.isArray(item.architectures) || !item.architectures.includes(expectedLipoArch)) {
      return true
    }
    const requiresSingleArchitecture =
      item.path === mainExecutable ||
      item.path.includes('/Contents/Frameworks/') ||
      item.path.endsWith('.node') ||
      basename(item.path) === 'spawn-helper'
    return requiresSingleArchitecture && item.architectures.length !== 1
  })

  if (mismatches.length > 0) {
    const details = mismatches
      .map(item => `${item.path}: ${item.architectures?.join(', ') || '<not Mach-O>'}`)
      .join('\n')
    throw new Error(`macOS package architecture mismatch; expected ${expectedLipoArch}:\n${details}`)
  }

  return { appPath, expectedArch, lipoArch: expectedLipoArch, inspected }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  try {
    const result = assertMacPackageArchitecture({
      appPath: process.argv[2],
      expectedArch: process.argv[3]
    })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
