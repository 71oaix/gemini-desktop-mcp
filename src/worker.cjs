const fs=require('node:fs');
const path=require('node:path');
const store=require('./store.cjs');
const queueEvents=require('./queue-events.cjs');
const policy=require('./desktop-model-policy.cjs');
const {DesktopTransport,validateWire,errorCode}=require('./desktop-transport.cjs');
const HEARTBEAT_MS=2000;
const MONITOR_TICK_MS=100;
const STREAM_BACKOFF_MS=[0,250,1000,2000,5000];
const MAX_STREAM_FAILURES=6;
const MAX_SYNC_FAILURES=3;
const ACTIVE_STATUSES=new Set(['connecting','submitting','generating']);
const TERMINAL_STATUSES=new Set(['completed','partial','failed','needs_user_action','uncertain']);
const SEND_UNSAFE_CODES=new Set(['DESKTOP_RPC_TIMEOUT','DESKTOP_RPC_LOST','BRIDGE_RPC_LOST']);
const NETWORK_CODES=new Set(['DESKTOP_RPC_REFUSED','DESKTOP_RPC_RESET','DESKTOP_RPC_ERROR','DESKTOP_RPC_TIMEOUT','DESKTOP_RPC_LOST','BRIDGE_RPC_LOST','BRIDGE_TIMEOUT','BRIDGE_UNAVAILABLE','NETWORK_TRANSIENT','REGION_UNSUPPORTED']);
const HANDLED_SEND_REJECTIONS=new Set(['BAD_REQUEST','READ_ONLY','BRIDGE_READ_ONLY','TASK_CONFLICT','CONFLICT','DESKTOP_TASK_INVALID','PENDING_TASK','BUSY','GENERATION_LIMIT','CONVERSATION_BUSY','SESSION_VIEW_UNAVAILABLE','RELEASED','TASK_NOT_FOUND','DESKTOP_INSTALLATION_CHANGED','OBSERVATION_UNAVAILABLE','BRIDGE_PAGE_NOT_READY','OBSERVER_NOT_BOUND']);
const NO_SEND_REJECTIONS=new Set(['BAD_REQUEST','READ_ONLY','BRIDGE_READ_ONLY','TASK_CONFLICT','CONFLICT','DESKTOP_TASK_INVALID','PENDING_TASK','BUSY','GENERATION_LIMIT','CONVERSATION_BUSY','SESSION_VIEW_UNAVAILABLE','DESKTOP_INSTALLATION_CHANGED']);
const GLOBAL_PAUSE_CODES=new Set(['NEEDS_LOGIN','AUTH_REQUIRED','LOGIN_REQUIRED','READ_ONLY','BRIDGE_READ_ONLY','BRIDGE_CONFIG']);
const REQUEUE_CODES=new Set(['GENERATION_LIMIT','CONVERSATION_BUSY','BUSY','SESSION_VIEW_UNAVAILABLE']);
// The bridge rejects observation-dependent operations before any ledger exists.
// These codes are explicit pre-send proof, so they clear the local intent and
// use the same bounded startup backoff. Transport timeouts/losses stay out:
// they do not prove the message was not sent and must only snapshot/recover.
const RETRY_SEND_REJECTIONS=new Set(['OBSERVATION_UNAVAILABLE','BRIDGE_PAGE_NOT_READY','OBSERVER_NOT_BOUND']);
const FATAL_EVENT_CODES=new Set(['EVENT_ANSWER_INVALID','EVENT_ANSWER_TRUNCATED','EVENT_REVISION_INVALID','EVENT_SNAPSHOT_INVALID','EVENT_ENVELOPE_INVALID','EVENT_MARKER_MISMATCH']);
// Startup page warming is a safe pre-send state: retry later instead of asking
// the user to reconnect. Store is unchanged; the local allowlist decides.
const STARTUP_RETRY_CODES=new Set(['BRIDGE_PAGE_NOT_READY','OBSERVER_NOT_BOUND','NETWORK_TRANSIENT','REGION_UNSUPPORTED']);

class FencedError extends Error{constructor(message='后台执行权已改变，停止新的页面操作'){super(message);this.name='FencedError';this.fenced=true;}}
function sleepDefault(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function sanitizeDiagnostic(value){
 if(!value||typeof value!=='object')return null;
 const copy={};
 for(const [key,item] of Object.entries(value)){
  if(/token|authorization|secret/i.test(key))continue;
  copy[key]=item&&typeof item==='object'?JSON.parse(JSON.stringify(item)):item;
 }
 return copy;
}
function writeJson(filename,value){
 try{fs.mkdirSync(path.dirname(filename),{recursive:true});const temporary=filename+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,filename);}catch{}
}
function wireForTask(task){
 const request=task.request,base=store.taskDir(request.fallback_parent_id||task.id),directory=path.join(base,'attachments');
 if(!Array.isArray(request.attachments)||!Array.isArray(request.files)||request.attachments.length!==request.files.length)throw Object.assign(Error('附件快照记录不完整，未发送'),{code:'ATTACHMENT_SNAPSHOT_INVALID'});
 const attachments=request.attachments.map((filename,index)=>{
  const resolved=path.resolve(filename);
  if(path.dirname(resolved)!==path.resolve(directory))throw Object.assign(Error('附件路径越界，未发送'),{code:'ATTACHMENT_PATH_INVALID'});
  let bytes;try{bytes=fs.readFileSync(resolved);}catch{throw Object.assign(Error('附件快照缺失，未发送；请使用新的 task_id 重新提交'),{code:'ATTACHMENT_MISSING'});}
  const expected=request.files[index];
  if(bytes.length>store.MAX_FILE_BYTES||store.sha256(bytes)!==expected.sha256)throw Object.assign(Error('附件快照校验失败，未发送；请使用新的 task_id 重新提交'),{code:'ATTACHMENT_CHANGED'});
  return {name:expected.name,mime:'text/plain',base64:bytes.toString('base64')};
 });
 const prompt=request.prompt;
 return validateWire({id:task.id,marker:task.marker,prompt,purpose:request.purpose,model:request.model,mode:request.mode,conversation_url:request.url,timeoutMs:request.timeoutMs,attachments});
}

function mergeResult(existing,snapshot,task){
 const current=existing||{};
 const incoming=snapshot.result||{};
 const fields=policy.mergeResultFields(current,incoming,task.request?.model);
 const actual=fields.actual_model!=='unknown'?policy.MODEL_LABELS[fields.actual_model]||fields.actual_model:null;
 const legacyModel=fields.actual_model==='unknown'&&current.actual_model===undefined&&incoming.actual_model===undefined?(incoming.model||current.model||null):null;
 return {
  ...current,
  answer:incoming.answer||current.answer||'',
  url:current.submission_confirmed===true&&store.boundConversation(current.url)?current.url:incoming.url||current.url||null,
  model:actual||legacyModel,
  ...fields,
  complete:current.complete===true||incoming.complete===true,
  submission_confirmed:current.submission_confirmed===true||incoming.submission_confirmed===true,
  submission_known:current.submission_known===true||incoming.submission_known===true,
  marker:incoming.marker||current.marker||task.marker,
  beforeResponses:Number.isInteger(incoming.beforeResponses)?incoming.beforeResponses:(Number.isInteger(current.beforeResponses)?current.beforeResponses:null)
 };
}

