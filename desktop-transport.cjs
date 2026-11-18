const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {openEventStream}=require('./desktop-stream.cjs');
const policy=require('./desktop-model-policy.cjs');
const APP_VERSION='1.16.0';
const PROTOCOL=2;
const DEFAULT_TIMEOUT_MS=8000;
// Server-side readiness wait is bounded at 15s; the RPC needs headroom.
const READY_TIMEOUT_MS=17000;
const MAX_RESPONSE_BYTES=32*1024*1024;
const SNAPSHOT_STATUSES=new Set(['connecting','submitting','generating','completed','partial','uncertain','needs_user_action','failed']);
const ID_PATTERN=/^[a-zA-Z0-9_-]{1,80}$/;
const CAPABILITY_STATUSES=new Set(['ready','busy','blocked','unavailable']);
const CAPABILITY_LIMITS=Object.freeze({models:40,selector:80,thinking:40});
const CONTROL_CHAR=/[\u0000-\u001F\u007F]/;
const GEMINI_URL=/^\/u\/\d+\/app(?:\/[a-zA-Z0-9_-]+)?\/?$|^\/app(?:\/[a-zA-Z0-9_-]+)?\/?$/;
const START_RETRY_CODES=new Set(['DESKTOP_RPC_REFUSED','DESKTOP_RPC_RESET','DESKTOP_RPC_TIMEOUT','DESKTOP_RPC_ERROR','DESKTOP_DISCOVERY_MISSING','DESKTOP_DISCOVERY_UNREADABLE','DESKTOP_DISCOVERY_INVALID']);
const STATE=path.resolve(process.env.GEMINI_WORK_STATE||path.join(__dirname,'state','desktop-v1'));

class DesktopError extends Error{
 constructor(code,message,cause){super(message);this.name='DesktopError';this.code=code;this.cause=cause;}
}
function errorCode(error){return error&&typeof error.code==='string'?error.code:'DESKTOP_ERROR';}
function redact(message,token){const text=String(message||'桌面桥请求失败');return token?text.split(token).join('[已隐藏]'):text;}
function isObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function normalizeProbeData(data){
 if(!isObject(data))throw new DesktopError('DESKTOP_PROTOCOL_INVALID','桌面桥 probe 返回格式错误');
 return {...data,readOnly:data.read_only===true||data.readOnly===true,pageReady:data.page?data.page.usable===true&&!data.page.fault:data.pageReady===true,transport:'desktop-loopback'};
}

function readDiscoveryFile(filename){
 let raw;
 try{raw=fs.readFileSync(filename,'utf8');}catch(e){
  if(e.code==='ENOENT')throw new DesktopError('DESKTOP_DISCOVERY_MISSING','未发现桌面桥 discovery.json；客户端可能未启动');
  throw new DesktopError('DESKTOP_DISCOVERY_UNREADABLE','无法读取桌面桥 discovery 文件',e);
 }
 let data;
 try{data=JSON.parse(raw);}catch(e){throw new DesktopError('DESKTOP_DISCOVERY_INVALID','桌面桥 discovery 文件不是有效 JSON',e);}
 if(!isObject(data))throw new DesktopError('DESKTOP_DISCOVERY_INVALID','桌面桥 discovery 内容格式错误');
 if(data.protocol!==PROTOCOL)throw new DesktopError('DESKTOP_PROTOCOL_MISMATCH',`桌面桥协议版本不受支持：需要 ${PROTOCOL}`);
 if(data.appVersion!==APP_VERSION)throw new DesktopError('DESKTOP_APP_VERSION_MISMATCH',`桌面客户端版本不是固定的 ${APP_VERSION}`);
 if(!Number.isInteger(data.port)||data.port<1||data.port>65535)throw new DesktopError('DESKTOP_DISCOVERY_INVALID','桌面桥端口无效');
 if(typeof data.token!=='string'||data.token.length<8||data.token.length>512||/[\r\n]/.test(data.token))throw new DesktopError('DESKTOP_DISCOVERY_INVALID','桌面桥认证信息无效');
 if(data.pid!==undefined&&(!Number.isInteger(data.pid)||data.pid<1))throw new DesktopError('DESKTOP_DISCOVERY_INVALID','桌面桥进程编号无效');
 return {
  protocol:data.protocol,port:data.port,token:data.token,pid:data.pid||null,
  appVersion:data.appVersion,
  bridgeVersion:typeof data.bridgeVersion==='string'?data.bridgeVersion:null,
  userDataPath:typeof data.userDataPath==='string'?data.userDataPath:null,
  runtimeVersions:isObject(data.runtimeVersions)?data.runtimeVersions:null,
  fingerprint:crypto.createHash('sha256').update(raw).digest('hex')
 };
}

