const {spawn}=require('node:child_process');
const readline=require('node:readline');
const path=require('node:path');
const fs=require('node:fs');
const TERMINAL=new Set(['completed','partial','failed','needs_user_action','uncertain']);
class Client{
 constructor(env={}){this.id=0;this.pending=new Map();this.child=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{cwd:__dirname,env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});this.child.stderr.on('data',()=>{});this.child.on('error',e=>this.failPending(e));this.child.on('exit',()=>this.failPending(Error('MCP 服务已退出；后台任务执行状态不变')));this.child.stdin.on('error',e=>this.failPending(e));readline.createInterface({input:this.child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});}
 rpc(method,params={},timeoutMs=30000){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('MCP 超时'));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
 async init(){return this.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'gemini-work-client',version:'1.16.0'}});}
 async call(name,args={}){const timeoutMs=name==='gemini_wait'?((args.wait_sec??1800)+10)*1000:name==='gemini_capabilities'?45000:30000;const r=await this.rpc('tools/call',{name,arguments:args},timeoutMs);if(r.isError)throw Error((r.content||[]).map(c=>c.text||'').join('\n'));return r.structuredContent||JSON.parse(r.content[0].text);}
 failPending(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 close(){this.failPending(Error('MCP 客户端等待已关闭；后台任务执行状态不变'));this.child.stdin.end();this.child.kill();}
}
async function collectResult(c,task_id,status){
 if(!status||(!status.has_partial_answer&&!['completed','partial','failed'].includes(status.status)))return status;
 let offset=0,answer='';
 for(;;){
  const page=await c.call('gemini_result',{task_id,offset,max_chars:60000});
  answer+=page.answer||'';
  offset=page.next_offset;
  if(offset===null||offset===undefined)return {...status,...page,answer,complete:page.complete,result_file:page.result_file||status.result_file};
 }
}
async function main(){
 const c=new Client();
 try{
  await c.init();
  const command=process.argv[2]||'health';
  let value;
  if(command==='tools')value=await c.rpc('tools/list');
  else if(command==='submit')value=await c.call('gemini_submit',JSON.parse(fs.readFileSync(path.resolve(process.argv[3]),'utf8').replace(/^\uFEFF/,'')));
  else if(command==='status'||command==='result'){
   value=await c.call(`gemini_${command}`,{task_id:process.argv[3],...(command==='result'?{offset:Number(process.argv[4]||0)}:{})});
  }else if(command==='wait'){
   const task_id=process.argv[3],seconds=Math.min(1800,Math.max(0,Number(process.argv[4]||1800)));
   value=await c.call('gemini_wait',{task_id,wait_sec:seconds});
   value=await collectResult(c,task_id,value);
  }else if(command==='health'||command==='connect'||command==='capabilities')value=await c.call(command==='capabilities'?'gemini_capabilities':`gemini_${command}`);
  else if(command==='release')value=await c.call('gemini_release',{task_id:process.argv[3],reason:process.argv[4]});
  else throw Error('用法: client.cjs health|connect|capabilities|tools|submit request.json|status task_id|result task_id [offset]|wait task_id [timeout_sec]|release task_id [reason]');
  console.log(JSON.stringify(value,null,2));
 }finally{c.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={Client,collectResult};
