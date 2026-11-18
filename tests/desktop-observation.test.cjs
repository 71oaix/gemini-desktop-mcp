'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const observation=require('../src/desktop-observation.cjs');

function pageState(over={}){
 return {
  url:'https://gemini.google.com/app',protocol:'https:',origin:'https://gemini.google.com',
  clientShell:false,hasInput:true,draft:'',dialog:false,backdrop:false,generates:false,
  uploads:[],controls:[],models:[],sendButtons:[],queries:[],responses:[],bodyText:'',...over
 };
}
function harness(){
 const ipcMain=new EventEmitter();
 const mainFrame={url:'https://gemini.google.com/app',parent:null};
 const wc=new EventEmitter();
 wc.mainFrame=mainFrame;
 wc.destroyed=false;
 wc.sent=[];
 wc.send=(channel,message)=>{wc.sent.push({channel,message:JSON.parse(JSON.stringify(message))});};
 wc.getURL=()=>mainFrame.url;
 wc.isDestroyed=()=>wc.destroyed;
 const host=new observation.ObservationHost({wc,ipcMain});
 return {ipcMain,wc,mainFrame,host};
}
function eventFor(h,over={}){
 return {sender:h.wc,senderFrame:h.mainFrame,...over};
}
function hello(h,over={}){
 const message={type:'hello',documentId:'doc-12345678',url:'https://gemini.google.com/app',protocol:1,...over};
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h,over.event),message);
 return message;
}
function lastBind(h){return h.wc.sent.filter(item=>item.channel===observation.CONTROL_CHANNEL&&item.message.type==='bind').at(-1)?.message;}
function envelope(h,over={}){
 const bind=lastBind(h);
 return {type:'state',bindingId:bind.bindingId,generation:bind.generation,seq:1,task_id:bind.task_id,state:pageState(),...over};
}
function sendState(h,over={}){
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h,over.event),envelope(h,over));
}
function nativeEnvelope(h,over={}){
 const bind=lastBind(h);
 return {type:'native',documentId:'doc-12345678',bindingId:bind.bindingId,generation:bind.generation,task_id:bind.task_id,seq:1,phase:'start',conversationId:'c_conv',...over};
}
function sendNative(h,over={}){
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h,over.event),nativeEnvelope(h,over));
}

test('hello from the authorized main frame binds and ready resolves on the first state',async()=>{
 const h=harness();
 const events=[];
 h.host.on('state',(state,meta)=>events.push({state,meta}));
 hello(h);
 const bind=lastBind(h);
 assert.ok(bind);
 assert.match(bind.bindingId,/^[0-9a-f-]{8,}$/);
 assert.equal(bind.generation,1);
 assert.equal(bind.task_id,null);
 assert.equal(h.host.binding.documentId,'doc-12345678');
 const promised=h.host.ready;
 sendState(h);
 const state=await promised;
 assert.equal(state.url,'https://gemini.google.com/app');
 assert.equal(h.host.currentState,state);
 assert.equal(h.host.diagnostics.hello,1);
 assert.equal(h.host.diagnostics.state,1);
 assert.equal(events.length,1);
 assert.equal(events[0].meta.seq,1);
 assert.equal(events[0].meta.bindingId,bind.bindingId);
 h.host.close();
});

test('wrong senders, iframe frames, URLs and malformed hello are rejected',()=>{
 const h=harness();
 const before=h.wc.sent.length;
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h,{sender:{}}),{type:'hello',documentId:'doc-12345678',url:'https://gemini.google.com/app',protocol:1});
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h,{senderFrame:{url:'https://gemini.google.com/app',parent:{}}}),{type:'hello',documentId:'doc-12345678',url:'https://gemini.google.com/app',protocol:1});
 h.mainFrame.url='https://evil.example/app';
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h),{type:'hello',documentId:'doc-12345678',url:'https://gemini.google.com/app',protocol:1});
 h.mainFrame.url='https://gemini.google.com/app';
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h),{type:'hello',documentId:'bad id',url:'https://gemini.google.com/app',protocol:1});
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h),{type:'hello',documentId:'doc-12345678',url:'https://evil.example/app',protocol:1});
 assert.equal(h.wc.sent.length,before);
 assert.equal(h.host.binding,null);
 assert.equal(h.host.diagnostics.rejected.sender,1);
 assert.equal(h.host.diagnostics.rejected.frame,1);
 assert.equal(h.host.diagnostics.rejected.url,2);
 assert.equal(h.host.diagnostics.rejected.schema,1);
 h.host.close();
});

