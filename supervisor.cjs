const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const store=require('./store.cjs');
const RESTART_DELAYS=[1000,2000,4000,8000,15000];
const MAX_CONSECUTIVE_FAILURES=5;
const HANG_MS=15000;
const WORKER_EXIT_WAIT_MS=30000;
const HEARTBEAT_MS=2000;

function waitForExit(child,timeoutMs){
 return new Promise(resolve=>{
  if(!child||child.exitCode!==null&&child.exitCode!==undefined)return resolve(true);
  let settled=false;
  const timer=setTimeout(()=>finish(false),Math.max(0,timeoutMs));
  function finish(value){if(settled)return;settled=true;clearTimeout(timer);child.removeListener('exit',onExit);resolve(value);}
  function onExit(){finish(true);}
  child.once('exit',onExit);
 });
}

function openLog(stateDir){
 const filename=path.join(stateDir,'supervisor.log');
 try{return fs.openSync(filename,'a');}catch{return 'ignore';}
}

class Supervisor{
 constructor({db,token=crypto.randomUUID(),spawnChild,waitChild=waitForExit,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{},stateDir=store.STATE}={}){
  this.db=db;this.token=token;this.stateDir=stateDir;this.logFile=null;
  this.waitChild=waitChild;this.now=now;this.sleep=sleep;this.log=log;
  this.spawnChild=spawnChild||(({workerToken})=>{
   this.logFile=this.logFile??openLog(stateDir);
   const child=spawn(process.execPath,[path.join(__dirname,'worker.cjs')],{
    cwd:__dirname,
    env:{...process.env,GEMINI_WORK_STATE:stateDir,GEMINI_WORK_SUPERVISOR_TOKEN:token,GEMINI_WORK_WORKER_TOKEN:workerToken,GEMINI_WORK_BACKGROUND:'1'},
    windowsHide:true,stdio:['ignore',this.logFile,this.logFile]
   });
   child.on('error',e=>this.log(`worker 启动失败：${e.message}`));
   return child;
  });
  this.failures=0;this.stopping=false;this.unsafeExit=false;this.heartbeat=null;
 }

 async run(){
  const claim=store.claimSupervisor(this.db,{token:this.token,pid:process.pid});
  if(!claim.ok){this.log(`supervisor 未取得执行权：${claim.reason}`);return {started:false,reason:claim.reason};}
  this.heartbeat=setInterval(()=>{try{store.heartbeatSupervisor(this.db,this.token);}catch(e){this.log(`supervisor 心跳失败：${e.message}`);}},HEARTBEAT_MS);
  if(this.heartbeat.unref)this.heartbeat.unref();
  try{
   while(!this.stopping){
    if(store.stopRequested()){this.log('发现 stop-worker，停止 supervisor');break;}
    const workerToken=crypto.randomUUID();
    const childStartedAt=this.now();
    const child=this.spawnChild({workerToken});
    if(!child||!Number.isInteger(child.pid)){this.log('worker 句柄无效，fail-closed');this.unsafeExit=true;break;}
    const started=store.startWorker(this.db,{supervisorToken:this.token,workerToken,pid:child.pid});
    if(!started.ok){
     this.log(`无法启动 worker：${started.reason}；不抢占执行`);
     this.unsafeExit=started.reason==='worker_alive';
     break;
    }
    this.log(`worker 已启动 pid=${child.pid}`);
    const outcome=await this.monitor(child,workerToken);
    store.releaseWorker(this.db,workerToken);
    if(outcome.stopped||this.stopping)break;
    if(outcome.fenced){this.log('worker 租约/令牌无法确认，保留运行时记录并以 fail-closed 退出');this.unsafeExit=true;break;}
    const runtimeMs=childStartedAt?this.now()-childStartedAt:0;
    this.failures=runtimeMs>=30000?0:this.failures+1;
    if(this.failures>MAX_CONSECUTIVE_FAILURES){this.log('worker 连续失败次数已达上限，停止 supervisor；任务保留');break;}
    const delay=RESTART_DELAYS[Math.min(this.failures-1,RESTART_DELAYS.length-1)];
    this.log(`worker 退出 code=${outcome.code}，${delay}ms 后重启（连续失败 ${this.failures}）`);
    await this.sleep(delay);
   }
  }finally{
   if(this.heartbeat)clearInterval(this.heartbeat);
   if(!this.unsafeExit)store.releaseSupervisor(this.db,this.token);
   if(this.logFile!==null&&this.logFile!=='ignore'){try{fs.closeSync(this.logFile);}catch{}}
  }
  return {started:true,gaveUp:this.failures>MAX_CONSECUTIVE_FAILURES,unsafeExit:this.unsafeExit};
 }

 async monitor(child,workerToken){
  for(;;){
   const exited=await this.waitChild(child,500);
   if(exited)return {exit:true,code:child.exitCode??null};
   if(store.stopRequested()){
    this.stopping=true;
    const stopped=await this.stopOwnedChild(child,workerToken);
    if(!stopped)this.unsafeExit=true;
    return {stopped:true};
   }
   const runtime=store.runtime(this.db);
   if(!runtime||runtime.worker_token!==workerToken){
    this.unsafeExit=true;
    return {fenced:true};
   }
   if(!runtime.worker_fresh){
    const beat=runtime.worker_heartbeat||runtime.worker_started||0;
    if(beat&&this.now()-beat>HANG_MS){
     this.log('worker 心跳过期；先核对令牌，再终止本项目子进程');
     const stopped=await this.stopOwnedChild(child,workerToken);
     if(!stopped){this.unsafeExit=true;return {fenced:true};}
     return {exit:true,code:'heartbeat_timeout',killed:true};
    }
   }
  }
 }

 async stopOwnedChild(child,workerToken){
  const runtime=store.runtime(this.db);
  if(!runtime||runtime.worker_token!==workerToken||runtime.worker_pid!==child.pid){this.log('worker 归属无法确认，不结束进程');return false;}
  if(await this.waitChild(child,WORKER_EXIT_WAIT_MS))return true;
  this.log('等待 worker 正常退出超时；结束本项目记录一致的子进程');
  try{child.kill();}catch{}
  return this.waitChild(child,5000);
 }
}

async function main(){
 const db=store.open();
 if(store.stopRequested()){db.close();return;}
 const logPath=path.join(store.STATE,'supervisor.log');
 const log=message=>{try{fs.appendFileSync(logPath,`${new Date().toISOString()} ${message}\n`);}catch{}};
 const supervisor=new Supervisor({db,log});
 try{await supervisor.run();}finally{db.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={Supervisor,waitForExit,RESTART_DELAYS,MAX_CONSECUTIVE_FAILURES,HANG_MS};