function validateGeminiUrl(value){
 if(value===null||value===undefined)return null;
 let url;
 try{url=new URL(value);}catch{throw new DesktopError('DESKTOP_TASK_INVALID','conversation_url 不是有效 URL');}
 if(url.protocol!=='https:'||url.hostname!=='gemini.google.com'||!GEMINI_URL.test(url.pathname))throw new DesktopError('DESKTOP_TASK_INVALID','conversation_url 只允许 Gemini 聊天页面');
 return url.href;
}

function validateWire(task){
 if(!isObject(task))throw new DesktopError('DESKTOP_TASK_INVALID','桌面任务格式错误');
 if(typeof task.id!=='string'||!ID_PATTERN.test(task.id))throw new DesktopError('DESKTOP_TASK_INVALID','任务编号无效');
 if(typeof task.marker!=='string'||!/^\[[A-Za-z0-9][A-Za-z0-9._:-]{7,159}\]$/.test(task.marker))throw new DesktopError('DESKTOP_TASK_INVALID','任务标记无效');
 if(typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>120000)throw new DesktopError('DESKTOP_TASK_INVALID','任务 prompt 无效');
 if(!['review','work'].includes(task.purpose))throw new DesktopError('DESKTOP_TASK_INVALID','purpose 只能为 review 或 work');
 const model=task.model===undefined||task.model===null?policy.DEFAULT_MODEL:policy.normalizeModel(task.model);
 if(!model)throw new DesktopError('DESKTOP_TASK_INVALID','model 必须是有界的模型名、菜单标识或 hydrogen、flash、argon');
 const mode=task.mode===undefined||task.mode===null||task.mode==='auto'?null:task.mode;
 if(mode!==null&&mode!=='chat'&&mode!=='task')throw new DesktopError('DESKTOP_TASK_INVALID','mode 只能为 auto、chat 或 task');
 if(task.timeoutMs!==null&&task.timeoutMs!==undefined&&(!Number.isInteger(task.timeoutMs)||task.timeoutMs<20000||task.timeoutMs>1800000))throw new DesktopError('DESKTOP_TASK_INVALID','timeoutMs 超出允许范围');
 if(!Array.isArray(task.attachments)||task.attachments.length>10)throw new DesktopError('DESKTOP_TASK_INVALID','附件数量无效');
 let total=0;
 const attachments=task.attachments.map(item=>{
  if(!isObject(item))throw new DesktopError('DESKTOP_TASK_INVALID','附件格式错误');
  const name=item.name;
  if(typeof name!=='string'||!name||name.length>255||name!==path.basename(name)||/[\r\n]/.test(name)||path.extname(name).toLowerCase()!=='.txt')throw new DesktopError('DESKTOP_TASK_INVALID','附件只允许单个 .txt 文件名');
  if(item.mime!=='text/plain')throw new DesktopError('DESKTOP_TASK_INVALID','附件 MIME 必须为 text/plain');
  if(typeof item.base64!=='string'||!item.base64)throw new DesktopError('DESKTOP_TASK_INVALID','附件内容缺失');
  const bytes=Buffer.from(item.base64,'base64');
  if(bytes.length>10*1024*1024)throw new DesktopError('DESKTOP_TASK_INVALID','单个附件超过 10 MiB');
  total+=bytes.length;
  return {name,mime:'text/plain',base64:bytes.toString('base64')};
 });
 if(total>25*1024*1024)throw new DesktopError('DESKTOP_TASK_INVALID','附件总量超过 25 MiB');
 return {
  id:task.id,marker:task.marker,prompt:task.prompt,purpose:task.purpose,model,mode,
  conversation_url:validateGeminiUrl(task.conversation_url),timeoutMs:task.timeoutMs,attachments
 };
}

