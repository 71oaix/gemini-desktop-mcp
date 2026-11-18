'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-generation-slots-'));
process.env.GEMINI_WORK_STATE=stateDir;
const store=require('../src/store.cjs');
const {runWorker}=require('../src/worker.cjs');

function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function startRuntime(db,token){
 db.prepare('DELETE FROM runtime').run();
 assert.equal(store.claimSupervisor(db,{token:'sup-'+token,pid:process.pid}).ok,true);
 assert.equal(store.startWorker(db,{supervisorToken:'sup-'+token,workerToken:token,pid:process.pid}).ok,true);
}
function submit(db,id,over={}){
 return store.submit(db,{task_id:id,prompt:'hello '+id,...over});
}

test('MAX_GENERATING is 3 and counts generating occupancy, not queue length',()=>{
 assert.equal(store.MAX_GENERATING,3);
 const db=store.open();
 try{
  db.prepare('DELETE FROM tasks').run();
  submit(db,'queued-a');
  submit(db,'queued-b');
  submit(db,'queued-c');
  submit(db,'queued-d');
  assert.equal(store.stats(db).queued,4);
  const first=store.nextTask(db,'worker-slots',{generatingCount:3,generatingLimit:3});
  assert.equal(first,null);
  const allowed=store.nextTask(db,'worker-slots',{generatingCount:2,generatingLimit:3});
  assert.equal(allowed.id,'queued-a');
  assert.equal(store.row(db,'queued-b').status,'queued');
 }finally{db.close();}
});

test('a continued conversation that is already generating stays queued',()=>{
 const db=store.open();
 try{
  db.prepare("DELETE FROM tasks").run();
  const parentUrl='https://gemini.google.com/app/conv-busy';
  const now=Date.now();
  const request={prompt:'continue',purpose:'work',model:'hydrogen',timeoutMs:null,files:[],attachments:[],continue_task_id:'parent-done',url:parentUrl,source:'test',transport:'desktop'};
  db.prepare("INSERT INTO tasks(id,hash,request,status,created,updated,marker,next_op) VALUES(?,?,?,?,?,?,?,?)").run('child-cont','hash-cont',JSON.stringify(request),'queued',now,now,'[gemini-work:cont]','send');
  const skipped=store.nextTask(db,'worker-slots',{generatingCount:1,busyConversations:['/app/conv-busy'],generatingLimit:3});
  assert.equal(skipped,null);
  assert.equal(store.row(db,'child-cont').status,'queued');
  const later=store.nextTask(db,'worker-slots',{generatingCount:1,busyConversations:[],generatingLimit:3});
  assert.equal(later.id,'child-cont');
 }finally{db.close();}
});

test('returnToQueue leaves a blocked send in queued without consuming retries',()=>{
 const db=store.open();
 try{
  db.prepare("DELETE FROM tasks").run();
  submit(db,'requeue-me');
  const claimed=store.nextTask(db,'worker-slots',{generatingCount:0,generatingLimit:3});
  assert.equal(claimed.status,'connecting');
  const back=store.returnToQueue(db,'requeue-me',{mode:'send',error:'同时正在生成的对话已达上限 3',error_code:'GENERATION_LIMIT'});
  assert.equal(back.status,'queued');
  assert.equal(back.next_op,'send');
  assert.equal(back.attempts,0);
  assert.equal(back.error_code,'GENERATION_LIMIT');
 }finally{db.close();}
});

class LimitTransport{
 constructor(){
  this.timeoutMs=1000;
  this.executeCalls=[];
  this.releaseCalls=[];
 }
 async ensureRunning(){return {running:true,probe:{connected:true,pageReady:true,readOnly:false}};}
 async execute(wire){
  this.executeCalls.push(wire.id);
  throw Object.assign(Error('同时正在生成的对话已达上限 3'),{code:'GENERATION_LIMIT'});
 }
 async synchronize(){return {instance_id:'epoch-limit',seq:0,snapshots:[]};}
 async snapshot(){return null;}
 async recover(){return null;}
 async release(id){this.releaseCalls.push(id);return {released:true};}
 events(){return new Promise(()=>{});}
}

test('GENERATION_LIMIT requeues the task and does not pause the worker connection',async()=>{
 const db=store.open();
 try{
  db.prepare("DELETE FROM tasks").run();
  db.prepare('DELETE FROM runtime').run();
  submit(db,'limit-task');
  startRuntime(db,'worker-limit');
  const transport=new LimitTransport();
  await runWorker({db,transport,token:'worker-limit',once:true,waitForOwnershipMs:100,sleep:ms=>delay(Math.min(ms,20))});
  const row=store.row(db,'limit-task');
  assert.equal(row.status,'queued');
  assert.equal(row.error_code,'GENERATION_LIMIT');
  assert.equal(row.attempts,0);
  assert.equal(store.runtime(db).connection,'connected');
  assert.equal(transport.executeCalls.length,1);
 }finally{db.close();}
});

test('CONVERSATION_BUSY requeues a continue without needs_user_action',async()=>{
 const db=store.open();
 try{
  db.prepare("DELETE FROM tasks").run();
  db.prepare('DELETE FROM runtime').run();
  submit(db,'busy-cont');
  startRuntime(db,'worker-busy');
  const transport=new LimitTransport();
  transport.execute=async wire=>{
   transport.executeCalls.push(wire.id);
   throw Object.assign(Error('该会话正在生成回复，请等待结束后再续聊'),{code:'CONVERSATION_BUSY'});
  };
  await runWorker({db,transport,token:'worker-busy',once:true,waitForOwnershipMs:100,sleep:ms=>delay(Math.min(ms,20))});
  const row=store.row(db,'busy-cont');
  assert.equal(row.status,'queued');
  assert.equal(row.error_code,'CONVERSATION_BUSY');
  assert.equal(store.runtime(db).connection,'connected');
 }finally{db.close();}
});
