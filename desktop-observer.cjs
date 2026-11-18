'use strict';
// Build-time source for the read-only renderer preload observer. The generated
// appendix is self-contained: the only require() it performs is
// require('electron'), and it never exposes contextBridge or a page global.
const page=require('./desktop-page.cjs');

const OBSERVER_VERSION='1.0.0';
const OBSERVER_PROTOCOL=1;
const EVENT_CHANNEL='gemini-work:observer-event';
const CONTROL_CHANNEL='gemini-work:observer-control';
const NATIVE_CHANNEL='gemini:notify-turn-lifecycle';
const MAX_PAYLOAD_BYTES=2*1024*1024;
const MAX_ANSWER_BYTES=1024*1024;
const COALESCE_MS=250;

// Executed in the Gemini renderer (isolated preload world). Keep this function
// free of outer references; it is serialized with Function#toString().
function observerRuntime(config,readState){
 'use strict';
 const electron=require('electron');
 const ipcRenderer=electron&&electron.ipcRenderer;
 if(!ipcRenderer||typeof ipcRenderer.send!=='function'||typeof ipcRenderer.on!=='function')return;
 if(typeof document==='undefined'||typeof location==='undefined')return;
 const DOCUMENT_ID=newDocumentId();
 let binding=null;
 let taskId=null;
 let seq=0;
 let lastSentKey=null;
 let lastSentUrgent=null;
 let pendingState=null;
 let timer=null;
 let disposed=false;
 let nativeSeq=0;
 let nativeStart=null;
 let hookInstalled=false;
 let hookOriginal=null;
 let hookWrapper=null;
 let observer=null;let observerError=null;
 const DIAGNOSTIC_TIMER_MS=250;
 let diagnosticSeq=0;
 let activeProbe=null;
 let rendererDiagnostic={supported:false,requested_at:null,completed_at:null,timer_fired_at:null,generation:null,seq:0};

 function nowStamp(){
  try{return new Date().toISOString();}catch{return null;}
 }
 function frameHost(){
  return typeof window!=='undefined'&&window?window:null;
 }
 function frameRequest(callback){
  try{if(typeof requestAnimationFrame==='function')return requestAnimationFrame(callback);}catch{return null;}
  try{
   const host=frameHost();
   if(host&&typeof host.requestAnimationFrame==='function')return host.requestAnimationFrame(callback);
  }catch{}
  return null;
 }
 function frameCancel(id){
  if(id===null||id===undefined)return;
  try{if(typeof cancelAnimationFrame==='function'){cancelAnimationFrame(id);return;}}catch{}
  try{
   const host=frameHost();
   if(host&&typeof host.cancelAnimationFrame==='function')host.cancelAnimationFrame(id);
  }catch{}
 }
 function frameSupported(){
  try{if(typeof requestAnimationFrame==='function')return true;}catch{}
  try{
   const host=frameHost();
   return !!(host&&typeof host.requestAnimationFrame==='function');
  }catch{return false;}
 }
 function diagnosticView(){
  return {
   supported:rendererDiagnostic.supported,
   requested_at:rendererDiagnostic.requested_at,
   completed_at:rendererDiagnostic.completed_at,
   timer_fired_at:rendererDiagnostic.timer_fired_at,
   generation:rendererDiagnostic.generation,
   seq:rendererDiagnostic.seq
  };
 }
 function cancelProbe(){
  const probe=activeProbe;
  activeProbe=null;
  if(!probe)return;
  probe.cancelled=true;
  frameCancel(probe.raf);
  probe.raf=null;
  if(probe.timer!==null){try{clearTimeout(probe.timer);}catch{}probe.timer=null;}
 }
 function probeEvent(probe,kind){
  if(disposed||!probe||probe!==activeProbe||probe.cancelled)return;
  if(kind==='raf'){
   probe.raf=null;
   rendererDiagnostic.completed_at=nowStamp();
  }else{
   probe.timer=null;
   rendererDiagnostic.timer_fired_at=nowStamp();
  }
  evaluate();
 }
 // Event-triggered, one-shot liveness probe. It never reschedules itself and
 // every callback is invalidated by the next bind/sample so superseded
 // bindings cannot overwrite the current diagnostic.
 function startProbe(){
  cancelProbe();
  if(disposed||!binding)return;
  const probe={cancelled:false,raf:null,timer:null};
  activeProbe=probe;
  diagnosticSeq+=1;
  rendererDiagnostic={
   supported:frameSupported(),
   requested_at:null,
   completed_at:null,
   timer_fired_at:null,
   generation:binding.generation,
   seq:diagnosticSeq
  };
  probe.timer=setTimeout(()=>probeEvent(probe,'timer'),DIAGNOSTIC_TIMER_MS);
  if(!rendererDiagnostic.supported)return;
  rendererDiagnostic.requested_at=nowStamp();
  probe.raf=frameRequest(()=>probeEvent(probe,'raf'));
  if(probe.raf===null)rendererDiagnostic.requested_at=null;
 }

 function newDocumentId(){
  try{
   const source=typeof globalThis!=='undefined'&&globalThis.crypto?globalThis.crypto:null;
   if(source&&typeof source.randomUUID==='function')return String(source.randomUUID());
  }catch{}
  let out='';
  for(let i=0;i<32;i++)out+='0123456789abcdef'.charAt(Math.floor(Math.random()*16));
  return out;
 }
 function utf8Length(value){
  const text=String(value);
  try{if(typeof TextEncoder==='function')return new TextEncoder().encode(text).length;}catch{}
  let bytes=0;
  for(const ch of text){const code=ch.codePointAt(0);bytes+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;}
  return bytes;
 }
 function truncateUtf8(value,maxBytes){
  const text=String(value);
  if(utf8Length(text)<=maxBytes)return text;
  let low=0,high=text.length;
  while(low<high){
   const mid=Math.ceil((low+high)/2);
   if(utf8Length(text.slice(0,mid))<=maxBytes)low=mid;else high=mid-1;
  }
  let out=text.slice(0,low);
  const last=out.charCodeAt(out.length-1);
  if(last>=0xd800&&last<=0xdbff)out=out.slice(0,-1);
  return out;
 }
 function jsonBytes(value){
  try{return utf8Length(JSON.stringify(value));}catch{return Infinity;}
 }
 function insideLimit(state){
  const maxPayload=config.maxPayloadBytes;
  const maxAnswer=config.maxAnswerBytes;
  if(!state||typeof state!=='object'||Array.isArray(state))return null;
  if(Array.isArray(state.responses)){
   state.responses=state.responses.map(response=>{
    if(!response||typeof response!=='object'||Array.isArray(response))return response;
    if(typeof response.answer!=='string'||utf8Length(response.answer)<=maxAnswer)return response;
    return Object.assign({},response,{answer:truncateUtf8(response.answer,maxAnswer),answer_truncated:true});
   });
  }
  if(jsonBytes(state)<=maxPayload)return state;
  if(Array.isArray(state.responses)){
   for(let i=0;i<state.responses.length;i++){
    const response=state.responses[i];
    if(!response||typeof response.answer!=='string'||!response.answer)continue;
    state.responses[i]=Object.assign({},response,{answer:'',answer_truncated:true});
    if(jsonBytes(state)<=maxPayload)return state;
   }
  }
  for(const key of ['controls','models','uploads','queries','bodyText','draftMetrics']){
   if(jsonBytes(state)<=maxPayload)return state;
   if(Array.isArray(state[key]))state[key]=[];
   else if(typeof state[key]==='string')state[key]='';
   else if(state[key]&&typeof state[key]==='object')state[key]=null;
  }
  for(const key of ['draft','draftTextContent','title']){
   if(jsonBytes(state)<=maxPayload)return state;
   if(typeof state[key]==='string')state[key]=truncateUtf8(state[key],4096);
  }
  if(jsonBytes(state)<=maxPayload)return state;
  return {
   protocol:String(state.protocol||''),origin:String(state.origin||''),url:String(state.url||''),title:'',
   width:Number(state.width)||0,height:Number(state.height)||0,online:state.online!==false,visibility:'',
   clientShell:state.clientShell!==false,draft:'',hasInput:!!state.hasInput,draftTextContent:'',draftMetrics:null,
   dialog:!!state.dialog,backdrop:!!state.backdrop,generates:!!state.generates,uploads:[],controls:[],models:[],
   hasModeMenu:!!state.hasModeMenu,sendButtons:[],queries:[],responses:[],bodyText:'',truncated:true,
   renderer_diagnostic:diagnosticView()
  };
 }
 function read(){
  try{
   const state=readState();
   if(state&&typeof state==='object'&&!Array.isArray(state))state.renderer_diagnostic=diagnosticView();
   return insideLimit(state);
  }catch(error){if(binding)post({type:'fault',bindingId:binding.bindingId,generation:binding.generation,seq:++seq,task_id:taskId,code:'OBSERVER_READ_FAILED',message:String(error.message||error).slice(0,500)});return null;}
 }
 function stateKey(state){
  try{return JSON.stringify(state);}catch{return null;}
 }
 function urgentKey(state){
  const last=(state.responses||[]).at(-1);
  const stop=(state.controls||[]).some(control=>/停止|stop response|stop generating/i.test(`${control.label||''} ${control.text||''}`));
  return JSON.stringify({
   url:state.url,online:state.online,clientShell:state.clientShell,hasInput:state.hasInput,
   dialog:state.dialog,backdrop:state.backdrop,generates:state.generates,hasModeMenu:state.hasModeMenu,
   uploads:state.uploads,sendButtons:state.sendButtons,draft:state.draft,queries:state.queries,
   complete:!!last?.complete,completedAnswer:last?.complete?last.answer:null,stop
  });
 }
function post(message){
 try{ipcRenderer.send(config.eventChannel,message);return true;}catch{return false;}
}
// The untouched app sends its lifecycle notification straight through
// ipcRenderer.send. The hook captures the observer binding at call time for
// start, and a complete may only reuse that still-current start context. It
// always calls the original with the same arguments/this and returns or throws
// exactly what the original did; capture/forward failures are contained.
function sameConversation(a,b){
 if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;
 return a===b||a==='c_'+b||b==='c_'+a;
}
function prepareNative(payload){
 if(disposed||!binding)return null;
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
 const phase=typeof payload.phase==='string'?payload.phase.trim():'';
 if(!phase||phase.length>64)return null;
 return {
  documentId:DOCUMENT_ID,bindingId:binding.bindingId,generation:binding.generation,
  task_id:taskId,phase,
  conversationId:typeof payload.conversationId==='string'?payload.conversationId.slice(0,200):''
 };
}
function postNative(event){
 if(disposed)return;
 try{ipcRenderer.send(config.eventChannel,Object.assign({type:'native',seq:++nativeSeq},event));}catch{}
}
function commitNative(event){
 if(disposed||!event)return;
 if(event.phase==='start'){
  // A duplicate start stays visible so the machine can mark the pair
  // ambiguous instead of pairing a complete with the older start.
  nativeStart={
   documentId:event.documentId,bindingId:event.bindingId,generation:event.generation,
   task_id:event.task_id,conversationId:event.conversationId
  };
  postNative(event);
  return;
 }
 if(event.phase==='complete'){
  const start=nativeStart;
  nativeStart=null;
  if(!start)return;
  if(!binding||binding.bindingId!==start.bindingId||binding.generation!==start.generation)return;
  if(taskId!==start.task_id||DOCUMENT_ID!==start.documentId)return;
  if(!sameConversation(start.conversationId,event.conversationId))return;
  postNative({
   documentId:start.documentId,bindingId:start.bindingId,generation:start.generation,
   task_id:start.task_id,phase:'complete',conversationId:event.conversationId
  });
  return;
 }
 // Unknown phases carry only the producing context for diagnostics.
 postNative(event);
}
function installNativeHook(){
 if(hookInstalled)return true;
 try{
  const target=ipcRenderer;
  const original=target.send;
  if(typeof original!=='function')return false;
  if(original.__geminiObserverHook===true)return false;
  const wrapper=function(channel){
   const args=Array.prototype.slice.call(arguments);
   let prepared=null;
   try{
    if(channel===config.nativeChannel&&args.length>1)prepared=prepareNative(args[1]);
   }catch{}
   let result;
   try{result=original.apply(this,args);}
   catch(error){throw error;}
   if(prepared){try{commitNative(prepared);}catch{}}
   return result;
  };
  wrapper.__geminiObserverHook=true;
  target.send=wrapper;
  if(target.send!==wrapper)return false;
  hookOriginal=original;hookWrapper=wrapper;hookInstalled=true;
  return true;
 }catch{return false;}
}
function restoreNativeHook(){
 if(!hookInstalled)return;
 const wrapper=hookWrapper,original=hookOriginal;
 hookInstalled=false;hookWrapper=null;hookOriginal=null;
 try{if(ipcRenderer.send===wrapper)ipcRenderer.send=original;}catch{}
}
function disposeObserver(){
 if(disposed)return;
 disposed=true;
 nativeStart=null;
 cancelTimer();
 cancelProbe();
 restoreNativeHook();
 try{if(observer&&typeof observer.disconnect==='function')observer.disconnect();}catch{}
 try{if(typeof ipcRenderer.removeListener==='function')ipcRenderer.removeListener(config.controlChannel,handleControl);}catch{}
}
 function cancelTimer(){
  if(timer!==null){try{clearTimeout(timer);}catch{}timer=null;}
 }
 function sendState(state){
  if(!binding||disposed)return;
  seq+=1;
  post({type:'state',bindingId:binding.bindingId,generation:binding.generation,seq,task_id:taskId,state});
  lastSentKey=stateKey(state);
  lastSentUrgent=urgentKey(state);
 }
 function sendPending(){
  timer=null;
  if(disposed||!binding||!pendingState)return;
  const state=pendingState;
  pendingState=null;
  if(stateKey(state)===lastSentKey)return;
  sendState(state);
 }
 function schedule(){
  if(timer!==null)return;
  timer=setTimeout(sendPending,config.coalesceMs);
 }
 function evaluate(){
  if(disposed||!binding)return;
  const state=read();
  if(!state)return;
  const key=stateKey(state);
  if(key===null)return;
  if(key===lastSentKey){
   pendingState=null;
   cancelTimer();
   return;
  }
  pendingState=state;
  if(urgentKey(state)!==lastSentUrgent){
   cancelTimer();
   sendPending();
  }else schedule();
 }
function hello(){
 post({type:'hello',documentId:DOCUMENT_ID,url:String(location.href||''),protocol:config.protocol,diagnostics:{mutationObserver:typeof MutationObserver,attached:!!observer,error:observerError,nativeHook:hookInstalled}});
}
 function handleControl(event,message){
  if(!message||typeof message!=='object'||Array.isArray(message))return;
  if(message.protocol!==undefined&&message.protocol!==config.protocol)return;
  if(message.type==='bind'){
   const bindingId=message.bindingId,generation=message.generation;
   if(typeof bindingId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(bindingId))return;
   if(!Number.isInteger(generation)||generation<1||generation>Number.MAX_SAFE_INTEGER)return;
   if(message.task_id!==null&&message.task_id!==undefined&&!(typeof message.task_id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(message.task_id)))return;
   // Any rebinding or task change invalidates the start context; a later
   // complete must not inherit the old document/binding/generation/task.
   nativeStart=null;
   binding={bindingId,generation};
   taskId=message.task_id===undefined?taskId:message.task_id;
   pendingState=null;
   cancelTimer();
   lastSentKey=null;
   lastSentUrgent=null;
   startProbe();
   const state=read();
   if(state)sendState(state);
   return;
  }
  if(message.type==='sample'){startProbe();evaluate();return;}
  if(message.type==='ping'){
   const nonce=message.nonce;
   if(typeof nonce!=='string'||nonce.length<1||nonce.length>128)return;
   // Idle diagnostics need current DOM evidence, not just a responsive IPC.
   // Report once before acknowledging; normal progress remains event driven.
   const state=read();
   if(state&&binding){pendingState=null;cancelTimer();sendState(state);}
   post({
    type:'pong',nonce,documentId:DOCUMENT_ID,
    bindingId:binding?binding.bindingId:null,generation:binding?binding.generation:null
   });
  }
 }
 function startObserver(){
  if(disposed||typeof MutationObserver!=='function')return;
  observer=new MutationObserver(evaluate);
  try{observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true});}catch(error){observerError=String(error.message||error).slice(0,500);}
 }
 function onPageShow(event){
  if(event&&event.persisted)hello();
 }