function normalizeSnapshot(data,expectedId){
 if(!isObject(data))throw new DesktopError('DESKTOP_PROTOCOL_INVALID','桌面桥返回的快照格式错误');
 if(typeof data.status!=='string'||!SNAPSHOT_STATUSES.has(data.status))throw new DesktopError('DESKTOP_PROTOCOL_INVALID',`桌面桥返回未知任务状态：${String(data.status).slice(0,40)}`);
 if(data.task_id!==undefined&&data.task_id!==expectedId)throw new DesktopError('DESKTOP_PROTOCOL_INVALID','桌面桥快照任务编号不匹配');
 const rawResult=isObject(data.result)?data.result:{};
 const text=key=>typeof rawResult[key]==='string'?rawResult[key]:null;
 // Policy fields are forwarded only when the bridge actually recorded them, so
 // an older snapshot cannot erase evidence already merged locally.
 const policyFields={};
 for(const key of ['requested_model','selected_model','actual_model','requested_mode','actual_mode','thinking_control','requested_thinking','thinking_level','policy_status','policy_code','fallback_reason','routing_warning']){
  if(rawResult[key]!==undefined)policyFields[key]=text(key);
 }
 for(const key of ['model_verified','thinking_verified','fallback_approved','policy_satisfied']){
  if(rawResult[key]!==undefined)policyFields[key]=rawResult[key]===true;
 }
 const result={
  answer:typeof rawResult.answer==='string'?rawResult.answer:'',
  answer_truncated:rawResult.answer_truncated===true,
  url:text('url'),
  model:text('model'),
  ...policyFields,
  complete:rawResult.complete===true,
  submission_confirmed:rawResult.submission_confirmed===true,
  submission_known:data.send_state?data.send_state!=='uncertain':typeof rawResult.submission_confirmed==='boolean',
  marker:text('marker'),
  beforeResponses:Number.isInteger(rawResult.beforeResponses)?rawResult.beforeResponses:null
 };
 let error=null;
 if(isObject(data.error))error={code:typeof data.error.code==='string'?data.error.code:'BRIDGE_ERROR',message:typeof data.error.message==='string'?data.error.message:''};
 return {task_id:data.task_id||expectedId,status:data.status,phase:typeof data.phase==='string'?data.phase:data.status,revision:Number.isSafeInteger(data.revision)?data.revision:0,metadata:isObject(data.metadata)?data.metadata:{},budget_exhausted:data.budget_exhausted===true,send_state:data.send_state||null,result,error};
}

function capabilityInvalid(message){return new DesktopError('DESKTOP_PROTOCOL_INVALID',message);}
function capabilityObservedAt(value){
 if(typeof value!=='string'||!value||!Number.isFinite(Date.parse(value)))throw capabilityInvalid('桌面桥返回的 observed_at 不是有效时间');
 return value;
}
// Selectors are accepted exactly as the bridge observed them: bounded and
// free of control characters, but never trimmed, sliced or otherwise rewritten.
function capabilitySelector(value){
 if(value===undefined||value===null)return null;
 if(typeof value!=='string'||!value||value.length>CAPABILITY_LIMITS.selector||CONTROL_CHAR.test(value))throw capabilityInvalid('桌面桥返回的模型 selector 无效');
 return value;
}
function capabilityModel(item,index){
 if(!isObject(item))throw capabilityInvalid(`桌面桥返回的模型选项 ${index} 不是对象`);
 if(typeof item.name!=='string'||!item.name)throw capabilityInvalid(`桌面桥返回的模型选项 ${index} 缺少名称`);
 return {
  id:typeof item.id==='string'?item.id:null,
  name:item.name,
  selector:capabilitySelector(item.selector),
  selected:item.selected===true,
  disabled:item.disabled===true,
  restricted:item.restricted===true,
  available:item.available===true,
  unavailable_reason:typeof item.unavailable_reason==='string'?item.unavailable_reason:null
 };
}
function capabilityLevel(item,index){
 if(!isObject(item))throw capabilityInvalid(`桌面桥返回的思考等级 ${index} 不是对象`);
 if(typeof item.label!=='string'||!item.label)throw capabilityInvalid(`桌面桥返回的思考等级 ${index} 缺少标签`);
 return {
  level:typeof item.level==='string'?item.level:null,
  label:item.label,
  selected:item.selected===true,
  disabled:item.disabled===true
 };
}

