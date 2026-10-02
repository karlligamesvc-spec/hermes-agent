"""Read-only package acceptance; never launches or installs APEX."""
import hashlib, json, pathlib, plistlib, re, subprocess, sys

ROOT = pathlib.Path('/Users/karl/projects/.wt/desktop-bundled-engine')
import argparse
READER_ROOT = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--root', type=pathlib.Path, required=True)
parser.add_argument('--expected-source', required=True)
args = parser.parse_args()
args.root = args.root.resolve()
assert args.root.parent == pathlib.Path('/private/tmp') and args.root.name.startswith('hc901-public042-'), 'private public042 output root required'
SHA = args.expected_source
assert re.fullmatch('[a-f0-9]{40}', SHA), 'requires final release SHA'
STAGE = args.root / 'packages'
PROOF = args.root / 'public-macos-static-proof.json'
NODE = r'''
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2],res=process.argv[3],sha=process.argv[4];
const asar=require(require.resolve('@electron/asar',{paths:[root]}));
const stamp=JSON.parse(fs.readFileSync(path.join(res,'install-stamp.json'),'utf8'));
const archive=path.join(res,'app.asar');
const pkg=JSON.parse(asar.extractFile(archive,'package.json').toString());
assert.equal(stamp.commit,sha);assert.equal(stamp.source,'ci');assert.equal(stamp.dirty,false);
assert.equal(pkg.version,'0.17.42');assert.equal(pkg.productName,'APEX');
assert.equal(pkg.apexnodes?.desktopTrial,undefined);
const entries=asar.listPackage(archive);
assert(entries.includes('/dist/index.html'));assert(entries.includes('/dist/electron-main.mjs'));
assert(fs.statSync(path.join(res,'native-deps')).isDirectory());
console.log(JSON.stringify({commit:stamp.commit,source:stamp.source,dirty:stamp.dirty,
version:pkg.version,productName:pkg.productName,asarEntries:entries.length,formal:true}));
'''

def digest(file):
    h=hashlib.sha256()
    with file.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

def command(args, log, *, stdin=None, required=True, timeout=90):
    r=subprocess.run([str(a) for a in args],input=stdin,text=True,capture_output=True,cwd=ROOT,timeout=timeout)
    log.write_text(r.stdout+'\n'+r.stderr);log.chmod(0o600)
    if required: assert r.returncode==0,(args,r.returncode,str(log))
    return {'exit':r.returncode,'log':str(log),'stdout':r.stdout,'stderr':r.stderr}

