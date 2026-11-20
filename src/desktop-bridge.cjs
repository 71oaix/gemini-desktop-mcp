'use strict';
// In-process bridge for the official Gemini desktop main process.
// Production page state arrives only from ObservationHost pushes. The bridge
// waits for state predicates and issues bounded one-shot page actions; it does
// not run observe/ready/collect polling loops.
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const page=require('./desktop-page.cjs');
const policy=require('./desktop-model-policy.cjs');
const {EventJournal}=require('./desktop-events.cjs');
const {TaskMachine,PHASES,PHASE_STATUS}=require('./desktop-machine.cjs');

const PROTOCOL=2;
const BRIDGE_VERSION='2.0.0';
const OPS=new Set(['probe','ready','execute','snapshot','recover','release','sync','inspect_settings','settings_action','capabilities']);
const READY_WAIT_MS=15000;
const TERMINAL=new Set(['completed','partial','failed']);
const STATUSES=new Set(['connecting','submitting','generating','retry_wait','completed','partial','uncertain','needs_user_action','failed']);
const INSTANCES=new Map();
const DEFAULT_STATE_DIR=null;
const FRAME_LIMIT=2*1024*1024-64*1024;
// Total execution budget (preparation included): 30 minutes from the first
// client-side start. Queue waiting is not counted.
const DEFAULT_BUDGET_MS=1800000;
const MAX_GENERATING=3;
const DEFAULTS=Object.freeze({
 stableMs:2000,prepareMs:60000,modelMs:10000,attachmentMs:60000,draftMs:10000,
 confirmationMs:120000,idleMs:60000,pingMs:2000,heartbeatMs:15000,answerPersistMs:1000
});

