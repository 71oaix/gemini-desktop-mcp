'use strict';
// Event-driven task state machine for one Gemini desktop generation.
// It consumes ObservationHost state pushes; it never reads the page, chooses a
// webContents, navigates, or treats native lifecycle notifications as truth.
const {EventEmitter}=require('node:events');
const page=require('./desktop-page.cjs');

const PHASES=Object.freeze([
 'preparing','ready_to_send','awaiting_confirmation','generating',
 'verifying_completion','completed','retry_wait','needs_user_action','uncertain'
]);
const PHASE_STATUS=Object.freeze({
 preparing:'connecting',
 ready_to_send:'submitting',
 awaiting_confirmation:'submitting',
 generating:'generating',
 verifying_completion:'generating',
 completed:'completed',
 retry_wait:'retry_wait',
 needs_user_action:'needs_user_action',
 uncertain:'uncertain'
});
const COMPLETION_STABLE_MS=2000;
const MAX_NATIVE_PHASES=20;
// Page control (the DOM copy button) is the only completion evidence the mode
// policy ever assumed. A verified chat surface may additionally accept the
// strict native start/complete pair for the same task and conversation, but
// only together with an owned, paired, untruncated, stable DOM answer and no
// visible generation. Unknown and task surfaces keep the page-control path.
const EVIDENCE_PAGE='page-control';
const EVIDENCE_CHAT_COMPOSITE='chat-composite';

function iso(ms){return new Date(ms).toISOString();}
function clone(value){try{return JSON.parse(JSON.stringify(value));}catch{return null;}}
function machineError(code,message){const error=new Error(message||code);error.code=code;return error;}
// Native lifecycle notifications prefix the conversation id with 'c_' while the
// chat URL carries the bare id. Accept exactly those two observed forms only.
function nativeConversationMatches(nativeId,urlId){
 if(typeof nativeId!=='string'||typeof urlId!=='string'||!nativeId||!urlId)return false;
 return nativeId===urlId||nativeId==='c_'+urlId;
}

// A finished turn requires no generation from the composer and none in the
// owned response's own scope. An explicit response-level false outranks the
// whole-page progressbar (which may be a sidebar upload); observations that
// predate the scoped field keep the whole-page signal.
function generationActive(state,response){
 if(page.hasStop(state))return true;
 if(!response)return state.generates===true;
 if(response.generating===true)return true;
 if(response.generating===false)return false;
 return state.generates===true;
}

