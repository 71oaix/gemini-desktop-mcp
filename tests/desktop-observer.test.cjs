'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const observer=require('../desktop-observer.cjs');
const page=require('../desktop-page.cjs');

function visible(){return {width:10,height:10};}
function element(text,extra={}){
 return {
  innerText:text,textContent:text,className:'',disabled:false,
  attributes:[],childNodes:[],children:[],
  getBoundingClientRect:visible,
  getAttribute(name){return Object.prototype.hasOwnProperty.call(extra,name)?extra[name]:null;},
  querySelector(){return null;},querySelectorAll(){return [];}
 };
}
function harness(options={}){
 const messages=[];
 const controlHandlers=new Map();
 const observers=[];
 const timers=new Map();
 const rafQueue=[];
 let timerId=0,clock=0,rafId=0;
 const fake={
  responses:[],queries:[],uploads:[],progress:false,dialog:false,backdrop:false,input:false,modeMenu:true,
  online:true,href:'https://gemini.google.com/app',bodyText:'body'
 };
 function querySelector(selector){
  if(selector==='[contenteditable="true"][role="textbox"]')return fake.input?element(''):null;
  if(selector==='[role="dialog"]')return fake.dialog?element('dialog'):null;
  if(selector==='.cdk-overlay-backdrop-showing')return fake.backdrop?element('backdrop'):null;
  if(selector==='[data-test-id="bard-mode-menu-button"]')return fake.modeMenu?element('mode'):null;
  return null;
 }
 function querySelectorAll(selector){
  if(selector==='model-response')return fake.responses.map(response=>({
   attributes:[],
   querySelector(inner){
    if(inner==='message-content')return element(response.answer||'');
    if(/copy-button/.test(inner))return response.complete?element('copy'):null;
    return null;
   },
   querySelectorAll(){return [];}
  }));
  if(selector==='[role="progressbar"]')return fake.progress?[element('progress')]:[];
  if(selector==='user-query')return fake.queries.map(text=>element(text));
  if(selector==='uploader-file-preview')return fake.uploads.map(text=>element(text));
  if(selector==='button')return [];
  if(selector==='button,[role="button"],a')return [];
  if(selector==='[data-test-id^="bard-mode-option-"]')return [element('3.8 Flash',{'data-test-id':'mode-flash'})];
  return [];
 }
 const document={
  readyState:'complete',title:'Gemini',visibilityState:'visible',body:{innerText:fake.bodyText},
  documentElement:{},
  querySelector,querySelectorAll,
  addEventListener(){},removeEventListener(){}
 };
 const window={addEventListener(){},removeEventListener(){}};
 const ipcRenderer={
  send(channel,message){
   if(options.sendError===channel)throw new Error('synthetic send failure');
   messages.push({channel,message:JSON.parse(JSON.stringify(message)),self:this});
   return 'sent';
  },
  on(channel,handler){controlHandlers.set(channel,handler);},
  removeListener(channel,handler){if(controlHandlers.get(channel)===handler)controlHandlers.delete(channel);}
 };
 if(options.frozenSend)Object.defineProperty(ipcRenderer,'send',{value:ipcRenderer.send,writable:false,configurable:false});
 const electron={ipcRenderer};
 const sandbox={
  console,TextEncoder,Date,
  document,window,navigator:{onLine:true},location:{
   get protocol(){return 'https:';},get origin(){return 'https://gemini.google.com';},
   get href(){return fake.href;},get hostname(){return 'gemini.google.com';}
  },
  get innerWidth(){return 1200;},get innerHeight(){return 800;},
  crypto:{randomUUID:()=>'11111111-2222-3333-4444-555555555555'},
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,due:clock+ms});return id;},
  clearTimeout(id){timers.delete(id);},
  MutationObserver:class{
   constructor(callback){this.callback=callback;observers.push(this);}
   observe(target,options){this.target=target;this.options=options;}
   disconnect(){this.disconnected=true;}
  },
  require(name){if(name!=='electron')throw new Error('unexpected require '+name);return electron;}
 };
 if(options.raf!==false){
  sandbox.requestAnimationFrame=callback=>{const id=++rafId;rafQueue.push({id,callback});return id;};
  sandbox.cancelAnimationFrame=id=>{const index=rafQueue.findIndex(entry=>entry.id===id);if(index>=0)rafQueue.splice(index,1);};
 }
 const runtime=vm.runInNewContext(observer.buildPreloadAppendix(),sandbox,{filename:'preload-observer.js'});
 function control(message){controlHandlers.get(observer.CONTROL_CHANNEL)({},message);}
 function mutate(){for(const item of observers)item.callback([],item);}
 function advance(ms){
  const target=clock+ms;
  for(;;){
   let next=null;
   for(const [id,timer] of timers){if(timer.due<=target&&(!next||timer.due<next.timer.due||(timer.due===next.timer.due&&id<next.id)))next={id,timer};}
   if(!next)break;
   timers.delete(next.id);clock=next.timer.due;next.timer.fn();
  }
  clock=target;
 }
 function pendingRaf(){return rafQueue.slice();}
 function flushRaf(){
  const queued=rafQueue.splice(0);
  for(const entry of queued)entry.callback();
 }
 return {fake,messages,control,mutate,advance,sandbox,window,pendingRaf,flushRaf,electron,ipcRenderer,runtime};
}
function states(messages){return messages.filter(item=>item.message.type==='state');}
function nativeEnvelopes(messages){
 return messages.filter(item=>item.channel===observer.EVENT_CHANNEL&&item.message.type==='native').map(item=>item.message);
}
function diagnostic(messages){return states(messages).at(-1).message.state.renderer_diagnostic;}

