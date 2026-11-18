const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
process.env.GEMINI_WORK_STATE=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-worker-state-'));
const store=require('../src/store.cjs');
const {runWorker}=require('../src/worker.cjs');
const {DesktopTransport:RealDesktopTransport,DesktopError,READY_TIMEOUT_MS,validateWire}=require('../src/desktop-transport.cjs');
class DesktopTransport extends RealDesktopTransport{constructor(options){super({...options,installationVerifier:async()=>({exists:true,versionMatches:true,patch:{ready:true}})});}}

function readBody(request){return new Promise((resolve,reject)=>{const chunks=[];request.on('data',c=>chunks.push(c));request.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch(e){reject(e);}});request.on('error',reject);});}
function send(response,status,value){const body=Buffer.from(JSON.stringify(value));response.writeHead(status,{'Content-Type':'application/json','Content-Length':body.length});response.end(body);}
function discoveryFile(state,{port,token,protocol=2,appVersion='1.16.0',bridgeVersion='test-bridge-2',pid=process.pid}={}){
 const target=path.join(state,'discovery.json'),temporary=target+'.tmp';
 fs.writeFileSync(temporary,JSON.stringify({protocol,port,token,pid,appVersion,bridgeVersion,userDataPath:path.join(state,'userdata'),runtimeVersions:{node:process.versions.node}}));
 fs.renameSync(temporary,target);
}
async function bridge(t,state){
 return new Promise((resolve,reject)=>{const server=http.createServer(async(request,response)=>{const body=await readBody(request).catch(()=>null);t.calls.push({headers:request.headers,body,url:request.url});try{await t.handler({request,response,body,port:server.address().port});}catch(e){if(!response.headersSent)send(response,500,{ok:false,error:{code:'TEST_ERROR',message:e.message}});}});server.on('error',reject);server.listen(0,'127.0.0.1',()=>resolve({server,port:server.address().port}));});
}
function close(server){return new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections?.();});}
function startRuntime(db,workerToken){
 db.prepare('DELETE FROM runtime').run();
 const supervisor=store.claimSupervisor(db,{token:`sup-${workerToken}`,pid:process.pid});
 assert.equal(supervisor.ok,true);
 const worker=store.startWorker(db,{supervisorToken:`sup-${workerToken}`,workerToken,pid:process.pid});
 assert.equal(worker.ok,true);
}
function clean(db){db.exec('DELETE FROM tasks; DELETE FROM runtime;');db.prepare("DELETE FROM meta WHERE key='desktop_event_cursor'").run();fs.rmSync(path.join(store.STATE,'stop-worker'),{force:true});}
function fullTask(overrides={}){
 return {id:'task-1',marker:'[gemini-work:abc12345]',prompt:'[gemini-work:abc]\nhello',purpose:'work',model:'flash',conversation_url:null,timeoutMs:180000,attachments:[{name:'a.txt',mime:'text/plain',base64:Buffer.from('hello').toString('base64')}],...overrides};
}
async function runOnce(db,transport,workerToken){
 return runWorker({db,transport,token:workerToken,once:true,pollMs:5,sleep:async()=>{},waitForOwnershipMs:100});
}

