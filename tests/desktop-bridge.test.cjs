'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const vm=require('node:vm');
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const observation=require('../src/desktop-observation.cjs');
const page=require('../src/desktop-page.cjs');
const bridge=require('../src/desktop-bridge.cjs');

function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}
function marker(id){return `[gemini-work:${id}:abcd1234]`;}
function baseState(over={}){
 return {
  protocol:'https:',origin:'https://gemini.google.com',url:'https://gemini.google.com/app',title:'Gemini',
  width:1200,height:800,online:true,visibility:'visible',clientShell:false,
  draft:'',hasInput:true,dialog:false,backdrop:false,generates:false,uploads:[],controls:[],
  models:[{id:'mode-flash',text:'3.8 Flash',visible:true},{id:'mode-argon',text:'4 Argon',visible:true}],
  hasModeMenu:true,sendButtons:[{label:'发送',testId:'send-button',disabled:false}],
  surface:{mode:'chat',selected:'对话',options:[{text:'对话',selected:true,checked:true},{text:'任务',selected:false,checked:false}]},
  thinking_control:'menu',
  thinkingEntryCount:1,
  thinkingOptions:[{id:'thinking-high',text:'高',visible:true,checked:true,disabled:false,role:'menuitemradio'}],
  composer:{model_text:'Flash 高',aria_label:'打开模式选择器，当前模式为“Flash 高”',action:null,action_label:'',action_test_id:''},
  queries:[],responses:[],bodyText:'',...over
 };
}
function tempDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'gemini-phase2-'));}
function clock(){
 let value=0,next=1;
 const timers=new Map();
 return {
  now:()=>value,
  setTimeout(fn,ms){const id=next++;timers.set(id,{at:value+ms,fn});return id;},
  clearTimeout(id){timers.delete(id);},
  advance(ms){
   value+=ms;
   let ran=true;
   while(ran){
    ran=false;
    for(const [id,timer] of Array.from(timers)){
     if(timer.at<=value){timers.delete(id);timer.fn();ran=true;break;}
    }
   }
  }
 };
}
function createHarness(initial={},options={}){
 const state=baseState(initial);
 const behavior=options.behavior||{};
 const counts={type:0,send:0,upload:0,observe:0,menu:0,model:0,nav:0,invalidate:0,newChat:0,surface:0,dismiss:0};
 const ipcMain=new EventEmitter();
 const wc=new EventEmitter();
 const mainFrame={url:state.url,parent:null};
 let binding=null,seq=0,nativeSeq=0,docCounter=0,pings=0;
 wc.id=1;wc.mainFrame=mainFrame;wc.sent=[];
 wc.isDestroyed=()=>false;
 wc.getURL=()=>mainFrame.url;
 wc.setBackgroundThrottling=value=>{state.throttled=value;};
 wc.getBackgroundThrottling=()=>state.throttled;
 wc.invalidate=()=>{counts.invalidate+=1;};
 function eventFor(over={}){return {sender:wc,senderFrame:mainFrame,...over};}
 function emitState(){
  if(!binding)return;
  mainFrame.url=state.url;
  seq+=1;
  ipcMain.emit(observation.EVENT_CHANNEL,eventFor(),{
   type:'state',bindingId:binding.bindingId,generation:binding.generation,seq,
   task_id:binding.task_id,state:JSON.parse(JSON.stringify(state))
  });
 }
 function hello(){
  docCounter++;
  mainFrame.url=state.url;
  seq=0;
  nativeSeq=0;
  ipcMain.emit(observation.EVENT_CHANNEL,eventFor(),{type:'hello',documentId:'doc-'+String(docCounter).padStart(8,'0'),url:state.url,protocol:1});
 }
 wc.send=(channel,message)=>{
  wc.sent.push({channel,message:JSON.parse(JSON.stringify(message))});
  if(channel!==observation.CONTROL_CHANNEL)return;
  if(message.type==='bind'){
   binding={bindingId:message.bindingId,generation:message.generation,task_id:message.task_id};
   emitState();
  }else if(message.type==='ping'){
   pings+=1;
   ipcMain.emit(observation.EVENT_CHANNEL,eventFor(),{type:'pong',nonce:message.nonce,documentId:'doc-'+String(docCounter).padStart(8,'0'),bindingId:binding.bindingId,generation:binding.generation});
  }
 };
 wc.executeJavaScript=async code=>{
  if(code.includes('gemini-page:observe')){counts.observe+=1;return JSON.parse(JSON.stringify(state));}
  if(code.includes('gemini-page:click-mode-menu')){
   counts.menu+=1;
   state.models=behavior.modelsOnMenu?JSON.parse(JSON.stringify(behavior.modelsOnMenu)):[{id:'mode-flash',text:'3.8 Flash',visible:true},{id:'mode-argon',text:'4 Argon',visible:true}];
   if(state.selectedId)state.models.forEach(item=>{item.checked=item.id===state.selectedId;});
   state.hasModeMenu=true;
   emitState();
   return {ok:true};
  }
   if(code.includes('gemini-page:click-model')){
    const aliasMatch=code.match(/(?:alias:|const selector=)("(?:[^"\\]|\\.)*")/);
    const idMatch=code.match(/const (?:id|expectedId)=("(?:[^"\\]|\\.)*");/);
    const alias=aliasMatch?JSON.parse(aliasMatch[1]):null;
    const clickedId=idMatch?JSON.parse(idMatch[1]):null;
    counts.model+=1;
    state.selectedId=clickedId||(alias==='flash'?'mode-flash':alias==='argon'?'mode-argon':alias==='hydrogen'?'mode-hydrogen':alias);
    const aliasRe=alias==='flash'?/flash/i:alias==='argon'?/argon/i:alias==='hydrogen'?/hydrogen/i:null;
    (state.models||[]).forEach(item=>{
     const byId=!!(clickedId&&item.id===clickedId)||item.id===state.selectedId;
     const byAlias=!!(aliasRe&&aliasRe.test(String(item.text||'')));
     item.checked=byId||byAlias;
    });
    emitState();
    return {ok:true};
   }
  if(code.includes('gemini-page:type-prompt')){
   const match=code.match(/const text=("(?:[^"\\]|\\.)*");/s);
   counts.type+=1;
   state.typedText=JSON.parse(match[1]);
   state.draft=state.typedText;
   emitState();
   return {ok:true,length:state.draft.length};
  }
  if(code.includes('gemini-page:upload')){
   const match=code.match(/const files=(\[.*?\]);\s*const inputs/s);
   const files=JSON.parse(match[1]);
   counts.upload+=1;
   state.uploads=typeof behavior.uploadTexts==='function'?behavior.uploadTexts(files):files.map(file=>file.name+(behavior.uploadSuffix||''));
   if(behavior.uploadGenerates!==undefined)state.generates=!!behavior.uploadGenerates;
   if(behavior.uploadProcessing!==undefined)state.uploadProcessing=!!behavior.uploadProcessing;
   emitState();
   return {ok:true,count:files.length};
  }
  if(code.includes('gemini-page:clear-uploads')){
   counts.clearUploads=(counts.clearUploads||0)+1;
   const previews=(state.uploads||[]).length;
   state.uploads=[];
   state.uploadProcessing=false;
   state.generates=false;
   emitState();
   return {ok:true,count:previews,previews,cleared:[]};
  }
  if(code.includes('gemini-page:settings-action')){
   if(code.includes('close_menus')){
    (state.models||[]).forEach(item=>{item.visible=false;});
    (state.thinkingOptions||[]).forEach(item=>{item.visible=false;});
    emitState();
   }
   return {ok:true};
  }
  if(code.includes('gemini-page:dismiss-menus')){
   counts.dismiss+=1;
   if(behavior.dismissFailure)return {ok:false,error:behavior.dismissFailure};
   if(!behavior.dismissLeavesOpen){
    (state.models||[]).forEach(item=>{item.visible=false;});
    (state.thinkingOptions||[]).forEach(item=>{item.visible=false;});
    state.backdrop=false;
    emitState();
   }
   return {ok:true,action:'backdrop'};
  }
  if(code.includes('gemini-page:select-surface')){
   counts.surface+=1;
   const modeMatch=code.match(/mode:("(?:[^"\\]|\\.)*")/)||code.match(/const mode=("(?:[^"\\]|\\.)*")/);
   let modeValue='chat';
   if(modeMatch)modeValue=JSON.parse(modeMatch[1])==='task'?'task':'chat';
   else if(code.includes('任务')||(code.includes('task')&&!code.includes('chat')))modeValue='task';
   state.surface={mode:modeValue,selected:modeValue==='task'?'任务':'对话',options:[{text:'对话',selected:modeValue==='chat',checked:modeValue==='chat'},{text:'任务',selected:modeValue==='task',checked:modeValue==='task'}]};
   emitState();
   return {ok:true};
  }
  if(code.includes('gemini-page:click-thinking-menu')||code.includes('gemini-page:click-thinking')){
   const wantHigh=code.includes('high')||code.includes('高');
   (state.thinkingOptions||[]).forEach(item=>{
    const high=/高|high/i.test(String(item.text||''))||item.id==='thinking-high'||item.level==='high';
    item.checked=wantHigh?!!high:!high;
    item.visible=true;
   });
   if(!(state.thinkingOptions||[]).length){
    state.thinkingOptions=[{id:'thinking-high',text:'高',visible:true,checked:true,disabled:false,role:'menuitemradio'}];
   }
   emitState();
   return {ok:true};
  }
  if(code.includes('gemini-page:click-new-chat')){
   counts.newChat+=1;
   state.queries=[];
   state.responses=[];
   state.draft='';
   state.uploads=[];
   state.generates=false;
   state.url='https://gemini.google.com/app';
   mainFrame.url=state.url;
   emitState();
   return {ok:true,clicked:true,label:'新聊天'};
  }
  if(code.includes('gemini-page:click-send')){
   counts.send+=1;
   const sentMarker=String(state.typedText||state.draft||'').split('\n')[0];
   state.draft='';
   state.uploads=[];
   state.queries.push(sentMarker);
   state.responses.push({answer:'',complete:false});
   if(typeof behavior.confirmUrl==='string')state.url=behavior.confirmUrl;
   else if(behavior.confirmUrl===false){}
   else if(page.hasConversationId(state.url)){}
   else state.url='https://gemini.google.com/app/conv-'+counts.send;
   emitState();
   if(typeof behavior.afterSend==='function')behavior.afterSend(api);
   return {ok:true};
  }
  throw new Error('unexpected page script: '+code.slice(0,80));
 };
 wc.loadURL=async url=>{
  counts.nav+=1;
  state.url=url;
  mainFrame.url=url;
  wc.emit('did-start-navigation',{url,isMainFrame:true,isSameDocument:false});
  hello();
 };
 wc.destroy=()=>{for(const handler of wc.listeners('destroyed'))handler();};
 const host=new observation.ObservationHost({
  wc,ipcMain,
  maxPayloadBytes:Number.isInteger(options.maxPayloadBytes)?options.maxPayloadBytes:undefined,
  maxAnswerBytes:Number.isInteger(options.maxAnswerBytes)?options.maxAnswerBytes:undefined
 });
 const api={
  state,counts,behavior,host,wc,ipcMain,hello,emitState,
  update(patch={}){Object.assign(state,patch);emitState();},
  push(){emitState();},
  native(turn){
   if(!binding)throw Error('native fixture requires a producer binding');
   ipcMain.emit(observation.EVENT_CHANNEL,eventFor(),{
    type:'native',documentId:'doc-'+String(docCounter).padStart(8,'0'),
    bindingId:binding.bindingId,generation:binding.generation,
    task_id:binding.task_id,seq:++nativeSeq,...turn
   });
  },
  get pings(){return pings;}
 };
 return api;
}
function request(port,options={}){
 const body=options.body===undefined?null:Buffer.from(typeof options.body==='string'?options.body:JSON.stringify(options.body));
 return new Promise((resolve,reject)=>{
  const headers={...(body?{'content-type':'application/json','content-length':body.length}:{}),...(options.headers||{})};
  const req=http.request({host:'127.0.0.1',port,path:options.path||'/rpc',method:options.method||'POST',headers,agent:false},res=>{
   const chunks=[];
   res.on('data',chunk=>chunks.push(chunk));
   res.on('end',()=>{
    const text=Buffer.concat(chunks).toString('utf8');
    let json=null;try{json=JSON.parse(text);}catch{}
    resolve({status:res.statusCode,json,text,headers:res.headers});
   });
  });
  req.on('error',reject);
  if(body)req.write(body);
  req.end();
 });
}
function openStream(port,headers){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:'/events',method:'GET',headers,agent:false},res=>resolve({req,res}));
  req.on('error',reject);
  req.end();
 });
}
function firstEvent(stream,timeout=1000){
 return new Promise(resolve=>{
  let data='';
  const done=()=>{clearTimeout(timer);stream.res.removeListener('data',onData);resolve(data);};
  const onData=chunk=>{data+=chunk.toString();if(data.includes('\n\n'))done();};
  const timer=setTimeout(done,timeout);
  stream.res.on('data',onData);
 });
}
async function setup(over={}){
 const stateDir=over.stateDir||tempDir();
 const h=createHarness(over.initial||{},over);
 const timers=over.clock||null;
 const handle=bridge.attach(h.wc,{
  stateDir,readOnly:over.readOnly!==false,appVersion:'1.16.0',observationHost:h.host,
  maxHTTPBytes:over.maxHTTPBytes,stableMs:over.stableMs===undefined?20:over.stableMs,
  confirmationMs:over.confirmationMs,idleMs:over.idleMs,attachmentMs:over.attachmentMs,
  modelMs:over.modelMs===undefined?200:over.modelMs,prepareMs:over.prepareMs,pingMs:over.pingMs,heartbeatMs:over.heartbeatMs,
 answerPersistMs:over.answerPersistMs,readyMs:over.readyMs,
 createConversationView:over.createConversationView,preloadPath:over.preloadPath,
  now:timers?timers.now:undefined,setTimeout:timers?timers.setTimeout:undefined,clearTimeout:timers?timers.clearTimeout:undefined
 });
 const ready=await handle.ready;
 assert.equal(ready.ok,true);
 if(!over.unbound)h.hello();
 const discovery=JSON.parse(fs.readFileSync(path.join(stateDir,'discovery.json'),'utf8'));
 return {stateDir,handle,discovery,h,...h};
}
function rpc(env,payload,headers={}){return request(env.handle.port,{headers:{authorization:'Bearer '+env.discovery.token,...headers},body:payload});}
async function waitSnapshot(env,id,predicate,timeout=5000){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  const response=await rpc(env,{op:'snapshot',task_id:id});
  if(response.json&&response.json.ok&&predicate(response.json.data))return response.json.data;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 const last=await rpc(env,{op:'snapshot',task_id:id});
 throw new Error('timeout waiting for snapshot, last='+JSON.stringify(last.json));
}
function waitStatus(env,id,statuses,timeout=5000){return waitSnapshot(env,id,data=>statuses.includes(data.status),timeout);}
function wire(id,over={}){
 return {id,marker:marker(id),prompt:'请回答 '+id,purpose:'work',model:'flash',conversation_url:null,timeoutMs:null,attachments:[],...over};
}
async function settleAnswer(env,id,answer){
 await waitSnapshot(env,id,data=>data.phase==='awaiting_confirmation'||data.phase==='generating'||data.status==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer=answer;
 response.complete=true;
 env.h.push();
 return waitStatus(env,id,['completed'],5000);
}
function seedLedger(stateDir,ledger){fs.mkdirSync(path.join(stateDir,'bridge-tasks'),{recursive:true});fs.writeFileSync(path.join(stateDir,'bridge-tasks',ledger.task_id+'.json'),JSON.stringify(ledger));}
function delay(ms=25){return new Promise(resolve=>setTimeout(resolve,ms));}
function stalledDiagnostic(env,over={}){
 const binding=env.host.binding;
 return {
  supported:true,requested_at:'2026-11-10T00:00:00.000Z',completed_at:null,
  timer_fired_at:'2026-11-10T00:00:00.250Z',generation:binding?binding.generation:1,seq:1,...over
 };
}
function ledgerFor(raw,over={}){
 const normalized=bridge.validateWire(raw);
 const hash=bridge.contentHash(normalized);
 return {
  schema:1,task_id:raw.id,marker:normalized.marker,content_hash:hash,model:raw.model,purpose:'work',timeoutMs:raw.timeoutMs,
  status:'partial',phase:'generating',revision:0,binding_id:'old',
  result:{answer:'',url:null,model:page.MODELS[raw.model],submission_confirmed:false,marker:normalized.marker,beforeResponses:0},
  error:null,metadata:{},created_at:new Date(0).toISOString(),updated_at:new Date(0).toISOString(),released:false,
  input:{content_sha256:hash,prompt_sha256:sha256(raw.prompt),prompt_chars:raw.prompt.length},
  phases:{prepared:null,send_intent:null,marker_seen:null,confirmed:null,terminal:null},...over
 };
}

test('execute is event-driven from ObservationHost pushes, confirms a real conversation URL, and journals snapshots',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const raw=wire('happy',{attachments:[{name:'m.txt',mime:'text/plain',base64:Buffer.from('material').toString('base64')}]});
 const execution=await rpc(env,{op:'execute',task:raw});
 assert.equal(execution.status,200);
 assert.equal(execution.json.ok,true);
 const generating=await waitSnapshot(env,'happy',data=>data.phase==='generating'||data.phase==='awaiting_confirmation');
 assert.ok(['submitting','generating'].includes(generating.status));
 assert.equal(env.counts.observe,0,'production path must not execute observe polling');
 assert.equal(env.counts.type,1);
 assert.equal(env.counts.upload,1);
 assert.equal(env.counts.send,1);
 const typed=env.h.state.typedText;
 assert.ok(typed.startsWith(marker('happy')+'\n'));
 assert.equal((typed.match(/\[gemini-work:happy:abcd1234\]/g)||[]).length,1,'promptFor header must be added exactly once');
 assert.ok(typed.includes('任务要求：\n请回答 happy'));
 // Native lifecycle completion is advisory only.
 env.h.native({phase:'completed',task_id:'happy'});
 await new Promise(resolve=>setTimeout(resolve,40));
 const still=await rpc(env,{op:'snapshot',task_id:'happy'});
 assert.notEqual(still.json.data.status,'completed');
 const done=await settleAnswer(env,'happy','answer for '+marker('happy'));
 assert.equal(done.result.submission_confirmed,true);
 assert.equal(done.result.url,'https://gemini.google.com/app/conv-1');
 assert.equal(done.result.complete,true);
 assert.equal(done.result.answer,'answer for '+marker('happy'));
 assert.ok(done.metadata.completion.completed_at);
 assert.equal(done.metadata.completion.stable_ms,20);
 const ledger=JSON.parse(fs.readFileSync(path.join(env.stateDir,'bridge-tasks','happy.json'),'utf8'));
 assert.ok(ledger.phases.prepared&&ledger.phases.send_intent&&ledger.phases.confirmed&&ledger.phases.terminal);
 assert.ok(Date.parse(ledger.phases.prepared.at)<=Date.parse(ledger.phases.send_intent.at));
 assert.ok(Date.parse(ledger.phases.send_intent.at)<=Date.parse(ledger.phases.confirmed.at));
 assert.equal(ledger.input.prompt_sha256,sha256(raw.prompt),'wire prompt stays raw');
 assert.equal(ledger.phase,'completed');
 const journalText=fs.readFileSync(path.join(env.stateDir,'bridge-events.json'),'utf8');
 const journal=JSON.parse(journalText);
 const snapshots=journal.events.filter(event=>event.type==='snapshot');
 assert.ok(snapshots.length>=3);
 for(let i=1;i<snapshots.length;i++)assert.ok(snapshots[i].revision>snapshots[i-1].revision,'revisions must be monotonic');
 const finalEvent=snapshots.at(-1);
 assert.equal(finalEvent.task.status,'completed');
 assert.equal(finalEvent.snapshot.result.answer,'answer for '+marker('happy'));
 const sync=await rpc(env,{op:'sync'});
 assert.equal(sync.status,200);
 assert.equal(sync.json.data.instance_id,journal.instance_id);
 assert.equal(sync.json.data.seq,journal.sequence);
 const synced=sync.json.data.tasks.find(task=>task.task_id==='happy');
 assert.equal(synced.result.url,'https://gemini.google.com/app/conv-1');
 const stream=await openStream(env.handle.port,{authorization:'Bearer '+env.discovery.token,'last-event-id':`${sync.json.data.instance_id}:${Math.max(0,sync.json.data.seq-1)}`});
 const replayed=await firstEvent(stream);
 stream.req.destroy();
 assert.match(replayed,/event: task/);
 assert.match(replayed,/"type":"snapshot"/);
 const replay=await rpc(env,{op:'execute',task:raw});
 assert.equal(replay.json.data.status,'completed');
 assert.equal(env.counts.send,1);
 assert.equal((await rpc(env,{op:'execute',task:wire('happy',{prompt:'different'})})).status,409);
 assert.equal((await rpc(env,{op:'execute',task:wire('happy',{selector:'x'})})).json.error.code,'BAD_REQUEST');
 const released=await rpc(env,{op:'release',task_id:'happy'});
 assert.equal(released.json.ok,true);
 const restarted=await rpc(env,{op:'execute',task:raw});
 assert.equal(restarted.status,409);
 assert.equal(restarted.json.error.code,'RELEASED');
});

