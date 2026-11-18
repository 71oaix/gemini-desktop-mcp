const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-recovery-test-'));
process.env.GEMINI_WORK_STATE=state;
const {DatabaseSync}=require('node:sqlite');
const legacy=new DatabaseSync(path.join(state,'tasks.sqlite'));
legacy.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,hash TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,result TEXT,error TEXT,worker TEXT);
CREATE TABLE daemon(singleton INTEGER PRIMARY KEY CHECK(singleton=1),token TEXT,pid INTEGER,heartbeat INTEGER,connection TEXT);`);
const legacyRequest=id=>JSON.stringify({id,prompt:'old web',model:'flash',purpose:'work',attachments:[],timeoutMs:180000});
legacy.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-queued','h1',legacyRequest('legacy-queued'),'queued',1,1,null,null,null);
legacy.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-completed','h2',legacyRequest('legacy-completed'),'completed',1,1,JSON.stringify({answer:'old',url:'https://gemini.google.com/app/old'}),null,null);
legacy.close();
const s=require('../store.cjs');
function file(name,content='hello'){const filename=path.join(state,name);fs.writeFileSync(filename,content);return filename;}
function cleanQueue(db,except=[]){const marks=except.map(()=>'?').join(',');const sql=marks?`UPDATE tasks SET status='failed',next_op=NULL,next_attempt=NULL WHERE status IN ('queued','staging','connecting','retry_wait','uncertain') AND id NOT IN (${marks})`:`UPDATE tasks SET status='failed',next_op=NULL,next_attempt=NULL WHERE status IN ('queued','staging','connecting','retry_wait','uncertain')`;db.prepare(sql).run(...except);}

test('legacy web database is refused without being migrated or executed',()=>{
 assert.throws(()=>s.open(),/旧网页|桌面 state/);
 const check=new DatabaseSync(path.join(state,'tasks.sqlite'),{readOnly:true});
 try{
  assert.equal(check.prepare("SELECT status FROM tasks WHERE id='legacy-queued'").get().status,'queued');
  assert.equal(check.prepare("SELECT status FROM tasks WHERE id='legacy-completed'").get().status,'completed');
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get(),undefined);
 }finally{check.close();}
 for(const suffix of ['','-wal','-shm'])fs.rmSync(path.join(state,`tasks.sqlite${suffix}`),{force:true});
});

test('staging crash recovery is atomic: complete becomes queued, incomplete fails after grace',()=>{
 const db=s.open();try{
  const good=s.submit(db,{task_id:'stage-complete',prompt:'x',files:[file('complete.txt','complete')]});
  assert.equal(good.status,'queued');
  s.update(db,'stage-complete',{status:'staging'});
  db.prepare('UPDATE tasks SET updated=? WHERE id=?').run(Date.now()-60000,'stage-complete');
  assert.deepEqual(s.recoverStaging(db,{force:true}),[{task_id:'stage-complete',status:'queued'}]);
  assert.equal(s.row(db,'stage-complete').status,'queued');

  const broken=s.submit(db,{task_id:'stage-broken',prompt:'x',files:[file('broken.txt','broken')]});
  const brokenPath=s.row(db,'stage-broken').request.attachments[0];
  fs.rmSync(brokenPath);
  s.update(db,'stage-broken',{status:'staging'});
  db.prepare('UPDATE tasks SET updated=? WHERE id=?').run(Date.now()-60000,'stage-broken');
  assert.deepEqual(s.recoverStaging(db,{force:false}),[{task_id:'stage-broken',status:'failed'}]);
  assert.equal(s.row(db,'stage-broken').error_code,'STAGING_INCOMPLETE');

  s.submit(db,{task_id:'stage-recent',prompt:'x',files:[file('recent.txt','recent')]});
  fs.rmSync(s.row(db,'stage-recent').request.attachments[0]);
  s.update(db,'stage-recent',{status:'staging'});
  assert.deepEqual(s.recoverStaging(db,{force:false}),[]);
  assert.equal(s.row(db,'stage-recent').status,'staging');
  assert.deepEqual(s.recoverStaging(db,{force:true}),[{task_id:'stage-recent',status:'failed'}]);
 }finally{db.close();}
});

test('random marker is generated once outside the normalized hash and reused',()=>{
 const db=s.open();try{
  const attachment=file('marker.txt','one');
  const args={task_id:'marker-task',prompt:'same',files:[attachment]};
  const first=s.submit(db,args),second=s.submit(db,args);
  assert.equal(second.reused,true);assert.equal(first.marker,second.marker);
  assert.match(first.marker,/^\[gemini-work:[0-9a-f]{24}\]$/);
  assert.equal(s.row(db,'marker-task').request.marker,first.marker);
  assert.throws(()=>s.submit(db,{...args,prompt:'changed'}),/不同内容/);
  s.submit(db,{task_id:'parent',prompt:'parent'});
  s.update(db,'parent',{status:'completed',result:{answer:'done',url:'https://gemini.google.com/app/parent'}});
  const child=s.submit(db,{task_id:'child',prompt:'continue',continue_task_id:'parent'});
  assert.equal(child.status,'queued');assert.equal(s.row(db,'child').request.url,'https://gemini.google.com/app/parent');
 }finally{db.close();}
});

test('supervisor lease refuses reused live PIDs and only seizes after owner exit',()=>{
 const db=s.open();try{
  db.prepare('DELETE FROM runtime').run();
  assert.equal(s.claimSupervisor(db,{token:'sup-a',pid:process.pid}).ok,true);
  assert.equal(s.claimSupervisor(db,{token:'sup-b',pid:process.pid}).ok,false);
  assert.equal(s.claimSupervisor(db,{token:'sup-b',pid:process.pid}).reason,'supervisor_active');
  db.prepare('UPDATE runtime SET supervisor_heartbeat=0,supervisor_pid=2147483647').run();
  assert.equal(s.claimSupervisor(db,{token:'sup-c',pid:process.pid}).ok,true);
  db.prepare("UPDATE runtime SET supervisor_token='reused',supervisor_heartbeat=0,supervisor_pid=?").run(process.pid);
  const refused=s.claimSupervisor(db,{token:'sup-d',pid:process.pid});
  assert.equal(refused.ok,false);assert.match(refused.reason,/supervisor_(active|unresponsive)/);
  db.prepare('DELETE FROM runtime').run();
 }finally{db.close();}
});

test('runtime reports fresh live supervisors as responsive and stale or missing workers as unresponsive',()=>{
 const db=s.open();try{
  db.prepare('DELETE FROM runtime').run();
  assert.equal(s.claimSupervisor(db,{token:'fresh-sup',pid:process.pid}).ok,true);
  assert.equal(s.startWorker(db,{supervisorToken:'fresh-sup',workerToken:'fresh-worker',pid:process.pid}).ok,true);
  let runtime=s.runtime(db);
  assert.equal(runtime.supervisor_fresh,true);
  assert.equal(runtime.worker_fresh,true);
  assert.equal(runtime.unresponsive,false);
  db.prepare('UPDATE runtime SET worker_heartbeat=?').run(Date.now()-60000);
  runtime=s.runtime(db);
  assert.equal(runtime.worker_fresh,false);
  assert.equal(runtime.unresponsive,true);
  db.prepare('UPDATE runtime SET supervisor_heartbeat=?').run(Date.now()-60000);
  runtime=s.runtime(db);
  assert.equal(runtime.supervisor_fresh,false);
  assert.equal(runtime.unresponsive,true);
  db.prepare('UPDATE runtime SET supervisor_heartbeat=?,worker_pid=NULL,worker_heartbeat=NULL').run(Date.now());
  runtime=s.runtime(db);
  assert.equal(runtime.supervisor_fresh,true);
  assert.equal(runtime.worker_fresh,false);
  assert.equal(runtime.unresponsive,true);
 }finally{db.close();}
});

test('in-flight submitting after executor exit becomes uncertain and only recovery is allowed',()=>{
 const db=s.open();try{
  cleanQueue(db,[]);
  db.prepare('DELETE FROM runtime').run();
  s.submit(db,{task_id:'crash-send',prompt:'x'});
  db.prepare("UPDATE tasks SET status='submitting',send_intent=1,worker='dead-worker' WHERE id='crash-send'").run();
  s.submit(db,{task_id:'crash-unsent',prompt:'y'});
  db.prepare("UPDATE tasks SET status='connecting',worker='dead-worker' WHERE id='crash-unsent'").run();
  assert.equal(s.claimSupervisor(db,{token:'sup-recover',pid:process.pid}).ok,true);
  const sent=s.row(db,'crash-send');
  assert.equal(sent.status,'uncertain');assert.equal(sent.next_op,'snapshot');
  assert.equal(s.row(db,'crash-unsent').status,'queued');
  assert.equal(s.row(db,'crash-send').send_intent,1);
  db.prepare('DELETE FROM runtime').run();
 }finally{db.close();}
});

test('retry delays are exactly 1/2/4/8/15/15 minutes then fail with partial data',()=>{
 const db=s.open();try{
  s.submit(db,{task_id:'retry-policy',prompt:'x'});
  s.update(db,'retry-policy',{result:{answer:'partial-answer',url:null,model:'flash',submission_confirmed:true,submission_known:true,marker:'m',beforeResponses:0}});
  const expected=[60000,120000,240000,480000,900000,900000];
  for(let i=0;i<expected.length;i++){
   const at=1000000+i*10000000;
   const scheduled=s.scheduleRetry(db,'retry-policy','NETWORK_TRANSIENT',{mode:'send',at});
   assert.equal(scheduled.scheduled,true);assert.equal(scheduled.delay,expected[i]);
   const task=s.row(db,'retry-policy');
   assert.equal(task.status,'retry_wait');assert.equal(task.attempts,i+1);assert.equal(task.next_attempt,at+expected[i]);
   assert.equal(task.result.answer,'partial-answer');
  }
  const exhausted=s.scheduleRetry(db,'retry-policy','NETWORK_TRANSIENT',{mode:'send',at:99999999});
  assert.equal(exhausted.exhausted,true);
  const task=s.row(db,'retry-policy');
  assert.equal(task.status,'failed');assert.match(task.error,/次数已用尽/);assert.equal(task.result.answer,'partial-answer');
  assert.match(fs.readFileSync(s.resultPath('retry-policy'),'utf8'),/partial-answer/);
 }finally{db.close();}
});

test('connect success resumes unsent work for sending and sent work only for reading',()=>{
 const db=s.open();try{
  db.prepare('DELETE FROM tasks').run();
  for(const id of ['auth-unsent','network-unsent','sent-auth','draft-blocked','uncertain-sent'])s.submit(db,{task_id:id,prompt:'x'});
  s.update(db,'auth-unsent',{status:'needs_user_action',error:'登录','error_code':'NEEDS_LOGIN'});
  s.update(db,'network-unsent',{status:'needs_user_action',error:'NETWORK_TRANSIENT','error_code':'NETWORK_TRANSIENT'});
  s.update(db,'sent-auth',{status:'needs_user_action',error:'登录','error_code':'NEEDS_LOGIN',send_intent:1,result:{answer:'partial',url:'https://gemini.google.com/app/sent',submission_confirmed:true,submission_known:true,marker:'m',beforeResponses:0}});
  s.update(db,'draft-blocked',{status:'needs_user_action',error:'有未发送草稿','error_code':'DRAFT_PRESENT'});
  s.update(db,'uncertain-sent',{status:'uncertain',send_intent:1,next_op:'snapshot',result:{answer:'',url:null,submission_confirmed:false,submission_known:false,marker:'m',beforeResponses:null}});
  const resumed=s.resumeAfterProbe(db).sort();
  assert.deepEqual(resumed,['auth-unsent','network-unsent','sent-auth','uncertain-sent'].sort());
  assert.equal(s.row(db,'auth-unsent').next_op,'send');
  assert.equal(s.row(db,'network-unsent').next_op,'send');
  assert.equal(s.row(db,'sent-auth').next_op,'recover');
  assert.equal(s.row(db,'sent-auth').send_intent,1);
  assert.equal(s.row(db,'uncertain-sent').next_op,'snapshot');
  assert.equal(s.row(db,'draft-blocked').status,'needs_user_action');
 }finally{db.close();}
});

test('large results paginate explicitly and result.md keeps the full answer',()=>{
 const db=s.open();try{
  s.submit(db,{task_id:'pages',prompt:'x'});
  const answer='a'.repeat(250);
  s.update(db,'pages',{status:'partial',result:{answer,url:'https://gemini.google.com/app/abc',submission_confirmed:true,submission_known:true,marker:'m',beforeResponses:0}});
  const first=s.result(db,{task_id:'pages',max_chars:100});
  assert.equal(first.answer.length,100);assert.equal(first.next_offset,100);assert.equal(first.complete,false);
  s.writeResultFile(db,'pages',s.row(db,'pages').result);
  assert.match(fs.readFileSync(s.resultPath('pages'),'utf8'),new RegExp(answer));
  s.update(db,'pages',{status:'completed'});
  const last=s.result(db,{task_id:'pages',offset:200,max_chars:100});
  assert.equal(last.answer.length,50);assert.equal(last.next_offset,null);assert.equal(last.complete,true);
 }finally{db.close();}
});
test('budget-held partial is reclaimable after worker exit without resending',()=>{
 const db=s.open();try{cleanQueue(db);s.submit(db,{task_id:'budget-restart',prompt:'hello'});
 const task=s.row(db,'budget-restart');s.update(db,task.id,{status:'partial',worker:'old-worker',budget_exhausted:1,send_intent:1,recover:1,next_op:'recover',next_attempt:null,result:{answer:'partial',url:'https://gemini.google.com/app/held',submission_confirmed:true,marker:task.marker}});
 const changed=s.interruptActive(db,'test worker exited');assert.ok(changed.some(t=>t.task_id===task.id));
 const claimed=s.nextTask(db,'replacement');assert.equal(claimed.id,task.id);assert.equal(claimed.next_op,'recover');assert.equal(claimed.worker,'replacement');assert.equal(claimed.send_intent,1);
 }finally{db.close();}
});
