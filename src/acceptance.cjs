#!/usr/bin/env node
'use strict';
// Event-v2 acceptance: resume the ten manifest tasks by their original IDs/args,
// wait on queue events, paginate every answer, validate semantics, and preserve
// all records. Never renumber, retry under a new ID, cancel, release, or delete.
const fs=require('node:fs');
const path=require('node:path');
const {Client}=require('./client.cjs');

const TERMINAL=new Set(['completed','partial','failed','needs_user_action','uncertain']);
const WAIT_SEC=300;          // per gemini_wait call; not a generation timeout
const PAGE_CHARS=700;
const MAX_WAIT_ROUNDS=12;
const MAX_PAGES=400;
const EXPECTED_TASKS=10;
const STATE_ROOT=path.join(__dirname,'..','state');

let RUN='';
let TOKEN='';
let OUTPUT='';

const EMPTY_ARRAY_CAUSE=/(0\s*\/\s*0|division\s+by\s+(?:zero|0)|divide\s+by\s+(?:zero|0)|divided\s+by\s+(?:zero|0)|empty\s+array|values\.length\s*(?:===|==|=|is)?\s*(?:0|zero)|空数组|空集|长度[^。\n]{0,6}(?:0|零)|除以\s*(?:零|0)|除零|除数[^。\n]{0,6}(?:0|零)|分母[^。\n]{0,6}(?:0|零))/i;

function fail(message){throw new Error(message);}

function redact(value){
 let text=value&&typeof value==='object'&&value.message?value.message:String(value===undefined?'':value);
 if(TOKEN)text=text.split(TOKEN).join('[redacted]');
 return text.length>1000?`${text.slice(0,1000)}…`:text;
}

function parseArgs(argv){
 const known=new Set(['--manifest','--output']);
 const out={};
 for(let i=0;i<argv.length;i++){
  let key=argv[i];
  let value;
  if(key.startsWith('--')&&key.includes('=')){
   const at=key.indexOf('=');
   value=key.slice(at+1);
   key=key.slice(0,at);
  }
  if(!known.has(key))fail(`未知参数: ${key}`);
  if(value===undefined)value=argv[++i];
  if(typeof value!=='string'||!value)fail(`${key} 缺少取值`);
  if(out[key.slice(2)]!==undefined)fail(`${key} 重复`);
  out[key.slice(2)]=value;
 }
 if(!out.manifest)fail('缺少 --manifest');
 if(!out.output)fail('缺少 --output');
 return out;
}