test('attachment cards must match exact lines; a mismatch never sends',async t=>{
 const env=await setup({readOnly:false,attachmentMs:30,initial:{generates:true},behavior:{uploadSuffix:' (1)',uploadGenerates:true,uploadProcessing:false}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('attachments',{attachments:[{name:'m.txt',mime:'text/plain',base64:Buffer.from('material').toString('base64')}]})});
 const failed=await waitStatus(env,'attachments',['needs_user_action','failed','uncertain']);
 assert.equal(failed.error.code,'ATTACHMENT_NOT_READY');
 assert.equal(env.counts.upload,1);
 assert.equal(env.counts.send,0);
 assert.ok(failed.error.details,failed.error);
 assert.deepEqual(failed.error.details.uploads,['m.txt (1)']);
 assert.equal(failed.error.details.generates,true);
 assert.match(failed.error.message,/未写提示词、未点发送/);
 assert.match(failed.error.message,/m\.txt \(1\)/);
 assert.equal(env.counts.clearUploads,1);
});

test('truncated attachment labels are accepted and do not depend on a global progress bar',async t=>{
 const name='第03章-PyTorch深度神经网络及训练与可视化工具（样板）.txt';
 const env=await setup({readOnly:false,attachmentMs:200,initial:{generates:true},behavior:{
  uploadTexts:()=>['TXT\n第03章-PyTor...与可视化工具（样板）'],
  uploadGenerates:true,
  uploadProcessing:false
 }});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('trunc-attach',{attachments:[{name,mime:'text/plain',base64:Buffer.from('material').toString('base64')}]})});
 const done=await waitStatus(env,'trunc-attach',['completed','generating','partial']);
 assert.ok(['completed','generating','partial'].includes(done.status),done.status);
 assert.equal(env.counts.upload,1);
 assert.equal(env.counts.send,1);
 assert.equal(env.counts.clearUploads||0,0);
});

test('model availability is exact and never downgraded',async t=>{
 const env=await setup({readOnly:false,modelMs:30,initial:{models:[]},behavior:{modelsOnMenu:[{id:'mode-argon',text:'4 Argon',visible:true}]}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('model-missing',{model:'flash'})});
 const failed=await waitStatus(env,'model-missing',['needs_user_action']);
 assert.equal(failed.error.code,'MODEL_UNAVAILABLE');
 assert.equal(env.counts.menu,1);
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});

test('a late conversation id after SEND_UNCONFIRMED_URL is bound read-only by recover and yields the full answer',async t=>{
 const env=await setup({readOnly:false,confirmationMs:30,initial:{},behavior:{confirmUrl:false}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('bare-url')});
 const uncertain=await waitStatus(env,'bare-url',['uncertain'],4000);
 assert.equal(uncertain.error.code,'SEND_UNCONFIRMED_URL');
 assert.equal(uncertain.result.submission_confirmed,false);
 assert.equal(uncertain.send_state,'submitted');
 assert.ok(uncertain.metadata.marker_seen_at);
 assert.equal(uncertain.metadata.confirmation_diagnostic.stage,'url-timeout');
 assert.equal(env.counts.send,1);
 const before=JSON.parse(fs.readFileSync(path.join(env.stateDir,'bridge-tasks','bare-url.json'),'utf8'));
 assert.ok(before.phases.marker_seen);
 assert.equal(before.phases.confirmed,null);
 assert.equal(before.phases.marker_seen.session_id,'primary');
 // The replay never sends again while only a bare /app has been observed.
 const replay=await rpc(env,{op:'execute',task:wire('bare-url')});
 assert.equal(replay.json.data.status,'uncertain');
 assert.equal(env.counts.send,1);
 // The original observation target later publishes the real URL and answer.
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='late full answer for '+marker('bare-url');
 response.complete=true;
 env.h.update({url:'https://gemini.google.com/app/conv-late'});
 const recovered=await rpc(env,{op:'recover',task_id:'bare-url'});
 assert.equal(recovered.json.ok,true);
 const done=await waitStatus(env,'bare-url',['completed'],5000);
 assert.equal(done.result.submission_confirmed,true);
 assert.equal(done.result.url,'https://gemini.google.com/app/conv-late');
 assert.equal(done.result.answer,'late full answer for '+marker('bare-url'));
 const ledger=JSON.parse(fs.readFileSync(path.join(env.stateDir,'bridge-tasks','bare-url.json'),'utf8'));
 assert.ok(ledger.phases.confirmed&&ledger.phases.terminal);
 assert.equal(ledger.metadata.late_bind.resolved_url,'https://gemini.google.com/app/conv-late');
 assert.equal(env.counts.send,1,'late binding must never send again');
 assert.equal(env.counts.type,1);
 assert.equal(env.counts.nav,0,'late binding must not navigate');
 assert.equal(env.counts.newChat,0,'late binding must not choose or create another conversation');
});

test('late binding without a uniquely owned marker stays unconfirmed and never resends',async t=>{
 const envs=[];
 t.after(async()=>{for(const env of envs){await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});}});
 const cases=[
  {id:'late-no-id',expect:'SEND_UNCONFIRMED_URL'},
  {id:'late-missing',expect:'MARKER_MISMATCH',apply:env=>env.h.update({url:'https://gemini.google.com/app/conv-missing',queries:['another user message'],responses:[{answer:'other answer',complete:true}]})},
  {id:'late-duplicate',expect:'MARKER_DUPLICATED',apply:env=>env.h.update({url:'https://gemini.google.com/app/conv-dup',queries:[marker('late-duplicate'),marker('late-duplicate')],responses:[{answer:'a',complete:true},{answer:'b',complete:true}]})},
  {id:'late-followup',expect:'MARKER_NOT_LAST',apply:env=>env.h.update({url:'https://gemini.google.com/app/conv-follow',queries:[marker('late-followup'),'a later user message'],responses:[{answer:'a',complete:true},{answer:'b',complete:true}]})}
 ];
 for(const item of cases){
  const env=await setup({readOnly:false,confirmationMs:30,initial:{},behavior:{confirmUrl:false}});
  envs.push(env);
  await rpc(env,{op:'execute',task:wire(item.id)});
  const uncertain=await waitStatus(env,item.id,['uncertain'],4000);
  assert.equal(uncertain.error.code,'SEND_UNCONFIRMED_URL',item.id);
  if(item.apply)item.apply(env);
  const recovered=await rpc(env,{op:'recover',task_id:item.id});
  assert.equal(recovered.json.ok,true,item.id);
  const held=await waitSnapshot(env,item.id,data=>data.status==='uncertain'&&data.error?.code===item.expect,4000);
  assert.equal(held.result.submission_confirmed,false,item.id);
  assert.equal(env.counts.send,1,item.id+' must not resend');
  assert.equal(env.counts.type,1,item.id+' must not type again');
  assert.equal(env.counts.nav,0,item.id+' must not navigate');
  assert.equal(env.counts.newChat,0,item.id+' must not choose another conversation');
 }
});