if(typeof ipcRenderer.on==='function')ipcRenderer.on(config.controlChannel,handleControl);
installNativeHook();
if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){
  window.addEventListener('online',evaluate);
  window.addEventListener('offline',evaluate);
  window.addEventListener('popstate',evaluate);
  window.addEventListener('hashchange',evaluate);
  window.addEventListener('pageshow',onPageShow);
 }
 if(typeof document!=='undefined'&&typeof document.addEventListener==='function')document.addEventListener('visibilitychange',evaluate);
startObserver();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hello,{once:true});
else hello();
return {dispose:disposeObserver};
}

function buildPreloadAppendix(options={}){
 const config={
  protocol:OBSERVER_PROTOCOL,
  version:OBSERVER_VERSION,
  eventChannel:EVENT_CHANNEL,
  controlChannel:CONTROL_CHANNEL,
  nativeChannel:NATIVE_CHANNEL,
  maxPayloadBytes:Number.isInteger(options.maxPayloadBytes)?options.maxPayloadBytes:MAX_PAYLOAD_BYTES,
  maxAnswerBytes:Number.isInteger(options.maxAnswerBytes)?options.maxAnswerBytes:MAX_ANSWER_BYTES,
  coalesceMs:Number.isInteger(options.coalesceMs)?options.coalesceMs:COALESCE_MS
 };
 if(config.maxPayloadBytes<1024||config.maxAnswerBytes<1024||config.coalesceMs<1)throw new Error('INVALID_OBSERVER_LIMITS');
 return `\n;(${observerRuntime.toString()})(${JSON.stringify(config)},${page.pageStateSource()});\n`;
}

module.exports={
 OBSERVER_VERSION,OBSERVER_PROTOCOL,EVENT_CHANNEL,CONTROL_CHANNEL,NATIVE_CHANNEL,
 MAX_PAYLOAD_BYTES,MAX_ANSWER_BYTES,COALESCE_MS,buildPreloadAppendix,observerRuntime
};