function unsentProof(snapshot,task,result){
 if(result?.submission_known===true&&result.submission_confirmed===true)return false;
 if(task.send_intent&&!snapshot)return false;
 return confirmedUnsent(snapshot,result)||chatNotReadyUnsent(snapshot,result);
}
// Trusted unsent proof: the bridge explicitly reports a pre-send failure. A
// bare not_sent preparing snapshot or an unknown send state does not qualify.
const confirmedUnsent=queueEvents.confirmedUnsent;
// waitReady fails before the bridge records send_intent, so that snapshot can
// prove the turn never started. The error code alone is never proof: require
// not_sent, a known and unconfirmed submission, and no recorded message.
const chatNotReadyUnsent=queueEvents.chatNotReadyUnsent;
function transientCode(code){return store.RETRYABLE_CODES.has(code)||SEND_UNSAFE_CODES.has(code)||NETWORK_CODES.has(code);}
// Only a confirmed URL or durable marker-seen evidence may select recover.
// Everything else keeps snapshot; neither path can resend.
function recoveryMode(task,result){
 if(result?.submission_confirmed===true&&typeof result.url==='string'&&result.url)return 'recover';
 if(task&&store.lateBindPending(task.id))return 'recover';
 return 'snapshot';
}
function fenced(error){return error?.fenced===true||error?.code==='WORKER_FENCED';}
function markerFailure(error){return error?.code==='MARKER_MISMATCH'||error?.code==='EVENT_MARKER_MISMATCH'||/MARKER_MISMATCH/.test(error?.message||'');}
function truncatedFailure(error){return /ANSWER_TRUNCATED/.test(error?.message||'')||error?.code==='EVENT_ANSWER_TRUNCATED';}
function authFailure(error){
 const code=String(error?.code||'');
 if(store.AUTH_CODES.has(code)||['UNAUTHORIZED','NEEDS_LOGIN','AUTH_REQUIRED','LOGIN_REQUIRED','READ_ONLY','BRIDGE_READ_ONLY'].includes(code)||error?.status===401)return code||'NEEDS_LOGIN';
 return null;
}
function fatalEvent(error){
 if(FATAL_EVENT_CODES.has(error?.code))return true;
 return /EVENT_(?:(?:REVISION|SNAPSHOT|ENVELOPE)_INVALID|ANSWER_INVALID)/.test(error?.message||'');
}
function snapshotStale(error){return error?.code==='EVENT_SNAPSHOT_STALE'||/SNAPSHOT_STALE/.test(error?.message||'');}
function retryDelay(attempt){return STREAM_BACKOFF_MS[Math.min(Math.max(attempt,0),STREAM_BACKOFF_MS.length-1)];}

function pageFaultCode(probe){
 return probe&&probe.page&&typeof probe.page.fault==='string'&&probe.page.fault?probe.page.fault:null;
}
function blockedReason(probe){
 if(!probe||typeof probe!=='object')return null;
 if(probe.readOnly===true)return {code:'BRIDGE_READ_ONLY',message:'桌面客户端处于只读状态；没有发送或恢复聊天任务。'};
 const fault=pageFaultCode(probe);
 if(probe.loginRequired===true||probe.needsLogin===true||probe.authenticated===false||fault==='LOGIN_REQUIRED')return {code:'NEEDS_LOGIN',message:'桌面客户端需要重新登录；没有发送聊天消息。'};
 if(fault==='USER_DIALOG')return {code:'USER_DIALOG',message:'Gemini 页面有待用户处理的同意或确认弹窗；没有发送聊天消息。'};
 // Network/region/warming are tracked by readinessRetry as bounded pre-send retries.
 if(fault==='NETWORK_TRANSIENT'||fault==='REGION_UNSUPPORTED')return null;
 if(probe.warming===true)return null;
 if(probe.connected===false)return {code:'BRIDGE_NOT_CONNECTED',message:'桌面桥未连接聊天页面；没有发送聊天消息。'};
 if(probe.pageReady===false)return {code:'BRIDGE_PAGE_NOT_READY',message:'桌面桥页面尚未就绪；没有发送聊天消息。'};
 return null;
}
// The fixed probe may observe a usable page while the desktop observer is still
// unbound and holds no pushed state. That page cannot be driven safely, so it
// must keep waiting for readiness instead of relying on pageReady alone.
function observerUnbound(probe){
 if(!probe||typeof probe!=='object')return false;
 const observer=probe.observer;
 return !!observer&&typeof observer==='object'&&observer.bound===false&&observer.has_state!==true;
}
function readinessRetry(probe){
 if(!probe||typeof probe!=='object')return null;
 const fault=pageFaultCode(probe);
 if(fault==='NETWORK_TRANSIENT')return {code:'NETWORK_TRANSIENT',message:'Gemini 网络连接中断；等待恢复后重试，尚未发送聊天消息。'};
 if(fault==='REGION_UNSUPPORTED')return {code:'REGION_UNSUPPORTED',message:'Gemini 提示所在地区不支持；等待恢复后重试，尚未发送聊天消息。'};
 const unbound=observerUnbound(probe);
 if(probe.warming!==true&&!unbound)return null;
 const declared=typeof probe.error?.code==='string'?probe.error.code:null;
 const code=unbound?'OBSERVER_NOT_BOUND':(STARTUP_RETRY_CODES.has(declared)?declared:'BRIDGE_PAGE_NOT_READY');
 return {code,message:code==='OBSERVER_NOT_BOUND'?'观察器尚未绑定页面；等待聊天页面加载后重试，尚未发送聊天消息。':'Gemini 聊天页面仍在加载；等待就绪后重试，尚未发送聊天消息。'};
}
function needsReadinessWait(probe){
 if(!probe||typeof probe!=='object')return false;
 if(probe.readOnly===true)return false;
 const fault=pageFaultCode(probe);
 if(fault&&fault!=='CLIENT_SHELL')return false;
 if(observerUnbound(probe))return true;
 if(probe.pageReady===true)return false;
 return true;
}
async function ensureReady(ctx){
 let readiness;
 try{readiness=await ctx.transport.ensureRunning({timeoutMs:1500});}
 catch(error){return {running:false,state:'bridge_error',code:errorCode(error),message:error?.message||'桌面桥不可用'};}
 if(!readiness||!readiness.running)return readiness;
 if(!needsReadinessWait(readiness.probe))return readiness;
 if(typeof ctx.transport.awaitReady!=='function')return readiness;
 try{
  const ready=await ctx.transport.awaitReady();
  return {...readiness,probe:ready||{},readiness_awaited:true};
 }catch(error){
  return {running:false,state:'bridge_error',code:errorCode(error),message:error?.message||'等待桌面页面就绪失败',probe:readiness.probe};
 }
}
function noteAttention(ctx,task,message,errorCodeValue,result=task.result){
 if(task.notified!==1)ctx.log(`任务 ${task.id} 需要用户处理：${message}`);
 return {status:'needs_user_action',error:message,error_code:errorCodeValue,notified:1,next_attempt:null,next_op:recoveryMode(task,result)};
}

