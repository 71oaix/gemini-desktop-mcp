const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-worker-events-'));
process.env.GEMINI_WORK_STATE=state;
const store=require('../src/store.cjs');
const {runWorker,unsentProof}=require('../src/worker.cjs');

function clean(db){
 db.exec('DELETE FROM tasks; DELETE FROM runtime;');
 db.prepare("DELETE FROM meta WHERE key='desktop_event_cursor'").run();
 fs.rmSync(path.join(state,'stop-worker'),{force:true});
 fs.rmSync(path.join(state,'bridge-tasks'),{recursive:true,force:true});
}
function writeBridgeLedger(taskId,value){
 const directory=path.join(state,'bridge-tasks');
 fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,`${taskId}.json`),JSON.stringify(value));
}
function startRuntime(db,workerToken){
 db.prepare('DELETE FROM runtime').run();
 assert.equal(store.claimSupervisor(db,{token:`sup-${workerToken}`,pid:process.pid}).ok,true);
 assert.equal(store.startWorker(db,{supervisorToken:`sup-${workerToken}`,workerToken,pid:process.pid}).ok,true);
}
function snapshotFor(task,{status='generating',revision=1,answer='',url=null,confirmed=true,send_state='confirmed',metadata={},error=null}={}){
 return {task_id:task.id,status,phase:status,revision,send_state,metadata,budget_exhausted:metadata.budget_exhausted===true,
  result:{answer,url,model:'flash',submission_confirmed:confirmed,submission_known:send_state!=='uncertain',marker:task.marker,beforeResponses:0},
  error:error?{code:error.code||'ERROR',message:error.message||''}:null};
}
function taskEvent(instanceId,task,options){
 const snapshot=snapshotFor(task,options);
 return {instance_id:instanceId,seq:options.seq,type:'snapshot',task_id:task.id,revision:snapshot.revision,snapshot};
}
function taskEventOptions({seq,revision,status,answer,url,confirmed,send_state,metadata,error}={}){
 return {seq,revision,status,answer,url,confirmed,send_state,metadata,error};
}

class FakeTransport{
 constructor(options={}){
  this.readiness=options.readiness||{running:true,probe:{connected:true,pageReady:true,readOnly:false}};
  this.onExecute=options.execute||options.onExecute||null;
  this.onSynchronize=options.synchronize||options.onSync||null;
  this.onSnapshot=options.snapshot||options.onSnapshot||null;
  this.onRecover=options.recover||options.onRecover||null;
  this.onRelease=options.release||options.onRelease||null;
  this._stream=options.stream||options.onStream||null;
  this.timeoutMs=1000;
  this.calls=[];this.executeCalls=[];this.syncCalls=[];this.snapshotCalls=[];this.recoverCalls=[];this.releaseCalls=[];this.subscriptions=[];this.readyCalls=[];
  // Only expose awaitReady when the test opts in; legacy fakes without it must
  // keep the explicit blocked behavior rather than a periodic fallback.
  if(typeof options.ready==='function'){
   this.awaitReady=async()=>{this.calls.push({op:'awaitReady'});this.readyCalls.push(1);return options.ready(this);};
  }
 }
 async ensureRunning(options){this.calls.push({op:'ensureRunning',options});return this.readiness;}
 async execute(wire){
  this.calls.push({op:'execute'});this.executeCalls.push(wire);
  if(!this.onExecute)throw Object.assign(Error('test transport has no execute'),{code:'TEST_NO_EXECUTE'});
  return this.onExecute(wire,this);
 }
 async synchronize(){
  this.calls.push({op:'synchronize'});this.syncCalls.push(this.syncCalls.length+1);
  if(!this.onSynchronize)return {instance_id:'epoch-default',seq:0,snapshots:[]};
  return this.onSynchronize(this.syncCalls.length,this);
 }
 async snapshot(taskId){
  this.calls.push({op:'snapshot',task_id:taskId});this.snapshotCalls.push(taskId);
  if(!this.onSnapshot)return null;
  return this.onSnapshot(taskId,this);
 }
 async recover(taskId){
  this.calls.push({op:'recover',task_id:taskId});this.recoverCalls.push(taskId);
  if(!this.onRecover)return null;
  return this.onRecover(taskId,this);
 }
 async release(taskId){
  this.calls.push({op:'release',task_id:taskId});this.releaseCalls.push(taskId);
  if(this.onRelease)return this.onRelease(taskId,this);
  return {released:true};
 }
 events({cursor,signal,onEvent}){
  this.calls.push({op:'events',cursor:cursor?{...cursor}:null});
  const subscription={attempt:this.subscriptions.length,cursor:cursor?{...cursor}:null,signal,closed:false};
  const promise=new Promise((resolve,reject)=>{
   subscription.emit=event=>{
    if(subscription.closed)return Promise.resolve();
    return Promise.resolve(onEvent(event));
   };
   subscription.reset=data=>subscription.emit({type:'reset',data});
   subscription.heartbeat=data=>subscription.emit({type:'heartbeat',data});
   subscription.drop=error=>{
    if(subscription.closed)return;
    subscription.closed=true;
    reject(error||Object.assign(Error('event stream closed'),{code:'EVENT_STREAM_CLOSED'}));
   };
   subscription.resolve=()=>{
    if(subscription.closed)return;
    subscription.closed=true;resolve();
   };
   const abort=()=>{
    if(subscription.closed)return;
    subscription.closed=true;
    reject(Object.assign(Error('aborted'),{code:'ABORT_ERR'}));
   };
   signal?.addEventListener('abort',abort,{once:true});
  });
  this.subscriptions.push(subscription);
  if(this._stream)Promise.resolve().then(()=>this._stream(subscription,this)).catch(()=>{});
  return promise;
 }
}
function waitUntil(predicate,message='condition not met',timeoutMs=4000){
 return new Promise((resolve,reject)=>{
  const deadline=Date.now()+timeoutMs;
  const check=()=>{
   let value;
   try{value=predicate();}catch(error){reject(error);return;}
   if(value)return resolve(value);
   if(Date.now()>=deadline)return reject(Error(message));
   setTimeout(check,5);
  };
  check();
 });
}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function runOnce(db,transport,token){
 return runWorker({db,transport,token,once:true,waitForOwnershipMs:100,sleep:ms=>delay(Math.min(ms,20))});
}

