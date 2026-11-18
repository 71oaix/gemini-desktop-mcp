'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const patch=require('../src/desktop-patch.cjs');
const observer=require('../src/desktop-observer.cjs');

const ROOT=path.join(__dirname,'..');
function tempDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'gemini-patch-test-'));}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}
function hashFile(file){return sha256(fs.readFileSync(file));}
function posix(value){return value.split(path.sep).join('/');}
function walkFiles(dir,base=dir,out=[]){
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const full=path.join(dir,entry.name);
  if(entry.isDirectory())walkFiles(full,base,out);
  else out.push(posix(path.relative(base,full)));
 }
 return out.sort();
}
function tree(dir){const out={};for(const name of walkFiles(dir))out[name]=hashFile(path.join(dir,name));return out;}
async function packFixture(source,dest,fileLevel){
 const lib=await import('@electron/asar');
 const dirs=[],files=[];
 (function collect(directory){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
   const full=path.join(directory,entry.name);
   if(entry.isDirectory()){dirs.push(full);collect(full);}else files.push(full);
  }
 })(source);
 dirs.sort((a,b)=>{
  const da=path.relative(source,a).split(path.sep).length,db=path.relative(source,b).split(path.sep).length;
  return da-db||posix(path.relative(source,a)).localeCompare(posix(path.relative(source,b)));
 });
 files.sort((a,b)=>posix(path.relative(source,a)).localeCompare(posix(path.relative(source,b))));
 const options=fileLevel?{unpack:'{messages.json,fonts.css,icon.png,native.node,package.json}'}:{unpackDir:'assets',unpack:'package.json'};
 await lib.createPackageFromFiles(source,dest,[...dirs,...files],{},options);
}
async function makeFixture(options={}){
 const tmp=tempDir();
 const install=path.join(tmp,'install');
 const source=path.join(tmp,'app');
 const mainPath=options.mainPath||'main.js';
 const main=options.main||"'use strict';\nfunction Xs(l){let a=l.webContents;Vr(0);return a;}\nmodule.exports={Xs};\n";
 const preload=options.preload||"'use strict';\n// fixture preload\nwindow.fixturePreload=true;\n";
 const files={
  'package.json':JSON.stringify({name:'gemini-fixture',version:'1.16.0',main:mainPath}),
  [mainPath]:main,
  'other.txt':'packed fixture',
  'assets/fonts/fonts.css':'body{font-family:sans-serif}',
  'assets/icon.png':Buffer.from([137,80,78,71,0,1,2,3]),
  'src/_locales/en/messages.json':JSON.stringify({hello:'Hello'}),
  'src/native.node':Buffer.alloc(64,7)
 };
 if(options.includePreload!==false)files['src/preload.js']=preload;
 for(const [name,content] of Object.entries(files)){
  const full=path.join(source,...name.split('/'));
  fs.mkdirSync(path.dirname(full),{recursive:true});
  fs.writeFileSync(full,content);
 }
 const asarPath=path.join(install,'resources','app.asar');
 fs.mkdirSync(path.dirname(asarPath),{recursive:true});
 await packFixture(source,asarPath,options.fileLevel);
 fs.renameSync(`${asarPath}.unpacked`,path.join(install,'resources','app.asar.unpacked'));
 fs.writeFileSync(path.join(install,'Gemini.exe'),Buffer.from('fixture-exe'));
 fs.writeFileSync(path.join(install,'GeminiAppLauncher.exe'),Buffer.from('fixture-helper'));
 const baseline={
  appVersion:'1.16.0',mainSha256:sha256(Buffer.from(main)),
  preload:options.includePreload===false?undefined:{path:'src/preload.js',size:Buffer.byteLength(preload),sha256:sha256(Buffer.from(preload))},
  files:{}
 };
 const all=walkFiles(install);
 for(const name of all){
  const stat=fs.statSync(path.join(install,name));
  baseline.files[name]={size:stat.size,sha256:hashFile(path.join(install,name))};
 }
 const baselinePath=path.join(tmp,'baseline.json');
 fs.writeFileSync(baselinePath,JSON.stringify(baseline,null,2));
 return {tmp,install,source,asarPath,baseline,baselinePath,originalMain:main,originalPreload:preload};
}
function cleanup(tmp){fs.rmSync(tmp,{recursive:true,force:true});}