class TaskMachine extends EventEmitter{
 constructor(spec={},options={}){
  super();
  spec=spec&&typeof spec==='object'?spec:{};
  options=options&&typeof options==='object'?options:{};
  this.marker=typeof spec.marker==='string'?spec.marker:'';
  this.taskId=typeof spec.taskId==='string'?spec.taskId:(typeof spec.task_id==='string'?spec.task_id:null);
  this.beforeResponses=Number.isInteger(spec.beforeResponses)?spec.beforeResponses:0;
  this.confirmedUrl=typeof spec.confirmedUrl==='string'?spec.confirmedUrl:null;
  // Only an explicitly verified surface may relax completion; the default
  // stays unknown so an unconfigured machine never treats a native pair as a
  // finished turn.
  this.actualMode=spec.actualMode==='chat'||spec.actualMode==='task'?spec.actualMode:'unknown';
  this.stableMs=Number.isFinite(options.stableMs)&&options.stableMs>=0?options.stableMs:COMPLETION_STABLE_MS;
  this._now=typeof options.now==='function'?options.now:Date.now;
  this._setTimeout=typeof options.setTimeout==='function'?options.setTimeout:setTimeout;
  this._clearTimeout=typeof options.clearTimeout==='function'?options.clearTimeout:clearTimeout;
  this.phase=PHASES.includes(spec.phase)?spec.phase:'preparing';
  this.armed=false;
  this.sent=!!spec.sent;
  this.terminal=false;
  this.answer='';
  this.answerRevision=0;
  this.markerSeen=false;
  this.lastState=null;
  this.lastStateAt=null;
  this.candidate=null;
  this.timer=null;
 this.native=[];this.nativeStart=null;this.nativeComplete=null;this.nativeAmbiguous=false;
 const started=this._now();
 this.diagnostics={
  started_at:iso(started),states:0,answers:0,candidates:0,resets:0,
  completions:0,native:0,faults:0,truncated:0,unpaired:0,
  native_ambiguity:null,last_unpaired:null,last_failure:null,completion:null
 };
 }
 get status(){return PHASE_STATUS[this.phase]||'uncertain';}
 get nativePhases(){return this.native.slice();}
 configure(patch={}){
  if(Number.isInteger(patch.beforeResponses))this.beforeResponses=patch.beforeResponses;
  if(patch.actualMode==='chat'||patch.actualMode==='task'||patch.actualMode==='unknown'){
   if(this.actualMode!==patch.actualMode){
    this.actualMode=patch.actualMode;
    // A composite candidate depends on the surface staying chat; any mode
    // change invalidates it instead of letting it finish under a new mode.
    if(this.candidate&&this.candidate.evidence===EVIDENCE_CHAT_COMPOSITE){
     this._cancelCandidate();
     if(this.phase==='verifying_completion')this.setPhase('generating');
    }
   }
  }
  if(typeof patch.confirmedUrl==='string'&&patch.confirmedUrl!==this.confirmedUrl){
   this.confirmedUrl=patch.confirmedUrl;
   // Native events seen before the conversation URL was known cannot be
   // filtered. Drop a start that provably belongs to another conversation.
   const urlId=page.conversationId(this.confirmedUrl);
   if(urlId&&this.nativeStart&&!nativeConversationMatches(this.nativeStart.conversationId,urlId)){
    this.nativeStart=null;this.nativeComplete=null;
    this._cancelCompositeCandidate();
   }
  }
  if(typeof patch.taskId==='string')this.taskId=patch.taskId;
  if(typeof patch.marker==='string')this.marker=patch.marker;
  return this;
 }
 setPhase(phase,meta={}){
  if(!PHASES.includes(phase))throw machineError('PHASE_INVALID','无效状态机阶段 '+phase);
  if(this.phase===phase)return false;
  this.phase=phase;
  this.emit('phase',{phase,status:this.status,at:this._now(),...meta});
  return true;
 }
 arm(){
  if(this.terminal)return this;
  this.armed=true;
  this.sent=true;
  this.setPhase('generating');
  return this;
 }
 _cancelCandidate(count=true){
  if(this.timer!==null){try{this._clearTimeout(this.timer);}catch{}this.timer=null;}
  if(this.candidate&&count)this.diagnostics.resets+=1;
  this.candidate=null;
 }
 _cancelCompositeCandidate(){
  if(!this.candidate||this.candidate.evidence!==EVIDENCE_CHAT_COMPOSITE)return;
  this._cancelCandidate();
  if(this.phase==='verifying_completion')this.setPhase('generating');
 }
 // Strict native evidence for a verified chat turn: one start and one later
 // complete for this task id and this confirmed conversation, with no
 // duplicate/overlap ambiguity. It is only ever combined with the owned DOM
 // answer below; it never completes a turn on its own.
 _chatNativePair(){
  if(this.actualMode!=='chat'||this.nativeAmbiguous)return false;
  const start=this.nativeStart,complete=this.nativeComplete;
  if(!start||!complete)return false;
  if(start.phase!=='start'||complete.phase!=='complete')return false;
  if(!this.taskId||start.task_id!==this.taskId||complete.task_id!==this.taskId)return false;
  if(!(complete.sequence>start.sequence))return false;
  const urlId=page.conversationId(this.confirmedUrl);
  if(!urlId)return false;
  if(!nativeConversationMatches(start.conversationId,urlId))return false;
  if(!nativeConversationMatches(complete.conversationId,urlId))return false;
  return true;
 }
 _truncation(state,response){
  if(state.truncated===true)return {code:'STATE_TRUNCATED',message:'观察数据被截断，停止判定完成'};
  if(state.answer_truncated===true)return {code:'ANSWER_TRUNCATED',message:'回答被观察层截断，停止判定完成'};
  if(response&&response.answer_truncated===true)return {code:'ANSWER_TRUNCATED',message:'回答被观察层截断，停止判定完成'};
  return null;
 }
 ingest(state,meta={}){
  if(this.terminal)return this.snapshot();
  if(!state||typeof state!=='object'||Array.isArray(state))return this.snapshot();
  this.lastState=state;
  this.lastStateAt=this._now();
  if(!this.armed)return this.snapshot();
  const diagnostics=this.diagnostics;
  diagnostics.states+=1;
  const responses=Array.isArray(state.responses)?state.responses:[];
  const queries=Array.isArray(state.queries)?state.queries:[];
  const hit=page.isMarkerLast(queries,this.marker);
  // Ownership is the marker's own query slot, not merely "a new last response".
  // A response is usable only when queries and responses are paired, the slot
  // exists, and it is at or after the pre-send response baseline. Otherwise the
  // last response may still be an older turn's answer.
  const markerIndex=hit.count===1&&hit.last?queries.findIndex(query=>String(query||'').includes(this.marker)):-1;
  const slotOwned=markerIndex>=0&&markerIndex>=this.beforeResponses;
  const paired=slotOwned&&queries.length===responses.length;
  const response=paired?responses[markerIndex]:null;
  const responseIndex=markerIndex;
  const truncated=this._truncation(state,response);
  if(truncated){diagnostics.truncated+=1;return this.fail(truncated.code,truncated.message);}
  if(hit.count>1)return this.fail('MARKER_DUPLICATED','会话中出现多个任务标记，停止判定完成');
  if(hit.count===1&&!hit.last)return this.fail('MARKER_NOT_LAST','任务标记后出现新的用户消息，停止判定完成');
  if(hit.count===0&&this.markerSeen&&(queries.length>0||responses.length>this.beforeResponses))return this.fail('MARKER_MISMATCH','已确认会话中找不到原任务标记，停止判定完成');
  if(hit.count===0){this._cancelCandidate();return this.snapshot();}
  if(hit.count===1)this.markerSeen=true;
  if(this.confirmedUrl&&typeof state.url==='string'&&state.url&&!page.sameConversation(state.url,this.confirmedUrl)){
   return this.fail('CONVERSATION_CHANGED','会话已切换到其他对话，停止判定完成');
  }
  if(!paired){
   diagnostics.unpaired+=1;
   diagnostics.last_unpaired={
    queries:queries.length,responses:responses.length,marker_index:markerIndex,
    before_responses:this.beforeResponses,
    reason:slotOwned?'length-mismatch':'marker-before-baseline',at:iso(this._now())
   };
   this._cancelCandidate();
   if(this.phase==='verifying_completion')this.setPhase('generating');
   return this.snapshot();
  }
  const answer=response&&typeof response.answer==='string'?response.answer:null;
  if(answer!==null&&answer!==this.answer){
   this.answer=answer;
   this.answerRevision+=1;
   diagnostics.answers+=1;
   this.emit('answer',{answer,revision:this.answerRevision,responseIndex,at:this._now()});
  }
  const answerReady=answer!==null&&answer.trim().length>0;
  const generating=generationActive(state,response);
  // Completion evidence. Page control (the DOM response.complete marker) still
  // finishes any mode, and remains the only path for task/unknown. A verified
  // chat turn may instead combine a strict native pair with the same owned,
  // paired, untruncated answer. Both paths share one conflict rule: the composer
  // must not show a stop control and the owned response must not be generating.
  // Native lifecycle alone is never enough.
  let evidence=null;
  if(hit.count===1&&hit.last&&!!response&&answerReady&&!generating){
   if(response.complete===true)evidence=EVIDENCE_PAGE;
   else if(this._chatNativePair())evidence=EVIDENCE_CHAT_COMPOSITE;
  }
  const valid=!!evidence;
  if(valid)this.completionEvidence=evidence;
  if(!valid){
   this._cancelCandidate();
   if(this.phase==='verifying_completion')this.setPhase('generating');
   return this.snapshot();
  }
  if(this.candidate&&this.candidate.answer===answer&&this.candidate.responseIndex===responseIndex&&this.candidate.evidence===evidence){
   return this.snapshot();
  }
  this._cancelCandidate();
  const started=this._now();
  this.candidate={answer,responseIndex,startedAt:started,evidence};
  diagnostics.candidates+=1;
  this.setPhase('verifying_completion');
  this.timer=this._setTimeout(()=>this._finishCompletion(),this.stableMs);
  if(this.timer&&typeof this.timer.unref==='function')this.timer.unref();
  return this.snapshot();
 }
 handleState(state,meta={}){return this.ingest(state,meta);}
 _finishCompletion(){
  if(this.terminal||!this.candidate)return;
  const candidate=this.candidate;
  this.candidate=null;
  if(this.timer!==null){try{this._clearTimeout(this.timer);}catch{}this.timer=null;}
  const completedAt=this._now();
  this.diagnostics.completions+=1;
  this.diagnostics.completion={
   candidate_started_at:iso(candidate.startedAt),
   completed_at:iso(completedAt),
   stable_ms:this.stableMs,evidence:candidate.evidence,
   states_observed:this.diagnostics.states
  };
  this.setPhase('completed');
  this.terminal=true;
  const outcome={
   code:'COMPLETED',answer:candidate.answer,url:this.lastState&&this.lastState.url||this.confirmedUrl,
   marker:this.marker,responseIndex:candidate.responseIndex,task_id:this.taskId,
   completed_at:iso(completedAt),candidate_started_at:iso(candidate.startedAt),stable_ms:this.stableMs,
   diagnostics:this.snapshot().diagnostics
  };
  this.emit('complete',outcome);
 }
 fail(code,message){
  if(this.terminal)return this.snapshot();
  this._cancelCandidate(false);
  this.terminal=true;
  this.diagnostics.last_failure={code:String(code||'MACHINE_FAILED'),message:String(message||code||'任务停止'),at:iso(this._now())};
  const phase=this.sent?'needs_user_action':'uncertain';
  this.setPhase(phase);
  const outcome={code:String(code||'MACHINE_FAILED'),message:String(message||code||'任务停止'),at:this._now(),phase,answer:this.answer,diagnostics:this.snapshot().diagnostics};
  this.emit('conflict',outcome);
  return this.snapshot();
 }
 _nativeAmbiguity(code){
  this.nativeAmbiguous=true;
  this.nativeStart=null;this.nativeComplete=null;
  this.diagnostics.native_ambiguity={code,at:iso(this._now())};
  this._cancelCompositeCandidate();
 }
 _noteNativePair(record,phase){
  if(this.nativeAmbiguous)return;
  // task_id is only the local ObservationHost binding, not a server turn id.
  // Exactly one start and one later complete from the target conversation is
  // evidence; any overlap, duplicate start, duplicate complete, or out-of-order
  // sequence voids native evidence instead of guessing a pairing.
  const urlId=page.conversationId(this.confirmedUrl);
  if(urlId&&!nativeConversationMatches(record.conversationId,urlId))return;
  if(phase==='start'){
   // A new start after a pair means a new generation; it must invalidate any
   // pending composite candidate instead of letting the old answer finish.
   if(this.candidate&&this.candidate.evidence===EVIDENCE_CHAT_COMPOSITE)this._cancelCompositeCandidate();
   if(this.nativeStart||this.nativeComplete)return this._nativeAmbiguity('NATIVE_START_DUPLICATED');
   this.nativeStart=record;this.nativeComplete=null;
   return;
  }
  if(!this.nativeStart)return;
  if(this.nativeComplete||!(record.sequence>this.nativeStart.sequence))return this._nativeAmbiguity('NATIVE_PAIR_INVALID');
  this.nativeComplete=record;
 }
 noteNative(turn){
  if(!turn||typeof turn!=='object')return this.snapshot();
  const phase=typeof turn.phase==='string'?turn.phase.slice(0,64):'';
  if(!phase)return this.snapshot();
  this.diagnostics.native+=1;
  const record={conversationId:typeof turn.conversationId==='string'?turn.conversationId:null,phase,at:Number.isFinite(turn.at)?turn.at:this._now(),sequence:turn.sequence||this.diagnostics.native,task_id:typeof turn.task_id==='string'?turn.task_id:null};
  if(record.task_id&&this.taskId)record.correlated=record.task_id===this.taskId;
  this.native.push(record);
  if(this.native.length>MAX_NATIVE_PHASES)this.native.splice(0,this.native.length-MAX_NATIVE_PHASES);
  // Advisory only: native phases never set completion or any terminal phase.
  // awaiting_confirmation is included so a very fast send can still pair its
  // own start/complete before the URL confirmation moves the phase on.
  if(record.correlated&&record.conversationId&&(phase==='start'||phase==='complete')&&['awaiting_confirmation','generating','verifying_completion'].includes(this.phase))this._noteNativePair(record,phase);
  this.emit('native-advisory',record);
  if(this.armed&&this.lastState)this.ingest(this.lastState);
  return this.snapshot();
 }
 noteFault(fault){
  if(!fault)return this.snapshot();
  this._cancelCandidate();
  this.lastState=null;this.nativeStart=null;this.nativeComplete=null;
  if(this.phase==='verifying_completion')this.setPhase('generating');
  this.diagnostics.faults+=1;
  this.emit('fault-advisory',{code:String(fault.code||'FAULT'),message:String(fault.message||''),at:fault.at||this._now()});
  return this.snapshot();
 }
 interrupt(code,message){
  return this.fail(code||'INTERRUPTED',message||'任务被中断');
 }
 snapshot(){
  return {
   phase:this.phase,status:this.status,armed:this.armed,terminal:this.terminal,
   answer:this.answer,answer_revision:this.answerRevision,marker_seen:this.markerSeen,
   confirmed_url:this.confirmedUrl,before_responses:this.beforeResponses,actual_mode:this.actualMode,
   candidate:this.candidate?{...this.candidate}:null,native:this.native.slice(),
   native_ambiguous:this.nativeAmbiguous,
   diagnostics:clone(this.diagnostics)
  };
 }
 dispose(){
  this._cancelCandidate(false);
  this.removeAllListeners();
 }
}
function createMachine(spec,options){return new TaskMachine(spec,options);}
module.exports={
 TaskMachine,createMachine,PHASES,PHASE_STATUS,COMPLETION_STABLE_MS,MAX_NATIVE_PHASES,machineError
};
