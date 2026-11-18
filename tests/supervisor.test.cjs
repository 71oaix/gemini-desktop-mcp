const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-supervisor-test-'));
process.env.GEMINI_WORK_STATE=state;
const s=require('../src/store.cjs');
const {Supervisor}=require('../src/supervisor.cjs');

function fakeChild(pid){
 return {pid,exitCode:1,kill(){this.killed=(this.killed||0)+1;this.exitCode=143;},removeListener(){},once(){}};
}

test('supervisor restarts a crashing worker with 1/2/4/8/15 second delays then stops, preserving tasks',async()=>{
 const db=s.open();try{
  db.prepare('DELETE FROM runtime').run();
  const delays=[],children=[];let seeded=false;
  const supervisor=new Supervisor({
   db,now:()=>1000000,
   sleep:async ms=>{delays.push(ms);},
   waitChild:async()=>true,
   spawnChild:()=>{
    const child=fakeChild(2147400000+children.length);
    children.push(child);
    if(!seeded){
     seeded=true;
     s.submit(db,{task_id:'worker-crash-task',prompt:'x'});
     db.prepare("UPDATE tasks SET status='submitting',send_intent=1,worker='crashed' WHERE id='worker-crash-task'").run();
    }
    return child;
   }
  });
  const result=await supervisor.run();
  assert.deepEqual(delays,[1000,2000,4000,8000,15000]);
  assert.equal(result.gaveUp,true);
  assert.equal(children.length,6);
  assert.equal(s.runtime(db),null);
  assert.equal(s.row(db,'worker-crash-task').status,'uncertain');
  assert.equal(s.row(db,'worker-crash-task').next_op,'snapshot');
  assert.equal(s.row(db,'worker-crash-task').send_intent,1);
 }finally{db.close();}
});

test('stop-worker prevents spawning and clears the supervisor lease',async()=>{
 const db=s.open();try{
  db.prepare('DELETE FROM runtime').run();
  fs.writeFileSync(path.join(state,'stop-worker'),'');
  let spawned=0;
  const supervisor=new Supervisor({db,now:()=>2000000,sleep:async()=>{},waitChild:async()=>true,spawnChild:()=>{spawned++;return fakeChild(2147500000);}});
  const result=await supervisor.run();
  assert.equal(result.started,true);assert.equal(spawned,0);assert.equal(s.runtime(db),null);
 }finally{fs.rmSync(path.join(state,'stop-worker'),{force:true});db.close();}
});

test('a hung worker is killed only when heartbeat and token still match its own child handle',async()=>{
 const db=s.open();try{
  db.prepare('DELETE FROM runtime').run();
  const child=fakeChild(2147600000);let calls=0;
  const supervisor=new Supervisor({
   db,now:()=>1000000,sleep:async()=>{},
   spawnChild:()=>child,
   waitChild:async(_child,ms)=>{
    if(ms===500){
     calls++;
     if(calls===1)db.prepare('UPDATE runtime SET worker_heartbeat=1000,worker_started=1000').run();
     return false;
    }
    if(ms===30000)return false;
    if(ms===5000){fs.writeFileSync(path.join(state,'stop-worker'),'');return true;}
    return false;
   }
  });
  await supervisor.run();
  assert.equal(child.killed,1);
  assert.equal(s.runtime(db),null);
 }finally{fs.rmSync(path.join(state,'stop-worker'),{force:true});db.close();}
});

test('token mismatch is fail-closed: supervisor exits without killing or releasing ownership',async()=>{
 const db=s.open();try{
  db.prepare('DELETE FROM runtime').run();
  const child=fakeChild(2147700000);let changed=false;
  const supervisor=new Supervisor({
   db,now:()=>3000000,sleep:async()=>{},spawnChild:()=>child,
   waitChild:async()=>{
    if(!changed){changed=true;db.prepare("UPDATE runtime SET worker_token='other-worker'").run();}
    return false;
   }
  });
  const result=await supervisor.run();
  assert.equal(result.unsafeExit,true);
  assert.equal(child.killed,undefined);
  const runtime=s.runtime(db);
  assert.ok(runtime);assert.equal(runtime.worker_token,'other-worker');
  db.prepare('DELETE FROM runtime').run();
 }finally{db.close();}
});
