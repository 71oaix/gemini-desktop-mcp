const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Client}=require('../client.cjs');
require('../desktop-transport.cjs');
require('../worker.cjs');
require('../supervisor.cjs');
require('../server.cjs');

test('two MCP clients share one idempotent desktop queue and enforce TXT boundaries',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-work-test-'));
 const a=new Client({GEMINI_WORK_STATE:state,GEMINI_WORK_NO_AUTOSTART:'1'});
 const b=new Client({GEMINI_WORK_STATE:state,GEMINI_WORK_NO_AUTOSTART:'1'});
 const startupErrors=[];
 for(const [name,client] of [['a',a],['b',b]])client.child.stderr.on('data',bytes=>startupErrors.push(name+': '+bytes.toString()));
 try{
  const init=await a.init();await b.init();
  assert.equal(init.serverInfo.name,'gemini-work');assert.equal(init.serverInfo.version,'1.16.0');
  const list=await a.rpc('tools/list');
  assert.deepEqual(list.tools.map(t=>t.name),['gemini_connect','gemini_submit','gemini_status','gemini_wait','gemini_result','gemini_health','gemini_capabilities','gemini_release']);

  const file=path.join(state,'review.txt');fs.writeFileSync(file,'module.exports = 123;');
  const args={task_id:'cross-chat-01',prompt:'审核附件',purpose:'review',files:[file]};
  const [first,second]=await Promise.all([a.call('gemini_submit',args),b.call('gemini_submit',args)]);
  assert.equal(first.task_id,second.task_id);
  assert.equal([first,second].filter(result=>!result.reused).length,1);
  assert.equal(first.marker,second.marker);
  assert.match(first.marker,/^\[gemini-work:[0-9a-f]{24}\]$/);

  const status=await b.call('gemini_status',{task_id:first.task_id});
  assert.equal(status.requested_model,'hydrogen');assert.equal(status.model,null);assert.ok(['queued','staging'].includes(status.status));
  assert.equal(status.marker,first.marker);assert.equal(status.transport,'desktop-loopback');
  assert.equal(status.send_state,'not_sent');
  assert.equal(status.activity.state,'queued');assert.equal(status.activity.evidence_source,'saved_task');
  assert.equal(status.activity.reason_code,'queued');assert.ok(status.activity.observed_at);
  assert.equal(typeof status.activity.summary,'string');assert.equal(typeof status.activity.next_action,'string');

  fs.writeFileSync(file,'module.exports = 999;');
  await assert.rejects(()=>b.call('gemini_submit',args),/不同内容|冲突/);
  const staged=fs.readFileSync(path.join(state,'tasks','cross-chat-01','attachments','00-review.txt'),'utf8');
  assert.match(staged,/123/);

  await assert.rejects(()=>a.call('gemini_submit',{prompt:'x',files:['relative.txt']}),/绝对/);
  const secret=path.join(state,'.env');fs.writeFileSync(secret,'TEST_ONLY=not_a_secret');
  await assert.rejects(()=>a.call('gemini_submit',{prompt:'x',files:[secret]}),/凭据/);
  const binary=path.join(state,'image.png');fs.writeFileSync(binary,'not-a-real-png');
  await assert.rejects(()=>a.call('gemini_submit',{prompt:'x',files:[binary]}),/TXT|txt/);
  await assert.rejects(()=>a.call('gemini_status',{task_id:'../outside'}),/task_id/);

  const pending=await a.call('gemini_result',{task_id:'cross-chat-01'});
  assert.equal(pending.complete,false);assert.equal(pending.answer,'');
  assert.equal(pending.activity.state,'queued');assert.equal(pending.activity.evidence_source,'saved_task');

  const secondTask=await a.call('gemini_submit',{task_id:'cross-chat-02',prompt:'second',files:[file]});
  assert.equal(secondTask.status,'queued');
  const positioned=await a.call('gemini_status',{task_id:'cross-chat-02'});
  assert.equal(positioned.queue_position,2);

  const submitTool=list.tools.find(tool=>tool.name==='gemini_submit');
  assert.equal(submitTool.inputSchema.properties.model.enum,undefined,'model must not be a fixed enum');
  assert.match(submitTool.inputSchema.properties.model.description,/Hydrogen/);
  assert.doesNotMatch(submitTool.description,/自动创建|保底补做/);

  const health=await b.call('gemini_health');
  assert.equal(health.transport,'desktop-loopback');
  assert.equal(health.transport_mode,'desktop');
  assert.equal(health.acceptance,'unverified');
  assert.equal(health.playwright,false);
  assert.equal(health.cookie_export,false);
  assert.equal(health.models.default,'hydrogen');
  assert.equal(health.models.observed,false);
  assert.equal(health.models.source,'static_aliases');
  assert.equal(health.models.live,false);
  assert.equal(health.models.discovery_tool,'gemini_capabilities');
  assert.match(health.models.note,/菜单|未观察/);
  assert.equal(health.activity.state,health.desktop.status==='not_running'?'not_running':'needs_user_action');
  assert.equal(health.activity.evidence_source,'health_snapshot');
  assert.equal(health.activity.observed_at,null);
  assert.equal(health.process.stop_requested,false);
  assert.equal(health.queue.queued,2);
  assert.equal(health.worker_alive,false);
  assert.equal(health.desktop.expected_app_version,'1.16.0');
  assert.equal(health.bridge.discovered,false);
  assert.equal(health.readiness.can_execute,false);
  assert.equal(health.attachments.only,'txt');
  assert.equal(health.discovery_guidance.port_ephemeral,true);
  assert.equal(health.discovery_guidance.action,'rerun_health_or_connect');
  assert.equal(typeof health.discovery_guidance.message,'string');
  assert.match(health.discovery_guidance.message,/自动发现/);
  assert.ok(['configuration_missing','not_installed','version_mismatch','not_running'].includes(health.desktop.status));

  const capabilities=await a.call('gemini_capabilities');
  assert.equal(capabilities.status,'unavailable');
  assert.equal(capabilities.observed,false);
  assert.equal(capabilities.default_model,null);
  assert.deepEqual(capabilities.models,[]);
  assert.deepEqual(capabilities.thinking.levels,[]);
  assert.equal(typeof capabilities.reason,'string');assert.ok(capabilities.reason);
  const capabilitiesTool=list.tools.find(tool=>tool.name==='gemini_capabilities');
  assert.deepEqual(capabilitiesTool.inputSchema.properties,{});

  const dynamic=await a.call('gemini_submit',{task_id:'dynamic-model',prompt:'future model',model:'Test Nova'});
  assert.equal(dynamic.status,'queued');
  const dynamicStatus=await a.call('gemini_status',{task_id:'dynamic-model'});
  assert.equal(dynamicStatus.requested_model,'Test Nova');
  const defaulted=await a.call('gemini_submit',{task_id:'default-model',prompt:'default model'});
  assert.equal((await a.call('gemini_status',{task_id:'default-model'})).requested_model,'hydrogen');
  assert.equal(defaulted.status,'queued');
 }catch(error){throw new Error(error.message+'\nMCP startup stderr:\n'+startupErrors.join(''),{cause:error});}
 finally{a.close();b.close();}
});