test('the fixed observe script and the preload observer share one DOM extractor',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 const direct=vm.runInNewContext(page.OBSERVE.replace('/*gemini-page:observe*/',''),h.sandbox);
 const observed={...states(h.messages).at(-1).message.state};
 assert.ok(observed.renderer_diagnostic,'the observer adds only the bounded diagnostic to page state');
 delete observed.renderer_diagnostic;
 assert.deepEqual(observed,JSON.parse(JSON.stringify(direct)));
});

test('preload observer waits for hello/bind, then sends one baseline state',()=>{
 const h=harness();
 assert.equal(h.messages.length,1);
 assert.equal(h.messages[0].channel,observer.EVENT_CHANNEL);
 assert.equal(h.messages[0].message.type,'hello');
 assert.equal(h.messages[0].message.documentId,'11111111-2222-3333-4444-555555555555');
 assert.equal(h.messages[0].message.url,'https://gemini.google.com/app');
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 const sent=states(h.messages);
 assert.equal(sent.length,1);
 assert.deepEqual(Object.keys(sent[0].message).sort(),['bindingId','generation','seq','state','task_id','type'].sort());
 assert.equal(sent[0].message.bindingId,'binding-1234');
 assert.equal(sent[0].message.generation,1);
 assert.equal(sent[0].message.seq,1);
 assert.equal(sent[0].message.task_id,null);
 assert.equal(sent[0].message.state.url,'https://gemini.google.com/app');
 h.mutate();
 assert.equal(states(h.messages).length,1,'an unchanged mutation must not resend the baseline');
});

test('answer text coalesces within 250ms while urgent signals are immediate',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 const baseline=states(h.messages).length;
 h.fake.responses=[{answer:'a',complete:false}];
 h.mutate();
 assert.equal(states(h.messages).length,baseline,'answer delta must be deferred');
 h.advance(249);
 assert.equal(states(h.messages).length,baseline);
 h.advance(1);
 assert.equal(states(h.messages).length,baseline+1);
 assert.equal(states(h.messages).at(-1).message.state.responses[0].answer,'a');
 h.fake.responses=[{answer:'ab',complete:false}];
 h.mutate();
 h.advance(100);
 h.fake.responses=[{answer:'abc',complete:false}];
 h.mutate();
 h.advance(150);
 assert.equal(states(h.messages).length,baseline+2,'mutations in one window coalesce');
 assert.equal(states(h.messages).at(-1).message.state.responses[0].answer,'abc');
 h.fake.progress=true;
 h.mutate();
 assert.equal(states(h.messages).length,baseline+3,'generating change is urgent');
 assert.equal(states(h.messages).at(-1).message.state.generates,true);
 h.fake.responses=[{answer:'abc',complete:true}];
 h.mutate();
 assert.equal(states(h.messages).length,baseline+4,'completion signal is urgent');
 h.fake.responses=[{answer:'rewritten while candidate active',complete:true}];h.mutate();
 assert.equal(states(h.messages).length,baseline+5,'text rewrites must immediately invalidate a completion candidate');
});

