// Project locks choose the executable; APEX only adapts its project selector.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

export function hypitProjectArgs(args, cwd) {
  const options = [], tail = []
  let project
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { tail.push(...args.slice(i)); break }
    const flag = ['--workspace', '--project'].find(f => arg === f || arg.startsWith(f + '='))
    if (!flag) { options.push(arg); continue }
    const value = arg === flag ? args[++i] : arg.slice(flag.length + 1)
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a directory`)
    if (project) throw new Error('Specify only one --project or --workspace')
    project = path.resolve(cwd, value)
  }
  return { options, tail, project }
}

export function selectHypit({ root, cwd, args }) {
  const parsed = hypitProjectArgs(args, cwd)
  let project = parsed.project
  if (!project) {
    let directory = path.resolve(cwd)
    while (true) {
      const manifest = readJson(path.join(directory, 'package.json'))
      if (manifest?.hypit?.project || manifest?.dependencies?.['@hypit/hypit'] ||
          manifest?.devDependencies?.['@hypit/hypit'] || fs.existsSync(path.join(directory, '.hypit/apex-runtime.json')) ||
          fs.existsSync(path.join(directory, '.hypit/runtime'))) {
        project = directory; break
      }
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  const manifest = project && readJson(path.join(project, 'package.json'))
  const lock = project && readJson(path.join(project, 'package-lock.json'))
  const pinned = lock?.packages?.['node_modules/@hypit/hypit']?.version || lock?.dependencies?.['@hypit/hypit']?.version
  const declared = manifest?.dependencies?.['@hypit/hypit'] || manifest?.devDependencies?.['@hypit/hypit']
  const exactDeclared = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(declared || '') ? declared : undefined
  const expected = pinned || exactDeclared
  const local = project && path.join(project, 'node_modules/@hypit/hypit')
  const localPackage = local && readJson(path.join(local, 'package.json'))
  const bundled = path.join(root, '.runtime/hypit/node_modules/@hypit/hypit')
  const bundledPackage = readJson(path.join(bundled, 'package.json'))
  if (localPackage && expected && localPackage.version !== expected) {
    throw new Error('Hypit project installation differs from its lockfile or exact manifest version; restore the locked dependencies first')
  }
  if (!localPackage && (pinned || declared) && (pinned || declared) !== bundledPackage?.version) {
    throw new Error(`Hypit project requires ${pinned || declared}; restore its locked installation before running. APEX will not upgrade it automatically`)
  }
  const packageRoot = localPackage ? local : bundled
  const version = (localPackage || bundledPackage)?.version
  if (!/^0\.[23]\./.test(version || '')) throw new Error(`Unsupported Hypit version: ${version || 'missing'}`)
  const modern = version.startsWith('0.3.')
  const selector = project && path.join(project, '.hypit/runtime')
  const profilePath = selector && fs.existsSync(selector)
    ? path.resolve(project, fs.readFileSync(selector, 'utf8').trim())
    : project && path.join(project, '.hypit/apex-runtime.json')
  const oldProfile = profilePath && readJson(profilePath)
  if (modern && !localPackage && Object.values(oldProfile?.endpoints || {}).some(e =>
    ['@hypit/provider-hyperframes-local', '@hypit/provider-media-local'].includes(e.use))) {
    throw new Error('This project uses a Hypit 0.2 runtime. Keep its locked 0.2 installation or explicitly migrate a copy first')
  }
  const upstream = path.join(packageRoot, 'bin/hypit.mjs')
  const nativeModule = createRequire(path.join(packageRoot, 'package.json')).resolve('koffi')
  // Capture is an independent CLI module: no project selector is accepted.
  // Its paths are cwd-relative, so an explicit selector selects its cwd instead.
  const capture = parsed.options[0] === 'capture'
  const versionOnly = ['version', '--version', '-v'].includes(parsed.options[0])
  const forwarded = [...parsed.options, ...(!capture && !versionOnly && parsed.project ? [modern ? '--project' : '--workspace', project] : []), ...parsed.tail]
  return { project: project || path.resolve(cwd), version, upstream, nativeModule, args: forwarded,
    cwd: capture && parsed.project ? parsed.project : cwd }
}