function v2Context(){
 return {calls:[],snapshots:new Map(),journal:[],clients:new Set(),instanceId:'instance-v2',seq:0,token:'v2-token-1234567890',execute:null,onStream:null,readOnly:false,counts:{execute:0,snapshot:0,recover:0,release:0,sync:0,events:0}};
}
function v2Snapshot({task_id,marker,status='generating',revision=1,answer='',url=null,confirmed=true,send_state='confirmed',metadata={},error=null}){
 return {task_id,status,phase:status,revision,send_state,metadata,budget_exhausted:metadata.budget_exhausted===true,
  result:{answer,url,model:'flash',submission_confirmed:confirmed,submission_known:send_state!=='uncertain',marker,beforeResponses:0},
  error:error?{code:error.code||'ERROR',message:error.message||''}:null};
}
function sseSend(response,event,kind='task'){
 const frame=`id: ${event.instance_id}:${event.seq}\nevent: ${kind}\ndata: ${JSON.stringify(event)}\n\n`;
 try{response.write(frame);}catch{}
}
function parseCursor(request){
 const raw=request.headers['last-event-id'];
 if(typeof raw!=='string')return null;
 const index=raw.lastIndexOf(':');
 const seq=Number(raw.slice(index+1));
 if(index<1||!Number.isSafeInteger(seq)||seq<0)return null;
 return {instance_id:raw.slice(0,index),seq};
}
function attachV2Stream(request,response,context){
 response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
 try{response.write(': connected\n\n');}catch{}
 context.clients.add(response);
 request.on('close',()=>context.clients.delete(response));
 const cursor=parseCursor(request);
 if(cursor){
  if(cursor.instance_id!==context.instanceId)sseSend(response,{instance_id:context.instanceId,seq:context.seq},'reset');
  else for(const event of context.journal)if(event.seq>cursor.seq)sseSend(response,event);
 }
 if(context.onStream)context.onStream(context);
}
function publishV2(context,taskId,snapshot){
 context.seq+=1;
 const event={instance_id:context.instanceId,seq:context.seq,type:'snapshot',task_id:taskId,revision:snapshot.revision,snapshot};
 context.snapshots.set(taskId,snapshot);
 context.journal.push(event);
 for(const response of context.clients)sseSend(response,event);
 return event;
}
function v2Handler(context){
 return ({request,response,body})=>{
  if(request.url==='/events'){
   context.counts.events++;
   attachV2Stream(request,response,context);
   return;
  }
  if(request.url!=='/rpc')return send(response,404,{ok:false,error:{code:'NOT_FOUND',message:'not found'}});
  if(body.op==='probe')return send(response,200,{ok:true,data:{connected:true,pageReady:true,readOnly:!!context.readOnly,bridgeVersion:'test-bridge-2'}});
  if(body.op==='ready')return send(response,200,{ok:true,data:{connected:true,page:{usable:true,fault:null},warming:false,readOnly:!!context.readOnly,bridgeVersion:'test-bridge-2'}});
  if(body.op==='sync'){context.counts.sync++;return send(response,200,{ok:true,data:{instance_id:context.instanceId,seq:context.seq,snapshots:[...context.snapshots.values()]}});}
  if(body.op==='execute'){context.counts.execute++;if(!context.execute)return send(response,200,{ok:false,error:{code:'SHOULD_NOT_EXECUTE',message:'execute not expected'}});return context.execute(body.task,response,request,context);}
  if(body.op==='snapshot'){context.counts.snapshot++;return send(response,200,{ok:false,error:{code:'SHOULD_NOT_SNAPSHOT',message:'snapshot polling is not expected'}});}
  if(body.op==='recover'){context.counts.recover++;return send(response,200,{ok:false,error:{code:'SHOULD_NOT_RECOVER',message:'recover not expected'}});}
  if(body.op==='release'){context.counts.release++;return send(response,200,{ok:true,data:{released:true}});}
  return send(response,200,{ok:false,error:{code:'UNEXPECTED_OP',message:body.op}});
 };
}
async function startV2Bridge(context){
 context.handler=v2Handler(context);
 const value=await bridge(context,store.STATE);
 context.server=value.server;context.port=value.port;
 discoveryFile(store.STATE,{port:value.port,token:context.token});
 return value;
}

test('worker consumes v2 SSE events once without polling snapshots',async()=>{
 const db=store.open();clean(db);
 const context=v2Context();
 const {server}=await startV2Bridge(context);
 try{
  store.submit(db,{task_id:'worker-v2-sse',prompt:'x'});
  const task=store.row(db,'worker-v2-sse');
  const generating=v2Snapshot({task_id:task.id,marker:task.marker,status:'generating',revision:1,url:'https://gemini.google.com/app/v2sse'});
  context.execute=(wire,response,request,ctx)=>{
   ctx.snapshots.set(task.id,generating);
   send(response,200,{ok:true,data:generating});
  };
  context.onStream=()=>{setTimeout(()=>{const completed=v2Snapshot({task_id:task.id,marker:task.marker,status:'completed',revision:2,answer:'v2 streamed answer',url:'https://gemini.google.com/app/v2sse'});publishV2(context,task.id,completed);},10);};
  startRuntime(db,'w-v2-sse');
  const transport=new DesktopTransport({stateDir:store.STATE,autoStart:false,timeoutMs:1000});
  await runOnce(db,transport,'w-v2-sse');
  const final=store.row(db,'worker-v2-sse');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'v2 streamed answer');
  assert.equal(context.counts.execute,1);assert.equal(context.counts.snapshot,0);
  assert.equal(context.counts.release,1);assert.equal(context.counts.events,1);
  assert.match(fs.readFileSync(store.resultPath('worker-v2-sse'),'utf8'),/v2 streamed answer/);
 }finally{await close(server);db.close();}
});