function writeJson(file,value){
 fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`);
}

function loadManifest(file){
 let raw;
 try{raw=fs.readFileSync(path.resolve(file),'utf8').replace(/^\uFEFF/,'');}
 catch{fail('无法读取 manifest 文件');}
 let manifest;
 try{manifest=JSON.parse(raw);}
 catch{fail('manifest 不是有效 JSON');}
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))fail('manifest 必须是 JSON 对象');
 if(typeof manifest.run!=='string'||!/^push-[0-9a-f]{6,64}$/.test(manifest.run))fail('manifest.run 必须形如 push-<hex>');
 if(typeof manifest.token!=='string'||!/^[\x21-\x7e]{4,200}$/.test(manifest.token))fail('manifest.token 缺失或格式无效');
 if(!Array.isArray(manifest.tasks)||manifest.tasks.length!==EXPECTED_TASKS)fail('manifest.tasks 必须恰好包含 10 个任务');

 const seenIds=new Set();
 const tasks=[];
 for(let i=0;i<manifest.tasks.length;i++){
  const input=manifest.tasks[i];
  if(!input||typeof input!=='object'||Array.isArray(input))fail(`tasks[${i}] 无效`);
  const expectedId=`${manifest.run}-${i+1}`;
  if(input.task_id!==expectedId)fail(`tasks[${i}].task_id 必须是 ${expectedId}`);
  if(seenIds.has(input.task_id))fail(`tasks[${i}].task_id 重复`);
  if(input.model!=='flash'&&input.model!=='argon')fail(`tasks[${i}].model 必须是 flash 或 argon`);
  if(input.purpose!=='work'&&input.purpose!=='review')fail(`tasks[${i}].purpose 必须是 work 或 review`);
  if(typeof input.prompt!=='string'||!input.prompt.trim())fail(`tasks[${i}].prompt 不能为空`);
  if(input.source!==undefined&&typeof input.source!=='string')fail(`tasks[${i}].source 必须是字符串`);
  if(input.continue_task_id!==undefined&&(typeof input.continue_task_id!=='string'||!seenIds.has(input.continue_task_id)))
   fail(`tasks[${i}].continue_task_id 必须指向更早任务`);

  const files=[];
  if(input.files!==undefined){
   if(!Array.isArray(input.files)||input.files.length===0||input.files.length>10)fail(`tasks[${i}].files 必须是 1–10 个文件`);
   const unique=new Set();
   const contents=[];
   for(const entry of input.files){
    if(typeof entry!=='string'||!path.isAbsolute(entry))fail(`tasks[${i}] 附件必须使用绝对路径`);
    if(path.extname(entry).toLowerCase()!=='.txt')fail(`tasks[${i}] 只允许 TXT 附件`);
    const resolved=path.resolve(entry);
    if(unique.has(resolved))fail(`tasks[${i}] 附件重复`);
    unique.add(resolved);
    let stat;
    try{stat=fs.statSync(resolved);}
    catch{fail(`tasks[${i}] 附件不存在`);}
    if(!stat.isFile())fail(`tasks[${i}] 附件不是常规文件`);
    let content;
    try{content=fs.readFileSync(resolved,'utf8');}
    catch{fail(`tasks[${i}] 附件无法读取`);}
    contents.push(content);
    files.push(resolved);
   }
   if(!contents.some(content=>content.includes(manifest.token)))fail(`tasks[${i}] 提供的 TXT 不包含 manifest.token`);
  }
  if(i===2){
   if(files.length===0)fail('任务 3 必须显式提供 TXT 附件');
   if(input.prompt.includes(manifest.token))fail('任务 3 prompt 不得包含 manifest.token');
  }
  if(i===5){
   if(input.continue_task_id!==`${manifest.run}-2`)fail('任务 6 必须续接任务 2');
  }else if(input.continue_task_id!==undefined){
   fail(`任务 ${i+1} 不应包含 continue_task_id`);
  }

  seenIds.add(input.task_id);
  tasks.push({
   task_id:input.task_id,
   model:input.model,
   purpose:input.purpose,
   prompt:input.prompt,
   source:input.source||'',
   files,
   continue_task_id:input.continue_task_id||null
  });
 }
 const counts={flash:0,argon:0};
 for(const task of tasks)counts[task.model]++;
 if(counts.flash!==5||counts.argon!==5)fail('manifest 必须恰好包含 5 个 flash 与 5 个 argon 任务');
 return {run:manifest.run,token:manifest.token,tasks};
}

function submitArgs(task){
 const args={task_id:task.task_id,prompt:task.prompt,model:task.model,purpose:task.purpose};
 if(task.source)args.source=task.source;
 if(task.files.length)args.files=task.files.slice();
 if(task.continue_task_id)args.continue_task_id=task.continue_task_id;
 return args;
}

function hasInteger(text,wanted){
 return new RegExp(`(?<!\\d)${wanted}(?!\\d)`).test(text);
}

function numberedLines(raw){
 let lines=String(raw||'').replace(/\r\n?/g,'\n').split('\n');
 lines=lines.filter(line=>!/^```/.test(line.trim()));
 while(lines.length&&lines[0].trim()==='')lines.shift();
 while(lines.length&&lines[lines.length-1].trim()==='')lines.pop();
 return lines.map(line=>line.trim());
}