test('a late id from a different conversation is rejected for a continued task',async t=>{
 const original='https://gemini.google.com/app/conv-a';
 const env=await setup({readOnly:false,confirmationMs:30,initial:{url:original},behavior:{confirmUrl:'https://gemini.google.com/app'}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const id='late-mismatch';
 await rpc(env,{op:'execute',task:wire(id,{conversation_url:original})});
 const uncertain=await waitStatus(env,id,['uncertain']);
 assert.equal(uncertain.error.code,'SEND_UNCONFIRMED_URL');
 env.update({url:'https://gemini.google.com/app/conv-b'});
 await rpc(env,{op:'recover',task_id:id});
 const held=await waitSnapshot(env,id,data=>data.error?.code==='CONVERSATION_CHANGED');
 assert.equal(held.status,'uncertain');
 assert.equal(held.result.submission_confirmed,false);
 assert.equal(env.counts.send,1);
});

test('late binding never treats a replacement bridge as the original primary page',async t=>{
 const original=await setup({readOnly:false,confirmationMs:30,behavior:{confirmUrl:false}});
 t.after(async()=>{await original.handle.close();fs.rmSync(original.stateDir,{recursive:true,force:true});});
 const id='late-restart';
 await rpc(original,{op:'execute',task:wire(id)});
 const uncertain=await waitStatus(original,id,['uncertain']);
 assert.equal(uncertain.error.code,'SEND_UNCONFIRMED_URL');
 await original.handle.close();
 const replacement=await setup({stateDir:original.stateDir,readOnly:false,initial:{
  url:'https://gemini.google.com/app/late-restart',queries:[marker(id)],responses:[{answer:'answer',complete:true}]
 }});
 t.after(()=>replacement.handle.close());
 await rpc(replacement,{op:'recover',task_id:id});
 const held=await waitSnapshot(replacement,id,data=>data.error?.code==='LATE_BIND_TARGET_LOST');
 assert.equal(held.status,'uncertain');
 assert.equal(held.result.url,null);
 assert.equal(replacement.counts.send+replacement.counts.nav,0);
});

test('explicit budget reports partial metadata but retains occupancy until real completion',async t=>{
 const fake=clock();
 const env=await setup({readOnly:false,clock:fake});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const raw=wire('budget',{timeoutMs:20000});
 await rpc(env,{op:'execute',task:raw});
 await waitSnapshot(env,'budget',data=>data.phase==='generating');
 fake.advance(20000);
 const partial=await waitSnapshot(env,'budget',data=>data.status==='partial');
 assert.equal(partial.metadata.budget_exhausted,true);
 assert.equal(partial.error.code,'BUDGET_EXHAUSTED');
 assert.equal(partial.result.partial,true);
 const probe=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(probe.generating_limit,3);
 assert.equal(probe.generating_count,1);
 assert.deepEqual(probe.generating_task_ids,['budget']);
 const denied=await rpc(env,{op:'release',task_id:'budget'});
 assert.equal(denied.json.error.code,'RELEASE_DENIED');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='late but real answer';
 response.complete=true;
 env.h.push();
 fake.advance(20);
 const done=await waitStatus(env,'budget',['completed']);
 assert.equal(done.result.complete,true);
 assert.equal(done.result.budget_exhausted,true);
 assert.equal(done.result.answer,'late but real answer');
});

test('idle timer performs one diagnostic ping and then waits for new business state',async t=>{
 const fake=clock();
 const env=await setup({readOnly:false,clock:fake,idleMs:90});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('idle')});
 await waitSnapshot(env,'idle',data=>data.phase==='generating');
 fake.advance(90);
 const diagnostic=await waitSnapshot(env,'idle',data=>data.metadata.idle_ping_ok===true,2000);
 assert.equal(diagnostic.metadata.completion_unverified,true);
 assert.equal(diagnostic.metadata.completion_unverified_reason,'idle_ping_no_progress');
 assert.equal(env.h.pings,1);
 fake.advance(1000);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(env.h.pings,1,'no recursive heartbeat ping without a business event');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='after idle';
 response.complete=true;
 env.h.push();
 fake.advance(20);
 const done=await waitStatus(env,'idle',['completed']);
 assert.equal(done.result.answer,'after idle');
});

test('an ordered native pair survives a healthy idle ping and completes a verified chat turn once generation stops',async t=>{
 const fake=clock();
 const env=await setup({readOnly:false,clock:fake,idleMs:90});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('native-idle')});
 await waitSnapshot(env,'native-idle',data=>data.phase==='generating');
 env.h.state.controls=[{label:'停止回答',text:''}];
 const response=env.h.state.responses[env.h.state.responses.length-1];
 // A short prefix must never be accepted as the final answer on its own.
 response.answer='Argon pr';
 env.h.push();
 env.h.native({phase:'start',task_id:'native-idle',conversationId:'conv-1'});
 fake.advance(90);
 const healthy=await waitSnapshot(env,'native-idle',data=>data.metadata.idle_ping_ok===true,2000);
 assert.equal(healthy.metadata.idle_still_generating,true);
 assert.equal(healthy.metadata.completion_unverified,undefined);
 assert.equal(healthy.metadata.completion_unverified_reason,undefined);
 assert.equal(healthy.status,'generating');
 assert.equal(healthy.error,null);
 assert.equal(env.h.pings,1);
 // The healthy ping neither faults nor clears the native start evidence.
 const probed=await rpc(env,{op:'probe'});
 assert.deepEqual(probed.json.data.observer.native_phases.map(turn=>turn.phase),['start']);
 assert.equal(probed.json.data.observer.native_phases[0].conversationId,'conv-1');
 // While the stop control is visible the turn is still generating, so the
 // correlated pair alone must not finish it.
 env.h.native({phase:'complete',task_id:'native-idle',conversationId:'conv-1'});
 const held=await rpc(env,{op:'snapshot',task_id:'native-idle'});
 assert.equal(held.json.data.status,'generating');
 assert.equal(held.json.data.phase,'generating');
 assert.notEqual(held.json.data.result.complete,true);
 // Generation stops: the verified chat composite evidence must finish the
 // same owned answer even though the DOM copy button never appears.
 env.h.state.controls=[];
 response.answer='Argon prefix final answer';
 env.h.push();
 fake.advance(20);
 const done=await waitStatus(env,'native-idle',['completed'],3000);
 assert.equal(done.result.answer,'Argon prefix final answer');
 assert.equal(done.result.complete,true);
 assert.equal(done.metadata.completion.evidence,'chat-composite');
 assert.equal(done.metadata.completion_unverified,undefined);
 assert.equal(done.metadata.completion_unverified_reason,undefined);
});

test('a verified chat turn completes on the native pair and owned DOM answer without a copy button and frees its slot',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('chat-composite')});
 await waitSnapshot(env,'chat-composite',data=>data.phase==='generating');
 env.h.native({phase:'start',task_id:'chat-composite',conversationId:'c_conv-1'});
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='PRELOAD_MIN_B_286';
 response.complete=false;
 env.h.push();
 env.h.native({phase:'complete',task_id:'chat-composite',conversationId:'c_conv-1'});
 const done=await waitStatus(env,'chat-composite',['completed'],3000);
 assert.equal(done.result.answer,'PRELOAD_MIN_B_286');
 assert.equal(done.result.complete,true);
 assert.equal(done.metadata.completion.evidence,'chat-composite');
 const probe=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(probe.generating_count,0,'a completed chat turn must release its generation slot');
});

test('a chat native pair without a DOM answer cannot complete or free the slot',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('chat-native-only')});
 await waitSnapshot(env,'chat-native-only',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='';
 response.complete=false;
 env.h.push();
 env.h.native({phase:'start',task_id:'chat-native-only',conversationId:'c_conv-1'});
 env.h.native({phase:'complete',task_id:'chat-native-only',conversationId:'c_conv-1'});
 await delay(200);
 const live=(await rpc(env,{op:'snapshot',task_id:'chat-native-only'})).json.data;
 assert.equal(live.status,'generating');
 assert.notEqual(live.result.complete,true);
 const probe=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(probe.generating_count,1);
});

test('a stalled hidden renderer requests one repaint after a correlated native complete and still needs DOM completion',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('repaint')});
 await waitSnapshot(env,'repaint',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='partial answer without a completion footer';
 response.complete=false;
 // A visible stop control keeps the turn generating so only the DOM copy
 // button may finish it in this diagnostic test.
 env.h.state.controls=[{label:'停止回答',text:''}];
 env.h.state.renderer_diagnostic=stalledDiagnostic(env);
 env.h.push();
 await delay();
 assert.equal(env.counts.invalidate,0,'native complete is required before any repaint');
 env.h.native({phase:'start',task_id:'repaint',conversationId:'c_conv-1'});
 env.h.native({phase:'complete',task_id:'repaint',conversationId:'c_conv-1'});
 const stalled=await waitSnapshot(env,'repaint',data=>data.metadata.render_repaint&&data.metadata.render_repaint.entries.length===1,2000);
 assert.equal(env.counts.invalidate,1);
 const entry=stalled.metadata.render_repaint.entries[0];
 assert.equal(entry.outcome,'called');
 assert.equal(entry.generation,env.host.binding.generation);
 assert.equal(entry.diagnostic_seq,1);
 assert.ok(entry.at);
 assert.equal(stalled.status,'generating');
 assert.notEqual(stalled.result.complete,true);
 // Duplicate pushes and duplicate native events must not schedule more repaints.
 env.h.push();
 env.h.native({phase:'complete',task_id:'repaint',conversationId:'c_conv-1'});
 await delay();
 assert.equal(env.counts.invalidate,1);
 assert.equal((await rpc(env,{op:'snapshot',task_id:'repaint'})).json.data.metadata.render_repaint.entries.length,1);
 // Only the page-provided completion marker can finish the task.
 env.h.state.controls=[];
 response.complete=true;
 env.h.push();
 const done=await waitStatus(env,'repaint',['completed'],3000);
 assert.equal(done.result.answer,'partial answer without a completion footer');
 assert.equal(done.result.complete,true);
 assert.equal(env.counts.invalidate,1);
});

test('repaint is once per observer generation and capped at two per task',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('repaint-cap')});
 await waitSnapshot(env,'repaint-cap',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='still streaming';
 response.complete=false;
 // Still generating, so the native pair cannot be treated as a finished turn.
 env.h.state.controls=[{label:'停止回答',text:''}];
 env.h.state.renderer_diagnostic=stalledDiagnostic(env);
 env.h.push();
 env.h.native({phase:'start',task_id:'repaint-cap',conversationId:'c_conv-1'});
 env.h.native({phase:'complete',task_id:'repaint-cap',conversationId:'c_conv-1'});
 await waitSnapshot(env,'repaint-cap',data=>data.metadata.render_repaint&&data.metadata.render_repaint.entries.length===1,2000);
 assert.equal(env.counts.invalidate,1);
 // A fresh observer generation may diagnose again.
 env.h.hello();
 env.h.state.renderer_diagnostic=stalledDiagnostic(env,{seq:2});
 env.h.push();
 const second=await waitSnapshot(env,'repaint-cap',data=>data.metadata.render_repaint&&data.metadata.render_repaint.entries.length===2,2000);
 assert.equal(env.counts.invalidate,2);
 assert.equal(second.metadata.render_repaint.entries[1].generation,env.host.binding.generation);
 // The per-task cap prevents a third request even with another generation.
 env.h.hello();
 env.h.state.renderer_diagnostic=stalledDiagnostic(env,{seq:3});
 env.h.push();
 await delay();
 const capped=await rpc(env,{op:'snapshot',task_id:'repaint-cap'});
 assert.equal(env.counts.invalidate,2);
 assert.equal(capped.json.data.metadata.render_repaint.entries.length,2);
 assert.equal(capped.json.data.status,'generating');
 assert.notEqual(capped.json.data.result.complete,true);
});

test('repaint refuses missing, cross-task, wrong-conversation, old-generation, and healthy-rAF evidence',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('repaint-guards')});
 await waitSnapshot(env,'repaint-guards',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='guarded answer';
 response.complete=false;
 // A stop control keeps the turn generating while repaint evidence is probed.
 env.h.state.controls=[{label:'停止回答',text:''}];
 env.h.state.renderer_diagnostic=stalledDiagnostic(env);
 env.h.push();
 await delay();
 assert.equal(env.counts.invalidate,0,'missing native complete must not repaint');
 env.h.native({phase:'complete',task_id:'other-task',conversationId:'c_conv-1'});
 env.h.native({phase:'complete',task_id:'repaint-guards',conversationId:'c_other'});
 await delay();
 assert.equal(env.counts.invalidate,0,'cross-task or wrong-conversation native events must not repaint');
 const binding=env.host.binding;
 env.h.state.renderer_diagnostic=stalledDiagnostic(env,{generation:binding.generation-1,seq:2});
 env.h.push();
 env.h.native({phase:'start',task_id:'repaint-guards',conversationId:'c_conv-1'});
 env.h.native({phase:'complete',task_id:'repaint-guards',conversationId:'c_conv-1'});
 await delay();
 assert.equal(env.counts.invalidate,0,'an old diagnostic generation must not repaint');
 env.h.state.renderer_diagnostic=stalledDiagnostic(env,{completed_at:'2026-11-10T00:00:00.500Z',seq:3});
 env.h.push();
 await delay();
 assert.equal(env.counts.invalidate,0,'a completed rAF means the renderer is not stalled');
 env.h.state.renderer_diagnostic=stalledDiagnostic(env,{seq:4});
 env.h.push();
 const repainted=await waitSnapshot(env,'repaint-guards',data=>data.metadata.render_repaint&&data.metadata.render_repaint.entries.length===1,2000);
 assert.equal(env.counts.invalidate,1);
 assert.equal(repainted.status,'generating');
});

test('repaint records unsupported and failed attempts without faking completion',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('repaint-unsupported')});
 await waitSnapshot(env,'repaint-unsupported',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='unverified answer';
 response.complete=false;
 // Still generating; the repaint diagnostic must not imply completion.
 env.h.state.controls=[{label:'停止回答',text:''}];
 delete env.wc.invalidate;
 env.h.state.renderer_diagnostic=stalledDiagnostic(env);
 env.h.push();
 env.h.native({phase:'start',task_id:'repaint-unsupported',conversationId:'c_conv-1'});
 env.h.native({phase:'complete',task_id:'repaint-unsupported',conversationId:'c_conv-1'});
 const unsupported=await waitSnapshot(env,'repaint-unsupported',data=>data.metadata.render_repaint&&data.metadata.render_repaint.entries.length===1,2000);
 assert.equal(unsupported.metadata.render_repaint.entries[0].outcome,'unsupported');
 assert.equal(unsupported.status,'generating');
 assert.notEqual(unsupported.result.complete,true);
 let calls=0;
 env.wc.invalidate=()=>{calls+=1;throw new Error('invalidate failed');};
 env.h.hello();
 env.h.state.renderer_diagnostic=stalledDiagnostic(env,{seq:2});
 env.h.push();
 const failed=await waitSnapshot(env,'repaint-unsupported',data=>data.metadata.render_repaint&&data.metadata.render_repaint.entries.length===2,2000);
 assert.equal(calls,1);
 assert.equal(failed.metadata.render_repaint.entries[1].outcome,'failed');
 assert.equal(failed.metadata.render_repaint.entries[1].error.message,'invalidate failed');
 assert.equal(failed.status,'generating');
 assert.notEqual(failed.result.complete,true);
});