test('lost execute reply recovers through sync and SSE without a second execute',async()=>{
 const db=store.open();clean(db);
 const context=v2Context();
 const {server}=await startV2Bridge(context);
 try{
  store.submit(db,{task_id:'worker-v2-lost',prompt:'x'});
  const task=store.row(db,'worker-v2-lost');
  const generating=v2Snapshot({task_id:task.id,marker:task.marker,status:'generating',revision:1,url:'https://gemini.google.com/app/v2lost'});
  context.execute=(wire,response,request,ctx)=>{
   ctx.snapshots.set(task.id,generating);
   request.socket.destroy();
  };
  context.onStream=()=>{setTimeout(()=>{const completed=v2Snapshot({task_id:task.id,marker:task.marker,status:'completed',revision:2,answer:'recovered from sync',url:'https://gemini.google.com/app/v2lost'});publishV2(context,task.id,completed);},10);};
  startRuntime(db,'w-v2-lost');
  const transport=new DesktopTransport({stateDir:store.STATE,autoStart:false,timeoutMs:500});
  await runOnce(db,transport,'w-v2-lost');
  const final=store.row(db,'worker-v2-lost');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'recovered from sync');
  assert.equal(context.counts.execute,1);assert.equal(context.counts.snapshot,0);
 }finally{await close(server);db.close();}
});

test('a replacement worker binds the existing task and reads completion without executing',async()=>{
 const db=store.open();clean(db);
 const context=v2Context();
 const {server}=await startV2Bridge(context);
 try{
  store.submit(db,{task_id:'worker-v2-rebind',prompt:'x'});
  const task=store.row(db,'worker-v2-rebind');
  context.snapshots.set(task.id,v2Snapshot({task_id:task.id,marker:task.marker,status:'completed',revision:5,answer:'already sent',url:'https://gemini.google.com/app/v2rebind'}));
  startRuntime(db,'w-v2-old');
  db.prepare("UPDATE tasks SET status='connecting',worker='w-v2-old' WHERE id=?").run(task.id);
  assert.equal(store.markSubmitting(db,task.id,'w-v2-old'),true);
  db.prepare('UPDATE runtime SET worker_token=NULL,worker_pid=NULL,worker_heartbeat=NULL').run();
  const replacement=store.startWorker(db,{supervisorToken:'sup-w-v2-old',workerToken:'w-v2-new',pid:process.pid});
  assert.equal(replacement.ok,true);
  assert.equal(store.row(db,task.id).status,'uncertain');
  const transport=new DesktopTransport({stateDir:store.STATE,autoStart:false,timeoutMs:1000});
  await runOnce(db,transport,'w-v2-new');
  const final=store.row(db,'worker-v2-rebind');
  assert.equal(final.status,'completed');assert.equal(final.result.answer,'already sent');
  assert.equal(context.counts.execute,0);assert.equal(context.counts.snapshot,0);
  assert.equal(context.counts.release,1);
 }finally{await close(server);db.close();}
});

test('read-only probe pauses the v2 queue without event or execute attempts',async()=>{
 const db=store.open();clean(db);
 const context=v2Context();context.readOnly=true;
 const {server}=await startV2Bridge(context);
 try{
  store.submit(db,{task_id:'worker-v2-readonly',prompt:'x'});
  startRuntime(db,'w-v2-readonly');
  const transport=new DesktopTransport({stateDir:store.STATE,autoStart:false,timeoutMs:1000});
  await runOnce(db,transport,'w-v2-readonly');
  const final=store.row(db,'worker-v2-readonly');
  assert.equal(final.status,'needs_user_action');assert.equal(final.error_code,'BRIDGE_READ_ONLY');
  assert.equal(final.send_intent,0);
  assert.equal(context.counts.execute,0);assert.equal(context.counts.events,0);
  assert.equal(store.runtime(db).connection,'needs_user_action');
 }finally{await close(server);db.close();}
});