test('quiet generation stays event driven with a null timeout and never polls snapshots',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-quiet',prompt:'hello'});
  const task=store.row(db,'events-quiet');
  assert.equal(task.request.timeoutMs,null);
  startRuntime(db,'worker-quiet');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:null});
  const transport=new FakeTransport({
   execute:wire=>{assert.equal(wire.timeoutMs,null);return generating;},
   synchronize:()=>({instance_id:'epoch-quiet',seq:4,snapshots:[generating]})
  });
  let settled=false;
  const running=runOnce(db,transport,'worker-quiet').finally(()=>{settled=true;});
  await waitUntil(()=>transport.subscriptions.length===1,'events subscription missing');
  await delay(80);
  assert.equal(settled,false);
  assert.equal(store.row(db,'events-quiet').status,'generating');
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.snapshotCalls.length,0);
  const completed=taskEvent('epoch-quiet',task,taskEventOptions({seq:5,revision:2,status:'completed',answer:'full answer',url:'https://gemini.google.com/app/quiet'}));
  await transport.subscriptions[0].emit({type:'task',data:completed});
  await running;
  const final=store.row(db,'events-quiet');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'full answer');
  assert.equal(transport.executeCalls.length,1);assert.equal(transport.snapshotCalls.length,0);
  assert.equal(transport.releaseCalls.length,1);
 }finally{db.close();}
});

test('a lost execute reply recovers through sync and replay without a second execute',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-lost-reply',prompt:'hello'});
  const task=store.row(db,'events-lost-reply');
  startRuntime(db,'worker-lost');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/lost'});
  const transport=new FakeTransport({
   execute:()=>{throw Object.assign(Error('reply lost'),{code:'DESKTOP_RPC_TIMEOUT'});},
   synchronize:()=>({instance_id:'epoch-lost',seq:7,snapshots:[generating]})
  });
  transport._stream=subscription=>{setTimeout(()=>subscription.emit({type:'task',data:taskEvent('epoch-lost',task,taskEventOptions({seq:8,revision:2,status:'completed',answer:'recovered',url:'https://gemini.google.com/app/lost'}))}),5);};
  await runOnce(db,transport,'worker-lost');
  const final=store.row(db,'events-lost-reply');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'recovered');
  assert.equal(transport.executeCalls.length,1);assert.equal(transport.snapshotCalls.length,0);
  assert.equal(transport.subscriptions[0].cursor.seq,7);
 }finally{db.close();}
});

test('a dropped stream reconnects immediately from the persisted cursor and replays missing events',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-reconnect',prompt:'hello'});
  const task=store.row(db,'events-reconnect');
  startRuntime(db,'worker-reconnect');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/reconnect'});
  const transport=new FakeTransport({
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-reconnect',seq:10,snapshots:[generating]})
  });
  transport._stream=async subscription=>{
   if(subscription.attempt===0){
    await delay(5);
    await subscription.emit({type:'task',data:taskEvent('epoch-reconnect',task,taskEventOptions({seq:11,revision:2,status:'generating',answer:'draft',url:'https://gemini.google.com/app/reconnect'}))});
    await delay(5);
    subscription.drop(Object.assign(Error('stream dropped'),{code:'EVENT_STREAM_CLOSED'}));
   }else if(subscription.attempt===1){
    assert.equal(subscription.cursor.seq,11);
    await delay(5);
    await subscription.emit({type:'task',data:taskEvent('epoch-reconnect',task,taskEventOptions({seq:12,revision:3,status:'completed',answer:'full after replay',url:'https://gemini.google.com/app/reconnect'}))});
   }
  };
  await runOnce(db,transport,'worker-reconnect');
  const final=store.row(db,'events-reconnect');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'full after replay');
  assert.ok(transport.subscriptions.length>=2);
  assert.equal(transport.subscriptions[1].cursor.seq,11);
  assert.equal(transport.snapshotCalls.length,0);
 }finally{db.close();}
});

test('explicit budget exhaustion holds occupancy until completion',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-budget',prompt:'hello'});
  const task=store.row(db,'events-budget');
  startRuntime(db,'worker-budget');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/budget'});
  const transport=new FakeTransport({
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-budget',seq:0,snapshots:[generating]})
  });
  let settled=false;
  const running=runOnce(db,transport,'worker-budget').finally(()=>{settled=true;});
  await waitUntil(()=>transport.subscriptions.length===1,'events subscription missing');
  const partial=taskEvent('epoch-budget',task,taskEventOptions({seq:1,revision:2,status:'partial',answer:'half answer',url:'https://gemini.google.com/app/budget',metadata:{budget_exhausted:true}}));
  await transport.subscriptions[0].emit({type:'task',data:partial});
  await waitUntil(()=>store.row(db,'events-budget').status==='partial','budget partial not applied');
  const held=store.row(db,'events-budget');
  assert.equal(held.budget_exhausted,1);assert.equal(held.next_attempt,null);assert.equal(held.attempts,0);
  assert.equal(settled,false);
  assert.equal(transport.snapshotCalls.length,0);
  const completed=taskEvent('epoch-budget',task,taskEventOptions({seq:2,revision:3,status:'completed',answer:'full answer',url:'https://gemini.google.com/app/budget'}));
  await transport.subscriptions[0].emit({type:'task',data:completed});
  await running;
  const final=store.row(db,'events-budget');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'full answer');
  assert.equal(transport.releaseCalls.length,1);
 }finally{db.close();}
});

test('snapshot_required fetches exactly one snapshot before advancing the event cursor',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-snapshot-required',prompt:'hello'});
  const task=store.row(db,'events-snapshot-required');
  startRuntime(db,'worker-required');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/required'});
  const completed=snapshotFor(task,{status:'completed',revision:4,answer:'from snapshot',url:'https://gemini.google.com/app/required'});
  const transport=new FakeTransport({
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-required',seq:0,snapshots:[generating]}),
   snapshot:()=>completed
  });
  transport._stream=async subscription=>{
   await delay(5);
   await subscription.emit({type:'task',data:{instance_id:'epoch-required',seq:1,type:'snapshot',task_id:task.id,revision:3,snapshot_required:true}});
  };
  await runOnce(db,transport,'worker-required');
  const final=store.row(db,'events-snapshot-required');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'from snapshot');
  assert.equal(transport.snapshotCalls.length,1);
  assert.deepEqual(transport.snapshotCalls,['events-snapshot-required']);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='desktop_event_cursor'").get().value.includes('"seq":1'),true);
  assert.equal(transport.releaseCalls.length,1);
 }finally{db.close();}
});

test('a stale snapshot_required payload is abandoned without advancing the cursor',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-stale-snapshot',prompt:'hello'});
  const task=store.row(db,'events-stale-snapshot');
  startRuntime(db,'worker-stale-snapshot');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/stale-snapshot'});
  const stale=snapshotFor(task,{status:'completed',revision:4,answer:'poisoned stale snapshot',url:'https://gemini.google.com/app/stale-snapshot'});
  const transport=new FakeTransport({
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-stale-snapshot',seq:0,snapshots:[generating]}),
   snapshot:()=>stale
  });
  transport._stream=async subscription=>{
   if(subscription.attempt===0){
    await delay(5);
    await subscription.emit({type:'task',data:{instance_id:'epoch-stale-snapshot',seq:1,type:'snapshot',task_id:task.id,revision:5,snapshot_required:true}});
   }else if(subscription.attempt===1){
    assert.equal(subscription.cursor.seq,0);
    await delay(5);
    await subscription.emit({type:'task',data:taskEvent('epoch-stale-snapshot',task,taskEventOptions({seq:1,revision:6,status:'completed',answer:'real after retry',url:'https://gemini.google.com/app/stale-snapshot'}))});
   }
  };
  await runOnce(db,transport,'worker-stale-snapshot');
  const final=store.row(db,'events-stale-snapshot');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'real after retry');
  assert.equal(transport.snapshotCalls.length,1);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='desktop_event_cursor'").get().value).seq,1);
 }finally{db.close();}
});