async function updateOwnedTask(ctx,taskId,patch){
 const saved=await store.updateOwned(ctx.db,taskId,ctx.token,patch);
 if(!saved)throw new FencedError();
 return store.row(ctx.db,taskId);
}
async function setConnection(ctx,value){store.setConnection(ctx.db,ctx.token,value);}
function isGlobalPauseCode(code){return GLOBAL_PAUSE_CODES.has(code);}
async function pauseConnectionIfGlobal(ctx,code){
 if(isGlobalPauseCode(code))await setConnection(ctx,'needs_user_action');
 else await setConnection(ctx,'connected');
}
function queueOptions(ctx,paused=false){
 const inflight=ctx.inflight||new Map();
 const excludeIds=[...inflight.keys()];
 const busyConversations=[];
 let generatingCount=0;
 const seen=new Set();
 const rows=ctx.db.prepare("SELECT id FROM tasks WHERE status IN ('connecting','submitting','generating') OR (status='partial' AND IFNULL(budget_exhausted,0)=1)").all();
 for(const item of rows.concat(excludeIds.map(id=>({id})))){
  if(seen.has(item.id))continue;
  seen.add(item.id);
  let task;try{task=store.row(ctx.db,item.id);}catch{continue;}
  if(!store.occupiesGeneration(task))continue;
  generatingCount+=1;
  const key=store.taskConversationKey(task);
  if(key&&!busyConversations.includes(key))busyConversations.push(key);
 }
 return {probeOnly:paused,generatingCount,busyConversations,excludeIds,generatingLimit:store.MAX_GENERATING};
}

async function probeTask(ctx,task){
 const readiness=await ensureReady(ctx);
 if(!readiness.running){
  const result={answer:`桌面桥不可用：${readiness.message||readiness.code||'未启动'}；没有发送聊天消息。`,url:null,model:null,submission_confirmed:false,submission_known:true,marker:task.marker,beforeResponses:null};
  await updateOwnedTask(ctx,task.id,noteAttention(ctx,task,result.answer,readiness.code||'BRIDGE_UNAVAILABLE',result));
  await updateOwnedTask(ctx,task.id,{result});
  await setConnection(ctx,'needs_user_action');
  return {terminal:true,status:'needs_user_action'};
 }
 const probe=readiness.probe||{};
 writeJson(path.join(store.STATE,'desktop-probe.json'),{at:new Date().toISOString(),discovery:readiness.discovery||null,probe:sanitizeDiagnostic(probe)});
 const blocked=blockedReason(probe);
 if(blocked){
  const result={answer:blocked.message,url:null,model:null,submission_confirmed:false,submission_known:true,marker:task.marker,beforeResponses:null};
  await updateOwnedTask(ctx,task.id,noteAttention(ctx,task,blocked.message,blocked.code,result));
  await updateOwnedTask(ctx,task.id,{result});
  await setConnection(ctx,'needs_user_action');
  return {terminal:true,status:'needs_user_action'};
 }
 const pending=readinessRetry(probe);
 if(pending){
  const result={answer:pending.message,url:null,model:null,submission_confirmed:false,submission_known:true,marker:task.marker,beforeResponses:null};
  await updateOwnedTask(ctx,task.id,{result});
  const scheduled=store.scheduleRetry(ctx.db,task.id,pending.message,{mode:'probe',error_code:pending.code});
  await setConnection(ctx,'connected');
  return {terminal:true,status:scheduled.exhausted?'failed':'retry_wait'};
 }
 const resumed=store.resumeAfterProbe(ctx.db);
 const result={answer:'桌面桥已连接；没有发送聊天消息。',url:null,model:null,submission_confirmed:false,submission_known:true,marker:task.marker,beforeResponses:null,readOnly:false,bridgeVersion:readiness.discovery?.bridge_version||null,resumed_task_ids:resumed};
 await updateOwnedTask(ctx,task.id,{status:'completed',result,error:null,error_code:null,next_attempt:null,next_op:null,notified:0});
 await setConnection(ctx,'connected');
 return {terminal:true,status:'completed'};
}

async function handleBridgeUnavailable(ctx,task,readiness){
 if(!ctx.owns())throw new FencedError();
 const current=store.row(ctx.db,task.id);
 const message=readiness.message||'桌面桥不可用；没有发送聊天消息';
 const code=readiness.code||'BRIDGE_UNAVAILABLE';
 const sent=!!current.send_intent||!!current.recover||store.ledgerSendIntent(task.id)||['submitting','generating'].includes(current.status);
 const result=current.result||{};
 if(transientCode(code)){
  await setConnection(ctx,'disconnected');
  if(sent||result.submission_confirmed||result.answer){
   const mode=recoveryMode(task,result);
   const scheduled=store.deferMonitor(ctx.db,task.id,`桌面桥连接中断（${code}）；只保留查询/恢复，不重新发送`,{mode,error_code:code});
   if(result.answer)store.writeResultFile(ctx.db,task.id,result);
   return {terminal:true,status:scheduled.exhausted?'failed':'uncertain'};
  }
  const scheduled=store.scheduleRetry(ctx.db,task.id,message,{mode:'send',error_code:code});
  return {terminal:true,status:scheduled.exhausted?'failed':'retry_wait'};
 }
 const nextOp=sent?recoveryMode(task,result):'send';
 await updateOwnedTask(ctx,task.id,{...noteAttention(ctx,current,message,code,current.result),next_op:nextOp});
 await setConnection(ctx,'needs_user_action');
 if(current.result?.answer)store.writeResultFile(ctx.db,task.id,current.result);
 return {terminal:true,status:'needs_user_action'};
}

async function handleReadinessBlocked(ctx,task,blocked){
 const current=store.row(ctx.db,task.id);
 await updateOwnedTask(ctx,task.id,{...noteAttention(ctx,current,blocked.message,blocked.code,current.result),next_attempt:null});
 await setConnection(ctx,'needs_user_action');
 if(current.result?.answer)store.writeResultFile(ctx.db,task.id,current.result);
 return {terminal:true,status:'needs_user_action'};
}

// Page warming is not a user-action condition. Unsent tasks keep the send
// boundary untouched and retry later; sent/unknown tasks keep recover/snapshot.
async function handleStartupNotReady(ctx,task,pending){
 const current=store.row(ctx.db,task.id);
 const requested=['recover','snapshot'].includes(task.next_op)?task.next_op:null;
 const sent=!!requested||!!current.send_intent||!!current.result?.submission_confirmed||['submitting','generating','uncertain'].includes(current.status);
 if(sent){
  const mode=requested||recoveryMode(task,current.result);
  const scheduled=store.deferMonitor(ctx.db,task.id,pending.message,{mode,error_code:pending.code});
  await setConnection(ctx,'connected');
  if(current.result?.answer)store.writeResultFile(ctx.db,task.id,current.result);
  return {terminal:true,status:scheduled.exhausted?'failed':'uncertain'};
 }
 await updateOwnedTask(ctx,task.id,{send_intent:0,intent_at:null});
 const scheduled=store.scheduleRetry(ctx.db,task.id,pending.message,{mode:'send',error_code:pending.code});
 await setConnection(ctx,'connected');
 return {terminal:true,status:scheduled.exhausted?'failed':'retry_wait'};
}

