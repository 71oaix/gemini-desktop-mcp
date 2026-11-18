const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');

const STORE=path.resolve(__dirname,'..','store.cjs');
const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-store-startup-'));
process.env.GEMINI_WORK_STATE=stateDir;
const store=require(STORE);

after(()=>{try{fs.rmSync(stateDir,{recursive:true,force:true});}catch{}});

// Real child processes, not workers or sequential opens: every process loads
// the worktree store, reports ready over IPC, and only calls open() after the
// parent broadcasts go, so first-time initialization genuinely overlaps.
const CHILD_SOURCE=`
const store=require(process.env.GEMINI_STARTUP_STORE);
process.send({type:'ready'});
process.on('message',message=>{
 if(message!=='go')return;
 let db=null;
 try{
  db=store.open();
  const marker=db.prepare("SELECT value FROM meta WHERE key='schema'").get();
  process.send({type:'done',ok:true,schema:marker?marker.value:null});
 }catch(error){
  try{process.send({type:'done',ok:false,error:String((error&&error.stack)||error)});}catch{}
 }finally{
  if(db)try{db.close();}catch{}
 }
});
`;

function runConcurrentOpen({count=8,timeoutMs=60000,statePath=stateDir}={}){
 return new Promise((resolve,reject)=>{
  const children=[];
  const outcomes=new Map();
  let ready=0,done=0,settled=false;
  function report(){
   return [...outcomes.entries()].sort((a,b)=>a[0]-b[0]).map(([index,outcome])=>`child ${index}: ${outcome.ok?'ok':outcome.error}`).join('\n');
  }
  function stop(){
   for(const child of children){try{child.kill();}catch{}}
  }
  const timer=setTimeout(()=>fail(new Error(`barrier timed out after ${timeoutMs}ms (ready=${ready}/${count}, done=${done}/${count})\n${report()}`)),timeoutMs);
  function fail(error){
   if(settled)return;
   settled=true;clearTimeout(timer);stop();reject(error);
  }
  function finish(){
   if(settled)return;
   settled=true;clearTimeout(timer);stop();
   if(outcomes.size!==count)return reject(new Error(`only ${outcomes.size}/${count} children reported\n${report()}`));
   const failures=[...outcomes.values()].filter(outcome=>!outcome.ok);
   if(failures.length)return reject(new Error(`${failures.length}/${count} concurrent store.open() calls failed\n${report()}`));
   resolve([...outcomes.values()]);
  }
  for(let index=0;index<count;index+=1){
   const child=spawn(process.execPath,['-e',CHILD_SOURCE],{
    env:{...process.env,GEMINI_WORK_STATE:statePath,GEMINI_STARTUP_STORE:STORE},
    stdio:['ignore','ignore','pipe','ipc'],
    windowsHide:true
   });
   let stderr='';
   child.stderr.setEncoding('utf8');
   child.stderr.on('data',chunk=>{stderr+=chunk;});
   child.on('error',error=>fail(error));
   child.on('exit',(code,signal)=>{
    if(settled||outcomes.has(index))return;
    fail(new Error(`child ${index} exited before reporting (code=${code}, signal=${signal})\n${stderr}`));
   });
   child.on('message',message=>{
    if(settled||!message||typeof message!=='object')return;
    if(message.type==='ready'){
     ready+=1;
     if(ready===count){
      for(const peer of children){try{peer.send('go');}catch(error){fail(error);return;}}
     }
     return;
    }
    if(message.type!=='done'||outcomes.has(index))return;
    if(!message.ok)message.error=`${message.error}\n${stderr}`.trim();
    outcomes.set(index,message);
    done+=1;
    if(done===count)finish();
   });
   children.push(child);
  }
 });
}

function assertCompleteSchema(db){
 assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema'").get().value,'2');
 const columns=new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column=>column.name));
 for(const name of ['attempts','next_op','notified','result_revision','budget_exhausted'])assert.ok(columns.has(name),`tasks.${name} missing`);
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime'").get(),'runtime table missing');
 assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
}

test('eight processes initializing the same brand-new state all succeed',async()=>{
 assert.equal(fs.existsSync(path.join(stateDir,'tasks.sqlite')),false);
 const outcomes=await runConcurrentOpen({count:8});
 assert.deepEqual(outcomes.map(outcome=>outcome.schema),Array(8).fill('2'));
 const db=store.open();
 try{
  assertCompleteSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
 }finally{db.close();}
});

test('another concurrent round keeps an existing desktop database and its rows intact',async()=>{
 const seed=store.open();
 try{
  const stamp=Date.now();
  seed.prepare('INSERT INTO tasks(id,hash,request,status,created,updated,marker,next_op) VALUES(?,?,?,?,?,?,?,?)').run(
   'kept-task',
   'kept-hash',
   JSON.stringify({id:'kept-task',prompt:'keep this row',attachments:[]}),
   'queued',
   stamp,
   stamp,
   '[gemini-work:kept]',
   'send'
  );
 }finally{seed.close();}
 const outcomes=await runConcurrentOpen({count:8});
 assert.deepEqual(outcomes.map(outcome=>outcome.schema),Array(8).fill('2'));
 const db=store.open();
 try{
  const task=store.row(db,'kept-task');
  assert.equal(task.status,'queued');
  assert.equal(task.hash,'kept-hash');
  assert.equal(task.request.prompt,'keep this row');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE id='kept-task'").get().n,1);
  assertCompleteSchema(db);
 }finally{db.close();}
});

test('an unreadable locked legacy database is refused instead of being initialized after the lock clears',async()=>{
 const legacyDir=path.join(stateDir,'locked-legacy');fs.mkdirSync(legacyDir);
 const db=new DatabaseSync(path.join(legacyDir,'tasks.sqlite'));
 db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,hash TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,result TEXT,error TEXT,worker TEXT); CREATE TABLE daemon(singleton INTEGER PRIMARY KEY,token TEXT,pid INTEGER,heartbeat INTEGER,connection TEXT)');
 db.prepare('INSERT INTO tasks(id,hash,request,status,created,updated) VALUES(?,?,?,?,?,?)').run('old-web','old-hash','{}','queued',1,1);
 db.exec('BEGIN EXCLUSIVE');
 // Hold long enough for the child's read-only probe to encounter the lock,
 // then release it so the old fail-open path could proceed to modify the DB.
 let locked=true;
 const release=setTimeout(()=>{if(locked){db.exec('COMMIT');locked=false;}},1000);
 try{
  await assert.rejects(runConcurrentOpen({count:1,statePath:legacyDir}),/无法验证|locked|旧网页/);
  if(locked){db.exec('COMMIT');locked=false;}
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get(),undefined);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='old-web'").get().status,'queued');
 }finally{clearTimeout(release);if(locked)try{db.exec('ROLLBACK');}catch{}db.close();}
});