test('check verifies every baseline file, the main hash and the unpacked header set',async t=>{
 const fixture=await makeFixture();
 t.after(()=>cleanup(fixture.tmp));
 const report=await patch.check({installDir:fixture.install,baselinePath:fixture.baselinePath});
 assert.equal(report.ok,true,JSON.stringify(report.issues));
 assert.equal(report.fileCount,Object.keys(fixture.baseline.files).length);
 assert.equal(report.mainEntry,'main.js');
 assert.equal(report.unpackedCount,Object.keys(fixture.baseline.files).filter(name=>name.startsWith('resources/app.asar.unpacked/')).length);
 const wrongBaseline=JSON.parse(fs.readFileSync(fixture.baselinePath,'utf8'));
 wrongBaseline.files['resources/app.asar'].sha256='0'.repeat(64);
 const wrongPath=path.join(fixture.tmp,'wrong.json');
 fs.writeFileSync(wrongPath,JSON.stringify(wrongBaseline));
 const wrong=await patch.check({installDir:fixture.install,baselinePath:wrongPath});
 assert.equal(wrong.ok,false);
 assert.ok(wrong.issues.some(issue=>issue.code==='ASAR_SHA256'));
 assert.ok(wrong.issues.some(issue=>issue.code==='SHA256'&&issue.path==='resources/app.asar'));
});

