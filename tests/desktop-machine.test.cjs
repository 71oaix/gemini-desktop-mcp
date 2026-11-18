'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {TaskMachine,PHASES,PHASE_STATUS,COMPLETION_STABLE_MS}=require('../desktop-machine.cjs');

const MARKER='[gemini-work:machine:abcd1234]';

function pageState(over={}){
 return {
  url:'https://gemini.google.com/app/conv-1',protocol:'https:',origin:'https://gemini.google.com',
  clientShell:false,hasInput:true,draft:'',dialog:false,backdrop:false,generates:false,
  uploads:[],controls:[],models:[],sendButtons:[],queries:[MARKER],responses:[],bodyText:'',...over
 };
}
function clock(){
 let now=0,next=1;
 const timers=new Map();
 return {
  now:()=>now,
  setTimeout(fn,ms){const id=next++;timers.set(id,{at:now+ms,fn});return id;},
  clearTimeout(id){timers.delete(id);},
  advance(ms){
   now+=ms;
   let ran=true;
   while(ran){
    ran=false;
    for(const [id,timer] of Array.from(timers)){
     if(timer.at<=now){timers.delete(id);timer.fn();ran=true;break;}
    }
   }
  },
  pending(){return timers.size;}
 };
}
function machineFor(over={},clockRef){
 const c=clockRef||clock();
 const machine=new TaskMachine({marker:MARKER,beforeResponses:0,confirmedUrl:'https://gemini.google.com/app/conv-1',...over},{stableMs:COMPLETION_STABLE_MS,now:c.now,setTimeout:c.setTimeout,clearTimeout:c.clearTimeout});
 return {machine,clock:c};
}
function response(answer,over={}){return {answer,complete:false,...over};}
function collect(machine){
 const outcomes={complete:null,conflicts:[]};
 machine.on('complete',outcome=>{outcomes.complete=outcome;});
 machine.on('conflict',outcome=>{outcomes.conflicts.push(outcome);});
 return outcomes;
}

test('machine exposes the FSM phases with legacy public status mapping',()=>{
 assert.deepEqual(PHASES,['preparing','ready_to_send','awaiting_confirmation','generating','verifying_completion','completed','retry_wait','needs_user_action','uncertain']);
 assert.equal(PHASE_STATUS.ready_to_send,'submitting');
 assert.equal(PHASE_STATUS.verifying_completion,'generating');
 const {machine}=machineFor();
 assert.equal(machine.phase,'preparing');
 assert.equal(machine.status,'connecting');
 machine.setPhase('ready_to_send');
 assert.equal(machine.status,'submitting');
 machine.setPhase('awaiting_confirmation');
 assert.equal(machine.status,'submitting');
 machine.arm();
 assert.equal(machine.phase,'generating');
 assert.equal(machine.status,'generating');
});

test('completion needs unique last marker, a new own response, completion marker, no stop, and 2s stability',()=>{
 const {machine,clock:c}=machineFor();
 const outcomes=collect(machine);
 machine.arm();
 machine.ingest(pageState({responses:[response('partial')]}));
 assert.equal(outcomes.complete,null);
 machine.ingest(pageState({responses:[response('full answer',{complete:true})]}));
 assert.equal(machine.phase,'verifying_completion');
 machine.noteNative({phase:'completed',task_id:'machine'});
 // Native notification is advisory and does not finish the candidate.
 assert.equal(outcomes.complete,null);
 c.advance(COMPLETION_STABLE_MS-1);
 assert.equal(outcomes.complete,null);
 c.advance(1);
 assert.ok(outcomes.complete);
 assert.equal(outcomes.complete.answer,'full answer');
 assert.equal(outcomes.complete.stable_ms,2000);
 assert.equal(machine.phase,'completed');
 assert.equal(machine.status,'completed');
 assert.equal(machine.diagnostics.completions,1);
 assert.ok(machine.diagnostics.completion.completed_at);
 assert.equal(machine.diagnostics.completion.stable_ms,2000);
});