test('diagnostic ping answers with the current document and binding only',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:2,task_id:null,protocol:1});
 h.control({type:'ping',nonce:'nonce-1'});
 const pong=h.messages.at(-1).message;
 assert.equal(pong.type,'pong');
 assert.equal(pong.nonce,'nonce-1');
 assert.equal(pong.documentId,'11111111-2222-3333-4444-555555555555');
 assert.equal(pong.bindingId,'binding-1234');
 assert.equal(pong.generation,2);
 const before=h.messages.length;
 h.control({type:'bind',bindingId:'bad id',generation:1});
 h.control({type:'bind',bindingId:'binding-9999',generation:0});
 h.control({type:'ping',nonce:42});
 h.control({type:'unknown'});
 h.control(null);
 assert.equal(h.messages.length,before,'invalid controls are ignored');
});

test('state payloads are bounded and answer text is truncated to 1 MiB',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 const before=states(h.messages).length;
 h.fake.responses=[{answer:'x'.repeat(1024*1024+512),complete:false}];
 h.mutate();
 h.advance(250);
 const message=states(h.messages).at(-1).message;
 const answer=message.state.responses[0].answer;
 assert.ok(Buffer.byteLength(answer,'utf8')<=observer.MAX_ANSWER_BYTES);
 assert.equal(message.state.responses[0].answer_truncated,true);
 assert.ok(Buffer.byteLength(JSON.stringify(message),'utf8')<=observer.MAX_PAYLOAD_BYTES);
 assert.equal(states(h.messages).length,before+1);
});