function normalizeCapabilities(data){
 if(!isObject(data))throw new DesktopError('DESKTOP_PROTOCOL_INVALID','桌面桥 capabilities 返回格式错误');
 if(!CAPABILITY_STATUSES.has(data.status))throw new DesktopError('DESKTOP_PROTOCOL_INVALID','桌面桥返回未知能力状态：'+String(data.status).slice(0,40));
 if(data.observed!==undefined&&typeof data.observed!=='boolean')throw capabilityInvalid('桌面桥 capabilities observed 标记无效');
 const ready=data.status==='ready';
 const observed=data.observed===true;
 if(ready){
  if(!observed)throw capabilityInvalid('ready 目录必须附带已观察标记');
  if(data.source!=='observed_menu')throw capabilityInvalid('ready 目录必须来自 observed_menu');
 }
 const observedAt=observed?capabilityObservedAt(data.observed_at):null;
 let models=[];
 if(ready){
  if(!Array.isArray(data.models)||data.models.length<1||data.models.length>CAPABILITY_LIMITS.models)throw capabilityInvalid(`ready 目录模型数量必须在 1–${CAPABILITY_LIMITS.models} 之间`);
  models=data.models.map(capabilityModel);
 }
 let thinkingStatus='unknown',levels=[];
 if(ready){
  if(!isObject(data.thinking))throw capabilityInvalid('ready 目录缺少思考观察');
  if(data.thinking.status==='observed'){
   if(!Array.isArray(data.thinking.levels)||data.thinking.levels.length<1||data.thinking.levels.length>CAPABILITY_LIMITS.thinking)throw capabilityInvalid(`观察到的思考选项数量必须在 1–${CAPABILITY_LIMITS.thinking} 之间`);
   thinkingStatus='observed';
   levels=data.thinking.levels.map(capabilityLevel);
  }else if(data.thinking.status==='not_exposed'||data.thinking.status==='unknown'){
   if(data.thinking.levels!==undefined&&(!Array.isArray(data.thinking.levels)||data.thinking.levels.length))throw capabilityInvalid('not_exposed 思考目录不能包含选项');
   thinkingStatus=data.thinking.status;
  }else{
   throw capabilityInvalid('ready 目录必须报告 observed 或 not_exposed 的思考状态');
  }
 }
 const modes=isObject(data.modes)?data.modes:{};
 return {
  status:data.status,
  observed,
  observed_at:observedAt,
  source:typeof data.source==='string'?data.source:null,
  reason:typeof data.reason==='string'?data.reason:null,
  models,
  modes:{
   current:['chat','task'].includes(modes.current)?modes.current:'unknown',
   supported:['chat','task'],
   source:'contract',
   immutable_after_start:true
  },
  thinking:{status:thinkingStatus,levels},
  default_model:typeof data.default_model==='string'?data.default_model:policy.DEFAULT_MODEL
 };
}