test('desktop RPC uses loopback auth headers, never sends Origin, and keeps tokens out of errors',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-rpc-'));
 const token='test-token-1234567890';const calls=[];
 const context={calls,handler:({request,response})=>{
  assert.equal(request.url,'/rpc');
  assert.equal(request.headers.host,`127.0.0.1:${context.server.address().port}`);
  assert.equal(request.headers.origin,undefined);
  assert.equal(request.headers['content-type'],'application/json');
  if(request.headers.authorization!==`Bearer ${token}`)return send(response,401,{ok:false,error:{code:'UNAUTHORIZED',message:'bad token'}});
  send(response,200,{ok:true,data:{connected:true,pageReady:true,readOnly:false,bridgeVersion:'test-bridge-1'}});
 }};
 const {server,port}=await bridge(context,state);context.server=server;
 try{
  discoveryFile(state,{port,token});
  const transport=new DesktopTransport({stateDir:state,autoStart:false,timeoutMs:1000});
  const probe=await transport.probe();
  assert.equal(probe.connected,true);assert.equal(probe.transport,'desktop-loopback');
  assert.equal(calls.length,1);assert.equal(calls[0].body.op,'probe');assert.deepEqual(calls[0].body.task,{});
  assert.equal(calls[0].headers.authorization,`Bearer ${token}`);
  const summary=transport.describe();assert.equal(summary.valid,true);assert.equal(summary.app_version,'1.16.0');
  assert.equal(JSON.stringify(summary).includes(token),false);

  const wrongState=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-wrong-'));
  discoveryFile(wrongState,{port,token:'wrong-token-1234567890'});
  const wrong=new DesktopTransport({stateDir:wrongState,autoStart:false,timeoutMs:1000});
  await assert.rejects(()=>wrong.probe(),error=>{
   assert.equal(error.code,'UNAUTHORIZED');
   assert.equal(String(error.message).includes('wrong-token-1234567890'),false);
   assert.equal(String(error.stack).includes('wrong-token-1234567890'),false);
   return true;
  });
 }finally{await close(server);}
});

test('discovery protocol/version/port are validated and invalid files do not leak token',()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-validation-'));
 discoveryFile(state,{port:1,token:'secret-token-1234567890',protocol:1});
 const transport=new DesktopTransport({stateDir:state,autoStart:false});
 assert.throws(()=>transport.discover(),error=>{assert.equal(error.code,'DESKTOP_PROTOCOL_MISMATCH');assert.equal(String(error.message).includes('secret-token-1234567890'),false);return true;});
 discoveryFile(state,{port:1,token:'secret-token-1234567890',appVersion:'1.15.9'});
 assert.throws(()=>new DesktopTransport({stateDir:state,autoStart:false}).discover(),/1\.16\.0/);
 fs.writeFileSync(path.join(state,'discovery.json'),JSON.stringify({protocol:2,port:'nope',token:'secret-token-1234567890',appVersion:'1.16.0'}));
 assert.throws(()=>new DesktopTransport({stateDir:state,autoStart:false}).discover(),error=>error.code==='DESKTOP_DISCOVERY_INVALID');
});

test('RPC timeouts are bounded and a changed discovery file reconnects the request',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-reconnect-'));
 const aCalls=[],bCalls=[];let portB=null;
 const contextA={calls:aCalls,handler:async({request})=>{
  discoveryFile(state,{port:portB,token:'token-b-1234567890',bridgeVersion:'bridge-b'});
  request.socket.destroy();
 }};
 const first=await bridge(contextA,state);contextA.server=first.server;
 const contextB={calls:bCalls,handler:({response})=>send(response,200,{ok:true,data:{connected:true,pageReady:true,readOnly:false,bridgeVersion:'bridge-b'}})};
 const second=await bridge(contextB,state);portB=second.port;
 try{
  const transport=new DesktopTransport({stateDir:state,autoStart:false,timeoutMs:1000});
  discoveryFile(state,{port:first.port,token:'token-a-1234567890',bridgeVersion:'bridge-a'});
  const probe=await transport.probe();
  assert.equal(probe.bridgeVersion,'bridge-b');assert.equal(aCalls.length,1);assert.equal(bCalls.length,1);

  const slowState=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-slow-'));
  const slow={calls:[],handler:async({response})=>{await new Promise(r=>setTimeout(r,300));try{send(response,200,{ok:true,data:{connected:true}});}catch{}}};
  const slowBridge=await bridge(slow,slowState);
  try{
   discoveryFile(slowState,{port:slowBridge.port,token:'slow-token-1234567890'});
   const slowTransport=new DesktopTransport({stateDir:slowState,autoStart:false,timeoutMs:80});
   const started=Date.now();
   await assert.rejects(()=>slowTransport.probe(),error=>error.code==='DESKTOP_RPC_TIMEOUT');
   assert.ok(Date.now()-started<1000);
  }finally{await close(slowBridge.server);}
 }finally{await close(first.server);await close(second.server);}
});