test('task changes rebind metadata and the observer exposes no page API',()=>{
 const h=harness();
 const beforeKeys=Object.keys(h.window).sort();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 const first=states(h.messages).at(-1).message;
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:'task_1',protocol:1});
 const next=states(h.messages).at(-1).message;
 assert.equal(next.task_id,'task_1');
 assert.ok(next.seq>first.seq);
 assert.equal(next.bindingId,first.bindingId);
 assert.deepEqual(Object.keys(h.window).sort(),beforeKeys,'no contextBridge/window surface is created');
});
test('same-document navigation sampling reports the new URL without periodic reads',()=>{
 const h=harness();h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 h.fake.href='https://gemini.google.com/app/route-test';h.control({type:'sample'});
 assert.equal(states(h.messages).at(-1).message.state.url,h.fake.href);
});
test('DOM extraction errors are actively reported with the current binding',()=>{
 const h=harness();h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 h.sandbox.document.querySelector=()=>{throw Error('synthetic DOM read failure');};h.mutate();
 const fault=h.messages.at(-1).message;assert.equal(fault.type,'fault');assert.equal(fault.bindingId,'binding-1234');assert.equal(fault.code,'OBSERVER_READ_FAILED');
});
test('bind starts one bounded rAF probe and a completed frame is pushed once',()=>{
 const h=harness();h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 const baseline=states(h.messages).length;
 const first=diagnostic(h.messages);
 assert.deepEqual(Object.keys(first).sort(),['completed_at','generation','requested_at','seq','supported','timer_fired_at'].sort());
 assert.equal(first.supported,true);
 assert.equal(typeof first.requested_at,'string');
 assert.equal(first.completed_at,null);
 assert.equal(first.timer_fired_at,null);
 assert.equal(first.generation,1);
 assert.equal(first.seq,1);
 h.flushRaf();
 assert.equal(states(h.messages).length,baseline,'a completed frame is not urgent business progress');
 h.advance(250);
 assert.equal(states(h.messages).length,baseline+1);
 const done=diagnostic(h.messages);
 assert.equal(typeof done.completed_at,'string');
 assert.equal(typeof done.timer_fired_at,'string');
 assert.equal(done.seq,first.seq);
 h.advance(5000);
 assert.equal(states(h.messages).length,baseline+1,'the probe must not reschedule itself or loop');
});
test('a timer still reports liveness when rAF never fires',()=>{
 const h=harness();h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 const baseline=states(h.messages).length;
 h.advance(250);
 h.advance(250);
 assert.equal(states(h.messages).length,baseline+1);
 const diag=diagnostic(h.messages);
 assert.equal(diag.supported,true);
 assert.equal(typeof diag.requested_at,'string');
 assert.equal(diag.completed_at,null,'no frame callback may be fabricated');
 assert.equal(typeof diag.timer_fired_at,'string');
 h.advance(5000);
 assert.equal(states(h.messages).length,baseline+1,'a stalled frame callback must not produce recurring reads');
});
test('a superseded binding probe is cancelled and its late callback is ignored',()=>{
 const h=harness();h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 const stale=h.pendingRaf();
 assert.equal(stale.length,1);
 h.control({type:'bind',bindingId:'binding-5678',generation:2,task_id:null,protocol:1});
 const afterRebind=states(h.messages).length;
 stale[0].callback();
 assert.equal(states(h.messages).length,afterRebind,'a late callback from the old binding must be ignored');
 assert.equal(diagnostic(h.messages).generation,2);
 assert.equal(diagnostic(h.messages).completed_at,null);
 h.flushRaf();
 h.advance(250);
 const diag=diagnostic(h.messages);
 assert.equal(diag.generation,2);
 assert.equal(diag.seq,2);
 assert.equal(typeof diag.completed_at,'string');
});
test('sample starts one new probe while evaluate alone never probes',()=>{
 const h=harness();h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1});
 h.flushRaf();h.advance(500);
 const baseline=states(h.messages).length,seq=diagnostic(h.messages).seq;
 h.control({type:'sample'});
 h.advance(250);
 assert.equal(states(h.messages).length,baseline+1);
 assert.equal(diagnostic(h.messages).seq,seq+1);
 h.mutate();h.advance(500);
 assert.equal(diagnostic(h.messages).seq,seq+1,'evaluate must not start another probe');
 assert.equal(states(h.messages).length,baseline+1);
});
test('a renderer without rAF reports supported=false but still records the diagnostic timer',()=>{
 const h=harness({raf:false});
 assert.doesNotThrow(()=>h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:null,protocol:1}));
 const baseline=states(h.messages).length;
 const first=diagnostic(h.messages);
 assert.equal(first.supported,false);
 assert.equal(first.requested_at,null);
 assert.equal(first.completed_at,null);
 h.advance(250);h.advance(250);
 assert.equal(states(h.messages).length,baseline+1);
 assert.equal(typeof diagnostic(h.messages).timer_fired_at,'string');
});
test('connectionDiagnostic passes only the bounded renderer diagnostic fields',()=>{
 const state={url:'https://gemini.google.com/app',clientShell:false,responses:[],controls:[],uploads:[],width:1200,height:800};
 assert.equal(page.connectionDiagnostic(state).renderer_diagnostic,null);
 state.renderer_diagnostic={supported:true,requested_at:'2026-11-10T00:00:00.000Z',completed_at:null,timer_fired_at:'2026-11-10T00:00:00.250Z',generation:3,seq:7,extra:'ignored'};
 const passed=page.connectionDiagnostic(state).renderer_diagnostic;
 assert.deepEqual(passed,{supported:true,requested_at:'2026-11-10T00:00:00.000Z',completed_at:null,timer_fired_at:'2026-11-10T00:00:00.250Z',generation:3,seq:7});
 state.renderer_diagnostic={supported:'yes',requested_at:'not-a-date',completed_at:42,timer_fired_at:'x'.repeat(100),generation:-1,seq:1.5};
 assert.deepEqual(page.connectionDiagnostic(state).renderer_diagnostic,{supported:false,requested_at:null,completed_at:null,timer_fired_at:null,generation:null,seq:null});
});
test('the installed native hook forwards start/complete with the source binding context and preserves passthrough',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:'task_1',protocol:1});
 const baseline=nativeEnvelopes(h.messages).length;
 const result=h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'start',clientTools:false});
 assert.equal(result,'sent','the original return value is preserved');
 const raw=h.messages.find(item=>item.channel===observer.NATIVE_CHANNEL&&item.message.phase==='start');
 assert.ok(raw,'the original channel is still delivered');
 assert.equal(raw.self,h.ipcRenderer,'the original this binding is preserved');
 const start=nativeEnvelopes(h.messages).at(-1);
 assert.equal(nativeEnvelopes(h.messages).length,baseline+1);
 assert.equal(start.documentId,'11111111-2222-3333-4444-555555555555');
 assert.equal(start.bindingId,'binding-1234');
 assert.equal(start.generation,1);
 assert.equal(start.task_id,'task_1');
 assert.equal(start.seq,1);
 assert.equal(start.phase,'start');
 assert.equal(start.conversationId,'c_conv');
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'complete',clientTools:true});
 const complete=nativeEnvelopes(h.messages).at(-1);
 assert.equal(complete.phase,'complete');
 assert.equal(complete.seq,2);
 assert.equal(complete.bindingId,'binding-1234');
 assert.equal(complete.task_id,'task_1');
 const other=h.ipcRenderer.send('example:other-ipc',{value:1});
 assert.equal(other,'sent');
 const passed=h.messages.at(-1);
 assert.equal(passed.channel,'example:other-ipc');
 assert.deepEqual(passed.message,{value:1});
 assert.equal(nativeEnvelopes(h.messages).length,baseline+2,'unrelated IPC must not create native envelopes');
});
test('a native start context is cleared on task or binding changes and cannot finish under the new context',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:'task_1',protocol:1});
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'start'});
 assert.equal(nativeEnvelopes(h.messages).length,1);
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:'task_2',protocol:1});
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'complete'});
 assert.equal(nativeEnvelopes(h.messages).length,1,'a complete after a task change must not inherit the old start');
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'start'});
 h.control({type:'bind',bindingId:'binding-5678',generation:2,task_id:'task_2',protocol:1});
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'complete'});
 assert.equal(nativeEnvelopes(h.messages).length,2,'a complete after a binding change is dropped');
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'start'});
 const restarted=nativeEnvelopes(h.messages).at(-1);
 assert.equal(restarted.task_id,'task_2');
 assert.equal(restarted.bindingId,'binding-5678');
 assert.equal(restarted.generation,2);
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'complete'});
 const completed=nativeEnvelopes(h.messages).at(-1);
 assert.equal(completed.phase,'complete');
 assert.equal(completed.task_id,'task_2');
 assert.equal(completed.bindingId,'binding-5678');
 assert.equal(completed.generation,2);
});
test('a duplicate start is forwarded and a complete must match the start conversation',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:'task_1',protocol:1});
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_one',phase:'start'});
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_one',phase:'start'});
 assert.deepEqual(nativeEnvelopes(h.messages).map(item=>item.phase),['start','start'],'duplicate starts stay visible so the machine can detect ambiguity');
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_other',phase:'complete'});
 assert.equal(nativeEnvelopes(h.messages).length,2,'a complete from another conversation cannot pair');
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_two',phase:'start'});
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_two',phase:'complete'});
 assert.deepEqual(nativeEnvelopes(h.messages).map(item=>item.phase),['start','start','start','complete']);
});
test('a hook installation failure is reported and never blocks the original send',()=>{
 const h=harness({frozenSend:true});
 assert.equal(h.messages[0].message.type,'hello','the observer still starts without the hook');
 assert.equal(h.messages[0].message.diagnostics.nativeHook,false);
 const result=h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'start'});
 assert.equal(result,'sent');
 assert.equal(h.messages.at(-1).channel,observer.NATIVE_CHANNEL,'the original notification is untouched');
 assert.equal(nativeEnvelopes(h.messages).length,0);
});
test('a failing capture never blocks the original send and original exceptions propagate unchanged',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:'task_1',protocol:1});
 const payload={conversationId:'c_conv'};
 Object.defineProperty(payload,'phase',{enumerable:false,get(){throw new Error('synthetic capture failure');}});
 const result=h.ipcRenderer.send(observer.NATIVE_CHANNEL,payload);
 assert.equal(result,'sent','a capture failure must not change the original result');
 assert.equal(h.messages.at(-1).channel,observer.NATIVE_CHANNEL);
 assert.equal(nativeEnvelopes(h.messages).length,0);
 const failing=harness({sendError:observer.NATIVE_CHANNEL});
 failing.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:'task_1',protocol:1});
 assert.throws(()=>failing.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'start'}),/synthetic send failure/);
 assert.equal(nativeEnvelopes(failing.messages).length,0,'a failed original send must not fabricate native evidence');
});
test('dispose stops collection, restores passthrough and drops pending native context',()=>{
 const h=harness();
 h.control({type:'bind',bindingId:'binding-1234',generation:1,task_id:'task_1',protocol:1});
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'start'});
 assert.equal(nativeEnvelopes(h.messages).length,1);
 assert.equal(h.ipcRenderer.send.__geminiObserverHook,true);
 assert.equal(typeof h.runtime.dispose,'function');
 h.runtime.dispose();
 assert.equal(h.ipcRenderer.send.__geminiObserverHook,undefined,'dispose restores the original send');
 const events=states(h.messages).length;
 h.ipcRenderer.send(observer.NATIVE_CHANNEL,{conversationId:'c_conv',phase:'complete'});
 assert.equal(nativeEnvelopes(h.messages).length,1,'no envelope is collected after dispose');
 assert.equal(h.messages.at(-1).channel,observer.NATIVE_CHANNEL,'passthrough remains available after dispose');
 h.mutate();
 h.advance(500);
 assert.equal(states(h.messages).length,events,'the disposed observer no longer samples the page');
});