function validateTask(index,task,rawAnswer,status,info,records){
 const text=String(rawAnswer||'').replace(/^\uFEFF/,'');
 const checks={statusCompleted:status==='completed'};
 switch(index){
  case 0:
   checks.identifierF1=text.includes(`F1_${RUN}`);
   break;
  case 1:
   checks.identifierA1=text.includes(`A1_${RUN}`);
   break;
  case 2:
   checks.tokenInAnswer=text.includes(TOKEN);
   break;
  case 3:
   checks.nanPresent=/\bNaN\b/.test(text);
   checks.emptyArrayCause=EMPTY_ARRAY_CAUSE.test(text);
   break;
  case 4:
   checks.integer391=hasInteger(text,391);
   break;
  case 5:
   checks.identifierA1=text.includes(`A1_${RUN}`);
   checks.sameConversationUrl=!!info.conversation_url&&info.conversation_url===records[1]?.result?.conversation_url;
   checks.parentCompleted=records[1]?.status==='completed';
   break;
  case 6:{
   const lines=numberedLines(text);
   checks.exactly400Lines=lines.length===400;
   checks.orderedLines=checks.exactly400Lines&&lines.every((line,at)=>line===`${String(at+1).padStart(4,'0')}:ABCDEFGHIJ`);
   checks.multiplePages=(info.pages||0)>1;
   break;
  }
  case 7:
   checks.integer817=hasInteger(text,817);
   break;
  case 8:
   checks.identifierF5=text.includes(`F5_${RUN}`);
   break;
  case 9:
   checks.identifierA5=text.includes(`A5_${RUN}`);
   break;
  default:
   fail(`未知任务序号 ${index+1}`);
 }
 const failed=Object.keys(checks).filter(name=>checks[name]!==true);
 return {ok:failed.length===0,checks,reason:failed.length?`未通过: ${failed.join(', ')}`:null};
}

async function collectPaged(primary,other,taskId){
 const state={answer:'',pages:0,total_chars:null,last:null};
 try{
  let offset=0;
  for(;;){
   if(state.pages>=MAX_PAGES)fail('分页次数超过上限');
   const client=state.pages%2===0?other:primary;
   const page=await client.call('gemini_result',{task_id:taskId,offset,max_chars:PAGE_CHARS});
   state.pages++;
   if(typeof page.total_chars==='number')state.total_chars=page.total_chars;
   state.answer+=typeof page.answer==='string'?page.answer:'';
   state.last=page;
   const next=page.next_offset;
   if(next===null||next===undefined)break;
   if(!Number.isInteger(next)||next<=offset)fail('分页 offset 未前进');
   if(typeof page.total_chars==='number'&&next>page.total_chars)fail('分页 offset 超出总长度');
   offset=next;
  }
  if(state.last&&typeof state.last.total_chars==='number'&&state.answer.length!==state.last.total_chars)
   fail('分页结果长度与 total_chars 不一致');
  return state;
 }catch(error){
  error.partial=state;
  throw error;
 }
}

async function waitTerminal(client,label,task){
 for(let round=1;round<=MAX_WAIT_ROUNDS;round++){
  const status=await client.call('gemini_wait',{task_id:task.task_id,wait_sec:WAIT_SEC});
  console.log(`[${label}/10] ${task.task_id} wait#${round} status=${(status&&status.status)||'unknown'}`);
  if(status&&TERMINAL.has(status.status))return status;
  // The bridge marked completion as unverified while the task stays generating.
  // Treat it as a concrete blocker: stop waiting (no 12x immediate loop) and
  // let runTask collect the partial answer and fail the batch with this reason.
  if(status&&status.completion_unverified===true){
   const reason=status.wait_reason||(status.diagnostic&&status.diagnostic.message)||status.completion_unverified_reason||'完成状态未验证';
   console.log(`[${label}/10] ${task.task_id} completion_unverified: ${reason}`);
   return status;
  }
 }
 return null;
}