test('execute is typed, idempotent for equal content, and conflicts are rejected by the bridge ledger',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-execute-'));
 const ledger=new Map(),calls=[];
 const context={calls,handler:({response,body})=>{
  if(body.op==='execute'){
   const wire=body.task,serialized=JSON.stringify(wire);
   if(ledger.has(wire.id)&&ledger.get(wire.id)!==serialized)return send(response,200,{ok:false,error:{code:'TASK_CONFLICT',message:'same id different content'}});
   ledger.set(wire.id,serialized);
   return send(response,200,{ok:true,data:{task_id:wire.id,status:'submitting',result:{answer:'',url:null,model:'flash',submission_confirmed:false,submission_known:true,marker:wire.marker,beforeResponses:0},error:null}});
  }
  if(body.op==='snapshot')return send(response,200,{ok:true,data:{task_id:body.task_id,status:'completed',result:{answer:'done',url:'https://gemini.google.com/app/done',model:'flash',submission_confirmed:true,submission_known:true,marker:'marker',beforeResponses:0},error:null}});
  if(body.op==='release')return send(response,200,{ok:true,data:{released:true}});
  return send(response,200,{ok:false,error:{code:'UNEXPECTED_OP',message:body.op}});
 }};
 const {server,port}=await bridge(context,state);
 try{
  discoveryFile(state,{port,token:'execute-token-1234567890'});
  const transport=new DesktopTransport({stateDir:state,autoStart:false,timeoutMs:1000});
  const task=fullTask();
  const first=await transport.execute(task);
  assert.equal(first.status,'submitting');assert.equal(first.result.submission_known,true);
  await transport.execute(task);
  await assert.rejects(()=>transport.execute(fullTask({prompt:'different'})),error=>error.code==='TASK_CONFLICT');
  assert.equal(calls.filter(call=>call.body.op==='execute').length,3);
  assert.equal(calls[0].body.task.attachments[0].mime,'text/plain');
  assert.equal(calls[0].body.task.attachments[0].name,'a.txt');
  const snapshot=await transport.snapshot('task-1');
  assert.equal(snapshot.status,'completed');assert.equal(snapshot.result.answer,'done');
  await transport.release('task-1');
  assert.equal(calls.at(-1).body.op,'release');assert.equal(calls.at(-1).body.task_id,'task-1');
  await assert.rejects(()=>transport.execute(fullTask({id:'../escape'})),error=>error.code==='DESKTOP_TASK_INVALID');
  await assert.rejects(()=>transport.execute(fullTask({attachments:[{name:'a.exe',mime:'text/plain',base64:'AA=='}]})),/txt|TXT/);
  await assert.rejects(()=>transport.execute(fullTask({attachments:[{name:'a.txt',mime:'image/png',base64:'AA=='}]})),/text\/plain/);
  await assert.rejects(()=>transport.execute(fullTask({conversation_url:'https://accounts.google.com/'})),/Gemini/);
  assert.equal(calls.filter(call=>call.body.op==='execute').length,3);
 }finally{await close(server);}
});

test('transport accepts bounded dynamic model selectors and defaults to Hydrogen',()=>{
 assert.equal(validateWire(fullTask({model:'Test Nova'})).model,'Test Nova');
 assert.equal(validateWire(fullTask({model:undefined})).model,'hydrogen');
 assert.equal(validateWire(fullTask({model:'mode-test-nova'})).model,'mode-test-nova');
 for(const bad of ['', '   ', 'x'.repeat(81), 'bad\nmodel', 42]){
  assert.throws(()=>validateWire(fullTask({model:bad})),/model/i,String(bad));
 }
});

