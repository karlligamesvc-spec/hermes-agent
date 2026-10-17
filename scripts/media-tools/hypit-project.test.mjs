import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { selectHypit, hypitProjectArgs } from '../../apex_overlay/hypit_project.mjs'

function json(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)) }
function installation(root, version) {
  const pkg = path.join(root, 'node_modules/@hypit/hypit')
  json(path.join(pkg, 'package.json'), { name: '@hypit/hypit', version })
  json(path.join(root, 'node_modules/koffi/package.json'), { name: 'koffi', main: 'index.js' })
  fs.writeFileSync(path.join(root, 'node_modules/koffi/index.js'), '')
}

test('project version and both selector forms route without changing caller arguments or locks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-hypit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const work = path.join(root, 'project with spaces')
  fs.mkdirSync(work)
  installation(path.join(root, '.runtime/hypit'), '0.3.1')
  const modern = selectHypit({ root, cwd: root, args: ['build', 'x.svrun', '--workspace', work] })
  assert.deepEqual(modern.args, ['build', 'x.svrun', '--project', work])
  assert.equal(modern.version, '0.3.1')
  const args = ['capture', 'run', 'capture.mjs', '--workspace='+work, '--', '--workspace', 'script-only']
  assert.deepEqual(selectHypit({root,cwd:root,args}).args,
    ['capture','run','capture.mjs','--','--workspace','script-only'])
  assert.equal(selectHypit({root,cwd:root,args}).cwd, work)
  json(path.join(work, 'package.json'), { dependencies: { '@hypit/hypit': '0.2.17' } })
  const lock = path.join(work, 'package-lock.json')
  json(lock, { packages: { 'node_modules/@hypit/hypit': { version: '0.2.17' } } })
  const bytes = fs.readFileSync(lock)
  assert.throws(() => selectHypit({ root, cwd: work, args: ['version'] }), /restore its locked installation/)
  installation(work, '0.2.17')
  for (const command of ['version','--version','-v']) {
    assert.deepEqual(selectHypit({root,cwd:work,args:[command]}).args,[command])
    assert.deepEqual(selectHypit({root,cwd:root,args:[command,'--workspace',work]}).args,[command])
  }
  const legacy = selectHypit({ root, cwd: work, args: ['runtime', 'up', '--project', work] })
  assert.equal(legacy.version, '0.2.17')
  assert.equal(legacy.upstream, path.join(work,'node_modules/@hypit/hypit/bin/hypit.mjs'))
  assert.deepEqual(legacy.args, ['runtime','up','--workspace',work])
  const legacyCapture = selectHypit({root,cwd:root,args:['capture','screenshot','page.html','--project',work]})
  assert.deepEqual(legacyCapture.args,['capture','screenshot','page.html'])
  assert.equal(legacyCapture.cwd,work)
  assert.deepEqual(fs.readFileSync(lock),bytes)
  installation(work, '0.3.1')
  assert.throws(() => selectHypit({root,cwd:work,args:['build','x']}), /differs from its lockfile/)
})

test('ambiguous selectors and inherited legacy profiles cannot silently choose the new runtime', t => {
  assert.throws(()=>hypitProjectArgs(['build','x','--workspace'],'/tmp'), /requires a directory/)
  assert.throws(()=>hypitProjectArgs(['--project=a','--workspace=b'],'/tmp'), /only one/)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-hypit-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  installation(path.join(root,'.runtime/hypit'),'0.3.1')
  const work = path.join(root,'project')
  json(path.join(work,'.hypit/apex-runtime.json'),{endpoints:{media:{use:'@hypit/provider-media-local'}}})
  assert.throws(()=>selectHypit({root,cwd:work,args:['build','x']}), /Hypit 0.2 runtime/)
  fs.renameSync(path.join(work,'.hypit/apex-runtime.json'), path.join(work,'custom.json'))
  fs.writeFileSync(path.join(work,'.hypit/runtime'),'custom.json')
  fs.mkdirSync(path.join(work,'nested'))
  assert.throws(()=>selectHypit({root,cwd:path.join(work,'nested'),args:['build','x']}), /Hypit 0.2 runtime/)
})
