'use strict';
// Read-only observation host for one Gemini BrowserWindow. The renderer
// preload pushes finite state and native lifecycle envelopes here. Only a
// native envelope that repeats the source binding/document/generation/task
// context may become an authoritative `native-turn`; the original app channel
// is recorded as a raw diagnostic and never proves task ownership. This module
// does not read files, open sockets, drive the page, or choose any webContents
// other than the bound one.
const {EventEmitter}=require('node:events');
const crypto=require('node:crypto');

const EVENT_CHANNEL='gemini-work:observer-event';
const CONTROL_CHANNEL='gemini-work:observer-control';
const NATIVE_CHANNEL='gemini:notify-turn-lifecycle';
const OBSERVER_PROTOCOL=1;
const MAX_PAYLOAD_BYTES=2*1024*1024;
const MAX_ANSWER_BYTES=1024*1024;
const MAX_NATIVE_BYTES=8*1024;
const MAX_NATIVE_PHASES=20;
const MAX_RESPONSES=1000;

function HostError(code,message){const error=new Error(message||code);error.code=code;return error;}
function isPlainObject(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const proto=Object.getPrototypeOf(value);
 return proto===Object.prototype||proto===null;
}
const OBSERVED_PATH=/^\/(?:u\/\d+\/)?(?:app(?:\/[A-Za-z0-9_-]+)?)?\/?$/;
function isTrustedUrl(value){
 if(typeof value!=='string'||value.length>4096)return false;
 let url;
 try{url=new URL(value);}catch{return false;}
 if(url.username||url.password||url.port)return false;
 return url.protocol==='https:'&&url.hostname==='gemini.google.com'&&OBSERVED_PATH.test(url.pathname);
}
function isBindingId(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value);}
function isTaskId(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);}
function payloadBytes(value){
 try{return Buffer.byteLength(JSON.stringify(value),'utf8');}catch{return Infinity;}
}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