test('build changes only staging, preserves unpacked bytes/flags and injects one fixed require',async t=>{
 const fixture=await makeFixture();
 t.after(()=>cleanup(fixture.tmp));
 const before=tree(fixture.install);
 const stateRoot=path.join(fixture.tmp,'state');
 const result=await patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot,readOnly:true});
 assert.equal(result.ok,true);
 assert.deepEqual(tree(fixture.install),before,'build must not modify the installation');
 assert.equal(result.readOnly,true);
 assert.equal(result.moduleDir,'gemini-work');
 const manifest=JSON.parse(fs.readFileSync(result.manifestPath,'utf8'));
 assert.equal(patch.PROTOCOL,2);
 assert.equal(require('../src/desktop-bridge.cjs').PROTOCOL,2);
 assert.equal(manifest.protocol,2);
 assert.equal(manifest.patchId,result.patchId);
 assert.equal(manifest.readOnly,true);
 assert.equal(manifest.original.asar.sha256,fixture.baseline.files['resources/app.asar'].sha256);
 assert.equal(manifest.patched.asar.sha256,result.asarSha256);
 assert.equal(manifest.original.main.sha256,fixture.baseline.mainSha256);
 assert.notEqual(manifest.patched.main.sha256,manifest.original.main.sha256);
 assert.match(manifest.patched.main.sha256,/^[0-9a-f]{64}$/);
 assert.equal(manifest.original.preload.path,'src/preload.js');
 assert.equal(manifest.original.preload.sha256,fixture.baseline.preload.sha256);
 assert.equal(manifest.patched.preload.prefixSha256,manifest.original.preload.sha256);
 assert.equal(manifest.patched.preload.appendedSha256,result.appendixSha256);
 assert.equal(manifest.patched.preload.sha256,result.preloadSha256);
 const patchedMainEntry=manifest.patched.files.find(file=>file.path==='main.js');
 assert.ok(patchedMainEntry);
 assert.match(patchedMainEntry.sha256,/^[0-9a-f]{64}$/);
 assert.ok(manifest.patched.files.some(file=>file.path==='gemini-work/desktop-bridge.cjs'&&/^[0-9a-f]{64}$/.test(file.sha256)));
 assert.ok(manifest.patched.files.some(file=>file.path==='gemini-work/desktop-observation.cjs'&&/^[0-9a-f]{64}$/.test(file.sha256)));
 const manifestPreload=manifest.patched.files.find(file=>file.path==='src/preload.js');
 assert.ok(manifestPreload);
 assert.equal(manifestPreload.sha256,manifest.patched.preload.sha256);
 assert.ok(manifest.bridgeSources.some(item=>item.path==='gemini-work/desktop-observation.cjs'));
 assert.equal(manifest.observer.protocol,1);
 assert.ok(manifest.patched.unpacked.every(file=>/^[0-9a-f]{64}$/.test(file.sha256)));
 assert.match(manifest.injection,/\.attach\(a,\{.*"readOnly":true/);
 assert.match(manifest.injection,/stateDir/);
 assert.ok(fs.existsSync(path.join(stateRoot,'desktop-backup','1.16.0','app.asar')));
 assert.equal(hashFile(path.join(stateRoot,'desktop-backup','1.16.0','app.asar')),manifest.original.asar.sha256);
 assert.ok(fs.existsSync(path.join(stateRoot,'desktop-backup','1.16.0','backup.json')));
 assert.ok(fs.existsSync(path.join(stateRoot,'desktop-backup','1.16.0','manifest.json')));
 const lib=await import('@electron/asar');
 lib.uncacheAll?.();
 const {header}=lib.getRawHeader(result.asarPath);
 const treeEntries=patch.walkEntries(header,'',[],[]);
 const entries=treeEntries.files;
 const byPath=new Map(entries.map(entry=>[entry.path,entry]));
 assert.ok(byPath.has('gemini-work/desktop-bridge.cjs'));
 assert.ok(byPath.has('gemini-work/desktop-page.cjs'));
 assert.ok(byPath.has('gemini-work/desktop-observation.cjs'));
 assert.equal(byPath.get('gemini-work/desktop-bridge.cjs').unpacked,false);
 assert.equal(byPath.get('gemini-work/desktop-page.cjs').unpacked,false);
 assert.equal(byPath.get('gemini-work/desktop-observation.cjs').unpacked,false);
 assert.equal(byPath.get('main.js').unpacked,false);
 assert.equal(byPath.get('src/preload.js').unpacked,false);
 const unpackedExpected=Object.keys(fixture.baseline.files).filter(name=>name.startsWith('resources/app.asar.unpacked/')).map(name=>name.slice('resources/app.asar.unpacked/'.length)).sort();
 const unpackedActual=entries.filter(entry=>entry.unpacked).map(entry=>entry.path).sort();
 assert.deepEqual(unpackedActual,unpackedExpected);
 const patchedMain=lib.extractFile(result.asarPath,'main.js').toString('utf8');
 assert.ok(patchedMain.includes(manifest.injection));
 assert.ok(!patchedMain.includes('let a=l.webContents;Vr(0);'));
 assert.equal(patchedMain.replace(manifest.injection,'let a=l.webContents;Vr(0);'),fixture.originalMain);
 const originalPreload=Buffer.from(fixture.originalPreload,'utf8');
 const patchedPreload=lib.extractFile(result.asarPath,'src/preload.js');
 assert.deepEqual(patchedPreload.subarray(0,originalPreload.length),originalPreload);
 assert.equal(sha256(patchedPreload.subarray(0,originalPreload.length)),manifest.original.preload.sha256);
 assert.equal(patchedPreload.subarray(originalPreload.length).toString('utf8'),observer.buildPreloadAppendix());
 assert.equal(sha256(patchedPreload),manifest.patched.preload.sha256);
 const bridgeFile=lib.extractFile(result.asarPath,'gemini-work/desktop-bridge.cjs');
 const pageFile=lib.extractFile(result.asarPath,'gemini-work/desktop-page.cjs');
 const observationFile=lib.extractFile(result.asarPath,'gemini-work/desktop-observation.cjs');
 assert.equal(sha256(bridgeFile),hashFile(path.join(ROOT,'src','desktop-bridge.cjs')));
 assert.equal(sha256(pageFile),hashFile(path.join(ROOT,'src','desktop-page.cjs')));
 assert.equal(sha256(observationFile),hashFile(path.join(ROOT,'src','desktop-observation.cjs')));
 for(const name of unpackedExpected){
  const staged=path.join(stateRoot,'desktop-build','app.asar.unpacked',...name.split('/'));
  const installed=path.join(fixture.install,'resources','app.asar.unpacked',...name.split('/'));
  assert.equal(hashFile(staged),hashFile(installed),name);
 }
 const second=await patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot,readOnly:true});
 assert.equal(second.asarSha256,result.asarSha256,'repeated builds must be byte-identical');
 assert.deepEqual(tree(fixture.install),before);
 const writable=await patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot,stagingDir:path.join(stateRoot,'desktop-build-writable'),readOnly:false});
 const writableManifest=JSON.parse(fs.readFileSync(writable.manifestPath,'utf8'));
 assert.equal(writableManifest.readOnly,false);
 assert.match(writableManifest.injection,/"readOnly":false/);
 assert.notEqual(writable.asarSha256,result.asarSha256);
});