test('queue fencing aborts monitoring and leaves the event cursor untouched',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-fenced',prompt:'hello'});
  const task=store.row(db,'events-fenced');
  startRuntime(db,'worker-fenced');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/fenced'});
  const transport=new FakeTransport({
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-fenced',seq:0,snapshots:[generating]})
  });
  const running=runOnce(db,transport,'worker-fenced');
  await waitUntil(()=>transport.subscriptions.length===1,'events subscription missing');
  db.prepare("UPDATE runtime SET worker_token='different-owner'").run();
  await assert.rejects(running,error=>error.fenced===true||error.code==='WORKER_FENCED');
  const cursor=db.prepare("SELECT value FROM meta WHERE key='desktop_event_cursor'").get();
  assert.equal(JSON.parse(cursor.value).seq,0);
  assert.equal(store.row(db,'events-fenced').result?.answer||'','');
 }finally{db.close();}
});

test('fencing one parallel task drains the other event stream before the worker exits',async()=>{
 const db=store.open();clean(db);
 let closed=false;
 try{
  store.submit(db,{task_id:'events-parallel-a',prompt:'hello a'});
  store.submit(db,{task_id:'events-parallel-b',prompt:'hello b'});
  const first=store.row(db,'events-parallel-a'),second=store.row(db,'events-parallel-b');
  startRuntime(db,'worker-parallel-fence');
  const snapshots=new Map([
   [first.id,snapshotFor(first,{status:'generating',revision:1,url:'https://gemini.google.com/app/parallel-a'})],
   [second.id,snapshotFor(second,{status:'generating',revision:1,url:'https://gemini.google.com/app/parallel-b'})]
  ]);
  const transport=new FakeTransport({
   execute:wire=>snapshots.get(wire.id),
   synchronize:()=>({instance_id:'epoch-parallel',seq:0,snapshots:[...snapshots.values()]})
  });
  const running=runWorker({db,transport,token:'worker-parallel-fence',once:false,waitForOwnershipMs:100,sleep:ms=>delay(Math.min(ms,20))});
  await waitUntil(()=>transport.subscriptions.length===2,'both parallel event streams must subscribe');
  db.prepare("UPDATE runtime SET worker_token='different-owner'").run();
  // The fenced task rejects through applyEvent, so runWorker's Promise.race
  // rejects while the other task is still holding an open event stream.
  await transport.subscriptions[0].emit({type:'task',data:taskEvent('epoch-parallel',first,taskEventOptions({seq:1,revision:2,status:'generating',url:'https://gemini.google.com/app/parallel-a'}))});
  await assert.rejects(running,error=>error.fenced===true||error.code==='WORKER_FENCED');
  assert.equal(transport.subscriptions.length,2);
  assert.equal(transport.subscriptions[0].closed,true);
  assert.equal(transport.subscriptions[1].closed,true,'a fenced worker must abort the surviving event stream before exiting');
  assert.equal(transport.releaseCalls.length,0);
  assert.equal(store.row(db,'events-parallel-a').status,'generating');
  assert.equal(store.row(db,'events-parallel-b').status,'generating');
  // Closing the shared database must not leave a monitor interval reading it.
  db.close();closed=true;
  await delay(250);
 }finally{
  if(!closed)db.close();
 }
});

test('read-only bridge pauses before execute with a concrete error',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-readonly',prompt:'hello'});
  startRuntime(db,'worker-readonly');
  const transport=new FakeTransport({readiness:{running:true,probe:{connected:true,pageReady:true,readOnly:true}}});
  await runOnce(db,transport,'worker-readonly');
  const task=store.row(db,'events-readonly');
  assert.equal(task.status,'needs_user_action');
  assert.equal(task.error_code,'BRIDGE_READ_ONLY');
  assert.equal(task.send_intent,0);
  assert.equal(transport.executeCalls.length,0);
  assert.equal(transport.syncCalls.length,0);
  assert.equal(transport.subscriptions.length,0);
  assert.equal(store.runtime(db).connection,'needs_user_action');
 }finally{db.close();}
});

test('a mismatched marker fails closed without storing the poisoned answer',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-marker',prompt:'hello'});
  const task=store.row(db,'events-marker');
  startRuntime(db,'worker-marker');
  const poisoned=snapshotFor(task,{status:'completed',revision:3,answer:'poisoned answer',url:'https://gemini.google.com/app/marker'});
  poisoned.result.marker='[gemini-work:wrongmarker]';
  const transport=new FakeTransport({
   execute:()=>{throw Object.assign(Error('reply lost'),{code:'DESKTOP_RPC_TIMEOUT'});},
   synchronize:()=>({instance_id:'epoch-marker',seq:3,snapshots:[poisoned]})
  });
  await runOnce(db,transport,'worker-marker');
  const final=store.row(db,'events-marker');
  assert.equal(final.status,'failed');assert.equal(final.error_code,'MARKER_MISMATCH');
  assert.equal(final.result?.answer||'','');
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.snapshotCalls.length,0);
  assert.equal(transport.subscriptions.length,0);
 }finally{db.close();}
});

test('a stale epoch triggers a fresh sync and never contaminates the current answer',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-stale-epoch',prompt:'hello'});
  const task=store.row(db,'events-stale-epoch');
  startRuntime(db,'worker-stale');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/stale'});
  const completed=snapshotFor(task,{status:'completed',revision:5,answer:'real answer',url:'https://gemini.google.com/app/stale'});
  const transport=new FakeTransport({
   execute:()=>generating,
   synchronize:call=>call===1?{instance_id:'epoch-new',seq:1,snapshots:[generating]}:{instance_id:'epoch-new',seq:3,snapshots:[completed]}
  });
  transport._stream=async subscription=>{
   await delay(5);
   await subscription.emit({type:'task',data:{instance_id:'epoch-old',seq:2,type:'snapshot',task_id:task.id,revision:4,snapshot:snapshotFor(task,{status:'completed',revision:4,answer:'poisoned old epoch',url:'https://gemini.google.com/app/stale'})}});
  };
  await runOnce(db,transport,'worker-stale');
  const final=store.row(db,'events-stale-epoch');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'real answer');
  assert.equal(transport.syncCalls.length,2);
  assert.equal(transport.recoverCalls.length,0);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='desktop_event_cursor'").get().value).seq,3);
 }finally{db.close();}
});