function snapshotPatch(current,task,snapshot){
 const result=mergeResult(current.result,snapshot,task);
 const metadata=snapshot.metadata||{};
 result.timings=metadata.diagnostics||current.result?.timings||null;
 if(metadata.model_diagnostic)result.model_diagnostic=metadata.model_diagnostic;
 const patch={
  status:snapshot.status,phase:snapshot.phase||snapshot.status,
  error:snapshot.error?.message||null,error_code:snapshot.error?.code||null,
  result,event_connection:'connected',observer_state:metadata.observer_state||current.observer_state||'bound',
  budget_exhausted:(metadata.budget_exhausted===true||snapshot.budget_exhausted===true)?1:0,
  next_attempt:null
 };
 if(Number.isSafeInteger(snapshot.revision))patch.result_revision=snapshot.revision;
 const activity=Number.isFinite(metadata.last_activity)?metadata.last_activity:Date.parse(metadata.last_state_at||'');
 if(Number.isFinite(activity))patch.last_activity=activity;
 // send_intent follows the bridge: a real send click or confirmed submission
 // sets it, and a trusted pre-send failure (including MODEL_UNAVAILABLE and
 // ATTACHMENT_NOT_READY) clears it so official closeTask can finish the row.
 const chatNotReady=chatNotReadyUnsent(snapshot,result);
 const submission=queueEvents.submissionPatch(current,snapshot,result);
 // Persist the same delivery evidence as pushed events. An observed marker
 // without a bound URL stays `observed` even when a later snapshot or fault
 // carries no send state.
 result.delivery=store.deliveryOf(current.result?.delivery,snapshot,result,(submission.send_intent!==undefined?submission.send_intent:current.send_intent)===1);
 Object.assign(patch,submission);
 // Reuse the existing bounded send retry for this proven-unsent snapshot.
 if(chatNotReady)patch.error_code='NOT_SENT';
 if(snapshot.status==='completed'||snapshot.status==='failed'){patch.next_attempt=null;patch.next_op=null;}
 if(snapshot.status==='completed')patch.notified=0;
 return {patch,result};
}

async function applyLocalSnapshot(ctx,task,snapshot){
 if(snapshot.result?.marker&&snapshot.result.marker!==task.marker)throw Object.assign(Error('桌面桥返回的任务标记不匹配；不采用该回答'),{code:'MARKER_MISMATCH'});
 if(snapshot.result?.answer_truncated||snapshot.metadata?.answer_truncated)throw Object.assign(Error('桌面桥结果被截断；不采用该回答'),{code:'ANSWER_TRUNCATED'});
 const current=store.row(ctx.db,task.id);
 const {patch}=snapshotPatch(current,task,snapshot);
 return updateOwnedTask(ctx,task.id,patch);
}

async function failClosed(ctx,task,code,message){
 const current=store.row(ctx.db,task.id);
 if(current.status==='completed')return {terminal:true,status:'completed'};
 await updateOwnedTask(ctx,task.id,{status:'failed',error:message,error_code:code,next_attempt:null,next_op:null,notified:0});
 await setConnection(ctx,'connected');
 if(current.result?.answer)store.writeResultFile(ctx.db,task.id,current.result);
 return {terminal:true,status:'failed'};
}

async function pauseTask(ctx,task,code,message,{nextOp}={}){
 const current=store.row(ctx.db,task.id);
 const patch=noteAttention(ctx,current,message,code,current.result);
 if(nextOp!==undefined)patch.next_op=nextOp;
 await updateOwnedTask(ctx,task.id,{...patch,next_attempt:null});
 await pauseConnectionIfGlobal(ctx,code);
 if(current.result?.answer)store.writeResultFile(ctx.db,task.id,current.result);
 return {terminal:true,status:'needs_user_action'};
}
async function requeueTask(ctx,task,code,message,{mode}={}){
 const current=store.row(ctx.db,task.id);
 if(current.result?.submission_confirmed===true&&code!=='CONVERSATION_BUSY'){
  return failClosed(ctx,task,code,message);
 }
 const nextMode=mode||current.next_op||'send';
 store.returnToQueue(ctx.db,task.id,{mode:nextMode,error:message,error_code:code});
 await setConnection(ctx,'connected');
 if(current.result?.answer)store.writeResultFile(ctx.db,task.id,current.result);
 return {terminal:true,status:'queued'};
}

async function releaseOnce(ctx,task,session){
 if(session?.released)return true;
 if(!ctx.owns())throw new FencedError();
 const release=async()=>{
  await ctx.transport.release(task.id,{timeoutMs:Math.min(ctx.transport.timeoutMs||8000,5000)});
  if(session)session.released=true;
  return true;
 };
 try{return await release();}
 catch(error){
  if(error?.code==='RELEASE_DENIED'){
   // The bridge may still be finishing the completed run in its finally block.
   // Wait briefly so the next queued task (including a fallback child) does not
   // hit the bridge's BUSY guard and get parked as needing user action.
   const wait=typeof ctx.sleep==='function'?ctx.sleep:sleepDefault;
   for(let attempt=0;attempt<5;attempt++){
    await wait(100);
    if(!ctx.owns())throw new FencedError();
    try{return await release();}
    catch(retry){
     if(retry?.code!=='RELEASE_DENIED'){ctx.log(`任务 ${task.id} 释放失败但不影响终态：${retry.message}`);return false;}
    }
   }
  }
  ctx.log(`任务 ${task.id} 释放失败但不影响终态：${error.message}`);
  return false;
 }
}

async function monitorFailure(ctx,task,error){
 const current=store.row(ctx.db,task.id);
 const result=current.result||{};
 const mode=recoveryMode(task,result);
 const code=error?.code||'EVENT_STREAM_FAILED';
 const message=`桌面桥连接中断（${code}）；只保留查询/恢复，不重新发送`;
 await setConnection(ctx,'disconnected');
 if(!ctx.owns())throw new FencedError();
 const scheduled=store.deferMonitor(ctx.db,task.id,message,{mode,error_code:code});
 if(result.answer)store.writeResultFile(ctx.db,task.id,result);
 return {terminal:true,status:scheduled.exhausted?'failed':'uncertain'};
}

