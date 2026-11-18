const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');const {waitForTask}=require('../src/task-wait.cjs');
test('waiter notices a different process writing SQLite WAL without a periodic read',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-wait-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let reads=0,status={status:'generating'};
 const promise=waitForTask({stateDir:dir,timeoutMs:2000,readStatus:()=>{reads++;return status;}});
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal(reads,1);
 status={status:'completed'};fs.writeFileSync(path.join(dir,'tasks.sqlite-wal'),'changed');
 const result=await promise;assert.equal(result.status,'completed');assert.equal(result.wait_expired,false);
});
test('waiting deadline leaves execution untouched and closes watcher',async()=>{
 let closed=false,reads=0;const state={status:'generating'};
 const result=await waitForTask({timeoutMs:5,watch:()=>{const w=new EventEmitter();w.close=()=>{closed=true;};return w;},readStatus:()=>{reads++;return state;}});
 assert.equal(result.wait_expired,true);assert.equal(state.status,'generating');assert.equal(closed,true);assert.equal(reads,2);
});
test('explicit completion-unverified diagnostic returns the concrete blocker while generation continues',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-wait-diag-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state={status:'generating',completion_unverified:false,diagnostic:null,next_retry_at:null};
 let settled=false;
 const promise=waitForTask({stateDir:dir,timeoutMs:2000,readStatus:()=>state}).then(value=>{settled=true;return value;});
 await new Promise(resolve=>setTimeout(resolve,60));
 assert.equal(settled,false,'a normal generating snapshot must keep waiting');
 state.completion_unverified=true;state.diagnostic={code:'IDLE_NO_PROGRESS',message:'空闲诊断未观察到新进度；完成状态未验证'};
 fs.writeFileSync(path.join(dir,'tasks.sqlite-wal'),'changed');
 const result=await promise;
 assert.equal(result.wait_expired,false);assert.equal(result.status,'generating');
 assert.equal(result.completion_unverified,true);assert.equal(result.wait_reason,state.diagnostic.message);
 assert.equal(state.status,'generating');assert.equal(state.next_retry_at,null);
});