test('rebinding a confirmed task recovers once without executing it again',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-recover',prompt:'hello'});
  const task=store.row(db,'events-recover');
  store.update(db,'events-recover',{status:'uncertain',next_attempt:0,next_op:'recover',recover:1,send_intent:1,result:{answer:'partial',url:'https://gemini.google.com/app/recover',model:'flash',submission_confirmed:true,submission_known:true,marker:task.marker,beforeResponses:0}});
  startRuntime(db,'worker-recover');
  const completed=snapshotFor(task,{status:'completed',revision:9,answer:'recovered answer',url:'https://gemini.google.com/app/recover'});
  const transport=new FakeTransport({
   synchronize:()=>({instance_id:'epoch-recover',seq:0,snapshots:[snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/recover',metadata:{execution_active:false}})]}),
   recover:()=>completed
  });
  await runOnce(db,transport,'worker-recover');
  const final=store.row(db,'events-recover');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'recovered answer');
  assert.equal(transport.executeCalls.length,0);
  assert.equal(transport.recoverCalls.length,1);
  assert.equal(transport.releaseCalls.length,1);
 }finally{db.close();}
});

test('a durable marker without a URL recovers read-only through recover and enables continue_task_id',async()=>{
 const db=store.open();clean(db);
 const id='events-late-bind';
 try{
  store.submit(db,{task_id:id,prompt:'hello'});
  const task=store.row(db,id);
  store.update(db,id,{
   status:'uncertain',next_attempt:0,next_op:'snapshot',send_intent:1,
   error:'已在页面看到任务标记，但未获得带会话 id 的 URL；保持待确认且绝不重发',error_code:'SEND_UNCONFIRMED_URL',
   result:{answer:'',url:null,model:null,submission_confirmed:false,submission_known:true,marker:task.marker,beforeResponses:0}
  });
  writeBridgeLedger(id,{
   task_id:id,marker:task.marker,status:'uncertain',phase:'uncertain',revision:2,released:false,
   result:{answer:'',url:null,submission_confirmed:false,marker:task.marker,beforeResponses:0},
   error:{code:'SEND_UNCONFIRMED_URL',message:'late url'},
   metadata:{marker_seen_target:{session_id:'primary',extra:false,web_contents_id:1}},
   phases:{prepared:{at:new Date(0).toISOString()},send_intent:{at:new Date(0).toISOString()},marker_seen:{at:new Date(0).toISOString(),url:'https://gemini.google.com/app'},confirmed:null,terminal:null}
  });
  startRuntime(db,'worker-late-bind');
  const own=snapshotFor(task,{status:'uncertain',revision:2,url:null,confirmed:false,send_state:'submitted',error:{code:'SEND_UNCONFIRMED_URL',message:'late url'},metadata:{execution_active:false}});
  assert.ok(store.resumeAfterProbe(db).includes(id));
  assert.equal(store.row(db,id).next_op,'recover');
  const completed=taskEvent('epoch-late',task,{seq:1,status:'completed',revision:5,answer:'late full answer',url:'https://gemini.google.com/app/late'});
  const transport=new FakeTransport({
   synchronize:()=>({instance_id:'epoch-late',seq:0,snapshots:[own]}),
   recover:()=>({...own,metadata:{execution_active:true}}),
   stream:sub=>sub.emit({type:'task',data:completed})
  });
  await runOnce(db,transport,'worker-late-bind');
  const final=store.row(db,id);
  assert.equal(final.status,'completed');
  assert.equal(store.result(db,{task_id:id}).answer,'late full answer');
  assert.equal(final.result.url,'https://gemini.google.com/app/late');
  assert.equal(transport.executeCalls.length,0,'late binding must never execute again');
  assert.equal(transport.recoverCalls.length,1);
  assert.equal(transport.releaseCalls.length,1);
  const child=store.submit(db,{prompt:'follow up',continue_task_id:id});
  assert.equal(store.row(db,child.task_id).request.url,'https://gemini.google.com/app/late');
 }finally{db.close();}
});

test('late binding remains uncertain after bounded automatic attempts and can reconnect',async()=>{
 const db=store.open();clean(db);
 const id='events-late-bind-exhausted';
 try{
  store.submit(db,{task_id:id,prompt:'hello'});
  const task=store.row(db,id);
  store.update(db,id,{status:'uncertain',next_attempt:0,next_op:'recover',attempts:store.MAX_RETRIES,send_intent:1});
  const code='SEND_UNCONFIRMED_URL';
  const own=snapshotFor(task,{status:'uncertain',revision:2,confirmed:false,send_state:'submitted',error:{code},metadata:{execution_active:false}});
  writeBridgeLedger(id,{...own,phases:{send_intent:{at:1},marker_seen:{at:2},confirmed:null}});
  startRuntime(db,'worker-late-bind-exhausted');
  const transport=new FakeTransport({
   synchronize:()=>({instance_id:'epoch-late-exhausted',seq:0,snapshots:[own]}),
   recover:()=>own
  });
  await runOnce(db,transport,'worker-late-bind-exhausted');
  const held=store.row(db,id);
  assert.equal(held.status,'uncertain');
  assert.equal(held.error_code,code);
  assert.equal(held.next_attempt,null);
  assert.equal(transport.executeCalls.length,0);
  assert.ok(store.resumeAfterProbe(db).includes(id));
  assert.equal(store.row(db,id).next_op,'recover');
 }finally{db.close();}
});

test('handled PENDING_TASK and RELEASED replies fail closed without network retries or resends',async()=>{
 const db=store.open();
 try{
  for(const [taskId,code,expectedStatus] of [['events-pending','PENDING_TASK','needs_user_action'],['events-released','RELEASED','failed']]){
   clean(db);
   store.submit(db,{task_id:taskId,prompt:'hello'});
   startRuntime(db,`worker-${taskId}`);
   const transport=new FakeTransport({execute:()=>{throw Object.assign(Error(code),{code});}});
   await runOnce(db,transport,`worker-${taskId}`);
   const final=store.row(db,taskId);
   assert.equal(final.status,expectedStatus);
   assert.equal(final.error_code,code);
   assert.equal(final.next_attempt,null);
   assert.equal(final.attempts,0);
   assert.equal(transport.executeCalls.length,1);
   assert.equal(transport.syncCalls.length,0);
   assert.equal(transport.subscriptions.length,0);
  }
 }finally{db.close();}
});

test('a confirmed network fault uses the existing minute retry and never resends',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-network',prompt:'hello'});
  const task=store.row(db,'events-network');
  startRuntime(db,'worker-network');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/network'});
  const transport=new FakeTransport({
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-network',seq:0,snapshots:[generating]})
  });
  transport._stream=subscription=>{setTimeout(()=>subscription.drop(Object.assign(Error('network down'),{code:'NETWORK_TRANSIENT'})),5);};
  const before=Date.now();
  await runOnce(db,transport,'worker-network');
  const final=store.row(db,'events-network');
  assert.equal(final.status,'uncertain');
  assert.equal(final.next_op,'recover');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.snapshotCalls.length,0);
  assert.equal(transport.releaseCalls.length,0);
 }finally{db.close();}
});