test('text rewrites and completion-candidate invalidation restart the one-shot stability window',()=>{
 const {machine,clock:c}=machineFor();
 const outcomes=collect(machine);
 machine.arm();
 machine.ingest(pageState({responses:[response('A',{complete:true})]}));
 c.advance(1000);
 machine.ingest(pageState({responses:[response('AB',{complete:true})]}));
 assert.equal(machine.phase,'verifying_completion');
 c.advance(1500);
 assert.equal(outcomes.complete,null);
 c.advance(500);
 assert.ok(outcomes.complete);
 assert.equal(outcomes.complete.answer,'AB');
 assert.ok(machine.diagnostics.resets>=1);
});

test('duplicate markers, non-last markers, missing new responses, and stop suppress completion',()=>{
 const duplicated=machineFor();
 const dup=collect(duplicated.machine);
 duplicated.machine.arm();
 duplicated.machine.ingest(pageState({queries:[MARKER,MARKER],responses:[response('x',{complete:true})]}));
 assert.equal(dup.conflicts.at(-1).code,'MARKER_DUPLICATED');
 assert.equal(dup.complete,null);
 const notLast=machineFor();
 const late=collect(notLast.machine);
 notLast.machine.arm();
 notLast.machine.ingest(pageState({queries:[MARKER,'later message'],responses:[response('x',{complete:true})]}));
 assert.equal(late.conflicts.at(-1).code,'MARKER_NOT_LAST');
 const old=machineFor({beforeResponses:1});
 const oldOut=collect(old.machine);
 old.machine.arm();
 old.machine.ingest(pageState({responses:[response('previous turn',{complete:true})]}));
 old.clock.advance(5000);
 assert.equal(oldOut.complete,null);
 assert.equal(old.machine.phase,'generating');
 const stopped=machineFor();
 const stopOut=collect(stopped.machine);
 stopped.machine.arm();
 stopped.machine.ingest(pageState({controls:[{label:'停止回答',text:''}],responses:[response('x',{complete:true})]}));
 stopped.clock.advance(5000);
 assert.equal(stopOut.complete,null);
 assert.equal(stopped.machine.phase,'generating');
});

test('conversation URL and marker mismatch stop the machine without completion',()=>{
 const {machine,clock:c}=machineFor();
 const outcomes=collect(machine);
 machine.arm();
 machine.ingest(pageState({url:'https://gemini.google.com/app/other',responses:[response('x',{complete:true})]}));
 assert.equal(outcomes.conflicts.at(-1).code,'CONVERSATION_CHANGED');
 assert.equal(machine.phase,'needs_user_action');
 c.advance(5000);
 assert.equal(outcomes.complete,null);
 const missing=machineFor();
 const missingOut=collect(missing.machine);
 missing.machine.arm();
 missing.machine.ingest(pageState({queries:[],responses:[response('x',{complete:true})]}));
 missing.clock.advance(5000);
 assert.equal(missingOut.complete,null);
 assert.equal(missing.machine.phase,'generating');
 const mismatch=machineFor();
 const mismatchOut=collect(mismatch.machine);
 mismatch.machine.arm();
 mismatch.machine.ingest(pageState({responses:[response('partial')]}));
 mismatch.machine.ingest(pageState({queries:['a different user message'],responses:[response('x',{complete:true})]}));
 assert.equal(mismatchOut.conflicts.at(-1).code,'MARKER_MISMATCH');
 mismatch.clock.advance(5000);
 assert.equal(mismatchOut.complete,null);
});

test('truncated answer or state overflow stops before completion and retains the prior answer',()=>{
 const {machine,clock:c}=machineFor();
 const outcomes=collect(machine);
 machine.arm();
 machine.ingest(pageState({responses:[response('prior full partial')]}));
 machine.ingest(pageState({responses:[response('prior full partial',{complete:true,answer_truncated:true})]}));
 assert.equal(outcomes.conflicts.at(-1).code,'ANSWER_TRUNCATED');
 assert.equal(machine.terminal,true);
 assert.equal(machine.answer,'prior full partial');
 assert.equal(machine.phase,'needs_user_action');
 c.advance(5000);
 assert.equal(outcomes.complete,null);
 const overflow=machineFor();
 const overflowOut=collect(overflow.machine);
 overflow.machine.arm();
 overflow.machine.ingest(pageState({truncated:true,responses:[response('x',{complete:true})]}));
 assert.equal(overflowOut.conflicts.at(-1).code,'STATE_TRUNCATED');
 overflow.clock.advance(5000);
 assert.equal(overflowOut.complete,null);
});