function nowIso(ms){return new Date(ms).toISOString();}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}
function BridgeError(code,message,status){const error=new Error(message||code);error.code=code;error.status=status||0;return error;}
function safeEqual(a,b){const left=crypto.createHash('sha256').update(String(a)).digest();const right=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(left,right);}
function isPlainObject(value){if(!value||typeof value!=='object'||Array.isArray(value))return false;const proto=Object.getPrototypeOf(value);return proto===Object.prototype||proto===null;}
function clone(value){try{return JSON.parse(JSON.stringify(value));}catch{return null;}}
function electronApp(){try{const electron=require('electron');if(electron&&typeof electron==='object'&&electron.app&&typeof electron.app.getPath==='function')return electron.app;}catch{}return null;}
function electronIpcMain(){try{const electron=require('electron');if(electron&&electron.ipcMain&&typeof electron.ipcMain.on==='function')return electron.ipcMain;}catch{}return null;}
// Electron 44 saves only a limited getLastWebPreferences dictionary and never
// stores the preload path there. The packaged bootstrap therefore passes the
// known patched preload from inside app.asar explicitly; a missing, relative or
// unusable path must fail before any window or view is created.
function explicitPreloadPath(options={}){
 const value=options&&options.preloadPath;
 if(typeof value!=='string'||!value||!path.isAbsolute(value))throw BridgeError('PRELOAD_PATH_REQUIRED','额外会话缺少显式的绝对 preload 路径，拒绝创建无观察器的页面',409);
 let stat=null;
 try{stat=fs.statSync(value);}catch{throw BridgeError('PRELOAD_PATH_UNAVAILABLE','额外会话 preload 路径不可用，拒绝创建页面',409);}
 if(!stat.isFile())throw BridgeError('PRELOAD_PATH_UNAVAILABLE','额外会话 preload 路径不是文件，拒绝创建页面',409);
 return value;
}
function defaultCreateConversationView(sourceWc,options={}){
 let electron=null;
 try{electron=require('electron');}catch{}
 const BrowserWindow=electron&&electron.BrowserWindow;
 const WebContentsView=electron&&electron.WebContentsView;
 if(!BrowserWindow||typeof BrowserWindow!=='function'||!WebContentsView||typeof WebContentsView!=='function')throw BridgeError('SESSION_VIEW_UNAVAILABLE','当前环境无法创建额外会话窗口',409);
 const preloadPath=explicitPreloadPath(options);
 let prefs={};
 try{if(sourceWc&&typeof sourceWc.getLastWebPreferences==='function')prefs=sourceWc.getLastWebPreferences()||{};}catch{}
 const inherited={...prefs};
 delete inherited.preload;
 const session=sourceWc&&sourceWc.session||prefs.session;
 const hostPreferences={...inherited,session};
 const viewPreferences={...inherited,session,preload:preloadPath,backgroundThrottling:false};
 const win=new BrowserWindow({
  show:options.show===true,
  paintWhenInitiallyHidden:true,
  width:1280,height:900,
  webPreferences:hostPreferences
 });
 let view=null;
 function destroyView(){
  let child=null;
  try{child=view&&view.webContents;}catch{}
  try{if(view&&win.contentView&&typeof win.contentView.removeChildView==='function')win.contentView.removeChildView(view);}catch{}
  try{
   if(child&&typeof child.isDestroyed==='function'&&!child.isDestroyed()){
    if(typeof child.destroy==='function')child.destroy();
    else if(typeof child.close==='function')child.close();
   }
  }catch{}
 }
 function destroyWindow(){
  try{if(win&&typeof win.isDestroyed==='function'&&!win.isDestroyed()&&typeof win.destroy==='function')win.destroy();}catch{}
 }
 try{
  if(typeof win.setMenuBarVisibility==='function')win.setMenuBarVisibility(false);
  // The BrowserWindow is only a blank host and is never navigated. Gemini runs
  // in a child WebContentsView, so the stock browser-window-created navigator
  // that watches each window's webContents never sees a Gemini URL and cannot
  // close this host or navigate the main page. Session and the rest of the
  // source webPreferences are inherited by both, but only the view receives the
  // explicit packaged preload; the blank host must not start a second observer.
  view=new WebContentsView({webPreferences:viewPreferences});
  const child=view.webContents;
  if(!child)throw BridgeError('SESSION_VIEW_UNAVAILABLE','无法创建额外会话页面',409);
  if(!win.contentView||typeof win.contentView.addChildView!=='function')throw BridgeError('SESSION_VIEW_UNAVAILABLE','无法把会话页面挂到宿主窗口',409);
  win.contentView.addChildView(view);
  if(typeof view.setBounds==='function')view.setBounds({x:0,y:0,width:1280,height:900});
  try{if(typeof child.setBackgroundThrottling==='function')child.setBackgroundThrottling(false);}catch{}
  return {wc:child,window:win,close(){destroyView();destroyWindow();}};
 }catch(error){
  destroyView();
  destroyWindow();
  throw error;
 }
}
function writeAtomic(file,data,mode){
 const directory=path.dirname(file);
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const temp=path.join(directory,`.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
 let fd;
 try{fd=fs.openSync(temp,'wx',mode||0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);}
 finally{if(fd!==undefined)fs.closeSync(fd);}
 fs.renameSync(temp,file);
 try{const dir=fs.openSync(directory,'r');fs.fsyncSync(dir);fs.closeSync(dir);}catch{}
}
function privateDir(directory){fs.mkdirSync(directory,{recursive:true,mode:0o700});try{fs.chmodSync(directory,0o700);}catch{}}
function taskPath(stateDir,id){if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw BridgeError('BAD_REQUEST','task_id 无效',400);return path.join(stateDir,'bridge-tasks',id+'.json');}
function inferPhase(ledger){
 if(ledger.status==='completed')return 'completed';
 if(ledger.status==='uncertain')return 'uncertain';
 if(ledger.status==='needs_user_action')return 'needs_user_action';
 if(ledger.status==='retry_wait')return 'retry_wait';
 if(ledger.status==='partial')return ledger.phases&&ledger.phases.confirmed?'verifying_completion':'uncertain';
 if(ledger.status==='generating')return ledger.phases&&ledger.phases.confirmed?'generating':'submitting';
 if(ledger.status==='submitting')return ledger.phases&&ledger.phases.send_intent?'awaiting_confirmation':'ready_to_send';
 if(ledger.status==='failed')return 'uncertain';
 return 'preparing';
}
function readLedger(stateDir,id){
 try{
  const ledger=JSON.parse(fs.readFileSync(taskPath(stateDir,id),'utf8'));
  if(!ledger||typeof ledger!=='object')return null;
  ledger.phases={prepared:null,send_intent:null,marker_seen:null,confirmed:null,terminal:null,...(ledger.phases&&typeof ledger.phases==='object'?ledger.phases:{})};
  ledger.result=ledger.result&&typeof ledger.result==='object'?ledger.result:{};
  ledger.metadata=ledger.metadata&&typeof ledger.metadata==='object'&&!Array.isArray(ledger.metadata)?ledger.metadata:{};
  ledger.released=!!ledger.released;
  ledger.revision=Number.isSafeInteger(ledger.revision)&&ledger.revision>=0?ledger.revision:0;
  ledger.phase=PHASES.includes(ledger.phase)?ledger.phase:inferPhase(ledger);
  return ledger;
 }
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function listLedgers(stateDir){
 let names=[];try{names=fs.readdirSync(path.join(stateDir,'bridge-tasks'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
 return names.filter(name=>/^[A-Za-z0-9_-]{1,80}\.json$/.test(name)).map(name=>{
  try{return JSON.parse(fs.readFileSync(path.join(stateDir,'bridge-tasks',name),'utf8'));}catch{throw BridgeError('LEDGER_CORRUPT','任务记录损坏，停止新的发送',500);}
 }).filter(Boolean);
}
function resultOf(ledger){
 const saved=ledger&&ledger.result||{};
 const fields=policy.legacyResultFields(saved,ledger&&ledger.model);
 const actual=fields.actual_model!=='unknown'?fields.actual_model:null;
 const legacyModel=typeof saved.model==='string'&&saved.actual_model===undefined&&saved.policy_status===undefined?saved.model:null;
 const out={
  answer:typeof saved.answer==='string'?saved.answer:'',
  url:typeof saved.url==='string'?saved.url:null,
  model:actual?(policy.MODEL_LABELS[actual]||actual):legacyModel,
  ...fields,
  submission_confirmed:!!saved.submission_confirmed,
  marker:typeof saved.marker==='string'?saved.marker:(ledger&&ledger.marker)||null,
  beforeResponses:Number.isInteger(saved.beforeResponses)?saved.beforeResponses:0
 };
 for(const key of ['complete','partial','budget_exhausted'])if(saved[key]!==undefined)out[key]=!!saved[key];
 return out;
}
function metadataOf(ledger){return ledger&&ledger.metadata&&typeof ledger.metadata==='object'&&!Array.isArray(ledger.metadata)?ledger.metadata:{};}
// A send that was observed on this page but has no conversation id yet. Only
// the original observation target may be sampled read-only for a late bind.
function lateBindPending(ledger){
 if(!ledger||ledger.released)return false;
 const phases=ledger.phases||{};
 if(!phases.send_intent||!phases.marker_seen||phases.confirmed)return false;
 if(ledger.status==='completed'||ledger.status==='failed')return false;
 return true;
}
function sendStateOf(ledger){
 if(ledger.phases&&ledger.phases.confirmed)return 'confirmed';
 if(ledger.phases&&ledger.phases.marker_seen)return 'submitted';
 if(ledger.phases&&ledger.phases.send_intent)return 'uncertain';
 return 'not_sent';
}
function snapshotOf(ledger){
 const saved=resultOf(ledger);
 return {
  task_id:ledger.task_id,status:STATUSES.has(ledger.status)?ledger.status:'failed',
  phase:PHASES.includes(ledger.phase)?ledger.phase:inferPhase(ledger),
  send_state:sendStateOf(ledger),result:saved,
  error:errorSnapshot(ledger.error),
  metadata:clone(metadataOf(ledger))||{},revision:Number.isSafeInteger(ledger.revision)?ledger.revision:0
 };
}
function validateWire(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw BridgeError('BAD_REQUEST','task 必须是对象',400);
 const allowed=['id','marker','prompt','purpose','model','mode','conversation_url','timeoutMs','attachments'];
 for(const key of Object.keys(input))if(!allowed.includes(key))throw BridgeError('BAD_REQUEST','task 含未知字段：'+key,400);
 if(typeof input.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(input.id))throw BridgeError('BAD_REQUEST','id 必须是 1–80 个字母、数字、下划线或连字符',400);
 if(typeof input.marker!=='string'||!/^\[[A-Za-z0-9][A-Za-z0-9._:-]{7,159}\]$/.test(input.marker))throw BridgeError('BAD_REQUEST','marker 必须是不含空白的 [..] 随机标记',400);
 if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>page.MAX_PROMPT)throw BridgeError('BAD_REQUEST','prompt 必须是非空文本，最多 120000 字符',400);
 const purpose=input.purpose===undefined?'work':input.purpose;
 if(purpose!=='review'&&purpose!=='work')throw BridgeError('BAD_REQUEST','purpose 必须为 review 或 work',400);
 // Every supported entry defaults to Hydrogen. A caller may name any bounded
 // model identifier/name that the live menu actually exposes.
 const model=input.model===undefined||input.model===null?policy.DEFAULT_MODEL:policy.normalizeModel(input.model);
 if(!model)throw BridgeError('BAD_REQUEST','model 必须是有界的模型名、菜单标识或 hydrogen、flash、argon',400);
 const mode=input.mode===undefined||input.mode===null||input.mode==='auto'?null:input.mode;
 if(mode!==null&&mode!=='chat'&&mode!=='task')throw BridgeError('BAD_REQUEST','mode 必须为 auto、chat 或 task',400);
 const conversationUrl=input.conversation_url===undefined||input.conversation_url===null?null:page.validUrl(input.conversation_url);
 const timeoutMs=input.timeoutMs===undefined||input.timeoutMs===null?null:input.timeoutMs;
 if(timeoutMs!==null&&(!Number.isInteger(timeoutMs)||timeoutMs<20000||timeoutMs>DEFAULT_BUDGET_MS))throw BridgeError('BAD_REQUEST','timeoutMs 必须为 null 或 20000–1800000 之间的整数',400);
 const attachments=page.validateAttachments(input.attachments).map(file=>({name:file.name,mime:file.mime,base64:file.base64,sha256:sha256(file.bytes)}));
 return {id:input.id,marker:input.marker,prompt:input.prompt,purpose,model,mode,conversation_url:conversationUrl,timeoutMs,attachments};
}
function contentHash(wire){
 return sha256(JSON.stringify({
  prompt:wire.prompt,purpose:wire.purpose,model:wire.model,...(wire.mode?{mode:wire.mode}:{}),conversation_url:wire.conversation_url,
  attachments:wire.attachments.map(file=>({name:file.name,mime:file.mime,sha256:file.sha256}))
 }));
}
function inputSummary(wire,hash){
 return {content_sha256:hash,prompt_sha256:sha256(wire.prompt),prompt_chars:wire.prompt.length,purpose:wire.purpose,model:wire.model,mode:wire.mode||null,conversation_url:wire.conversation_url,timeout_ms:wire.timeoutMs,attachments:wire.attachments.map(file=>({name:file.name,mime:file.mime,sha256:file.sha256}))};
}
function err(code,message,details){const out={code:String(code||'INTERNAL'),message:String(message||code||'INTERNAL')};if(details&&typeof details==='object')out.details=details;return out;}
function errorSnapshot(error){
 if(!error||typeof error!=='object')return null;
 const out={code:String(error.code||'INTERNAL'),message:String(error.message||'')};
 if(error.details&&typeof error.details==='object')out.details=error.details;
 return out;
}

function phaseStatus(phase){return PHASE_STATUS[phase]||'uncertain';}

function attach(wc,options={}){
 const logger=typeof options.logger==='function'?options.logger:()=>{};
 const log=(level,message)=>{try{logger(level,'[gemini-desktop-bridge] '+message);}catch{}};
 try{
  if(!wc||typeof wc.executeJavaScript!=='function')return {ok:false,error:'WC_INVALID'};
  const app=electronApp();
  const configured=options.stateDir||process.env.GEMINI_DESKTOP_STATE||DEFAULT_STATE_DIR;
  if(!configured)return {ok:false,error:'STATE_DIR_REQUIRED'};
  const stateDir=path.resolve(configured);
  if(INSTANCES.has(stateDir))return {ok:false,error:'STATE_DIR_IN_USE'};
  privateDir(stateDir);
  privateDir(path.join(stateDir,'bridge-tasks'));
  const appVersion=String((app&&typeof app.getVersion==='function'?app.getVersion():'')||options.appVersion||'unknown');
  const readOnly=options.readOnly!==false;
  const maxHTTPBytes=Number.isInteger(options.maxHTTPBytes)?options.maxHTTPBytes:40*1024*1024;
  const sleep=options.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const now=options.now||Date.now;
  const setTimer=typeof options.setTimeout==='function'?options.setTimeout:setTimeout;
  const clearTimer=typeof options.clearTimeout==='function'?options.clearTimeout:clearTimeout;
  const stableMs=Number.isFinite(options.stableMs)&&options.stableMs>=0?options.stableMs:DEFAULTS.stableMs;
  const prepareMs=Number.isFinite(options.prepareMs)?options.prepareMs:DEFAULTS.prepareMs;
  const modelMs=Number.isFinite(options.modelMs)?options.modelMs:DEFAULTS.modelMs;
  const attachmentMs=Number.isFinite(options.attachmentMs)?options.attachmentMs:DEFAULTS.attachmentMs;
  const draftMs=Number.isFinite(options.draftMs)?options.draftMs:DEFAULTS.draftMs;
  const confirmationMs=Number.isFinite(options.confirmationMs)?options.confirmationMs:DEFAULTS.confirmationMs;
  const idleMs=Number.isFinite(options.idleMs)?options.idleMs:DEFAULTS.idleMs;
  const pingMs=Number.isFinite(options.pingMs)?options.pingMs:DEFAULTS.pingMs;
  const heartbeatMs=Number.isFinite(options.heartbeatMs)?options.heartbeatMs:DEFAULTS.heartbeatMs;
  const answerPersistMs=Number.isFinite(options.answerPersistMs)?options.answerPersistMs:DEFAULTS.answerPersistMs;
  // Test-only override for the bounded startup-readiness wait.
  const readyMs=Number.isFinite(options.readyMs)&&options.readyMs>=0?options.readyMs:READY_WAIT_MS;
  const token=crypto.randomBytes(32).toString('base64url');
  const bindingId=crypto.randomUUID();
  const journal=new EventJournal({filename:path.join(stateDir,'bridge-events.json')});
  const instance={
   wc,stateDir,readOnly,appVersion,bindingId,closed:false,stopping:false,activeId:null,task:null,tasks:new Map(),uiLockId:null,settingsReservation:null,sessions:new Map(),primarySession:null,port:null,server:null,
   openingExtraSessions:0,timers:new Set(),discoveryPath:path.join(stateDir,'discovery.json'),journal,subscriptions:new Set(),journalError:null
  };
  INSTANCES.set(stateDir,instance);
  let observation=null;
  if(options.observationHost)observation=options.observationHost;
  else if(app){
   const ipcMain=electronIpcMain();
   if(ipcMain){
    const {ObservationHost}=require('./desktop-observation.cjs');
    observation=new ObservationHost({wc,ipcMain});
   }
  }
  if(observation)instance.observation=observation;
  function taskObservation(task){return (task&&task.session&&task.session.observation)||observation;}
  function taskWc(task){return (task&&task.session&&task.session.wc)||wc;}
  function taskForSession(session){return session&&session.taskId?instance.tasks.get(session.taskId)||null:null;}
  function wireSessionObservation(session){
   const host=session&&session.observation;
   if(!host||host._geminiWorkWired)return;
   host._geminiWorkWired=true;
   host.on('fault',fault=>{
    if(session===instance.primarySession)instance.observationFault={code:fault.code,at:fault.at};
    taskForSession(session)?.machine?.noteFault(fault);
   });
   host.on('state',()=>{if(session===instance.primarySession){instance.lastObservationAt=now();instance.observationFault=null;}});
   host.on('native-turn',turn=>{taskForSession(session)?.machine?.noteNative(turn);});
  }
  // A task owns its WebContents for the whole preparation/send/generation
  // window. The global uiLock is only a diagnostic/menu token; it must not be
  // used to decide whether another task's page is free.
  function taskDriving(task){
   return !!(task&&task.run&&!task.closed&&!task.generationSettled);
  }
  function occupyingGeneration(task){
   if(!task||task.generationSettled)return false;
   if(task.lateBinding)return true;
   const status=task.ledger.status;
   // Preparing tasks own a real page too; reserve the same bounded slot.
   if(taskDriving(task)&&(status==='connecting'||status==='submitting'))return true;
   if(task.ledger.phases&&task.ledger.phases.confirmed&&!TERMINAL.has(status)&&status!=='needs_user_action'&&status!=='uncertain'&&status!=='failed'&&status!=='retry_wait')return true;
   if(status==='generating')return true;
   if(status==='partial'&&task.ledger.metadata&&task.ledger.metadata.budget_exhausted)return true;
   // After the single send click but before confirmation the page may already
   // be generating; keep the slot reserved.
   if(task.ledger.phases&&task.ledger.phases.send_intent&&(status==='connecting'||status==='submitting'))return true;
   return false;
  }
  function taskUsingConversation(task){return taskDriving(task)||occupyingGeneration(task);}
  function persistedOccupying(ledger){
   if(!ledger||ledger.released)return false;
   // Budget-exhausted sent tasks stay at status=partial but still occupy a slot.
   if(ledger.metadata&&ledger.metadata.budget_exhausted&&ledger.phases&&ledger.phases.confirmed&&!ledger.phases.terminal)return true;
   if(TERMINAL.has(ledger.status))return false;
   if(ledger.phases&&ledger.phases.terminal)return false;
   return ledger.status==='generating'||ledger.status==='submitting';
  }
  function generationCount(){
   const ids=new Set();
   for(const task of instance.tasks.values())if(occupyingGeneration(task))ids.add(task.id);
   for(const ledger of listLedgers(stateDir)){
    if(instance.tasks.has(ledger.task_id))continue;
    if(persistedOccupying(ledger))ids.add(ledger.task_id);
   }
   return ids.size;
  }
  function conversationOfLedger(ledger){
   const saved=resultOf(ledger);
   if(saved&&typeof saved.url==='string')return saved.url;
   return null;
  }
  function conversationBusy(url,exceptId){
   if(!url||!page.hasConversationId(url))return null;
   for(const task of instance.tasks.values()){
    if(exceptId&&task.id===exceptId)continue;
    const current=(resultOf(task.ledger).url)||(task.wire&&task.wire.conversation_url)||null;
    if(current&&page.sameConversation(current,url)&&taskUsingConversation(task))return task.ledger;
   }
   for(const ledger of listLedgers(stateDir)){
    if(exceptId&&ledger.task_id===exceptId)continue;
    const current=conversationOfLedger(ledger);
    if(current&&page.sameConversation(current,url)&&persistedOccupying(ledger))return ledger;
   }
   return null;
  }
  function generationInfo(){
   const ids=[];
   for(const task of instance.tasks.values())if(occupyingGeneration(task))ids.push(task.id);
   for(const ledger of listLedgers(stateDir)){
    if(ids.includes(ledger.task_id))continue;
    if(persistedOccupying(ledger))ids.push(ledger.task_id);
   }
   return {generating_count:ids.length,generating_limit:MAX_GENERATING,generating_task_ids:ids,ui_lock:instance.uiLockId,active_tasks:[...instance.tasks.keys()]};
  }
  function acquireUiLock(task){
   // Never steal a menu/action token from another live task. Page ownership is
   // tracked separately on the session and is never transferred silently.
   if(instance.uiLockId&&instance.uiLockId!==task.id)return false;
   instance.uiLockId=task.id;
   instance.activeId=task.id;
   instance.task=task;
   return true;
  }
  function releaseUiLock(task){
   if(instance.uiLockId===task.id)instance.uiLockId=null;
   if(instance.activeId===task.id&&!instance.uiLockId)instance.activeId=[...instance.tasks.keys()].find(id=>id!==task.id)||null;
  }
  function sessionIsFree(session,task){
   if(!session)return false;
   // A page kept for a possible late conversation-id bind belongs to that task
   // until it resolves or is released. Never hand it to a second task.
   if(session.lateBindTaskId&&session.lateBindTaskId!==task.id)return false;
   // Ownership lasts for the whole preparation/send/generation window. A task
   // that is still typing or selecting a model is not an idle page.
   if(!session.taskId||session.taskId===task.id)return true;
   return false;
  }
  function bindSession(task,session){
   if(session.lateBindTaskId&&session.lateBindTaskId!==task.id)throw BridgeError('SESSION_BUSY','页面仍保留给另一个任务的迟到会话绑定，未转移',409);
   if(session.taskId&&session.taskId!==task.id){
    const other=instance.tasks.get(session.taskId);
    if(other&&other.session===session&&!other.closed)throw BridgeError('SESSION_BUSY','页面仍由另一个准备中的任务独占，未转移会话绑定',409);
    if(other&&other.session===session)other.session=null;
   }
   session.taskId=task.id;
   task.session=session;
  }
  function bindSessionLifecycle(session){
   const target=session.wc;
   if(!target||typeof target.on!=='function'||session._lifecycleBound)return;
   session._lifecycleBound=true;
   const onDestroyed=()=>{if(session!==instance.primarySession)instance.sessions.delete(session.id);};
   const onInput=(event,input)=>{
    if(instance.closed)return;
    if(instance.capabilityInspection){instance.capabilityInspection.interrupted=true;return;}
    if(input&&/^(keyDown|keyUp|char|rawKeyDown)$/i.test(input.type||'')){
    const task=taskForSession(session);
    if(!task||!task.run||task.closed)return;
    if(!(taskDriving(task)||occupyingGeneration(task)))return;
    instance.stopping=true;
    task.machine.interrupt('USER_INTERFERENCE','用户输入中断了自动任务');
     task.abort.abort();
    }
   };
   const onNavigate=(event,url)=>{
    if(instance.closed||session.navigating)return;
    if(instance.capabilityInspection){instance.capabilityInspection.interrupted=true;return;}
    const task=taskForSession(session);
    if(!task||!task.run||task.closed)return;
    if(!(taskDriving(task)||occupyingGeneration(task)))return;
    if(task.lateBinding){
     task.machine.interrupt('USER_INTERFERENCE','页面由用户切换，已暂停只读恢复');
     task.abort.abort();
     return;
    }
    try{event.preventDefault();}catch{}
    if(taskDriving(task)&&!(task.ledger.phases&&task.ledger.phases.confirmed)){
     instance.stopping=true;
     task.machine.interrupt('USER_INTERFERENCE','页面被意外导航，任务已暂停');
     task.abort.abort();
    }
   };
   target.on('destroyed',onDestroyed);
   target.on('before-input-event',onInput);
   target.on('will-navigate',onNavigate);
   session._destroyHandler=onDestroyed;
   session._inputHandler=onInput;
   session._navigateHandler=onNavigate;
  }
  async function openExtraSession(){
   const open=[...instance.sessions.values()].filter(session=>session.extra).length;
   if(open+instance.openingExtraSessions>=MAX_GENERATING)throw BridgeError('SESSION_VIEW_UNAVAILABLE','额外会话页面已达上限，等待原页面恢复或关闭',409);
   instance.openingExtraSessions++;
   const factory=typeof options.createConversationView==='function'?options.createConversationView:defaultCreateConversationView;
   let created=null,host=null,owned=false;
   try{
    created=await factory(wc,{show:false,preloadPath:options.preloadPath});
    if(!created||!created.wc)throw BridgeError('SESSION_VIEW_UNAVAILABLE','无法创建额外会话窗口',409);
    host=created.observation||null;
    if(!host){
     const ipcMain=electronIpcMain();
     if(!ipcMain)throw BridgeError('SESSION_VIEW_UNAVAILABLE','无法为额外会话绑定观察器',409);
     const {ObservationHost}=require('./desktop-observation.cjs');
     host=new ObservationHost({wc:created.wc,ipcMain});
    }
    const session={id:'session-'+crypto.randomUUID(),wc:created.wc,observation:host,window:created.window||null,close:created.close||null,extra:true,taskId:null,navigating:false};
    wireSessionObservation(session);
    bindSessionLifecycle(session);
    instance.sessions.set(session.id,session);
    owned=true;
    return session;
   }catch(error){
    if(!owned){
     // A factory may already have created a window/WebContents before the
     // observation host fails. Never leak that extra view into the app.
     try{host&&typeof host.close==='function'?host.close():null;}catch{}
     try{created&&typeof created.close==='function'?created.close():null;}catch{}
    }
    if(error&&error.code&&typeof error.status==='number')throw error;
    throw BridgeError(error&&error.code||'SESSION_VIEW_UNAVAILABLE',error&&error.message||'无法创建额外会话窗口',409);
   }finally{instance.openingExtraSessions--;}
  }
  async function attachSession(task,{recover=false}={}){
   const saved=resultOf(task.ledger);
   const target=task.wire.conversation_url||(recover&&saved&&saved.url?saved.url:null);
   if(target&&page.hasConversationId(target)){
    const busy=conversationBusy(target,task.id);
    if(busy)throw BridgeError('CONVERSATION_BUSY','该会话正在生成回复，请等待结束后再续聊',409);
    for(const session of instance.sessions.values()){
     let url='';
     try{url=typeof session.wc.getURL==='function'?session.wc.getURL():'';}catch{}
     if(url&&page.sameConversation(url,target)&&sessionIsFree(session,task)){bindSession(task,session);return session;}
    }
   }
   const free=[...instance.sessions.values()].filter(session=>sessionIsFree(session,task));
   // A page whose current mode is unknown cannot host a new chat: the restored
   // primary conversation may have no segmented control at all, and a page that
   // has not pushed any state may still be recovering. Extra views are safe
   // because their first document is the plain app entry, never a business
   // conversation.
   const usable=free.filter(session=>{
    if(session.extra)return true;
    const state=session.observation&&session.observation.currentState;
    return !!state&&surfaceModeOf(state)!==null;
   });
   const chosen=usable[0];
   if(chosen){bindSession(task,chosen);return chosen;}
   const created=await openExtraSession();
   bindSession(task,created);
   return created;
  }
  function closeSessionIfUnused(session){
   if(!session||!session.extra)return;
   if(session.lateBindTaskId)return;
   if(session.taskId&&instance.tasks.has(session.taskId)){
    const owner=instance.tasks.get(session.taskId);
    if(owner&&occupyingGeneration(owner))return;
   }
   instance.sessions.delete(session.id);
   if(session.taskId){
    const owner=instance.tasks.get(session.taskId);
    if(owner&&owner.session===session)owner.session=null;
   }
   try{session.observation?.close();}catch{}
   try{if(typeof session.close==='function')session.close();}catch{}
  }
  function primarySession(){
   if(instance.primarySession)return instance.primarySession;
   const session={id:'primary',wc,observation,window:null,close:null,extra:false,taskId:null,navigating:false};
   instance.primarySession=session;
   instance.sessions.set('primary',session);
   wireSessionObservation(session);
   return session;
  }
  primarySession();
  // Read-only diagnostic record for background throttling. Booleans only; any
  // failure is clipped into throttle.error instead of being swallowed.
  const throttle={supported:!!(wc&&typeof wc.setBackgroundThrottling==='function'),applied:false,previous:null,error:null};

  function persist(ledger){
   ledger.updated_at=nowIso(now());
   writeAtomic(taskPath(stateDir,ledger.task_id),JSON.stringify(ledger,null,2)+'\n',0o600);
  }
  function journalSummary(ledger){
   const result=resultOf(ledger);const {answer,...rest}=result;
   return {task_id:ledger.task_id,status:ledger.status,phase:ledger.phase,send_state:sendStateOf(ledger),result:{...rest,answer_chars:answer.length},error:errorSnapshot(ledger.error),metadata:clone(metadataOf(ledger))||{},revision:ledger.revision};
  }
  function publishSnapshot(ledger){
   try{
    const summary=journalSummary(ledger);
    const full=snapshotOf(ledger);
    const candidate={task:summary,snapshot:full,task_id:ledger.task_id,revision:ledger.revision};
    if(Buffer.byteLength(JSON.stringify(candidate),'utf8')<=FRAME_LIMIT)journal.append('snapshot',candidate);
    else journal.append('snapshot',{task:summary,task_id:ledger.task_id,revision:ledger.revision,snapshot_required:true});
    instance.journalError=null;
   }catch(error){
    instance.journalError={code:error.code||'JOURNAL_FAILED',message:error.message};
    closeSubscriptions();
    if(!instance.closed)log('error','journal append failed: '+(error.message||error));
   }
  }
  function commitSnapshot(task,patch={}){
   const ledger=task.ledger;
   if(patch.phase!==undefined){
    if(!PHASES.includes(patch.phase))throw BridgeError('INTERNAL','无效阶段 '+patch.phase,500);
    if(ledger.phase!==patch.phase){ledger.phase=patch.phase;ledger.metadata.phase_changed_at=nowIso(now());}
   }
   let status=patch.status;
   if(!status)status=ledger.status==='partial'&&ledger.metadata.budget_exhausted?'partial':phaseStatus(ledger.phase);
   if(ledger.metadata.budget_exhausted&&['connecting','submitting','generating'].includes(status))status='partial';
   if(!STATUSES.has(status))throw BridgeError('INTERNAL','无效状态 '+status,500);
   ledger.status=status;
   if(patch.error!==undefined)ledger.error=patch.error;
   else if(status==='connecting'||status==='submitting'||status==='generating'||status==='retry_wait')ledger.error=null;
   if(patch.result)ledger.result={...resultOf(ledger),...patch.result};
   if(patch.metadata)ledger.metadata={...ledger.metadata,...patch.metadata};
   if(patch.terminal)ledger.phases.terminal=patch.terminal;
   ledger.revision=ledger.revision+1;
   persist(ledger);
   publishSnapshot(ledger);
   return snapshotOf(ledger);
  }
  function createTask(wire){
   const hash=contentHash(wire);
   const timestamp=nowIso(now());
   const ledger={
    schema:1,task_id:wire.id,marker:wire.marker,content_hash:hash,model:wire.model,mode:wire.mode||null,purpose:wire.purpose,timeoutMs:wire.timeoutMs,
    status:'connecting',phase:'preparing',revision:0,
    result:{answer:'',url:null,model:null,...policy.presendResult({requestedModel:wire.model,mode:wire.mode,requestedMode:wire.mode||'auto'}),submission_confirmed:false,marker:wire.marker,beforeResponses:0},
    error:null,metadata:{created_at:timestamp,phase_changed_at:timestamp},binding_id:bindingId,web_contents_id:typeof wc.id==='number'?wc.id:null,
    created_at:timestamp,updated_at:timestamp,released:false,input:inputSummary(wire,hash),
    phases:{prepared:null,send_intent:null,marker_seen:null,confirmed:null,terminal:null}
   };
   persist(ledger);
   return ledger;
  }
  function onMachinePhase(task,info){
   if(task.closed)return;
   // Terminal phases are committed by finalizeOutcome with the complete result.
   if(info.phase==='completed'||info.phase==='needs_user_action'||info.phase==='uncertain')return;
   const ledger=task.ledger;
   if(ledger.phase===info.phase)return;
   const status=ledger.status==='partial'&&ledger.metadata.budget_exhausted?'partial':undefined;
   try{commitSnapshot(task,{phase:info.phase,status,reason:'phase'});}
   catch(error){if(!instance.closed)log('error','phase snapshot failed: '+(error.message||error));}
  }
  function onMachineAnswer(task,info){
   if(task.closed)return;
   const ledger=task.ledger;
   ledger.result={...resultOf(ledger),answer:info.answer};
   if(now()-(task.lastAnswerPersist||0)<answerPersistMs)return;
   task.lastAnswerPersist=now();
   const status=ledger.status==='partial'&&ledger.metadata.budget_exhausted?'partial':undefined;
   try{commitSnapshot(task,{status,reason:'answer'});}
   catch(error){if(!instance.closed)log('error','answer snapshot failed: '+(error.message||error));}
  }
  function taskFor(ledger,wire){
   const saved=resultOf(ledger);
   const machine=new TaskMachine({
    marker:ledger.marker,taskId:ledger.task_id,beforeResponses:saved.beforeResponses,
    confirmedUrl:saved.url&&page.hasConversationId(saved.url)?saved.url:null,
    actualMode:saved.actual_mode==='chat'||saved.actual_mode==='task'?saved.actual_mode:'unknown',
    phase:ledger.phase,sent:!!ledger.phases.send_intent
   },{stableMs,now,setTimeout:setTimer,clearTimeout:clearTimer});
   const task={
   id:ledger.task_id,wire,ledger,machine,run:null,closed:false,generationSettled:false,
   abort:new AbortController(),budgetTimer:null,idleTimer:null,idleArmed:false,idleSeq:0,
   lastStateAt:0,lastAnswerPersist:0,lastBusinessFingerprint:null,removeGeneration:null
   };
   machine.on('phase',info=>onMachinePhase(task,info));
   machine.on('answer',info=>onMachineAnswer(task,info));
   machine.on('native-advisory',()=>{
    if(task.closed||task.generationSettled)return;
    try{const host=taskObservation(task);maybeRepaint(task,host&&host.currentState,{generation:host&&host.binding?host.binding.generation:null,source:'native'});}
    catch(error){if(!instance.closed)log('error','repaint native diagnostic failed: '+(error.message||error));}
   });
   return task;
  }
  function currentTask(id){return instance.tasks.get(id)||((instance.task&&instance.task.id===id)?instance.task:null);}
  function findBlocking(otherId,wire){
   const target=wire&&wire.conversation_url;
   if(!target||!page.hasConversationId(target))return null;
   return conversationBusy(target,otherId);
  }
  function throttleFailure(code,failure){
   const raw=failure&&failure.message!==undefined?failure.message:String(failure||'');
   return {code:String(failure&&failure.code||code||'THROTTLE_FAILED'),message:String(raw||code||'THROTTLE_FAILED').slice(0,300)};
  }
  function readThrottleCurrent(){
   try{
    if(typeof wc.getBackgroundThrottling!=='function')return null;
    const value=wc.getBackgroundThrottling();
    return typeof value==='boolean'?value:null;
   }catch(error){
    throttle.error=throttleFailure('THROTTLE_READ_FAILED',error);
    return null;
   }
  }
  function throttleDiagnostic(){
   return {supported:!!(wc&&typeof wc.setBackgroundThrottling==='function'),applied:throttle.applied,previous:throttle.previous,current:readThrottleCurrent(),error:throttle.error};
  }
  function attachThrottle(targetWc){
   const used=targetWc||wc;
   if(used!==wc){
    try{if(typeof used.setBackgroundThrottling==='function')used.setBackgroundThrottling(false);}catch{}
    return;
   }
   if(throttle.applied)return;
   throttle.supported=!!(wc&&typeof wc.setBackgroundThrottling==='function');
   if(!throttle.supported)return;
   throttle.error=null;
   throttle.previous=readThrottleCurrent();
   try{
    wc.setBackgroundThrottling(false);
    throttle.applied=true;
   }catch(error){
    throttle.applied=false;
    throttle.error=throttleFailure('THROTTLE_ATTACH_FAILED',error);
   }
  }
  function restoreThrottle(force=false){
   if(!throttle.applied)return;
   if(!force){
    const still=liveTasks().some(task=>(taskDriving(task)||occupyingGeneration(task))&&taskWc(task)===wc);
    if(still)return;
   }
   throttle.applied=false;
   const target=throttle.previous===null?true:throttle.previous;
   try{if(typeof wc.setBackgroundThrottling==='function')wc.setBackgroundThrottling(target);}
   catch(error){
    throttle.error=throttleFailure('THROTTLE_RESTORE_FAILED',error);
   }
  }
  function liveTasks(){return [...instance.tasks.values()];}
  function classifyFailure(task,error){
   const code=error&&error.code||'INTERNAL';
   const sent=!!task.ledger.phases.send_intent;
   const confirmed=!!task.ledger.phases.confirmed;
   const details=error&&error.details&&typeof error.details==='object'?error.details:undefined;
   if(code==='BRIDGE_CLOSED'||code==='WC_DESTROYED')return {status:sent?(confirmed?'partial':'uncertain'):'needs_user_action',error:err(code,error.message,details)};
   if(sent&&!confirmed)return {status:'uncertain',error:err(code,error.message,details)};
   if(sent&&confirmed)return {status:code==='INTERNAL'?'uncertain':'needs_user_action',error:err(code,error.message,details)};
   if(code==='INTERNAL')return {status:'failed',error:err('INTERNAL','桥内部错误：'+(error.message||'unknown'),details)};
   return {status:'needs_user_action',error:err(code,error.message,details)};
  }
  function observationBound(host){
   host=host||observation;
   if(!host)return false;
   return !!host.binding||!!host.currentState;
  }
  function requireObservation(task){
   const host=task?taskObservation(task):observation;
   if(!host)throw BridgeError('OBSERVATION_UNAVAILABLE','观察器未配置，拒绝页面操作',409);
   if(!observationBound(host))throw BridgeError('OBSERVATION_UNAVAILABLE','观察器尚未绑定页面，拒绝轮询式操作',409);
   return host;
  }
  function sessionPageUrl(session){
   try{return session&&session.wc&&typeof session.wc.getURL==='function'?String(session.wc.getURL()||''):'';}catch{return '';}
  }
  function validGeminiUrl(value){
   try{return page.validUrl(value);}catch{return null;}
  }
  // The production extra view is created empty: defaultCreateConversationView
  // builds the BrowserWindow but never loads a document, so that page can never
  // greet the observer. Derive the app entry from the source page, keeping its
  // /u/<n> account prefix. The loaded business conversation is never reused as
  // a new-chat entry; only the plain app path is returned here.
  function entryUrlFrom(value){
   const valid=validGeminiUrl(value);
   if(!valid)return page.APP_URL;
   let prefix='/';
   try{
    const match=/^\/(u\/\d+\/)?app(?:\/[A-Za-z0-9_-]+)?\/?$/.exec(new URL(valid).pathname);
    if(match&&match[1])prefix='/'+match[1];
   }catch{}
   return page.validUrl('https://gemini.google.com'+prefix+'app');
  }
  // The only permitted first document for a blank extra view: this task's
  // already verified continuation URL, otherwise the plain Gemini entry.
  function firstDocumentFor(task){
   const wire=task.wire||{};
   if(wire.conversation_url&&page.hasConversationId(wire.conversation_url))return page.validUrl(wire.conversation_url);
   const saved=resultOf(task.ledger);
   if(saved&&typeof saved.url==='string'&&page.hasConversationId(saved.url))return page.validUrl(saved.url);
   return entryUrlFrom(sessionPageUrl(instance.primarySession));
  }
  // Load the first document once, only after the observation host and the
  // session lifecycle handlers exist, with the navigation guard set so the
  // will-navigate handler cannot report USER_INTERFERENCE. The load is bounded;
  // a page that never becomes ready still fails and is closed by task cleanup.
  async function loadFirstDocument(task,session){
   if(!session||!session.extra)return false;
   if(validGeminiUrl(sessionPageUrl(session)))return false;
   const targetWc=session.wc;
   if(!targetWc||typeof targetWc.loadURL!=='function')throw BridgeError('SESSION_VIEW_UNAVAILABLE','额外会话窗口无法加载 Gemini 页面',409);
   const target=firstDocumentFor(task);
   session.navigating=true;
   let timer=null;
   try{
    await new Promise((resolve,reject)=>{
     timer=setTimer(()=>reject(page.PageError('NAVIGATION_TIMEOUT','额外会话页面未在限定时间内完成首次加载')),prepareMs);
     if(timer&&typeof timer.unref==='function')timer.unref();
     page.navigateTo(targetWc,target).then(resolve,reject);
    });
   }finally{
    if(timer!==null){try{clearTimer(timer);}catch{}}
    session.navigating=false;
   }
   return true;
  }
  // A newly created extra view is returned before its preload hello arrives.
  // bindTask only records the task id, so it is valid before that hello and makes
  // the hello's bind control carry this task. The pushed state of that handshake
  // is the only evidence the page is bound; wait for it instead of polling, and
  // never touch the page before it arrives.
  async function bindObservation(task,{loadDocument=true}={}){
   const host=taskObservation(task);
   if(!host)throw BridgeError('OBSERVATION_UNAVAILABLE','观察器未配置，拒绝页面操作',409);
   host.bindTask({id:task.id});
   if(loadDocument)await loadFirstDocument(task,task.session);
   try{
    await host.waitFor(()=>true,{signal:task.abort.signal,deadlineMs:prepareMs});
   }catch(error){
    if(error&&error.code==='OBSERVATION_TIMEOUT')throw BridgeError('OBSERVATION_UNAVAILABLE','观察器未在限定时间内握手页面，未操作页面',409);
    throw error;
   }
   task.ledger.binding_id=bindingId;
   task.ledger.metadata.bound_at=nowIso(now());
  }
  function pageFaultOf(state){
   const fault=page.pageFault(state);
   if(!fault)return null;
   return {code:String(fault).split(':')[0],message:String(fault)};
  }
  // CLIENT_SHELL means the desktop shell is still loading, not a user-facing
  // fault. Startup readiness keeps waiting for the pushed chat state instead of
  // turning a normal launch into a manual-action pause.
  function readyFaultOf(state){
   const fault=pageFaultOf(state);
   if(!fault||fault.code==='CLIENT_SHELL')return null;
   return fault;
  }
  function isReadyState(state){return !!state&&!state.clientShell&&!!state.hasModeMenu&&!!state.hasInput;}
  async function waitForState(task,predicate,{deadlineMs,label,faultGate=true}={}){
   const host=taskObservation(task);
   if(!host)throw BridgeError('OBSERVATION_UNAVAILABLE','观察器未配置，拒绝页面操作',409);
   let state;
   try{
    state=await host.waitFor(state=>{
     if(faultGate){const fault=pageFaultOf(state);if(fault&&fault.code!=='CLIENT_SHELL')return true;}
     try{return !!predicate(state);}catch{return false;}
    },{signal:task.abort.signal,deadlineMs});
   }catch(error){
    if(error&&error.code==='OBSERVATION_TIMEOUT')throw page.PageError('CHAT_NOT_READY',(label||'等待页面状态')+'超时');
    throw error;
   }
   if(faultGate){const fault=pageFaultOf(state);if(fault&&fault.code!=='CLIENT_SHELL')throw page.PageError(fault.code,fault.message);}
   return state;
  }
  async function waitReady(task,deadlineMs){
   const state=await waitForState(task,isReadyState,{deadlineMs,label:'Gemini 聊天输入区未就绪',faultGate:true});
   if(!isReadyState(state))throw page.PageError('CHAT_NOT_READY','Gemini 聊天输入区未就绪');
   return state;
  }
  function surfaceModeOf(state){
   return state&&state.surface&&typeof state.surface.mode==='string'?state.surface.mode:null;
  }
  // The composer can be mounted before the 对话/任务 control is. A new
  // independent chat must wait for an actually pushed mode; input readiness or
  // the requested mode is never treated as the selected mode, and an
  // unobserved control is never clicked.
  async function waitNewSessionMode(task,state){
   if(surfaceModeOf(state))return state;
   try{
    return await waitForState(task,s=>surfaceModeOf(s)!==null,{deadlineMs:prepareMs,label:'等待新会话模式控件'});
   }catch(error){
    if(error.code==='CHAT_NOT_READY'||error.code==='OBSERVATION_TIMEOUT')throw page.PageError('MODE_CONTROL_UNIDENTIFIED','新会话未出现可识别的对话/任务模式控件，未发送');
    throw error;
   }
  }
  // Mode is a hard precondition for model/thinking behavior: chat has a
  // thinking menu, task uses native thinking. auto keeps the observed surface.
  // A continued conversation already has its mode; never click the surface
  // control again just because the request repeats chat or task.
  async function ensureSurfaceMode(task,state){
   const requested=task.wire.mode||null;
   const observed=surfaceModeOf(state);
   const plan=policy.planSurfaceAction({
    requestedMode:requested,
    observedMode:observed,
    continueConversation:!!task.wire.conversation_url
   });
   if(plan.action==='error')throw page.PageError(plan.code,plan.message);
   if(plan.action==='keep'){
    const mode=plan.mode||requested||observed;
    if(!mode)throw page.PageError('MODE_UNIDENTIFIED','无法从页面识别当前是对话还是任务模式；未发送，请确认 Gemini 界面显示分段按钮');
    return {state,mode};
   }
   const target=plan.mode;
   await page.selectSurface(taskWc(task),target);
   let verified;
   try{verified=await waitForState(task,s=>surfaceModeOf(s)===target,{deadlineMs:modelMs,label:'等待模式切换'});}
   catch(error){throw page.PageError('MODE_SELECTION_UNVERIFIED',`未确认页面已切换到${target==='task'?'任务':'对话'}模式，拒绝发送`);}
   return {state:verified,mode:target};
  }
  function attachmentNames(wire){return wire.attachments.map(file=>file.name);}
  function attachmentsPresent(state,names){
   if(!names.length)return true;
   const shown=state.uploads||[];
   // Truncated labels may collapse or split visible text, so length equality
   // is not required. Every expected name must match some chip, and leftover
   // unmatched chips are allowed only if all names are accounted for.
   return names.every(name=>shown.some(text=>page.attachmentShown(text,name)));
  }
  function attachmentsSettled(state,names){
   if(!attachmentsPresent(state,names))return false;
   return state.uploadProcessing!==true;
  }
  function attachmentTimeoutDetails(state){
   return {uploads:Array.isArray(state&&state.uploads)?state.uploads.slice(0,20):[],generates:!!(state&&state.generates),uploadProcessing:!!(state&&state.uploadProcessing)};
  }
  function hasPageContent(state){return !!(String(state&&state.draft||'').trim()||(state&&state.uploads||[]).length);}
 function ownedByPrepared(state,ledger,names){
  const prepared=ledger.phases.prepared;
  if(!prepared||ledger.phases.send_intent)return false;
  if(prepared.draft_hash&&page.draftHash(state.draft)===prepared.draft_hash)return true;
  const preparedNames=Array.isArray(prepared.attachments)&&prepared.attachments.length?prepared.attachments:names;
  return !String(state.draft||'').trim()&&preparedNames.length>0&&attachmentsPresent(state,preparedNames);
 }
 function modelOptionSame(left,right){
  if(!left||!right)return false;
  if(left.id&&right.id)return String(left.id)===String(right.id);
  const normalize=value=>String(value||'').replace(/\s+/g,' ').trim().toLowerCase();
  return normalize(left.text)===normalize(right.text);
 }
 function modelUnavailableMessage(requested,plan){
  const texts=JSON.stringify(plan.options.map(item=>item.text));
  if(plan.reason==='model_ambiguous')return `模型 ${requested} 匹配到多个菜单项，无法唯一确定；未自动降级；页面选项=${texts}`;
  if(plan.reason==='menu_not_observed')return '未观察到模型菜单，不能判定模型可用；未发送、未自动降级';
  if(plan.unavailable_reason)return `模型 ${requested} 当前不可用（${plan.unavailable_reason}），未自动降级；页面选项=${texts}`;
  return `模型 ${requested} 不在当前已观察菜单中，未自动降级；页面选项=${texts}`;
 }
 async function selectModelForTask(task,requestedOverride=null){
  const requested=policy.normalizeModel(requestedOverride||task.wire.model)||policy.DEFAULT_MODEL;
  let state=taskObservation(task).currentState||{};
  let plan=policy.planSelection(state,requested);
  let openedForSelection=false;
  if(!plan.menu_visible){
   openedForSelection=true;
   await page.openModelMenu(taskWc(task));
   try{state=await waitForState(task,s=>policy.menuReadyToDecide(s),{deadlineMs:modelMs,label:'等待模型菜单'});}
   catch(error){
    state=taskObservation(task).currentState||state;
    plan=policy.planSelection(state,requested);
    if(!plan.menu_visible){
     if(error.code==='CHAT_NOT_READY'||error.code==='OBSERVATION_TIMEOUT')throw page.PageError('MODEL_UNAVAILABLE','未观察到模型菜单，不能判定模型可用；未发送、未自动降级');
     throw error;
    }
   }
   plan=policy.planSelection(state,requested);
  }
  if(!plan.options.length)throw page.PageError('MODEL_UNAVAILABLE','未观察到模型选项，不能判定模型可用；未自动降级');
  // A cached or partially mounted menu does not prove absence. Ensure the
  // menu is open, then wait within the existing model observation budget.
  if(!plan.choice&&!plan.resolution.ambiguous&&!plan.unavailable_reason){
   if(!openedForSelection)await page.openModelMenu(taskWc(task));
   try{
    state=await waitForState(task,s=>{
     const current=policy.planSelection(s,requested);
     return current.choice!==null||current.resolution.ambiguous||!!current.unavailable_reason;
    },{deadlineMs:modelMs,label:'等待请求模型选项'});
   }catch(error){
    if(error.code!=='CHAT_NOT_READY'&&error.code!=='OBSERVATION_TIMEOUT')throw error;
   }
   plan=policy.planSelection(taskObservation(task).currentState||state,requested);
  }
  if(!plan.choice)throw page.PageError('MODEL_UNAVAILABLE',modelUnavailableMessage(requested,plan));
  const expected=plan.resolution.item;
  if(!expected)throw page.PageError('MODEL_UNAVAILABLE','模型选项缺少可核对的页面标识，未发送');
  await page.selectModel(taskWc(task),{selector:requested,id:expected.id||'',text:expected.text});
  // The click may close the menu. Reopen the same fixed entry and verify that
  // exactly one option is checked and that it is the expected item.
  try{await page.openModelMenu(taskWc(task));}
  catch(error){throw page.PageError('MODEL_SELECTION_UNVERIFIED','选择后无法重新打开模型菜单核对勾选，拒绝发送');}
  let verified;
  try{
   verified=await waitForState(task,s=>{
    const current=policy.planSelection(s,requested);
    return current.menu_visible&&!current.checked_conflict&&!!current.checked_option&&modelOptionSame(current.checked_option,expected);
   },{deadlineMs:modelMs,label:'等待模型勾选'});
  }catch(error){
   throw page.PageError('MODEL_SELECTION_UNVERIFIED','未确认唯一且相同的模型已被勾选，拒绝发送');
  }
  return {state:verified,selected:requested,selected_id:expected.id,selected_text:expected.text,fallback_reason:null};
 }
 async function ensureHighThinking(task,state){
  const requested=task.wire.model;
  let current=state||taskObservation(task).currentState||{};
  let thought=policy.thinkingSnapshot(current);
  if(thought.checked_level==='high'&&!thought.checked_conflict)return {state:current,thinking:thought};
  if(!thought.options.length){
   // Always use the idempotent open: a stale menu_visible would otherwise
   // skip the click, or a second click would toggle an open menu shut.
   await page.openModelMenu(taskWc(task));
   try{current=await waitForState(task,s=>policy.planSelection(s,requested).menu_visible,{deadlineMs:modelMs,label:'等待模型菜单'});}
   catch(error){throw page.PageError('THINKING_CONTROL_MISSING','未识别思考等级入口，拒绝发送低思考');}
   try{await page.openThinkingMenu(taskWc(task));}
   catch(error){throw page.PageError('THINKING_CONTROL_MISSING',error.message||'未识别思考等级入口，拒绝发送低思考');}
   try{current=await waitForState(task,s=>policy.thinkingSnapshot(s).options.length>0,{deadlineMs:modelMs,label:'等待思考等级选项'});}
   catch(error){throw page.PageError('THINKING_CONTROL_MISSING','未识别思考等级控件，拒绝发送低思考');}
   thought=policy.thinkingSnapshot(current);
  }
  if(!thought.options.length)throw page.PageError('THINKING_CONTROL_MISSING','未识别思考等级控件，拒绝发送低思考');
  if(thought.checked_level==='high'&&!thought.checked_conflict)return {state:current,thinking:thought};
  const high=thought.options.find(item=>item.level==='high'&&item.disabled!==true);
  if(!high)throw page.PageError('THINKING_LEVEL_UNAVAILABLE','没有可选的高思考等级，拒绝发送');
  await page.selectThinkingLevel(taskWc(task),'high');
  const verifyHigh=()=>waitForState(task,s=>{const snapshot=policy.thinkingSnapshot(s);return snapshot.checked_level==='high'&&!snapshot.checked_conflict;},{deadlineMs:modelMs,label:'等待高思考勾选'});
  const settleHigh=()=>waitForState(task,s=>{const snapshot=policy.thinkingSnapshot(s);return (snapshot.checked_level==='high'&&!snapshot.checked_conflict)||!snapshot.options.length;},{deadlineMs:modelMs,label:'等待高思考勾选'});
  let verified=null;
  try{const settled=await settleHigh();const snapshot=policy.thinkingSnapshot(settled);if(snapshot.checked_level==='high'&&!snapshot.checked_conflict)verified=settled;}
  catch{}
  if(!verified){
   // The submenu can close after a click. Reopen the same fixed entry at once
   // and verify the checked high state instead of idling until the timeout.
   const after=policy.thinkingSnapshot(taskObservation(task).currentState||{});
   if(!after.options.length){
    try{
     let plan=policy.planSelection(taskObservation(task).currentState||{},requested);
     if(!plan.menu_visible){
      await page.openModelMenu(taskWc(task));
      await waitForState(task,s=>policy.planSelection(s,requested).menu_visible,{deadlineMs:modelMs,label:'等待模型菜单'});
     }
     await page.openThinkingMenu(taskWc(task));
     await waitForState(task,s=>policy.thinkingSnapshot(s).options.length>0,{deadlineMs:modelMs,label:'等待思考等级选项'});
     verified=await verifyHigh();
    }catch{}
   }else{
    try{verified=await verifyHigh();}catch{}
   }
  }
  if(!verified)throw page.PageError('THINKING_LEVEL_UNVERIFIED','未确认思考等级为高，拒绝发送');
  return {state:verified,thinking:policy.thinkingSnapshot(verified)};
 }
  async function prepareExecution(task){
   const wire=task.wire;
   await bindObservation(task);
   let state=await waitReady(task,prepareMs);
   const names=attachmentNames(wire);
if(hasPageContent(state)&&!ownedByPrepared(state,task.ledger,names))throw page.PageError('DRAFT_PRESENT','当前页面有未发送内容，未覆盖或丢弃草稿');
   const session=task.session||instance.primarySession;
   if(wire.conversation_url){
    const target=wire.conversation_url;
    if(!page.sameConversation(state.url,target)){
     if(session)session.navigating=true;
     try{
      await page.navigateTo(taskWc(task),target);
      state=await waitReady(task,prepareMs);
     }finally{if(session)session.navigating=false;}
     if(hasPageContent(state)&&!ownedByPrepared(state,task.ledger,names))throw page.PageError('DRAFT_PRESENT','目标会话有未发送内容，未覆盖或丢弃草稿');
    }
   }else if(!page.isEmptyConversation(state)){
    if(session)session.navigating=true;
    try{
     await page.clickNewChatOnce(taskWc(task),{sleep,now});
     state=await waitForState(task,s=>page.isEmptyConversation(s),{deadlineMs:prepareMs,label:'等待进入新对话'});
    }finally{if(session)session.navigating=false;}
    if(!page.isEmptyConversation(state))throw page.PageError('NEW_CHAT_UNVERIFIED','独立任务未进入空的新对话，未发送');
   }
  if(page.hasStop(state)&&!page.isMarkerLast(state.queries||[],task.ledger.marker).last)throw page.PageError('PAGE_BUSY','Gemini 正在生成其他回答，请等待完成');
  if(!wire.conversation_url)state=await waitNewSessionMode(task,state);
  const surface=await ensureSurfaceMode(task,state);
  state=surface.state;
  let actualMode=surface.mode;
  const continueTarget=wire.conversation_url;
  if(continueTarget&&!page.sameConversation(state.url,continueTarget)){
   // Switching the surface may leave a conversation and land on /app. Reopen
   // the authorized conversation once, then require the selected mode to stick.
   if(session)session.navigating=true;
   try{
    await page.navigateTo(taskWc(task),continueTarget);
    state=await waitReady(task,prepareMs);
   }finally{if(session)session.navigating=false;}
   if(hasPageContent(state)&&!ownedByPrepared(state,task.ledger,names))throw page.PageError('DRAFT_PRESENT','目标会话有未发送内容，未覆盖或丢弃草稿');
   if(surfaceModeOf(state)!==actualMode)throw page.PageError('MODE_SELECTION_UNVERIFIED',`目标会话未保持${actualMode==='task'?'任务':'对话'}模式，拒绝发送`);
  }
  // Only an observed and verified surface reaches the machine. Unknown stays
  // the machine default, and task keeps the page-control completion path.
  task.machine.configure({actualMode});
  const modelSelection=await selectModelForTask(task);
  state=modelSelection.state;
  const thinking=actualMode==='task'?{state,thinking:{options:[],checked_level:null,checked_conflict:false,entry_count:0,control:'not_exposed'}}:await ensureHighThinking(task,state);
  state=thinking.state;
  const presend=policy.presendResult({
   requestedModel:wire.model,selectedModel:modelSelection.selected,fallbackReason:modelSelection.fallback_reason,
   thinking:thinking.thinking,menu:policy.planSelection(state,wire.model),state,
   mode:actualMode,requestedMode:wire.mode||'auto',thinkingControl:actualMode==='task'?'not_exposed':'menu'
  });
  task.ledger.result={...resultOf(task.ledger),model:null,...presend};
  task.ledger.metadata.model_policy={
   requested_model:presend.requested_model,selected_model:presend.selected_model,
   requested_mode:presend.requested_mode,actual_mode:presend.actual_mode,thinking_control:presend.thinking_control,
   thinking_level:presend.thinking_level,thinking_verified:presend.thinking_verified,
   presend_thinking_verified:presend.thinking_verified===true,
   fallback_reason:presend.fallback_reason,fallback_approved:presend.fallback_approved,
   approved_fallback_reason:presend.fallback_approved?presend.fallback_reason:null
  };
  task.ledger.metadata.model_diagnostic=page.modelDiagnostic(state);
  await page.settingsAction(taskWc(task),'close_menus');
  state=await waitForState(task,s=>!(s.models||[]).some(m=>m.visible!==false)&&!(s.thinkingOptions||[]).some(m=>m.visible!==false),{deadlineMs:modelMs,label:'等待设置菜单关闭'});
  const before=(state.responses||[]).length;
  task.ledger.result={...resultOf(task.ledger),beforeResponses:before};
  task.machine.configure({beforeResponses:before,taskId:task.id});
  const text=page.promptFor(wire);
  if(!task.ledger.phases.prepared){
   task.ledger.phases.prepared={at:nowIso(now()),draft_hash:page.draftHash(text),attachments:names};
  }
  commitSnapshot(task,{phase:'preparing',status:'connecting',reason:'prepared'});
   if(names.length&&!attachmentsSettled(state,names)){
    await page.uploadOnce(taskWc(task),wire.attachments);
    try{state=await waitForState(task,s=>attachmentsSettled(s,names),{deadlineMs:attachmentMs,label:'等待附件处理'});}
    catch(error){
     const latest=taskObservation(task).currentState||state||{};
     const details=attachmentTimeoutDetails(latest);
     log('error',`task ${task.id} ATTACHMENT_NOT_READY 未写提示词、未点发送 uploads=${JSON.stringify(details.uploads)} generates=${details.generates} uploadProcessing=${details.uploadProcessing}`);
     if(!String(latest.draft||'').trim()){
      try{await page.clearUploadsOnce(taskWc(task));}
      catch(clearError){log('error',`task ${task.id} 收回未发送附件失败：${clearError.message||clearError}`);}
     }
     if(error.code==='CHAT_NOT_READY')throw page.PageError('ATTACHMENT_NOT_READY','未确认附件处理完成，未发送问题；未写提示词、未点发送；uploads='+JSON.stringify(details.uploads)+' generates='+String(details.generates)+' uploadProcessing='+String(details.uploadProcessing),details);
     throw error;
    }
   }
   state=taskObservation(task).currentState||state;
   if(page.draftHash(state.draft)!==page.draftHash(text)){
    if(String(state.draft||'').trim())throw page.PageError('DRAFT_PRESENT','目标会话有未发送内容，未覆盖或丢弃草稿');
    await page.typePrompt(taskWc(task),text);
    try{state=await waitForState(task,s=>page.draftHash(s.draft)===page.draftHash(text),{deadlineMs:draftMs,label:'等待输入框草稿'});}
    catch(error){if(error.code==='CHAT_NOT_READY')throw page.PageError('DRAFT_NOT_SET','输入框内容与待发送任务不一致');throw error;}
   }
   await waitForState(task,s=>(s.sendButtons||[]).length===1&&!s.sendButtons[0].disabled&&/^(发送|发送消息|Send|Send message)$/i.test(s.sendButtons[0].label||''),{deadlineMs:draftMs,label:'等待发送控件就绪'});
   task.machine.setPhase('ready_to_send');
   return {before};
  }
  // Attribute replies to a unique user-message turn. A single turn can
  // expose the same text more than once through the renderer.
  function markerHit(state,marker){
   return page.isMarkerLast(Array.isArray(state.queries)?state.queries:[],marker);
  }
  function confirmationTarget(task,state){
   const session=task.session||null;
   const targetWc=taskWc(task);
   return {
    at:nowIso(now()),
    url:validGeminiUrl(state&&state.url),
    session_id:session?session.id:null,
    web_contents_id:targetWc&&Number.isInteger(targetWc.id)?targetWc.id:null
   };
  }
  // Diagnostics name only bounded page facts. The task prompt and attachment
  // bytes are never copied into the ledger or the error.
  function confirmationSnapshot(task,stage,extra={}){
   const state=taskObservation(task)&&taskObservation(task).currentState||{};
   const queries=Array.isArray(state.queries)?state.queries:[];
   const hit=markerHit(state,task.ledger.marker);
   return {
    stage,at:nowIso(now()),url:validGeminiUrl(state.url),
    marker_count:hit.count,marker_last:!!hit.last,
    query_count:queries.length,
    response_count:Array.isArray(state.responses)?state.responses.length:0,
    ...extra
   };
  }
  function confirmationFailure(task,code,message,stage,extra={}){
   const diagnostic=confirmationSnapshot(task,stage,extra);
   task.ledger.metadata.confirmation_diagnostic=diagnostic;
   return page.PageError(code,message,diagnostic);
  }
  async function confirmSubmission(task){
   const wire=task.wire,ledger=task.ledger,marker=ledger.marker;
   let state;
   try{
    state=await waitForState(task,s=>markerHit(s,marker).count>0,{deadlineMs:confirmationMs,label:'等待发送确认',faultGate:true});
   }catch(error){
    if(error.code==='CHAT_NOT_READY')throw page.PageError('SEND_UNCONFIRMED','发送后未确认任务标记，按未知发送状态处理');
    throw error;
   }
   const hit=markerHit(state,marker);
   if(hit.count>1)throw confirmationFailure(task,'MARKER_DUPLICATED','多个用户消息含同一任务标记，无法安全归属回答','marker-conflict');
   if(hit.count===1&&!hit.last)throw page.PageError('MARKER_NOT_LAST','任务标记后有后续用户消息，无法安全归属回答');
   if(!hit.count)throw page.PageError('SEND_UNCONFIRMED','发送后未确认任务标记，按未知发送状态处理');
   ledger.phases.marker_seen=confirmationTarget(task,state);
   ledger.metadata.marker_seen_at=ledger.phases.marker_seen.at;
   if(!page.hasConversationId(state.url)){
    commitSnapshot(task,{phase:'awaiting_confirmation',status:'submitting',reason:'marker-seen'});
    try{
     state=await waitForState(task,s=>{
      const current=markerHit(s,marker);
      if(current.count>1)return true;
      if(current.count===1&&!current.last)return true;
      // An empty document may be a reload; other messages without our marker
      // are a real conflict and must stop the wait immediately.
      if(current.count===0&&(page.hasConversationId(s.url)||(s.queries||[]).length>0))return true;
      return current.count===1&&current.last&&page.hasConversationId(s.url);
     },{deadlineMs:confirmationMs,label:'等待会话 URL',faultGate:true});
    }catch(error){
     if(error.code==='CHAT_NOT_READY'||error.code==='OBSERVATION_TIMEOUT'){
      throw confirmationFailure(task,'SEND_UNCONFIRMED_URL','已在页面看到任务标记，但未获得带会话 id 的 URL；保持待确认且绝不重发','url-timeout');
     }
     const diagnostic=confirmationSnapshot(task,'url-observation-fault',{fault:String(error.code||'INTERNAL')});
     ledger.metadata.confirmation_diagnostic=diagnostic;
     if(error&&typeof error==='object'&&!error.details)error.details=diagnostic;
     throw error;
    }
    const settled=markerHit(state,marker);
    if(settled.count>1)throw confirmationFailure(task,'MARKER_DUPLICATED','会话中出现多个任务标记，无法安全归属回答','url-conflict');
    if(settled.count===1&&!settled.last)throw confirmationFailure(task,'MARKER_NOT_LAST','任务标记后有后续用户消息，无法安全归属回答','url-conflict');
    if(settled.count===0)throw confirmationFailure(task,'SEND_CONFIRMATION_LOST','等待会话 URL 时任务标记消失；保持待确认且绝不重发','url-conflict');
    if(!page.hasConversationId(state.url))throw confirmationFailure(task,'SEND_UNCONFIRMED_URL','已在页面看到任务标记，但未获得带会话 id 的 URL；保持待确认且绝不重发','url-timeout');
   }
   if(wire.conversation_url&&page.hasConversationId(wire.conversation_url)&&!page.sameConversation(state.url,wire.conversation_url))throw confirmationFailure(task,'CONVERSATION_CHANGED','发送后的会话与目标任务会话不一致','url-mismatch',{expected_url:wire.conversation_url});
   const confirmedUrl=state.url;
   ledger.metadata.confirmation_diagnostic=confirmationSnapshot(task,'confirmed',{confirmed_url:confirmedUrl});
   recordConfirmedConversation(task,confirmedUrl,'confirmed');
   return state;
  }
  function recordConfirmedConversation(task,confirmedUrl,reason){
   const ledger=task.ledger;
   const at=nowIso(now());
   ledger.phases.confirmed={at,url:confirmedUrl,marker:ledger.marker};
   ledger.metadata.confirmed_at=at;
   ledger.result={...resultOf(ledger),url:confirmedUrl,submission_confirmed:true,marker:ledger.marker};
   task.machine.configure({confirmedUrl,beforeResponses:task.machine.beforeResponses,taskId:task.id});
   task.machine.arm();
   commitSnapshot(task,{phase:'generating',status:ledger.metadata.budget_exhausted?'partial':'generating',reason});
  }
  function clearTaskTimer(task,name){const key=name+'Timer';if(task[key]!==null&&task[key]!==undefined){try{clearTimer(task[key]);}catch{}task[key]=null;}}
  function clearIdleDiagnostic(ledger){
   delete ledger.metadata.completion_unverified;
   delete ledger.metadata.completion_unverified_reason;
   delete ledger.metadata.idle_still_generating;
   delete ledger.metadata.idle_has_answer;
  }
  // Only business-visible changes reset the idle window. A healthy observer
  // that still reports explicit generation re-arms the same check, so a long
  // silent turn is diagnosed once per idle interval instead of only once.
  function businessFingerprint(state){
   if(!state)return '';
   const queries=Array.isArray(state.queries)?state.queries:[];
   const responses=Array.isArray(state.responses)?state.responses:[];
   const last=responses.length?responses[responses.length-1]:null;
   return [
    typeof state.url==='string'?state.url:'',
    queries.length,responses.length,
    last&&typeof last.answer==='string'?last.answer.length:-1,
    last&&last.complete===true?1:0,
    state.generates===true?1:0,
    page.hasStop(state)?1:0
   ].join('|');
  }
  function ownedAnswer(state,marker,beforeResponses){
   if(!state)return '';
   const queries=Array.isArray(state.queries)?state.queries:[];
   const responses=Array.isArray(state.responses)?state.responses:[];
   const hit=page.isMarkerLast(queries,marker);
   if(hit.count!==1||!hit.last||queries.length!==responses.length)return '';
   const index=queries.findIndex(query=>String(query||'').includes(marker));
   if(index<0||index<beforeResponses)return '';
   const response=responses[index];
   return response&&typeof response.answer==='string'?response.answer:'';
  }
  function turnResponseFor(state,marker,beforeResponses){
   if(!state)return null;
   const queries=Array.isArray(state.queries)?state.queries:[];
   const responses=Array.isArray(state.responses)?state.responses:[];
   const hit=page.isMarkerLast(queries,marker);
   if(hit.count!==1||!hit.last||queries.length!==responses.length)return null;
   const index=queries.findIndex(query=>String(query||'').includes(marker));
   if(index<0||index<beforeResponses)return null;
   return {index,response:responses[index]||null};
  }
  // Turn-local model evidence. Only the response belonging to this task's
  // marker may update the actual model or carry a routing warning; an older
  // conversation notice can never downgrade the current turn.
  function applyTurnModelEvidence(task,state,{commit=true}={}){
   if(!state||!task||task.closed)return false;
   const saved=resultOf(task.ledger);
   const prior=isPlainObject(task.ledger.metadata.model_policy)?task.ledger.metadata.model_policy:{};
   const turn=turnResponseFor(state,task.ledger.marker,task.machine.beforeResponses);
   const fields=policy.evaluateTurn({
    requestedModel:saved.requested_model||task.wire.model,
    selectedModel:saved.selected_model||prior.selected_model||null,
    requestedThinking:saved.requested_thinking,
    presendThinkingVerified:prior.presend_thinking_verified===true,
    fallbackReason:prior.fallback_approved===true?(prior.approved_fallback_reason||prior.fallback_reason):null,
    mode:saved.actual_mode||saved.requested_mode||prior.actual_mode||prior.requested_mode||task.wire.mode,
    requestedMode:saved.requested_mode||prior.requested_mode||task.wire.mode,
    thinkingControl:prior.thinking_control||saved.thinking_control,
    response:turn?turn.response:null,
    turnIndex:turn?turn.index:null,
    state
   });
   const priorWarning=saved.routing_warning||(saved.evidence&&typeof saved.evidence.warning==='string'?saved.evidence.warning:null);
   if(priorWarning&&!fields.routing_warning){
    // A routing notice observed on this turn must not be erased by a later
    // sample that merely omits the notice.
    fields.routing_warning=priorWarning;
    fields.policy_status='unsatisfied';
    fields.policy_code=policy.POLICY_CODE;
    fields.fallback_reason='routing_warning';
    fields.model_verified=false;
    fields.thinking_level='unknown';
    fields.thinking_verified=false;
   }
   const mergedEvidence={...(saved.evidence||{}),...(fields.evidence||{})};
   if(priorWarning&&!mergedEvidence.warning)mergedEvidence.warning=priorWarning;
   let next={...saved,...fields,evidence:mergedEvidence};
   // Keep collecting the original turn. A routing warning is evidence, not a
   // terminal state: only the strict DOM completion path may record the policy
   // as unsatisfied together with terminal evidence. The raw warning stays in
   // evidence so a later sample that omits it cannot erase it.
   const settled=task.generationSettled===true||['completed','failed','partial'].includes(task.ledger.status);
   if(!settled&&next.policy_status==='unsatisfied'){
    next={...next,policy_status:'pending',policy_code:null,policy_satisfied:false,routing_warning:null,fallback_reason:next.fallback_reason==='routing_warning'?null:next.fallback_reason};
   }
   const evidenceSame=String(saved.evidence&&saved.evidence.warning||'')===String(next.evidence&&next.evidence.warning||'');
   if(policy.policyFingerprint(saved)===policy.policyFingerprint(next)&&evidenceSame)return false;
   task.ledger.result=next;
   task.ledger.metadata.model_policy={
    ...prior,
    actual_model:next.actual_model,model_verified:next.model_verified,
    requested_mode:next.requested_mode,actual_mode:next.actual_mode,thinking_control:next.thinking_control,
    thinking_level:next.thinking_level,thinking_verified:next.thinking_verified,
    policy_status:next.policy_status,policy_code:next.policy_code,fallback_reason:next.fallback_reason
   };
   task.ledger.metadata.model_diagnostic=page.modelDiagnostic(state);
   if(commit){try{commitSnapshot(task,{reason:'model-evidence'});}catch{}}
   return true;
  }
  // Native lifecycle notifications prefix the conversation id with 'c_'. The
  // repaint hint accepts exactly the raw URL id or that single observed prefix.
  function nativeConversationMatches(nativeId,urlId){
   if(typeof nativeId!=='string'||typeof urlId!=='string'||!nativeId||!urlId)return false;
   return nativeId===urlId||nativeId==='c_'+urlId;
  }
  function repaintRecord(ledger){
   let record=ledger.metadata.render_repaint;
   if(!isPlainObject(record)){record={count:0,entries:[],last:null};ledger.metadata.render_repaint=record;}
   if(!Array.isArray(record.entries))record.entries=[];
   record.entries=record.entries.filter(entry=>isPlainObject(entry));
   syncRepaintRecord(record);
   return record;
  }
  function syncRepaintRecord(record){
   record.count=record.entries.length;
   record.last=record.entries.length?record.entries[record.entries.length-1]:null;
   if(record.last){
    record.generation=record.last.generation;
    record.diagnostic_seq=record.last.diagnostic_seq;
    record.at=record.last.at;
    record.outcome=record.last.outcome;
   }else{
    delete record.generation;delete record.diagnostic_seq;delete record.at;delete record.outcome;
   }
  }
  // Persist repaint bookkeeping without letting commitSnapshot recompute the
  // status/error fields; a repaint hint must never change FSM evidence.
  function persistRepaint(task){
   const ledger=task.ledger;
   ledger.revision=ledger.revision+1;
   persist(ledger);
   publishSnapshot(ledger);
  }
  // One-shot, event-driven repaint request for a hidden WebContentsView whose
  // rAF diagnostic never completed. It only schedules a native repaint: it does
  // not read the page, capture frames, show/focus the window, navigate, or
  // change FSM completion eligibility. Every request is persisted before the
  // call and deduplicated per observer generation, with a hard cap per task.
  function maybeRepaint(task,state,event={}){
   if(!task||task.closed||task.generationSettled)return false;
   if(!state||typeof state!=='object'||Array.isArray(state))return false;
   const host=taskObservation(task);
   if(!host||host.taskId!==task.id)return false;
   const binding=host.binding;
   if(!binding||binding.task_id!==task.id)return false;
   const generation=Number.isInteger(event.generation)?event.generation:binding.generation;
   if(generation!==binding.generation)return false;
   if(event.bindingId&&event.bindingId!==binding.bindingId)return false;
   const machine=task.machine;
   if(!machine||!machine.armed||machine.terminal)return false;
   const ledger=task.ledger;
   const confirmed=ledger.phases&&ledger.phases.confirmed;
   const confirmedUrl=confirmed&&typeof confirmed.url==='string'?confirmed.url:null;
   if(!confirmedUrl||!page.hasConversationId(confirmedUrl))return false;
   if(typeof state.url!=='string'||!page.sameConversation(state.url,confirmedUrl))return false;
   const urlId=page.conversationId(confirmedUrl);
   const nativeComplete=machine.nativeComplete;
   if(!nativeComplete||nativeComplete.phase!=='complete'||nativeComplete.task_id!==task.id)return false;
   if(!urlId||!nativeConversationMatches(nativeComplete.conversationId,urlId))return false;
   const queries=Array.isArray(state.queries)?state.queries:[];
   const responses=Array.isArray(state.responses)?state.responses:[];
   const hit=page.isMarkerLast(queries,ledger.marker);
   if(hit.count!==1||!hit.last||queries.length!==responses.length)return false;
   const index=queries.findIndex(query=>String(query||'').includes(ledger.marker));
   if(index<0||index<machine.beforeResponses)return false;
   const response=responses[index];
   if(!response||response.complete===true)return false;
   const diagnostic=page.connectionDiagnostic(state).renderer_diagnostic;
   if(!diagnostic||diagnostic.supported!==true||!diagnostic.requested_at)return false;
   if(diagnostic.completed_at!==null||!diagnostic.timer_fired_at)return false;
   if(diagnostic.generation!==binding.generation)return false;
   const record=repaintRecord(ledger);
   if(record.entries.length>=2)return false;
   if(record.entries.some(entry=>entry.generation===binding.generation))return false;
   const entry={generation:binding.generation,diagnostic_seq:diagnostic.seq,at:nowIso(now()),outcome:'requested'};
   record.entries.push(entry);syncRepaintRecord(record);
   try{persistRepaint(task);}
   catch(error){
    record.entries.pop();syncRepaintRecord(record);
    if(!instance.closed)log('error','repaint intent persist failed: '+(error.message||error));
    return false;
   }
   const targetWc=taskWc(task);
   if(typeof targetWc.invalidate!=='function'){
    entry.outcome='unsupported';
   }else{
    try{targetWc.invalidate();entry.outcome='called';}
    catch(error){
     entry.outcome='failed';
     entry.error=err(error.code||'REPAINT_FAILED',error.message||'invalidate 失败');
    }
   }
   syncRepaintRecord(record);
   try{persistRepaint(task);}
   catch(error){if(!instance.closed)log('error','repaint result persist failed: '+(error.message||error));}
   return true;
  }
  function generationActive(state){
   if(!state)return false;
   return page.hasStop(state)||state.generates===true;
  }
  function scheduleIdle(task){
   if(task.generationSettled||task.idleArmed||task.idleTimer!==null)return;
   const seq=task.idleSeq+1;
   task.idleSeq=seq;
   task.idleTimer=setTimer(()=>{
    task.idleTimer=null;
    if(task.generationSettled)return;
    task.idleArmed=true;
    runIdleDiagnostic(task,seq).catch(()=>{});
   },idleMs);
   if(task.idleTimer&&typeof task.idleTimer.unref==='function')task.idleTimer.unref();
  }
  async function runIdleDiagnostic(task,seq){
   task.ledger.metadata.idle_ping_at=nowIso(now());
   let ok=false,error=null;
   try{await taskObservation(task).ping({deadlineMs:pingMs});ok=true;}catch(failure){error=failure;}
   // A business change during the ping already opened a newer idle window; the
   // older run must not re-arm or overwrite the newer diagnostic.
   if(task.generationSettled||task.idleSeq!==seq)return;
   const ledger=task.ledger;
   ledger.metadata.idle_ping_ok=ok;
   if(error)ledger.metadata.idle_ping_error=err(error.code||'PING_FAILED',error.message);
   else delete ledger.metadata.idle_ping_error;
   if(!ok){
    // A failed ping means the observer binding can no longer be trusted for
    // completion evidence. Invalidate the evidence; never fake a terminal.
    ledger.metadata.idle_still_generating=false;
    delete ledger.metadata.idle_has_answer;
    ledger.metadata.completion_unverified=true;
    ledger.metadata.completion_unverified_reason='idle_ping_failed';
    task.machine.noteFault({code:'IDLE_PING_FAILED',message:'空闲诊断 ping 失败，完成状态未验证',at:now()});
    try{commitSnapshot(task,{reason:'idle-diagnostic',error:err('COMPLETION_UNVERIFIED','空闲诊断 ping 失败，完成状态未验证')});}catch{}
    return;
   }
   // The ping asks the observer to report a fresh fixed state before its pong.
   const state=taskObservation(task).currentState||task.machine.lastState||null;
   if(generationActive(state)){
    // Healthy observer and explicit generation evidence: keep the native pair
    // and any pending candidate, and report the healthy in-progress state.
    clearIdleDiagnostic(ledger);
    ledger.metadata.idle_still_generating=true;
    try{commitSnapshot(task,{reason:'idle-healthy'});}catch{}
    // Generation is still explicit: wait again and re-check after another full
    // idle interval without business changes.
    if(!task.generationSettled&&task.idleSeq===seq){task.idleArmed=false;scheduleIdle(task);}
    return;
   }
   ledger.metadata.idle_still_generating=false;
   if(task.machine.candidate||task.machine.phase==='verifying_completion'){
    // Completion evidence already exists; the stability window decides.
    clearIdleDiagnostic(ledger);
    ledger.metadata.idle_still_generating=false;
    try{commitSnapshot(task,{reason:'idle-diagnostic'});}catch{}
    return;
   }
   const answer=ownedAnswer(state,ledger.marker,task.machine.beforeResponses)||task.machine.answer||'';
   ledger.metadata.completion_unverified=true;
   ledger.metadata.completion_unverified_reason=answer?'idle_answer_unverified':'idle_ping_no_progress';
   ledger.metadata.idle_has_answer=!!answer;
   try{commitSnapshot(task,{reason:'idle-diagnostic'});}catch{}
  }
  // Total execution budget: fixed 30 minutes by default, anchored at the first
  // client-side start (queue waiting excluded) and persisted as an absolute
  // deadline so recovery resumes the remaining time instead of restarting it.
  // An explicit wire timeoutMs keeps its previous meaning.
  function ensureBudget(task){
   const ledger=task.ledger;
   const saved=ledger.metadata.budget;
   if(isPlainObject(saved)&&Number.isInteger(saved.ms)&&Number.isFinite(saved.deadline_ms))return saved;
   const explicit=Number.isInteger(task.wire&&task.wire.timeoutMs)?task.wire.timeoutMs:Number.isInteger(ledger.timeoutMs)?ledger.timeoutMs:null;
   const ms=explicit===null?DEFAULT_BUDGET_MS:Math.min(Math.max(explicit,20000),DEFAULT_BUDGET_MS);
   const created=Date.parse(ledger.created_at);
   const started=Number.isFinite(created)?Math.min(created,now()):now();
   const budget={ms,started_at:nowIso(started),deadline_ms:started+ms,deadline_at:nowIso(started+ms)};
   ledger.metadata.budget=budget;
   persist(ledger);
   return budget;
  }
  function expireBudget(task,budget){
   if(task.generationSettled)return;
   const ledger=task.ledger;
   if(ledger.metadata.budget_exhausted)return;
   if(!ledger.phases.send_intent){
    finishUnsentBudget(task,budget);
    task.abort.abort(page.PageError('BUDGET_EXHAUSTED','任务总预算已用完，未发送'));
    return;
   }
   ledger.metadata.budget_exhausted=true;
   ledger.metadata.budget_ms=budget.ms;
   ledger.metadata.budget_expired_at=nowIso(now());
   const current=resultOf(ledger);
   const answer=task.machine.answer||current.answer;
   // The sent turn is never navigated, resent, or released here: keep observing
   // passively until real completion or conflict.
   try{commitSnapshot(task,{status:'partial',result:{...current,answer,partial:true,complete:false,budget_exhausted:true},error:err('BUDGET_EXHAUSTED','任务总预算已用完，观察继续等待真实完成或冲突'),reason:'budget'});}catch{}
  }
  function armBudget(task){
   const budget=ensureBudget(task);
   if(task.ledger.metadata.budget_exhausted)return;
   const remaining=budget.deadline_ms-now();
   if(remaining<=0){expireBudget(task,budget);return;}
   task.budgetTimer=setTimer(()=>{
    task.budgetTimer=null;
    expireBudget(task,budget);
   },remaining);
   if(task.budgetTimer&&typeof task.budgetTimer.unref==='function')task.budgetTimer.unref();
  }
  // Budget exhausted before the single send click: stop explicitly without
  // sending, navigating, or taking over the client.
  function finishUnsentBudget(task,budget){
   const ledger=task.ledger;
   ledger.metadata.budget_exhausted=true;
   ledger.metadata.budget_ms=budget.ms;
   ledger.metadata.budget_expired_at=nowIso(now());
   const current=resultOf(ledger);
   try{commitSnapshot(task,{phase:'uncertain',status:'failed',result:{...current,partial:false,complete:false,budget_exhausted:true},error:err('BUDGET_EXHAUSTED','任务总预算已用完，未发送'),terminal:{at:nowIso(now()),status:'failed'},reason:'budget-unsent'});}catch{}
  }
  function waitGeneration(task){
   return new Promise(resolve=>{
    let done=false;
    const cleanups=[];
    // A reload/navigation invalidates the observer binding; the host rebinds to
    // the same task id. Machine URL/marker checks decide whether the new
    // document still belongs to this task.
    const softFaults=new Set(['CLIENT_SHELL','NAVIGATION','NAVIGATED','LOAD_FAILED','OBSERVER_WAITING']);
    const cleanup=()=>{
     for(const fn of cleanups.splice(0)){try{fn();}catch{}}
     clearTaskTimer(task,'idle');clearTaskTimer(task,'budget');
    };
    const finish=outcome=>{
     if(done)return;
     done=true;task.generationSettled=true;
     cleanup();resolve(outcome);
    };
    task.finishGeneration=finish;
    const markBusinessProgress=(state,answerRevision)=>{
     const fingerprint=businessFingerprint(state);
     const progressed=fingerprint!==task.lastBusinessFingerprint||task.machine.answerRevision!==answerRevision;
     task.lastBusinessFingerprint=fingerprint;
     if(!progressed)return;
     task.idleArmed=false;
     clearTaskTimer(task,'idle');
     scheduleIdle(task);
     const metadata=task.ledger.metadata;
     metadata.last_activity=now();
     if(metadata.completion_unverified!==undefined||metadata.completion_unverified_reason!==undefined||metadata.idle_still_generating!==undefined){
      clearIdleDiagnostic(task.ledger);
      try{commitSnapshot(task,{reason:'progress'});}catch{}
     }
    };
    const onState=(state,meta)=>{
     if(done)return;
     task.lastStateAt=now();
     task.ledger.metadata.last_state_at=nowIso(now());
     const answerRevision=task.machine.answerRevision;
     const fault=pageFaultOf(state);
     if(fault&&softFaults.has(fault.code)){markBusinessProgress(state,answerRevision);return;}
     if(fault){finish({type:'fault',code:fault.code,message:fault.message});return;}
    try{applyTurnModelEvidence(task,state);}catch(error){if(!instance.closed)log('error','model evidence failed: '+(error.message||error));}
    task.machine.ingest(state,meta);
    if(done)return;
    markBusinessProgress(state,answerRevision);
    if(!done){
     try{maybeRepaint(task,state,{generation:meta&&meta.generation,bindingId:meta&&meta.bindingId,source:'state'});}
     catch(error){if(!instance.closed)log('error','repaint state diagnostic failed: '+(error.message||error));}
    }
   };
    const onFault=fault=>{
     if(done)return;
     const code=fault&&fault.code||'OBSERVATION_FAULT';
     if(softFaults.has(code))return;
     finish({type:'fault',code,message:fault&&fault.message||'观察器故障'});
    };
    const onComplete=outcome=>finish({type:'complete',outcome});
    const onConflict=outcome=>finish({type:'conflict',outcome});
    const onAbort=()=>finish({type:'abort',code:'BRIDGE_CLOSED',message:'桥已关闭'});
    const host=taskObservation(task);
    host.on('state',onState);cleanups.push(()=>host.removeListener('state',onState));
    host.on('fault',onFault);cleanups.push(()=>host.removeListener('fault',onFault));
    task.machine.once('complete',onComplete);cleanups.push(()=>task.machine.removeListener('complete',onComplete));
    task.machine.once('conflict',onConflict);cleanups.push(()=>task.machine.removeListener('conflict',onConflict));
    if(task.abort.signal.aborted){onAbort();return;}
    task.abort.signal.addEventListener('abort',onAbort,{once:true});
    cleanups.push(()=>{try{task.abort.signal.removeEventListener('abort',onAbort);}catch{}});
    task.machine.arm();
    if(done)return;
    scheduleIdle(task);
    if(host.currentState)onState(host.currentState,{source:'current'});
   });
  }
  function finalizeOutcome(task,outcome){
   const ledger=task.ledger;
   if(!outcome||!outcome.type)throw page.PageError('INTERNAL','生成观察未返回结果');
   if(outcome.type==='complete'){
    const out=outcome.outcome||{};
    // Compute the final policy fields without an intermediate snapshot, so the
    // terminal record and MODEL_POLICY_UNSATISFIED are written in one commit.
    try{applyTurnModelEvidence(task,taskObservation(task)&&taskObservation(task).currentState||null,{commit:false});}catch{}
    const current=resultOf(ledger);
    const result={...current,answer:typeof out.answer==='string'?out.answer:current.answer,url:out.url||current.url,submission_confirmed:true,marker:ledger.marker,complete:true,partial:false};
    if(current.budget_exhausted)result.budget_exhausted=true;
    const policyError=policy.errorFor(result);
    ledger.metadata.completion=out.diagnostics&&out.diagnostics.completion?out.diagnostics.completion:{completed_at:out.completed_at||nowIso(now()),stable_ms:stableMs};
    ledger.metadata.diagnostics=out.diagnostics||null;
    clearIdleDiagnostic(ledger);
    ledger.phases.terminal={at:nowIso(now()),status:'completed'};
    commitSnapshot(task,{phase:'completed',status:'completed',result,error:policyError,reason:'completed'});
    return;
   }
   if(outcome.type==='conflict'){
    const out=outcome.outcome||{};
    const failure=classifyFailure(task,page.PageError(out.code||'MACHINE_CONFLICT',out.message||out.code||'状态机判定冲突'));
    ledger.metadata.diagnostics=out.diagnostics||null;
    const phase=failure.status==='needs_user_action'?'needs_user_action':failure.status==='uncertain'?'uncertain':ledger.phase;
    const current=resultOf(ledger);
    const patch={phase,status:failure.status,error:failure.error,reason:'conflict'};
    if(failure.status==='needs_user_action'||failure.status==='uncertain')patch.result={...current,answer:current.answer||out.answer||''};
    if(TERMINAL.has(failure.status))patch.terminal={at:nowIso(now()),status:failure.status};
    commitSnapshot(task,patch);
    return;
   }
   if(outcome.type==='fault')throw page.PageError(outcome.code||'OBSERVATION_FAULT',outcome.message||'观察器报告故障');
   throw BridgeError(outcome.code||'BRIDGE_CLOSED',outcome.message||'桥已关闭',503);
  }
  function handleRunFailure(task,error){
   if(task.closed)return;
   const failure=classifyFailure(task,error);
   let phase=task.ledger.phase;
   if(failure.status==='needs_user_action')phase='needs_user_action';
   else if(failure.status==='uncertain'||failure.status==='failed')phase='uncertain';
   const patch={phase,status:failure.status,error:failure.error,reason:'failure'};
   if(TERMINAL.has(failure.status))patch.terminal={at:nowIso(now()),status:failure.status};
   try{commitSnapshot(task,patch);}catch{}
   if(error&&error.stack)log('error',`task ${task.id} ${failure.error.code}: ${error.message}`);
  }
  async function runTask(task){
   try{
    acquireUiLock(task);
    await attachSession(task);
    attachThrottle(taskWc(task));
    const budget=ensureBudget(task);
    commitSnapshot(task,{phase:'preparing',status:'connecting',reason:'start'});
    if(now()>=budget.deadline_ms){finishUnsentBudget(task,budget);return;}
    armBudget(task);
    await prepareExecution(task);
    // Preparation counts toward the total budget; an expired task must never
    // reach send_intent or the single send click.
    if(now()>=budget.deadline_ms){finishUnsentBudget(task,budget);return;}
    task.machine.setPhase('awaiting_confirmation');
    task.ledger.phases.send_intent={at:nowIso(now())};
    task.ledger.metadata.send_intent_at=nowIso(now());
    // fsync the intent (and its journal snapshot) before the only send click.
    commitSnapshot(task,{phase:'awaiting_confirmation',status:'submitting',reason:'send-intent'});
    await page.sendOnce(taskWc(task));
    await confirmSubmission(task);
    // The composer is free once this turn is confirmed and generating.
    releaseUiLock(task);
    const outcome=await waitGeneration(task);
    finalizeOutcome(task,outcome);
   }catch(error){
    if(!task.ledger.metadata.budget_exhausted||task.ledger.phases.send_intent)handleRunFailure(task,error);
   }finally{
    cleanupTask(task);
   }
  }
  async function recoverTask(task){
   try{
    await attachSession(task,{recover:true});
    attachThrottle(taskWc(task));
    // Reuse the persisted deadline; recovery never restarts the budget.
    ensureBudget(task);
    armBudget(task);
    const saved=resultOf(task.ledger);
    if(!saved.url||!page.hasConversationId(saved.url))throw page.PageError('RECOVERY_UNAVAILABLE','缺少带会话 id 的已确认 URL，不能自动恢复');
    await bindObservation(task);
    let state=await waitReady(task,prepareMs);
    if(hasPageContent(state)&&!page.sameConversation(state.url,saved.url))throw page.PageError('DRAFT_PRESENT','当前页面有未发送内容，未覆盖或丢弃草稿');
    if(page.hasStop(state)&&!page.isMarkerLast(state.queries||[],task.ledger.marker).last&&!page.sameConversation(state.url,saved.url))throw page.PageError('PAGE_BUSY','Gemini 正在生成其他回答，请等待完成');
    if(!page.sameConversation(state.url,saved.url)){
     acquireUiLock(task);
     const session=task.session||instance.primarySession;
     if(session)session.navigating=true;
     try{
      await page.navigateTo(taskWc(task),saved.url);
      state=await waitReady(task,prepareMs);
     }finally{if(session)session.navigating=false;releaseUiLock(task);}
     if(hasPageContent(state))throw page.PageError('DRAFT_PRESENT','当前页面有未发送内容，未覆盖或丢弃草稿');
    }
    task.machine.configure({beforeResponses:saved.beforeResponses,confirmedUrl:saved.url,taskId:task.id});
    task.machine.arm();
    // A resumed task keeps the persisted partial status after budget expiry.
    const resumedStatus=task.ledger.metadata.budget_exhausted?'partial':'generating';
    commitSnapshot(task,{phase:'generating',status:resumedStatus,metadata:{recovered_at:nowIso(now())},reason:'recover'});
    const outcome=await waitGeneration(task);
    finalizeOutcome(task,outcome);
   }catch(error){
    handleRunFailure(task,error);
   }finally{
    cleanupTask(task);
   }
  }
  // The original observed page can publish its conversation id after the
  // bounded confirmation window. Recovery still has the recorded send intent
  // and marker, so it may sample only that recorded page read-only. It never
  // sends, navigates, clicks, opens a view, or accepts a marker from another
  // conversation.
  function lateBindExpectedUrls(task){
   const urls=[];
   const add=value=>{if(typeof value==='string'&&page.hasConversationId(value)&&!urls.some(url=>page.sameConversation(url,value)))urls.push(value);};
   add(task.wire&&task.wire.conversation_url);
   add(task.ledger.input&&task.ledger.input.conversation_url);
   add(resultOf(task.ledger).url);
   add(task.ledger.phases&&task.ledger.phases.marker_seen&&task.ledger.phases.marker_seen.url);
   return urls;
  }
  function lateBindEvidence(task,state){
   const queries=Array.isArray(state&&state.queries)?state.queries:[];
   const responses=Array.isArray(state&&state.responses)?state.responses:[];
   const hit=markerHit(state,task.ledger.marker);
   const index=hit.count===1?queries.findIndex(query=>String(query||'').includes(task.ledger.marker)):-1;
   const before=Number.isInteger(task.machine.beforeResponses)?task.machine.beforeResponses:0;
   const url=validGeminiUrl(state.url);
   const urlId=page.conversationId(url);
   const expected=lateBindExpectedUrls(task);
   const mismatch=!!urlId&&expected.some(candidate=>!page.sameConversation(url,candidate));
   return {hit,index,before,url,urlId,mismatch,expected,queries:queries.length,responses:responses.length};
  }
  function lateBindSession(task){
   const target=task.ledger.phases.marker_seen;
   // WebContents IDs may be reused after an app restart. The bridge UUID
   // ties the session recorded at send time to this specific process lifetime.
   if(task.ledger.binding_id!==bindingId)return {error:'LATE_BIND_TARGET_LOST'};
   if(typeof target.session_id!=='string')return {error:'LATE_BIND_TARGET_UNKNOWN'};
   const session=instance.sessions.get(target.session_id);
   if(!session||session.wc.isDestroyed?.())return {error:'LATE_BIND_TARGET_LOST'};
   if(target.web_contents_id!==null&&target.web_contents_id!==session.wc.id)return {error:'LATE_BIND_TARGET_CHANGED'};
   if(!session.observation)return {error:'LATE_BIND_OBSERVATION_UNAVAILABLE'};
   if(session.taskId&&session.taskId!==task.id)return {error:'LATE_BIND_TARGET_BUSY'};
   if(session.lateBindTaskId&&session.lateBindTaskId!==task.id)return {error:'LATE_BIND_TARGET_BUSY'};
   return {session};
  }
  function lateBindDiagnostic(task,stage,evidence,extra={}){
   return {
    stage,at:nowIso(now()),url:evidence?.url||null,
    marker_count:evidence?evidence.hit.count:null,marker_last:!!(evidence&&evidence.hit.last),
    query_count:evidence?evidence.queries:null,response_count:evidence?evidence.responses:null,
    expected_urls:evidence?evidence.expected.slice(0,4):[],...extra
   };
  }
  function recordLateBindError(task,diagnostic){
   task.ledger.metadata.late_bind={...metadataOf(task.ledger).late_bind,last_error:diagnostic};
  }
  function lateBindFailure(task,code,message,stage,evidence,extra={}){
   const diagnostic=lateBindDiagnostic(task,stage,evidence,extra);
   recordLateBindError(task,diagnostic);
   return page.PageError(code,message,diagnostic);
  }
  async function lateBindTask(task){
   try{
    if(!acquireUiLock(task))throw BridgeError('BUSY','页面仍由另一个任务占用，不能执行迟到会话绑定',409);
    ensureBudget(task);
    armBudget(task);
    const resolved=lateBindSession(task);
    if(resolved.error){
     const message={
      LATE_BIND_TARGET_LOST:'原观察页面已不存在；保持未确认，不切换页面、不新建会话',
      LATE_BIND_TARGET_CHANGED:'原观察页面的标识已变化；保持未确认，不切换到其他页面',
      LATE_BIND_TARGET_UNKNOWN:'没有可靠的原观察目标；保持未确认，不猜测页面',
      LATE_BIND_TARGET_BUSY:'原观察页面正由其他任务使用；保持未确认，不劫持该页面',
      LATE_BIND_OBSERVATION_UNAVAILABLE:'原观察页面缺少观察器；保持未确认，不操作页面'
     }[resolved.error]||'无法定位原观察页面；保持未确认';
     throw page.PageError(resolved.error,message);
    }
    const session=resolved.session;
    bindSession(task,session);
    attachThrottle(taskWc(task));
    await bindObservation(task,{loadDocument:false});
    task.ledger.metadata.late_bind={...metadataOf(task.ledger).late_bind,session_id:session.id,extra:!!session.extra,started_at:nowIso(now())};
    let state;
    try{
     state=await waitForState(task,s=>{
      const evidence=lateBindEvidence(task,s);
      if(evidence.hit.count>1)return true;
      if(evidence.hit.count===1&&!evidence.hit.last)return true;
      if(evidence.hit.count===0&&(evidence.urlId||evidence.queries>0))return true;
      return evidence.hit.count===1&&evidence.hit.last&&!!evidence.urlId;
     },{deadlineMs:confirmationMs,label:'等待迟到的会话 URL',faultGate:true});
    }catch(error){
     const evidence=lateBindEvidence(task,taskObservation(task).currentState||{});
     if(error.code==='CHAT_NOT_READY'||error.code==='OBSERVATION_TIMEOUT'){
      throw lateBindFailure(task,'SEND_UNCONFIRMED_URL','恢复时仍未观察到带会话 id 的 URL；保持未确认且绝不重发','late-url-timeout',evidence);
     }
     const diagnostic=lateBindDiagnostic(task,'observation-fault',evidence,{fault:String(error.code||'INTERNAL')});
     recordLateBindError(task,diagnostic);
     if(error&&typeof error==='object'&&!error.details)error.details=diagnostic;
     throw error;
    }
    const evidence=lateBindEvidence(task,state);
    if(evidence.hit.count>1)throw lateBindFailure(task,'MARKER_DUPLICATED','迟到恢复看到多个任务标记，无法安全归属回答','conflict',evidence);
    if(evidence.hit.count===1&&!evidence.hit.last)throw lateBindFailure(task,'MARKER_NOT_LAST','迟到恢复发现任务标记后有其他用户消息，无法安全归属回答','conflict',evidence);
    if(evidence.hit.count===0)throw lateBindFailure(task,'MARKER_MISMATCH','迟到恢复的页面已找不到原任务标记，保持未确认','missing-marker',evidence);
    if(evidence.index<evidence.before)throw lateBindFailure(task,'MARKER_BEFORE_BASELINE','迟到恢复看到的标记早于本轮回答槽位，无法安全归属回答','stale-marker',evidence);
    if(evidence.mismatch)throw lateBindFailure(task,'CONVERSATION_CHANGED','迟到恢复出现带 id 的会话与目标任务会话不一致，保持未确认','url-mismatch',evidence);
    if(!evidence.urlId)throw lateBindFailure(task,'SEND_UNCONFIRMED_URL','迟到恢复仍未获得带会话 id 的 URL；保持未确认且绝不重发','late-url-timeout',evidence);
    const confirmedUrl=evidence.url;
    if(conversationBusy(confirmedUrl,task.id))throw page.PageError('CONVERSATION_BUSY','这个会话正由另一个任务占用，保持待确认');
    task.ledger.metadata.late_bind={...metadataOf(task.ledger).late_bind,resolved_at:nowIso(now()),resolved_url:confirmedUrl,last_error:null};
    if(session.lateBindTaskId===task.id)delete session.lateBindTaskId;
    recordConfirmedConversation(task,confirmedUrl,'late-bind-confirmed');
    releaseUiLock(task);
    const outcome=await waitGeneration(task);
    finalizeOutcome(task,outcome);
   }catch(error){
    handleRunFailure(task,error);
   }finally{
    cleanupTask(task);
   }
  }
  function cleanupTask(task){
   task.generationSettled=true;
   clearTaskTimer(task,'idle');clearTaskTimer(task,'budget');
   try{task.machine.dispose();}catch{}
   task.finishGeneration=null;
   task.run=null;
   releaseUiLock(task);
   const session=task.session;
   const keepForLateBind=lateBindPending(task.ledger);
   if(session){
    if(session.taskId===task.id)session.taskId=null;
    // Keep exactly the page that saw the marker; the next recovery may only
    // sample it read-only. Any other page is cleaned up normally.
    if(keepForLateBind&&!instance.closed)session.lateBindTaskId=task.id;
    else if(session.lateBindTaskId===task.id)delete session.lateBindTaskId;
   }
   instance.tasks.delete(task.id);
   if(instance.task===task)instance.task=[...instance.tasks.values()][0]||null;
   if(instance.activeId===task.id)instance.activeId=instance.uiLockId||(instance.task&&instance.task.id)||null;
   if(!instance.closed)instance.stopping=false;
   restoreThrottle();
   if(session)closeSessionIfUnused(session);
  }
  function start(task,runner){
   instance.tasks.set(task.id,task);
   instance.task=task;
   if(!instance.activeId)instance.activeId=task.id;
   task.run=runner(task);
   task.run.catch(error=>log('error',`task ${task.id} crashed: ${error.message}`));
  }
  function snapshot(taskId){
   if(typeof taskId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(taskId))throw BridgeError('BAD_REQUEST','task_id 无效',400);
   const live=currentTask(taskId);
   const ledger=live?live.ledger:readLedger(stateDir,taskId);
   if(!ledger)throw BridgeError('TASK_NOT_FOUND','未找到任务 '+taskId,404);
   if(!STATUSES.has(ledger.status))ledger.status='failed';
   return snapshotOf(ledger);
  }
  function syncQueue(){
   const byId=new Map();
   for(const ledger of listLedgers(stateDir)){
    if(!ledger.released)byId.set(ledger.task_id,ledger);
   }
   for(const [id,ledger] of byId){
    if(!PHASES.includes(ledger.phase))ledger.phase=inferPhase(ledger);
    ledger.revision=Number.isSafeInteger(ledger.revision)?ledger.revision:0;
   }
   for(const task of instance.tasks.values()){
    if(task.ledger&&!task.ledger.released)byId.set(task.id,task.ledger);
   }
   const tasks=Array.from(byId.values()).sort((a,b)=>{
    const left=String(a.updated_at||''),right=String(b.updated_at||'');
    return left===right?String(a.task_id).localeCompare(String(b.task_id)):left.localeCompare(right);
   }).map(ledger=>{
    const live=instance.tasks.get(ledger.task_id);
    const host=live?taskObservation(live):observation;
    const s=snapshotOf(ledger);
    s.metadata.execution_active=!!(live&&live.run);
    s.metadata.observer_task_bound=!!(host&&host.taskId===ledger.task_id&&host.binding);
    return s;
   });
   // Read the cursor after the snapshots in the same synchronous turn.
   return {instance_id:journal.instanceId,seq:journal.sequence,tasks};
  }
  function execute(taskWire){
   if(readOnly)throw BridgeError('READ_ONLY','当前补丁为只读模式，execute 被拒绝',403);
   const wire=validateWire(taskWire);
   const hash=contentHash(wire);
   let ledger=readLedger(stateDir,wire.id);
   if(ledger&&ledger.content_hash!==hash)throw BridgeError('CONFLICT','task_id 已用于不同内容，请使用新 task_id',409);
   if(ledger&&ledger.released)throw BridgeError('RELEASED','任务已由用户释放，不能继续执行',409);
   const live=currentTask(wire.id);
   if(live&&live.run)return snapshotOf(live.ledger);
   if(ledger&&TERMINAL.has(ledger.status))return snapshotOf(ledger);
   if(!ledger){
    const blocker=findBlocking(wire.id,wire);
    if(blocker)throw BridgeError('CONVERSATION_BUSY',`会话仍在生成任务 ${blocker.task_id} 的回复，请等待结束后再续聊`,409);
   }
   requireObservation();
   wire.marker=ledger?ledger.marker:wire.marker;
   if(!ledger)ledger=createTask(wire);
   else{ledger.binding_id=bindingId;}
   if(ledger.phases.send_intent){
    const saved=resultOf(ledger);
    if(ledger.phases.confirmed&&saved.url&&page.hasConversationId(saved.url)){
     const live=currentTask(ledger.task_id);
     if(live&&live.run)return snapshotOf(live.ledger);
     if(generationCount()>=MAX_GENERATING&&!persistedOccupying(ledger))throw BridgeError('GENERATION_LIMIT',`同时正在生成的对话已达上限 ${MAX_GENERATING}`,409);
     const task=taskFor(ledger,wire);
     start(task,recoverTask);
     return snapshotOf(ledger);
    }
    if(ledger.status!=='uncertain'&&ledger.status!=='needs_user_action'){
     const task=taskFor(ledger,wire);
     try{commitSnapshot(task,{phase:'uncertain',status:'uncertain',error:err('SEND_STATE_UNKNOWN','发送状态未知，绝不自动重发；需要人工确认后释放'),reason:'send-unknown'});}
     finally{task.machine.dispose();}
    }
    return snapshotOf(ledger);
   }
   if(generationCount()>=MAX_GENERATING)throw BridgeError('GENERATION_LIMIT',`同时正在生成的对话已达上限 ${MAX_GENERATING}`,409);
   if(wire.conversation_url){
    const blocker=conversationBusy(wire.conversation_url,ledger.task_id);
    if(blocker)throw BridgeError('CONVERSATION_BUSY',`会话仍在生成任务 ${blocker.task_id} 的回复，请等待结束后再续聊`,409);
   }
   const task=taskFor(ledger,wire);
   start(task,runTask);
   return snapshotOf(ledger);
  }
  function recover(taskId){
   const current=snapshot(taskId);
   const ledger=currentTask(taskId)?.ledger||readLedger(stateDir,taskId);
   if(!ledger)throw BridgeError('TASK_NOT_FOUND','未找到任务 '+taskId,404);
   if(ledger.released)throw BridgeError('RELEASED','任务已由用户释放，不能自动恢复',409);
   if(ledger.status==='completed')return current;
   const lateBind=lateBindPending(ledger);
   if(ledger.status==='failed'&&!ledger.phases.confirmed&&!lateBind)return current;
   const liveBusy=currentTask(taskId);
   if(liveBusy&&liveBusy.run)return snapshotOf(liveBusy.ledger);
   if(generationCount()>=MAX_GENERATING&&!persistedOccupying(ledger))throw BridgeError('GENERATION_LIMIT',`同时正在生成的对话已达上限 ${MAX_GENERATING}`,409);
   const saved=resultOf(ledger);
   const confirmedUrl=ledger.phases.confirmed&&saved.url&&page.hasConversationId(saved.url)?saved.url:null;
   if(!confirmedUrl&&!lateBind){
    if(ledger.status!=='uncertain'&&ledger.status!=='needs_user_action'){
     const temp=taskFor(ledger,{marker:ledger.marker,model:ledger.model,mode:ledger.mode||null,purpose:ledger.purpose,prompt:'',conversation_url:null,timeoutMs:ledger.timeoutMs===undefined?null:ledger.timeoutMs,attachments:[]});
     try{commitSnapshot(temp,{phase:'uncertain',status:'uncertain',error:err('RECOVERY_UNAVAILABLE','缺少已确认的原会话 id，不能自动恢复'),reason:'recover-unavailable'});}
     finally{temp.machine.dispose();}
    }
    return snapshotOf(ledger);
   }
   if(confirmedUrl)requireObservation();
   const live=currentTask(taskId);
   if(live&&live.run)return snapshotOf(live.ledger);
   // After cleanup the previous task keeps a disposed machine and may already
   // be aborted. Always start recovery with a fresh AbortController.
   if(instance.task===live)instance.task=null;
   const task=taskFor(ledger,{
    marker:ledger.marker,model:ledger.model,mode:ledger.mode||null,purpose:ledger.purpose,prompt:'',conversation_url:null,
    timeoutMs:ledger.timeoutMs===undefined?null:ledger.timeoutMs,attachments:[]
   });
   task.lateBinding=!confirmedUrl;
   start(task,confirmedUrl?recoverTask:lateBindTask);
   const recovered=snapshotOf(ledger);
   recovered.metadata.execution_active=!!currentTask(taskId)?.run;
   return recovered;
  }
  function releaseLateBindSession(taskId){
   for(const session of Array.from(instance.sessions.values())){
    if(session.lateBindTaskId!==taskId)continue;
    delete session.lateBindTaskId;
    if(!session.taskId)closeSessionIfUnused(session);
   }
  }
  function release(taskId){
   const live=currentTask(taskId);
   if(live&&live.run)throw BridgeError('RELEASE_DENIED','任务仍在执行，不能释放',409);
   const ledger=live?live.ledger:readLedger(stateDir,taskId);
   if(!ledger)throw BridgeError('TASK_NOT_FOUND','未找到任务 '+taskId,404);
   if(ledger.released)return snapshotOf(ledger);
   if(!TERMINAL.has(ledger.status)&&ledger.status!=='uncertain'&&ledger.status!=='needs_user_action')throw BridgeError('RELEASE_DENIED','只有终态或等待人工处理的任务可以释放',409);
   ledger.released=true;
   persist(ledger);
   releaseLateBindSession(taskId);
   if(instance.task===live)instance.task=[...instance.tasks.values()].find(item=>item!==live)||null;
   if(instance.activeId===taskId)instance.activeId=instance.uiLockId||(instance.task&&instance.task.id)||null;
   return snapshotOf(ledger);
  }
  function probeData(state,error){
   const slots=generationInfo();
   const base={bound_url:typeof wc.getURL==='function'?wc.getURL():null,connected:!!state&&!state.clientShell,patch_id:options.patchId||null,read_only:readOnly,active_task:instance.uiLockId||instance.activeId,app_version:appVersion,bridge_version:BRIDGE_VERSION,background_throttling:throttleDiagnostic(),generating_count:slots.generating_count,generating_limit:slots.generating_limit,generating_task_ids:slots.generating_task_ids,ui_lock:slots.ui_lock,active_tasks:slots.active_tasks,observer:observation?{bound:observationBound(),has_state:!!observation.currentState,last_event_at:instance.lastObservationAt||null,fault:instance.observationFault||null,diagnostics:observation.diagnostics,native_phases:observation.nativePhases}:null,page:state?page.connectionDiagnostic(state):null};
   if(error)base.error=error;
   else if(!state)base.error=err('OBSERVATION_NOT_READY','观察器尚未推送状态');
   return base;
  }
  async function probe(){
   let state=observation&&observation.currentState?observation.currentState:null;
   let error=null;
   if(!state){
    try{if(typeof wc.isDestroyed==='function'&&wc.isDestroyed())throw page.PageError('WC_DESTROYED','WebContents 已销毁');state=await page.observe(wc);}
    catch(failure){error=err(failure.code||'PROBE_FAILED',failure.message);}
   }
   return probeData(state,error);
  }
  // Fixed read-only startup handoff. Waits for the observer's pushed usable
  // state or an explicit page fault; never executes page scripts or navigates.
  async function readyOp(){
   let state=null,fault=null,warming=false;
   if(observation){
    try{
     state=await observation.waitFor(candidate=>!!readyFaultOf(candidate)||isReadyState(candidate),{deadlineMs:readyMs});
    }catch(error){
     if(error&&error.code==='OBSERVATION_TIMEOUT'){
      state=observation.currentState||null;
      fault=readyFaultOf(state);
      warming=!fault&&!isReadyState(state);
     }else{
      const base=probeData(observation.currentState||null,null);
      base.error=err(error&&error.code||'READY_FAILED',error&&error.message||'等待页面就绪失败');
      base.warming=false;
      return base;
     }
    }
   }
   if(state&&!fault)fault=readyFaultOf(state);
   if(!observation)return {...probeData(null,err('OBSERVATION_UNAVAILABLE','观察器未配置')),warming:false};
   if(warming){
    const bound=observationBound();
    const base=probeData(state,null);
    base.warming=true;
    base.error=err(bound?'BRIDGE_PAGE_NOT_READY':'OBSERVER_NOT_BOUND',bound?'Gemini 聊天页面仍在加载；尚未发送':'观察器尚未绑定页面；仍在等待聊天页面加载');
    return base;
   }
   const base=probeData(state,fault?err(fault.code,fault.message):null);
   base.warming=false;
   return base;
  }
  // Fixed read-only settings sample for one-time UI evidence. Accepts no
  // parameters, runs the single static page script, and changes nothing.
  async function inspectSettingsOp(){
   if(typeof wc.isDestroyed==='function'&&wc.isDestroyed())throw page.PageError('WC_DESTROYED','WebContents 已销毁');
   return page.inspectSettings(wc);
  }
  function menusVisible(state){
   if(!state||typeof state!=='object')return false;
   if(state.backdrop===true)return true;
   if(Array.isArray(state.models)&&state.models.some(item=>item&&item.visible!==false))return true;
   if(Array.isArray(state.thinkingOptions)&&state.thinkingOptions.some(item=>item&&item.visible!==false))return true;
   return false;
  }
  function capabilityBusyReason(){
   if(instance.capabilityInspection)return 'inspection_active';
   // settings_action reserves the page synchronously before its one-shot
   // observe await, so a capability query cannot open menus beside it.
   if(instance.settingsReservation)return 'settings_action';
   if(instance.uiLockId)return 'ui_lock';
   for(const task of instance.tasks.values())if(task.run||taskDriving(task)||occupyingGeneration(task))return 'task_active';
   if(generationCount()>0)return 'task_active';
   return null;
  }
  // The catalog reports only what the live menu exposes. An option id is used
  // only when it is unique and bounded; otherwise a unique complete name is the
  // selector. Nothing here is a production model list or a cached answer.
  function capabilitySelector(item,options){
   const id=typeof item.id==='string'?item.id:item.id===undefined||item.id===null?'':String(item.id);
   if(id){
    const selector=policy.normalizeModel(id);
    if(selector&&policy.resolveModelOptions(options,selector).matches.length===1)return selector;
   }
   const name=String(item.text||'').replace(/\s+/g,' ').trim();
   const selector=policy.normalizeModel(name);
   if(!selector)return null;
   if(policy.resolveModelOptions(options,selector).matches.length!==1)return null;
   return selector;
  }
  function capabilityModels(state){
   const options=policy.menuOptions(state);
   return options.map(item=>{
    const selector=capabilitySelector(item,options);
    const unavailableReason=policy.optionUnavailableReason(item)||(selector?null:'selector_unavailable');
    return {
     id:item.id||null,
     name:item.text,
     selector,
     selected:item.checked===true,
     disabled:item.disabled===true,
     restricted:policy.optionRestricted(item),
     available:unavailableReason===null,
     unavailable_reason:unavailableReason
    };
   });
  }
  function capabilityLevels(state){
   return policy.thinkingOptions(state).map(item=>({level:item.level,label:item.text,selected:item.checked===true,disabled:item.disabled===true}));
  }
  function capabilityBase(status,reason,extra={}){
   return {
    status,observed:false,observed_at:null,
    source:extra.source||'observation',reason:reason||null,
    models:[],modes:{current:'unknown',supported:['chat','task'],source:'contract',immutable_after_start:true},
    thinking:{status:'unknown',levels:[]},default_model:policy.DEFAULT_MODEL,...extra
   };
  }
  // Wait only on pushed observer state. No observe/poll loop, no page read.
  function checkCapabilityContext(host,inspection){
   if(instance.closed)throw page.PageError('CAPABILITY_ABORTED','桥已关闭');
   if(inspection?.interrupted)throw page.PageError('CAPABILITY_INTERRUPTED','用户已操作页面');
   const current=host&&host.binding,original=inspection&&inspection.binding;
   if(original&&(!current||current.bindingId!==original.bindingId||current.generation!==original.generation||current.documentId!==original.documentId))throw page.PageError('CAPABILITY_PAGE_CHANGED','查询期间页面绑定已变化');
   const state=host&&host.currentState;
   if(state?.truncated===true)throw page.PageError('CAPABILITY_TRUNCATED','页面观察被截断');
   return true;
  }
  async function waitCapabilityState(host,predicate,deadlineMs,label,inspection){
   let state;
   try{
    state=await host.waitFor(candidate=>{
     try{checkCapabilityContext(host,inspection);}catch{return true;}
     const fault=pageFaultOf(candidate);
     if(fault&&fault.code!=='CLIENT_SHELL')return true;
     try{return !!predicate(candidate);}catch{return false;}
    },{deadlineMs});
   }catch(error){
    if(error&&error.code==='OBSERVATION_TIMEOUT')throw page.PageError('CAPABILITY_TIMEOUT',label+'超时');
    if(error&&error.code==='OBSERVATION_CLOSED')throw page.PageError('CAPABILITY_ABORTED','观察器已关闭');
    throw error;
   }
   checkCapabilityContext(host,inspection);
   const fault=pageFaultOf(state);
   if(fault&&fault.code!=='CLIENT_SHELL')throw page.PageError(fault.code,fault.message);
   if(!predicate(state))throw page.PageError('CAPABILITY_TIMEOUT',label+'超时');
   return state;
  }
  async function dismissCapabilityMenus(){
   const result=await page.dismissMenus(wc);
   if(!result||result.ok!==true)throw page.PageError(result&&result.error||'DISMISS_FAILED','未能安全关闭本次打开的菜单');
   return result;
  }
  async function runCapability(inspection){
   const host=observation;
   let observedAt=null;
   let opened=false;
   let result=null;
   const interrupted=()=>inspection.interrupted===true||instance.closed;
   try{
    if(!host||!observationBound(host))return capabilityBase('blocked','page_unbound',{source:'none'});
    inspection.binding={...host.binding};
    let state=host.currentState||null;
    if(!state){
     try{state=await waitCapabilityState(host,()=>true,modelMs,'等待页面状态',inspection);}
     catch(error){return capabilityBase('unavailable','observation_unavailable',{source:'none'});}
    }
    if(interrupted())return capabilityBase('unavailable',instance.closed?'bridge_closed':'user_interference',{source:'none'});
    checkCapabilityContext(host,inspection);
    if(state.clientShell)return capabilityBase('blocked','client_shell');
    const fault=pageFaultOf(state);
    if(fault&&fault.code!=='CLIENT_SHELL')return capabilityBase('blocked',String(fault.code).toLowerCase());
    if(state.dialog)return capabilityBase('blocked','dialog');
    if(String(state.draft||'').trim())return capabilityBase('blocked','draft');
    if((state.uploads||[]).length)return capabilityBase('blocked','attachments');
    if(menusVisible(state))return capabilityBase('blocked','menu_open');
    const mode=policy.surfaceMode(state.surface&&state.surface.mode)||'unknown';
    let modes={current:mode,supported:['chat','task'],source:'contract',immutable_after_start:true};
    if(page.hasStop(state)||state.generates===true)return capabilityBase('busy','page_generating',{modes});
    opened=false;
    try{await page.openModelMenu(wc);opened=true;}
    catch(error){
     // A script timeout may hide a click that already opened the menu. Only
     // treat it as ours when the observer actually reports an open menu.
     opened=menusVisible(host.currentState);
     throw error;
    }
    if(interrupted()){
     result=capabilityBase('unavailable',instance.closed?'bridge_closed':'user_interference',{source:'none'});
    }else{
     state=await waitCapabilityState(host,candidate=>policy.menuReadyToDecide(candidate),modelMs,'等待模型菜单',inspection);
     const plan=policy.planSelection(state,'');
     if(!plan.menu_visible||!plan.options.length)result=capabilityBase('unavailable','menu_not_observed',{modes});
     else if(Array.isArray(state.models)&&state.models.length>40)result=capabilityBase('unavailable','menu_truncated',{modes});
     else{
      // A real menu sample is the only evidence for this catalog. Menu
      // selection is not proof that the model actually served a turn.
      observedAt=nowIso(now());
      const models=capabilityModels(state);
      let thinking={status:'unknown',levels:[]};
      {
       const entry=Number.isInteger(state.thinkingEntryCount)&&state.thinkingEntryCount>0;
       if(entry){
        try{
         checkCapabilityContext(host,inspection);
         await page.openThinkingMenu(wc);
         state=await waitCapabilityState(host,candidate=>policy.thinkingOptions(candidate).length>0,modelMs,'等待思考等级菜单',inspection);
         if(state.thinkingOptions.length>40)throw page.PageError('CAPABILITY_TRUNCATED','思考选项超过观察上限');
         thinking={status:'observed',levels:capabilityLevels(state)};
        }catch(error){
         checkCapabilityContext(host,inspection);
         if(error.code!=='CAPABILITY_TIMEOUT')throw error;
         thinking={status:'unknown',levels:[]};
        }
       }else if(mode==='task')thinking={status:'not_exposed',levels:[]};
      }
      result={status:'ready',observed:true,observed_at:observedAt,source:'observed_menu',reason:null,models,modes,thinking,default_model:policy.DEFAULT_MODEL};
     }
    }
   }catch(error){
    const code=error?.code==='CAPABILITY_PAGE_CHANGED'?'page_changed':error?.code==='CAPABILITY_INTERRUPTED'?'user_interference':error?.code==='CAPABILITY_TRUNCATED'?'observation_truncated':error?.code==='CAPABILITY_TIMEOUT'?'menu_not_observed':'observe_failed';
    result=capabilityBase('unavailable',code,{source:opened?'observation':'none'});
  }finally{
   let sameContext=true,contextCode=null;
   try{checkCapabilityContext(host,inspection);}catch(error){sameContext=false;contextCode=error&&error.code||null;}
   if(opened&&sameContext&&!inspection.interrupted&&!instance.closed){
    try{
     await dismissCapabilityMenus();
     await waitCapabilityState(host,candidate=>!menusVisible(candidate),modelMs,'等待菜单关闭',inspection);
    }catch(error){
     result=capabilityBase('unavailable','cleanup_unconfirmed',{observed:observedAt!==null,observed_at:observedAt,source:'observation'});
    }
   }else if(opened&&(!sameContext||inspection.interrupted||instance.closed)){
    // Keep the real context loss distinguishable: a truncated observation is
    // not a page change, and the caller needs the specific reason.
    const reason=instance.closed?'bridge_closed':inspection.interrupted?'user_interference':contextCode==='CAPABILITY_TRUNCATED'?'observation_truncated':'page_changed';
    result=capabilityBase('unavailable',reason,{source:'none'});
   }
  }
   return result||capabilityBase('unavailable','observe_failed',{source:'none'});
  }
  // A capability query reserves the page before its first await so no task can
  // start between the busy check and the first menu click. The lease is released
  // only after the fixed dismiss script and its observer confirmation settle.
  function capabilities(){
   const busy=capabilityBusyReason();
   if(busy)return Promise.resolve(capabilityBase('busy',busy,{source:'policy'}));
   if(instance.closed)return Promise.resolve(capabilityBase('unavailable','bridge_closed',{source:'none'}));
   if(readOnly)return Promise.resolve(capabilityBase('unavailable','read_only',{source:'policy'}));
   if(!observation||!observationBound(observation))return Promise.resolve(capabilityBase('blocked','page_unbound',{source:'none'}));
   const inspection={token:crypto.randomUUID(),interrupted:false,started_at:nowIso(now())};
   instance.capabilityInspection=inspection;
   return runCapability(inspection).catch(error=>capabilityBase('unavailable','observe_failed',{source:'none'})).finally(()=>{
    if(instance.capabilityInspection===inspection)instance.capabilityInspection=null;
   });
  }
  function dispatch(op,args){
   if(readOnly&&['execute','recover','release','settings_action'].includes(op))throw BridgeError('READ_ONLY','当前补丁为只读模式',403);
   if(!OPS.has(op))throw BridgeError('UNKNOWN_OP','未知 op：'+String(op),400);
   if(args!==undefined&&(args===null||typeof args!=='object'||Array.isArray(args)))throw BridgeError('BAD_REQUEST','参数必须是对象',400);
   const body=args||{};
   if(op==='probe')return probe();
   if(op==='ready')return readyOp();
   if(op==='settings_action'){
    if(instance.capabilityInspection)throw BridgeError('BUSY','能力查询正在检查页面菜单',409);
    if(instance.settingsReservation)throw BridgeError('BUSY','另一个设置操作正在检查页面',409);
    if(instance.uiLockId||taskDriving(taskForSession(instance.primarySession)))throw BridgeError('BUSY','客户端有任务占用',409);
    // Reserve before the first await. page.observe is a page read; a catalogue
    // query that slipped in between the busy check and this await could open
    // menus on the same page. The lease is always released in finally.
    const reservation={token:crypto.randomUUID(),at:nowIso(now())};
    instance.settingsReservation=reservation;
    return page.observe(wc).then(state=>{if(hasPageContent(state)||page.hasStop(state)||state.generates)throw BridgeError('DRAFT_PRESENT','页面有未发送内容或正在生成',409);return page.settingsAction(wc,body.action);}).finally(()=>{
     if(instance.settingsReservation===reservation)instance.settingsReservation=null;
    });
   }
   if(op==='inspect_settings'){
    if(body.task!==undefined||body.task_id!==undefined)throw BridgeError('BAD_REQUEST','inspect_settings 不接受任何参数',400);
    return inspectSettingsOp();
   }
   if(op==='capabilities'){
    if(body.task!==undefined||body.task_id!==undefined||body.action!==undefined)throw BridgeError('BAD_REQUEST','capabilities 不接受任何参数',400);
    return capabilities();
   }
   if(op==='execute'){
    if(instance.capabilityInspection)throw BridgeError('BUSY','能力查询正在检查页面菜单，拒绝创建任务',409);
    if(instance.settingsReservation)throw BridgeError('BUSY','设置操作正在检查页面，拒绝创建任务',409);
    return execute(body.task);
   }
   if(op==='snapshot')return snapshot(body.task_id);
   if(op==='recover'){
    if(instance.capabilityInspection)throw BridgeError('BUSY','能力查询正在检查页面菜单，拒绝恢复任务',409);
    if(instance.settingsReservation)throw BridgeError('BUSY','设置操作正在检查页面，拒绝恢复任务',409);
    return recover(body.task_id);
   }
   if(op==='sync'){
    if(body.task!==undefined||body.task_id!==undefined)throw BridgeError('BAD_REQUEST','sync 不接受 task_id',400);
    return syncQueue();
   }
   return release(body.task_id);
  }
  function respond(res,status,value){
   const data=Buffer.from(JSON.stringify(value),'utf8');
   try{res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':data.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(data);}catch{}
  }
  function readBody(req){
   return new Promise((resolve,reject)=>{
    const declared=Number(req.headers['content-length']);
    if(Number.isFinite(declared)&&declared>maxHTTPBytes){reject(BridgeError('PAYLOAD_TOO_LARGE','请求超过 40 MiB 上限',413));req.resume();return;}
    let size=0;const chunks=[];
    req.on('data',chunk=>{size+=chunk.length;if(size>maxHTTPBytes){reject(BridgeError('PAYLOAD_TOO_LARGE','请求超过 40 MiB 上限',413));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
   });
  }
  function authorize(req){
   const authorization=req.headers.authorization||'';
   if(!safeEqual(authorization,'Bearer '+token))throw BridgeError('UNAUTHORIZED','认证失败',401);
  }
  function parseCursor(value){
   if(value===undefined)return {instance_id:journal.instanceId,seq:journal.sequence};
   const match=/^([A-Za-z0-9-]{8,80}):(\d{1,15})$/.exec(String(value));
   if(!match)throw BridgeError('BAD_REQUEST','Last-Event-ID 必须为 uuid:seq',400);
   const seq=Number(match[2]);
   if(!Number.isSafeInteger(seq))throw BridgeError('BAD_REQUEST','Last-Event-ID 序号无效',400);
   return {instance_id:match[1],seq};
  }
  function closeSubscriptions(){
   for(const entry of Array.from(instance.subscriptions)){
    instance.subscriptions.delete(entry);
    try{entry.close?.();}catch{}
    try{entry.response.end();}catch{}
    try{entry.response.destroy();}catch{}
   }
  }
  function openEvents(req,res){
   if(instance.subscriptions.size>=4)throw BridgeError('TOO_MANY_SUBSCRIPTIONS','事件订阅已达上限 4',429);
   const cursor=parseCursor(req.headers['last-event-id']);
   res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff'});
   if(typeof res.flushHeaders==='function')res.flushHeaders();
   const entry={response:res,close:null};
   const cleanup=()=>{instance.subscriptions.delete(entry);try{entry.close?.();}catch{}};
   instance.subscriptions.add(entry);
   res.on('close',cleanup);
   entry.close=journal.subscribe(res,cursor,{heartbeatMs});
  }
  async function handleRequest(req,res){
   try{
    if(req.headers.host!==`127.0.0.1:${instance.port}`)throw BridgeError('FORBIDDEN','Host 不被允许',403);
    if(Object.prototype.hasOwnProperty.call(req.headers,'origin'))throw BridgeError('FORBIDDEN','不接受任何 Origin',403);
    if(req.url==='/events'){
     if(req.method!=='GET')throw BridgeError('METHOD_NOT_ALLOWED','只接受 GET',405);
     authorize(req);
     openEvents(req,res);
     return;
    }
    if(req.url!=='/rpc')throw BridgeError('NOT_FOUND','未找到接口',404);
    if(req.method!=='POST')throw BridgeError('METHOD_NOT_ALLOWED','只接受 POST',405);
    authorize(req);
    if(!/^application\/json\b/i.test(String(req.headers['content-type']||'')))throw BridgeError('UNSUPPORTED_MEDIA_TYPE','只接受 application/json',415);
    const raw=await readBody(req);
    let message;
    try{message=JSON.parse(raw.toString('utf8'));}catch{throw BridgeError('BAD_REQUEST','JSON 解析失败',400);}
    if(!message||typeof message!=='object'||Array.isArray(message))throw BridgeError('BAD_REQUEST','请求必须是对象',400);
    for(const key of Object.keys(message))if(!['op','task','task_id','action'].includes(key))throw BridgeError('BAD_REQUEST','请求含未知字段：'+key,400);
    if(typeof message.op!=='string')throw BridgeError('BAD_REQUEST','缺少 op',400);
    const data=await dispatch(message.op,message.op==='settings_action'?{action:message.action}:message.op==='execute'?{task:message.task}:message.op==='capabilities'?{task_id:message.task_id,task:message.task,action:message.action}:{task_id:message.task_id,task:message.task});
    respond(res,200,{ok:true,data});
   }catch(error){
    if(res.headersSent){try{res.end();}catch{}return;}
    const status=error.status||(error.code==='PAYLOAD_TOO_LARGE'?413:error.code==='UNAUTHORIZED'?401:error.code==='FORBIDDEN'?403:error.code==='TASK_NOT_FOUND'?404:error.code==='NOT_FOUND'?404:error.code==='METHOD_NOT_ALLOWED'?405:error.code==='UNSUPPORTED_MEDIA_TYPE'?415:error.code==='READ_ONLY'?403:error.code==='TOO_MANY_SUBSCRIPTIONS'?429:error.code==='BUSY'||error.code==='CONFLICT'||error.code==='RELEASED'||error.code==='RELEASE_DENIED'||error.code==='PENDING_TASK'||error.code==='OBSERVATION_UNAVAILABLE'?409:error.code==='BAD_REQUEST'||error.code==='UNKNOWN_OP'||error.code==='BAD_ATTACHMENTS'||error.code==='INVALID_URL'||error.code==='BAD_MODEL'?400:500);
    if(status>=500)log('error','rpc failure: '+(error&&error.stack||error));
    respond(res,status,{ok:false,error:{code:String(error.code||'INTERNAL'),message:String(error.message||'INTERNAL')}});
   }
  }
  const server=http.createServer((req,res)=>{handleRequest(req,res).catch(error=>{try{respond(res,500,{ok:false,error:{code:'INTERNAL',message:'internal'}});}catch{}log('error','http handler: '+error.message);});});
  server.headersTimeout=15000;server.requestTimeout=60000;server.keepAliveTimeout=5000;
  instance.server=server;
  const ready=new Promise((resolve,reject)=>{
   server.once('error',reject);
   server.listen(0,'127.0.0.1',()=>{
    server.removeListener('error',reject);
    if(instance.closed){try{server.close();}catch{}resolve({port:null,closed:true});return;}
    instance.port=server.address().port;
    const document={protocol:PROTOCOL,port:instance.port,token,pid:process.pid,appVersion,bridgeVersion:BRIDGE_VERSION,userDataPath:app&&typeof app.getPath==='function'?app.getPath('userData'):null,runtimeVersions:{node:process.versions.node,electron:process.versions.electron||null,chrome:process.versions.chrome||null}};
    writeAtomic(instance.discoveryPath,JSON.stringify(document,null,2)+'\n',0o600);
    try{fs.chmodSync(instance.discoveryPath,0o600);}catch{}
    log('info',`listening on 127.0.0.1:${instance.port} (readOnly=${readOnly})`);
    resolve({port:instance.port});
   });
  });
  server.on('error',error=>{if(!instance.closed)log('error','server error: '+error.message);});
  server.unref();
  ready.catch(error=>{log('error','listen failed: '+error.message);INSTANCES.delete(stateDir);});

  const listeners=[];
  function bind(event,handler){if(wc&&typeof wc.on==='function'&&typeof wc.removeListener==='function'){wc.on(event,handler);listeners.push([event,handler]);}}
  bind('destroyed',()=>{shutdown('WC_DESTROYED').catch(()=>{});});
  bind('before-input-event',(event,input)=>{
   if(instance.closed)return;
   if(instance.capabilityInspection){instance.capabilityInspection.interrupted=true;return;}
   if(input&&/^(keyDown|keyUp|char|rawKeyDown)$/i.test(input.type||'')){
    const task=taskForSession(instance.primarySession);
    if(!task||!task.run||task.closed)return;
    if(!(taskDriving(task)||occupyingGeneration(task)))return;
    instance.stopping=true;
    task.machine.interrupt('USER_INTERFERENCE','用户输入中断了自动任务');
    task.abort.abort();
   }
  });
  bind('will-navigate',(event,url)=>{
   const session=instance.primarySession;
   if(instance.closed||!session||session.navigating)return;
   if(instance.capabilityInspection){instance.capabilityInspection.interrupted=true;return;}
   const task=taskForSession(session);
   if(!task||!task.run||task.closed)return;
   if(!(taskDriving(task)||occupyingGeneration(task)))return;
   try{event.preventDefault();}catch{}
   if(taskDriving(task)&&!(task.ledger.phases&&task.ledger.phases.confirmed)){
    instance.stopping=true;
    task.machine.interrupt('USER_INTERFERENCE','页面被意外导航，任务已暂停');
    task.abort.abort();
   }
  });

  async function shutdown(reason){
   if(instance.closed)return;
   instance.closed=true;instance.stopping=true;
   closeSubscriptions();
   const running=[...instance.tasks.values()];
   for(const task of running){
    task.closed=true;
    try{task.finishGeneration?.({type:'abort',code:reason==='WC_DESTROYED'?'WC_DESTROYED':'BRIDGE_CLOSED',message:reason==='WC_DESTROYED'?'WebContents 已销毁':'桥已关闭'});}catch{}
    try{task.abort.abort();}catch{}
    try{task.machine.dispose();}catch{}
    clearTaskTimer(task,'idle');clearTaskTimer(task,'budget');
    if(task.run&&!TERMINAL.has(task.ledger.status)){
     const sent=!!task.ledger.phases.send_intent,confirmed=!!task.ledger.phases.confirmed;
     const status=sent?(confirmed?'partial':'uncertain'):'needs_user_action';
     const phase=status==='partial'?task.ledger.phase:status==='uncertain'?'uncertain':'needs_user_action';
     try{commitSnapshot(task,{phase,status,error:err(reason==='WC_DESTROYED'?'WC_DESTROYED':'BRIDGE_CLOSED',reason==='WC_DESTROYED'?'WebContents 已销毁，发送状态按已记录处理':'桥已关闭，发送状态按已记录处理'),terminal:{at:nowIso(now()),status},reason:'shutdown'});}catch{}
    }
   }
   for(const session of [...instance.sessions.values()]){
    if(session.extra){
     try{session.observation?.close();}catch{}
     try{if(typeof session.close==='function')session.close();}catch{}
    }
   }
   observation?.close();
   instance.tasks.clear();
   instance.uiLockId=null;
   instance.task=null;
   instance.activeId=null;
   for(const [event,handler] of listeners.splice(0)){try{wc.removeListener(event,handler);}catch{}}
   restoreThrottle(true);
   await new Promise(resolve=>{
    let done=false;const finish=()=>{if(!done){done=true;resolve();}};
    try{server.close(finish);}catch{finish();}
    setTimeout(finish,1500).unref();
   });
   try{const document=JSON.parse(fs.readFileSync(instance.discoveryPath,'utf8'));if(document.token===token)fs.unlinkSync(instance.discoveryPath);}catch{}
   if(INSTANCES.get(stateDir)===instance)INSTANCES.delete(stateDir);
  }
  const handlePromise=ready.then(()=>({ok:true,port:instance.port,protocol:PROTOCOL,stateDir})).catch(error=>({ok:false,error:error.message||'LISTEN_FAILED'}));
  const handle={
   ok:true,protocol:PROTOCOL,stateDir,ready:handlePromise,
   get port(){return instance.port;},
   address(){const address=server.address();return address?{address:address.address,family:address.family,port:address.port}:null;},
   close(){return shutdown('BRIDGE_CLOSED');},
   debug(){return {activeId:instance.activeId,uiLockId:instance.uiLockId,generating_count:generationCount(),generating_limit:MAX_GENERATING,closed:instance.closed,readOnly,journal:journal.sequence};}
  };
  return handle;
 }catch(error){
  log('error','attach failed: '+(error.stack||error));
  return {ok:false,error:error.code||error.message||'ATTACH_FAILED'};
 }
}
module.exports={attach,PROTOCOL,BRIDGE_VERSION,DEFAULT_STATE_DIR,MAX_GENERATING,validateWire,contentHash,resultOf,snapshotOf,PHASES,PHASE_STATUS,DEFAULTS,defaultCreateConversationView};