test('a persisted task unknown to the bridge fails closed instead of waiting or resending',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-unknown',prompt:'hello'});
  store.update(db,'events-unknown',{status:'uncertain',next_attempt:0,next_op:'snapshot',send_intent:1});
  startRuntime(db,'worker-unknown');
  const transport=new FakeTransport({synchronize:()=>({instance_id:'epoch-unknown',seq:0,snapshots:[]})});
  await runOnce(db,transport,'worker-unknown');
  const final=store.row(db,'events-unknown');
  assert.equal(final.status,'failed');assert.equal(final.error_code,'TASK_NOT_FOUND');
  assert.equal(transport.executeCalls.length,0);
  assert.equal(transport.recoverCalls.length,0);
  assert.equal(transport.subscriptions.length,0);
 }finally{db.close();}
});

test('an idle worker wakes on a filesystem change and executes a newly queued task',async()=>{
 const db=store.open();clean(db);
 const originalWatch=fs.watch;
 let openWatchers=0;
 fs.watch=(...args)=>{
  const watcher=originalWatch(...args);openWatchers+=1;
  const close=watcher.close.bind(watcher);let closed=false;
  watcher.close=()=>{if(!closed){closed=true;openWatchers-=1;}return close();};
  return watcher;
 };
 try{
  startRuntime(db,'worker-idle');
  const transport=new FakeTransport({
   execute:()=>snapshotFor({id:'events-idle',marker:store.row(db,'events-idle').marker},{status:'generating',revision:1,url:'https://gemini.google.com/app/idle'}),
   synchronize:()=>({instance_id:'epoch-idle',seq:0,snapshots:[snapshotFor({id:'events-idle',marker:store.row(db,'events-idle').marker},{status:'generating',revision:1,url:'https://gemini.google.com/app/idle'})]})
  });
  transport._stream=async subscription=>{
   await delay(5);
   const task=store.row(db,'events-idle');
   await subscription.emit({type:'task',data:taskEvent('epoch-idle',task,taskEventOptions({seq:1,revision:2,status:'completed',answer:'woke up',url:'https://gemini.google.com/app/idle'}))});
  };
  const running=runWorker({db,transport,token:'worker-idle',once:false,waitForOwnershipMs:100,sleep:ms=>delay(Math.min(ms,20))});
  await delay(60);
  store.submit(db,{task_id:'events-idle',prompt:'hello'});
  await waitUntil(()=>store.row(db,'events-idle').status==='completed','idle worker did not wake',4000);
  fs.writeFileSync(path.join(state,'stop-worker'),'');
  await running;
  assert.equal(openWatchers,0,'worker shutdown must close losing queue waits as well');
  assert.equal(store.row(db,'events-idle').result.answer,'woke up');
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.snapshotCalls.length,0);
 }finally{
  fs.watch=originalWatch;
  fs.rmSync(path.join(state,'stop-worker'),{force:true});
  db.close();
 }
});

test('stop-worker aborts an active event wait without changing execution state',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-stop',prompt:'hello'});
  const task=store.row(db,'events-stop');
  startRuntime(db,'worker-stop');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/stop'});
  const transport=new FakeTransport({
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-stop',seq:0,snapshots:[generating]})
  });
  const running=runOnce(db,transport,'worker-stop');
  await waitUntil(()=>transport.subscriptions.length===1,'events subscription missing');
  fs.writeFileSync(path.join(state,'stop-worker'),'');
  await running;
  assert.equal(transport.releaseCalls.length,0);
  assert.equal(store.row(db,'events-stop').status,'generating');
  assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='desktop_event_cursor'").get().value).seq,0);
 }finally{
  fs.rmSync(path.join(state,'stop-worker'),{force:true});
  db.close();
 }
});

test('a probe task waits for readiness and resumes the queue once usable',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-resume-send',prompt:'hello'});
  store.update(db,'events-resume-send',{status:'needs_user_action',error:'桌面桥页面尚未就绪；没有发送聊天消息。',error_code:'BRIDGE_PAGE_NOT_READY',next_op:'send',next_attempt:null});
  const probe=store.probe(db);
  startRuntime(db,'worker-probe-ready');
  const transport=new FakeTransport({
   readiness:{running:true,probe:{connected:false,pageReady:false,readOnly:false,observer:{bound:false,has_state:false}}},
   ready:()=>({connected:true,pageReady:true,readOnly:false,warming:false,observer:{bound:true,has_state:true},page:{usable:true,fault:null}})
  });
  await runOnce(db,transport,'worker-probe-ready');
  const finished=store.row(db,probe.task_id);
  assert.equal(finished.status,'completed');
  assert.equal(transport.readyCalls.length,1);
  assert.deepEqual(finished.result.resumed_task_ids,['events-resume-send']);
  assert.equal(store.row(db,'events-resume-send').status,'queued');
  assert.equal(transport.executeCalls.length,0);
 }finally{db.close();}
});

test('a warming startup awaits one readiness push and executes exactly once',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-warm-ready',prompt:'hello'});
  const task=store.row(db,'events-warm-ready');
  startRuntime(db,'worker-warm-ready');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/warm'});
  const transport=new FakeTransport({
   readiness:{running:true,probe:{connected:false,pageReady:false,readOnly:false,observer:{bound:false,has_state:false}}},
   ready:()=>({connected:true,pageReady:true,readOnly:false,warming:false,bridgeVersion:'test-bridge-2'}),
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-warm-ready',seq:0,snapshots:[generating]})
  });
  transport._stream=async subscription=>{
   await delay(5);
   await subscription.emit({type:'task',data:taskEvent('epoch-warm-ready',task,taskEventOptions({seq:1,revision:2,status:'completed',answer:'warm answer',url:'https://gemini.google.com/app/warm'}))});
  };
  await runOnce(db,transport,'worker-warm-ready');
  const final=store.row(db,'events-warm-ready');
  assert.equal(final.status,'completed');
  assert.equal(final.result.answer,'warm answer');
  assert.equal(final.send_intent,1);
  assert.equal(transport.readyCalls.length,1);
  assert.equal(transport.executeCalls.length,1);
 }finally{db.close();}
});

