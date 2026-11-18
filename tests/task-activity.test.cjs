const test=require('node:test');
const assert=require('node:assert/strict');
const {taskActivity,healthActivity}=require('../src/task-activity.cjs');

const LAST='2026-01-01T00:00:00.000Z';
const UPDATED='2026-01-01T00:00:05.000Z';
const PING='2026-01-01T00:01:00.000Z';

function status(overrides={}){
 return {
  status:'generating',phase:'generating',
  last_activity_at:LAST,updated_at:UPDATED,
  observer_state:'bound',event_connection:'connected',
  completion_unverified:false,completion_unverified_reason:null,diagnostic:null,
  has_partial_answer:false,budget_exhausted:false,
  error:null,error_code:null,next_retry_at:null,send_state:'confirmed',
  ...overrides
 };
}

function health(overrides={}){
 return {
  process:{supervisor_heartbeat_fresh:true,worker_heartbeat_fresh:true,stop_requested:false},
  bridge:{discovered:true,probe_ok:true,probe_error:null,read_only:false},
  desktop:{status:'ready'},
  readiness:{can_execute:true},
  connection:'connected',
  queue:{generating_count:0},
  ...overrides
 };
}

test('silent generating is normal generation, not observation loss',()=>{
 const activity=taskActivity(status());
 assert.equal(activity.state,'generating');
 assert.equal(activity.reason_code,'generating');
 assert.equal(activity.evidence_source,'saved_task');
 assert.equal(activity.observed_at,LAST);
 assert.match(activity.summary,/静默|没有新文字/);
 assert.match(activity.next_action,/不要重新提交/);
});

test('responsive idle ping with no progress is quiet, not lost',()=>{
 const activity=taskActivity(status({
  completion_unverified:true,completion_unverified_reason:'idle_ping_no_progress',
  diagnostic:{reason:'idle_ping_no_progress',idle_ping_ok:true,at:PING}
 }));
 assert.equal(activity.state,'quiet');
 assert.equal(activity.reason_code,'idle_ping_no_progress');
 assert.equal(activity.observed_at,PING);
 assert.match(activity.summary,/可响应|未观察到新进展/);
 assert.match(activity.next_action,/不要重新提交/);
});

test('answer with unverified completion awaits completion evidence',()=>{
 const activity=taskActivity(status({
  has_partial_answer:true,completion_unverified:true,completion_unverified_reason:'idle_answer_unverified',
  diagnostic:{reason:'idle_answer_unverified',idle_ping_ok:true,at:PING}
 }));
 assert.equal(activity.state,'awaiting_completion');
 assert.equal(activity.reason_code,'idle_answer_unverified');
 assert.match(activity.summary,/完成证据不足/);
 assert.match(activity.next_action,/不要当作已完成/);
});

test('idle_ping_failed outranks an existing answer and reports observation loss',()=>{
 const activity=taskActivity(status({
  has_partial_answer:true,completion_unverified:true,completion_unverified_reason:'idle_ping_failed',
  diagnostic:{reason:'idle_ping_failed',idle_ping_ok:false,at:PING}
 }));
 assert.equal(activity.state,'observation_lost');
 assert.equal(activity.reason_code,'idle_ping_failed');
 assert.match(activity.summary,/已有回答也不能证明完成/);
 assert.match(activity.next_action,/不要重新提交或重发/);
});

test('an explicit observer fault also reports observation loss',()=>{
 const activity=taskActivity(status({has_partial_answer:true,observer_state:'fault'}));
 assert.equal(activity.state,'observation_lost');
 assert.equal(activity.reason_code,'observer_fault');
});

test('disconnected generation and bounded retry are reconnecting',()=>{
 const dropped=taskActivity(status({event_connection:'disconnected'}));
 assert.equal(dropped.state,'reconnecting');
 assert.equal(dropped.reason_code,'connection_disconnected');
 const staleQuiet=taskActivity(status({event_connection:'disconnected',completion_unverified:true,completion_unverified_reason:'idle_ping_no_progress',diagnostic:{reason:'idle_ping_no_progress',idle_ping_ok:true,at:PING}}));
 assert.equal(staleQuiet.state,'reconnecting','a past responsive ping cannot conceal a currently disconnected stream');
 const retrying=taskActivity(status({status:'retry_wait',phase:'retry_wait',next_retry_at:'2026-01-01T00:02:00.000Z'}));
 assert.equal(retrying.state,'reconnecting');
 assert.equal(retrying.reason_code,'retry_scheduled');
 assert.match(retrying.summary,/2026-01-01T00:02:00.000Z/);
 assert.match(retrying.next_action,/不要重新提交或重发/);
});

