const {waitForTask}=require('./task-wait.cjs');
const readline=require('node:readline');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const store=require('./store.cjs');
const {healthActivity}=require('./task-activity.cjs');
const {DesktopTransport,APP_VERSION}=require('./desktop-transport.cjs');
const PENDING=new Set(['queued','staging','retry_wait','connecting','submitting','generating','uncertain']);
const properties={
 prompt:{type:'string',description:'本次需要 Gemini 完成的具体任务。审核时包含目标、范围和关注点。'},
 purpose:{type:'string',enum:['review','work'],description:'任务用途标签；不指定 model 时一律默认 hydrogen（4 Hydrogen）并在对话模式使用最高思考强度。'},
 model:{type:'string',minLength:1,maxLength:80,description:'模型选择器：不指定时一律使用 Hydrogen（4 Hydrogen，对话模式强制最高思考强度）。也可填当前模型菜单中的唯一名称或 data-test-id，支持未来新增模型；旧别名 hydrogen/flash/argon 仅为兼容。指定模型缺失、歧义、禁用或锁定/upsell 时明确失败，不自动降级。'},
 mode:{type:'string',enum:['auto','chat','task'],description:'auto 保持当前页面对话/任务模式；chat=对话模式（强制高思考）；task=任务模式（使用原生强度，菜单不提供思考等级）。续接默认继承父任务模式。'},
 files:{type:'array',items:{type:'string'},maxItems:10,description:'明确授权发送到 Gemini 的本地 .txt 文件绝对路径。提交时快照，每个不超过 10 MiB，合计不超过 25 MiB。'},
 task_id:{type:'string',description:'可选稳定任务编号。相同编号相同内容复用；不同内容拒绝。'},
 continue_task_id:{type:'string',description:'续聊时填写已完成父任务编号。不要复制会话上下文。'},
 source:{type:'string',description:'调用来源，建议填写项目或聊天的简短标签，仅在本机记录。'},
 timeout_sec:{type:'integer',minimum:20,maximum:1800,description:'任务总执行预算秒数，20–1800；不指定时默认1800秒（30分钟）。预算从客户端首次执行开始，准备阶段也计入，排队不计；到期保留已有回答并报 BUDGET_EXHAUSTED，不自动导航或重发。'}
};
const tools=[
 {name:'gemini_connect',description:'检查本机 Gemini 1.16.0 桌面桥连接与页面可用性，不发送聊天消息。返回检查任务编号，用 gemini_status 查询。登录或人工阻碍解除后也用它唤醒队列；只恢复只读检查，不重发已发任务。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
 {name:'gemini_submit',description:'通过本机已登录的 Gemini 1.16.0 桌面客户端提交审核或工作任务。异步返回 task_id；独立任务进入新对话，同时正在生成回复的上限为 3。提交会把 prompt 和指定 TXT 发送到 Google Gemini。',inputSchema:{type:'object',properties,required:['prompt'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},
 {name:'gemini_status',description:'查询 Gemini 任务的队列位置、执行状态或需要用户处理的事项，不重新提交。可等待至多20秒，并在等待中按需唤醒后台。',inputSchema:{type:'object',properties:{task_id:{type:'string'},wait_sec:{type:'integer',minimum:0,maximum:20}},required:['task_id'],additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'gemini_wait',description:'按队列变更等待任务完成或人工阻碍，不轮询页面；等待到期只返回现状，不改变执行。',inputSchema:{type:'object',properties:{task_id:{type:'string'},wait_sec:{type:'integer',minimum:0,maximum:1800}},required:['task_id'],additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'gemini_result',description:'取回 Gemini 完整或部分回答、会话链接与本地结果路径。next_offset 非空时继续分页；complete=false 不代表任务完成。历史记录中的 fallback_task_id 仍可读取以兼容旧结果；原轮回答与 hash 保持不变，不会因此产生新的调用。',inputSchema:{type:'object',properties:{task_id:{type:'string'},offset:{type:'integer',minimum:0},max_chars:{type:'integer',minimum:100,maximum:60000}},required:['task_id'],additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'gemini_health',description:'查看桌面桥发现/探测状态、supervisor/worker 心跳、队列、重试和桌面客户端版本；不发送消息、不读取任务正文，也不代表真实提交已验收。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'gemini_capabilities',description:'读取当前 Gemini 页面实际观察到的模型、模式与思考等级目录；无参数、不启动后台、不发送消息。status=unavailable 时目录为空，不能按静态别名猜测或据此提交。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'gemini_release',description:'关闭任务生命周期：同步已结束的桥记录到本地账本，或关闭从未发送的阻塞任务，并释放桌面桥记录。不发送聊天，也不重发已发任务。已发送但桥记录尚未结束的任务会拒绝关闭。',inputSchema:{type:'object',properties:{task_id:{type:'string',description:'要关闭的任务编号。'},reason:{type:'string',description:'关闭原因，仅写入本地账本。'}},required:['task_id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}
];

function ensureWorker(db){
 if(process.env.GEMINI_WORK_NO_AUTOSTART==='1')return {started:false,disabled:true};
 if(store.stopRequested())return {started:false,stop_requested:true};
 const runtime=store.runtime(db);
 if(runtime?.supervisor_fresh||runtime?.worker_fresh)return {started:false,alive:true};
 if(runtime?.supervisor_token&&store.alive(runtime.supervisor_pid))return {started:false,unresponsive:true};
 if(runtime?.worker_token&&store.alive(runtime.worker_pid))return {started:false,unresponsive:true};
 let log='ignore';
 try{log=fs.openSync(path.join(store.STATE,'supervisor.log'),'a');}catch{}
 try{
  const child=spawn(process.execPath,[path.join(__dirname,'supervisor.cjs')],{
   cwd:__dirname,
   env:{...process.env,GEMINI_WORK_STATE:store.STATE,GEMINI_WORK_BACKGROUND:'1'},
   windowsHide:true,detached:true,stdio:['ignore',log,log]
  });
  child.on('error',()=>{});child.unref();
  return {started:true};
 }catch(error){
  return {started:false,error:error.message};
 }finally{
  if(log!=='ignore'){try{fs.closeSync(log);}catch{}}
 }
}

function discoverySummary(){
 const transport=new DesktopTransport({autoStart:false});
 return {transport,discovery:transport.describe()};
}

async function health(db){
 const {transport,discovery}=discoverySummary();
 const runtime=store.runtime(db),stats=store.stats(db);
 const installation=await transport.checkedInstallation();
 let probe=null;
 let probeError=null;
 if(discovery.valid){const result=await transport.healthProbe(1200);if(result.ok)probe=result.probe;else probeError={code:result.code,message:result.message};}
 const readOnly=probe?probe.readOnly===true||probe.connected===false||probe.pageReady===false:false;
 let desktopState='not_running';
 if(discovery.valid&&probe&&!readOnly)desktopState='ready';
 else if(discovery.valid&&probe&&readOnly)desktopState='needs_user_action';
 else if(discovery.valid&&!probe)desktopState='unresponsive';
 else if(!installation.exists)desktopState='not_installed';
 else if(!installation.versionMatches)desktopState='version_mismatch';
 else if(!installation.patch.ready)desktopState='configuration_missing';
 const nextAction=store.stopRequested()
  ?`删除 ${path.join(store.STATE,'stop-worker')} 后重新 connect 或提交`
  :!runtime
   ?'提交或查询任务时将按需启动后台 supervisor'
   :runtime.unresponsive
    ?'后台心跳过期但仍有进程占用；不会按复用 PID 结束无关进程，请人工确认本项目进程'
    :desktopState==='configuration_missing'
     ?installation.patch.message||'桌面桥补丁未验证，不能启动客户端'
     :desktopState==='not_installed'
      ?`未发现固定版本 ${APP_VERSION} 桌面客户端`
      :desktopState==='unresponsive'&&probeError
       ?`桌面桥未响应（${probeError.code}）；可在桌面客户端中完整退出并重新打开一次`
       :desktopState==='needs_user_action'
        ?'桌面端只读、未登录或页面未就绪；处理后调用 gemini_connect'
        :runtime?.connection==='needs_user_action'
         ?'处理登录/授权后调用 gemini_connect；已发任务只恢复读取'
         :null;
 const payload={
  version:APP_VERSION,protocol:store.PROTOCOL,transport:'desktop-loopback',transport_mode:'desktop',
  acceptance:'unverified',notice:'health 不代表真实桌面提交或桌面桥联调已验收',
  process:{
   supervisor_pid:runtime?.supervisor_pid||null,worker_pid:runtime?.worker_pid||null,
   supervisor_alive:!!runtime?.supervisor_fresh,worker_alive:!!runtime?.worker_fresh,
   supervisor_heartbeat_fresh:!!runtime?.supervisor_fresh,worker_heartbeat_fresh:!!runtime?.worker_fresh,
   unresponsive:!!runtime?.unresponsive,stop_requested:store.stopRequested(),node:process.versions.node
  },
  bridge:{
   discovered:discovery.valid,state:discovery.valid?'discovered':discovery.state,
   app_version:discovery.app_version||null,bridge_version:discovery.bridge_version||probe?.bridgeVersion||null,
   protocol:discovery.protocol||null,port:discovery.port||null,pid:discovery.pid||null,
   probe_ok:!!probe,probe_error:probeError,read_only:readOnly
  },
  desktop:{status:desktopState,app_version:discovery.app_version||installation.version||null,expected_app_version:APP_VERSION,installed:installation.exists,version_matches:installation.versionMatches,patch:{available:installation.patch.available,ready:installation.patch.ready,state:installation.patch.state,message:installation.patch.message||null,patchId:installation.patch.patchId||null}},
  readiness:{desktop:desktopState,can_execute:desktopState==='ready'&&!readOnly,patch_ready:installation.patch.ready,transport:discovery.valid},
  connection:runtime?.connection||'not_started',
  worker_alive:!!runtime?.worker_fresh,
  supervisor_alive:!!runtime?.supervisor_fresh,
  queue:{...stats,position_source:'queued order',generating_count:probe&&Number.isInteger(probe.generating_count)?probe.generating_count:(stats.active||0),generating_limit:probe&&Number.isInteger(probe.generating_limit)?probe.generating_limit:store.MAX_GENERATING,generating_task_ids:Array.isArray(probe&&probe.generating_task_ids)?probe.generating_task_ids:[]},
  retry:{retry_wait:stats.retry_wait,uncertain:stats.uncertain,partial:stats.partial,exhausted:stats.failed},
  models:{
   default:'hydrogen',
   source:'static_aliases',
   observed:false,
   live:false,
   discovery_tool:'gemini_capabilities',
   aliases:{hydrogen:'4 Hydrogen',flash:'3.8 Flash',argon:'4 Argon'},
   note:'以上仅为兼容别名，不是实时可用清单，也不是当前页面目录；实际模型请用无参数 gemini_capabilities 读取，本健康检查未观察菜单。'
  },
  modes:{auto:'保持当前页面对话/任务模式',chat:'对话模式；强制高思考',task:'任务模式；原生强度，菜单不提供思考等级'},
  attachments:{only:'txt',file_limit_mib:10,total_limit_mib:25,max_files:10},
  cookie_export:false,playwright:false,
  discovery_guidance:{
   port_ephemeral:true,
   action:'rerun_health_or_connect',
   message:'桌面桥只监听 127.0.0.1 上的随机端口，令牌随 Gemini 启动轮换。client.cjs 与 MCP 会从 state/desktop-v1/discovery.json 自动发现，不要记录或指定端口。Gemini 重新打开后，再次调用 gemini_health 或 gemini_connect（CLI 为 node client.cjs health 或 connect）即可。'
  },
  next_action:nextAction
 };
 payload.activity=healthActivity(payload);
 return payload;
}

async function capabilities(){
 try{
  const transport=new DesktopTransport({autoStart:false});
  // Headroom for one bounded bridge observation; never an unbounded wait and
  // never a worker start or a page send.
  const catalog=await transport.capabilities({timeoutMs:35000});
  // An unavailable catalog must not fall back to a static default alias.
  return catalog.status==='unavailable'?{...catalog,default_model:null}:catalog;
 }catch(error){
  return {
   status:'unavailable',
   observed:false,
   observed_at:null,
   source:'desktop_transport',
   reason:error&&error.message?error.message:String(error),
   reason_code:error&&error.code?error.code:null,
   models:[],
   modes:{current:'unknown',supported:['chat','task'],source:'contract',immutable_after_start:true},
   thinking:{status:'unknown',levels:[]},
   default_model:null
  };
 }
}

async function dispatch(db,name,args,context={}){
 args=args||{};
 if(name==='gemini_connect'){const r=store.probe(db);ensureWorker(db);return {...r,resume_after_probe:true};}
 if(name==='gemini_submit'){const r=store.submit(db,args);ensureWorker(db);return r;}
 if(name==='gemini_status'){
  ensureWorker(db);
  const first=store.status(db,args.task_id);const wait=Math.min(20,Math.max(0,args.wait_sec||0));
  if(!wait||!PENDING.has(first.status))return first;
  return waitForTask({stateDir:store.STATE,readStatus:()=>store.status(db,args.task_id),timeoutMs:wait*1000,signal:context.signal,returnOnChange:true});
 }
 if(name==='gemini_wait'){
  ensureWorker(db);const seconds=args.wait_sec===undefined?1800:args.wait_sec;
  if(!Number.isInteger(seconds)||seconds<0||seconds>1800)throw Error('wait_sec must be 0..1800');
  return waitForTask({stateDir:store.STATE,readStatus:()=>store.status(db,args.task_id),timeoutMs:seconds*1000,signal:context.signal});
 }
 if(name==='gemini_result')return store.result(db,args);
 if(name==='gemini_health')return health(db);
 if(name==='gemini_capabilities')return capabilities();
 if(name==='gemini_release'){
  const closed=store.closeTask(db,args.task_id,{reason:args.reason});
  let bridge_release=null,bridge_release_error=null;
  try{
   const transport=new DesktopTransport({autoStart:false});
   const released=await transport.release(args.task_id);
   bridge_release={status:released.status||null,released:released.released===true,send_state:released.send_state||null};
  }catch(error){
   bridge_release_error={code:error.code||null,message:error.message||String(error)};
  }
  return {...closed,bridge_release,bridge_release_error};
 }
 throw Error('Unknown tool');
}

function serve(){
 const db=store.open();const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
 const controller=new AbortController(),active=new Set();let closing=false;
 const send=value=>{if(!closing)process.stdout.write(JSON.stringify(value)+'\n');};
 lines.on('line',async line=>{
  let m;try{m=JSON.parse(line)}catch{return send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
  if(m.id===undefined)return;
  try{
   let result;
   if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'gemini-work',version:APP_VERSION},instructions:'桌面通道：gemini_submit 提交，gemini_status 查询，gemini_result 分页取回。默认只恢复原会话，不重发发送状态不明的任务。Gemini 结论须由调用方核实。'};
   else if(m.method==='ping')result={};
   else if(m.method==='tools/list')result={tools};
   else if(m.method==='tools/call'){
    try{const pending=dispatch(db,m.params.name,m.params.arguments||{},{signal:controller.signal});active.add(pending);let data;try{data=await pending;}finally{active.delete(pending);}result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
    catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}
   }else return send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});
   send({jsonrpc:'2.0',id:m.id,result});
  }catch(e){send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:e.message}});}
 });
 lines.on('close',()=>{closing=true;controller.abort();Promise.allSettled([...active]).then(()=>db.close());});
}
if(require.main===module)serve();
module.exports={tools,dispatch,ensureWorker,health,capabilities};