test('a startup that stays warming retries before send without intent or user action',async()=>{
 const db=store.open();
 try{
  for(const [taskId,declared,bound] of [['events-warm-page','BRIDGE_PAGE_NOT_READY',true],['events-warm-unbound','OBSERVER_NOT_BOUND',false]]){
   clean(db);
   store.submit(db,{task_id:taskId,prompt:'hello'});
   startRuntime(db,`worker-${taskId}`);
   const transport=new FakeTransport({
    readiness:{running:true,probe:{connected:bound,pageReady:false,readOnly:false,observer:{bound,has_state:bound}}},
    ready:()=>({connected:bound,pageReady:false,readOnly:false,warming:true,observer:{bound,has_state:bound},page:{usable:false,fault:null},error:{code:declared,message:'warming'}})
   });
   const before=Date.now();
   await runOnce(db,transport,`worker-${taskId}`);
   const final=store.row(db,taskId);
   assert.equal(final.status,'retry_wait',taskId);
   assert.equal(final.error_code,declared,taskId);
   assert.equal(final.send_intent,0,taskId);
   assert.equal(final.next_op,'send',taskId);
   assert.equal(final.attempts,1,taskId);
   assert.ok(final.next_attempt>=before+60000,`${taskId} next_attempt=${final.next_attempt}`);
   assert.equal(transport.readyCalls.length,1,taskId);
   assert.equal(transport.executeCalls.length,0,taskId);
   assert.equal(transport.syncCalls.length,0,taskId);
   assert.equal(transport.subscriptions.length,0,taskId);
   assert.equal(store.runtime(db).connection,'connected',taskId);
  }
 }finally{db.close();}
});

test('an explicit login fault pauses without waiting for readiness',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-login-warm',prompt:'hello'});
  startRuntime(db,'worker-login-warm');
  const transport=new FakeTransport({
   readiness:{running:true,probe:{connected:false,pageReady:false,readOnly:false,page:{usable:false,fault:'LOGIN_REQUIRED'},observer:{bound:true,has_state:true}}},
   ready:()=>{throw Error('awaitReady must not run for an explicit fault');}
  });
  await runOnce(db,transport,'worker-login-warm');
  const final=store.row(db,'events-login-warm');
  assert.equal(final.status,'needs_user_action');
  assert.equal(final.error_code,'NEEDS_LOGIN');
  assert.equal(final.send_intent,0);
  assert.equal(final.attempts,0);
  assert.equal(transport.readyCalls.length,0);
  assert.equal(transport.executeCalls.length,0);
  assert.equal(store.runtime(db).connection,'needs_user_action');
 }finally{db.close();}
});

test('read-only reported by readiness pauses without send intent',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-readonly-warm',prompt:'hello'});
  startRuntime(db,'worker-readonly-warm');
  const transport=new FakeTransport({
   readiness:{running:true,probe:{connected:true,pageReady:false,readOnly:false,observer:{bound:true,has_state:true}}},
   ready:()=>({connected:true,pageReady:false,warming:true,readOnly:true,error:{code:'BRIDGE_PAGE_NOT_READY',message:'warming'}})
  });
  await runOnce(db,transport,'worker-readonly-warm');
  const final=store.row(db,'events-readonly-warm');
  assert.equal(final.status,'needs_user_action');
  assert.equal(final.error_code,'BRIDGE_READ_ONLY');
  assert.equal(final.send_intent,0);
  assert.equal(transport.readyCalls.length,1);
  assert.equal(transport.executeCalls.length,0);
  assert.equal(store.runtime(db).connection,'needs_user_action');
 }finally{db.close();}
});

test('already sent startup warming keeps recover or snapshot and never resends',async()=>{
 const db=store.open();
 try{
  for(const [taskId,mode] of [['events-sent-recover','recover'],['events-sent-snapshot','snapshot']]){
   clean(db);
   store.submit(db,{task_id:taskId,prompt:'hello'});
   const task=store.row(db,taskId);
   const result=mode==='recover'
    ?{answer:'partial',url:'https://gemini.google.com/app/sent',model:'flash',submission_confirmed:true,submission_known:true,marker:task.marker,beforeResponses:0}
    :{answer:'',url:null,model:'flash',submission_confirmed:false,submission_known:false,marker:task.marker,beforeResponses:0};
   store.update(db,taskId,{status:'uncertain',next_attempt:0,next_op:mode,send_intent:1,result});
   startRuntime(db,`worker-${taskId}`);
   const transport=new FakeTransport({
    readiness:{running:true,probe:{connected:true,pageReady:false,readOnly:false,observer:{bound:true,has_state:true}}},
    ready:()=>({connected:true,pageReady:false,readOnly:false,warming:true,observer:{bound:true,has_state:true},page:{usable:false,fault:null},error:{code:'BRIDGE_PAGE_NOT_READY',message:'warming'}})
   });
   const before=Date.now();
   await runOnce(db,transport,`worker-${taskId}`);
   const final=store.row(db,taskId);
   assert.equal(final.status,'uncertain',taskId);
   assert.equal(final.next_op,mode,taskId);
   assert.equal(final.send_intent,1,taskId);
   assert.equal(final.attempts,1,taskId);
   assert.ok(final.next_attempt>=before+60000,`${taskId} next_attempt=${final.next_attempt}`);
   assert.equal(transport.readyCalls.length,1,taskId);
   assert.equal(transport.executeCalls.length,0,taskId);
   assert.equal(transport.recoverCalls.length,0,taskId);
   assert.equal(transport.syncCalls.length,0,taskId);
  }
 }finally{db.close();}
});

test('a usable page with an explicitly unbound observer waits for pushed readiness before sending',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-probe-unbound',prompt:'hello'});
  const task=store.row(db,'events-probe-unbound');
  startRuntime(db,'worker-probe-unbound');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/probe-unbound'});
  const transport=new FakeTransport({
   readiness:{running:true,probe:{connected:true,pageReady:true,readOnly:false,observer:{bound:false,has_state:false}}},
   ready:()=>({connected:true,pageReady:true,readOnly:false,warming:false,observer:{bound:true,has_state:true},page:{usable:true,fault:null}}),
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-probe-unbound',seq:0,snapshots:[generating]})
  });
  transport._stream=async subscription=>{
   await delay(5);
   await subscription.emit({type:'task',data:taskEvent('epoch-probe-unbound',task,taskEventOptions({seq:1,revision:2,status:'completed',answer:'observed answer',url:'https://gemini.google.com/app/probe-unbound'}))});
  };
  await runOnce(db,transport,'worker-probe-unbound');
  const final=store.row(db,'events-probe-unbound');
  assert.equal(final.status,'completed');
  assert.equal(final.result.answer,'observed answer');
  assert.equal(transport.readyCalls.length,1);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.syncCalls.length,1);
 }finally{db.close();}
});