class ObservationHost extends EventEmitter{
 constructor(options={}){
  super();
  options=options||{};
  const wc=options.wc,ipcMain=options.ipcMain;
  if(!wc||typeof wc.on!=='function'||typeof wc.removeListener!=='function'||typeof wc.send!=='function')throw HostError('WC_INVALID','WebContents 不可用');
  if(!ipcMain||typeof ipcMain.on!=='function'||typeof ipcMain.removeListener!=='function')throw HostError('IPC_INVALID','ipcMain 不可用');
  this.wc=wc;
  this._ipcMain=ipcMain;
  this._now=typeof options.now==='function'?options.now:Date.now;
  this._maxPayloadBytes=Number.isInteger(options.maxPayloadBytes)?options.maxPayloadBytes:MAX_PAYLOAD_BYTES;
  this._maxAnswerBytes=Number.isInteger(options.maxAnswerBytes)?options.maxAnswerBytes:MAX_ANSWER_BYTES;
  if(this._maxPayloadBytes<1024||this._maxAnswerBytes<1024)throw HostError('LIMITS_INVALID','观察上限过小');
  this._bindingId=null;
  this._generation=0;
  this._lastSeq=0;
  this._documentId=null;
  this._taskId=null;
  this._state=null;
  this._closed=false;
  this._readySettled=false;
  this._pendingPings=new Map();
  this._waiters=new Set();
  this._nativePhases=[];
  this._nativeSeq=0;
  this._lastNativeSeq=0;
  this._diagnostics={hello:0,state:0,pong:0,native:0,raw_native:0,rejected:{sender:0,frame:0,url:0,payload:0,schema:0,binding:0,generation:0,sequence:0,task:0}};
  this.ready=new Promise((resolve,reject)=>{this._readyResolve=resolve;this._readyReject=reject;});
  this.ready.catch(()=>{});
  this._onMessage=this._handleMessage.bind(this);
  this._onNative=this._handleNative.bind(this);
  this._ipcListeners=[];
  this._ipcMain.on(EVENT_CHANNEL,this._onMessage);this._ipcListeners.push([this._ipcMain,EVENT_CHANNEL,this._onMessage]);
  this._ipcMain.on(NATIVE_CHANNEL,this._onNative);this._ipcListeners.push([this._ipcMain,NATIVE_CHANNEL,this._onNative]);
  this._wcListeners=[];
  this._bindNativeEvents();
 }
 get closed(){return this._closed;}
 get currentState(){return this._state;}
 get taskId(){return this._taskId;}
 get binding(){
  if(this._closed||!this._bindingId)return null;
  return {bindingId:this._bindingId,generation:this._generation,documentId:this._documentId,task_id:this._taskId};
 }
 get nativePhases(){return this._nativePhases.slice();}
 get diagnostics(){
  const rejected={};for(const [key,value] of Object.entries(this._diagnostics.rejected))rejected[key]=value;
  return {...this._diagnostics,rejected};
 }
 _reject(reason){this._diagnostics.rejected[reason]+=1;}
 _fault(code,message,extra={}){
  if(this._closed)return;
  const fault={code:String(code||'OBSERVATION_FAULT'),message:String(message||code||''),at:this._now(),...extra};
  try{this.emit('fault',fault);}catch{}
 }
 _isMainFrame(frame){
  if(!frame)return false;
  if(this.wc.mainFrame)return frame===this.wc.mainFrame;
  return frame.parent===null||frame.parent===undefined;
 }
 _frameUrl(event){
  if(event&&event.senderFrame&&typeof event.senderFrame.url==='string')return event.senderFrame.url;
  try{if(typeof this.wc.getURL==='function')return this.wc.getURL();}catch{}
  return '';
 }
 _validateEvent(event){
  if(!event||event.sender!==this.wc){this._reject('sender');return null;}
  if(!this._isMainFrame(event.senderFrame)){this._reject('frame');return null;}
  const url=this._frameUrl(event);
  if(!isTrustedUrl(url)){this._reject('url');return null;}
  return {url};
 }
 _validState(state){
  if(!isPlainObject(state))return false;
  if(typeof state.url!=='string'||!isTrustedUrl(state.url))return false;
  if(typeof state.clientShell!=='boolean')return false;
  if(!Array.isArray(state.responses)||state.responses.length>MAX_RESPONSES)return false;
  for(const response of state.responses){
   if(!isPlainObject(response)||typeof response.answer!=='string')return false;
   if(Buffer.byteLength(response.answer,'utf8')>this._maxAnswerBytes)return false;
  }
  for(const key of ['controls','models','uploads','queries','sendButtons']){
   if(state[key]!==undefined&&!Array.isArray(state[key]))return false;
  }
  return true;
 }
 _sendControl(message){
  try{this.wc.send(CONTROL_CHANNEL,message);return true;}
  catch(error){
   this._fault('CONTROL_SEND_FAILED','无法向观察器发送 '+message.type);
   return false;
  }
 }
 _handleMessage(event,payload){
  if(this._closed)return;
  const source=this._validateEvent(event);if(!source)return;
  if(payload?.type==='hello'&&payload.url!==source.url){this._reject('url');return;}
  if(payload?.type==='state'&&payload.state?.url!==source.url){this._reject('url');return;}
  if(!isPlainObject(payload)){this._reject('schema');return;}
  if(payloadBytes(payload)>this._maxPayloadBytes){this._reject('payload');return;}
  if(payload.type==='hello')return this._handleHello(payload);
  if(payload.type==='state')return this._handleState(payload);
  if(payload.type==='native')return this._handleNativeEnvelope(payload);
  if(payload.type==='fault'){if(payload.bindingId!==this._bindingId||payload.generation!==this._generation||payload.task_id!==this._taskId||!Number.isInteger(payload.seq)||payload.seq<=this._lastSeq){this._reject('binding');return;}this._lastSeq=payload.seq;this._fault('OBSERVER_READ_FAILED',String(payload.message||'observer failed').slice(0,500));return;}
  if(payload.type==='pong')return this._handlePong(payload);
  this._reject('schema');
 }
 _handleHello(payload){
  if(payload.protocol!==OBSERVER_PROTOCOL){this._reject('schema');return;}
  if(!isBindingId(payload.documentId)){this._reject('schema');return;}
  if(typeof payload.url!=='string'||!isTrustedUrl(payload.url)){this._reject('url');return;}
  this._generation+=1;
  this._bindingId=crypto.randomUUID();
  this._documentId=payload.documentId;
  this._lastSeq=0;
  this._lastNativeSeq=0;
  this._state=null;
  this._rejectPings('NOT_BOUND');
  this._diagnostics.hello+=1;
  this._diagnostics.runtime=payload.diagnostics||null;
  const bind={type:'bind',bindingId:this._bindingId,generation:this._generation,task_id:this._taskId,protocol:OBSERVER_PROTOCOL};
  this._sendControl(bind);
  this.emit('bind',{bindingId:this._bindingId,generation:this._generation,documentId:this._documentId,task_id:this._taskId});
 }
 _handleState(payload){
  if(!this._bindingId){this._reject('binding');return;}
  if(payload.bindingId!==this._bindingId){this._reject('binding');return;}
  if(!Number.isInteger(payload.generation)||payload.generation!==this._generation){this._reject('generation');return;}
  if(!Number.isInteger(payload.seq)||payload.seq<=this._lastSeq){this._reject('sequence');return;}
  if(payload.task_id!==this._taskId){this._reject('task');return;}
  if(!this._validState(payload.state)){this._reject('schema');return;}
  this._lastSeq=payload.seq;
  this._state=payload.state;
  this._diagnostics.state+=1;
  const meta={bindingId:this._bindingId,generation:this._generation,seq:payload.seq,task_id:this._taskId,at:this._now()};
  if(!this._readySettled){this._readySettled=true;this._readyResolve(payload.state);}
  this.emit('state',payload.state,meta);
  this._settleWaiters(payload.state);
 }
 _handlePong(payload){
  if(payload.documentId!==this._documentId||payload.bindingId!==this._bindingId||payload.generation!==this._generation){
   this._reject('binding');return;
  }
  const pending=this._pendingPings.get(payload.nonce);
  if(!pending){this._reject('schema');return;}
  this._finishPing(pending);
  this._pendingPings.delete(payload.nonce);
  this._diagnostics.pong+=1;
  pending.resolve({nonce:payload.nonce,documentId:payload.documentId,at:this._now()});
 }
 _handleNative(event,payload){
  if(this._closed)return;
  if(!this._validateEvent(event))return;
  if(!isPlainObject(payload)||payloadBytes(payload)>MAX_NATIVE_BYTES){this._reject('payload');return;}
  const phase=typeof payload.phase==='string'?payload.phase.trim():'';
  if(!phase||phase.length>64){this._reject('schema');return;}
  // The original preload channel cannot name the observer binding, so a late
  // notification from the same frame and URL cannot be attributed to the
  // current task. Keep it as raw diagnostic evidence only.
  const turn={phase,at:this._now(),sequence:++this._nativeSeq,task_id:null,conversationId:typeof payload.conversationId==='string'?payload.conversationId.slice(0,200):null,authoritative:false};
  if(isTaskId(payload.task_id))turn.task_id=payload.task_id;
  this._nativePhases.push(turn);
  if(this._nativePhases.length>MAX_NATIVE_PHASES)this._nativePhases.splice(0,this._nativePhases.length-MAX_NATIVE_PHASES);
  this._diagnostics.raw_native+=1;
  if(phase==='complete'&&this._bindingId)this._sendControl({type:'sample'});
 }
 _handleNativeEnvelope(payload){
  if(payloadBytes(payload)>MAX_NATIVE_BYTES){this._reject('payload');return;}
  if(!this._bindingId){this._reject('binding');return;}
  if(!isBindingId(payload.documentId)||payload.documentId!==this._documentId){this._reject('binding');return;}
  if(payload.bindingId!==this._bindingId){this._reject('binding');return;}
  if(!Number.isInteger(payload.generation)||payload.generation!==this._generation){this._reject('generation');return;}
  if(payload.task_id!==this._taskId){this._reject('task');return;}
  if(!Number.isInteger(payload.seq)||payload.seq<=this._lastNativeSeq){this._reject('sequence');return;}
  const phase=typeof payload.phase==='string'?payload.phase.trim():'';
  if(!phase||phase.length>64){this._reject('schema');return;}
  this._lastNativeSeq=payload.seq;
  const conversationId=typeof payload.conversationId==='string'?payload.conversationId.slice(0,200):null;
  const authoritative=phase==='start'||phase==='complete';
  const turn={phase,at:this._now(),sequence:++this._nativeSeq,task_id:this._taskId,conversationId,authoritative,documentId:this._documentId,bindingId:this._bindingId,generation:this._generation};
  this._nativePhases.push(turn);
  if(this._nativePhases.length>MAX_NATIVE_PHASES)this._nativePhases.splice(0,this._nativePhases.length-MAX_NATIVE_PHASES);
  if(!authoritative)return;
  this._diagnostics.native+=1;
  this.emit('native-turn',turn);
  if(phase==='complete')this._sendControl({type:'sample'});
 }
 _bindNativeEvents(){
  const bind=(name,handler)=>{
   if(typeof this.wc.on==='function'){this.wc.on(name,handler);this._wcListeners.push([name,handler]);}
  };
  bind('did-start-navigation',(event,...rest)=>{
   const info=navigationInfo(event,rest);
   if(info.isMainFrame===false||info.isSameDocument)return;
   this._invalidateDocument('NAVIGATION','页面开始导航'+(info.url?'：'+info.url:''));
  });
  bind('did-navigate',(event,...rest)=>{
   const info=navigationInfo(event,rest);
   this._invalidateDocument('NAVIGATED','页面已导航'+(info.url?'：'+info.url:''));
  });
  bind('did-fail-load',(event,...rest)=>{
   const info=failureInfo(event,rest);
   if(info.isMainFrame===false)return;
   this._invalidateDocument('LOAD_FAILED',`页面加载失败${info.errorCode!==undefined?'（'+info.errorCode+'）':''}`);
  });
  bind('did-navigate-in-page',()=>{if(!this._closed&&this._bindingId)this._sendControl({type:'sample'});});
  bind('did-finish-load',()=>{
   if(!this._closed&&!this._bindingId)this._fault('OBSERVER_WAITING','页面已加载，等待观察器 hello');
  });
  bind('render-process-gone',(event,details)=>{
   this._invalidateDocument('PROCESS_GONE','渲染进程退出'+(details&&details.reason?'：'+details.reason:''),true);
  });
  bind('destroyed',()=>{this._invalidateDocument('DESTROYED','WebContents 已销毁',true);});
 }
 _invalidateDocument(code,message,fatal){
  const hadBinding=!!this._bindingId;
  this._bindingId=null;
  this._documentId=null;
  this._lastSeq=0;
  this._lastNativeSeq=0;
  this._state=null;
  this._rejectPings('NOT_BOUND');
  if(hadBinding)this._fault(code,message,{fatal:!!fatal});
 }
 _rejectPings(reason){
  for(const [nonce,pending] of this._pendingPings){
   this._finishPing(pending);pending.reject(HostError(reason,'观察绑定已失效'));this._pendingPings.delete(nonce);
  }
 }
 _finishPing(pending){
  if(pending.timer!==null){try{clearTimeout(pending.timer);}catch{}pending.timer=null;}
 }
 _settleWaiters(state){
  for(const waiter of Array.from(this._waiters)){
   let match=false;
   try{match=!!waiter.predicate(state);}catch(error){this._removeWaiter(waiter);waiter.reject(error);continue;}
   if(match){this._removeWaiter(waiter);waiter.resolve(state);}
  }
 }
 _removeWaiter(waiter){
  this._waiters.delete(waiter);
  if(waiter.timer!==null){try{clearTimeout(waiter.timer);}catch{}waiter.timer=null;}
  if(waiter.abortHandler&&waiter.signal){try{waiter.signal.removeEventListener('abort',waiter.abortHandler);}catch{}}
 }
 bindTask(task){
  if(this._closed)throw HostError('OBSERVATION_CLOSED','观察器已关闭');
  if(task===null||task===undefined){
   this._taskId=null;
  }else{
   const id=isPlainObject(task)?(task.id!==undefined?task.id:task.task_id):undefined;
   if(!isTaskId(id))throw HostError('TASK_INVALID','task.id 必须是 1–80 个字母、数字、下划线或连字符');
   this._taskId=id;
  }
  this._state=null;
  if(this._bindingId){
   this._sendControl({type:'bind',bindingId:this._bindingId,generation:this._generation,task_id:this._taskId,protocol:OBSERVER_PROTOCOL});
  }
  return this;
 }
 waitFor(predicate,options={}){
  options=options||{};
  if(this._closed)return Promise.reject(HostError('OBSERVATION_CLOSED','观察器已关闭'));
  if(typeof predicate!=='function')return Promise.reject(HostError('PREDICATE_INVALID','waitFor 需要函数'));
  const signal=options.signal,deadlineMs=options.deadlineMs;
  if(deadlineMs!==undefined&&(!Number.isFinite(deadlineMs)||deadlineMs<0))return Promise.reject(HostError('DEADLINE_INVALID','deadlineMs 必须是非负有限数'));
  return new Promise((resolve,reject)=>{
   if(signal&&signal.aborted)return reject(HostError('OBSERVATION_ABORTED','等待已取消'));
   let settled=false;
   const waiter={predicate,signal,timer:null,abortHandler:null,resolve:value=>{if(settled)return;settled=true;resolve(value);},reject:error=>{if(settled)return;settled=true;reject(error);}};
   if(this._state){
    let match=false;
    try{match=!!predicate(this._state);}catch(error){return reject(error);}
    if(match){settled=true;return resolve(this._state);}
   }
   this._waiters.add(waiter);
   if(signal&&typeof signal.addEventListener==='function'){
    waiter.abortHandler=()=>{this._removeWaiter(waiter);waiter.reject(HostError('OBSERVATION_ABORTED','等待已取消'));};
    try{signal.addEventListener('abort',waiter.abortHandler,{once:true});}catch{}
   }
   if(deadlineMs!==undefined){
    const deadline=this._now()+deadlineMs;
    waiter.deadline=deadline;
    const check=()=>{
     if(settled)return;
     const remaining=deadline-this._now();
     if(remaining<=0){this._removeWaiter(waiter);waiter.reject(HostError('OBSERVATION_TIMEOUT','等待页面状态超时'));return;}
     waiter.timer=setTimeout(check,Math.min(remaining,2147483647));
    };
    waiter.timer=setTimeout(check,Math.min(Math.max(deadlineMs,0),2147483647));
   }
  });
 }
 ping(options={}){
  options=options||{};
  if(this._closed)return Promise.reject(HostError('OBSERVATION_CLOSED','观察器已关闭'));
  if(!this._bindingId)return Promise.reject(HostError('NOT_BOUND','观察器尚未绑定页面'));
  const deadlineMs=options.deadlineMs===undefined?2000:options.deadlineMs;
  if(!Number.isFinite(deadlineMs)||deadlineMs<1||deadlineMs>60000)return Promise.reject(HostError('DEADLINE_INVALID','deadlineMs 必须在 1–60000 之间'));
  let nonce;
  do{nonce=crypto.randomBytes(16).toString('hex');}while(this._pendingPings.has(nonce));
  return new Promise((resolve,reject)=>{
   const pending={resolve,reject,timer:null};
   pending.timer=setTimeout(()=>{
    if(!this._pendingPings.has(nonce))return;
    this._pendingPings.delete(nonce);this._finishPing(pending);reject(HostError('PING_TIMEOUT','观察器诊断 ping 超时'));
   },deadlineMs);
   this._pendingPings.set(nonce,pending);
   if(!this._sendControl({type:'ping',nonce})){
    this._pendingPings.delete(nonce);this._finishPing(pending);reject(HostError('CONTROL_SEND_FAILED','无法发送观察器诊断 ping'));
   }
  });
 }
 close(){
  if(this._closed)return;
  this._closed=true;
  for(const [target,channel,handler] of this._ipcListeners.splice(0)){try{target.removeListener(channel,handler);}catch{}}
  for(const [name,handler] of this._wcListeners.splice(0)){try{this.wc.removeListener(name,handler);}catch{}}
  this._rejectPings('OBSERVATION_CLOSED');
  for(const nonce of Array.from(this._pendingPings.keys()))this._pendingPings.delete(nonce);
  for(const waiter of Array.from(this._waiters)){this._removeWaiter(waiter);waiter.reject(HostError('OBSERVATION_CLOSED','观察器已关闭'));}
  this._bindingId=null;this._documentId=null;this._lastSeq=0;this._state=null;
  if(!this._readySettled){this._readySettled=true;this._readyReject(HostError('OBSERVATION_CLOSED','观察器已关闭'));}
  this.emit('close');
 }
}
function navigationInfo(event,rest){
 if(event&&typeof event==='object'&&typeof event.url==='string'){
  return {url:event.url,isMainFrame:event.isMainFrame!==false,isSameDocument:!!event.isSameDocument};
 }
 const args=Array.isArray(rest)?rest:[];
 return {
  url:typeof args[0]==='string'?args[0]:(typeof event==='string'?event:''),
  isMainFrame:args[2]===undefined?true:args[2]!==false,
  isSameDocument:args[1]===true
 };
}
function failureInfo(event,rest){
 if(event&&typeof event==='object'&&event.isMainFrame!==undefined){
  return {errorCode:event.errorCode,errorDescription:event.errorDescription,isMainFrame:event.isMainFrame!==false};
 }
 const args=Array.isArray(rest)?rest:[];
 return {errorCode:args[0],errorDescription:args[1],isMainFrame:args[3]===undefined?true:args[3]!==false};
}
module.exports={
 ObservationHost,HostError,navigationInfo,failureInfo,
 EVENT_CHANNEL,CONTROL_CHANNEL,NATIVE_CHANNEL,OBSERVER_PROTOCOL,
 MAX_PAYLOAD_BYTES,MAX_ANSWER_BYTES,MAX_NATIVE_BYTES,MAX_NATIVE_PHASES,
 isTrustedUrl,isBindingId,isTaskId
};