function makeRecord(index,task,submitInfo,status,answer,collected,info,started,validation){
 return {
  index:index+1,
  task:{
   task_id:task.task_id,
   model:task.model,
   purpose:task.purpose,
   source:task.source,
   prompt:task.prompt,
   files:task.files.slice(),
   continue_task_id:task.continue_task_id
  },
  submit:submitInfo?{reused:submitInfo.reused===true,status:submitInfo.status||null}:null,
  status,
  complete:status==='completed',
  result:{
   answer,
   total_chars:collected&&typeof collected.total_chars==='number'?collected.total_chars:answer.length,
   conversation_url:(info&&info.conversation_url)||null,
   result_file:(info&&info.result_file)||null
  },
  pages:collected?collected.pages:0,
  elapsedMs:Date.now()-started,
  validation
 };
}

async function runTask(index,submitClient,waitClient,otherClient,manifest,records){
 const task=manifest.tasks[index];
 const started=Date.now();
 let submitInfo=null;
 try{
  if(task.continue_task_id){
   const parent=records.find(record=>record&&record.task.task_id===task.continue_task_id);
   if(!parent||parent.status!=='completed')fail('续聊父任务未完成，停止提交');
  }
  submitInfo=await submitClient.call('gemini_submit',submitArgs(task));
  if(!submitInfo||submitInfo.task_id!==task.task_id)fail('gemini_submit 返回的 task_id 不一致');
  console.log(`[${index+1}/10] ${task.task_id} submitted reused=${submitInfo.reused===true} status=${submitInfo.status||'unknown'}`);

  const waited=await waitTerminal(waitClient,index+1,task);
  let collected=null;
  let collectError=null;
  if(waited&&(waited.status==='completed'||waited.has_partial_answer===true)){
   try{collected=await collectPaged(waitClient,otherClient,task.task_id);}
   catch(error){
    collectError=redact(error);
    collected=error.partial||null;
   }
  }
  const info={...(waited||{}),...(collected&&collected.last?collected.last:{})};
  info.pages=collected?collected.pages:0;
  const status=info.status||(waited?waited.status:'timeout');
  const answer=collected?collected.answer:'';
  let validation;
  if(!waited)validation={ok:false,checks:{statusCompleted:false},reason:'等待超时（未收到终态）'};
  else if(collectError)validation={ok:false,checks:{statusCompleted:status==='completed'},reason:`分页失败：${collectError}`};
  else validation=validateTask(index,task,answer,status,info,records);
  if(waited&&waited.completion_unverified===true&&!validation.ok){
   const reason=waited.wait_reason||(waited.diagnostic&&waited.diagnostic.message)||waited.completion_unverified_reason||'完成状态未验证';
   validation={...validation,reason:`${validation.reason}；完成状态未验证：${reason}`};
  }

  const record=makeRecord(index,task,submitInfo,status,answer,collected,info,started,validation);
  records[index]=record;
  console.log(`[${index+1}/10] ${task.task_id} ${record.status} pages=${record.pages} elapsedMs=${record.elapsedMs} validation=${record.validation.ok?'ok':'fail'}`);
  if(!record.validation.ok)console.error(`[${index+1}/10] ${task.task_id} 未通过: ${record.validation.reason}`);
  writeJson(path.join(OUTPUT,`result-${index+1}.json`),record);
  return record;
 }catch(error){
  const message=redact(error);
  const record=makeRecord(index,task,submitInfo,'error','',null,{},started,{ok:false,checks:{},reason:message});
  records[index]=record;
  console.error(`[${index+1}/10] ${task.task_id} 错误: ${message}`);
  writeJson(path.join(OUTPUT,`result-${index+1}.json`),record);
  return record;
 }
}