test('snapshot responses are normalized but unknown statuses are never accepted',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-status-'));
 let status='completed';
 const context={calls:[],handler:({response})=>send(response,200,{ok:true,data:{task_id:'status-task',status,result:{answer:'x',url:null,model:'flash',submission_confirmed:true,marker:'m',beforeResponses:2},error:null}})};
 const {server,port}=await bridge(context,state);
 try{
  discoveryFile(state,{port,token:'status-token-1234567890'});
  const transport=new DesktopTransport({stateDir:state,autoStart:false,timeoutMs:1000});
  const snapshot=await transport.snapshot('status-task');
  assert.equal(snapshot.result.submission_known,true);assert.equal(snapshot.result.beforeResponses,2);
  status='mystery';
  await assert.rejects(()=>transport.snapshot('status-task'),/未知任务状态/);
  status='completed';
  await assert.rejects(()=>transport.snapshot('different-id'),/不匹配/);
 }finally{await close(server);}
});

test('changed installation blocks all RPC even when a bridge is already reachable',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-hash-lock-'));let posts=0;
 const transport=new RealDesktopTransport({stateDir:state,autoStart:false,installationVerifier:async()=>({exists:true,versionMatches:true,patch:{ready:false,message:'hash changed'}})});
 transport.post=async()=>{posts++;return {connected:true};};
 await assert.rejects(()=>transport.execute(fullTask()),error=>error.code==='DESKTOP_INSTALLATION_CHANGED');
 await assert.rejects(()=>transport.awaitReady(),error=>error.code==='DESKTOP_INSTALLATION_CHANGED');
 const ready=await transport.ensureRunning();assert.equal(ready.running,false);assert.equal(posts,0);
});

test('awaitReady issues one bounded ready RPC and normalizes warming, read-only and fault state',async()=>{
 assert.ok(READY_TIMEOUT_MS>15000,'ready RPC timeout must exceed the 15s server wait');
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-ready-'));
 const calls=[];
 let data={connected:false,read_only:true,warming:true,page:null,error:{code:'BRIDGE_PAGE_NOT_READY',message:'warming'}};
 const context={calls,handler:({response})=>send(response,200,{ok:true,data})};
 const {server,port}=await bridge(context,state);
 try{
  discoveryFile(state,{port,token:'ready-token-1234567890'});
  const transport=new DesktopTransport({stateDir:state,autoStart:false,timeoutMs:1000});
  const warming=await transport.awaitReady({timeoutMs:500});
  assert.deepEqual(calls.map(call=>call.body.op),['ready']);
  assert.equal(warming.warming,true);assert.equal(warming.pageReady,false);assert.equal(warming.readOnly,true);
  assert.equal(warming.error.code,'BRIDGE_PAGE_NOT_READY');
  data={connected:true,warming:false,page:{usable:true,fault:'LOGIN_REQUIRED'},error:{code:'LOGIN_REQUIRED',message:'login'}};
  const login=await transport.awaitReady({timeoutMs:500});
  assert.deepEqual(calls.map(call=>call.body.op),['ready','ready']);
  assert.equal(login.warming,false);assert.equal(login.pageReady,false);assert.equal(login.readOnly,false);
  assert.equal(login.page.fault,'LOGIN_REQUIRED');
 }finally{await close(server);}
});

test('ensureRunning retries a start-racing existing bridge without relaunching the client',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-starting-'));
 discoveryFile(state,{port:1,token:'starting-token-1234567890',pid:process.pid});
 let clock=0,probes=0,sleeps=0;
 const transport=new RealDesktopTransport({stateDir:state,autoStart:false,installationVerifier:async()=>({exists:true,versionMatches:true,patch:{ready:true}}),now:()=>clock,sleep:async ms=>{sleeps+=1;clock+=ms;}});
 transport.probe=async()=>{
  probes+=1;
  if(probes===1)throw new DesktopError('DESKTOP_DISCOVERY_MISSING','bridge discovery not written yet');
  if(probes===2)throw new DesktopError('DESKTOP_RPC_REFUSED','bridge still starting');
  return {connected:true,pageReady:true,readOnly:false};
 };
 const result=await transport.ensureRunning({timeoutMs:1000,startTimeoutMs:3000});
 assert.equal(result.running,true);
 assert.equal(result.launched,undefined);
 assert.equal(probes,3);assert.equal(sleeps,2);assert.ok(clock<=3000);
});