async function settleTask(ctx,task,{snapshot=null,session=null}={}){
 let current=store.row(ctx.db,task.id);
 if(!ctx.owns())throw new FencedError();
 // Sync and direct replies share submissionPatch. Also normalize a trusted
 // CHAT_NOT_READY proof left by an older worker so its bounded retry can resume.
 if(current.send_intent&&!current.result?.submission_confirmed&&['failed','needs_user_action'].includes(current.status)&&(chatNotReadyUnsent(snapshot,current.result||{})||confirmedUnsent(snapshot,current.result||{}))){
  const code=chatNotReadyUnsent(snapshot,current.result||{})?'NOT_SENT':(current.error_code||snapshot?.error?.code||null);
  current=await updateOwnedTask(ctx,task.id,{send_intent:0,intent_at:null,...(code?{error_code:code}:{})});
 }
 const status=current.status,result=current.result||{};
 const error={code:current.error_code||null,message:current.error||null};
 const proxy={status,error,result};
 if(status==='completed'){
  // The original turn is terminal only here. A downgraded or unverified turn
  // stays a recorded policy failure; it never creates another Gemini call.
  const final=store.row(ctx.db,task.id);
  if(final.result)store.writeResultFile(ctx.db,task.id,final.result);
  await setConnection(ctx,'connected');
  await releaseOnce(ctx,task,session);
  return {terminal:true,status:'completed'};
 }
 if(status==='failed'){
  if(!current.send_intent&&!result.answer&&unsentProof(proxy,task,result)&&transientCode(error.code)){
   const scheduled=store.scheduleRetry(ctx.db,task.id,error.message||'发送前网络异常；稍后重试',{mode:'send',error_code:error.code});
   await setConnection(ctx,'connected');
   return {terminal:true,status:scheduled.exhausted?'failed':'retry_wait'};
  }
  if(transientCode(error.code)&&(current.send_intent||result.submission_confirmed||result.answer)){
   const mode=recoveryMode(task,result);
   const scheduled=store.scheduleRetry(ctx.db,task.id,error.message||'已发送任务连接中断；只恢复原会话',{mode,error_code:error.code});
   if(result.answer)store.writeResultFile(ctx.db,task.id,result);
   await setConnection(ctx,'connected');
   return {terminal:true,status:scheduled.exhausted?'failed':'retry_wait'};
  }
  if(result.answer)store.writeResultFile(ctx.db,task.id,result);
  await setConnection(ctx,'connected');
  await releaseOnce(ctx,task,session);
  return {terminal:true,status:'failed'};
 }
 if(status==='needs_user_action'){
  if(!current.send_intent&&!result.answer&&unsentProof(proxy,task,result)&&transientCode(error.code)){
   const scheduled=store.scheduleRetry(ctx.db,task.id,error.message||'发送前网络异常；稍后重试',{mode:'send',error_code:error.code});
   await setConnection(ctx,'connected');
   return {terminal:true,status:scheduled.exhausted?'failed':'retry_wait'};
  }
  if(transientCode(error.code)&&(current.send_intent||result.submission_confirmed||result.answer)){
   const mode=recoveryMode(task,result);
   const scheduled=store.scheduleRetry(ctx.db,task.id,error.message||'已发送任务连接中断；只恢复原会话',{mode,error_code:error.code});
   if(result.answer)store.writeResultFile(ctx.db,task.id,result);
   await setConnection(ctx,'connected');
   return {terminal:true,status:scheduled.exhausted?'failed':'retry_wait'};
  }
  const patch=noteAttention(ctx,current,error.message||'桌面端需要用户处理',error.code||'NEEDS_USER_ACTION',result);
  await updateOwnedTask(ctx,task.id,{status:'needs_user_action',error:error.message||'桌面端需要用户处理',error_code:error.code||'NEEDS_USER_ACTION',next_attempt:null,next_op:patch.next_op,notified:patch.notified});
  await pauseConnectionIfGlobal(ctx,error.code||'NEEDS_USER_ACTION');
  if(result.answer)store.writeResultFile(ctx.db,task.id,result);
  return {terminal:true,status:'needs_user_action'};
 }
 if(status==='uncertain'){
  const mode=recoveryMode(task,result);
  const keepUncertain=mode==='recover'&&!result.submission_confirmed;
  const scheduled=store.deferMonitor(ctx.db,task.id,error.message||'发送状态未确认；只允许查询或恢复',{mode,error_code:error.code||'SEND_UNKNOWN',keepUncertain});
  if(result.answer)store.writeResultFile(ctx.db,task.id,result);
  await setConnection(ctx,'disconnected');
  return {terminal:true,status:scheduled.exhausted?'failed':'uncertain'};
 }
 if(status==='partial'){
  if(result.answer)store.writeResultFile(ctx.db,task.id,result);
  if(current.budget_exhausted===1){
   if(current.next_attempt!==null)await updateOwnedTask(ctx,task.id,{next_attempt:null});
   await setConnection(ctx,'connected');
   return {terminal:false,budget:true};
  }
  const scheduled=store.scheduleRetry(ctx.db,task.id,error.message||'回答尚未完整；稍后只读取原会话',{mode:recoveryMode(task,result),error_code:error.code||'ANSWER_PARTIAL'});
  await setConnection(ctx,'connected');
  return {terminal:true,status:scheduled.exhausted?'failed':'partial'};
 }
 if(ACTIVE_STATUSES.has(status)){
  await setConnection(ctx,'connected');
  return {terminal:false};
 }
 return {terminal:false};
}

function eventDecision(type,extra={}){return {type,...extra};}
async function applyOwnedEvent(ctx,task,state,session,event,snapshot){
 let outcome;
 try{outcome=queueEvents.applyEvent(ctx.db,ctx.token,event,{snapshot});}
 catch(error){
  if(fenced(error))throw new FencedError();
  if(markerFailure(error))throw Object.assign(Error('事件任务标记不匹配；不采用该回答'),{code:'MARKER_MISMATCH'});
  throw error;
 }
 if(outcome.reset||outcome.gap)return eventDecision('resync');
 if(outcome.duplicate)return null;
 if(outcome.applied){
  state.streamFailures=0;state.resyncs=0;
  if(snapshot&&snapshot.task_id===task.id&&outcome.changed){
   const settled=await settleTask(ctx,task,{snapshot,session});
   if(settled.terminal)return eventDecision('terminal',{outcome:settled});
  }
 }
 return null;
}
async function handleStreamEvent(ctx,task,state,session,wrapper){
 if(!wrapper||typeof wrapper!=='object')throw Error('EVENT_INVALID');
 if(wrapper.type==='heartbeat')return null;
 if(wrapper.type==='reset')return eventDecision('resync');
 if(wrapper.type!=='task')return null;
 const data=wrapper.data;
 if(!data||typeof data!=='object')throw Error('EVENT_INVALID');
 const prior=queueEvents.cursor(ctx.db);
 if(!prior||prior.instance_id!==data.instance_id)return eventDecision('resync');
 if(Number.isSafeInteger(data.seq)&&data.seq<=prior.seq)return null;
 if(Number.isSafeInteger(data.seq)&&data.seq!==prior.seq+1)return eventDecision('resync');
 let snapshot=data.snapshot||null;
 if(data.snapshot_required){
  snapshot=await ctx.transport.snapshot(data.task_id);
  if(!snapshot)throw Object.assign(Error('EVENT_SNAPSHOT_REQUIRED'),{code:'EVENT_SNAPSHOT_REQUIRED'});
  if(Number.isSafeInteger(data.revision)&&Number.isSafeInteger(snapshot.revision)&&snapshot.revision<data.revision)throw Object.assign(Error('快照修订号落后于事件；等待重新同步'),{code:'EVENT_SNAPSHOT_STALE'});
 }
 return applyOwnedEvent(ctx,task,state,session,data,snapshot);
}

