'use strict';
// Historical fallback links stay readable, but no completed turn may create
// another Gemini call or reset the original answer.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-mcp-fallback-'));
process.env.GEMINI_WORK_STATE=stateDir;
const store=require('../store.cjs');
const worker=require('../worker.cjs');
const policy=require('../desktop-model-policy.cjs');

let db=null;
let sequence=0;
test.before(()=>{db=store.open();});
test.after(()=>{try{db?.close();}catch{};try{fs.rmSync(stateDir,{recursive:true,force:true});}catch{}});

function makeParent({status='completed',result={}}={}){
 const taskId=`parent-${++sequence}`;
 const submitted=store.submit(db,{task_id:taskId,prompt:'核对材料并给出结论',purpose:'review',model:'argon'});
 const saved={
  answer:'原轮回答',url:'https://gemini.google.com/app/abc123',
  requested_model:'argon',selected_model:'argon',
  actual_model:'flash',model_verified:false,
  requested_thinking:'high',thinking_level:'high',thinking_verified:true,
  fallback_reason:'model_mismatch',fallback_approved:false,routing_warning:null,
  policy_status:'unsatisfied',policy_satisfied:false,policy_code:policy.POLICY_CODE,
  submission_confirmed:true,complete:true,marker:submitted.marker,beforeResponses:0,
  ...result
 };
 store.update(db,taskId,{status,result:saved,error_code:policy.POLICY_CODE,error:'模型策略未满足'});
 return store.row(db,taskId);
}
function childrenOf(parentId){
 return db.prepare("SELECT COUNT(*) n FROM tasks WHERE json_extract(request,'$.fallback_parent_id')=?").get(parentId).n;
}
function ownerContext(){
 db.prepare('DELETE FROM runtime').run();
 assert.equal(store.claimSupervisor(db,{token:`sup-${sequence}`,pid:process.pid}).ok,true);
 assert.equal(store.startWorker(db,{supervisorToken:`sup-${sequence}`,workerToken:`worker-${sequence}`,pid:process.pid}).ok,true);
 return {token:`worker-${sequence}`,releases:0};
}

test('the active automatic fallback entry points are gone',()=>{
 assert.equal(store.createFallbackTask,undefined);
 assert.equal(store.fallbackTaskId,undefined);
 assert.equal(policy.fallbackDecision,undefined);
});

test('a strict completed downgraded turn stays a policy failure and creates no child',async()=>{
 const parent=makeParent();
 assert.equal(childrenOf(parent.id),0);
 const owner=ownerContext();
 const ctx={
  db,token:owner.token,log(){},inflight:new Map(),
  transport:{timeoutMs:10,async release(){owner.releases+=1;return {released:true};}},
  owns:()=>true
 };
 const outcome=await worker.settleTask(ctx,parent,{});
 assert.equal(outcome.status,'completed');
 assert.equal(childrenOf(parent.id),0);
 const after=store.row(db,parent.id);
 assert.equal(after.status,'completed');
 assert.equal(after.result.answer,'原轮回答');
 assert.equal(after.result.policy_status,'unsatisfied');
 assert.equal(after.result.fallback_task_id,undefined);
 assert.equal(owner.releases,1);
});

test('historical fallback links remain readable without creating a new call',()=>{
 const parent=makeParent();
 const childId=store.id(`legacy-child-${sequence}`);
 const marker=`[gemini-work:legacy-${sequence}:abcd1234]`;
 const request={id:childId,marker,prompt:'旧补做',purpose:'review',model:'flash',url:null,
  attachments:[],files:[],fallback_parent_id:parent.id,fallback_attempt:1,timeoutMs:null};
 db.prepare('INSERT INTO tasks(id,hash,request,status,created,updated,marker,next_op) VALUES(?,?,?,?,?,?,?,?)')
  .run(childId,'legacy-hash',JSON.stringify(request),'queued',store.now(),store.now(),marker,'send');
 store.update(db,childId,{status:'completed',result:{
  answer:'旧补做回答',url:'https://gemini.google.com/app/legacy',
  requested_model:'flash',selected_model:'flash',actual_model:'flash',model_verified:true,
  requested_thinking:'high',thinking_level:'high',thinking_verified:true,
  policy_status:'satisfied',policy_satisfied:true,policy_code:null,
  submission_confirmed:true,complete:true,marker
 }});
 store.update(db,parent.id,{result:{...parent.result,fallback_task_id:childId,fallback_reason:'argon_routed_other_model'}});
 const status=store.status(db,parent.id);
 assert.equal(status.fallback_task_id,childId);
 assert.equal(status.fallback_status,'completed');
 assert.equal(status.fallback_satisfied,true);
 assert.equal(status.fallback_actual_model,'flash');
 const result=store.result(db,{task_id:parent.id});
 assert.equal(result.answer,'原轮回答');
 assert.equal(result.fallback.task_id,childId);
 assert.equal(result.fallback.answer,'旧补做回答');
 assert.equal(childrenOf(parent.id),1,'the historical row is only read, not created');
});