test('a usable page with no readiness push backs off instead of sending while the observer is unbound',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-probe-unbound-idle',prompt:'hello'});
  startRuntime(db,'worker-probe-unbound-idle');
  const transport=new FakeTransport({
   readiness:{running:true,probe:{connected:true,pageReady:true,readOnly:false,observer:{bound:false,has_state:false}}}
  });
  const before=Date.now();
  await runOnce(db,transport,'worker-probe-unbound-idle');
  const final=store.row(db,'events-probe-unbound-idle');
  assert.equal(final.status,'retry_wait');
  assert.equal(final.error_code,'OBSERVER_NOT_BOUND');
  assert.equal(final.send_intent,0);
  assert.equal(final.next_op,'send');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,0);
  assert.equal(transport.syncCalls.length,0);
  assert.equal(transport.subscriptions.length,0);
  assert.equal(store.runtime(db).connection,'connected');
 }finally{db.close();}
});

test('an explicit OBSERVATION_UNAVAILABLE rejection clears intent and backs off instead of hanging in submitting',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-observation-unavailable',prompt:'hello'});
  startRuntime(db,'worker-observation-unavailable');
  const transport=new FakeTransport({
   execute:()=>{throw Object.assign(Error('观察器尚未绑定页面，拒绝轮询式操作'),{code:'OBSERVATION_UNAVAILABLE',status:409});}
  });
  const before=Date.now();
  await runOnce(db,transport,'worker-observation-unavailable');
  const final=store.row(db,'events-observation-unavailable');
  assert.equal(final.status,'retry_wait');
  assert.equal(final.error_code,'OBSERVATION_UNAVAILABLE');
  assert.equal(final.send_intent,0);
  assert.equal(final.next_op,'send');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.syncCalls.length,0);
  assert.equal(transport.subscriptions.length,0);
  assert.equal(store.runtime(db).connection,'connected');
 }finally{db.close();}
});

test('a not_sent preparing snapshot does not invent send intent; a later confirmed event records it',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-preparing',prompt:'hello'});
  const task=store.row(db,'events-preparing');
  startRuntime(db,'worker-preparing');
  const preparing=snapshotFor(task,{status:'submitting',revision:1,url:null,confirmed:false,send_state:'not_sent'});
  const transport=new FakeTransport({
   execute:()=>preparing,
   synchronize:()=>({instance_id:'epoch-preparing',seq:0,snapshots:[preparing]})
  });
  let emitCompletion=null;
  transport._stream=async subscription=>{
   await new Promise(resolve=>{emitCompletion=resolve;});
   await subscription.emit({type:'task',data:taskEvent('epoch-preparing',task,taskEventOptions({seq:1,revision:2,status:'completed',answer:'sent answer',url:'https://gemini.google.com/app/preparing'}))});
  };
  const running=runOnce(db,transport,'worker-preparing');
  await waitUntil(()=>transport.subscriptions.length===1&&emitCompletion,'preparing monitor missing');
  const held=store.row(db,'events-preparing');
  assert.equal(held.status,'submitting');
  // markSubmitting no longer writes send_intent before the real send click.
  assert.equal(held.send_intent,0);
  emitCompletion();
  await running;
  const final=store.row(db,'events-preparing');
  assert.equal(final.status,'completed');
  assert.equal(final.result.answer,'sent answer');
  assert.equal(final.send_intent,1);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.snapshotCalls.length,0);
 }finally{db.close();}
});

test('a trusted pre-send failure snapshot clears intent and retries send within the bounded backoff',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-trusted-unsent',prompt:'hello'});
  const task=store.row(db,'events-trusted-unsent');
  startRuntime(db,'worker-trusted-unsent');
  const unsent=snapshotFor(task,{status:'failed',revision:2,url:null,confirmed:false,send_state:'not_sent',error:{code:'NOT_SENT',message:'发送前失败'}});
  const transport=new FakeTransport({execute:()=>unsent});
  const before=Date.now();
  await runOnce(db,transport,'worker-trusted-unsent');
  const final=store.row(db,'events-trusted-unsent');
  assert.equal(final.status,'retry_wait');
  assert.equal(final.error_code,'NOT_SENT');
  assert.equal(final.send_intent,0);
  assert.equal(final.next_op,'send');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.syncCalls.length,0);
  assert.equal(transport.subscriptions.length,0);
 }finally{db.close();}
});

test('a trusted CHAT_NOT_READY snapshot from a fresh send clears intent and retries send within the bounded backoff',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-chat-not-ready',prompt:'hello'});
  const task=store.row(db,'events-chat-not-ready');
  startRuntime(db,'worker-chat-not-ready');
  const notReady=snapshotFor(task,{status:'needs_user_action',revision:1,url:null,confirmed:false,send_state:'not_sent',error:{code:'CHAT_NOT_READY',message:'Gemini 聊天输入区未就绪'}});
  assert.equal(unsentProof(notReady,{...task,send_intent:1},notReady.result),true);
  const transport=new FakeTransport({execute:()=>notReady});
  const before=Date.now();
  await runOnce(db,transport,'worker-chat-not-ready');
  const final=store.row(db,'events-chat-not-ready');
  assert.equal(final.status,'retry_wait');
  assert.equal(final.error_code,'NOT_SENT');
  assert.equal(final.send_intent,0);
  assert.equal(final.next_op,'send');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.syncCalls.length,0);
  assert.equal(transport.subscriptions.length,0);
  assert.equal(store.runtime(db).connection,'connected');
 }finally{db.close();}
});

test('a CHAT_NOT_READY snapshot discovered through sync resumes the send queue instead of pausing it',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-chat-sync',prompt:'hello'});
  const task=store.row(db,'events-chat-sync');
  startRuntime(db,'worker-chat-sync');
  const notReady=snapshotFor(task,{status:'needs_user_action',revision:2,url:null,confirmed:false,send_state:'not_sent',error:{code:'CHAT_NOT_READY',message:'Gemini 聊天输入区未就绪'}});
  const transport=new FakeTransport({
   execute:()=>{throw Object.assign(Error('execute reply lost'),{code:'DESKTOP_RPC_TIMEOUT'});},
   synchronize:()=>({instance_id:'epoch-chat-sync',seq:1,snapshots:[notReady]})
  });
  const before=Date.now();
  await runOnce(db,transport,'worker-chat-sync');
  let final=store.row(db,'events-chat-sync');
  assert.equal(final.status,'retry_wait');
  assert.equal(final.error_code,'NOT_SENT');
  assert.equal(final.send_intent,0);
  assert.equal(final.next_op,'send');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.syncCalls.length,1);
  assert.equal(transport.subscriptions.length,0);
  assert.equal(store.runtime(db).connection,'connected');
  store.update(db,'events-chat-sync',{next_attempt:0});
  startRuntime(db,'worker-chat-sync-2');
  const generating=snapshotFor(task,{status:'generating',revision:3,url:'https://gemini.google.com/app/chat-sync'});
  const resumed=new FakeTransport({
   execute:()=>generating,
   synchronize:()=>({instance_id:'epoch-chat-sync-2',seq:0,snapshots:[generating]})
  });
  resumed._stream=async subscription=>{
   await delay(5);
   await subscription.emit({type:'task',data:taskEvent('epoch-chat-sync-2',task,taskEventOptions({seq:1,revision:4,status:'completed',answer:'resumed answer',url:'https://gemini.google.com/app/chat-sync'}))});
  };
  await runOnce(db,resumed,'worker-chat-sync-2');
  final=store.row(db,'events-chat-sync');
  assert.equal(final.status,'completed');
  assert.equal(final.result.answer,'resumed answer');
  assert.equal(resumed.executeCalls.length,1);
 }finally{db.close();}
});