async function syncTask(ctx,task,state,session){
 const sync=await ctx.transport.synchronize();
 if(!sync||typeof sync.instance_id!=='string'||!Number.isSafeInteger(sync.seq)||!Array.isArray(sync.snapshots))throw Object.assign(Error('桌面桥同步快照格式错误'),{code:'DESKTOP_PROTOCOL_INVALID'});
 let point;
 try{point=queueEvents.synchronize(ctx.db,ctx.token,sync);}
 catch(error){if(fenced(error))throw new FencedError();throw error;}
 state.instance_id=sync.instance_id;state.seq=sync.seq;
 const own=sync.snapshots.find(item=>item&&item.task_id===task.id);
 const shouldRecover=!state.recoverAttempted&&canRecover(ctx,task)&&(!own||own.metadata?.execution_active===false)&&!['completed','failed'].includes(own?.status);
 if(own){
  state.seenTask=true;
  if(!shouldRecover){const settled=await settleTask(ctx,task,{snapshot:own,session});if(settled.terminal)return settled;}
 }
 if(shouldRecover){
  state.recoverAttempted=true;
  let recovered;
  try{recovered=await ctx.transport.recover(task.id);}
  catch(error){
   if(['BUSY','PENDING_TASK'].includes(error?.code))return {terminal:false};
   throw error;
  }
  if(!recovered)throw Object.assign(Error('桌面桥恢复返回空快照'),{code:'DESKTOP_PROTOCOL_INVALID'});
  state.seenTask=true;
  await applyLocalSnapshot(ctx,task,recovered);
  const recoveredRow=store.row(ctx.db,task.id);
  if(!recoveredRow.event_instance){
   const saved=await store.updateOwned(ctx.db,task.id,ctx.token,{event_instance:state.instance_id});
   if(!saved)throw new FencedError();
  }
  // A recovery may return the last uncertain snapshot while its new
  // observer is binding. Keep listening for the outcome of that attempt.
  if(!(recovered.status==='uncertain'&&recovered.metadata?.execution_active===true)){
   const settled=await settleTask(ctx,task,{snapshot:recovered,session});
   if(settled.terminal)return settled;
  }
 }else if(!state.seenTask&&!state.freshSend){
  return failClosed(ctx,task,'TASK_NOT_FOUND','桌面桥没有该任务的快照；不重发未知或已释放的旧任务');
 }
 if(point&&point.stale)ctx.log(`任务 ${task.id} 同步快照落后于本地游标，未重复应用`);
 return {terminal:false};
}
function canRecover(ctx,task){
 const current=store.row(ctx.db,task.id);
 if(typeof ctx.transport.recover!=='function')return false;
 if(current.result?.submission_confirmed===true&&typeof current.result?.url==='string'&&!!current.result.url)return true;
 // Durable marker evidence without a URL may bind only through the bridge's
 // read-only late-bind path. The send intent itself is not enough.
 return store.lateBindPending(task.id);
}

function runEventStream(ctx,task,state,session){
 return new Promise(resolve=>{
  const controller=new AbortController();
  let control=null,settled=false;
  const timer=setInterval(()=>{
   if(settled)return;
   let stop,owns;
   try{stop=store.stopRequested();owns=stop?false:ctx.owns();}
   catch{
    // The lease check itself failed (for example the worker database already
    // closed). End this stream instead of letting a timer read a dead handle.
    control=control||{type:'stopped'};controller.abort();finish(null);return;
   }
   if(stop){control={type:'stopped'};controller.abort();}
   else if(!owns){control={type:'fenced'};controller.abort();}
  },MONITOR_TICK_MS);
  state.abort=reason=>{if(!settled){control=control||{type:reason||'stopped'};controller.abort();}};
  ctx.activeAbort=state.abort;
  if(ctx.aborts)ctx.aborts.set(task.id,state.abort);
  const finish=fallback=>{if(settled)return;settled=true;clearInterval(timer);if(ctx.activeAbort===state.abort)ctx.activeAbort=null;if(ctx.aborts)ctx.aborts.delete(task.id);state.abort=null;resolve(control||fallback||{type:'closed'});};
  const onEvent=wrapper=>Promise.resolve().then(async()=>{
   if(settled)return;
   try{
    const decision=await handleStreamEvent(ctx,task,state,session,wrapper);
    if(decision&&!settled){control=decision;controller.abort();}
   }catch(error){if(!settled){control={type:'error',error};controller.abort();}}
  });
  let pending;
  try{pending=ctx.transport.events({cursor:queueEvents.cursor(ctx.db),signal:controller.signal,onEvent});}
  catch(error){finish({type:'error',error});return;}
  Promise.resolve(pending).then(()=>finish(null),error=>finish({type:'error',error}));
 });
}

async function monitor(ctx,task,{session=null,freshSend=false}={}){
 const state={syncFailures:0,streamFailures:0,resyncs:0,recoverAttempted:false,seenTask:false,freshSend:!!freshSend,abort:null};
 let needsSync=true;
 for(;;){
  if(store.stopRequested())return {terminal:true,stopped:true};
  if(!ctx.owns())throw new FencedError();
  if(needsSync){
   let synced;
   try{synced=await syncTask(ctx,task,state,session);}
   catch(error){
    if(fenced(error))throw new FencedError();
    if(markerFailure(error))return failClosed(ctx,task,'MARKER_MISMATCH','桌面桥返回的任务标记不匹配；不采用该回答');
    if(truncatedFailure(error))return failClosed(ctx,task,'ANSWER_TRUNCATED','桌面桥结果被截断；不采用该回答');
    if(snapshotStale(error)){state.resyncs++;if(state.resyncs>MAX_STREAM_FAILURES)return monitorFailure(ctx,task,Object.assign(Error('事件重同步次数过多'),{code:'EVENT_RESYNC_LIMIT'}));needsSync=true;await ctx.sleep(retryDelay(state.resyncs-1));continue;}
    if(fatalEvent(error))return failClosed(ctx,task,error.code||'EVENT_INVALID',error.message||'桌面同步快照不合法');
    const auth=authFailure(error);
    if(auth)return pauseTask(ctx,task,auth==='READ_ONLY'?'BRIDGE_READ_ONLY':auth,error?.message||'桌面桥需要用户处理登录或只读状态');
    if(['RELEASED','TASK_NOT_FOUND','BAD_REQUEST','DESKTOP_TASK_INVALID','CONFLICT','TASK_CONFLICT'].includes(error?.code))return failClosed(ctx,task,error.code,error?.message||'桌面桥拒绝访问该任务');
    state.syncFailures++;
    await setConnection(ctx,'disconnected');
    if(state.syncFailures>MAX_SYNC_FAILURES)return monitorFailure(ctx,task,error);
    await ctx.sleep(retryDelay(state.syncFailures-1));
    continue;
   }
   state.syncFailures=0;needsSync=false;
   if(synced.terminal)return synced;
   await setConnection(ctx,'connected');
  }
  const control=await runEventStream(ctx,task,state,session);
  if(control.type==='terminal')return control.outcome;
  if(control.type==='resync'){state.resyncs++;if(state.resyncs>MAX_STREAM_FAILURES)return monitorFailure(ctx,task,Object.assign(Error('事件重同步次数过多'),{code:'EVENT_RESYNC_LIMIT'}));needsSync=true;state.streamFailures=0;await ctx.sleep(retryDelay(state.resyncs-1));continue;}
  if(control.type==='stopped')return {terminal:true,stopped:true};
  if(control.type==='fenced')throw new FencedError();
  if(control.type==='error'){
   const error=control.error;
   if(fenced(error))throw new FencedError();
   if(markerFailure(error))return failClosed(ctx,task,'MARKER_MISMATCH','事件任务标记不匹配；不采用该回答');
   if(truncatedFailure(error))return failClosed(ctx,task,'ANSWER_TRUNCATED','桌面桥结果被截断；不采用该回答');
   if(snapshotStale(error)||error?.code==='EVENT_SNAPSHOT_REQUIRED'){
    state.streamFailures++;
    await setConnection(ctx,'disconnected');
    if(state.streamFailures>MAX_STREAM_FAILURES)return monitorFailure(ctx,task,error);
    await ctx.sleep(retryDelay(state.streamFailures-1));
    continue;
   }
   const auth=authFailure(error);
   if(auth)return pauseTask(ctx,task,auth==='READ_ONLY'?'BRIDGE_READ_ONLY':auth,error?.message||'桌面桥需要用户处理登录或只读状态');
   if(error?.code==='EVENT_STREAM_REJECTED')return pauseTask(ctx,task,error.status===401?'NEEDS_LOGIN':'EVENT_STREAM_REJECTED',error.message||'桌面事件流拒绝连接');
   if(fatalEvent(error))return failClosed(ctx,task,error.code||'EVENT_INVALID',error.message||'桌面事件不合法');
   if(error?.code==='BAD_REQUEST'||error?.code==='TASK_NOT_FOUND'||error?.code==='RELEASED')return failClosed(ctx,task,error.code,error.message||'桌面桥拒绝请求');
   if(transientCode(error?.code))return monitorFailure(ctx,task,error);
   state.streamFailures++;
   await setConnection(ctx,'disconnected');
   if(state.streamFailures>MAX_STREAM_FAILURES)return monitorFailure(ctx,task,error);
   await ctx.sleep(retryDelay(state.streamFailures-1));
   continue;
  }
  state.streamFailures++;
  await setConnection(ctx,'disconnected');
  if(state.streamFailures>MAX_STREAM_FAILURES)return monitorFailure(ctx,task,Object.assign(Error('桌面事件流已关闭'),{code:'EVENT_STREAM_CLOSED'}));
  await ctx.sleep(retryDelay(state.streamFailures-1));
 }
}