function runInjection(injection,asarDir){
 let captured=null;
 const requireForMain=id=>id==='node:path'?path:{attach:(wc,options)=>{captured={wc,options};}};
 vm.runInNewContext(injection,{l:{webContents:{id:7}},Vr(){},__dirname:asarDir,require:requireForMain},{filename:'patched-main.js'});
 return captured;
}

test('injection resolves the packaged preload from the running main entry without an absolute install path',async t=>{
 const fixture=await makeFixture({mainPath:'src/main.js'});
 t.after(()=>cleanup(fixture.tmp));
 const stateRoot=path.join(fixture.tmp,'state');
 const result=await patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot,readOnly:true});
 const manifest=JSON.parse(fs.readFileSync(result.manifestPath,'utf8'));
 const injection=manifest.injection;
 assert.equal(manifest.original.main.path,'src/main.js');
 assert.ok(injection.includes('"preloadPath"'));
 assert.match(injection,/"preloadPath":require\("node:path"\)\.resolve\(__dirname,"preload\.js"\)/);
 assert.ok(!injection.includes(fixture.install),'the injection must not embed the install directory');
 assert.ok(!injection.includes(path.join('resources','app.asar')),'the injection must not embed a packaged absolute path');
 const asarDir=path.join(fixture.install,'resources','app.asar','src');
 const first=runInjection(injection,asarDir);
 assert.equal(first.wc.id,7);
 assert.equal(first.options.preloadPath,path.join(asarDir,'preload.js'));
 const movedDir=path.join(fixture.tmp,'moved-install','resources','app.asar','src');
 const moved=runInjection(injection,movedDir);
 assert.equal(moved.options.preloadPath,path.join(movedDir,'preload.js'));
 assert.notEqual(first.options.preloadPath,moved.options.preloadPath);
 assert.equal(first.options.stateDir,path.join(stateRoot,'desktop-v1'));
 assert.equal(first.options.readOnly,true);
});

test('build requires the original preload and never falls back to skipping it',async t=>{
 const missing=await makeFixture({includePreload:false});
 t.after(()=>cleanup(missing.tmp));
 await assert.rejects(
  ()=>patch.build({installDir:missing.install,baselinePath:missing.baselinePath,stateRoot:path.join(missing.tmp,'state')}),
  error=>error.code==='VERIFY_FAILED'&&/PRELOAD_MISSING/.test(error.message)
 );
 const fixture=await makeFixture();
 t.after(()=>cleanup(fixture.tmp));
 const noBaseline=JSON.parse(fs.readFileSync(fixture.baselinePath,'utf8'));
 delete noBaseline.preload;
 const noBaselinePath=path.join(fixture.tmp,'no-preload-baseline.json');
 fs.writeFileSync(noBaselinePath,JSON.stringify(noBaseline));
 assert.equal(patch.expectedPreload({}).sha256,patch.PRELOAD_SHA256);
 await assert.rejects(
  ()=>patch.build({installDir:fixture.install,baselinePath:noBaselinePath,stateRoot:path.join(fixture.tmp,'state')}),
  error=>error.code==='VERIFY_FAILED'&&/PRELOAD_SHA/.test(error.message)
 );
});

