const {spawn}=require('node:child_process');
const readline=require('node:readline');
const path=require('node:path');
class Transport{
 constructor(){this.sequence=0;this.pending=new Map();this.child=null;}
 async start(){
  if(this.child)return;
  const cli=path.join(__dirname,'..','node_modules/@playwright/mcp/cli.js');
  this.child=spawn(process.execPath,[cli,'--extension','--browser','chrome','--profile-dir-name',process.env.GEMINI_CHROME_PROFILE||'Default','--no-webmcp','--timeout-action','10000','--output-dir',path.join(__dirname,'..','state/browser-evidence')],{cwd:__dirname,windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.child.stderr.on('data',()=>{});
  const connection=this.child;
  const fail=error=>{if(this.child!==connection)return;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.child=null;};
  this.child.on('error',fail);this.child.on('exit',code=>fail(Error(`浏览器连接进程退出: ${code}`)));
  readline.createInterface({input:this.child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line)}catch{return}const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(JSON.stringify(message.error))):p.resolve(message.result);});
  await this.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'gemini-work',version:'1.0.0'}});
  this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})+'\n');
 }
 rpc(method,params,timeout=120000){return new Promise((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('浏览器连接超时；任务状态不明时不会自动重发'));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
 async call(name,args={}){await this.start();const r=await this.rpc('tools/call',{name,arguments:args});if(r.isError)throw Error(r.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||r.error||'浏览器操作失败');return r;}
 close(){if(this.child){const child=this.child;this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('浏览器连接已关闭'));}this.pending.clear();child.stdin.end();child.kill();}}
}
function parse(r){const text=r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');const raw=text.split('### Result\n')[1]?.split('\n### ')[0];if(!raw)throw Error('浏览器没有返回可解析结果');return JSON.parse(raw);}
module.exports={Transport,parse};