test('stale generation, duplicate sequence, wrong binding and task mismatches are ignored',()=>{
 const h=harness();
 hello(h);
 sendState(h,{seq:1});
 const first=h.host.currentState;
 sendState(h,{seq:1});
 assert.equal(h.host.currentState,first);
 assert.equal(h.host.diagnostics.rejected.sequence,1);
 sendState(h,{bindingId:'spoofed-binding'});
 assert.equal(h.host.diagnostics.rejected.binding,1);
 sendState(h,{task_id:'task_1',seq:2});
 assert.equal(h.host.diagnostics.rejected.task,1);
 hello(h,{documentId:'doc-87654321'});
 const generation=lastBind(h).generation;
 assert.equal(generation,2);
 sendState(h,{generation:1,seq:2});
 assert.equal(h.host.diagnostics.rejected.generation,1);
 sendState(h,{generation,seq:1});
 assert.equal(h.host.currentState.url,'https://gemini.google.com/app');
 h.host.close();
});

test('payload limits and 1 MiB answer limits are enforced',()=>{
 const h=harness();
 hello(h);
 sendState(h,{state:pageState({responses:[{answer:'x'.repeat(observation.MAX_ANSWER_BYTES+1),complete:false}]})});
 assert.equal(h.host.diagnostics.rejected.schema,1);
 const huge=pageState({blob:'y'.repeat(observation.MAX_PAYLOAD_BYTES)});
 sendState(h,{state:huge});
 assert.equal(h.host.diagnostics.rejected.payload,1);
 assert.equal(h.host.currentState,null);
 h.host.close();
});

test('bindTask changes the expected task id and requests a fresh baseline',()=>{
 const h=harness();
 hello(h);
 assert.equal(lastBind(h).task_id,null);
 h.host.bindTask({id:'task_1'});
 assert.equal(lastBind(h).task_id,'task_1');
 assert.equal(h.host.currentState,null);
 sendState(h,{task_id:'task_1'});
 assert.equal(h.host.currentState.task_id,undefined);
 assert.ok(h.host.currentState);
 h.host.bindTask(null);
 assert.equal(lastBind(h).task_id,null);
 sendState(h,{task_id:null,seq:2});
 assert.equal(h.host.taskId,null);
 assert.throws(()=>h.host.bindTask({id:'bad id'}),/task\.id/);
 h.host.close();
});

test('ping is one-shot and validates the current document and binding',async()=>{
 const h=harness();
 hello(h);
 const pending=h.host.ping({deadlineMs:1000});
 const ping=h.wc.sent.filter(item=>item.channel===observation.CONTROL_CHANNEL&&item.message.type==='ping').at(-1)?.message;
 assert.ok(ping);
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h),{type:'pong',nonce:ping.nonce,documentId:'other-doc',bindingId:lastBind(h).bindingId,generation:lastBind(h).generation});
 h.ipcMain.emit(observation.EVENT_CHANNEL,eventFor(h),{type:'pong',nonce:ping.nonce,documentId:'doc-12345678',bindingId:lastBind(h).bindingId,generation:lastBind(h).generation});
 const pong=await pending;
 assert.equal(pong.nonce,ping.nonce);
 assert.equal(pong.documentId,'doc-12345678');
 h.host.close();
 await assert.rejects(()=>h.host.ping(),error=>error.code==='OBSERVATION_CLOSED');
});

test('waitFor is event-driven, supports abort/deadline and rejects on close',async()=>{
 const h=harness();
 hello(h);
 const future=h.host.waitFor(state=>state.responses.length===1,{deadlineMs:1000});
 sendState(h,{state:pageState({responses:[{answer:'answer',complete:true}]})});
 assert.equal((await future).responses[0].answer,'answer');
 const controller=new AbortController();
 const aborted=h.host.waitFor(()=>false,{signal:controller.signal,deadlineMs:1000});
 controller.abort();
 await assert.rejects(aborted,error=>error.code==='OBSERVATION_ABORTED');
 await assert.rejects(()=>h.host.waitFor(()=>false,{deadlineMs:5}),error=>error.code==='OBSERVATION_TIMEOUT');
 const closed=h.host.waitFor(()=>false,{deadlineMs:1000});
 h.host.close();
 await assert.rejects(closed,error=>error.code==='OBSERVATION_CLOSED');
});

