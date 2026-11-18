'use strict';
const store=require('./store.cjs');
const STATUSES=new Set(['connecting','submitting','generating','completed','partial','uncertain','needs_user_action','failed','retry_wait']);
const UNSENT_PROOF_CODES=new Set([...store.PRE_SEND_UNSENT_CODES].filter(code=>code!=='CHAT_NOT_READY'));
function cursor(db){
 const value=db.prepare("SELECT value FROM meta WHERE key='desktop_event_cursor'").get()?.value;
 return value?JSON.parse(value):null;
}
function fenced(db,token){if(db.prepare('SELECT worker_token FROM runtime WHERE singleton=1').get()?.worker_token!==token)throw Object.assign(Error('Worker lease changed'),{code:'WORKER_FENCED'});}
function saveCursor(db,value){db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('desktop_event_cursor',?)").run(JSON.stringify(value));}
// Send intent is monotonic. Only a terminal, explicit pre-send bridge failure
// proves the message was not sent; a bare not_sent preparing snapshot cannot
// erase an intent recorded at the real send boundary.
function confirmedUnsent(snapshot,result){
 if(!snapshot||typeof snapshot!=='object')return false;
 if(result?.submission_known!==true||result.submission_confirmed!==false)return false;
 if(!['failed','needs_user_action'].includes(snapshot.status))return false;
 return UNSENT_PROOF_CODES.has(snapshot.error?.code||'');
}
function chatNotReadyUnsent(snapshot,result){
 return snapshot?.send_state==='not_sent'&&snapshot.error?.code==='CHAT_NOT_READY'
  &&['failed','needs_user_action'].includes(snapshot.status)
  &&result?.submission_known===true&&result.submission_confirmed===false&&!result.answer&&!result.url;
}
// RPC replies, pushed events and reconnect synchronization share this mapping.
function submissionPatch(current,snapshot,result){
 if(snapshot.send_state==='confirmed'||result?.submission_confirmed||current.result?.submission_confirmed)return {send_intent:1,recover:1};
 if(snapshot.send_state==='submitted'||snapshot.send_state==='uncertain')return {send_intent:1,...(['needs_user_action','uncertain'].includes(snapshot.status)?{next_op:'snapshot'}:{})};
 if(snapshot.send_state==='not_sent'){
  const chatNotReady=chatNotReadyUnsent(snapshot,result);
  if(confirmedUnsent(snapshot,result)||chatNotReady)return {send_intent:0,intent_at:null,...(chatNotReady?{error_code:'NOT_SENT'}:{})};
  if(['needs_user_action','uncertain'].includes(snapshot.status))return {next_op:'snapshot'};
 }
 return {};
}
// Persist the bridge's explicit completion-unverified diagnostic in the
// existing result JSON. It never changes status/send intent and is cleared by
// normal progress after the idle ping or by a real completion.
function diagnosticOf(metadata,status,activity,prior){
 if(status==='completed'||metadata.completion_unverified!==true)return null;
 const pingAt=Date.parse(metadata.idle_ping_at||'');
 if(Number.isFinite(pingAt)&&Number.isFinite(activity)&&activity>pingAt)return null;
 const priorAt=Date.parse(prior?.at||'');
 if(Number.isFinite(priorAt)&&Number.isFinite(activity)&&activity>priorAt)return null;
 const reason=typeof metadata.completion_unverified_reason==='string'?metadata.completion_unverified_reason.slice(0,120):'completion_unverified';
 const ok=metadata.idle_ping_ok===true;
 const rawMessage=metadata.idle_ping_error?.message;
 const message=typeof rawMessage==='string'&&rawMessage?rawMessage.slice(0,400):ok?'空闲诊断未观察到新进度；完成状态未验证':'空闲诊断 ping 失败；完成状态未验证';
 return {completion_unverified:true,completion_unverified_reason:reason,diagnostic:{code:reason==='idle_ping_failed'?'COMPLETION_UNVERIFIED':'IDLE_NO_PROGRESS',message,reason,at:Number.isFinite(pingAt)?new Date(pingAt).toISOString():null,idle_ping_ok:ok,last_activity:Number.isFinite(activity)?activity:null}};
}
function applySnapshot(db,token,snapshot,point){
 if(!snapshot||typeof snapshot.task_id!=='string'||!STATUSES.has(snapshot.status))throw Error('EVENT_SNAPSHOT_INVALID');
 const task=db.prepare('SELECT worker FROM tasks WHERE id=?').get(store.id(snapshot.task_id));
 // Older direct bridge diagnostics and other tasks do not belong to this claim.
 if(!task||task.worker!==token)return false;
 const current=store.row(db,snapshot.task_id),result=snapshot.result;
 if(result?.marker&&result.marker!==current.marker)throw Error('EVENT_MARKER_MISMATCH');
 const revision=snapshot.revision??snapshot.metadata?.revision??0;
 if(!Number.isSafeInteger(revision)||revision<0)throw Error('EVENT_REVISION_INVALID');
 if(current.event_instance===point.instance_id&&revision<current.result_revision)return false;
 const metadata=snapshot.metadata||{};
 const patch={status:snapshot.status,phase:snapshot.phase||snapshot.status,error:snapshot.error?.message||null,error_code:snapshot.error?.code||null,event_instance:point.instance_id,event_seq:point.seq,result_revision:revision,event_connection:'connected',observer_state:metadata.observer_state||'bound',budget_exhausted:metadata.budget_exhausted||snapshot.budget_exhausted?1:0};
 const activity=Number.isFinite(metadata.last_activity)?metadata.last_activity:Date.parse(metadata.last_state_at||'');
 if(Number.isFinite(activity))patch.last_activity=activity;
 const diagnostic=diagnosticOf(metadata,snapshot.status,activity,current.result?.diagnostic);
 if(result){
  if(typeof result.answer!=='string')throw Error('EVENT_ANSWER_INVALID');
  if(result.answer_truncated||metadata.answer_truncated)throw Error('EVENT_ANSWER_TRUNCATED');
  const merged={...current.result,...result,timings:metadata.diagnostics||current.result?.timings||null};
  if(diagnostic)Object.assign(merged,diagnostic);
  else{
   delete merged.completion_unverified;delete merged.completion_unverified_reason;delete merged.diagnostic;
  }
  patch.result=merged;
 }else if(!diagnostic&&current.result?.completion_unverified){
  const cleared={...current.result};delete cleared.completion_unverified;delete cleared.completion_unverified_reason;delete cleared.diagnostic;
  patch.result=cleared;
 }
 Object.assign(patch,submissionPatch(current,snapshot,patch.result||current.result));
 if(snapshot.status==='completed'||snapshot.status==='failed'){patch.next_attempt=null;patch.next_op=null;}
 store.update(db,current.id,patch);return true;
}
// The snapshot/result and cursor advance always commit together.
function applyEvent(db,token,event,{snapshot=event.snapshot}={}){
 if(!event||typeof event.instance_id!=='string'||!Number.isSafeInteger(event.seq)||event.seq<1)throw Error('EVENT_ENVELOPE_INVALID');
 db.exec('BEGIN IMMEDIATE');
 try{
  fenced(db,token);const prior=cursor(db);
  if(!prior||prior.instance_id!==event.instance_id){db.exec('ROLLBACK');return {reset:true};}
  if(event.seq<=prior.seq){db.exec('ROLLBACK');return {duplicate:true};}
  if(event.seq!==prior.seq+1){db.exec('ROLLBACK');return {gap:true};}
  const point={instance_id:event.instance_id,seq:event.seq};
  if(event.snapshot_required&&!snapshot)throw Error('EVENT_SNAPSHOT_REQUIRED');
  const changed=snapshot?applySnapshot(db,token,snapshot,point):false;
  saveCursor(db,point);db.exec('COMMIT');return {applied:true,changed};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
function synchronize(db,token,{instance_id,seq,snapshots}){
 if(typeof instance_id!=='string'||!Number.isSafeInteger(seq)||seq<0||!Array.isArray(snapshots))throw Error('EVENT_SYNC_INVALID');
 db.exec('BEGIN IMMEDIATE');
 try{
  fenced(db,token);const prior=cursor(db);
  if(prior?.instance_id===instance_id&&seq<prior.seq){db.exec('ROLLBACK');return {stale:true};}
  const point={instance_id,seq};
  for(const snapshot of snapshots)applySnapshot(db,token,snapshot,point);
  saveCursor(db,point);db.exec('COMMIT');return point;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
module.exports={cursor,applyEvent,synchronize,submissionPatch,confirmedUnsent,chatNotReadyUnsent};
