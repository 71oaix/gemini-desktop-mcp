const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-lifecycle-'));
process.env.GEMINI_WORK_STATE=stateDir;
const store=require('../src/store.cjs');

function writeLedger(taskId,payload){
 const dir=path.join(stateDir,'bridge-tasks');
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,`${taskId}.json`),JSON.stringify(payload));
}

function seed(taskId,patch={}){
 const db=store.open();
 try{
  const now=Date.now();
  db.prepare(`INSERT INTO tasks(id,hash,request,status,created,updated,result,error,attempts,recover,send_intent,error_code,next_op,notified,phase,result_revision,budget_exhausted)
   VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,0,0)`).run(
   taskId,
   'hash-'+taskId,
   JSON.stringify({prompt:taskId,timeoutMs:60000}),
   patch.status||'needs_user_action',
   now,
   now,
   patch.result?JSON.stringify(patch.result):null,
   patch.error||null,
   patch.recover||0,
   patch.send_intent||0,
   patch.error_code||null,
   patch.next_op||null,
   1,
   patch.phase||patch.status||'needs_user_action'
  );
 }finally{db.close();}
}

test('resumeAfterProbe settles a completed ledger and does not requeue it',()=>{
 seed('done-r6',{status:'needs_user_action',send_intent:1,recover:1,next_op:'recover',error:'等待已取消',error_code:'OBSERVATION_ABORTED',result:{answer:'',url:'https://gemini.google.com/app/abc',submission_confirmed:true}});
 writeLedger('done-r6',{task_id:'done-r6',status:'completed',released:false,phase:'completed',result:{answer:'finished text',url:'https://gemini.google.com/app/abc',submission_confirmed:true}});
 const db=store.open();
 try{
  const resumed=store.resumeAfterProbe(db);
  assert.ok(!resumed.includes('done-r6'));
  const row=store.row(db,'done-r6');
  assert.equal(row.status,'completed');
  assert.equal(row.result.answer,'finished text');
  assert.equal(row.next_op,null);
 }finally{db.close();}
});

test('resumeAfterProbe closes an unsent PENDING_TASK after its blocker is finished',()=>{
 seed('blocker-done',{status:'completed',phase:'completed'});
 seed('unsent-r1',{status:'needs_user_action',send_intent:0,recover:0,error_code:'PENDING_TASK',error:'任务 blocker-done 的发送状态未知或未完成，需先处理或释放'});
 const db=store.open();
 try{
  const resumed=store.resumeAfterProbe(db);
  assert.ok(!resumed.includes('unsent-r1'));
  const row=store.row(db,'unsent-r1');
  assert.equal(row.status,'failed');
  assert.equal(row.error_code,'SUPERSEDED');
 }finally{db.close();}
});

test('closeTask closes an unsent task and refuses a sent unfinished task',()=>{
 seed('unsent-close',{status:'needs_user_action',send_intent:0,error_code:'PENDING_TASK',error:'任务 still-open 的发送状态未知或未完成，需先处理或释放'});
 seed('sent-open',{status:'needs_user_action',send_intent:1,recover:1,next_op:'recover',error_code:'OBSERVATION_ABORTED',error:'等待已取消',result:{url:'https://gemini.google.com/app/xyz',submission_confirmed:true}});
 const db=store.open();
 try{
  const closed=store.closeTask(db,'unsent-close',{reason:'手动关闭',error_code:'CLOSED'});
  assert.equal(closed.status,'failed');
  assert.equal(store.row(db,'unsent-close').error_code,'CLOSED');
  assert.throws(()=>store.closeTask(db,'sent-open'),error=>error.code==='RELEASE_NOT_ALLOWED');
  assert.equal(store.row(db,'sent-open').status,'needs_user_action');
 }finally{db.close();}
});