test('a pending page-control completion candidate survives a healthy idle ping',async t=>{ const fake=clock();
 const env=await setup({readOnly:false,clock:fake,idleMs:90,stableMs:200});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('candidate-idle')});
 await waitSnapshot(env,'candidate-idle',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='complete answer';
 response.complete=true;
 env.h.push();
 fake.advance(90);
 const healthy=await waitSnapshot(env,'candidate-idle',data=>data.metadata.idle_ping_ok===true,2000);
 assert.equal(healthy.phase,'verifying_completion');
 assert.equal(healthy.metadata.completion_unverified,undefined);
 assert.equal(healthy.metadata.completion_unverified_reason,undefined);
 assert.equal(env.h.pings,1);
 fake.advance(110);
 const done=await waitStatus(env,'candidate-idle',['completed'],3000);
 assert.equal(done.result.answer,'complete answer');
 assert.equal(done.result.complete,true);
 assert.equal(env.h.pings,1);
});

test('an idle ping after generation stops reports the concrete missing completion evidence',async t=>{
 const fake=clock();
 const env=await setup({readOnly:false,clock:fake,idleMs:90});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('stalled')});
 await waitSnapshot(env,'stalled',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='partial answer without a completion signal';
 response.complete=false;
 env.h.push();
 fake.advance(90);
 const diagnostic=await waitSnapshot(env,'stalled',data=>data.metadata.idle_ping_ok===true,2000);
 assert.equal(diagnostic.metadata.completion_unverified,true);
 assert.equal(diagnostic.metadata.completion_unverified_reason,'idle_answer_unverified');
 assert.equal(diagnostic.metadata.idle_has_answer,true);
 assert.equal(diagnostic.status,'generating');
 assert.equal(diagnostic.error,null);
 assert.equal(env.h.pings,1);
 // Repeating the same pushed state must not re-arm the one-shot diagnostic.
 env.h.push();
 fake.advance(1000);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(env.h.pings,1);
});

test('new progress and final completion clear a stale idle completion diagnostic',async t=>{
 const fake=clock();
 const env=await setup({readOnly:false,clock:fake,idleMs:90});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('clear-diagnostic')});
 await waitSnapshot(env,'clear-diagnostic',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='partial before diagnostic';
 response.complete=false;
 env.h.push();
 fake.advance(90);
 const diagnostic=await waitSnapshot(env,'clear-diagnostic',data=>data.metadata.completion_unverified===true,2000);
 assert.equal(diagnostic.metadata.completion_unverified_reason,'idle_answer_unverified');
 response.answer='partial plus new progress';
 env.h.push();
 const progressed=await waitSnapshot(env,'clear-diagnostic',data=>data.metadata.completion_unverified===undefined,2000);
 assert.equal(progressed.metadata.completion_unverified_reason,undefined);
 assert.equal(progressed.status,'generating');
 assert.equal(progressed.result.answer,'partial plus new progress');
 response.answer='final answer';
 response.complete=true;
 env.h.push();
 fake.advance(20);
 const done=await waitStatus(env,'clear-diagnostic',['completed'],3000);
 assert.equal(done.result.answer,'final answer');
 assert.equal(done.metadata.completion_unverified,undefined);
 assert.equal(done.metadata.completion_unverified_reason,undefined);
});

test('a failed idle ping invalidates evidence without fabricating a terminal state',async t=>{
 const fake=clock();
 const env=await setup({readOnly:false,clock:fake,idleMs:90});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('ping-failed')});
 await waitSnapshot(env,'ping-failed',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='pending answer';
 env.h.push();
 env.wc.emit('did-start-navigation',{url:env.h.state.url,isMainFrame:true,isSameDocument:false});
 fake.advance(90);
 const diagnostic=await waitSnapshot(env,'ping-failed',data=>data.metadata.idle_ping_ok===false,2000);
 assert.equal(diagnostic.metadata.completion_unverified,true);
 assert.equal(diagnostic.metadata.completion_unverified_reason,'idle_ping_failed');
 assert.equal(diagnostic.status,'generating');
 assert.equal(diagnostic.send_state,'confirmed');
 assert.equal(diagnostic.error.code,'COMPLETION_UNVERIFIED');
});

test('truncated observation stops completion and retains the prior full result',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('truncated')});
 await waitSnapshot(env,'truncated',data=>data.phase==='generating');
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='prior full partial';
 response.complete=false;
 env.h.push();
 await new Promise(resolve=>setTimeout(resolve,30));
 response.answer_truncated=true;
 response.complete=true;
 env.h.push();
 const failed=await waitStatus(env,'truncated',['needs_user_action']);
 assert.equal(failed.error.code,'ANSWER_TRUNCATED');
 assert.equal(failed.result.answer,'prior full partial');
 assert.notEqual(failed.result.complete,true);
 assert.equal(env.counts.send,1);
});

test('boundary user input stops the generation without marking completion',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('boundary')});
 await waitSnapshot(env,'boundary',data=>data.phase==='generating');
 env.wc.emit('before-input-event',{}, {type:'keyDown'});
 const stopped=await waitStatus(env,'boundary',['needs_user_action','uncertain']);
 assert.equal(stopped.error.code,'USER_INTERFERENCE');
 assert.equal(env.counts.send,1);
});

test('recover after user interference starts a fresh read and never resends',async t=>{
 const env=await setup({readOnly:false,initial:{url:'https://gemini.google.com/app/conv-reread',queries:[marker('reread')],responses:[{answer:'partial so far',complete:false}],composer:{action:'stop',action_label:'停止生成'}}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const raw=wire('reread',{conversation_url:'https://gemini.google.com/app/conv-reread'});
 const seeded=ledgerFor(raw,{status:'partial',phase:'generating',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),result:{answer:'partial so far',url:'https://gemini.google.com/app/conv-reread',model:'3.8 Flash',submission_confirmed:true,marker:marker('reread'),beforeResponses:0},metadata:{budget:{ms:1800000,started_at:new Date().toISOString(),deadline_ms:Date.now()+1800000,deadline_at:new Date(Date.now()+1800000).toISOString()}},phases:{prepared:{at:new Date(0).toISOString(),draft_hash:'x',attachments:[]},send_intent:{at:new Date(0).toISOString()},marker_seen:{at:new Date(0).toISOString(),url:'https://gemini.google.com/app/conv-reread'},confirmed:{at:new Date(0).toISOString(),url:'https://gemini.google.com/app/conv-reread',marker:marker('reread')},terminal:null}});
 seedLedger(env.stateDir,seeded);
 const first=await rpc(env,{op:'recover',task_id:'reread'});
 assert.equal(first.json.ok,true);
 await waitSnapshot(env,'reread',data=>data.phase==='generating'||data.status==='generating'||data.status==='partial');
 env.wc.emit('before-input-event',{}, {type:'keyDown'});
 const stopped=await waitStatus(env,'reread',['needs_user_action','uncertain']);
 assert.equal(stopped.error.code,'USER_INTERFERENCE');
 assert.equal(env.counts.send,0);
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer='finished after interrupt';
 response.complete=true;
 env.h.update({composer:{model_text:'Flash 高',aria_label:'打开模式选择器',action:'mic',action_label:'语音输入',action_test_id:''}});
 const recovered=await rpc(env,{op:'recover',task_id:'reread'});
 assert.equal(recovered.json.ok,true);
 const done=await waitStatus(env,'reread',['completed']);
 assert.equal(done.result.answer,'finished after interrupt');
 assert.equal(env.counts.send,0);
});

test('recover binds the host to the same task, retains the ledger, and never sends or types',async t=>{
 const env=await setup({readOnly:false,initial:{url:'https://gemini.google.com/app/conv-old',queries:[marker('recover')],responses:[{answer:'recovered answer',complete:true}]}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const raw=wire('recover',{conversation_url:'https://gemini.google.com/app/conv-old'});
 const seeded=ledgerFor(raw,{status:'partial',phase:'generating',result:{answer:'old partial',url:'https://gemini.google.com/app/conv-old',model:'3.8 Flash',submission_confirmed:true,marker:marker('recover'),beforeResponses:0},phases:{prepared:{at:new Date(0).toISOString(),draft_hash:'x',attachments:[]},send_intent:{at:new Date(0).toISOString()},marker_seen:{at:new Date(0).toISOString(),url:'https://gemini.google.com/app/conv-old'},confirmed:{at:new Date(0).toISOString(),url:'https://gemini.google.com/app/conv-old',marker:marker('recover')},terminal:null}});
 seedLedger(env.stateDir,seeded);
 const recovered=await rpc(env,{op:'recover',task_id:'recover'});
 assert.equal(recovered.json.ok,true);
 const done=await waitStatus(env,'recover',['completed']);
 assert.equal(done.result.answer,'recovered answer');
 assert.equal(done.result.submission_confirmed,true);
 assert.equal(env.counts.send,0);
 assert.equal(env.counts.type,0);
 assert.equal(env.counts.upload,0);
 assert.equal(env.host.taskId,'recover');
 const ledger=JSON.parse(fs.readFileSync(path.join(env.stateDir,'bridge-tasks','recover.json'),'utf8'));
 assert.equal(ledger.content_hash,seeded.content_hash);
 assert.ok(ledger.phases.confirmed);
});

test('a persisted send intent without confirmation is never resent after restart',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const raw=wire('sent-unknown');
 const seeded=ledgerFor(raw,{status:'uncertain',phase:'uncertain',result:{answer:'',url:null,model:'3.8 Flash',submission_confirmed:false,marker:marker('sent-unknown'),beforeResponses:0},error:{code:'SEND_STATE_UNKNOWN',message:'old'},phases:{prepared:{at:new Date(0).toISOString(),draft_hash:'x',attachments:[]},send_intent:{at:new Date(0).toISOString()},marker_seen:null,confirmed:null,terminal:null}});
 seedLedger(env.stateDir,seeded);
 const replay=await rpc(env,{op:'execute',task:raw});
 assert.equal(replay.json.data.status,'uncertain');
 assert.equal(env.counts.send,0);
 const recovered=await rpc(env,{op:'recover',task_id:'sent-unknown'});
 assert.equal(recovered.json.data.status,'uncertain');
 assert.equal(env.counts.send,0);
});

test('oversized answers produce a lightweight snapshot_required event while REST keeps the full result',async t=>{
 const env=await setup({readOnly:false,initial:{},maxPayloadBytes:8*1024*1024,maxAnswerBytes:4*1024*1024});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('large')});
 await waitSnapshot(env,'large',data=>data.phase==='generating');
 const answer='x'.repeat(2*1024*1024+250000);
 const response=env.h.state.responses[env.h.state.responses.length-1];
 response.answer=answer;
 response.complete=true;
 env.h.push();
 const done=await waitStatus(env,'large',['completed'],10000);
 assert.equal(done.result.answer.length,answer.length);
 const journal=JSON.parse(fs.readFileSync(path.join(env.stateDir,'bridge-events.json'),'utf8'));
 const event=journal.events.at(-1);
 assert.equal(event.type,'snapshot');
 assert.equal(event.snapshot_required,true);
 assert.equal(event.snapshot,undefined);
 const rest=await rpc(env,{op:'snapshot',task_id:'large'});
 assert.equal(rest.json.data.result.answer.length,answer.length);
});

test('unbound observer rejects ready operations explicitly; read-only refuses execute',async t=>{
 const unbound=await setup({readOnly:false,unbound:true});
 t.after(async()=>{await unbound.handle.close();fs.rmSync(unbound.stateDir,{recursive:true,force:true});});
 const refused=await rpc(unbound,{op:'execute',task:wire('unbound')});
 assert.equal(refused.status,409);
 assert.equal(refused.json.error.code,'OBSERVATION_UNAVAILABLE');
 assert.equal(unbound.counts.observe,0);
 assert.equal(unbound.counts.send,0);
 unbound.h.hello();
 const started=await rpc(unbound,{op:'execute',task:wire('unbound')});
 assert.equal(started.status,200);
 await waitSnapshot(unbound,'unbound',data=>data.phase==='generating');
 await settleAnswer(unbound,'unbound','after bind');
 const readonly=await setup({readOnly:true});
 t.after(async()=>{await readonly.handle.close();fs.rmSync(readonly.stateDir,{recursive:true,force:true});});
 const denied=await rpc(readonly,{op:'execute',task:wire('readonly')});
 assert.equal(denied.status,403);
 assert.equal(denied.json.error.code,'READ_ONLY');
});

test('shutdown closes open event subscriptions',async t=>{
 const env=await setup({readOnly:true});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const stream=await openStream(env.handle.port,{authorization:'Bearer '+env.discovery.token});
 assert.equal(stream.res.statusCode,200);
 const closed=new Promise(resolve=>{
  stream.res.once('end',()=>resolve(true));
  stream.res.once('close',()=>resolve(true));
  stream.res.once('error',()=>resolve(true));
  stream.req.once('close',()=>resolve(true));
 });
 await env.handle.close();
 const didClose=await Promise.race([closed,new Promise(resolve=>setTimeout(()=>resolve(false),500))]);
 assert.equal(didClose,true);
});

test('SSE and RPC share auth, Host and Origin checks; subscriptions are bounded',async t=>{
 const env=await setup({readOnly:true});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const port=env.handle.port,auth={authorization:'Bearer '+env.discovery.token};
 assert.equal((await request(port,{path:'/events',method:'GET'})).status,401);
 assert.equal((await request(port,{path:'/events',method:'GET',headers:{...auth,origin:'http://127.0.0.1'}})).status,403);
 assert.equal((await request(port,{path:'/events',method:'GET',headers:{...auth,host:'evil.example'}})).status,403);
 assert.equal((await request(port,{path:'/unknown',method:'GET',headers:auth})).status,404);
 assert.equal((await request(port,{path:'/events',method:'POST',headers:auth,body:{}})).status,405);
 assert.equal((await request(port,{path:'/rpc',method:'GET',headers:auth})).status,405);
 assert.equal((await request(port,{path:'/events',method:'GET',headers:{...auth,'last-event-id':'not-a-cursor'}})).status,400);
 const streams=[];
 for(let i=0;i<4;i++)streams.push(await openStream(port,auth));
 assert.equal(streams.every(stream=>stream.res.statusCode===200),true);
 const limited=await request(port,{path:'/events',method:'GET',headers:auth});
 assert.equal(limited.status,429);
 assert.equal(limited.json.error.code,'TOO_MANY_SUBSCRIPTIONS');
 for(const stream of streams)stream.req.destroy();
 const syncWithId=await rpc(env,{op:'sync',task_id:'x'});
 assert.equal(syncWithId.status,400);
});
test('persisted budget exhaustion occupies a generation slot after loss of in-memory activeId',async t=>{
 const env=await setup({readOnly:false});t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const held=wire('budget-held');
 seedLedger(env.stateDir,ledgerFor(held,{status:'partial',phase:'generating',metadata:{budget_exhausted:true},phases:{prepared:null,send_intent:{at:new Date(0).toISOString()},confirmed:{at:new Date(0).toISOString(),url:'https://gemini.google.com/app/held'},terminal:null}}));
 const probe=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(probe.generating_limit,3);
 assert.equal(probe.generating_count,1);
 assert.deepEqual(probe.generating_task_ids,['budget-held']);
 const allowed=await rpc(env,{op:'execute',task:wire('new-after-budget')});
 assert.equal(allowed.json.ok,true,JSON.stringify(allowed.json));
 assert.equal(env.counts.send,1);
});