class DesktopTransport{
 constructor({stateDir=STATE,discoveryPath,timeoutMs=DEFAULT_TIMEOUT_MS,autoStart=process.env.GEMINI_WORK_NO_AUTOSTART!=='1',installationVerifier=null,sleep:sleepFn=null,now:clock=null}={}){
  this.stateDir=path.resolve(stateDir);
  this.discoveryPath=discoveryPath||path.join(this.stateDir,'discovery.json');
  this.timeoutMs=Math.max(250,Number(timeoutMs)||DEFAULT_TIMEOUT_MS);
  this.autoStart=!!autoStart;
  this._discovery=null;
  this._installation=null;
  this.installationVerifier=installationVerifier;
  this._verifiedFiles=new Map();
  this._sleep=typeof sleepFn==='function'?sleepFn:sleep;
  this._now=typeof clock==='function'?clock:Date.now;
 }

 discover(){
  const discovery=readDiscoveryFile(this.discoveryPath);
  this._discovery=discovery;
  return discovery;
 }

 describe(){
  try{
   const d=this.discover();
   return {discovered:true,valid:true,protocol:d.protocol,port:d.port,pid:d.pid,app_version:d.appVersion,bridge_version:d.bridgeVersion,user_data_configured:!!d.userDataPath,runtime_versions:d.runtimeVersions,fingerprint:d.fingerprint};
  }catch(e){
   return {discovered:false,valid:false,state:errorCode(e),message:e.message};
  }
 }

 async post(discovery,body,timeoutMs){
  const payload=Buffer.from(JSON.stringify(body));
  if(payload.length>40*1024*1024)throw new DesktopError('DESKTOP_REQUEST_TOO_LARGE','桌面桥请求过大');
  return new Promise((resolve,reject)=>{
   let settled=false,timedOut=false,timer=null;
   const finish=(error,value)=>{
    if(settled)return;settled=true;if(timer)clearTimeout(timer);
    if(error)reject(new DesktopError(error.code,redact(error.message,discovery.token),error.cause));else resolve(value);
   };
   const request=http.request({
    host:'127.0.0.1',port:discovery.port,path:'/rpc',method:'POST',agent:false,timeout:timeoutMs,
    headers:{
     Host:`127.0.0.1:${discovery.port}`,
     Authorization:`Bearer ${discovery.token}`,
     'Content-Type':'application/json',
     'Content-Length':payload.length
    }
   },response=>{
    const chunks=[];let size=0;
    response.on('data',chunk=>{
     size+=chunk.length;
     if(size>MAX_RESPONSE_BYTES){request.destroy(new DesktopError('DESKTOP_RESPONSE_TOO_LARGE','桌面桥响应超过大小上限'));return;}
     chunks.push(chunk);
    });
    response.on('aborted',()=>finish({code:'DESKTOP_RPC_RESET',message:'桌面桥连接中断'}));
    response.on('end',()=>{
     const text=Buffer.concat(chunks).toString('utf8');
     let parsed=null;
     try{parsed=JSON.parse(text);}catch{}
     if(!isObject(parsed))return finish({code:'DESKTOP_PROTOCOL_INVALID',message:'桌面桥响应不是有效 JSON'});
     if(parsed.ok===true)return finish(null,parsed.data===undefined?{}:parsed.data);
     const code=isObject(parsed.error)&&typeof parsed.error.code==='string'?parsed.error.code:`DESKTOP_HTTP_${response.statusCode}`;
     const message=isObject(parsed.error)&&typeof parsed.error.message==='string'?parsed.error.message:'桌面桥拒绝请求';
     finish({code,message});
    });
   });
   timer=setTimeout(()=>{timedOut=true;request.destroy();},timeoutMs+50);
   request.on('timeout',()=>{timedOut=true;request.destroy();});
   request.on('error',error=>{
    if(timedOut)return finish({code:'DESKTOP_RPC_TIMEOUT',message:'桌面桥请求超时；发送状态不明时只允许查询或恢复'});
    if(error instanceof DesktopError)return finish({code:error.code,message:error.message});
    const code=error.code==='ECONNREFUSED'?'DESKTOP_RPC_REFUSED':error.code==='ECONNRESET'?'DESKTOP_RPC_RESET':error.code==='EPIPE'?'DESKTOP_RPC_RESET':'DESKTOP_RPC_ERROR';
    finish({code,message:'无法连接桌面桥'});
   });
   request.end(payload);
  });
 }