proof={'commit':SHA,'version':'0.17.42','scope':'Static anonymous public four-package readback only; no application launch, install, Runtime activation or publication writes.','packages':[]}
try:
    for arch in ('x64','arm64'):
        source=STAGE/('mac-'+arch);work=STAGE/'inspection'/('mac-'+arch);work.mkdir(parents=True,exist_ok=True)
        for extension in ('zip','dmg'):
            package=source/f'APEX-0.17.42-mac-{arch}.{extension}'
            assert package.is_file() and package.stat().st_size>0,str(package)
            item={'package':str(package),'arch':arch,'type':extension,'bytes':package.stat().st_size,'sha256':digest(package)}
            prefix=work/extension;prefix.mkdir(exist_ok=True);mounted=False
            try:
                if extension=='zip':
                    unpacked=prefix/'unpacked';unpacked.mkdir(exist_ok=True)
                    command(['/usr/bin/ditto','-x','-k',package,unpacked],prefix/'extract.log',timeout=180)
                    apps=list(unpacked.glob('*.app'))
                else:
                    mount=prefix/'mount';mount.mkdir(exist_ok=True)
                    command(['/usr/bin/hdiutil','attach','-readonly','-nobrowse','-mountpoint',mount,package],prefix/'mount.log',timeout=120)
                    mounted=True;apps=list(mount.glob('*.app'))
                assert len(apps)==1,apps
                app=apps[0];res=app/'Contents/Resources'
                plist=plistlib.loads((app/'Contents/Info.plist').read_bytes())
                assert plist['CFBundleShortVersionString']=='0.17.42' and plist['CFBundleVersion']=='0.17.42'
                assert plist['CFBundleIdentifier']=='com.apexnodes.desktop'
                item['app']=str(app);item['bundle']={k:plist[k] for k in ('CFBundleShortVersionString','CFBundleVersion','CFBundleIdentifier')}
                item['resource_identity']=json.loads(command(['/Users/karl/.local/bin/node','-',ROOT,res,SHA],prefix/'resources.log',stdin=NODE)['stdout'])
                command(['/Users/karl/.local/bin/node',ROOT/'apps/desktop/scripts/assert-updater-deps.cjs',res],prefix/'updater.log')
                item['renderer_acceptance']=json.loads(command(['/Users/karl/.local/bin/node',READER_ROOT/'renderer-static-readback.mjs',ROOT,res/'app.asar'],prefix/'renderer.log')['stdout'])
                item['independent_engine']=json.loads(command(['/Users/karl/projects/hermes-cloud/.venv/bin/python','-B',READER_ROOT/'engine-static-readback.py',res,'mac',arch,'--expected-source',SHA],prefix/'independent-engine.log',timeout=300)['stdout'])
                item['bundled_engine']=json.loads(command(['/Users/karl/.local/bin/node',ROOT/'apps/desktop/scripts/bundled-runtime-package.mjs','assert',res,'darwin',arch],prefix/'bundled-engine.log',timeout=300)['stdout'])
                item['architecture']=json.loads(command(['/Users/karl/.local/bin/node',ROOT/'apps/desktop/scripts/assert-macos-package-arch.mjs',app,arch],prefix/'architecture.log')['stdout'])
                command(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',app],prefix/'signature-verify.log')
                identity=command(['/usr/bin/codesign','-dv','--verbose=4',app],prefix/'signature-identity.log')['stderr']
                assert 'TeamIdentifier=Q3S52NJ72G' in identity and 'Developer ID Application:' in identity
                cdhash=re.search(r'^CDHash=(\w+)$',identity,re.M);assert cdhash
                item['signature']={'team':'Q3S52NJ72G','cdhash':cdhash.group(1),'deep_strict_passed':True}
                gatekeeper=command(['/usr/sbin/spctl','--assess','--type','execute','--verbose=4',app],prefix/'gatekeeper.log')
                assert 'source=Notarized Developer ID' in gatekeeper['stderr']
                command(['/usr/bin/xcrun','stapler','validate',app],prefix/'notary-ticket.log')
                item['app_gatekeeper_notarized']=True;item['app_stapled_ticket_valid']=True
                item['identity_file_hashes']={str(p.relative_to(app)):digest(p) for p in [app/'Contents/Info.plist',res/'app.asar',res/'install-stamp.json',app/'Contents/MacOS/APEX']}
                if extension=='dmg':
                    item['container_signature']=command(['/usr/bin/codesign','-dv','--verbose=2',package],prefix/'container-signature.log',required=False)
                    item['container_ticket']=command(['/usr/bin/xcrun','stapler','validate',package],prefix/'container-ticket.log',required=False)
                item['passed']=True
            finally:
                if mounted: item['detach']=command(['/usr/bin/hdiutil','detach',mount],prefix/'detach.log')
            proof['packages'].append(item)
            PROOF.write_text(json.dumps(proof,indent=2)+'\n');PROOF.chmod(0o600)
            print(json.dumps({'arch':arch,'package_type':extension,'source':SHA,'identity_and_app_signature_passed':True}),flush=True)
        pair=proof['packages'][-2:]
        assert pair[0]['identity_file_hashes']==pair[1]['identity_file_hashes']
        assert pair[0]['signature']['cdhash']==pair[1]['signature']['cdhash']
    proof['all_four_passed']=True;proof['zip_dmg_same_inner_identity_each_arch']=True
except BaseException as exc:
    proof['failure']=repr(exc);raise
finally:
    PROOF.write_text(json.dumps(proof,indent=2)+'\n');PROOF.chmod(0o600)