test('a stuck CHAT_NOT_READY intent becomes a bounded send retry after a successful probe',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-chat-probe',prompt:'hello'});
  const task=store.row(db,'events-chat-probe');
  store.update(db,'events-chat-probe',{status:'needs_user_action',next_op:'snapshot',next_attempt:null,send_intent:1,error:'Gemini 聊天输入区未就绪',error_code:'CHAT_NOT_READY',result:{answer:'',url:null,model:null,submission_confirmed:false,submission_known:true,marker:task.marker,beforeResponses:null}});
  startRuntime(db,'worker-chat-probe');
  store.setConnection(db,'worker-chat-probe','needs_user_action');
  const probe=store.probe(db);
  const notReady=snapshotFor(task,{status:'needs_user_action',revision:2,url:null,confirmed:false,send_state:'not_sent',error:{code:'CHAT_NOT_READY',message:'Gemini 聊天输入区未就绪'}});
  const transport=new FakeTransport({synchronize:()=>({instance_id:'epoch-chat-probe',seq:1,snapshots:[notReady]})});
  await runOnce(db,transport,'worker-chat-probe');
  assert.equal(store.row(db,probe.task_id).status,'completed');
  assert.equal(store.row(db,'events-chat-probe').status,'queued');
  startRuntime(db,'worker-chat-probe-2');
  await runOnce(db,transport,'worker-chat-probe-2');
  const final=store.row(db,'events-chat-probe');
  assert.equal(final.status,'retry_wait');
  assert.equal(final.error_code,'NOT_SENT');
  assert.equal(final.send_intent,0);
  assert.equal(final.next_op,'send');
  assert.equal(transport.executeCalls.length,0);
  assert.equal(store.runtime(db).connection,'connected');
 }finally{db.close();}
});

test('a CHAT_NOT_READY code without full snapshot proof never clears intent or resends',async()=>{
 const db=store.open();
 try{
  for(const [taskId,options] of [['events-chat-uncertain',{send_state:'uncertain'}],['events-chat-known-false',{send_state:'not_sent',known:false}],['events-chat-confirmed',{send_state:'not_sent',confirmed:true}]]){
   clean(db);
   store.submit(db,{task_id:taskId,prompt:'hello'});
   const task=store.row(db,taskId);
   startRuntime(db,`worker-${taskId}`);
   const snapshot=snapshotFor(task,{status:'needs_user_action',revision:2,url:null,confirmed:options.confirmed===true,send_state:options.send_state,error:{code:'CHAT_NOT_READY',message:'Gemini 聊天输入区未就绪'}});
   if(options.known===false)snapshot.result.submission_known=false;
   const transport=new FakeTransport({execute:()=>snapshot});
   await runOnce(db,transport,`worker-${taskId}`);
   const final=store.row(db,taskId);
   assert.equal(final.status,'needs_user_action',taskId);
   const expectIntent=options.send_state==='uncertain'||options.confirmed===true;
   assert.equal(final.send_intent,expectIntent?1:0,taskId);
   assert.notEqual(final.next_op,'send',taskId);
   assert.equal(transport.executeCalls.length,1,taskId);
   assert.equal(transport.syncCalls.length,0,taskId);
   assert.equal(transport.subscriptions.length,0,taskId);
  }
 }finally{db.close();}
});

test('an unknown send state keeps intent and only schedules a snapshot',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-unknown-send',prompt:'hello'});
  const task=store.row(db,'events-unknown-send');
  startRuntime(db,'worker-unknown-send');
  const unknown=snapshotFor(task,{status:'uncertain',revision:3,url:null,confirmed:false,send_state:'uncertain',error:{code:'SEND_STATE_UNKNOWN',message:'发送状态未知'}});
  const transport=new FakeTransport({execute:()=>unknown});
  const before=Date.now();
  await runOnce(db,transport,'worker-unknown-send');
  const final=store.row(db,'events-unknown-send');
  assert.equal(final.status,'uncertain');
  assert.equal(final.send_intent,1);
  assert.equal(final.next_op,'snapshot');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.snapshotCalls.length,0);
  assert.equal(transport.recoverCalls.length,0);
  assert.equal(transport.syncCalls.length,0);
 }finally{db.close();}
});

test('a confirmed snapshot is never converted into a new send',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-confirmed-fault',prompt:'hello'});
  const task=store.row(db,'events-confirmed-fault');
  startRuntime(db,'worker-confirmed-fault');
  const failed=snapshotFor(task,{status:'failed',revision:2,url:null,confirmed:true,send_state:'confirmed',error:{code:'NETWORK_TRANSIENT',message:'connection lost after send'}});
  const transport=new FakeTransport({execute:()=>failed});
  const before=Date.now();
  await runOnce(db,transport,'worker-confirmed-fault');
  const final=store.row(db,'events-confirmed-fault');
  assert.equal(final.status,'retry_wait');
  assert.equal(final.send_intent,1);
  assert.equal(final.next_op,'snapshot');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.syncCalls.length,0);
  assert.equal(transport.subscriptions.length,0);
 }finally{db.close();}
});

test('a lost execute reply is never converted into a new send',async()=>{
 const db=store.open();clean(db);
 try{
  store.submit(db,{task_id:'events-lost-send',prompt:'hello'});
  const task=store.row(db,'events-lost-send');
  startRuntime(db,'worker-lost-send');
  const generating=snapshotFor(task,{status:'generating',revision:1,url:'https://gemini.google.com/app/lost-send'});
  const transport=new FakeTransport({
   execute:()=>{throw Object.assign(Error('execute reply lost'),{code:'DESKTOP_RPC_TIMEOUT'});},
   synchronize:()=>({instance_id:'epoch-lost-send',seq:0,snapshots:[generating]})
  });
  transport._stream=subscription=>{setTimeout(()=>subscription.drop(Object.assign(Error('network down'),{code:'NETWORK_TRANSIENT'})),5);};
  const before=Date.now();
  await runOnce(db,transport,'worker-lost-send');
  const final=store.row(db,'events-lost-send');
  assert.equal(final.status,'uncertain');
  assert.equal(final.send_intent,1);
  assert.equal(final.next_op,'recover');
  assert.equal(final.attempts,1);
  assert.ok(final.next_attempt>=before+60000,`next_attempt=${final.next_attempt}`);
  assert.equal(transport.executeCalls.length,1);
  assert.equal(transport.snapshotCalls.length,0);
 }finally{db.close();}
});