 async rpc(op,payload={},options={}){
  const timeoutMs=Math.max(250,Number(options.timeoutMs)||this.timeoutMs);
  const installation=await this.checkedInstallation();
  if(!installation.patch?.ready)throw new DesktopError('DESKTOP_INSTALLATION_CHANGED',installation.patch?.message||'固定安装校验未通过');
  const discovery=this.discover();
  try{
   return await this.post(discovery,{op,...payload},timeoutMs);
  }catch(error){
   if(op==='execute')throw error;
   const retryable=new Set(['DESKTOP_RPC_REFUSED','DESKTOP_RPC_RESET','DESKTOP_RPC_TIMEOUT','DESKTOP_RPC_ERROR']).has(error.code);
   if(!retryable)throw error;
   let changed=false;
   try{changed=this.discover().fingerprint!==discovery.fingerprint;}catch{throw error;}
   if(!changed)throw error;
   return this.post(this.discover(),{op,...payload},timeoutMs);
  }
 }

 async probe(options={}){
  const data=await this.rpc('probe',{task:{}},options);
  const normalized=normalizeProbeData(data);
  const expected=this._installation?.patch?.patchId;
  if(expected&&data.patch_id!==expected)throw new DesktopError('DESKTOP_PATCH_HANDSHAKE_MISMATCH','运行中的桥接补丁与安装清单不一致');
  return normalized;
 }

 // Single bounded readiness RPC. The server waits for pushed state; the client
 // must allow more time than the 15s server wait. No polling loop is used.
 async awaitReady(options={}){
  const timeoutMs=Math.min(Math.max(Number(options.timeoutMs)||READY_TIMEOUT_MS,250),30000);
  const data=await this.rpc('ready',{}, {timeoutMs});
  const normalized=normalizeProbeData(data);
  const expected=this._installation?.patch?.patchId;
  if(expected&&data.patch_id!==expected)throw new DesktopError('DESKTOP_PATCH_HANDSHAKE_MISMATCH','运行中的桥接补丁与安装清单不一致');
  return {...normalized,warming:data.warming===true};
 }

 async execute(task,options={}){
  const wire=validateWire(task);
  const data=await this.rpc('execute',{task:wire},options);
  return normalizeSnapshot(data,wire.id);
 }

 // Live capability catalog. Every call re-verifies the fixed installation and
 // re-reads discovery; no port or menu sample is cached.
 async capabilities(options={}){
  return normalizeCapabilities(await this.rpc('capabilities',{},options));
 }

 async snapshot(taskId,options={}){
  if(typeof taskId!=='string'||!ID_PATTERN.test(taskId))throw new DesktopError('DESKTOP_TASK_INVALID','任务编号无效');
  return normalizeSnapshot(await this.rpc('snapshot',{task_id:taskId},options),taskId);
 }

 async recover(taskId,options={}){
  if(typeof taskId!=='string'||!ID_PATTERN.test(taskId))throw new DesktopError('DESKTOP_TASK_INVALID','任务编号无效');
  return normalizeSnapshot(await this.rpc('recover',{task_id:taskId},options),taskId);
 }

 async synchronize(options={}){
  const data=await this.rpc('sync',{},options);
  const snapshots=data?.snapshots??data?.tasks;
  if(!isObject(data)||typeof data.instance_id!=='string'||!Number.isSafeInteger(data.seq)||data.seq<0||!Array.isArray(snapshots))throw new DesktopError('DESKTOP_PROTOCOL_INVALID','事件同步快照格式错误');
  return {instance_id:data.instance_id,seq:data.seq,snapshots:snapshots.map(s=>normalizeSnapshot(s,s.task_id))};
 }

 async events({cursor,signal,onEvent}={}){
  const installation=await this.checkedInstallation();
  if(!installation.patch?.ready)throw new DesktopError('DESKTOP_INSTALLATION_CHANGED','事件连接前安装校验失败');
  return openEventStream({discovery:this.discover(),cursor,signal,onEvent});
 }