async function main(){
 const options=parseArgs(process.argv.slice(2));
 OUTPUT=path.resolve(process.cwd(),options.output);
 const relative=path.relative(STATE_ROOT,OUTPUT);
 if(relative.startsWith('..')||path.isAbsolute(relative))fail('--output 必须位于 workspace/state 内');
 fs.mkdirSync(OUTPUT,{recursive:true});

 let manifest;
 try{
  manifest=loadManifest(options.manifest);
 }catch(error){
  const message=redact(error);
  writeJson(path.join(OUTPUT,'validation.json'),{ok:false,run:null,error:message,tasks:[]});
  writeJson(path.join(OUTPUT,'progress.json'),{ok:false,error:message,tasks:[]});
  console.error(`[fatal] ${message}`);
  process.exitCode=1;
  return;
 }
 RUN=manifest.run;
 TOKEN=manifest.token;
 const records=new Array(EXPECTED_TASKS);
 const clients=[new Client(),new Client()];
 let fatal=null;

 const ordered=()=>Array.from({length:EXPECTED_TASKS},(_,index)=>records[index]||null);
 const writeProgress=()=>{
  writeJson(path.join(OUTPUT,'progress.json'),{
   run:RUN,
   ok:null,
   updatedAt:new Date().toISOString(),
   tasks:ordered().map((record,index)=>{
    const task=manifest.tasks[index];
    return record
     ?{index:index+1,task_id:task.task_id,model:task.model,status:record.status,pages:record.pages,elapsedMs:record.elapsedMs,validation:{ok:record.validation.ok,reason:record.validation.reason}}
     :{index:index+1,task_id:task.task_id,model:task.model,status:'pending',validation:null};
   })
  });
 };

 try{
  await Promise.all(clients.map(client=>client.init()));
  await Promise.all([
   runTask(0,clients[0],clients[0],clients[1],manifest,records),
   runTask(1,clients[1],clients[1],clients[0],manifest,records)
  ]);
  writeProgress();
  let stopped=!(records[0]&&records[0].validation.ok&&records[1]&&records[1].validation.ok);
  for(let index=2;index<manifest.tasks.length&&!stopped;index++){
   const record=await runTask(index,clients[0],clients[0],clients[1],manifest,records);
   writeProgress();
   if(!record.validation.ok)stopped=true;
  }
 }catch(error){
  fatal=redact(error);
  console.error(`[fatal] ${fatal}`);
 }finally{
  for(const client of clients){
   try{client.close();}
   catch{}
  }
 }

 const finalRecords=ordered();
 const models={flash:0,argon:0};
 for(const record of finalRecords){
  if(record&&models[record.task.model]!==undefined)models[record.task.model]++;
 }
 const allOk=finalRecords.every(record=>record&&record.status==='completed'&&record.validation.ok);
 const ok=allOk&&models.flash===5&&models.argon===5&&!fatal;
 const tasks=finalRecords.map((record,index)=>{
  const task=manifest.tasks[index];
  return record
   ?{index:index+1,task_id:task.task_id,model:task.model,status:record.status,complete:record.complete,pages:record.pages,elapsedMs:record.elapsedMs,validation:record.validation}
   :{index:index+1,task_id:task.task_id,model:task.model,status:'not_run',complete:false,pages:0,elapsedMs:null,validation:{ok:false,checks:{},reason:'未提交'}};
 });
 writeJson(path.join(OUTPUT,'validation.json'),{
  run:RUN,
  ok,
  finishedAt:new Date().toISOString(),
  error:fatal,
  models,
  tasks
 });
 writeJson(path.join(OUTPUT,'progress.json'),{
  run:RUN,
  ok,
  updatedAt:new Date().toISOString(),
  tasks:tasks.map(task=>({
   index:task.index,
   task_id:task.task_id,
   model:task.model,
   status:task.status,
   pages:task.pages,
   elapsedMs:task.elapsedMs,
   validation:{ok:task.validation.ok,reason:task.validation.reason}
  }))
 });
 console.log(`${ok?'ACCEPTANCE OK':'ACCEPTANCE FAIL'} run=${RUN} tasks=${finalRecords.filter(Boolean).length}/10 flash=${models.flash} argon=${models.argon}${fatal?` error=${fatal}`:''}`);
 if(!ok)process.exitCode=1;
}

main().catch(error=>{
 console.error(`[fatal] ${redact(error)}`);
 process.exitCode=1;
});