test('native lifecycle phases remain advisory and keep task correlation when provided',()=>{
 const {machine,clock:c}=machineFor({taskId:'machine'});
 const outcomes=collect(machine);
 machine.arm();
 for(const phase of ['thinking','generating','completed'])machine.noteNative({phase,task_id:'machine'});
 assert.equal(machine.phase,'generating');
 assert.equal(machine.diagnostics.native,3);
 assert.equal(machine.native.at(-1).correlated,true);
 machine.noteNative({phase:'completed',task_id:'other-task'});
 assert.equal(machine.native.at(-1).correlated,false);
 c.advance(5000);
 assert.equal(outcomes.complete,null);
 machine.ingest(pageState({responses:[response('real',{complete:true})]}));
 c.advance(2000);
 assert.ok(outcomes.complete);
 assert.equal(outcomes.complete.answer,'real');
});

test('interruption and disposal cancel pending stability without a fake completion',()=>{
 const interrupted=machineFor();
 const outcomes=collect(interrupted.machine);
 interrupted.machine.arm();
 interrupted.machine.ingest(pageState({responses:[response('pending',{complete:true})]}));
 interrupted.machine.interrupt('USER_INTERFERENCE','用户输入');
 assert.equal(outcomes.conflicts.at(-1).code,'USER_INTERFERENCE');
 interrupted.clock.advance(5000);
 assert.equal(outcomes.complete,null);
 assert.equal(interrupted.machine.phase,'needs_user_action');
 const disposed=machineFor();
 const disposedOut=collect(disposed.machine);
 disposed.machine.arm();
 disposed.machine.ingest(pageState({responses:[response('pending',{complete:true})]}));
 disposed.machine.dispose();
 disposed.clock.advance(5000);
 assert.equal(disposedOut.complete,null);
});
test('navigation invalidates a completion candidate until a new owned state arrives',()=>{
 const {machine,clock:c}=machineFor();const outcomes=collect(machine);machine.arm();
 machine.ingest(pageState({responses:[response('pending',{complete:true})]}));
 machine.noteFault({code:'NAVIGATION',message:'document replaced'});c.advance(5000);
 assert.equal(outcomes.complete,null);assert.equal(machine.phase,'generating');
 machine.ingest(pageState({responses:[response('after rebind',{complete:true})]}));c.advance(2000);
 assert.equal(outcomes.complete.answer,'after rebind');
});
test('a page without the own marker cannot publish or overwrite any answer',()=>{
 const {machine}=machineFor();const answers=[];machine.on('answer',e=>answers.push(e.answer));machine.arm();
 machine.ingest(pageState({queries:[],responses:[response('UNOWNED_RESPONSE')]}));
 assert.deepEqual(answers,[]);assert.equal(machine.answer,'');
 machine.ingest(pageState({responses:[response('owned partial')]}));
 machine.ingest(pageState({queries:[],responses:[response('unowned replacement')]}));
 assert.equal(machine.answer,'owned partial');assert.deepEqual(answers,['owned partial']);machine.dispose();
});
test('native pair is diagnostic only and cannot substitute for page completion',()=>{
 const {machine,clock:c}=machineFor({taskId:'bound'});const out=collect(machine);machine.arm();
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'conv-1',sequence:1});
 machine.ingest(pageState({responses:[response('answer')]}));c.advance(3000);assert.equal(out.complete,null);
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'other',sequence:2});machine.noteNative({phase:'complete',task_id:'bound',conversationId:'other',sequence:3});c.advance(3000);assert.equal(out.complete,null);
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'conv-1',sequence:4});machine.noteNative({phase:'complete',task_id:'bound',conversationId:'conv-1',sequence:5});
 c.advance(3000);
 assert.equal(out.complete,null);
 assert.equal(machine.phase,'generating');
 assert.equal(machine.nativeStart.phase,'start');
 assert.equal(machine.nativeComplete.phase,'complete');
 machine.ingest(pageState({responses:[response('answer',{complete:true})]}));
 c.advance(1999);assert.equal(out.complete,null);c.advance(1);
 assert.equal(out.complete.answer,'answer');assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