 async release(taskId,options={}){
  if(typeof taskId!=='string'||!ID_PATTERN.test(taskId))throw new DesktopError('DESKTOP_TASK_INVALID','任务编号无效');
  return this.rpc('release',{task_id:taskId},options);
 }

 installation(){

  const local=process.env.LOCALAPPDATA||'';
  const appDir=path.join(local,'Google','Gemini',`app-${APP_VERSION}`);
  const exe=path.join(appDir,'Gemini.exe');
  const result={appDir,exe,exists:fs.existsSync(exe),version:null,versionMatches:false,patch:{available:false,ready:false,state:'desktop_patch_missing',message:'桌面桥补丁检查接口不可用；未验证桌面安装'}};
  if(!result.exists){result.state='desktop_not_installed';return (this._installation=result);}
  try{
   const manifest=JSON.parse(fs.readFileSync(path.join(appDir,'resources','app.asar.unpacked','package.json'),'utf8'));
   result.version=typeof manifest.version==='string'?manifest.version:null;
   result.versionMatches=manifest.version===APP_VERSION;
  }catch{
   result.state='desktop_manifest_missing';
   return (this._installation=result);
  }
  if(!result.versionMatches){result.state='desktop_version_mismatch';return (this._installation=result);}
  result.state='desktop_patch_unchecked';
  return result;
 }

 async checkedInstallation(){
  if(this.installationVerifier){const value=await this.installationVerifier();this._installation=value;return value;}
  const installation=this.installation();
  try{
   const baseline=require('./desktop-baseline.json');
   const filename=path.join(__dirname,'state','desktop-backup',APP_VERSION,'manifest.json');
   const manifest=JSON.parse(fs.readFileSync(filename,'utf8'));
   if(manifest.appVersion!==APP_VERSION||manifest.protocol!==PROTOCOL||path.resolve(manifest.installDir).toLowerCase()!==path.resolve(installation.appDir).toLowerCase()||path.resolve(manifest.stateDir).toLowerCase()!==this.stateDir.toLowerCase())throw Error('补丁版本、安装位置或状态目录不匹配');
   for(const [relative,original] of Object.entries(baseline.files)){
    const expected=relative==='resources/app.asar'?manifest.patched.asar:original;
    if(!expected?.sha256)throw Error('补丁哈希缺失');
    const target=path.join(installation.appDir,relative),stat=fs.statSync(target);
    const fingerprint=[stat.size,stat.mtimeMs,stat.ctimeMs,expected.sha256].join(':');
    if(this._verifiedFiles.get(target)!==fingerprint){
     if(stat.size!==expected.size||crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==expected.sha256)throw Error('固定安装文件已变化：'+relative);
     this._verifiedFiles.set(target,fingerprint);
    }
   }
   installation.patch={ready:true,checked:true,patchId:manifest.patchId,readOnly:manifest.readOnly,state:'ready'};
   installation.state='ready';
  }catch(error){installation.patch={ready:false,checked:true,state:'desktop_installation_changed',message:error.message};installation.state=installation.patch.state;}
  this._installation=installation;
  return installation;
 }

 async waitForBridge(options={}){
  const timeoutMs=Math.min(Math.max(Number(options.timeoutMs)||1200,250),5000);
  const startTimeoutMs=Math.min(Math.max(Number(options.startTimeoutMs)||20000,3000),30000);
  const deadline=this._now()+startTimeoutMs;
  const maxAttempts=Math.max(1,Math.ceil(startTimeoutMs/500));
  let error=options.initialError||null;
  if(!error){
   try{return {running:true,probe:await this.probe({timeoutMs})};}
   catch(e){error=e;}
  }
  for(let attempt=0;attempt<maxAttempts;attempt+=1){
   if(!START_RETRY_CODES.has(errorCode(error)))return {running:false,error,retryable:false};
   const remaining=deadline-this._now();
   if(remaining<=0)break;
   await this._sleep(Math.min(500,remaining));
   try{return {running:true,probe:await this.probe({timeoutMs})};}
   catch(e){error=e;}
  }
  return {running:false,error,retryable:true,exhausted:true};
 }