async function rejectSend(ctx,task,error,session){
 const code=error?.code||'EXECUTE_REJECTED';
 const message=error?.message||'桌面桥拒绝发送';
 if(RETRY_SEND_REJECTIONS.has(code)){
  const current=store.row(ctx.db,task.id);
  // A rejected retry must never erase or reschedule a confirmed submission.
  if(current.result?.submission_confirmed===true)return failClosed(ctx,task,code,message);
  await updateOwnedTask(ctx,task.id,{send_intent:0,intent_at:null});
  const scheduled=store.scheduleRetry(ctx.db,task.id,message,{mode:'send',error_code:code});
  await setConnection(ctx,'connected');
  if(current.result?.answer)store.writeResultFile(ctx.db,task.id,current.result);
  return {terminal:true,status:scheduled.exhausted?'failed':'retry_wait'};
 }
 if(NO_SEND_REJECTIONS.has(code)){
  const current=store.row(ctx.db,task.id);
  if(!current.result?.submission_confirmed)await updateOwnedTask(ctx,task.id,{send_intent:0,intent_at:null});
  if(REQUEUE_CODES.has(code))return requeueTask(ctx,task,code,message,{mode:current.next_op||'send'});
  if(code==='READ_ONLY'||code==='BRIDGE_READ_ONLY')return pauseTask(ctx,task,'BRIDGE_READ_ONLY',message);
  if(code==='DESKTOP_INSTALLATION_CHANGED')return pauseTask(ctx,task,code,message);
  if(code==='PENDING_TASK')return pauseTask(ctx,task,code,message,{nextOp:null});
  if(current.result?.submission_confirmed&&current.result?.url)return failClosed(ctx,task,code,message);
  return failClosed(ctx,task,code,message);
 }
 if(code==='RELEASED'||code==='TASK_NOT_FOUND')return failClosed(ctx,task,code,message);
 return null;
}

async function sendFlow(ctx,task,readiness,session){
 const probe=readiness?.probe||{};
 const blocked=blockedReason(probe);
 if(blocked)return handleReadinessBlocked(ctx,task,blocked);
 const pending=readinessRetry(probe);
 if(pending)return handleStartupNotReady(ctx,task,pending);
 let wire;
 try{wire=wireForTask(task);}catch(error){
  await updateOwnedTask(ctx,task.id,{status:'failed',error:error.message,error_code:error.code||'ATTACHMENT_SNAPSHOT_INVALID',next_op:null,next_attempt:null});
  return {terminal:true,status:'failed'};
 }
 const marked=store.markSubmitting(ctx.db,task.id,ctx.token);
 if(!marked)throw new FencedError();
 await setConnection(ctx,'submitting');
 let initial=null,executeError=null;
 try{initial=await ctx.transport.execute(wire);}catch(error){executeError=error;}
 if(executeError){
  if(fenced(executeError))throw new FencedError();
  if(HANDLED_SEND_REJECTIONS.has(executeError.code))return rejectSend(ctx,task,executeError,session);
  // The RPC ended without a snapshot. If the bridge already fsynced a send
  // click, or the connection was lost mid-execute, persist intent so we
  // only snapshot/recover and never resend.
  if(store.ledgerSendIntent(task.id)||SEND_UNSAFE_CODES.has(executeError.code)){
   await updateOwnedTask(ctx,task.id,{send_intent:1,intent_at:store.now()});
  }
  ctx.log(`execute 返回前连接中断（${executeError.code||executeError.message||'未知'}）；只允许同步/查询/恢复，绝不重发`);
 }
 if(initial){
  try{await applyLocalSnapshot(ctx,task,initial);}
  catch(error){
   if(markerFailure(error))return failClosed(ctx,task,'MARKER_MISMATCH','桌面桥返回的任务标记不匹配；不采用该回答');
   if(truncatedFailure(error))return failClosed(ctx,task,'ANSWER_TRUNCATED','桌面桥结果被截断；不采用该回答');
   throw error;
  }
  const settled=await settleTask(ctx,task,{snapshot:initial,session});
  if(settled.terminal)return settled;
  return monitor(ctx,task,{mode:'snapshot',session,executeRevision:initial.revision,freshSend:true});
 }
 return monitor(ctx,task,{mode:'snapshot',session,executeRevision:null,freshSend:true});
}