test('native c_<url-id> pair stays diagnostic-only and keeps raw ids',()=>{
 const url='https://gemini.google.com/app/0000000000000001';
 const {machine,clock:c}=machineFor({taskId:'push-49f59947-1',confirmedUrl:url});
 const out=collect(machine);machine.arm();
 machine.noteNative({phase:'start',task_id:'push-49f59947-1',conversationId:'c_0000000000000001',sequence:1});
 machine.ingest(pageState({url,responses:[response('flash answer')]}));
 assert.equal(machine.phase,'generating');
 machine.noteNative({phase:'complete',task_id:'push-49f59947-1',conversationId:'c_0000000000000001',sequence:2});
 assert.equal(machine.phase,'generating');
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete,null);
 assert.equal(machine.native[0].conversationId,'c_0000000000000001');
 assert.equal(machine.native[1].conversationId,'c_0000000000000001');
 assert.equal(machine.native[0].correlated,true);
 // Only an explicit page completion control may finish the same answer.
 machine.ingest(pageState({url,responses:[response('flash answer',{complete:true})]}));
 c.advance(COMPLETION_STABLE_MS);
 assert.ok(out.complete);
 assert.equal(out.complete.answer,'flash answer');
 assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
test('plain native conversation id is paired for diagnostics but cannot complete',()=>{
 const url='https://gemini.google.com/app/0000000000000001';
 const {machine,clock:c}=machineFor({taskId:'bound',confirmedUrl:url});
 const out=collect(machine);machine.arm();
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'0000000000000001',sequence:1});
 machine.ingest(pageState({url,responses:[response('plain answer')]}));
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'0000000000000001',sequence:2});
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete,null);
 assert.equal(machine.phase,'generating');
 assert.equal(machine.diagnostics.native,2);
 machine.ingest(pageState({url,responses:[response('plain answer',{complete:true})]}));
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete.answer,'plain answer');
 assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