test('native navigation faults invalidate the old document and a new hello rebinds',()=>{
 const h=harness();
 const faults=[];
 h.host.on('fault',fault=>faults.push(fault));
 hello(h);
 sendState(h,{seq:1});
 const oldGeneration=lastBind(h).generation;
 h.wc.emit('did-start-navigation',{url:'https://gemini.google.com/app/next',isMainFrame:true,isSameDocument:false});
 assert.equal(faults.at(-1).code,'NAVIGATION');
 assert.equal(h.host.binding,null);
 assert.equal(h.host.currentState,null);
 sendState(h,{seq:2,generation:oldGeneration});
 assert.equal(h.host.diagnostics.rejected.binding,1);
 hello(h,{documentId:'doc-87654321'});
 assert.equal(lastBind(h).generation,oldGeneration+1);
 sendState(h,{generation:oldGeneration,seq:1});
 assert.equal(h.host.diagnostics.rejected.generation,1);
 h.mainFrame.url='https://gemini.google.com/app/next';
 sendState(h,{generation:lastBind(h).generation,seq:1,state:pageState({url:'https://gemini.google.com/app/next'})});
 assert.equal(h.host.currentState.url,'https://gemini.google.com/app/next');
 h.wc.emit('did-start-navigation',{url:'https://gemini.google.com/app/next#section',isMainFrame:true,isSameDocument:true});
 assert.ok(h.host.binding,'same-document navigation must not invalidate the observer');
 h.wc.emit('render-process-gone',{}, {reason:'crashed'});
 assert.equal(faults.at(-1).code,'PROCESS_GONE');
 assert.equal(faults.at(-1).fatal,true);
 assert.equal(h.host.binding,null);
 h.host.close();
});

test('raw native lifecycle stays bounded diagnostic traffic and is never authoritative',()=>{
 const h=harness();
 hello(h);
 sendState(h,{seq:1});
 const state=h.host.currentState;
 const turns=[];
 h.host.on('native-turn',turn=>turns.push(turn));
 for(let i=0;i<30;i++)h.ipcMain.emit(observation.NATIVE_CHANNEL,eventFor(h),{phase:'phase-'+i,task_id:'task_1'});
 assert.equal(h.host.nativePhases.length,observation.MAX_NATIVE_PHASES);
 assert.equal(h.host.nativePhases.at(-1).phase,'phase-29');
 assert.ok(h.host.nativePhases.every(turn=>turn.authoritative===false));
 assert.equal(h.host.diagnostics.raw_native,30);
 assert.equal(h.host.diagnostics.native,0);
 assert.equal(turns.length,0,'an unbound raw notification must never become an authoritative native turn');
 assert.equal(h.host.nativePhases.at(-1).task_id,'task_1','raw diagnostics keep only what the source sent');
 assert.equal(h.host.currentState,state,'native phases must not replace observed state');
 h.ipcMain.emit(observation.NATIVE_CHANNEL,eventFor(h),{phase:'complete',conversationId:'c_conv'});
 assert.equal(h.host.diagnostics.raw_native,31);
 assert.ok(h.wc.sent.some(item=>item.channel===observation.CONTROL_CHANNEL&&item.message.type==='sample'),'a raw complete may still request a sample');
 h.ipcMain.emit(observation.NATIVE_CHANNEL,eventFor(h,{senderFrame:{url:'https://gemini.google.com/app',parent:{}}}),{phase:'spoof'});
 assert.equal(h.host.diagnostics.raw_native,31);
 h.ipcMain.emit(observation.NATIVE_CHANNEL,eventFor(h),{phase:'x'.repeat(65)});
 assert.equal(h.host.diagnostics.raw_native,31);
 h.host.close();
});

test('observer native envelopes require the bound document, binding, generation, task and sequence',()=>{
 const h=harness();
 hello(h);
 h.host.bindTask({id:'task_1'});
 sendState(h,{task_id:'task_1',seq:1});
 const turns=[];
 h.host.on('native-turn',turn=>turns.push(turn));
 sendNative(h,{seq:1,phase:'start'});
 assert.equal(turns.length,1);
 assert.equal(turns[0].task_id,'task_1');
 assert.equal(turns[0].authoritative,true);
 sendNative(h,{seq:1,phase:'start'});
 assert.equal(h.host.diagnostics.rejected.sequence,1);
 sendNative(h,{seq:2,phase:'start',documentId:'doc-87654321'});
 assert.equal(h.host.diagnostics.rejected.binding,1);
 sendNative(h,{seq:2,phase:'start',generation:lastBind(h).generation+1});
 assert.equal(h.host.diagnostics.rejected.generation,1);
 sendNative(h,{seq:2,phase:'start',task_id:'task_old'});
 assert.equal(h.host.diagnostics.rejected.task,1);
 assert.equal(turns.length,1,'rejected envelopes must not reach the state machine');
 sendNative(h,{seq:2,phase:'heartbeat'});
 assert.equal(turns.length,1);
 assert.equal(h.host.nativePhases.at(-1).authoritative,false);
 assert.equal(h.host.diagnostics.native,1);
 h.host.close();
});