 async ensureRunning(options={}){
  const timeoutMs=Math.min(Math.max(Number(options.timeoutMs)||1200,300),5000);
  const verified=await this.checkedInstallation();
  if(!verified.patch?.ready)return {running:false,state:'configuration_missing',code:'DESKTOP_INSTALLATION_CHANGED',message:verified.patch?.message||'固定安装校验未通过',installation:verified};
  const initial=await this.probe({timeoutMs}).then(data=>({running:true,probe:data,discovery:this.describe()})).catch(error=>({running:false,error}));
  if(initial.running)return initial;
  if(!START_RETRY_CODES.has(errorCode(initial.error)))return {running:false,state:'needs_user_action',code:errorCode(initial.error),message:initial.error.message,installation:verified};
  let existingAlive=false;
  try{const d=this.discover();existingAlive=!!d.pid&&isAlive(d.pid);}catch{}
  if(existingAlive){
   const ready=await this.waitForBridge({timeoutMs,startTimeoutMs:options.startTimeoutMs,initialError:initial.error});
   if(ready.running)return {running:true,probe:ready.probe,discovery:this.describe()};
   if(!ready.retryable)return {running:false,state:'needs_user_action',code:errorCode(ready.error),message:ready.error.message,installation:verified};
   return {running:false,state:'needs_user_action',code:'DESKTOP_RESTART_REQUIRED',message:'桌面客户端正在运行但桌面桥在等待时间内未就绪；请正常退出并重新打开 Gemini 一次。不会强制结束现有进程。',installation:verified};
  }
  if(!this.autoStart)return {running:false,state:'not_running',code:errorCode(initial.error),message:initial.error.message,probe:null};
  const installation=await this.checkedInstallation();
  if(!installation.exists)return {running:false,state:'desktop_not_installed',code:'DESKTOP_NOT_INSTALLED',message:'未找到固定版本 Gemini.exe',installation};
  if(!installation.versionMatches)return {running:false,state:'desktop_version_mismatch',code:'DESKTOP_VERSION_MISMATCH',message:`需要固定版本 ${APP_VERSION}`,installation};
  if(!installation.patch.ready)return {running:false,state:'configuration_missing',code:String(installation.patch.state||'DESKTOP_PATCH_MISSING').toUpperCase(),message:installation.patch.message||'桌面桥未验证；未启动客户端',installation};
  let child;
  try{
   child=spawn(installation.exe,[],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,GEMINI_WORK_BACKGROUND:'1'}});
   child.on('error',()=>{});
   child.unref();
  }catch(e){
   return {running:false,state:'desktop_launch_failed',code:'DESKTOP_LAUNCH_FAILED',message:`无法启动桌面客户端：${e.message}`,installation};
  }
  const ready=await this.waitForBridge({timeoutMs,startTimeoutMs:options.startTimeoutMs});
  if(ready.running)return {running:true,probe:ready.probe,discovery:this.describe(),launched:true};
  if(!ready.retryable)return {running:false,state:'needs_user_action',code:errorCode(ready.error),message:ready.error.message,installation,launched:true};
  return {running:false,state:'needs_user_action',code:'DESKTOP_BRIDGE_NOT_READY',message:'已尝试启动桌面客户端，但未发现可用桌面桥；请正常退出并重新打开 Gemini 一次。不会强制结束现有进程。',installation,launched:true};
 }

 healthProbe(timeoutMs=1200){
  return this.probe({timeoutMs}).then(data=>({ok:true,probe:data})).catch(error=>({ok:false,code:errorCode(error),message:error.message}));
 }
}

function isAlive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}

module.exports={DesktopTransport,DesktopError,APP_VERSION,PROTOCOL,READY_TIMEOUT_MS,SNAPSHOT_STATUSES,validateWire,normalizeSnapshot,normalizeCapabilities,validateGeminiUrl,readDiscoveryFile,STATE,errorCode};