test('different, unknown-prefix, or substring native ids cannot complete',()=>{
 const url='https://gemini.google.com/app/0000000000000001';
 for(const conversationId of ['c_other','x_0000000000000001','000000000000001']){
  const {machine,clock:c}=machineFor({taskId:'bound',confirmedUrl:url});
  const out=collect(machine);machine.arm();
  machine.ingest(pageState({url,responses:[response('answer')]}));
  machine.noteNative({phase:'start',task_id:'bound',conversationId,sequence:1});
  machine.noteNative({phase:'complete',task_id:'bound',conversationId,sequence:2});
  c.advance(COMPLETION_STABLE_MS);
  assert.equal(out.complete,null,conversationId);
  assert.equal(machine.phase,'generating',conversationId);
  assert.equal(machine.native[0].conversationId,conversationId);
 }
});
test('native complete without an ordered start cannot finish',()=>{
 const url='https://gemini.google.com/app/0000000000000001';
 const {machine,clock:c}=machineFor({taskId:'bound',confirmedUrl:url});
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({url,responses:[response('answer')]}));
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_0000000000000001',sequence:1});
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete,null);
 assert.equal(machine.phase,'generating');
});
test('the marker query index must own a paired response slot; older answers are never published',()=>{
 const {machine,clock:c}=machineFor({beforeResponses:1});
 const out=collect(machine);const answers=[];
 machine.on('answer',event=>answers.push(event.answer));
 machine.arm();
 // Third query owns slot 2, but only two old responses exist.
 machine.ingest(pageState({
  queries:['old question 1','old question 2',MARKER],
  responses:[response('old answer 1',{complete:true}),response('old answer 2',{complete:true})]
 }));
 assert.deepEqual(answers,[]);
 assert.equal(machine.answer,'');
 assert.equal(machine.candidate,null);
 assert.equal(machine.phase,'generating');
 assert.equal(machine.diagnostics.unpaired,1);
 assert.equal(machine.diagnostics.last_unpaired.reason,'length-mismatch');
 c.advance(5000);
 assert.equal(out.complete,null);
 // The marker's own third answer completes normally once its slot appears.
 machine.ingest(pageState({
  queries:['old question 1','old question 2',MARKER],
  responses:[response('old answer 1',{complete:true}),response('old answer 2',{complete:true}),response('own answer',{complete:true})]
 }));
 assert.deepEqual(answers,['own answer']);
 assert.equal(machine.phase,'verifying_completion');
 c.advance(COMPLETION_STABLE_MS);
 assert.ok(out.complete);
 assert.equal(out.complete.answer,'own answer');
 assert.equal(out.complete.responseIndex,2);
 assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
test('unpaired DOM arrays and slots before the send baseline wait without guessing',()=>{
 const extra=machineFor();
 const extraOut=collect(extra.machine);const extraAnswers=[];
 extra.machine.on('answer',event=>extraAnswers.push(event.answer));
 extra.machine.arm();
 extra.machine.ingest(pageState({queries:[MARKER],responses:[response('first',{complete:true}),response('second',{complete:true})]}));
 assert.deepEqual(extraAnswers,[]);
 assert.equal(extra.machine.answer,'');
 assert.equal(extra.machine.candidate,null);
 assert.equal(extraOut.complete,null);
 assert.equal(extra.machine.diagnostics.last_unpaired.reason,'length-mismatch');
 extra.clock.advance(5000);
 assert.equal(extraOut.complete,null);
 const baseline=machineFor({beforeResponses:1});
 const baselineOut=collect(baseline.machine);const baselineAnswers=[];
 baseline.machine.on('answer',event=>baselineAnswers.push(event.answer));
 baseline.machine.arm();
 baseline.machine.ingest(pageState({queries:[MARKER],responses:[response('older answer',{complete:true})]}));
 assert.deepEqual(baselineAnswers,[]);
 assert.equal(baseline.machine.candidate,null);
 assert.equal(baseline.machine.diagnostics.last_unpaired.reason,'marker-before-baseline');
 baseline.clock.advance(5000);
 assert.equal(baselineOut.complete,null);
});
test('an unpaired DOM cannot reuse a pending page completion candidate',()=>{
 const {machine,clock:c}=machineFor();
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({responses:[response('good answer',{complete:true})]}));
 assert.equal(machine.phase,'verifying_completion');
 c.advance(1000);
 machine.ingest(pageState({queries:[MARKER],responses:[]}));
 assert.equal(machine.candidate,null);
 assert.equal(machine.phase,'generating');
 assert.equal(machine.diagnostics.unpaired,1);
 c.advance(5000);
 assert.equal(out.complete,null);
});
test('duplicate or overlapping native starts void native evidence instead of guessing a pair',()=>{
 const {machine,clock:c}=machineFor({taskId:'bound'});
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({responses:[response('streamed answer')]}));
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'conv-1',sequence:1});
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'conv-1',sequence:2});
 assert.equal(machine.snapshot().native_ambiguous,true);
 assert.equal(machine.diagnostics.native_ambiguity.code,'NATIVE_START_DUPLICATED');
 // complete3 must not be assigned to either start.
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'conv-1',sequence:3});
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'conv-1',sequence:4});
 // A later start/complete cannot repair evidence voided by the duplicate start.
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'conv-1',sequence:5});
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'conv-1',sequence:6});
 c.advance(5000);
 assert.equal(out.complete,null);
 assert.equal(machine.phase,'generating');
});
test('a duplicate native complete is diagnostic only and leaves a page candidate intact',()=>{
 const {machine,clock:c}=machineFor({taskId:'bound'});
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({responses:[response('answer',{complete:true})]}));
 assert.equal(machine.phase,'verifying_completion');
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'conv-1',sequence:1});
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'conv-1',sequence:2});
 c.advance(1000);
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'conv-1',sequence:3});
 assert.equal(machine.diagnostics.native_ambiguity.code,'NATIVE_PAIR_INVALID');
 assert.equal(machine.snapshot().native_ambiguous,true);
 assert.ok(machine.candidate);
 assert.equal(machine.phase,'verifying_completion');
 c.advance(1000);
 assert.ok(out.complete);
 assert.equal(out.complete.answer,'answer');
 assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