test('ensureRunning stops retrying a live process after the bounded start timeout',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-exhausted-'));
 discoveryFile(state,{port:1,token:'exhausted-token-1234567890',pid:process.pid});
 let clock=0,probes=0;
 const transport=new RealDesktopTransport({stateDir:state,autoStart:false,installationVerifier:async()=>({exists:true,versionMatches:true,patch:{ready:true}}),now:()=>clock,sleep:async ms=>{clock+=ms;}});
 transport.probe=async()=>{probes+=1;throw new DesktopError('DESKTOP_RPC_REFUSED','bridge still starting');};
 const result=await transport.ensureRunning({timeoutMs:1000,startTimeoutMs:3000});
 assert.equal(result.running,false);
 assert.equal(result.code,'DESKTOP_RESTART_REQUIRED');
 assert.ok(probes>1);
 assert.equal(clock,3000);
});

test('ensureRunning does not retry protocol, hash or auth rejection',async()=>{
 for(const code of ['DESKTOP_PROTOCOL_MISMATCH','DESKTOP_APP_VERSION_MISMATCH','DESKTOP_PATCH_HANDSHAKE_MISMATCH','DESKTOP_INSTALLATION_CHANGED','UNAUTHORIZED']){
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-rejected-'));
  discoveryFile(state,{port:1,token:'rejected-token-1234567890',pid:process.pid});
  let probes=0,sleeps=0;
  const transport=new RealDesktopTransport({stateDir:state,autoStart:false,installationVerifier:async()=>({exists:true,versionMatches:true,patch:{ready:true}}),now:()=>0,sleep:async()=>{sleeps+=1;}});
  transport.probe=async()=>{probes+=1;throw new DesktopError(code,'rejected');};
  const result=await transport.ensureRunning({timeoutMs:500,startTimeoutMs:3000});
  assert.equal(result.running,false,code);
  assert.equal(result.code,code,code);
  assert.equal(probes,1,code);assert.equal(sleeps,0,code);
 }
});

test('capabilities is argument-free, normalized, and re-reads discovery for every call',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-desktop-capabilities-'));
 const seen=[];
 const first={calls:[],handler:null};
 first.handler=({request,response,body,port})=>{
  seen.push({port,body,authorization:request.headers.authorization});
  send(response,200,{ok:true,data:{
   status:'ready',observed:true,observed_at:'2026-11-18T00:00:00.000Z',source:'observed_menu',reason:null,
   models:[{id:'mode-hydrogen',name:'日常帮助 4 Hydrogen',selector:'mode-hydrogen',selected:true,disabled:false,restricted:false,available:true,unavailable_reason:null}],
   modes:{current:'chat',supported:['chat','task'],source:'contract',immutable_after_start:true},
   thinking:{status:'observed',levels:[{level:'high',label:'高',selected:true,disabled:false}]},
   default_model:'hydrogen'
  }});
 };
 const a=await bridge(first,state);
 discoveryFile(state,{port:a.port,token:'cap-token-1234567890'});
 const transport=new DesktopTransport({stateDir:state});
 const catalog=await transport.capabilities();
 assert.equal(first.calls.length,1);
 assert.equal(first.calls[0].body.op,'capabilities');
 assert.equal(first.calls[0].body.task,undefined);
 assert.equal(first.calls[0].body.task_id,undefined);
 assert.equal(first.calls[0].headers.authorization,'Bearer cap-token-1234567890');
 assert.equal(catalog.status,'ready');
 assert.equal(catalog.default_model,'hydrogen');
 assert.equal(catalog.models.length,1);
 assert.equal(catalog.models[0].selector,'mode-hydrogen');
 assert.equal(catalog.models[0].available,true);
 assert.deepEqual(catalog.modes,{current:'chat',supported:['chat','task'],source:'contract',immutable_after_start:true});
 assert.deepEqual(catalog.thinking,{status:'observed',levels:[{level:'high',label:'高',selected:true,disabled:false}]});
 const b=await bridge({calls:[],handler:({request,response,body,port})=>{
  seen.push({port,body,authorization:request.headers.authorization});
  send(response,200,{ok:true,data:{status:'busy',observed:false,observed_at:null,source:'policy',reason:'task_active',models:[{id:'stale',name:'stale',selector:'stale'}],modes:{current:'task'},thinking:{status:'observed',levels:[{level:'high',label:'高'}]},default_model:'hydrogen'}});
 }},state);
 discoveryFile(state,{port:b.port,token:'cap-token-0987654321'});
 const busy=await transport.capabilities();
 assert.equal(seen.length,2,'the second call must re-read discovery instead of reusing the old port');
 assert.equal(seen[1].port,b.port);
 assert.equal(seen[1].authorization,'Bearer cap-token-0987654321');
 assert.equal(busy.status,'busy');
 assert.equal(busy.reason,'task_active');
 assert.deepEqual(busy.models,[],'a non-ready catalog must not echo stale options');
 assert.deepEqual(busy.thinking,{status:'unknown',levels:[]});
 await close(a.server);await close(b.server);
 assert.equal(transport._discovery.port,b.port);
});

