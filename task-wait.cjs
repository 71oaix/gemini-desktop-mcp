'use strict';
const fs=require('node:fs');
// Cross-process SQLite notifications. fs.watch is a wakeup hint; SQLite remains
// authoritative. Watching before the first read closes the initial-check race.
function waitForTask({stateDir,readStatus,timeoutMs=1800000,signal,onProgress,returnOnChange=false,watch=fs.watch}={}){
 return new Promise((resolve,reject)=>{
  let watcher,timer,coalesce,done=false,lastKey=null;
  const cleanup=()=>{clearTimeout(timer);clearTimeout(coalesce);watcher?.close();signal?.removeEventListener('abort',abort);};
  const finish=(error,value)=>{if(done)return;done=true;cleanup();error?reject(error):resolve(value);};
  const abort=()=>finish(Object.assign(Error('Task wait aborted; execution unchanged'),{code:'ABORT_ERR'}));
  const check=()=>{
   if(done)return;
   try{
    const status=readStatus();
    if(['completed','failed','needs_user_action'].includes(status.status)||(status.status==='uncertain'&&!status.next_retry_at)||status.budget_exhausted===true){finish(null,{...status,wait_expired:false});return;}
    // The bridge explicitly marked completion as unverified. Report that
    // concrete blocker now instead of waiting out the full deadline; the task
    // stays generating and this waiter never changes its execution or lease.
    if(status.completion_unverified===true){finish(null,{...status,wait_expired:false,wait_reason:status.diagnostic?.message||status.completion_unverified_reason||'完成状态未验证'});return;}
    const key=JSON.stringify(status);
    if(key!==lastKey){if(lastKey!==null&&returnOnChange){finish(null,{...status,wait_expired:false});return;}lastKey=key;onProgress?.(status);}
   }catch(error){finish(error);}
  };
  if(signal?.aborted){abort();return;}
  try{
   watcher=watch(stateDir,{persistent:false},(_event,name)=>{
    if(name&&!/^tasks\.sqlite(?:-wal|-shm)?$/.test(String(name)))return;
    clearTimeout(coalesce);coalesce=setTimeout(check,25);
   });
   watcher.on('error',error=>finish(error));
   signal?.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>{try{finish(null,{...readStatus(),wait_expired:true});}catch(error){finish(error);}},Math.max(0,timeoutMs));
   check();
  }catch(error){finish(error);}
 });
}
module.exports={waitForTask};