test('an out-of-order native complete sequence cannot be reused',()=>{
 const {machine,clock:c}=machineFor({taskId:'bound'});
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({responses:[response('answer')]}));
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'conv-1',sequence:5});
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'conv-1',sequence:3});
 assert.equal(machine.snapshot().native_ambiguous,true);
 assert.equal(machine.diagnostics.native_ambiguity.code,'NATIVE_PAIR_INVALID');
 c.advance(5000);
 assert.equal(out.complete,null);
});
test('a reliable page completion control still completes after native evidence is voided',()=>{
 const {machine,clock:c}=machineFor({taskId:'bound'});
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({responses:[response('answer')]}));
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'conv-1',sequence:1});
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'conv-1',sequence:2});
 machine.ingest(pageState({responses:[response('answer',{complete:true})]}));
 c.advance(COMPLETION_STABLE_MS);
 assert.ok(out.complete);
 assert.equal(out.complete.answer,'answer');
 assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
test('a fast native pair accepted during awaiting_confirmation cannot complete on its own',()=>{
 const {machine,clock:c}=machineFor({taskId:'bound'});
 const out=collect(machine);
 machine.setPhase('awaiting_confirmation');
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1});
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2});
 machine.arm();
 machine.ingest(pageState({responses:[response('fast answer')]}));
 assert.equal(machine.phase,'generating');
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete,null);
 assert.equal(machine.diagnostics.native,2);
 machine.ingest(pageState({responses:[response('fast answer',{complete:true})]}));
 c.advance(COMPLETION_STABLE_MS);
 assert.ok(out.complete);
 assert.equal(out.complete.answer,'fast answer');
 assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