async function handleTask(ctx,task){
 if(task.request?.kind==='probe')return probeTask(ctx,task);
 const readiness=await ensureReady(ctx);
 if(!readiness.running)return handleBridgeUnavailable(ctx,task,readiness);
 const blocked=blockedReason(readiness.probe);
 if(blocked)return handleReadinessBlocked(ctx,task,blocked);
 const pending=readinessRetry(readiness.probe);
 if(pending)return handleStartupNotReady(ctx,task,pending);
 const session={released:false};
 const ledgerSent=store.ledgerSendIntent(task.id);
 let mode=task.next_op||(task.recover||task.send_intent||ledgerSent?'snapshot':'send');
 if(mode==='send'&&(task.send_intent||ledgerSent))mode=recoveryMode(task,task.result);
 if(mode==='send'&&task.recover)mode=recoveryMode(task,task.result);
 if(mode==='send')return sendFlow(ctx,task,readiness,session);
 return monitor(ctx,task,{mode,session});
}

async function handleUnexpected(ctx,task,error){
 if(error.fenced)throw error;
 const current=store.row(ctx.db,task.id);
 const budgetActive=current.status==='partial'&&current.budget_exhausted===1;
 if(TERMINAL_STATUSES.has(current.status)&&!budgetActive)return;
 if(current.send_intent||ACTIVE_STATUSES.has(current.status)||budgetActive){
  const result=current.result||{};
  const mode=recoveryMode(task,result);
  if(!ctx.owns())throw new FencedError();
  const scheduled=store.deferMonitor(ctx.db,task.id,`执行异常：${error.message}`,{mode,error_code:error.code||'EXECUTOR_ERROR'});
  if(!scheduled.scheduled&&result.answer)store.writeResultFile(ctx.db,task.id,result);
  await setConnection(ctx,'disconnected');
 }else{
  await updateOwnedTask(ctx,task.id,{status:'failed',error:`执行失败，未发送：${error.message}`,error_code:error.code||'EXECUTOR_ERROR',next_attempt:null,next_op:null});
 }
}

function nearestRetryAt(db){
 const value=db.prepare("SELECT MIN(next_attempt) AS at FROM tasks WHERE next_attempt IS NOT NULL AND (status='retry_wait' OR (status='uncertain' AND next_op IS NOT NULL))").get()?.at;
 return Number.isFinite(value)?value:null;
}
function waitForQueue(ctx,{ignoreDeadline=false,eligibility=null,signal=null}={}){
 return new Promise(resolve=>{
  let done=false,watcher=null,timer=null,coalesce=null,control=null;
  const finish=()=>{if(done)return;done=true;clearInterval(control);clearTimeout(timer);clearTimeout(coalesce);signal?.removeEventListener('abort',finish);try{watcher?.close();}catch{}resolve();};
  if(signal?.aborted){finish();return;}
  signal?.addEventListener('abort',finish,{once:true});
  const options=()=>eligibility||queueOptions(ctx,ignoreDeadline);
  try{
   watcher=fs.watch(store.STATE,{persistent:true},(_event,name)=>{
    if(done)return;
    const changed=String(name||'');
    if(changed&&!/^(?:tasks\.sqlite(?:-wal|-shm)?|stop-worker)$/.test(changed))return;
    clearTimeout(coalesce);coalesce=setTimeout(()=>{if(!done&&(store.hasEligibleQueued(ctx.db,options())||store.stopRequested()||!ctx.owns()))finish();},25);
   });
   watcher.on('error',finish);
  }catch{}
  control=setInterval(()=>{if(!done&&(store.stopRequested()||!ctx.owns()))finish();},250);
  if(control.unref)control.unref();
  if(store.hasEligibleQueued(ctx.db,options())){finish();return;}
  if(!ignoreDeadline){
   const at=nearestRetryAt(ctx.db);
   if(Number.isFinite(at))timer=setTimeout(finish,Math.max(0,Math.min(at-Date.now(),2147483647)));
  }
  if(!watcher&&!timer)timer=setTimeout(finish,30000);
 });
}

async function runWorker({db,transport,token,sleep=sleepDefault,once=false,waitForOwnershipMs=0,log=message=>process.stderr.write(`${message}\n`)}={}){
 if(typeof token!=='string'||!token)throw Error('worker token 缺失');
 const inflight=new Map();
 const ctx={db,transport,token,sleep,log,fenced:false,activeAbort:null,aborts:new Map(),inflight,owns:()=>store.workerOwns(db,token),stopRequested:()=>store.stopRequested(),abortActive(reason){if(this.activeAbort)this.activeAbort(reason);for(const abort of this.aborts.values()){try{abort(reason);}catch{}}}};
 const heartbeat=setInterval(()=>{
  let owned=false;
  try{owned=store.heartbeatWorker(db,token);}catch{}
  if(!owned){ctx.fenced=true;ctx.abortActive('fenced');}
 },HEARTBEAT_MS);
 if(heartbeat.unref)heartbeat.unref();
 const track=async(task)=>{
  try{const outcome=await handleTask(ctx,task);return outcome;}
  catch(error){if(error.fenced)throw error;await handleUnexpected(ctx,task,error);return {terminal:true,error};}
  finally{inflight.delete(task.id);ctx.aborts.delete(task.id);}
 };
 let failure=null;
 try{
  const ownershipDeadline=Date.now()+Math.max(0,waitForOwnershipMs);
  while(!ctx.owns()&&Date.now()<ownershipDeadline)await sleep(100);
  if(!ctx.owns())return;
  for(;;){
   if(store.stopRequested())break;
   if(!ctx.owns())break;
   const paused=store.runtime(db)?.connection==='needs_user_action';
   const eligibility=queueOptions(ctx,paused);
   const task=store.nextTask(db,token,eligibility);
   if(task){
    const running=track(task);
    inflight.set(task.id,running);
    if(once){
     const outcome=await running;
     if(outcome?.stopped)break;
     break;
    }
    continue;
   }
   if(once)break;
   if(inflight.size){
    const queueWait=new AbortController();
    try{await Promise.race([...inflight.values(),waitForQueue(ctx,{ignoreDeadline:paused,eligibility:queueOptions(ctx,paused),signal:queueWait.signal})]);}
    finally{queueWait.abort();}
    continue;
   }
   await waitForQueue(ctx,{ignoreDeadline:paused,eligibility});
  }
 }catch(error){
  failure=error;
  throw error;
 }finally{
  clearInterval(heartbeat);
  let drainFailure=null;
  try{
   if(inflight.size){
    ctx.abortActive('stopped');
    const results=await Promise.allSettled([...inflight.values()]);
    for(const result of results){
     if(result.status==='rejected'&&result.reason?.fenced){drainFailure=result.reason;break;}
    }
   }
  }finally{
   try{store.releaseWorker(db,token);}catch(error){if(!failure)throw error;}
  }
  if(!failure&&drainFailure)throw drainFailure;
 }
}

async function main(){
 const db=store.open();
 const token=process.env.GEMINI_WORK_WORKER_TOKEN;
 if(!token){db.close();throw Error('worker 必须由 supervisor.cjs 启动');}
 const logPath=path.join(store.STATE,'worker.log');
 const log=message=>{try{fs.appendFileSync(logPath,`${new Date().toISOString()} ${message}\n`);}catch{}};
 const transport=new DesktopTransport();
 try{await runWorker({db,transport,token,waitForOwnershipMs:10000,log});}finally{db.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={runWorker,handleTask,settleTask,wireForTask,mergeResult,unsentProof,FencedError,STREAM_BACKOFF_MS,REQUEUE_CODES,GLOBAL_PAUSE_CODES};