test('read-only ready waits for a delayed observer hello without page scripts, navigation, or execute',async t=>{
 const env=await setup({readOnly:true,unbound:true,readyMs:2000});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const pending=rpc(env,{op:'ready'});
 const deadline=Date.now()+2000;
 while(env.host._waiters.size===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 assert.ok(env.host._waiters.size>0,'ready must register one observer waiter before hello');
 env.h.hello();
 const result=await pending;
 assert.equal(result.status,200);
 assert.equal(result.json.ok,true);
 assert.equal(result.json.data.warming,false);
 assert.equal(result.json.data.read_only,true);
 assert.equal(result.json.data.page.usable,true);
 assert.equal(result.json.data.page.fault,null);
 assert.equal(env.counts.observe,0);
 assert.equal(env.counts.nav,0);
 assert.equal(env.counts.send,0);
 assert.equal(env.counts.type,0);
});

test('unbound ready times out as warming without faking login or read-only',async t=>{
 const env=await setup({readOnly:false,unbound:true,readyMs:25});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const started=Date.now();
 const result=await rpc(env,{op:'ready'});
 assert.ok(Date.now()-started<2000);
 assert.equal(result.status,200);
 assert.equal(result.json.ok,true);
 assert.equal(result.json.data.warming,true);
 assert.equal(result.json.data.read_only,false);
 assert.equal(result.json.data.connected,false);
 assert.equal(result.json.data.page,null);
 assert.equal(result.json.data.error.code,'OBSERVER_NOT_BOUND');
 assert.equal(env.counts.observe,0);
 assert.equal(env.counts.nav,0);
 assert.equal(env.counts.send,0);
});

test('a bound but not-yet-usable page reports warming rather than a user fault',async t=>{
 const env=await setup({readOnly:false,readyMs:25,initial:{hasInput:false}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const result=await rpc(env,{op:'ready'});
 assert.equal(result.status,200);
 assert.equal(result.json.data.warming,true);
 assert.equal(result.json.data.read_only,false);
 assert.equal(result.json.data.connected,true);
 assert.equal(result.json.data.page.usable,false);
 assert.equal(result.json.data.page.fault,null);
 assert.equal(result.json.data.error.code,'BRIDGE_PAGE_NOT_READY');
 assert.equal(env.counts.observe,0);
 assert.equal(env.counts.send,0);
});

test('probe reports the real background throttling state during execution and after restore',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const idle=await rpc(env,{op:'probe'});
 assert.equal(idle.status,200);
 assert.deepEqual(Object.keys(idle.json.data.background_throttling).sort(),['applied','current','error','previous','supported']);
 assert.equal(idle.json.data.background_throttling.supported,true);
 assert.equal(idle.json.data.background_throttling.applied,false);
 assert.equal(idle.json.data.background_throttling.previous,null);
 assert.equal(idle.json.data.background_throttling.current,null,'no boolean is reported before any read');
 assert.equal(idle.json.data.background_throttling.error,null);
 await rpc(env,{op:'execute',task:wire('throttle')});
 await waitSnapshot(env,'throttle',data=>data.phase==='generating');
 const active=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(active.background_throttling.supported,true);
 assert.equal(active.background_throttling.applied,true);
 assert.equal(active.background_throttling.previous,null);
 assert.equal(active.background_throttling.current,false,'the page must actually read back as un-throttled while generating');
 assert.equal(active.background_throttling.error,null);
 assert.equal(active.page.width,1200);
 assert.equal(active.page.height,800);
 assert.equal(active.page.visibility,'visible');
 await settleAnswer(env,'throttle','answer for '+marker('throttle'));
 const restored=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(restored.background_throttling.applied,false);
 assert.equal(restored.background_throttling.current,true,'the previous value must be restored after the task ends');
 assert.equal(env.counts.observe,0);
});

test('a rejected setBackgroundThrottling stays visible as a bounded probe error',async t=>{
 const env=await setup({readOnly:false});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 env.wc.setBackgroundThrottling=()=>{throw new Error('throttling rejected');};
 await rpc(env,{op:'execute',task:wire('throttle-error')});
 await waitSnapshot(env,'throttle-error',data=>data.phase==='generating');
 const diagnostic=(await rpc(env,{op:'probe'})).json.data.background_throttling;
 assert.equal(diagnostic.supported,true);
 assert.equal(diagnostic.applied,false);
 assert.equal(diagnostic.error.code,'THROTTLE_ATTACH_FAILED');
 assert.equal(diagnostic.error.message,'throttling rejected');
 assert.ok(diagnostic.error.message.length<=300);
 await settleAnswer(env,'throttle-error','still completed');
 assert.equal(env.counts.send,1);
});

test('ready derives an explicit login fault from pushed state instead of warming',async t=>{
 const env=await setup({readOnly:false,readyMs:1000,initial:{controls:[{label:'登录',text:'登录'}]}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const result=await rpc(env,{op:'ready'});
 assert.equal(result.status,200);
 assert.equal(result.json.data.warming,false);
 assert.equal(result.json.data.page.fault,'LOGIN_REQUIRED');
 assert.equal(result.json.data.error.code,'LOGIN_REQUIRED');
 assert.equal(result.json.data.read_only,false);
 assert.equal(env.counts.send,0);
});

function extraViews(options={}){
 const extras=[];
 const factory=()=>{
  const extra=createHarness({},options);
  extra.hello();
  extras.push(extra);
  return {wc:extra.wc,observation:extra.host,api:extra,close(){try{extra.host.close();}catch{}}};
 };
 factory.extras=extras;
 return factory;
}

test('the explicit attach preload path is forwarded to an extra view factory',async t=>{
 const calls=[];
 const factory=(source,options)=>{
  calls.push({source,options});
  const extra=createHarness();
  extra.hello();
  return {wc:extra.wc,observation:extra.host,close(){try{extra.host.close();}catch{}}};
 };
 const preloadPath=path.join(os.tmpdir(),'gemini-explicit-preload','preload.js');
 const env=await setup({readOnly:false,createConversationView:factory,preloadPath});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('preload-holder')});
 await waitSnapshot(env,'preload-holder',data=>data.phase==='generating'||data.status==='generating');
 await rpc(env,{op:'execute',task:wire('preload-forward')});
 await waitSnapshot(env,'preload-forward',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(calls.length,1);
 assert.equal(calls[0].source,env.wc);
 assert.deepEqual(calls[0].options,{show:false,preloadPath});
});

test('late recovery reuses a retained extra page and keeps additional views bounded',async t=>{
 const factory=extraViews({behavior:{confirmUrl:false}});
 const env=await setup({readOnly:false,confirmationMs:30,createConversationView:factory,initial:{
  url:'https://gemini.google.com/app/unrelated',surface:{mode:null,selected:null,options:[]}
 }});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 for(const id of ['extra-late-one','extra-late-two','extra-late-three']){
  await rpc(env,{op:'execute',task:wire(id)});
  assert.equal((await waitStatus(env,id,['uncertain'])).error.code,'SEND_UNCONFIRMED_URL');
 }
 await rpc(env,{op:'execute',task:wire('extra-late-overflow')});
 const blocked=await waitStatus(env,'extra-late-overflow',['needs_user_action']);
 assert.equal(blocked.error.code,'SESSION_VIEW_UNAVAILABLE');
 assert.equal(factory.extras.length,3);
 const first=factory.extras[0];
 const url='https://gemini.google.com/app/recovered-extra';
 first.update({url,responses:[{answer:'reply from original extra page',complete:true}]});
 await rpc(env,{op:'recover',task_id:'extra-late-one'});
 const done=await waitStatus(env,'extra-late-one',['completed']);
 assert.equal(done.result.url,url);
 assert.equal(done.result.answer,'reply from original extra page');
 assert.equal(first.counts.send,1);
 assert.equal(env.counts.send,0);
 assert.equal(factory.extras.length,3);
});

test('an independent task opens a new chat instead of reusing the previous conversation',async t=>{
 const env=await setup({readOnly:false,initial:{url:'https://gemini.google.com/app/old-chat',queries:['previous'],responses:[{answer:'old',complete:true}]}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('fresh-chat')});
 await waitSnapshot(env,'fresh-chat',data=>data.phase==='generating'||data.status==='generating');
 assert.ok(env.counts.newChat>=1);
 assert.equal(env.h.state.url.startsWith('https://gemini.google.com/app/conv-'),true);
 assert.ok(env.h.state.queries.some(item=>String(item).includes('fresh-chat')));
});

test('an independent task avoids a restored primary page whose mode control is missing',async t=>{
 const factory=extraViews();
 const env=await setup({readOnly:false,createConversationView:factory,initial:{
  url:'https://gemini.google.com/app/old-chat',queries:['previous'],responses:[{answer:'old',complete:true}],
  surface:{mode:null,selected:null,options:[]}
 }});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('safe-page')});
 const generating=await waitSnapshot(env,'safe-page',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(factory.extras.length,1,'an unknown-mode primary must not be reused for a new chat');
 assert.equal(env.counts.type+env.counts.send+env.counts.newChat+env.counts.nav,0,'the restored primary conversation is left untouched');
 assert.equal(factory.extras[0].counts.send,1);
 assert.equal(generating.result.url,'https://gemini.google.com/app/conv-1');
 assert.equal(page.sameConversation(generating.result.url,'https://gemini.google.com/app/old-chat'),false,'the task never lands on the old conversation');
});

test('a new session waits for the pushed mode instead of switching or guessing',async t=>{
 const extras=[];
 const factory=()=>{
  const extra=createHarness({surface:{mode:null,selected:null,options:[]}});
  extra.hello();
  extras.push(extra);
  return {wc:extra.wc,observation:extra.host,close(){try{extra.host.close();}catch{}}};
 };
 const env=await setup({readOnly:false,createConversationView:factory,prepareMs:1500});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('mode-holder')});
 await waitSnapshot(env,'mode-holder',data=>data.phase==='generating'||data.status==='generating');
 await rpc(env,{op:'execute',task:wire('late-mode')});
 const created=Date.now()+2000;
 while(extras.length===0&&Date.now()<created)await delay(5);
 assert.equal(extras.length,1);
 await delay(120);
 assert.equal(extras[0].counts.send,0,'an input-ready page without a mode control must not send');
 assert.equal(extras[0].counts.surface,0,'nobody may click a mode control that has not been observed');
 assert.equal(extras[0].counts.newChat,0);
 extras[0].update({surface:{mode:'chat',selected:'对话',options:[{text:'对话',selected:true,checked:true},{text:'任务',selected:false,checked:false}]}});
 const generating=await waitSnapshot(env,'late-mode',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(extras[0].counts.surface,0,'the pushed chat mode is kept without a blind switch');
 assert.equal(extras[0].counts.send,1);
 assert.equal(generating.result.actual_mode,'chat');
});

test('a new session that never exposes a mode fails bounded without sending',async t=>{
 const extras=[];
 const factory=()=>{
  const extra=createHarness({surface:{mode:null,selected:null,options:[]}});
  extra.hello();
  extras.push(extra);
  return {wc:extra.wc,observation:extra.host,close(){try{extra.host.close();}catch{}}};
 };
 const env=await setup({readOnly:false,createConversationView:factory,prepareMs:250});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('mode-holder-2')});
 await waitSnapshot(env,'mode-holder-2',data=>data.phase==='generating'||data.status==='generating');
 await rpc(env,{op:'execute',task:wire('no-mode')});
 const failed=await waitStatus(env,'no-mode',['needs_user_action','uncertain','failed'],5000);
 assert.equal(failed.status,'needs_user_action');
 assert.equal(failed.error.code,'MODE_CONTROL_UNIDENTIFIED');
 assert.equal(extras.length,1);
 assert.equal(extras[0].counts.send,0);
 assert.equal(extras[0].counts.surface,0);
 assert.equal(extras[0].counts.newChat,0);
 const probe=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(probe.ui_lock,null);
 const released=await rpc(env,{op:'release',task_id:'no-mode'});
 assert.equal(released.json.ok,true,JSON.stringify(released.json));
});