test('a verified chat turn completes on a strict native pair plus an owned stable DOM answer without a copy button',()=>{
 const {machine,clock:c}=machineFor({actualMode:'chat',taskId:'bound'});
 const outcomes=collect(machine);machine.arm();
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1});
 machine.ingest(pageState({responses:[response('chat answer')]}));
 assert.equal(machine.phase,'generating');
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(outcomes.complete,null,'a pair alone or an answer alone cannot finish');
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2});
 assert.equal(machine.phase,'verifying_completion');
 c.advance(COMPLETION_STABLE_MS-1);
 assert.equal(outcomes.complete,null);
 c.advance(1);
 assert.ok(outcomes.complete);
 assert.equal(outcomes.complete.answer,'chat answer');
 assert.equal(outcomes.complete.diagnostics.completion.evidence,'chat-composite');
});
test('the chat composite requires this task, this conversation, both native phases, no generation, and an untruncated answer',()=>{
 const url='https://gemini.google.com/app/conv-1';
 const run=(spec,steps)=>{
  const {machine,clock:c}=machineFor({actualMode:'chat',taskId:'bound',confirmedUrl:url,...spec});
  const outcomes=collect(machine);machine.arm();
  for(const step of steps)step(machine);
  c.advance(COMPLETION_STABLE_MS*2);
  return {machine,outcomes};
 };
 const noPair=run({},[
  machine=>machine.ingest(pageState({responses:[response('answer without pair')]}))
 ]);
 assert.equal(noPair.outcomes.complete,null);
 assert.equal(noPair.machine.phase,'generating');
 const completeOnly=run({},[
  machine=>machine.ingest(pageState({responses:[response('answer')]})),
  machine=>machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:1})
 ]);
 assert.equal(completeOnly.outcomes.complete,null);
 const otherTask=run({},[
  machine=>machine.ingest(pageState({responses:[response('answer')]})),
  machine=>machine.noteNative({phase:'start',task_id:'other',conversationId:'c_conv-1',sequence:1}),
  machine=>machine.noteNative({phase:'complete',task_id:'other',conversationId:'c_conv-1',sequence:2})
 ]);
 assert.equal(otherTask.outcomes.complete,null);
 const otherConversation=run({},[
  machine=>machine.ingest(pageState({responses:[response('answer')]})),
  machine=>machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_other',sequence:1}),
  machine=>machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_other',sequence:2})
 ]);
 assert.equal(otherConversation.outcomes.complete,null);
 const generating=run({},[
  machine=>machine.ingest(pageState({generates:true,responses:[response('answer')]})),
  machine=>machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1}),
  machine=>machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2})
 ]);
 assert.equal(generating.outcomes.complete,null);
 const stopped=run({},[
  machine=>machine.ingest(pageState({controls:[{label:'停止回答',text:''}],responses:[response('answer')]})),
  machine=>machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1}),
  machine=>machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2})
 ]);
 assert.equal(stopped.outcomes.complete,null);
 const truncated=run({},[
  machine=>machine.ingest(pageState({responses:[response('answer')]})),
  machine=>machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1}),
  machine=>machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2}),
  machine=>machine.ingest(pageState({responses:[response('answer',{answer_truncated:true})]}))
 ]);
 assert.equal(truncated.outcomes.complete,null);
 assert.equal(truncated.outcomes.conflicts.at(-1).code,'ANSWER_TRUNCATED');
 const unconfirmed=run({confirmedUrl:null},[
  machine=>machine.ingest(pageState({responses:[response('answer')]})),
  machine=>machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1}),
  machine=>machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2})
 ]);
 assert.equal(unconfirmed.outcomes.complete,null);
 const notLast=run({},[
  machine=>machine.ingest(pageState({queries:[MARKER,'later message'],responses:[response('answer')]})),
  machine=>machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1}),
  machine=>machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2})
 ]);
 assert.equal(notLast.outcomes.complete,null);
 assert.equal(notLast.outcomes.conflicts.at(-1).code,'MARKER_NOT_LAST');
});
test('a new or duplicated native start cancels a pending chat composite candidate',()=>{
 const {machine,clock:c}=machineFor({actualMode:'chat',taskId:'bound'});
 const outcomes=collect(machine);machine.arm();
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1});
 machine.ingest(pageState({responses:[response('answer')]}));
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2});
 assert.equal(machine.phase,'verifying_completion');
 c.advance(1000);
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:3});
 assert.equal(machine.candidate,null);
 assert.equal(machine.phase,'generating');
 assert.equal(machine.snapshot().native_ambiguous,true);
 c.advance(COMPLETION_STABLE_MS*2);
 assert.equal(outcomes.complete,null);
});
test('the default unknown mode keeps the page-control-only completion path',()=>{
 const {machine,clock:c}=machineFor({taskId:'bound'});
 const outcomes=collect(machine);machine.arm();
 machine.ingest(pageState({responses:[response('answer')]}));
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1});
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2});
 c.advance(COMPLETION_STABLE_MS*2);
 assert.equal(outcomes.complete,null);
 assert.equal(machine.phase,'generating');
});
test('an owned response generation signal blocks page-control completion on a complete answer',()=>{
 const {machine,clock:c}=machineFor();
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({controls:[],generates:true,responses:[response('finished',{complete:true,generating:true,generating_source:'response-progressbar'})]}));
 assert.equal(machine.phase,'generating');
 assert.equal(machine.candidate,null);
 c.advance(COMPLETION_STABLE_MS*2);
 assert.equal(out.complete,null);
 machine.ingest(pageState({controls:[],generates:false,responses:[response('finished',{complete:true,generating:false,generating_source:null})]}));
 assert.equal(machine.phase,'verifying_completion');
 c.advance(COMPLETION_STABLE_MS-1);assert.equal(out.complete,null);
 c.advance(1);
 assert.equal(out.complete.answer,'finished');
 assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
test('the chat composite path applies the same owned response generation rule',()=>{
 const {machine,clock:c}=machineFor({actualMode:'chat',taskId:'bound'});
 const out=collect(machine);machine.arm();
 machine.noteNative({phase:'start',task_id:'bound',conversationId:'c_conv-1',sequence:1});
 machine.ingest(pageState({responses:[response('chat answer',{generating:true,generating_source:'response-busy'})]}));
 machine.noteNative({phase:'complete',task_id:'bound',conversationId:'c_conv-1',sequence:2});
 c.advance(COMPLETION_STABLE_MS*2);
 assert.equal(out.complete,null);
 assert.equal(machine.phase,'generating');
 machine.ingest(pageState({responses:[response('chat answer',{generating:false,generating_source:null})]}));
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete.answer,'chat answer');
 assert.equal(out.complete.diagnostics.completion.evidence,'chat-composite');
});
test('intermittent scoped generation cancels and restarts the stability window',()=>{
 const {machine,clock:c}=machineFor();
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({responses:[response('streamed',{complete:true,generating:true,generating_source:'response-progressbar'})]}));
 c.advance(1000);
 assert.equal(out.complete,null);
 machine.ingest(pageState({responses:[response('streamed',{complete:true,generating:false,generating_source:null})]}));
 assert.equal(machine.phase,'verifying_completion');
 c.advance(1500);
 machine.ingest(pageState({responses:[response('streamed',{complete:true,generating:true,generating_source:'response-progressbar'})]}));
 assert.equal(machine.candidate,null);
 assert.equal(machine.phase,'generating');
 c.advance(COMPLETION_STABLE_MS*2);
 assert.equal(out.complete,null);
 machine.ingest(pageState({responses:[response('streamed',{complete:true,generating:false,generating_source:null})]}));
 c.advance(COMPLETION_STABLE_MS-1);assert.equal(out.complete,null);
 c.advance(1);
 assert.ok(out.complete);
 assert.ok(machine.diagnostics.resets>=1);
 assert.ok(machine.diagnostics.candidates>=2);
});
test('a whitespace-only owned answer never completes',()=>{
 const {machine,clock:c}=machineFor();
 const out=collect(machine);machine.arm();
 for(const blank of ['','   ','\n\t '])machine.ingest(pageState({responses:[response(blank,{complete:true,generating:false})]}));
 c.advance(COMPLETION_STABLE_MS*3);
 assert.equal(out.complete,null);
 assert.equal(machine.candidate,null);
 assert.equal(machine.phase,'generating');
});
test('legacy observations without a scoped signal keep the whole-page generates guard',()=>{
 const {machine,clock:c}=machineFor();
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({controls:[],generates:true,responses:[response('legacy answer',{complete:true})]}));
 c.advance(COMPLETION_STABLE_MS*2);
 assert.equal(out.complete,null);
 assert.equal(machine.candidate,null);
 machine.ingest(pageState({generates:false,responses:[response('legacy answer',{complete:true})]}));
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete.answer,'legacy answer');
});
test('an explicit response.generating=false ignores an unrelated page progressbar',()=>{
 const {machine,clock:c}=machineFor();
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({controls:[],generates:true,responses:[response('done answer',{complete:true,generating:false,generating_source:null})]}));
 assert.equal(machine.phase,'verifying_completion');
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete.answer,'done answer');
});
test('an older response generating flag does not block the owned answer',()=>{
 const {machine,clock:c}=machineFor({beforeResponses:1});
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({
  queries:['old question',MARKER],
  responses:[
   response('old answer',{complete:true,generating:true,generating_source:'response-progressbar'}),
   response('own answer',{complete:true,generating:false,generating_source:null})
  ]
 }));
 c.advance(COMPLETION_STABLE_MS);
 assert.ok(out.complete);
 assert.equal(out.complete.answer,'own answer');
});
test('a native complete on an answer prefix cannot freeze a two-second completion',()=>{
 const url='https://gemini.google.com/app/0000000000000002';
 const prefix='针对附件文本中的';
 const full=prefix+'析'.repeat(460);
 const {machine,clock:c}=machineFor({taskId:'push-49f59947-4',confirmedUrl:url});
 const out=collect(machine);machine.arm();
 machine.ingest(pageState({url,responses:[response(prefix)]}));
 machine.noteNative({phase:'start',task_id:'push-49f59947-4',conversationId:'c_0000000000000002',sequence:1});
 machine.noteNative({phase:'complete',task_id:'push-49f59947-4',conversationId:'c_0000000000000002',sequence:2});
 c.advance(COMPLETION_STABLE_MS);
 assert.equal(out.complete,null);
 assert.equal(machine.phase,'generating');
 assert.equal(machine.candidate,null);
 machine.ingest(pageState({url,responses:[response(full,{complete:true})]}));
 c.advance(COMPLETION_STABLE_MS-1);
 assert.equal(out.complete,null);
 c.advance(1);
 assert.ok(out.complete);
 assert.equal(out.complete.answer,full);
 assert.equal(out.complete.answer.length,468);
 assert.equal(out.complete.diagnostics.completion.evidence,'page-control');
});