test('gemini_wait wakes from another process write and its own deadline never changes execution',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-mcp-wait-'));
 const a=new Client({GEMINI_WORK_STATE:state,GEMINI_WORK_NO_AUTOSTART:'1'});
 try{
  await a.init();await a.call('gemini_submit',{task_id:'wait-case',prompt:'hello'});
  const expired=await a.call('gemini_wait',{task_id:'wait-case',wait_sec:0});
  assert.equal(expired.wait_expired,true);assert.equal(expired.status,'queued');
  const waiting=a.call('gemini_wait',{task_id:'wait-case',wait_sec:2});
  await new Promise(r=>setTimeout(r,80));
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(state,'tasks.sqlite'));
  db.prepare("UPDATE tasks SET status='completed' WHERE id='wait-case'").run();db.close();
  const value=await waiting;assert.equal(value.status,'completed');assert.equal(value.wait_expired,false);
 }finally{a.close();}
});

test('CLI capabilities entry returns a structured unavailable catalog without starting the worker',()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-cli-caps-'));
 const {spawnSync}=require('node:child_process');
 const run=spawnSync(process.execPath,[path.join(__dirname,'..','client.cjs'),'capabilities'],{
  env:{...process.env,GEMINI_WORK_STATE:state,GEMINI_WORK_NO_AUTOSTART:'1'},
  encoding:'utf8',timeout:60000,cwd:path.join(__dirname,'..')
 });
 assert.equal(run.status,0,run.stderr);
 const value=JSON.parse(run.stdout);
 assert.equal(value.status,'unavailable');
 assert.equal(value.observed,false);
 assert.equal(value.default_model,null);
 assert.deepEqual(value.models,[]);
 assert.deepEqual(value.thinking.levels,[]);
 assert.equal(typeof value.reason,'string');
});

test('server exit rejects a long client wait and releases all timers',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-wait-close-'));
 const c=new Client({GEMINI_WORK_STATE:state,GEMINI_WORK_NO_AUTOSTART:'1'});
 try{await c.init();await c.call('gemini_submit',{task_id:'close-case',prompt:'hello'});
 const waiting=c.call('gemini_wait',{task_id:'close-case',wait_sec:1800});
 const rejected=assert.rejects(waiting,/退出|关闭/);
 await new Promise(r=>setTimeout(r,60));c.child.stdin.end();await rejected;assert.equal(c.pending.size,0);
 }finally{c.close();}
});