test('a continued task stays on the parent conversation url',async t=>{
 const env=await setup({readOnly:false,behavior:{confirmUrl:'https://gemini.google.com/app/conv-parent'},initial:{url:'https://gemini.google.com/app/conv-parent',queries:['parent'],responses:[{answer:'done',complete:true}]}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('follow-up',{conversation_url:'https://gemini.google.com/app/conv-parent'})});
 await waitSnapshot(env,'follow-up',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(env.counts.newChat,0);
 assert.equal(env.counts.nav,0);
 assert.equal(env.h.state.url,'https://gemini.google.com/app/conv-parent');
});

test('the fourth concurrent generation stays queued at the generation limit',async t=>{
 const factory=extraViews();
 const env=await setup({readOnly:false,createConversationView:factory});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const ids=['slot-1','slot-2','slot-3','slot-4'];
 for(const id of ids){
  const result=await rpc(env,{op:'execute',task:wire(id)});
  if(id==='slot-4'){
   assert.equal(result.status,409);
   assert.equal(result.json.error.code,'GENERATION_LIMIT');
  }else{
   assert.equal(result.json.ok,true,id+' '+JSON.stringify(result.json));
   await waitSnapshot(env,id,data=>data.phase==='generating'||data.status==='generating');
  }
 }
 const probe=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(probe.generating_limit,3);
 assert.equal(probe.generating_count,3);
 assert.equal(env.counts.send+factory.extras.reduce((n,item)=>n+item.counts.send,0),3);
});

test('a freed generation slot can start the next independent task',async t=>{
 const factory=extraViews();
 const env=await setup({readOnly:false,createConversationView:factory});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 for(const id of ['free-1','free-2','free-3']){
  await rpc(env,{op:'execute',task:wire(id)});
  await waitSnapshot(env,id,data=>data.phase==='generating'||data.status==='generating');
 }
 const blocked=await rpc(env,{op:'execute',task:wire('free-4')});
 assert.equal(blocked.json.error.code,'GENERATION_LIMIT');
 const first=env.h;
 const response=first.state.responses[first.state.responses.length-1];
 response.answer='done-1';
 response.complete=true;
 first.push();
 await waitStatus(env,'free-1',['completed']);
 const started=await rpc(env,{op:'execute',task:wire('free-4')});
 assert.equal(started.json.ok,true,JSON.stringify(started.json));
 await waitSnapshot(env,'free-4',data=>data.phase==='generating'||data.status==='generating');
});

test('the same conversation cannot start a second concurrent generation',async t=>{
 const env=await setup({readOnly:false,initial:{url:'https://gemini.google.com/app/conv-same',queries:['one'],responses:[{answer:'ok',complete:true}]}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('same-a',{conversation_url:'https://gemini.google.com/app/conv-same'})});
 await waitSnapshot(env,'same-a',data=>data.phase==='generating'||data.status==='generating');
 const blocked=await rpc(env,{op:'execute',task:wire('same-b',{conversation_url:'https://gemini.google.com/app/conv-same'})});
 assert.equal(blocked.status,409);
 assert.equal(blocked.json.error.code,'CONVERSATION_BUSY');
 assert.equal(env.counts.send,1);
});

test('a task still preparing keeps exclusive ownership of its page',async t=>{
 const factory=extraViews();
 const env=await setup({readOnly:false,createConversationView:factory});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 let releaseType=null,enteredType=null;
 const gate=new Promise(resolve=>{releaseType=resolve;});
 const entered=new Promise(resolve=>{enteredType=resolve;});
 const original=env.h.wc.executeJavaScript;
 env.h.wc.executeJavaScript=async code=>{
  if(code.includes('gemini-page:type-prompt')){
   enteredType();
   await gate;
  }
  return original(code);
 };
 const first=rpc(env,{op:'execute',task:wire('prep-first')});
 await entered;
 const second=await rpc(env,{op:'execute',task:wire('prep-second')});
 assert.equal(second.json.ok,true,JSON.stringify(second.json));
 await waitSnapshot(env,'prep-second',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(factory.extras.length,1,'the second task must get its own WebContents');
 assert.equal(env.h.state.draft,'','the first task keeps its own page untouched');
 assert.equal(env.host.taskId,'prep-first');
 assert.equal(factory.extras[0].host.taskId,'prep-second');
 assert.equal(factory.extras[0].counts.nav,0,'a custom view already on Gemini is not navigated again');
 assert.ok(String(factory.extras[0].state.typedText||'').startsWith(marker('prep-second')));
 releaseType();
 await waitSnapshot(env,'prep-first',data=>data.phase==='generating'||data.status==='generating');
 assert.ok(String(env.h.state.typedText||'').startsWith(marker('prep-first')));
 assert.equal(env.counts.send,1);
 assert.equal(factory.extras[0].counts.send,1);
});

test('a rejected attach reaches failure cleanup and never leaves release denied',async t=>{
 const factory=()=>{throw Object.assign(new Error('no extra view'),{code:'SESSION_VIEW_UNAVAILABLE'});};
 const env=await setup({readOnly:false,createConversationView:factory});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('attach-holder')});
 await waitSnapshot(env,'attach-holder',data=>data.phase==='generating'||data.status==='generating');
 const started=await rpc(env,{op:'execute',task:wire('attach-failed')});
 assert.equal(started.json.ok,true,JSON.stringify(started.json));
 const failed=await waitStatus(env,'attach-failed',['needs_user_action','failed','uncertain']);
 assert.equal(failed.status,'needs_user_action');
 assert.equal(failed.error.code,'SESSION_VIEW_UNAVAILABLE');
 const probe=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(probe.ui_lock,null);
 const released=await rpc(env,{op:'release',task_id:'attach-failed'});
 assert.equal(released.status,200,JSON.stringify(released.json));
 assert.equal(released.json.ok,true);
});

test('a created view is closed when host binding fails before the run starts',async t=>{
 let closed=0;
 const extra=createHarness();
 extra.hello();
 const factory=()=>({wc:extra.wc,close(){closed+=1;}});
 const env=await setup({readOnly:false,createConversationView:factory});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('bind-holder')});
 await waitSnapshot(env,'bind-holder',data=>data.phase==='generating'||data.status==='generating');
 await rpc(env,{op:'execute',task:wire('bind-failed')});
 const failed=await waitStatus(env,'bind-failed',['needs_user_action','failed','uncertain']);
 assert.equal(failed.status,'needs_user_action');
 assert.equal(failed.error.code,'SESSION_VIEW_UNAVAILABLE');
 assert.equal(closed,1,'a created extra view must be closed on binding failure');
 const released=await rpc(env,{op:'release',task_id:'bind-failed'});
 assert.equal(released.json.ok,true,JSON.stringify(released.json));
});

test('an extra view that greets late is bound before hello and still sends once',async t=>{
 const extras=[];
 const factory=()=>{
  const extra=createHarness();
  extras.push(extra);
  return {wc:extra.wc,observation:extra.host,close(){try{extra.host.close();}catch{}}};
 };
 const env=await setup({readOnly:false,createConversationView:factory,prepareMs:2000});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('hello-holder')});
 await waitSnapshot(env,'hello-holder',data=>data.phase==='generating'||data.status==='generating');
 await rpc(env,{op:'execute',task:wire('late-hello')});
 const created=Date.now()+2000;
 while(extras.length===0&&Date.now()<created)await delay(5);
 assert.equal(extras.length,1,'the task must get its own view');
 const bound=Date.now()+2000;
 let pending=null;
 while(Date.now()<bound){
  pending=(await rpc(env,{op:'snapshot',task_id:'late-hello'})).json.data;
  if(extras[0].host.taskId==='late-hello'||pending.error)break;
  await delay(5);
 }
 assert.equal(pending.error,null,'a pending hello must not fail as an unbound observer');
 assert.equal(pending.status,'connecting','the task waits for the pushed handshake');
 assert.equal(extras[0].host.taskId,'late-hello','the task id is recorded before the page greets');
 assert.equal(extras[0].host.binding,null,'a silent view has no binding yet');
 assert.equal(extras[0].counts.type+extras[0].counts.send+extras[0].counts.nav+extras[0].counts.observe,0,'no page operation before the handshake');
 extras[0].hello();
 await waitSnapshot(env,'late-hello',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(extras[0].counts.send,1,'the extra page sends exactly once after the delayed hello');
 assert.equal(env.counts.send,1,'the primary page is untouched by the second task');
 assert.equal(env.host.taskId,'hello-holder');
 assert.ok(String(extras[0].state.typedText||'').startsWith(marker('late-hello')));
});

test('an extra view that never greets fails bounded, touches no page, and is released',async t=>{
 let closed=0;
 const extras=[];
 const factory=()=>{
  const extra=createHarness();
  extras.push(extra);
  return {wc:extra.wc,observation:extra.host,close(){closed+=1;try{extra.host.close();}catch{}}};
 };
 const env=await setup({readOnly:false,createConversationView:factory,prepareMs:60});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('silent-holder')});
 await waitSnapshot(env,'silent-holder',data=>data.phase==='generating'||data.status==='generating');
 const started=Date.now();
 await rpc(env,{op:'execute',task:wire('no-hello')});
 const failed=await waitStatus(env,'no-hello',['needs_user_action','failed','uncertain'],4000);
 assert.ok(Date.now()-started<3000,'the handshake wait must be bounded');
 assert.equal(failed.status,'needs_user_action');
 assert.equal(failed.error.code,'OBSERVATION_UNAVAILABLE');
 assert.equal(extras.length,1);
 const extra=extras[0];
 assert.equal(extra.counts.type+extra.counts.send+extra.counts.nav+extra.counts.observe,0,'no page operation without a handshake');
 assert.equal(closed,1,'the unbound view is closed with the task');
 const probe=(await rpc(env,{op:'probe'})).json.data;
 assert.equal(probe.ui_lock,null);
 assert.equal(probe.active_tasks.includes('no-hello'),false);
 const released=await rpc(env,{op:'release',task_id:'no-hello'});
 assert.equal(released.status,200,JSON.stringify(released.json));
 assert.equal(released.json.ok,true);
});

test('a blank extra view is loaded once after binding, then greets and sends',async t=>{
 const extras=[];
 const factory=()=>{
  const extra=createHarness({url:'about:blank'});
  const loads=[],helloBeforeLoad=[];
  const original=extra.wc.loadURL;
  extra.wc.loadURL=async url=>{helloBeforeLoad.push(extra.host.diagnostics.hello);loads.push(url);return original(url);};
  extra.loads=loads;extra.helloBeforeLoad=helloBeforeLoad;
  extras.push(extra);
  return {wc:extra.wc,observation:extra.host,close(){try{extra.host.close();}catch{}}};
 };
 const env=await setup({readOnly:false,createConversationView:factory,prepareMs:1500});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('blank-holder')});
 await waitSnapshot(env,'blank-holder',data=>data.phase==='generating'||data.status==='generating');
 const started=Date.now();
 await rpc(env,{op:'execute',task:wire('blank-extra')});
 const generating=await waitSnapshot(env,'blank-extra',data=>data.phase==='generating'||data.status==='generating');
 assert.ok(Date.now()-started<3000,'a blank page must not wait for the full preparation deadline');
 assert.equal(extras.length,1,'the second task must get its own WebContents');
 const extra=extras[0];
 assert.deepEqual(extra.helloBeforeLoad,[0],'the page must not greet before the first load starts');
 assert.deepEqual(extra.loads,['https://gemini.google.com/app'],'the blank page is loaded exactly once to a valid Gemini entry');
 assert.equal(page.validUrl(extra.loads[0]),'https://gemini.google.com/app');
 assert.equal(page.hasConversationId(extra.loads[0]),false,'a new task must not reuse a business conversation as its entry');
 assert.equal(extra.counts.nav,1);
 assert.equal(extra.host.diagnostics.hello,1,'the loaded page greets exactly once');
 assert.equal(extra.host.binding&&extra.host.binding.task_id,'blank-extra','the hello binds the task id recorded before the load');
 assert.equal(generating.error,null,'loading the entry must not surface an interference fault');
 assert.equal(extra.counts.send,1,'the blank page sends exactly once after greeting');
 assert.equal(env.counts.send,1,'the primary page is untouched');
});

test('a blank extra view whose first load fails is closed, bounded, and released',async t=>{
 let closed=0;
 const extra=createHarness({url:'about:blank'});
 extra.wc.loadURL=async()=>{extra.counts.nav+=1;throw Object.assign(new Error('ERR_FAILED'),{code:'ERR_FAILED'});};
 const factory=()=>({wc:extra.wc,observation:extra.host,close(){closed+=1;try{extra.host.close();}catch{}}});
 const env=await setup({readOnly:false,createConversationView:factory,prepareMs:400});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('fail-holder')});
 await waitSnapshot(env,'fail-holder',data=>data.phase==='generating'||data.status==='generating');
 const started=Date.now();
 await rpc(env,{op:'execute',task:wire('blank-load-fail')});
 const failed=await waitStatus(env,'blank-load-fail',['needs_user_action','failed','uncertain'],4000);
 assert.ok(Date.now()-started<3000,'a failed first load must fail bounded');
 assert.equal(failed.status,'needs_user_action');
 assert.equal(failed.error.code,'NAVIGATION_FAILED');
 assert.equal(extra.counts.nav,1,'only one load attempt is made');
 assert.equal(extra.counts.type+extra.counts.send+extra.counts.observe,0,'no page operation after the load failure');
 assert.equal(closed,1,'the failed extra view is closed');
 assert.equal(extra.host.binding,null,'a failed load produces no binding');
 const released=await rpc(env,{op:'release',task_id:'blank-load-fail'});
 assert.equal(released.status,200,JSON.stringify(released.json));
 assert.equal(released.json.ok,true);
});

const CURRENT_MENU=[
 {id:'mode-flash-lite',text:'快速解答 3.5 Flash-Lite',visible:true,checked:false,disabled:false},
 {id:'mode-hydrogen',text:'日常帮助 4 Hydrogen',visible:true,checked:true,disabled:false},
 {id:'mode-pro',text:'深度研究 3.1 Pro',visible:true,checked:false,disabled:false},
 {id:'mode-argon',text:'代码与分析 4 Argon',visible:true,checked:false,disabled:false},
 {id:'mode-carbon-upsell',text:'高难任务 4 Carbon',visible:true,checked:false,disabled:false}
];