test('terminal states outrank stale connection fields',()=>{
 const completed=taskActivity(status({
  status:'completed',event_connection:'disconnected',
  diagnostic:{reason:'idle_ping_failed',idle_ping_ok:false,at:PING},completion_unverified:true
 }));
 assert.equal(completed.state,'completed');
 const failed=taskActivity(status({status:'failed',error_code:'BOOM',event_connection:'disconnected'}));
 assert.equal(failed.state,'failed');
 assert.match(failed.summary,/BOOM/);
});

test('budget-exhausted partial is never presented as completed',()=>{
 const activity=taskActivity(status({status:'partial',budget_exhausted:true,event_connection:'disconnected',has_partial_answer:true}));
 assert.equal(activity.state,'partial');
 assert.equal(activity.reason_code,'budget_exhausted');
 assert.match(activity.summary,/预算已用尽/);
 assert.match(activity.summary,/未确认完成/);
 assert.doesNotMatch(activity.summary,/已完成/);
 assert.match(activity.next_action,/不要重发/);
});

test('preserves queued, uncertain and needs_user_action meanings without resend advice',()=>{
 const queued=taskActivity(status({status:'queued',event_connection:'disconnected'}));
 assert.equal(queued.state,'queued');
 const uncertain=taskActivity(status({status:'uncertain',send_state:'intent_persisted'}));
 assert.equal(uncertain.state,'uncertain');
 assert.match(uncertain.next_action,/不要重新提交或重发/);
 const blocked=taskActivity(status({status:'needs_user_action'}));
 assert.equal(blocked.state,'needs_user_action');
 assert.match(blocked.next_action,/gemini_connect/);
});

test('observed_at never invents a fresh time',()=>{
 const missing=taskActivity(status({last_activity_at:null,updated_at:null}));
 assert.equal(missing.observed_at,null);
 assert.equal(missing.evidence_source,'saved_task');
 const preferred=taskActivity(status({
  completion_unverified:true,completion_unverified_reason:'idle_ping_no_progress',
  diagnostic:{reason:'idle_ping_no_progress',idle_ping_ok:true,at:PING}
 }));
 assert.equal(preferred.observed_at,PING);
});

test('health idle is normal and does not call silent zero activity broken',()=>{
 const activity=healthActivity(health());
 assert.equal(activity.state,'idle');
 assert.equal(activity.evidence_source,'health_probe');
 assert.ok(Number.isFinite(Date.parse(activity.observed_at)));
 assert.match(activity.summary,/空闲|0 个任务/);
 assert.doesNotMatch(activity.summary,/失联/);
});

test('health working reflects live generation count',()=>{
 const activity=healthActivity(health({queue:{generating_count:2}}));
 assert.equal(activity.state,'working');
 assert.match(activity.summary,/2 个任务/);
});

test('health without a probe reports not_running without faking observed_at',()=>{
 const activity=healthActivity({
  process:{supervisor_heartbeat_fresh:false,worker_heartbeat_fresh:false},
  bridge:{discovered:false,probe_ok:false,probe_error:null,read_only:false},
  desktop:{status:'not_running'},connection:'not_started',queue:{generating_count:0}
 });
 assert.equal(activity.state,'not_running');
 assert.equal(activity.evidence_source,'health_snapshot');
 assert.equal(activity.observed_at,null);
 assert.match(activity.summary,/0 个任务.*正常/);
 assert.match(activity.next_action,/connect|按需/);
});

test('health bridge probe failure is reconnecting and never healthy',()=>{
 const activity=healthActivity(health({
  bridge:{discovered:true,probe_ok:false,probe_error:{code:'DESKTOP_RPC_TIMEOUT',message:'timeout'},read_only:false}
 }));
 assert.equal(activity.state,'reconnecting');
 assert.equal(activity.evidence_source,'health_snapshot');
 assert.equal(activity.observed_at,null);
 assert.match(activity.summary,/无法证实|探测失败/);
 assert.doesNotMatch(activity.summary,/健康/);
});

test('health read-only and stop request map to explicit states',()=>{
 const missing=healthActivity(health({desktop:{status:'configuration_missing'},bridge:{probe_ok:false,discovered:false},process:{}}));
 assert.equal(missing.state,'needs_user_action');
 assert.equal(missing.reason_code,'configuration_missing');
 const blocked=healthActivity(health({bridge:{discovered:true,probe_ok:true,probe_error:null,read_only:true}}));
 assert.equal(blocked.state,'needs_user_action');
 const stopped=healthActivity(health({process:{supervisor_heartbeat_fresh:true,worker_heartbeat_fresh:true,stop_requested:true}}));
 assert.equal(stopped.state,'stopped');
});

test('health with a fresh worker but no discovery reconnects instead of claiming healthy',()=>{
 const activity=healthActivity(health({
  bridge:{discovered:false,probe_ok:false,probe_error:null,read_only:false}
 }));
 assert.equal(activity.state,'reconnecting');
 assert.equal(activity.reason_code,'bridge_not_discovered');
 assert.doesNotMatch(activity.summary,/健康/);
});