test('MODEL_UNAVAILABLE and ATTACHMENT_NOT_READY clear intent so closeTask can finish the row',()=>{
 seed('model-unavail',{status:'needs_user_action',send_intent:1,recover:0,error_code:'MODEL_UNAVAILABLE',error:'模型 4 Hydrogen 当前不可用，未自动降级',result:{submission_confirmed:false}});
 seed('attach-unready',{status:'needs_user_action',send_intent:1,recover:0,error_code:'ATTACHMENT_NOT_READY',error:'未确认附件处理完成，未发送问题',result:{submission_confirmed:false}});
 seed('attach-but-sent',{status:'needs_user_action',send_intent:1,recover:1,error_code:'ATTACHMENT_NOT_READY',error:'should not happen',result:{url:'https://gemini.google.com/app/xyz',submission_confirmed:true}});
 const db=store.open();
 try{
  const model=store.closeTask(db,'model-unavail',{reason:'关闭发送前失败',error_code:'CLOSED'});
  assert.equal(model.status,'failed');
  assert.equal(model.send_intent,false);
  assert.equal(store.row(db,'model-unavail').send_intent,0);
  const attach=store.closeTask(db,'attach-unready',{reason:'关闭发送前失败',error_code:'CLOSED'});
  assert.equal(attach.status,'failed');
  assert.equal(attach.send_intent,false);
  assert.equal(store.row(db,'attach-unready').error_code,'CLOSED');
  assert.throws(()=>store.closeTask(db,'attach-but-sent'),error=>error.code==='RELEASE_NOT_ALLOWED');
 }finally{db.close();}
});

test('closeTask consults bridge send evidence even when local intent is absent or failed',()=>{
 const db=store.open();
 try{
  for(const status of ['needs_user_action','failed']){
   const taskId='bridge-sent-'+status;
   seed(taskId,{status,send_intent:0});
   writeLedger(taskId,{status:'uncertain',phases:{send_intent:{at:'offline'}}});
   assert.throws(()=>store.closeTask(db,taskId),error=>error.code==='RELEASE_NOT_ALLOWED');
   assert.equal(store.row(db,taskId).status,status);
  }
 }finally{db.close();}
});

test('budget partial without terminal evidence resumes read-only after interruption',()=>{
 const taskId='budget-interrupted';
 const result={answer:'partial answer',url:'https://gemini.google.com/app/budget',submission_confirmed:true};
 seed(taskId,{status:'uncertain',send_intent:1,recover:1,next_op:'recover',result});
 writeLedger(taskId,{status:'partial',phase:'generating',metadata:{budget_exhausted:true},phases:{send_intent:{},confirmed:{},terminal:null},result});
 const db=store.open();
 try{
  assert.ok(store.resumeAfterProbe(db).includes(taskId));
  const resumed=store.row(db,taskId);
  assert.equal(resumed.status,'queued');assert.equal(resumed.next_op,'recover');
  assert.equal(resumed.result.answer,'partial answer');
  assert.throws(()=>store.closeTask(db,taskId),error=>error.code==='RELEASE_NOT_ALLOWED');
 }finally{db.close();}
});

test('budget partial cannot be closed or clear another task blocker while observation continues',()=>{
 const taskId='budget-still-running';
 seed(taskId,{status:'partial',send_intent:1,recover:1});
 writeLedger(taskId,{status:'partial',metadata:{budget_exhausted:true},phases:{send_intent:{},confirmed:{},terminal:null}});
 seed('waiting-on-budget',{error_code:'PENDING_TASK',error:`任务 ${taskId} 的发送状态未知或未完成`});
 const db=store.open();
 try{
  store.update(db,taskId,{budget_exhausted:1});
  assert.throws(()=>store.closeTask(db,taskId),error=>error.code==='RELEASE_NOT_ALLOWED');
  assert.ok(!store.closeStaleUnsent(db).includes('waiting-on-budget'));
  writeLedger(taskId,{status:'completed',phases:{terminal:{status:'completed'}},result:{answer:'finished'}});
  assert.equal(store.closeTask(db,taskId).status,'completed');
  assert.ok(store.closeStaleUnsent(db).includes('waiting-on-budget'));
 }finally{db.close();}
});

test('a shutdown terminal record ends observation, not recovery of a partial answer',()=>{
 const db=store.open();
 try{
  for(const budgetExhausted of [false,true]){
   const taskId='shutdown-partial-'+budgetExhausted;
   const result={answer:'saved answer',url:'https://gemini.google.com/app/shutdown',submission_confirmed:true};
   seed(taskId,{status:'uncertain',send_intent:1,recover:1,next_op:'recover',result});
   writeLedger(taskId,{status:'partial',metadata:{budget_exhausted:budgetExhausted},phases:{confirmed:{},send_intent:{},terminal:{status:'partial'}},result});
   assert.ok(store.resumeAfterProbe(db).includes(taskId));
   assert.equal(store.row(db,taskId).next_op,'recover');
  }
 }finally{db.close();}
});