test('a future model can be selected by its unique menu name without changing the production list',async t=>{
 const menu=[...CURRENT_MENU,{id:'mode-test-nova',text:'实验功能 Test Nova',visible:true,checked:false,disabled:false}];
 const env=await setup({readOnly:false,initial:{models:menu},behavior:{modelsOnMenu:menu,confirmUrl:'https://gemini.google.com/app/conv-dynamic'}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('dynamic-name',{model:'Test Nova'})});
 const generating=await waitSnapshot(env,'dynamic-name',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(env.h.state.selectedId,'mode-test-nova');
 assert.equal(env.counts.model,1);
 assert.equal(generating.result.requested_model,'Test Nova');
 assert.equal(generating.result.selected_model,'Test Nova');
});

test('a future model can also be selected by its current menu id',async t=>{
 const menu=[...CURRENT_MENU,{id:'mode-test-nova',text:'实验功能 Test Nova',visible:true,checked:false,disabled:false}];
 const env=await setup({readOnly:false,initial:{models:menu},behavior:{modelsOnMenu:menu,confirmUrl:'https://gemini.google.com/app/conv-dynamic-id'}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('dynamic-id',{model:'mode-test-nova'})});
 await waitSnapshot(env,'dynamic-id',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(env.h.state.selectedId,'mode-test-nova');
 assert.equal(env.counts.model,1);
});

test('duplicate model names fail explicitly instead of picking the first entry',async t=>{
 const menu=[
  {id:'mode-test-nova-a',text:'实验功能 Test Nova',visible:true,checked:false,disabled:false},
  {id:'mode-test-nova-b',text:'测试功能 Test Nova',visible:true,checked:false,disabled:false}
 ];
 const env=await setup({readOnly:false,initial:{models:menu},behavior:{modelsOnMenu:menu}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('dynamic-ambiguous',{model:'Test Nova'})});
 const failed=await waitStatus(env,'dynamic-ambiguous',['needs_user_action']);
 assert.equal(failed.error.code,'MODEL_UNAVAILABLE');
 assert.match(failed.error.message,/多个|歧义/);
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});

test('an upsell entry is never clicked even when disabled=false',async t=>{
 const env=await setup({readOnly:false,initial:{models:CURRENT_MENU},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('carbon-upsell',{model:'4 Carbon'})});
 const failed=await waitStatus(env,'carbon-upsell',['needs_user_action']);
 assert.equal(failed.error.code,'MODEL_UNAVAILABLE');
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});

test('an omitted model defaults to Hydrogen and never silently falls back',async t=>{
 const menu=[...CURRENT_MENU,{id:'mode-test-nova',text:'实验功能 Test Nova',visible:true,checked:false,disabled:false}];
 const env=await setup({readOnly:false,initial:{models:menu},behavior:{modelsOnMenu:menu,confirmUrl:'https://gemini.google.com/app/conv-default'}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('default-hydrogen',{model:undefined})});
 const generating=await waitSnapshot(env,'default-hydrogen',data=>data.phase==='generating'||data.status==='generating');
 assert.equal(env.h.state.selectedId,'mode-hydrogen');
 assert.equal(generating.result.requested_model,'hydrogen');
 const noHydrogen=await setup({readOnly:false,initial:{models:menu.filter(item=>item.id!=='mode-hydrogen')},behavior:{modelsOnMenu:menu.filter(item=>item.id!=='mode-hydrogen')}});
 t.after(async()=>{await noHydrogen.handle.close();fs.rmSync(noHydrogen.stateDir,{recursive:true,force:true});});
 await rpc(noHydrogen,{op:'execute',task:wire('default-missing',{model:undefined})});
 const failed=await waitStatus(noHydrogen,'default-missing',['needs_user_action']);
 assert.equal(failed.error.code,'MODEL_UNAVAILABLE');
 assert.equal(noHydrogen.counts.model,0);
 assert.equal(noHydrogen.counts.send,0);
});


test('preparing pages also reserve bounded execution slots',async t=>{
 const releases=[];let entered=0;
 const hold=h=>{const run=h.wc.executeJavaScript;h.wc.executeJavaScript=async code=>{if(code.includes('gemini-page:type-prompt')){entered+=1;await new Promise(resolve=>releases.push(resolve));}return run(code);};};
 const extras=[];
 const factory=()=>{const h=createHarness();h.hello();hold(h);extras.push(h);return {wc:h.wc,observation:h.host,close(){h.host.close();}};};
 const env=await setup({readOnly:false,createConversationView:factory});hold(env.h);
 t.after(async()=>{for(const release of releases)release();await delay(30);await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 for(let i=0;i<3;i++){
  const response=await rpc(env,{op:'execute',task:wire('preparing-limit-'+i)});
  assert.equal(response.status,200);
  const deadline=Date.now()+2000;
  while(entered<=i&&Date.now()<deadline)await delay(5);
  assert.equal(entered,i+1,'the fixture must hold each task in preparation');
 }
 const fourth=await rpc(env,{op:'execute',task:wire('preparing-limit-four')});
 assert.equal(fourth.status,409,'preparation must not bypass the page bound');
 assert.equal(fourth.json.error.code,'GENERATION_LIMIT');
 assert.equal(extras.length,2);
});


test('a partially loaded menu waits for a later model option instead of guessing absence',async t=>{
 const first=[{id:'mode-flash',text:'3.8 Flash',visible:true}];
 const full=[...first,{id:'mode-delayed-nova',text:'Test Nova',visible:true}];
 const env=await setup({readOnly:false,modelMs:500,initial:{models:first},behavior:{modelsOnMenu:first}});
 const timers=[];
 t.after(async()=>{for(const timer of timers)clearTimeout(timer);await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const run=env.wc.executeJavaScript;
 env.wc.executeJavaScript=async code=>{
  const result=await run(code);
  if(code.includes('gemini-page:click-mode-menu'))timers.push(setTimeout(()=>env.h.update({models:full.map(item=>({...item,checked:item.id===env.h.state.selectedId}))}),80));
  return result;
 };
 await rpc(env,{op:'execute',task:wire('delayed-menu-model',{model:'Test Nova'})});
 const result=await waitSnapshot(env,'delayed-menu-model',data=>data.status==='generating'||data.status==='needs_user_action');
 assert.equal(result.status,'generating');assert.equal(env.h.state.selectedId,'mode-delayed-nova');
});

function preloadFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-preload-fixture-'));
 const file=path.join(dir,'preload.js');
 fs.writeFileSync(file,"'use strict';\n// fixture preload for the extra view\nwindow.fixturePreload=true;\n");
 if(t&&typeof t.after==='function')t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return file;
}
// The production factory is loaded through a VM module wrapper so require('electron')
// can resolve to this fake without adding a test-only injection point to the bridge.
function productionFactoryWithElectron(electron){
 const filename=path.join(__dirname,'..','src','desktop-bridge.cjs');
 const source=fs.readFileSync(filename,'utf8');
 const baseRequire=Module.createRequire(filename);
 const requireForBridge=id=>id==='electron'?electron:baseRequire(id);
 const wrapper=vm.runInThisContext('(function(exports,require,module,__filename,__dirname){'+source+'\n})',{filename});
 const target={exports:{}};
 wrapper(target.exports,requireForBridge,target,filename,path.dirname(filename));
 assert.equal(typeof target.exports.defaultCreateConversationView,'function');
 return target.exports.defaultCreateConversationView;
}
function electronMock(){
 const app=new EventEmitter();
 const windows=[],views=[];
 let nextId=0;
 class FakeWebContents extends EventEmitter{
  constructor(owner,webPreferences){
   super();
   this.owner=owner;this.id=++nextId;this.urls=[];this.destroyed=false;
   this.throttled=true;this.session={name:'session-'+this.id};this._prefs=webPreferences||null;
  }
  getLastWebPreferences(){return this._prefs?{...this._prefs}:null;}
  setBackgroundThrottling(value){this.throttled=value;}
  getBackgroundThrottling(){return this.throttled;}
  isDestroyed(){return this.destroyed;}
  async loadURL(url){
   this.urls.push(url);
   this.emit('did-start-navigation',{url,isMainFrame:true,isSameDocument:false});
   this.emit('did-navigate',{},url);
  }
  close(){this.destroy();}
  destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('destroyed');}
 }
 class FakeBrowserWindow extends EventEmitter{
  constructor(options={}){
   super();
   this.options=options;this.webContents=new FakeWebContents(this,options.webPreferences);
   this.destroyed=false;this.menuBarVisible=true;
   this.contentView={
    children:[],
    addChildView(view){this.children.push(view);},
    removeChildView(view){const index=this.children.indexOf(view);if(index>=0)this.children.splice(index,1);}
   };
   windows.push(this);
   app.emit('browser-window-created',{},this);
  }
  setMenuBarVisibility(visible){this.menuBarVisible=visible;}
  isDestroyed(){return this.destroyed;}
  destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('closed');}
  close(){this.destroy();}
 }
 class FakeWebContentsView{
  constructor(options={}){
   this.options=options;this.bounds=null;
   this.webContents=new FakeWebContents(this,options.webPreferences);
   views.push(this);
  }
  setBounds(bounds){this.bounds=bounds;}
 }
 const main=new FakeBrowserWindow({});
 const electron={app,BrowserWindow:FakeBrowserWindow,WebContentsView:FakeWebContentsView};
 return {electron,windows,views,main};
}
// Mirrors the stock app.asar cd(e) guard: for every non-main BrowserWindow it
// closes that window and navigates the main page when Gemini is reached.
function stockPopupGuard(mock){
 const hits=[],closed=[];
 const gemini=url=>{
  try{const host=new URL(String(url)).hostname;return host==='gemini.google.com'||host.endsWith('.gemini.google.com');}
  catch{return false;}
 };
 mock.electron.app.on('browser-window-created',(event,win)=>{
  if(win===mock.main||!win.webContents||typeof win.webContents.on!=='function')return;
  const handler=(eventOrUrl,maybeUrl)=>{
   const url=typeof maybeUrl==='string'?maybeUrl:String(eventOrUrl||'');
   if(!gemini(url))return;
   hits.push(url);closed.push(win);
   try{win.close();}catch{}
   try{mock.main.webContents.loadURL(url);}catch{}
  };
  win.webContents.on('did-navigate',handler);
  win.webContents.on('will-redirect',handler);
 });
 return {hits,closed};
}

test('the simulated stock popup guard reproduces the shell collision for a plain BrowserWindow child',async()=>{
 const mock=electronMock();
 const guard=stockPopupGuard(mock);
 const oldStyle=new mock.electron.BrowserWindow({show:false});
 await oldStyle.webContents.loadURL('https://gemini.google.com/app');
 assert.deepEqual(guard.hits,['https://gemini.google.com/app']);
 assert.equal(oldStyle.isDestroyed(),true,'the stock guard must close a navigated child window');
 assert.deepEqual(mock.main.webContents.urls,['https://gemini.google.com/app']);
});

test('production factory returns an embedded WebContentsView wc that the stock popup guard cannot reach',async t=>{
 const mock=electronMock();
 const guard=stockPopupGuard(mock);
 const factory=productionFactoryWithElectron(mock.electron);
 const source=mock.main.webContents;
 // Electron 44's GetLastWebPreferences only saves a limited dictionary and
 // never includes the preload path, so the factory must not infer it.
 source._prefs={nodeIntegration:false,nodeIntegrationInWorker:false,sandbox:true,contextIsolation:true,webSecurity:true,backgroundThrottling:true};
 source.session={name:'source-session'};
 const preloadPath=preloadFixture(t);
 const created=factory(source,{show:false,preloadPath});
 assert.ok(created&&created.wc);
 const shell=mock.windows[1];
 assert.ok(shell,'the factory must create one host BrowserWindow');
 assert.equal(created.window,shell);
 assert.notEqual(created.wc,shell.webContents,'the returned WebContents must not be the blank shell page');
 const view=mock.views[0];
 assert.ok(view,'the factory must create a WebContentsView');
 assert.equal(view.webContents,created.wc);
 assert.deepEqual(shell.contentView.children,[view]);
 assert.deepEqual(view.bounds,{x:0,y:0,width:1280,height:900});
 assert.equal(shell.options.show,false);
 assert.equal(source._prefs.preload,undefined,'the real saved dictionary has no preload');
 const prefs=view.options.webPreferences;
 assert.equal(prefs.preload,preloadPath,'the explicit preload path must reach the extra view');
 assert.equal(prefs.sandbox,true);
 assert.equal(prefs.contextIsolation,true);
 assert.equal(prefs.session,source.session,'the source session must be inherited');
 assert.equal(prefs.backgroundThrottling,false,'background throttling must stay disabled for the hidden view');
 assert.equal(view.webContents.throttled,false);
 assert.equal(shell.options.webPreferences.preload,undefined,'the blank host must not start the observer preload');
 assert.deepEqual(shell.webContents.urls,[],'the host shell must stay blank');
 assert.deepEqual(view.webContents.urls,[],'the factory must not load a document by itself');
 await created.wc.loadURL('https://gemini.google.com/app');
 assert.deepEqual(guard.hits,[],'loading Gemini in the view must not trigger the shell guard');
 assert.deepEqual(guard.closed,[]);
 assert.equal(shell.isDestroyed(),false,'the host window must survive the first Gemini load');
 assert.deepEqual(mock.main.webContents.urls,[],'the main page must never be navigated by the guard');
});

test('production factory close destroys the embedded view webContents and the host window',t=>{
 const mock=electronMock();
 const factory=productionFactoryWithElectron(mock.electron);
 const preloadPath=preloadFixture(t);
 const created=factory(mock.main.webContents,{show:false,preloadPath});
 const shell=mock.windows[1];
 const view=mock.views[0];
 assert.ok(shell&&view);
 assert.equal(view.webContents.isDestroyed(),false);
 created.close();
 assert.equal(view.webContents.isDestroyed(),true,'close must destroy the view webContents');
 assert.equal(shell.isDestroyed(),true,'close must destroy the host window');
 assert.deepEqual(shell.contentView.children,[],'the view must be detached from the host');
 created.close();
});

test('production factory releases a partially built host when the view cannot be attached',t=>{
 const mock=electronMock();
 const Base=mock.electron.BrowserWindow;
 mock.electron.BrowserWindow=class extends Base{
  constructor(options={}){
   super(options);
   this.contentView.addChildView=()=>{throw new Error('cannot attach view');};
  }
 };
 const factory=productionFactoryWithElectron(mock.electron);
 const preloadPath=preloadFixture(t);
 assert.throws(()=>factory(mock.main.webContents,{show:false,preloadPath}),/cannot attach view/);
 const shell=mock.windows[1];
 const view=mock.views[0];
 assert.ok(shell,'the host window was created');
 assert.ok(view,'the view was created before the failure');
 assert.equal(view.webContents.isDestroyed(),true,'a partially created view must not leak');
 assert.equal(shell.isDestroyed(),true,'a partially created host must not leak');
});

test('production factory rejects a missing, relative or unavailable preload path before creating a window',()=>{
 const mock=electronMock();
 const factory=productionFactoryWithElectron(mock.electron);
 assert.throws(()=>factory(mock.main.webContents,{show:false}),error=>error.code==='PRELOAD_PATH_REQUIRED');
 assert.throws(()=>factory(mock.main.webContents,{show:false,preloadPath:'relative/preload.js'}),error=>error.code==='PRELOAD_PATH_REQUIRED');
 const unavailable=path.join(os.tmpdir(),'gemini-missing-'+crypto.randomBytes(6).toString('hex'),'preload.js');
 assert.throws(()=>factory(mock.main.webContents,{show:false,preloadPath:unavailable}),error=>error.code==='PRELOAD_PATH_UNAVAILABLE');
 assert.equal(mock.windows.length,1,'no host window may be created without a usable preload');
 assert.equal(mock.views.length,0,'no view may be created without a usable preload');
});

function thinkingMenu(){
 return [
  {id:'thinking-low',text:'低',visible:false,checked:false,disabled:false,role:'menuitemradio'},
  {id:'thinking-medium',text:'中',visible:false,checked:false,disabled:false,role:'menuitemradio'},
  {id:'thinking-high',text:'高',visible:false,checked:true,disabled:false,role:'menuitemradio'}
 ];
}

test('capabilities observes the live menu, reports dynamic models/levels, and dismisses only its own menus',async t=>{
 const env=await setup({readOnly:false,modelMs:500,initial:{selectedId:'mode-hydrogen',models:[],thinkingOptions:thinkingMenu(),thinkingEntryCount:1},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const response=await rpc(env,{op:'capabilities'});
 assert.equal(response.status,200,JSON.stringify(response.json));
 const data=response.json.data;
 assert.equal(data.status,'ready');
 assert.equal(data.observed,true);
 assert.ok(!Number.isNaN(Date.parse(data.observed_at)));
 assert.equal(data.default_model,'hydrogen');
 assert.deepEqual(data.modes,{current:'chat',supported:['chat','task'],source:'contract',immutable_after_start:true});
 assert.equal(data.models.length,CURRENT_MENU.length,'every live menu entry is reported without a production list');
 const hydrogen=data.models.find(item=>item.id==='mode-hydrogen');
 assert.equal(hydrogen.name,'日常帮助 4 Hydrogen');
 assert.equal(hydrogen.selector,'mode-hydrogen');
 assert.equal(hydrogen.selected,true);
 assert.equal(hydrogen.available,true);
 assert.equal(hydrogen.unavailable_reason,null);
 const carbon=data.models.find(item=>item.id==='mode-carbon-upsell');
 assert.equal(carbon.restricted,true);
 assert.equal(carbon.available,false);
 assert.equal(carbon.unavailable_reason,'restricted');
 assert.equal(data.thinking.status,'observed');
 assert.equal(data.thinking.levels.length,3);
 assert.deepEqual(data.thinking.levels.map(item=>item.level),['low','medium','high']);
 // Query-only: no model/level/mode/send/navigation action, and no observe loop.
 assert.equal(env.counts.menu,1);
 assert.equal(env.counts.dismiss,1);
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.surface,0);
 assert.equal(env.counts.send,0);
 assert.equal(env.counts.type,0);
 assert.equal(env.counts.newChat,0);
 assert.equal(env.counts.nav,0);
 assert.equal(env.counts.observe,0);
 assert.equal(env.h.state.models.every(item=>item.visible===false),true,'cleanup must be confirmed by the observer');
 assert.equal(env.h.state.thinkingOptions.every(item=>item.visible===false),true);
 const extra=await rpc(env,{op:'capabilities',task_id:'x'});
 assert.equal(extra.status,400);
 assert.equal(extra.json.error.code,'BAD_REQUEST');
});

test('capabilities reports busy without touching a page that is already generating',async t=>{
 const env=await setup({readOnly:false,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 await rpc(env,{op:'execute',task:wire('cap-busy')});
 await waitSnapshot(env,'cap-busy',data=>data.phase==='generating'||data.status==='generating');
 const menuBefore=env.counts.menu,dismissBefore=env.counts.dismiss,modelBefore=env.counts.model;
 const data=(await rpc(env,{op:'capabilities'})).json.data;
 assert.equal(data.status,'busy');
 assert.equal(data.reason,'task_active');
 assert.deepEqual(data.models,[]);
 assert.deepEqual(data.thinking.levels,[]);
 assert.equal(env.counts.menu,menuBefore);
 assert.equal(env.counts.dismiss,dismissBefore);
 assert.equal(env.counts.model,modelBefore);
});

test('capabilities blocks a user-opened menu and an unbound or draft page without clicking',async t=>{
 const open=await setup({readOnly:false,initial:{models:baseState().models,thinkingEntryCount:1}});
 t.after(async()=>{await open.handle.close();fs.rmSync(open.stateDir,{recursive:true,force:true});});
 const blocked=(await rpc(open,{op:'capabilities'})).json.data;
 assert.equal(blocked.status,'blocked');
 assert.equal(blocked.reason,'menu_open');
 assert.equal(open.counts.menu,0);
 assert.equal(open.counts.dismiss,0);
 const unbound=await setup({readOnly:false,unbound:true});
 t.after(async()=>{await unbound.handle.close();fs.rmSync(unbound.stateDir,{recursive:true,force:true});});
 const page=(await rpc(unbound,{op:'capabilities'})).json.data;
 assert.equal(page.status,'blocked');
 assert.equal(page.reason,'page_unbound');
 assert.equal(unbound.counts.menu,0);
 const draft=await setup({readOnly:false,initial:{draft:'未发送草稿',models:[],thinkingOptions:[],thinkingEntryCount:0}});
 t.after(async()=>{await draft.handle.close();fs.rmSync(draft.stateDir,{recursive:true,force:true});});
 const draftResult=(await rpc(draft,{op:'capabilities'})).json.data;
 assert.equal(draftResult.status,'blocked');
 assert.equal(draftResult.reason,'draft');
 assert.equal(draft.counts.menu,0);
 assert.equal(draft.counts.type,0);
 const dialog=await setup({readOnly:false,initial:{dialog:true,models:[],thinkingOptions:[],thinkingEntryCount:0}});
 t.after(async()=>{await dialog.handle.close();fs.rmSync(dialog.stateDir,{recursive:true,force:true});});
 const dialogResult=(await rpc(dialog,{op:'capabilities'})).json.data;
 assert.equal(dialogResult.status,'blocked');
 assert.equal(dialogResult.reason,'user_dialog');
 assert.equal(dialog.counts.menu,0);
});

test('capabilities never reports ready when this query cannot confirm menu cleanup',async t=>{
 const env=await setup({readOnly:false,modelMs:80,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:CURRENT_MENU,dismissLeavesOpen:true}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const data=(await rpc(env,{op:'capabilities'})).json.data;
 assert.equal(data.status,'unavailable');
 assert.equal(data.reason,'cleanup_unconfirmed');
 assert.deepEqual(data.models,[]);
 assert.equal(data.thinking.status,'unknown');
 assert.deepEqual(data.thinking.levels,[]);
 assert.equal(env.counts.dismiss,1);
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});

test('the capability lease is taken before the first await so execute/recover/settings_action cannot slip in',async t=>{
 let entered=null,release=null;
 const gate=new Promise(resolve=>{release=resolve;});
 const reached=new Promise(resolve=>{entered=resolve;});
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const run=env.wc.executeJavaScript;
 env.wc.executeJavaScript=async code=>{
  if(code.includes('gemini-page:click-mode-menu')){entered();await gate;}
  return run(code);
 };
 const pending=rpc(env,{op:'capabilities'});
 await reached;
 const deniedExecute=await rpc(env,{op:'execute',task:wire('late-task')});
 assert.equal(deniedExecute.status,409);
 assert.equal(deniedExecute.json.error.code,'BUSY');
 assert.equal(fs.existsSync(path.join(env.stateDir,'bridge-tasks','late-task.json')),false,'a rejected task must not create a ledger');
 const deniedRecover=await rpc(env,{op:'recover',task_id:'late-task'});
 assert.equal(deniedRecover.status,409);
 assert.equal(deniedRecover.json.error.code,'BUSY');
 const deniedSettings=await rpc(env,{op:'settings_action',action:'models'});
 assert.equal(deniedSettings.status,409);
 assert.equal(deniedSettings.json.error.code,'BUSY');
 release();
 const data=(await pending).json.data;
 assert.equal(data.status,'ready');
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
 assert.equal(env.counts.type,0);
 assert.equal(env.counts.menu,1);
});

test('user keyboard input during a capability query returns control without further clicks',async t=>{
 let entered=null,release=null;
 const gate=new Promise(resolve=>{release=resolve;});
 const reached=new Promise(resolve=>{entered=resolve;});
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const run=env.wc.executeJavaScript;
 env.wc.executeJavaScript=async code=>{
  if(code.includes('gemini-page:click-mode-menu')){entered();await gate;}
  return run(code);
 };
 const pending=rpc(env,{op:'capabilities'});
 await reached;
 env.wc.emit('before-input-event',{}, {type:'keyDown'});
 release();
 const data=(await pending).json.data;
 assert.equal(data.status,'unavailable');
 assert.equal(data.reason,'user_interference');
 assert.deepEqual(data.models,[]);
 assert.equal(env.counts.dismiss,0,'after user intervention the query must not click again');
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});

test('settings_action reserves the page before its first await so capabilities/execute/recover/settings cannot slip in',async t=>{
 let entered=null,release=null;
 const gate=new Promise(resolve=>{release=resolve;});
 const reached=new Promise(resolve=>{entered=resolve;});
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const run=env.wc.executeJavaScript;
 env.wc.executeJavaScript=async code=>{
  if(code.includes('gemini-page:observe')){entered();await gate;}
  return run(code);
 };
 const pending=rpc(env,{op:'settings_action',action:'models'});
 await reached;
 const deniedCapabilities=await rpc(env,{op:'capabilities'});
 assert.equal(deniedCapabilities.status,200);
 assert.equal(deniedCapabilities.json.data.status,'busy');
 assert.equal(deniedCapabilities.json.data.reason,'settings_action');
 assert.deepEqual(deniedCapabilities.json.data.models,[]);
 assert.equal(env.counts.menu,0,'a denied capability query must not open the model menu');
 const deniedExecute=await rpc(env,{op:'execute',task:wire('reverse-race')});
 assert.equal(deniedExecute.status,409);
 assert.equal(deniedExecute.json.error.code,'BUSY');
 assert.equal(fs.existsSync(path.join(env.stateDir,'bridge-tasks','reverse-race.json')),false,'a denied execute must not create a ledger');
 const deniedRecover=await rpc(env,{op:'recover',task_id:'reverse-race'});
 assert.equal(deniedRecover.status,409);
 assert.equal(deniedRecover.json.error.code,'BUSY');
 const deniedSettings=await rpc(env,{op:'settings_action',action:'models'});
 assert.equal(deniedSettings.status,409);
 assert.equal(deniedSettings.json.error.code,'BUSY');
 release();
 const applied=await pending;
 assert.equal(applied.status,200,JSON.stringify(applied.json));
 assert.equal(applied.json.ok,true);
 const catalog=await rpc(env,{op:'capabilities'});
 assert.equal(catalog.status,200,JSON.stringify(catalog.json));
 assert.equal(catalog.json.data.status,'ready');
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});

test('a failed settings_action still releases its page reservation',async t=>{
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const run=env.wc.executeJavaScript;
 let failObserve=true;
 env.wc.executeJavaScript=async code=>{
  if(code.includes('gemini-page:observe')&&failObserve)throw new Error('observe exploded');
  return run(code);
 };
 const failed=await rpc(env,{op:'settings_action',action:'models'});
 assert.equal(failed.status,500);
 assert.equal(failed.json.ok,false);
 failObserve=false;
 const catalog=await rpc(env,{op:'capabilities'});
 assert.equal(catalog.status,200,JSON.stringify(catalog.json));
 assert.equal(catalog.json.data.status,'ready','the reservation must be released even when observe fails');
});

test('a capability query loses readiness when the page binding changes mid-query',async t=>{
 let entered=null,release=null;
 const gate=new Promise(resolve=>{release=resolve;});
 const reached=new Promise(resolve=>{entered=resolve;});
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const run=env.wc.executeJavaScript;
 env.wc.executeJavaScript=async code=>{
  if(code.includes('gemini-page:click-mode-menu')){entered();await gate;}
  return run(code);
 };
 const pending=rpc(env,{op:'capabilities'});
 await reached;
 env.h.hello();
 release();
 const data=(await pending).json.data;
 assert.equal(data.status,'unavailable');
 assert.equal(data.reason,'page_changed');
 assert.deepEqual(data.models,[]);
 assert.deepEqual(data.thinking.levels,[]);
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});

test('a truncated observation during a capability query never reports ready',async t=>{
 let entered=null,release=null;
 const gate=new Promise(resolve=>{release=resolve;});
 const reached=new Promise(resolve=>{entered=resolve;});
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const run=env.wc.executeJavaScript;
 env.wc.executeJavaScript=async code=>{
  if(code.includes('gemini-page:click-mode-menu')){entered();await gate;}
  return run(code);
 };
 const pending=rpc(env,{op:'capabilities'});
 await reached;
 env.h.update({truncated:true});
 release();
 const data=(await pending).json.data;
 assert.equal(data.status,'unavailable');
 assert.equal(data.reason,'observation_truncated','truncation must not be misreported as a page change');
 assert.deepEqual(data.models,[]);
 assert.deepEqual(data.thinking.levels,[]);
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});

test('capabilities inspects thinking even when the surface mode is unknown',async t=>{
 const env=await setup({readOnly:false,modelMs:500,initial:{surface:{},models:[],thinkingOptions:thinkingMenu(),thinkingEntryCount:1},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const data=(await rpc(env,{op:'capabilities'})).json.data;
 assert.equal(data.status,'ready');
 assert.equal(data.modes.current,'unknown');
 assert.equal(data.thinking.status,'observed');
 assert.deepEqual(data.thinking.levels.map(item=>item.level),['low','medium','high']);
 assert.equal(env.counts.menu,1);
 assert.equal(env.counts.model,0);
});

test('capabilities uses the policy resolver for unique selectors and never picks among duplicates',async t=>{
 const menu=[
  {id:'',text:'独特模型 Unique Nova',visible:true,checked:false,disabled:false},
  {id:'mode-dup',text:'重复模型 Duplicate',visible:true,checked:false,disabled:false},
  {id:'mode-dup',text:'重复模型 Duplicate',visible:true,checked:false,disabled:false}
 ];
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:menu}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const data=(await rpc(env,{op:'capabilities'})).json.data;
 assert.equal(data.status,'ready');
 assert.equal(data.models.length,3);
 const unique=data.models.find(item=>item.name==='独特模型 Unique Nova');
 assert.equal(unique.selector,'独特模型 Unique Nova');
 assert.equal(unique.available,true);
 assert.equal(unique.unavailable_reason,null);
 const duplicated=data.models.filter(item=>item.name==='重复模型 Duplicate');
 assert.equal(duplicated.length,2);
 for(const item of duplicated){
  assert.equal(item.selector,null,'an ambiguous entry must not get a guessed selector');
  assert.equal(item.available,false);
  assert.equal(item.unavailable_reason,'selector_unavailable');
 }
 assert.equal(env.counts.model,0);
});

test('capabilities accepts 40 observed model options but refuses 41 instead of truncating',async t=>{
 const forty=Array.from({length:40},(_,index)=>({id:'mode-bulk-'+index,text:'批量模型 '+index,visible:true,checked:false,disabled:false}));
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:forty}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const data=(await rpc(env,{op:'capabilities'})).json.data;
 assert.equal(data.status,'ready');
 assert.equal(data.models.length,40);
 assert.equal(data.models[39].name,'批量模型 39');
 const over=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:[],thinkingEntryCount:0},behavior:{modelsOnMenu:[...forty,{id:'mode-bulk-40',text:'批量模型 40',visible:true,checked:false,disabled:false}]}});
 t.after(async()=>{await over.handle.close();fs.rmSync(over.stateDir,{recursive:true,force:true});});
 const rejected=(await rpc(over,{op:'capabilities'})).json.data;
 assert.equal(rejected.status,'unavailable');
 assert.equal(rejected.reason,'menu_truncated');
 assert.deepEqual(rejected.models,[]);
 assert.deepEqual(rejected.thinking.levels,[]);
 assert.equal(over.counts.model,0);
 assert.equal(over.counts.send,0);
});

test('capabilities refuses an over-40 thinking observation without reporting ready',async t=>{
 const levels=Array.from({length:41},(_,index)=>({id:'thinking-'+index,text:'等级 '+index,visible:false,checked:index===40,disabled:false,role:'menuitemradio'}));
 const env=await setup({readOnly:false,modelMs:500,initial:{models:[],thinkingOptions:levels,thinkingEntryCount:1},behavior:{modelsOnMenu:CURRENT_MENU}});
 t.after(async()=>{await env.handle.close();fs.rmSync(env.stateDir,{recursive:true,force:true});});
 const data=(await rpc(env,{op:'capabilities'})).json.data;
 assert.equal(data.status,'unavailable');
 assert.equal(data.reason,'observation_truncated');
 assert.deepEqual(data.models,[]);
 assert.deepEqual(data.thinking.levels,[]);
 assert.equal(env.counts.model,0);
 assert.equal(env.counts.send,0);
});