test('a valid same-task same-document start/complete pair emits exactly two authoritative native turns',()=>{
 const h=harness();
 hello(h);
 h.host.bindTask({id:'task_1'});
 sendState(h,{task_id:'task_1',seq:1});
 const turns=[];
 h.host.on('native-turn',turn=>turns.push(turn));
 sendNative(h,{seq:1,phase:'start',conversationId:'c_conv'});
 sendNative(h,{seq:2,phase:'complete',conversationId:'c_conv'});
 assert.deepEqual(turns.map(turn=>turn.phase),['start','complete']);
 assert.equal(turns[0].task_id,'task_1');
 assert.equal(turns[1].task_id,'task_1');
 assert.equal(turns[0].documentId,'doc-12345678');
 assert.equal(turns[1].documentId,'doc-12345678');
 assert.ok(turns[1].sequence>turns[0].sequence);
 assert.equal(h.host.diagnostics.native,2);
 assert.ok(h.wc.sent.some(item=>item.channel===observation.CONTROL_CHANNEL&&item.message.type==='sample'),'an authoritative complete still requests a confirming sample');
 h.host.close();
});

test('a complete carrying an old task or a stale binding is rejected',()=>{
 const h=harness();
 hello(h);
 h.host.bindTask({id:'task_1'});
 sendState(h,{task_id:'task_1',seq:1});
 const turns=[];
 h.host.on('native-turn',turn=>turns.push(turn));
 sendNative(h,{seq:1,phase:'start'});
 h.host.bindTask({id:'task_2'});
 sendNative(h,{seq:2,phase:'complete',task_id:'task_1'});
 assert.equal(h.host.diagnostics.rejected.task,1);
 assert.equal(turns.length,1,'an old task start must not be relabeled to the current task');
 const stale=lastBind(h);
 hello(h,{documentId:'doc-87654321'});
 sendNative(h,{seq:3,phase:'complete',bindingId:stale.bindingId,generation:stale.generation,task_id:'task_2'});
 assert.equal(h.host.diagnostics.rejected.binding,1);
 assert.equal(turns.length,1);
 h.host.close();
});

test('out-of-order native envelopes are rejected before they reach the state machine',()=>{
 const h=harness();
 hello(h);
 h.host.bindTask({id:'task_1'});
 sendState(h,{task_id:'task_1',seq:1});
 const turns=[];
 h.host.on('native-turn',turn=>turns.push(turn));
 sendNative(h,{seq:2,phase:'start'});
 sendNative(h,{seq:1,phase:'complete'});
 assert.deepEqual(turns.map(turn=>turn.phase),['start']);
 assert.equal(h.host.diagnostics.rejected.sequence,1);
 h.host.close();
});

test('close removes IPC and webContents listeners and is idempotent',async()=>{
 const h=harness();
 hello(h);
 const ready=h.host.ready;
 const counts={
  event:h.ipcMain.listenerCount(observation.EVENT_CHANNEL),
  native:h.ipcMain.listenerCount(observation.NATIVE_CHANNEL),
  navigation:h.wc.listenerCount('did-start-navigation')
 };
 h.host.close();
 h.host.close();
 assert.equal(h.ipcMain.listenerCount(observation.EVENT_CHANNEL),0);
 assert.equal(h.ipcMain.listenerCount(observation.NATIVE_CHANNEL),0);
 assert.equal(h.wc.listenerCount('did-start-navigation'),0);
 assert.ok(counts.event>0&&counts.native>0&&counts.navigation>0);
 await assert.rejects(ready,error=>error.code==='OBSERVATION_CLOSED');
});

test('observations from another document URL are rejected even on the same frame',()=>{
 const h=harness();hello(h);sendState(h,{state:pageState({url:'https://gemini.google.com/app/old'})});
 assert.equal(h.host.currentState,null);assert.equal(h.host.diagnostics.rejected.url,1);h.host.close();
});

test('the HTTPS Gemini landing root is observable while other origins and mismatched URLs stay rejected',()=>{
 for(const url of ['https://gemini.google.com/','https://gemini.google.com/app','https://gemini.google.com/u/1/','https://gemini.google.com/u/1/app/abc'])assert.equal(observation.isTrustedUrl(url),true,url);
 for(const url of ['http://gemini.google.com/','https://user:pass@gemini.google.com/','https://gemini.google.com:8443/','https://evil.example/','https://gemini.google.com.evil.example/','https://accounts.google.com/'])assert.equal(observation.isTrustedUrl(url),false,url);
 const h=harness();
 h.mainFrame.url='https://gemini.google.com/';
 hello(h,{url:'https://gemini.google.com/'});
 assert.ok(h.host.binding);
 sendState(h,{state:pageState({url:'https://gemini.google.com/app'})});
 assert.equal(h.host.currentState,null);
 assert.equal(h.host.diagnostics.rejected.url,1);
 sendState(h,{state:pageState({url:'https://gemini.google.com/'})});
 assert.equal(h.host.currentState.url,'https://gemini.google.com/');
 h.host.close();
});
