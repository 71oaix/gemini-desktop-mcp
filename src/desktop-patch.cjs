'use strict';
// Build, install and roll back the desktop bridge patch for the fixed
// Gemini 1.16.0 package. Nothing here writes to the installation unless
// install()/rollback() is called explicitly with confirm and a closed-app
// assertion.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const observer=require('./desktop-observer.cjs');

const ROOT=path.dirname(__dirname);
const BASELINE_PATH=path.join(ROOT,'desktop-baseline.json');
const DEFAULT_STATE_ROOT=path.join(ROOT,'state');
// Protocol 2 describes the phase-1 observation manifest. The legacy bridge
// handshake intentionally stays at protocol 1 until the caller wiring lands.
const PROTOCOL=2;
const BRIDGE_VERSION='1.0.0';
const PRELOAD_PATH='src/preload.js';
const PRELOAD_SHA256='8a733a4222db9a87667594e1bce6202eef09d4b808b038336d5c2132a0102d56';
const ANCHOR='let a=l.webContents;Vr(0);';
const BACKGROUND_ANCHOR='icon:Bu(),show:!0,titleBarStyle:';
const BACKGROUND_PATCH='icon:Bu(),show:process.env.GEMINI_WORK_BACKGROUND!=="1",titleBarStyle:';
const BRIDGE_FILES=[
 {name:'desktop-bridge.cjs',source:path.join(__dirname,'desktop-bridge.cjs')},
 {name:'desktop-page.cjs',source:path.join(__dirname,'desktop-page.cjs')},
 {name:'desktop-model-policy.cjs',source:path.join(__dirname,'desktop-model-policy.cjs')},
 {name:'desktop-observation.cjs',source:path.join(__dirname,'desktop-observation.cjs')},
 {name:'desktop-events.cjs',source:path.join(__dirname,'desktop-events.cjs')},
 {name:'desktop-machine.cjs',source:path.join(__dirname,'desktop-machine.cjs')}
];