test('capabilities normalization rejects truncated, malformed or unobserved ready payloads',()=>{
 const {normalizeCapabilities}=require('../src/desktop-transport.cjs');
 const model=(index=0,over={})=>({id:`mode-${index}`,name:`Model ${index}`,selector:`mode-${index}`,selected:false,disabled:false,restricted:false,available:true,unavailable_reason:null,...over});
 const ready=over=>({status:'ready',observed:true,observed_at:'2026-11-18T00:00:00.000Z',source:'observed_menu',reason:null,models:[model()],modes:{current:'chat'},thinking:{status:'observed',levels:[{level:'high',label:'高',selected:true,disabled:false}]},default_model:'hydrogen',...over});
 const forty=Array.from({length:40},(_,index)=>model(index));
 const accepted=normalizeCapabilities(ready({models:forty}));
 assert.equal(accepted.status,'ready');
 assert.equal(accepted.models.length,40,'exactly 40 observed models are kept in full');
 assert.equal(accepted.models[39].name,'Model 39');
 assert.deepEqual(normalizeCapabilities(ready()).thinking,{status:'observed',levels:[{level:'high',label:'高',selected:true,disabled:false}]});
 for(const [label,payload] of [
  ['41 models',ready({models:[...forty,model(40)]})],
  ['no models',ready({models:[]})],
  ['non-object model',ready({models:[model(),null]})],
  ['empty model name',ready({models:[model(0,{name:''})]})],
  ['81-char selector',ready({models:[model(0,{selector:'x'.repeat(81)})]})],
  ['control char in selector',ready({models:[model(0,{selector:'mode\u0007'})]})],
  ['observed false on ready',ready({observed:false})],
  ['invalid observed_at',ready({observed_at:'not-a-time'})],
  ['missing observed_at',ready({observed_at:null})],
  ['wrong ready source',ready({source:'observation'})],
  ['unknown thinking with invented levels',ready({thinking:{status:'unknown',levels:[{level:'high',label:'高'}]}})],
  ['41 thinking levels',ready({thinking:{status:'observed',levels:Array.from({length:41},()=>({level:'high',label:'高'}))}})],
  ['empty thinking levels',ready({thinking:{status:'observed',levels:[]}})],
  ['non-object thinking level',ready({thinking:{status:'observed',levels:[null]}})],
  ['empty thinking label',ready({thinking:{status:'observed',levels:[{level:'high',label:''}]}})],
  ['not_exposed with levels',ready({thinking:{status:'not_exposed',levels:[{level:'high',label:'高'}]}})],
  ['non-boolean observed flag',ready({observed:'yes'})]
 ]){
  assert.throws(()=>normalizeCapabilities(payload),error=>error.code==='DESKTOP_PROTOCOL_INVALID',label);
 }
 const spaced=' 保留  selector  ';
 assert.equal(normalizeCapabilities(ready({models:[model(0,{selector:spaced})]})).models[0].selector,spaced,'selectors are never transformed');
 const eighty='s'.repeat(80);
 assert.equal(normalizeCapabilities(ready({models:[model(0,{selector:eighty})]})).models[0].selector,eighty,'an 80-char selector is a valid boundary');
 assert.equal(normalizeCapabilities(ready({models:[model(0,{selector:null})]})).models[0].selector,null);
 assert.equal(normalizeCapabilities(ready({thinking:{status:'not_exposed',levels:[]}})).thinking.status,'not_exposed');
 assert.deepEqual(normalizeCapabilities(ready({thinking:{status:'unknown',levels:[]}})).thinking,{status:'unknown',levels:[]});
 const busy=normalizeCapabilities({status:'busy',observed:false,observed_at:null,source:'policy',reason:'task_active',models:forty,thinking:{status:'observed',levels:[{level:'high',label:'高'}]}});
 assert.equal(busy.status,'busy');
 assert.deepEqual(busy.models,[],'non-ready payloads never echo observed options');
 assert.deepEqual(busy.thinking,{status:'unknown',levels:[]});
});