test('build preserves a file-level unpacked layout without adding directory flags',async t=>{
 const fixture=await makeFixture({fileLevel:true});
 t.after(()=>cleanup(fixture.tmp));
 const report=await patch.check({installDir:fixture.install,baselinePath:fixture.baselinePath});
 assert.equal(report.ok,true,JSON.stringify(report.issues));
 const stateRoot=path.join(fixture.tmp,'state');
 const result=await patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot,readOnly:true});
 assert.equal(result.ok,true);
 const lib=await import('@electron/asar');
 lib.uncacheAll?.();
 const {header}=lib.getRawHeader(result.asarPath);
 const parsed=patch.walkEntries(header,'',[],[]);
 const expected=Object.keys(fixture.baseline.files).filter(name=>name.startsWith('resources/app.asar.unpacked/')).map(name=>name.slice('resources/app.asar.unpacked/'.length)).sort();
 assert.deepEqual(parsed.files.filter(file=>file.unpacked).map(file=>file.path).sort(),expected);
 assert.deepEqual(parsed.dirs.filter(dir=>dir.unpacked).map(dir=>dir.path).sort(),[]);
});

test('build refuses a duplicate/missing anchor, wrong main hash and extra unpacked files',async t=>{
 const broken=await makeFixture({main:"'use strict';\nmodule.exports={Xs(){return 1;}};\n"});
 t.after(()=>cleanup(broken.tmp));
 const report=await patch.check({installDir:broken.install,baselinePath:broken.baselinePath});
 assert.equal(report.ok,false);
 assert.ok(report.issues.some(issue=>issue.code==='ANCHOR_COUNT'));
 await assert.rejects(()=>patch.build({installDir:broken.install,baselinePath:broken.baselinePath,stateRoot:path.join(broken.tmp,'state')}),error=>error.code==='VERIFY_FAILED');
 const fixture=await makeFixture();
 t.after(()=>cleanup(fixture.tmp));
 const wrongMain=JSON.parse(fs.readFileSync(fixture.baselinePath,'utf8'));
 wrongMain.mainSha256='f'.repeat(64);
 const wrongMainPath=path.join(fixture.tmp,'wrong-main.json');
 fs.writeFileSync(wrongMainPath,JSON.stringify(wrongMain));
 const mainCheck=await patch.check({installDir:fixture.install,baselinePath:wrongMainPath});
 assert.ok(mainCheck.issues.some(issue=>issue.code==='MAIN_SHA256'));
 fs.writeFileSync(path.join(fixture.install,'resources','app.asar.unpacked','assets','extra.txt'),'unexpected');
 const extra=await patch.check({installDir:fixture.install,baselinePath:fixture.baselinePath});
 assert.ok(extra.issues.some(issue=>issue.code==='UNPACKED_EXTRA'));
 await assert.rejects(()=>patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot:path.join(fixture.tmp,'state')}),error=>error.code==='VERIFY_FAILED');
});

test('install requires explicit confirmation and a closed-app assertion, then replaces only app.asar',async t=>{
 const fixture=await makeFixture();
 t.after(()=>cleanup(fixture.tmp));
 const stateRoot=path.join(fixture.tmp,'state');
 const built=await patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot,readOnly:true});
 const before=tree(fixture.install);
 await assert.rejects(()=>patch.install({installDir:fixture.install,stateRoot}),error=>error.code==='CONFIRM_REQUIRED');
 await assert.rejects(()=>patch.install({installDir:fixture.install,stateRoot,confirm:true}),error=>error.code==='PROCESS_CHECK_REQUIRED');
 await assert.rejects(()=>patch.install({installDir:fixture.install,stateRoot,confirm:true,isProcessRunning:async()=>true}),error=>error.code==='GEMINI_RUNNING');
 const installed=await patch.install({installDir:fixture.install,stateRoot,confirm:true,isProcessRunning:async()=>false});
 assert.equal(installed.status,'installed');
 assert.equal(hashFile(fixture.asarPath),built.asarSha256);
 const after=tree(fixture.install);
 assert.equal(after['resources/app.asar'],built.asarSha256);
 for(const name of Object.keys(before))if(name!=='resources/app.asar')assert.equal(after[name],before[name],name);
 assert.ok(!Object.keys(after).some(name=>name.includes('.tmp')));
 assert.ok(fs.existsSync(path.join(stateRoot,'desktop-backup','1.16.0','install.json')));
 const again=await patch.install({installDir:fixture.install,stateRoot,confirm:true,assertClosed:true});
 assert.equal(again.status,'already_installed');
 assert.equal(hashFile(fixture.asarPath),built.asarSha256);
});