function PatchError(code,message){const error=new Error(message||code);error.code=code;return error;}
function sha256(buffer){return crypto.createHash('sha256').update(buffer).digest('hex');}
function hashFile(file){return sha256(fs.readFileSync(file));}
function posix(value){return value.split(path.sep).join('/');}
function normalizeInstallDir(value){return path.resolve(String(value||''));}
function isInside(parent,child){const rel=path.relative(parent,child);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);}
function samePath(a,b){return process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);}
function writeJsonAtomic(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const temp=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
 let fd;
 try{
  fd=fs.openSync(temp,'wx',0o600);
  fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');
  fs.fsyncSync(fd);
 }finally{if(fd!==undefined)fs.closeSync(fd);}
 fs.renameSync(temp,file);
}
function copyFileAtomic(source,target){
 fs.mkdirSync(path.dirname(target),{recursive:true});
 const temp=`${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
 let fd;
 try{
  fd=fs.openSync(temp,'w',0o600);
  fs.writeFileSync(fd,fs.readFileSync(source));
  fs.fsyncSync(fd);
 }finally{if(fd!==undefined)fs.closeSync(fd);}
 fs.renameSync(temp,target);
}
let asarPromise=null;
async function asar(){
 if(!asarPromise)asarPromise=import('@electron/asar');
 return asarPromise;
}
async function uncache(file){try{const lib=await asar();if(typeof lib.uncache==='function')lib.uncache(file);else if(typeof lib.uncacheAll==='function')lib.uncacheAll();}catch{}}
function loadBaseline(file){
 let value;
 try{value=JSON.parse(fs.readFileSync(file||BASELINE_PATH,'utf8'));}
 catch(error){throw PatchError('BASELINE_MISSING','无法读取基线：'+(error.message||error));}
 if(!value||typeof value!=='object'||!value.files||typeof value.files!=='object')throw PatchError('BASELINE_INVALID','基线格式无效');
 return value;
}
function baselineFiles(baseline){return Object.keys(baseline.files).sort();}
function unpackedFromBaseline(baseline){
 return baselineFiles(baseline).filter(rel=>rel.startsWith('resources/app.asar.unpacked/')).map(rel=>({path:rel.slice('resources/app.asar.unpacked/'.length),size:baseline.files[rel].size,sha256:baseline.files[rel].sha256}));
}
function expectedPreload(baseline){
 let candidate=baseline&&baseline.preload&&typeof baseline.preload==='object'?baseline.preload:null;
 if(!candidate&&baseline&&baseline.files&&typeof baseline.files==='object'){
  for(const key of [PRELOAD_PATH,`resources/app.asar/${PRELOAD_PATH}`,`app.asar/${PRELOAD_PATH}`]){
   if(baseline.files[key]&&typeof baseline.files[key]==='object'){candidate={path:PRELOAD_PATH,size:baseline.files[key].size,sha256:baseline.files[key].sha256};break;}
  }
 }
 const source=candidate||{path:PRELOAD_PATH,sha256:PRELOAD_SHA256,size:null};
 const preloadPath=typeof source.path==='string'&&source.path?source.path:PRELOAD_PATH;
 if(preloadPath!==PRELOAD_PATH)throw PatchError('PRELOAD_PATH','只允许修补 '+PRELOAD_PATH);
 if(typeof source.sha256!=='string'||!/^[0-9a-f]{64}$/.test(source.sha256))throw PatchError('PRELOAD_BASELINE','preload 基线哈希无效');
 if(source.size!==null&&source.size!==undefined&&(!Number.isInteger(source.size)||source.size<0))throw PatchError('PRELOAD_BASELINE','preload 基线大小无效');
 return {path:preloadPath,sha256:source.sha256,size:source.size===undefined?null:source.size,trusted:!candidate};
}
function findPreloadEntry(info){
 return info.files.find(file=>posix(file.path)===PRELOAD_PATH)||null;
}
async function readOriginalPreload(info,baseline){
 const expected=expectedPreload(baseline);
 const entry=findPreloadEntry(info);
 if(!entry)throw PatchError('PRELOAD_MISSING','app.asar 中未找到 '+PRELOAD_PATH);
 if(entry.unpacked)throw PatchError('PRELOAD_UNPACKED',PRELOAD_PATH+' 位于 unpacked 区，无法只替换 app.asar');
 if(entry.link)throw PatchError('PRELOAD_LINK',PRELOAD_PATH+' 是链接，拒绝修补');
 const lib=await asar();
 await uncache(info.asarPath);
 let buffer;
 try{buffer=lib.extractFile(info.asarPath,PRELOAD_PATH);}
 catch(error){throw PatchError('PRELOAD_READ','无法读取 '+PRELOAD_PATH+'：'+(error.message||error));}
 const actual=sha256(buffer);
 if(actual!==expected.sha256)throw PatchError('PRELOAD_SHA',`${PRELOAD_PATH} 哈希与基线不一致（期望 ${expected.sha256}，实际 ${actual}）`);
 if(expected.size!==null&&buffer.length!==expected.size)throw PatchError('PRELOAD_SIZE',`${PRELOAD_PATH} 大小与基线不一致`);
 return {entry,buffer,sha256:actual,expected};
}
function walk(dir,base=dir,out=[]){
 let names=[];
 try{names=fs.readdirSync(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return out;throw error;}
 for(const entry of names){
  const full=path.join(dir,entry.name);
  if(entry.isDirectory())walk(full,base,out);
  else out.push(posix(path.relative(base,full)));
 }
 return out.sort();
}
function walkEntries(node,prefix,out,dirs){
 for(const [name,value] of Object.entries(node.files||{})){
  const rel=prefix?`${prefix}/${name}`:name;
  if(value.files){dirs.push({path:rel,unpacked:!!value.unpacked});walkEntries(value,rel,out,dirs);}
  else out.push({path:rel,size:value.size,unpacked:!!value.unpacked,executable:!!value.executable,link:value.link||null,offset:value.offset});
 }
 return {files:out,dirs};
}
function verifyBaseline(installDir,baseline){
 const issues=[];
 for(const rel of baselineFiles(baseline)){
  const expected=baseline.files[rel],full=path.join(installDir,rel);
  let stat;
  try{stat=fs.statSync(full);}catch{issues.push({code:'MISSING',path:rel});continue;}
  if(!stat.isFile()){issues.push({code:'NOT_FILE',path:rel});continue;}
  if(stat.size!==expected.size)issues.push({code:'SIZE',path:rel,expected:expected.size,actual:stat.size});
  const actual=hashFile(full);
  if(actual!==expected.sha256)issues.push({code:'SHA256',path:rel,expected:expected.sha256,actual});
 }
 return issues;
}
function verifyUnpackedDisk(installDir,expected){
 const root=path.join(installDir,'resources','app.asar.unpacked');
 const issues=[];
 const actual=walk(root);
 const expectedNames=expected.map(item=>posix(item.path)).sort();
 for(const name of expectedNames){
  const full=path.join(root,name);
  if(!fs.existsSync(full)){issues.push({code:'UNPACKED_MISSING',path:name});continue;}
  const item=expected.find(entry=>posix(entry.path)===name);
  const stat=fs.statSync(full);
  if(stat.size!==item.size)issues.push({code:'UNPACKED_SIZE',path:name,expected:item.size,actual:stat.size});
  const actualHash=hashFile(full);
  if(actualHash!==item.sha256)issues.push({code:'UNPACKED_SHA256',path:name,expected:item.sha256,actual:actualHash});
 }
 for(const name of actual)if(!expectedNames.includes(name))issues.push({code:'UNPACKED_EXTRA',path:name});
 return issues;
}
async function inspect(installDir,baseline){
 const asarPath=path.join(installDir,'resources','app.asar');
 if(!fs.existsSync(asarPath))throw PatchError('ASAR_MISSING','未找到 resources/app.asar');
 const lib=await asar();
 await uncache(asarPath);
 const raw=lib.getRawHeader(asarPath);
 const {files,dirs}=walkEntries(raw.header,'',[],[]);
 let packageJson;
 try{packageJson=JSON.parse(lib.extractFile(asarPath,'package.json').toString('utf8'));}catch(error){throw PatchError('PACKAGE_JSON_MISSING','无法读取 app.asar 内 package.json：'+(error.message||error));}
 const mainEntry=String(packageJson.main||'index.js').replace(/\\/g,'/').replace(/^\.\//,'');
 if(!mainEntry||mainEntry.startsWith('/')||mainEntry.split('/').includes('..'))throw PatchError('MAIN_INVALID','package.json main 路径无效');
 const mainBuffer=lib.extractFile(asarPath,mainEntry);
 return {asarPath,raw,header:raw.header,files,dirs,packageJson,mainEntry,mainBuffer,mainDir:path.posix.dirname(mainEntry),mainSha256:sha256(mainBuffer)};
}
async function check(options={}){
 if(!options.installDir)throw PatchError('INSTALL_DIR_REQUIRED','必须提供 --install-dir');
 const installDir=normalizeInstallDir(options.installDir);
 let baseline=loadBaseline(options.baselinePath);
 let installedPatch=null;
 if(!options.requireOriginal){
  try{
   const manifest=JSON.parse(fs.readFileSync(path.join(options.stateRoot||DEFAULT_STATE_ROOT,'desktop-backup',baseline.appVersion,'manifest.json'),'utf8'));
   const target=path.join(installDir,'resources','app.asar');
   if(samePath(manifest.installDir,installDir)&&manifest.original.asar.sha256===baseline.files['resources/app.asar'].sha256&&hashFile(target)===manifest.patched.asar.sha256){
    installedPatch=manifest;
    baseline={...baseline,mainSha256:manifest.patched.main.sha256,files:{...baseline.files,'resources/app.asar':manifest.patched.asar}};
   }
  }catch{}
 }
 const issues=verifyBaseline(installDir,baseline);
 let info=null;
 try{info=await inspect(installDir,baseline);}catch(error){issues.push({code:error.code||'ASAR',path:'resources/app.asar',message:error.message});}
 const expectedUnpacked=unpackedFromBaseline(baseline);
 const expectedAsar=baseline.files['resources/app.asar'];
 if(!expectedAsar)issues.push({code:'BASELINE_ASAR_MISSING',path:'resources/app.asar'});
 if(info){
  if(info.mainSha256!==baseline.mainSha256)issues.push({code:'MAIN_SHA256',expected:baseline.mainSha256,actual:info.mainSha256,path:info.mainEntry});
  const anchorCount=(info.mainBuffer.toString('utf8').match(new RegExp(ANCHOR.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
  if(anchorCount!==(installedPatch?0:1))issues.push({code:'ANCHOR_COUNT',expected:installedPatch?0:1,actual:anchorCount,path:info.mainEntry});
  const headerUnpacked=info.files.filter(file=>file.unpacked).map(file=>posix(file.path)).sort();
  const baselineUnpacked=expectedUnpacked.map(item=>posix(item.path)).sort();
  if(JSON.stringify(headerUnpacked)!==JSON.stringify(baselineUnpacked))issues.push({code:'UNPACKED_HEADER_SET',expected:baselineUnpacked,actual:headerUnpacked});
  if(info.files.some(file=>file.link))issues.push({code:'UNSUPPORTED_LINK',path:info.files.find(file=>file.link).path});
  if(expectedAsar){
   const asarSha=hashFile(info.asarPath);
   if(asarSha!==expectedAsar.sha256)issues.push({code:'ASAR_SHA256',path:'resources/app.asar',expected:expectedAsar.sha256,actual:asarSha});
  }
  if(!installedPatch){
   try{await readOriginalPreload(info,baseline);}
   catch(error){issues.push({code:error.code||'PRELOAD',path:PRELOAD_PATH,message:error.message});}
  }
 }
 issues.push(...verifyUnpackedDisk(installDir,expectedUnpacked));
 return {
  ok:issues.length===0,status:installedPatch?'patched':'original',patchId:installedPatch?.patchId||null,appVersion:baseline.appVersion,installDir,baselinePath:path.resolve(options.baselinePath||BASELINE_PATH),
  fileCount:baselineFiles(baseline).length,asarSha256:info?hashFile(info.asarPath):null,mainEntry:info?info.mainEntry:null,mainSha256:info?info.mainSha256:null,
  unpackedCount:expectedUnpacked.length,issues
 };
}
function unpackPatterns(info,expectedUnpacked){
 const allFiles=info.files.map(file=>posix(file.path));
 const unpackedFiles=new Set(expectedUnpacked.map(item=>posix(item.path)));
 const dirs=info.dirs.filter(dir=>dir.unpacked).map(dir=>posix(dir.path));
 const roots=[...new Set(dirs.map(name=>name.split('/')[0]))];
 const rootFiles=[...unpackedFiles].filter(name=>!name.includes('/')).map(name=>name.split('/').pop());
 if(roots.length){
  const covered=[...unpackedFiles].every(name=>!name.includes('/')||roots.includes(name.split('/')[0]));
  const over=allFiles.filter(name=>name.includes('/')&&roots.includes(name.split('/')[0])&&!unpackedFiles.has(name));
  if(covered&&over.length===0){
   for(const dir of roots)if(dir.includes(',')||dir.includes('{')||dir.includes('}'))throw PatchError('UNSUPPORTED_UNPACK_LAYOUT','unpacked 目录名含通配字符');
   for(const file of rootFiles)if(file.includes(',')||file.includes('{')||file.includes('}'))throw PatchError('UNSUPPORTED_UNPACK_LAYOUT','unpacked 文件名含通配字符');
   const unpackDir=roots.length===1?roots[0]:`{${roots.slice().sort().join(',')}}`;
   const unpack=rootFiles.length===0?undefined:rootFiles.length===1?rootFiles[0]:`{${rootFiles.slice().sort().join(',')}}`;
   return {unpackDir,unpack};
  }
 }
 // File-level unpack layout: match by unique basenames. matchBase is the only
 // cross-platform exact-enough primitive in @electron/asar 4.
 const groups=new Map();
 for(const name of allFiles){
  const base=name.split('/').pop();
  if(!groups.has(base))groups.set(base,[]);
  groups.get(base).push(name);
 }
 const patterns=[];
 for(const [base,names] of groups){
  const count=names.filter(name=>unpackedFiles.has(name)).length;
  if(!count)continue;
  if(count!==names.length)throw PatchError('UNSUPPORTED_UNPACK_LAYOUT','同名文件混有 packed/unpacked：'+base);
  if(!/^[A-Za-z0-9._@+-]+$/.test(base))throw PatchError('UNSUPPORTED_UNPACK_LAYOUT','unpacked 文件名含通配字符：'+base);
  patterns.push(base);
 }
 const predicted=new Set(allFiles.filter(name=>patterns.includes(name.split('/').pop())));
 if(predicted.size!==unpackedFiles.size||[...unpackedFiles].some(name=>!predicted.has(name)))throw PatchError('UNSUPPORTED_UNPACK_LAYOUT','无法用文件级 unpack 模式精确保留原布局');
 const unpack=patterns.length===1?patterns[0]:`{${patterns.slice().sort().join(',')}}`;
 return {unpackDir:undefined,unpack};
}
function buildInjection(config){
 // The preload is a known packaged file, but its absolute path depends on the
 // installation. Resolve it at runtime from the patched main module's own
 // __dirname so the injection carries no user-machine path and moves with the
 // installation. Both paths are relative to the app.asar root.
 const mainDir=typeof config.mainDir==='string'&&config.mainDir!=='.'?config.mainDir:'';
 const preloadRelative=path.posix.relative(mainDir,PRELOAD_PATH);
 const options=JSON.stringify({stateDir:config.stateDir,readOnly:config.readOnly,appVersion:config.appVersion,patchId:config.patchId,preloadPath:null})
  .replace('"preloadPath":null',`"preloadPath":require("node:path").resolve(__dirname,${JSON.stringify(preloadRelative)})`);
 return `let a=l.webContents;require(${JSON.stringify(config.requirePath)}).attach(a,${options});Vr(0);`;
}
function preserveExecutableMetadata(archive,originalFiles){
 const data=fs.readFileSync(archive),oldHeaderSize=data.readUInt32LE(4);
 const tree=JSON.parse(data.subarray(16,16+data.readUInt32LE(12)).toString());
 for(const entry of originalFiles){
  let node=tree;for(const part of posix(entry.path).split('/'))node=node.files[part];
  if(entry.executable)node.executable=true;else delete node.executable;
 }
 const json=Buffer.from(JSON.stringify(tree)),payloadSize=4+json.length;
 const header=Buffer.alloc(4+Math.ceil(payloadSize/4)*4);
 header.writeUInt32LE(header.length-4,0);header.writeUInt32LE(json.length,4);json.copy(header,8);
 const size=Buffer.alloc(8);size.writeUInt32LE(4,0);size.writeUInt32LE(header.length,4);
 fs.writeFileSync(archive,Buffer.concat([size,header,data.subarray(8+oldHeaderSize)]));
}
async function ensureBackup(stateRoot,baseline,asarPath){
 const backupDir=path.join(stateRoot,'desktop-backup',String(baseline.appVersion));
 fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
 const backupAsar=path.join(backupDir,'app.asar');
 const originalSha=hashFile(asarPath);
 if(fs.existsSync(backupAsar)){
  const current=hashFile(backupAsar);
  if(current!==originalSha)throw PatchError('BACKUP_CONFLICT',`备份 ${backupAsar} 与当前安装包不一致，拒绝覆盖`);
 }else copyFileAtomic(asarPath,backupAsar);
 const backupStat=fs.statSync(backupAsar);
 return {backupDir,backupAsar,size:backupStat.size,sha256:hashFile(backupAsar)};
}
async function build(options={}){
 if(!options.installDir)throw PatchError('INSTALL_DIR_REQUIRED','必须提供 --install-dir');
 const installDir=normalizeInstallDir(options.installDir);
 const stateRoot=path.resolve(options.stateRoot||DEFAULT_STATE_ROOT);
 const stagingDir=path.resolve(options.stagingDir||path.join(stateRoot,'desktop-build'));
 const bridgeStateDir=path.resolve(options.bridgeStateDir||path.join(stateRoot,'desktop-v1'));
 const baselinePath=path.resolve(options.baselinePath||BASELINE_PATH);
 if(isInside(installDir,stateRoot))throw PatchError('STATE_INSIDE_INSTALL','state 目录不能位于安装目录内');
 if(!isInside(stateRoot,stagingDir))throw PatchError('STAGING_OUTSIDE_STATE','staging 必须位于 state 目录内');
 if(samePath(stagingDir,installDir)||isInside(installDir,stagingDir))throw PatchError('STAGING_INSIDE_INSTALL','staging 不能位于安装目录内');
 const baseline=loadBaseline(baselinePath);
 const report=await check({installDir,baselinePath,requireOriginal:true});
 if(!report.ok)throw PatchError('VERIFY_FAILED','安装包与基线不一致：'+JSON.stringify(report.issues.slice(0,10)));
 const info=await inspect(installDir,baseline);
 const mainText=info.mainBuffer.toString('utf8');
 const anchorCount=(mainText.match(new RegExp(ANCHOR.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
 if(anchorCount!==1)throw PatchError('ANCHOR_COUNT','主进程锚点必须恰好出现一次，实际 '+anchorCount);
 const mainEntryFile=info.files.find(file=>posix(file.path)===info.mainEntry);
 if(!mainEntryFile)throw PatchError('MAIN_MISSING','asar 中未找到 '+info.mainEntry);
 if(mainEntryFile.unpacked)throw PatchError('MAIN_UNPACKED','main.js 位于 unpacked 区，无法只替换 app.asar');
 const preload=await readOriginalPreload(info,baseline);
 const appendix=observer.buildPreloadAppendix();
 const patchedPreload=Buffer.concat([preload.buffer,Buffer.from(appendix,'utf8')]);
 const moduleDirCandidate=info.mainDir==='.'?'gemini-work':`${info.mainDir}/gemini-work`;
 const ancestorUnpacked=info.dirs.some(dir=>dir.unpacked&&(moduleDirCandidate===posix(dir.path)||moduleDirCandidate.startsWith(posix(dir.path)+'/')));
 const moduleDir=ancestorUnpacked?'gemini-work':moduleDirCandidate;
 const relativeDir=path.posix.relative(info.mainDir==='.'?'':info.mainDir,moduleDir);
 const requirePath=(relativeDir.startsWith('.')?relativeDir:`./${relativeDir}`)+'/desktop-bridge.cjs';
 const readOnly=options.readOnly!==false;
 fs.rmSync(stagingDir,{recursive:true,force:true});
 fs.mkdirSync(stagingDir,{recursive:true,mode:0o700});
 const sourceDir=path.join(stagingDir,'src');
 await (await asar()).extractAll(info.asarPath,sourceDir);
 const extractedMain=path.join(sourceDir,...info.mainEntry.split('/'));
 if(hashFile(extractedMain)!==baseline.mainSha256)throw PatchError('EXTRACT_MAIN_MISMATCH','提取出的 main.js 与基线不一致');
 const bridgeHashes=BRIDGE_FILES.map(item=>({name:item.name,sha256:hashFile(item.source)}));
 const appendixSha256=sha256(Buffer.from(appendix,'utf8'));
 const patchedPreloadSha256=sha256(patchedPreload);
 const patchId=sha256(JSON.stringify({originalAsar:baseline.files['resources/app.asar'].sha256,readOnly,stateDir:bridgeStateDir,moduleDir,bridge:bridgeHashes,protocol:PROTOCOL,preload:{path:PRELOAD_PATH,sha256:preload.sha256,appendixSha256}})).slice(0,24);
 const injection=buildInjection({stateDir:bridgeStateDir,readOnly,appVersion:baseline.appVersion,patchId,requirePath,mainDir:info.mainDir});
 let patchedMain=mainText.replace(ANCHOR,injection);
 const backgroundCount=mainText.split(BACKGROUND_ANCHOR).length-1;
 if(backgroundCount===1)patchedMain=patchedMain.replace(BACKGROUND_ANCHOR,BACKGROUND_PATCH);
 else if(backgroundCount>1)throw PatchError('BACKGROUND_ANCHOR','后台窗口锚点不唯一');
 if((patchedMain.match(new RegExp(ANCHOR.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length!==0)throw PatchError('PATCH_LEFTOVER','替换后仍存在锚点');
 if(patchedMain.replace(injection,ANCHOR).replace(BACKGROUND_PATCH,BACKGROUND_ANCHOR)!==mainText)throw PatchError('PATCH_EXTRA_CHANGE','补丁修改了锚点以外的内容');
 fs.writeFileSync(extractedMain,patchedMain);
 const extractedPreload=path.join(sourceDir,...PRELOAD_PATH.split('/'));
 fs.writeFileSync(extractedPreload,patchedPreload);
 const writtenPreload=fs.readFileSync(extractedPreload);
 if(!writtenPreload.subarray(0,preload.buffer.length).equals(preload.buffer))throw PatchError('PRELOAD_PREFIX','preload 原始字节前缀被改变');
 if(!writtenPreload.subarray(preload.buffer.length).equals(Buffer.from(appendix,'utf8')))throw PatchError('PRELOAD_SUFFIX','preload 追加内容校验失败');
 if(sha256(writtenPreload)!==patchedPreloadSha256)throw PatchError('PRELOAD_PATCHED_SHA','preload 补丁哈希不一致');
 const modulePath=path.join(sourceDir,...moduleDir.split('/'));
 fs.mkdirSync(modulePath,{recursive:true,mode:0o700});
 for(const item of BRIDGE_FILES)fs.copyFileSync(item.source,path.join(modulePath,item.name));
 const expectedUnpacked=unpackedFromBaseline(baseline);
 const patterns=unpackPatterns(info,expectedUnpacked);
 const entries=[];
 function addTree(directory){
  for(const name of fs.readdirSync(directory,{withFileTypes:true})){
   const full=path.join(directory,name.name);
   if(name.isDirectory()){entries.push({full,type:'directory'});addTree(full);}
   else entries.push({full,type:'file'});
  }
 }
 addTree(sourceDir);
 const dirs=entries.filter(entry=>entry.type==='directory').sort((a,b)=>{
  const da=path.relative(sourceDir,a.full).split(path.sep).length,db=path.relative(sourceDir,b.full).split(path.sep).length;
  return da-db||posix(path.relative(sourceDir,a.full)).localeCompare(posix(path.relative(sourceDir,b.full)));
 });
 const files=entries.filter(entry=>entry.type==='file').sort((a,b)=>posix(path.relative(sourceDir,a.full)).localeCompare(posix(path.relative(sourceDir,b.full))));
 const ordered=[...dirs,...files].map(entry=>entry.full);
 const dest=path.join(stagingDir,'app.asar');
 fs.rmSync(`${dest}.unpacked`,{recursive:true,force:true});
 fs.rmSync(dest,{force:true});
 const packedStream=await (await asar()).createPackageFromFiles(sourceDir,dest,ordered,{},patterns);
 await require('node:stream/promises').finished(packedStream);
 preserveExecutableMetadata(dest,info.files);
 if(!fs.existsSync(dest))throw PatchError('PACK_FAILED','未生成 app.asar');
 await uncache(dest);
 const patchedRaw=(await asar()).getRawHeader(dest);
 const patchedTree=walkEntries(patchedRaw.header,'',[],[]);
 const patchedFiles=patchedTree.files;
 const patchedDirs=patchedTree.dirs;
 const newFiles=new Set(BRIDGE_FILES.map(item=>`${moduleDir}/${item.name}`));
 const originalPaths=new Set(info.files.map(file=>posix(file.path)));
 for(const file of info.files){
  const current=patchedFiles.find(entry=>posix(entry.path)===posix(file.path));
  if(!current)throw PatchError('PATCH_ENTRY_LOST','补丁后丢失条目 '+file.path);
  if(current.unpacked!==file.unpacked)throw PatchError('PATCH_UNPACKED_CHANGED','unpacked 标记变化：'+file.path);
  if(!!current.executable!==!!file.executable)throw PatchError('PATCH_EXECUTABLE_CHANGED','执行权限变化：'+file.path);
 }
 for(const file of patchedFiles)if(!originalPaths.has(posix(file.path))&&!newFiles.has(posix(file.path)))throw PatchError('PATCH_EXTRA_ENTRY','补丁后出现未知条目 '+file.path);
 const patchedDirMap=new Map(patchedDirs.map(dir=>[posix(dir.path),!!dir.unpacked]));
 for(const dir of info.dirs){
  const current=patchedDirMap.get(posix(dir.path));
  if(current!==undefined&&current!==!!dir.unpacked)throw PatchError('PATCH_DIR_UNPACKED_CHANGED','目录 unpacked 标记变化：'+dir.path);
 }
 const patchedUnpacked=patchedFiles.filter(file=>file.unpacked).map(file=>posix(file.path)).sort();
 const expectedNames=expectedUnpacked.map(item=>posix(item.path)).sort();
 if(JSON.stringify(patchedUnpacked)!==JSON.stringify(expectedNames))throw PatchError('PATCH_UNPACKED_SET','unpacked 条目未能精确保留',);
 const unpackedRoot=path.join(stagingDir,'app.asar.unpacked');
 const producedUnpacked=walk(unpackedRoot);
 for(const item of expectedUnpacked){
  const full=path.join(unpackedRoot,...posix(item.path).split('/'));
  if(!fs.existsSync(full))throw PatchError('PATCH_UNPACKED_MISSING','打包后缺少 unpacked 文件 '+item.path);
  if(hashFile(full)!==item.sha256)throw PatchError('PATCH_UNPACKED_SHA','unpacked 文件字节变化 '+item.path);
 }
 for(const name of producedUnpacked)if(!expectedNames.includes(name))throw PatchError('PATCH_UNPACKED_EXTRA','打包后出现未知 unpacked 文件 '+name);
 const patchedAsarSha=hashFile(dest);
 const patchedMainHash=hashFile(extractedMain);
 const patchedSize=fs.statSync(dest).size;
 const unpackedFiles=expectedUnpacked.map(item=>({path:posix(item.path),size:item.size,sha256:item.sha256}));
 const manifest={
  schema:1,patchId,createdAt:new Date().toISOString(),appVersion:baseline.appVersion,readOnly,protocol:PROTOCOL,bridgeVersion:BRIDGE_VERSION,
  installDir,stateDir:bridgeStateDir,
  original:{
   asar:{path:'resources/app.asar',size:baseline.files['resources/app.asar'].size,sha256:baseline.files['resources/app.asar'].sha256},
   main:{path:info.mainEntry,sha256:baseline.mainSha256},
   preload:{path:PRELOAD_PATH,size:preload.buffer.length,sha256:preload.sha256},
   files:baseline.files,unpacked:unpackedFiles
  },
  patched:{
   asar:{path:'resources/app.asar',size:patchedSize,sha256:patchedAsarSha},
   main:{path:info.mainEntry,sha256:patchedMainHash},
   preload:{path:PRELOAD_PATH,size:patchedPreload.length,sha256:patchedPreloadSha256,prefixSha256:preload.sha256,appendedSize:Buffer.byteLength(appendix,'utf8'),appendedSha256:appendixSha256},
   files:patchedFiles.map(file=>({path:posix(file.path),size:file.size,unpacked:!!file.unpacked,executable:!!file.executable})),unpacked:unpackedFiles
  },
  observer:{protocol:observer.OBSERVER_PROTOCOL,version:observer.OBSERVER_VERSION,preloadPath:PRELOAD_PATH,appendedSha256:appendixSha256,modulePath:`${moduleDir}/desktop-observation.cjs`},
  moduleDir,bridgeSources:BRIDGE_FILES.map(item=>({path:`${moduleDir}/${item.name}`,sha256:hashFile(item.source)})),anchor:ANCHOR,injection
 };
 // Fill packed file hashes by extracting the rebuilt archive for independent review.
 const patchedHashes=[];
 for(const file of patchedFiles){
  if(file.unpacked)continue;
  let digest=null;
  try{digest=sha256((await asar()).extractFile(dest,file.path));}catch{}
  patchedHashes.push({path:posix(file.path),size:file.size,sha256:digest,unpacked:false,executable:!!file.executable});
 }
 manifest.patched.files=patchedHashes.sort((a,b)=>a.path.localeCompare(b.path));
 const manifestPath=path.join(stagingDir,'manifest.json');
 writeJsonAtomic(manifestPath,manifest);
 const backup=await ensureBackup(stateRoot,baseline,info.asarPath);
 if(backup.sha256!==manifest.original.asar.sha256)throw PatchError('BACKUP_SHA','备份包校验失败');
 writeJsonAtomic(path.join(backup.backupDir,'backup.json'),{
  schema:1,appVersion:baseline.appVersion,installDir,createdAt:new Date().toISOString(),
  asar:{path:'app.asar',size:backup.size,sha256:backup.sha256},originalFiles:baseline.files,unpacked:unpackedFiles
 });
 writeJsonAtomic(path.join(backup.backupDir,'manifest.json'),manifest);
 return {ok:true,patchId,protocol:PROTOCOL,stagingDir,asarPath:dest,asarSha256:patchedAsarSha,mainSha256:patchedMainHash,preloadPath:PRELOAD_PATH,preloadSha256:patchedPreloadSha256,appendixSha256,manifestPath,backupDir:backup.backupDir,readOnly,moduleDir,injection,unpackedCount:unpackedFiles.length};
}
function requireProcessCheck(options){
 if(typeof options.isProcessRunning==='function')return options.isProcessRunning;
 if(options.assertClosed===true)return null;
 throw PatchError('PROCESS_CHECK_REQUIRED','必须提供进程检测函数或明确 assertClosed（CLI：--assert-closed）');
}
async function assertClosed(options){
 const checker=requireProcessCheck(options);
 if(!checker)return {checked:false,asserted:true};
 let running;
 try{running=await checker();}catch(error){throw PatchError('PROCESS_CHECK_FAILED','进程检测失败：'+(error.message||error));}
 if(running)throw PatchError('GEMINI_RUNNING','Gemini 仍在运行，拒绝替换安装包');
 return {checked:true,running:false};
}
async function replaceAsar(installDir,source,expectedSha){
 const resources=path.join(installDir,'resources');
 const target=path.join(resources,'app.asar');
 const temp=path.join(resources,`.app.asar.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
 let fd;
 try{
  fd=fs.openSync(temp,'w',0o600);
  fs.writeFileSync(fd,fs.readFileSync(source));
  fs.fsyncSync(fd);
 }finally{if(fd!==undefined)fs.closeSync(fd);}
 const staged=hashFile(temp);
 if(staged!==expectedSha){try{fs.unlinkSync(temp);}catch{}throw PatchError('STAGED_SHA','暂存文件校验失败');}
 fs.renameSync(temp,target);
 const actual=hashFile(target);
 if(actual!==expectedSha)throw PatchError('INSTALL_SHA','替换后 app.asar 校验失败');
}
async function install(options={}){
 if(!options.installDir)throw PatchError('INSTALL_DIR_REQUIRED','必须提供 --install-dir');
 const installDir=normalizeInstallDir(options.installDir);
 const stateRoot=path.resolve(options.stateRoot||DEFAULT_STATE_ROOT);
 const stagingDir=path.resolve(options.stagingDir||path.join(stateRoot,'desktop-build'));
 if(options.confirm!==true)throw PatchError('CONFIRM_REQUIRED','安装需要显式 confirm（CLI：--yes）');
 const manifestPath=path.join(stagingDir,'manifest.json');
 if(!fs.existsSync(manifestPath))throw PatchError('MANIFEST_MISSING','未找到 staging manifest：'+manifestPath);
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 if(!samePath(manifest.installDir,installDir))throw PatchError('INSTALL_DIR_MISMATCH','manifest 属于另一个安装目录');
 if(manifest.protocol!==PROTOCOL||manifest.bridgeVersion!==BRIDGE_VERSION)throw PatchError('MANIFEST_VERSION','manifest 协议版本不匹配');
 const stagedAsar=path.join(stagingDir,'app.asar');
 if(!fs.existsSync(stagedAsar))throw PatchError('STAGED_ASAR_MISSING','staging app.asar 不存在');
 if(hashFile(stagedAsar)!==manifest.patched.asar.sha256)throw PatchError('STAGED_SHA','staging app.asar 与 manifest 不一致');
 const target=path.join(installDir,'resources','app.asar');
 if(!fs.existsSync(target))throw PatchError('ASAR_MISSING','未找到 resources/app.asar');
 const current=hashFile(target);
 const backupDir=path.join(stateRoot,'desktop-backup',String(manifest.appVersion));
 const backupAsar=path.join(backupDir,'app.asar');
 if(current===manifest.patched.asar.sha256){
  if(!fs.existsSync(backupAsar))throw PatchError('BACKUP_MISSING','已安装但缺少备份');
  const installedFiles={...manifest.original.files,'resources/app.asar':{size:manifest.patched.asar.size,sha256:manifest.patched.asar.sha256}};
  const existing=verifyBaseline(installDir,{appVersion:manifest.appVersion,files:installedFiles,mainSha256:manifest.original.main.sha256});
  const unpackExisting=verifyUnpackedDisk(installDir,manifest.original.unpacked);
  if(existing.length||unpackExisting.length)throw PatchError('INSTALLED_TREE_CHANGED','已安装状态与非 asar 文件不一致：'+JSON.stringify([...existing,...unpackExisting].slice(0,10)));
  return {ok:true,status:'already_installed',appVersion:manifest.appVersion,asarSha256:current};
 }
 if(current!==manifest.original.asar.sha256)throw PatchError('UNKNOWN_HASH','当前 app.asar 哈希未知，拒绝安装');
 const baseline={appVersion:manifest.appVersion,files:manifest.original.files,mainSha256:manifest.original.main.sha256};
 const baseIssues=verifyBaseline(installDir,baseline);
 if(baseIssues.length)throw PatchError('VERIFY_FAILED','安装目录基线不一致：'+JSON.stringify(baseIssues.slice(0,10)));
 const unpackIssues=verifyUnpackedDisk(installDir,manifest.original.unpacked);
 if(unpackIssues.length)throw PatchError('UNPACKED_CHANGED','unpacked 资源与备份不一致：'+JSON.stringify(unpackIssues.slice(0,10)));
 if(!fs.existsSync(backupAsar)||hashFile(backupAsar)!==manifest.original.asar.sha256)throw PatchError('BACKUP_INVALID','备份包缺失或校验失败');
 const closed=await assertClosed(options);
 await replaceAsar(installDir,stagedAsar,manifest.patched.asar.sha256);
 const installedFiles={...manifest.original.files,'resources/app.asar':{size:manifest.patched.asar.size,sha256:manifest.patched.asar.sha256}};
 const afterBase=verifyBaseline(installDir,{appVersion:manifest.appVersion,files:installedFiles,mainSha256:manifest.original.main.sha256});
 const afterUnpacked=verifyUnpackedDisk(installDir,manifest.original.unpacked);
 if(afterBase.length||afterUnpacked.length){
  await replaceAsar(installDir,backupAsar,manifest.original.asar.sha256).catch(()=>{});
  throw PatchError('POST_VERIFY_FAILED','安装后校验失败，已尝试回滚：'+JSON.stringify([...afterBase,...afterUnpacked].slice(0,10)));
 }
 writeJsonAtomic(path.join(backupDir,'install.json'),{
  schema:1,appVersion:manifest.appVersion,patchId:manifest.patchId,installDir,installedAt:new Date().toISOString(),
  processCheck:closed,originalAsarSha256:manifest.original.asar.sha256,patchedAsarSha256:manifest.patched.asar.sha256
 });
 return {ok:true,status:'installed',appVersion:manifest.appVersion,patchId:manifest.patchId,asarSha256:manifest.patched.asar.sha256,backupDir};
}
async function rollback(options={}){
 if(!options.installDir)throw PatchError('INSTALL_DIR_REQUIRED','必须提供 --install-dir');
 const installDir=normalizeInstallDir(options.installDir);
 const stateRoot=path.resolve(options.stateRoot||DEFAULT_STATE_ROOT);
 if(options.confirm!==true)throw PatchError('CONFIRM_REQUIRED','回滚需要显式 confirm（CLI：--yes）');
 const backupRoot=path.join(stateRoot,'desktop-backup');
 const known=[];
 for(const version of fs.existsSync(backupRoot)?fs.readdirSync(backupRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name):[]){
  const manifestPath=path.join(backupRoot,version,'manifest.json');
  if(!fs.existsSync(manifestPath))continue;
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(samePath(manifest.installDir,installDir))known.push({version,manifest,dir:path.dirname(manifestPath)});
 }
 if(known.length!==1)throw PatchError('BACKUP_AMBIGUOUS','无法唯一定位该安装目录的备份，找到 '+known.length+' 个');
 const {manifest,dir}=known[0];
 const target=path.join(installDir,'resources','app.asar');
 if(!fs.existsSync(target))throw PatchError('ASAR_MISSING','未找到 resources/app.asar');
 const current=hashFile(target);
 const backupAsar=path.join(dir,'app.asar');
 if(!fs.existsSync(backupAsar))throw PatchError('BACKUP_MISSING','备份包缺失');
 if(hashFile(backupAsar)!==manifest.original.asar.sha256)throw PatchError('BACKUP_INVALID','备份包校验失败');
 if(current===manifest.original.asar.sha256)return {ok:true,status:'already_rolled_back',asarSha256:current};
 if(current!==manifest.patched.asar.sha256)throw PatchError('UNKNOWN_HASH','当前 app.asar 哈希未知，拒绝回滚');
 const baseline={appVersion:manifest.appVersion,files:manifest.original.files,mainSha256:manifest.original.main.sha256};
 const closed=await assertClosed(options);
 await replaceAsar(installDir,backupAsar,manifest.original.asar.sha256);
 const afterBase=verifyBaseline(installDir,baseline);
 const afterUnpacked=verifyUnpackedDisk(installDir,manifest.original.unpacked);
 if(afterBase.length||afterUnpacked.length)throw PatchError('ROLLBACK_VERIFY_FAILED','回滚后校验失败：'+JSON.stringify([...afterBase,...afterUnpacked].slice(0,10)));
 const recordPath=path.join(dir,'rollback.json');
 writeJsonAtomic(recordPath,{schema:1,appVersion:manifest.appVersion,patchId:manifest.patchId,installDir,rolledBackAt:new Date().toISOString(),processCheck:closed,restoredSha256:manifest.original.asar.sha256});
 return {ok:true,status:'rolled_back',appVersion:manifest.appVersion,asarSha256:manifest.original.asar.sha256,recordPath};
}
function parseArgs(argv){
 const out={_:[],readOnly:true};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg==='--install-dir')out.installDir=argv[++i];
  else if(arg==='--baseline')out.baselinePath=argv[++i];
  else if(arg==='--state-root')out.stateRoot=argv[++i];
  else if(arg==='--staging')out.stagingDir=argv[++i];
  else if(arg==='--bridge-state')out.bridgeStateDir=argv[++i];
  else if(arg==='--writable')out.readOnly=false;
  else if(arg==='--read-only')out.readOnly=true;
  else if(arg==='--yes')out.confirm=true;
  else if(arg==='--assert-closed')out.assertClosed=true;
  else if(arg==='--json')out.json=true;
  else if(!arg.startsWith('--'))out._.push(arg);
  else throw PatchError('UNKNOWN_ARG','未知参数 '+arg);
 }
 return out;
}
async function main(argv){
 const args=parseArgs(argv);
 const command=args._[0];
 if(!['check','build','install','rollback'].includes(command))throw PatchError('COMMAND_REQUIRED','用法：desktop-patch.cjs <check|build|install|rollback> --install-dir <dir> [options]');
 const options={...args};
 const result=command==='check'?await check(options):command==='build'?await build(options):command==='install'?await install(options):await rollback(options);
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
 return result;
}
async function run(argv=process.argv.slice(2)){
 try{
  const result=await main(argv);
  process.exitCode=result&&result.ok?0:1;
  return result;
 }catch(error){
  process.stderr.write(JSON.stringify({ok:false,code:error.code||'ERROR',message:error.message||String(error)},null,2)+'\n');
  process.exitCode=1;
  return null;
 }
}
if(require.main===module)run();
module.exports={run,main,check,build,install,rollback,parseArgs,ANCHOR,PROTOCOL,BRIDGE_VERSION,BASELINE_PATH,DEFAULT_STATE_ROOT,PRELOAD_PATH,PRELOAD_SHA256,inspect,walkEntries,unpackPatterns,expectedPreload,readOriginalPreload};