test('rollback restores only the known patched hash and refuses unknown files',async t=>{
 const fixture=await makeFixture();
 t.after(()=>cleanup(fixture.tmp));
 const stateRoot=path.join(fixture.tmp,'state');
 const built=await patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot,readOnly:true});
 const original=fixture.baseline.files['resources/app.asar'].sha256;
 const before=tree(fixture.install);
 await patch.install({installDir:fixture.install,stateRoot,confirm:true,assertClosed:true});
 assert.equal(hashFile(fixture.asarPath),built.asarSha256);
 await assert.rejects(()=>patch.rollback({installDir:fixture.install,stateRoot}),error=>error.code==='CONFIRM_REQUIRED');
 await assert.rejects(()=>patch.rollback({installDir:fixture.install,stateRoot,confirm:true}),error=>error.code==='PROCESS_CHECK_REQUIRED');
 fs.writeFileSync(fixture.asarPath,Buffer.from('unknown modification'));
 await assert.rejects(()=>patch.rollback({installDir:fixture.install,stateRoot,confirm:true,assertClosed:true}),error=>error.code==='UNKNOWN_HASH');
 assert.equal(fs.readFileSync(fixture.asarPath).toString(),'unknown modification');
 fs.copyFileSync(path.join(stateRoot,'desktop-build','app.asar'),fixture.asarPath);
 const rolled=await patch.rollback({installDir:fixture.install,stateRoot,confirm:true,assertClosed:true});
 assert.equal(rolled.status,'rolled_back');
 assert.equal(hashFile(fixture.asarPath),original);
 assert.deepEqual(tree(fixture.install),before);
 const lib=await import('@electron/asar');
 lib.uncacheAll?.();
 const restoredPreload=lib.extractFile(fixture.asarPath,'src/preload.js');
 assert.equal(sha256(restoredPreload),sha256(Buffer.from(fixture.originalPreload,'utf8')));
 const again=await patch.rollback({installDir:fixture.install,stateRoot,confirm:true,assertClosed:true});
 assert.equal(again.status,'already_rolled_back');
 assert.ok(fs.existsSync(path.join(stateRoot,'desktop-backup','1.16.0','rollback.json')));
});

test('install refuses an unknown current asar hash and CLI parsing is explicit',async t=>{
 const fixture=await makeFixture();
 t.after(()=>cleanup(fixture.tmp));
 const stateRoot=path.join(fixture.tmp,'state');
 const built=await patch.build({installDir:fixture.install,baselinePath:fixture.baselinePath,stateRoot,readOnly:true});
 fs.writeFileSync(fixture.asarPath,Buffer.from('tampered before install'));
 await assert.rejects(()=>patch.install({installDir:fixture.install,stateRoot,confirm:true,assertClosed:true}),error=>error.code==='UNKNOWN_HASH');
 assert.equal(fs.readFileSync(fixture.asarPath).toString(),'tampered before install');
 fs.copyFileSync(path.join(stateRoot,'desktop-build','app.asar'),fixture.asarPath);
 assert.equal(hashFile(fixture.asarPath),built.asarSha256);
 const parsed=patch.parseArgs(['build','--install-dir','C:/Gemini','--writable','--staging','C:/state/build','--assert-closed']);
 assert.equal(parsed.readOnly,false);
 assert.equal(parsed.assertClosed,true);
 assert.equal(parsed.installDir,'C:/Gemini');
 const injected=patch.build?true:false;
 assert.equal(injected,true);
});

test('root CLI wrapper executes the patch entrypoint without an undefined run',async t=>{
 const fixture=await makeFixture();
 t.after(()=>cleanup(fixture.tmp));
 const wrapper=require('../desktop-patch.cjs');
 assert.equal(typeof wrapper.run,'function');
 const cli=spawnSync(process.execPath,[path.join(ROOT,'desktop-patch.cjs'),'check','--install-dir',fixture.install,'--baseline',fixture.baselinePath,'--json'],{encoding:'utf8',timeout:60000,cwd:ROOT});
 assert.equal(cli.status,0,cli.stderr);
 const value=JSON.parse(cli.stdout);
 assert.equal(value.ok,true,JSON.stringify(value.issues));
 assert.equal(value.status,'original');
});
