'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../desktop-model-policy.cjs');
const bridge=require('../desktop-bridge.cjs');
const worker=require('../worker.cjs');

function menu(over=[]){
 return [
  {id:'mode-flash',text:'3.8 Flash',visible:true,checked:true,disabled:false},
  {id:'mode-argon',text:'4 Argon',visible:true,checked:false,disabled:false},
  ...over
 ];
}
function thinking(level){
 return {
  options:[
   {id:'think-low',text:'低',visible:true,checked:level==='low',disabled:false},
   {id:'think-medium',text:'中',visible:true,checked:level==='medium',disabled:false},
   {id:'think-high',text:'高',visible:true,checked:level==='high',disabled:false}
  ],
  checked_level:level||null,
  checked_conflict:false,
  entry_count:1
 };
}
function presend(requested,selected,level='high',fallbackReason=null){
 return policy.presendResult({
  requestedModel:requested,
  selectedModel:selected,
  fallbackReason,
  thinking:thinking(level),
  menu:policy.planSelection({models:menu()},requested),
  state:{models:menu(),thinkingOptions:thinking(level).options,thinkingEntryCount:1,composer:{model_text:'3.8 Flash'}}
 });
}

test('requested Argon but the turn marker says Flash is an explicit policy failure',()=>{
 const before=presend('argon','argon');
 assert.equal(before.requested_model,'argon');
 assert.equal(before.selected_model,'argon');
 assert.equal(before.actual_model,'unknown');
 assert.equal(before.model_verified,false);
 assert.equal(before.model,undefined);

 const turn=policy.evaluateTurn({
  requestedModel:'argon',selectedModel:'argon',requestedThinking:'high',
  presendThinkingVerified:true,
  response:{model_evidence:['data-model="3.8 Flash"'],warning:null,warning_source:null},
  turnIndex:4
 });
 assert.equal(turn.actual_model,'flash');
 assert.equal(turn.model_verified,false);
 assert.equal(turn.policy_status,'unsatisfied');
 assert.equal(turn.policy_code,policy.POLICY_CODE);
 assert.equal(policy.errorFor(turn).code,'MODEL_POLICY_UNSATISFIED');
});

test('a routing warning without a concrete model reports unknown, never Flash',()=>{
 const warning='高级模型目前处于用量高峰期，因此Gemini使用了其他模型来提供回答。';
 const turn=policy.evaluateTurn({
  requestedModel:'argon',selectedModel:'argon',requestedThinking:'high',
  presendThinkingVerified:true,
  response:{model_evidence:['aria-label="4 Argon"'],warning,warning_source:'conversation_container'},
  turnIndex:2
 });
 assert.equal(turn.actual_model,'unknown');
 assert.notEqual(turn.actual_model,'flash');
 assert.equal(turn.model_verified,false);
 assert.equal(turn.thinking_level,'unknown');
 assert.equal(turn.thinking_verified,false);
 assert.equal(turn.routing_warning,warning);
 assert.equal(turn.policy_status,'unsatisfied');
 assert.equal(turn.policy_code,policy.POLICY_CODE);
});

test('high thinking is never assumed when the menu does not confirm it',()=>{
 const medium=presend('argon','argon','medium');
 assert.equal(medium.thinking_level,'unknown');
 assert.equal(medium.thinking_verified,false);

 const turn=policy.evaluateTurn({
  requestedModel:'argon',selectedModel:'argon',requestedThinking:'high',
  presendThinkingVerified:medium.thinking_verified,
  response:{model_evidence:['4 Argon'],warning:null,warning_source:null},
  turnIndex:1
 });
 assert.equal(turn.actual_model,'argon');
 assert.equal(turn.model_verified,true);
 assert.equal(turn.thinking_level,'unknown');
 assert.equal(turn.thinking_verified,false);
 assert.equal(turn.policy_status,'unsatisfied');
 assert.equal(turn.policy_code,policy.POLICY_CODE);
});

test('a checked high thinking level and a per-turn Argon marker verify the policy',()=>{
 const before=presend('argon','argon','high');
 assert.equal(before.thinking_level,'high');
 assert.equal(before.thinking_verified,true);

 const turn=policy.evaluateTurn({
  requestedModel:'argon',selectedModel:'argon',requestedThinking:'high',
  presendThinkingVerified:before.thinking_verified,
  response:{model_evidence:['model-response model="4 Argon"'],warning:null,warning_source:null},
  turnIndex:3
 });
 assert.equal(turn.actual_model,'argon');
 assert.equal(turn.model_verified,true);
 assert.equal(turn.thinking_level,'high');
 assert.equal(turn.thinking_verified,true);
 assert.equal(turn.policy_status,'satisfied');
 assert.equal(turn.policy_code,null);
 assert.equal(policy.errorFor(turn),null);
});

test('an explicitly unavailable model fails instead of switching to another model',()=>{
 const available=policy.planSelection({models:menu()},'argon');
 assert.equal(available.choice,'argon');
 assert.equal(available.fallback_reason,null);

 const disabled=policy.planSelection({models:[
  {id:'mode-flash',text:'3.8 Flash',visible:true,checked:false,disabled:false},
  {id:'mode-argon',text:'4 Argon',visible:true,checked:false,disabled:true}
 ]},'argon');
 assert.equal(disabled.choice,null);
 assert.equal(disabled.fallback_reason,null);
 assert.equal(disabled.reason,'argon_unavailable');
 assert.equal(disabled.unavailable_reason,'disabled');

 const quota=policy.planSelection({models:[
  {id:'mode-flash',text:'3.8 Flash',visible:true,checked:false,disabled:false},
  {id:'mode-argon',text:'4 Argon 额度已用完',visible:true,checked:false,disabled:false}
 ]},'argon');
 assert.equal(quota.choice,null);
 assert.equal(quota.reason,'argon_unavailable');
 assert.equal(quota.unavailable_reason,'quota');

 const unavailable=policy.planSelection({models:[
  {id:'mode-flash',text:'3.8 Flash',visible:true,checked:false,disabled:false},
  {id:'mode-argon',text:'4 Argon 当前不可用',visible:true,checked:false,disabled:false}
 ]},'argon');
 assert.equal(unavailable.choice,null);
 assert.equal(unavailable.reason,'argon_unavailable');
 assert.equal(unavailable.unavailable_reason,'unavailable_text');
});

test('legacy fallback fields stay readable without approving a new fallback',()=>{
 const before=presend('argon','flash','high','argon_unavailable');
 assert.equal(before.fallback_approved,true);
 assert.equal(before.thinking_verified,true);
 const turn=policy.evaluateTurn({
  requestedModel:'argon',selectedModel:'flash',requestedThinking:'high',
  presendThinkingVerified:true,fallbackReason:'argon_unavailable',
  response:{model_evidence:['3.8 Flash'],warning:null,warning_source:null},
  turnIndex:5
 });
 assert.equal(turn.actual_model,'flash');
 assert.equal(turn.model_verified,false,'fallback must not claim Argon was verified');
 assert.equal(turn.policy_status,'fallback');
 assert.equal(turn.policy_code,null);
 assert.equal(turn.thinking_level,'high');
 assert.equal(typeof policy.fallbackDecision,'undefined');
});

test('legacy records keep their label as selection evidence and never become verified',()=>{
 const legacy=policy.legacyResultFields({answer:'old answer',model:'4 Argon',url:'https://gemini.google.com/app/x'},'argon');
 assert.equal(legacy.requested_model,'argon');
 assert.equal(legacy.selected_model,'argon');
 assert.equal(legacy.actual_model,'unknown');
 assert.equal(legacy.model_verified,false);
 assert.equal(legacy.thinking_level,'unknown');
 assert.equal(legacy.thinking_verified,false);
 assert.equal(legacy.policy_status,'unverified');
 assert.equal(legacy.policy_code,null);

 const current={...legacy,actual_model:'argon',model_verified:true,thinking_level:'high',thinking_verified:true,policy_status:'satisfied',policy_satisfied:true};
 const merged=policy.mergeResultFields(current,{answer:'old answer',model:'4 Argon'},'argon');
 assert.equal(merged.actual_model,'argon');
 assert.equal(merged.model_verified,true);
 assert.equal(merged.policy_status,'satisfied');
 assert.equal(merged.policy_code,null);
});

test('bridge and worker result paths pass policy fields through without request-model prefill',()=>{
 const legacy=bridge.resultOf({model:'argon',marker:'[gemini-work:legacy:abcd1234]',result:{answer:'old',model:'4 Argon',beforeResponses:0}});
 assert.equal(legacy.model,'4 Argon','legacy display label stays readable');
 assert.equal(legacy.actual_model,'unknown');
 assert.equal(legacy.model_verified,false);
 assert.equal(legacy.thinking_level,'unknown');
 assert.equal(legacy.thinking_verified,false);

 const pending=bridge.resultOf({model:'argon',marker:'[gemini-work:pending:abcd1234]',result:{answer:'',requested_model:'argon',selected_model:'argon',actual_model:'unknown',model_verified:false,thinking_level:'unknown',thinking_verified:false,policy_status:'pending',policy_satisfied:false,policy_code:null,beforeResponses:0}});
 assert.equal(pending.model,null,'a request/selection must not be exposed as the actual model');
 assert.equal(pending.selected_model,'argon');
 assert.equal(pending.actual_model,'unknown');

 const task={request:{model:'argon'},marker:'[gemini-work:merge:abcd1234]'};
 const current={answer:'kept',url:'https://gemini.google.com/app/x',requested_model:'argon',selected_model:'argon',actual_model:'argon',model_verified:true,thinking_level:'high',thinking_verified:true,policy_status:'satisfied',policy_satisfied:true,policy_code:null,fallback_reason:null,fallback_approved:false};
 const merged=worker.mergeResult(current,{result:{answer:'kept',model:'4 Argon',submission_confirmed:true}},task);
 assert.equal(merged.actual_model,'argon');
 assert.equal(merged.model_verified,true);
 assert.equal(merged.policy_status,'satisfied');
 assert.equal(merged.model,'4 Argon');

 const unverified=worker.mergeResult({...current,actual_model:'unknown',model_verified:false,policy_status:'pending',policy_satisfied:false}, {result:{answer:'',model:'4 Argon'}}, task);
 assert.equal(unverified.actual_model,'unknown');
 assert.equal(unverified.model,null,'worker merge must not turn a selected label into an actual model');
});


test('continuing a conversation never plans a mode-control click',()=>{
 const same=policy.planSurfaceAction({requestedMode:'chat',observedMode:'chat',continueConversation:true});
 assert.equal(same.action,'keep');
 assert.equal(same.mode,'chat');
 assert.equal(same.reason,'continue-inherit');

 const unidentified=policy.planSurfaceAction({requestedMode:'chat',observedMode:null,continueConversation:true});
 assert.equal(unidentified.action,'keep');
 assert.equal(unidentified.mode,'chat');
 assert.notEqual(unidentified.action,'switch');

 const inheritParent=policy.planSurfaceAction({requestedMode:'chat',observedMode:null,parentMode:'chat',continueConversation:true});
 assert.equal(inheritParent.action,'keep');
 assert.equal(inheritParent.mode,'chat');

 const keepExisting=policy.planSurfaceAction({requestedMode:'task',observedMode:'chat',continueConversation:true});
 assert.equal(keepExisting.action,'keep');
 assert.equal(keepExisting.mode,'chat');
});

test('a new conversation only clicks when an explicit mode differs from the page',()=>{
 const auto=policy.planSurfaceAction({requestedMode:'auto',observedMode:'chat',continueConversation:false});
 assert.equal(auto.action,'keep');
 assert.equal(auto.mode,'chat');

 const already=policy.planSurfaceAction({requestedMode:'chat',observedMode:'chat',continueConversation:false});
 assert.equal(already.action,'keep');
 assert.equal(already.mode,'chat');

 const switchToTask=policy.planSurfaceAction({requestedMode:'task',observedMode:'chat',continueConversation:false});
 assert.equal(switchToTask.action,'switch');
 assert.equal(switchToTask.mode,'task');

 const missing=policy.planSurfaceAction({requestedMode:'auto',observedMode:null,continueConversation:false});
 assert.equal(missing.action,'error');
 assert.equal(missing.code,'MODE_UNIDENTIFIED');
});


function currentMenu(over=[]){
 return [
  {id:'mode-flash-lite',text:'快速解答 3.5 Flash-Lite',visible:true,checked:false,disabled:false},
  {id:'mode-hydrogen',text:'日常帮助 4 Hydrogen',visible:true,checked:true,disabled:false},
  {id:'mode-pro',text:'深度研究 3.1 Pro',visible:true,checked:false,disabled:false},
  {id:'mode-argon',text:'代码与分析 4 Argon',visible:true,checked:false,disabled:false},
  {id:'mode-carbon',text:'高难任务 4 Carbon',visible:true,checked:false,disabled:true},
  ...over
 ];
}

test('omitted model defaults to Hydrogen at high thinking and does not select Argon',()=>{
 assert.equal(policy.DEFAULT_MODEL,'hydrogen');
 assert.equal(policy.MODEL_LABELS.hydrogen,'4 Hydrogen');
 const plan=policy.planSelection({models:currentMenu()});
 assert.equal(plan.requested_model,'hydrogen');
 assert.equal(plan.choice,'hydrogen');
 assert.equal(plan.fallback_reason,null);
 assert.equal(plan.hydrogen.usable,true);
 assert.equal(policy.normalizeModelLabel('日常帮助 4 Hydrogen'),'hydrogen');
 assert.equal(policy.modelMentionedInText('Hydrogen 高'),'hydrogen');
 assert.equal(policy.normalizeModelLabel('快速解答 3.5 Flash-Lite'),null);
 assert.equal(policy.normalizeModelLabel('深度研究 3.1 Pro'),null);
});

test('Hydrogen is not silently replaced when Argon is also on the menu',()=>{
 const plan=policy.planSelection({models:currentMenu()},'hydrogen');
 assert.equal(plan.choice,'hydrogen');
 assert.equal(plan.fallback_reason,null);
 const missing=policy.planSelection({models:currentMenu().filter(item=>item.id!=='mode-hydrogen')});
 assert.equal(missing.choice,null);
 assert.equal(missing.reason,'hydrogen_missing');
});

function liveMenu(over=[]){
 return [
  {id:'bard-mode-option-flash-lite',text:'快速解答 3.5 Flash-Lite',visible:true,checked:false,disabled:false},
  {id:'bard-mode-option-hydrogen',text:'日常帮助 4 Hydrogen',visible:true,checked:true,disabled:false},
  {id:'bard-mode-option-3-1-pro',text:'深度研究 3.1 Pro',visible:true,checked:false,disabled:false},
  {id:'bard-mode-option-argon',text:'代码与分析 4 Argon',visible:true,checked:false,disabled:false},
  {id:'bard-mode-option-carbon-upsell',text:'高难任务 4 Carbon',visible:true,checked:false,disabled:false},
  ...over
 ];
}

test('an unknown model resolves by its current menu id or unique name',()=>{
 const menu=liveMenu([{id:'bard-mode-option-test-nova',text:'实验功能 Test Nova',visible:true,checked:false,disabled:false}]);
 const byName=policy.planSelection({models:menu},'Test Nova');
 assert.equal(byName.choice,'Test Nova');
 assert.equal(byName.fallback_reason,null);
 assert.equal(byName.resolution.item.id,'bard-mode-option-test-nova');
 assert.equal(byName.resolution.ambiguous,false);
 const byId=policy.planSelection({models:menu},'bard-mode-option-test-nova');
 assert.equal(byId.choice,'bard-mode-option-test-nova');
 assert.equal(byId.resolution.item.id,'bard-mode-option-test-nova');
 const bySuffix=policy.planSelection({models:menu},'test-nova');
 assert.equal(bySuffix.choice,null,'opaque ids must be matched in full, not by suffix guessing');
 assert.equal(bySuffix.resolution.item,null);
 assert.equal(policy.normalizeModel('Test Nova'),'Test Nova');
 assert.equal(policy.normalizeModel('  Test   Nova  '),'Test Nova');
});

test('a non-human model selector requires a unique match and never picks the first',()=>{
 const menu=liveMenu([
  {id:'bard-mode-option-test-nova-a',text:'实验功能 Test Nova',visible:true,checked:false,disabled:false},
  {id:'bard-mode-option-test-nova-b',text:'测试功能 Test Nova',visible:true,checked:false,disabled:false}
 ]);
 const plan=policy.planSelection({models:menu},'Test Nova');
 assert.equal(plan.choice,null);
 assert.equal(plan.reason,'model_ambiguous');
 assert.equal(plan.resolution.ambiguous,true);
});

test('upsell and restricted DOM evidence makes a model explicitly unavailable',()=>{
 const byId=policy.planSelection({models:liveMenu()},'4 Carbon');
 assert.equal(byId.choice,null);
 assert.equal(byId.reason,'model_unavailable');
 assert.equal(byId.unavailable_reason,'restricted');
 const byFlag=policy.planSelection({models:[
  {id:'bard-mode-option-carbon',text:'高难任务 4 Carbon',visible:true,checked:false,disabled:false,restricted:true}
 ]},'4 Carbon');
 assert.equal(byFlag.choice,null);
 assert.equal(byFlag.unavailable_reason,'restricted');
 const disabled=policy.planSelection({models:[
  {id:'bard-mode-option-carbon',text:'高难任务 4 Carbon',visible:true,checked:false,disabled:true}
 ]},'4 Carbon');
 assert.equal(disabled.choice,null);
 assert.equal(disabled.unavailable_reason,'disabled');
});

test('menu readiness is structural and does not depend on a fixed model list or group text',()=>{
 assert.equal(policy.menuReadyToDecide({models:[]}),false);
 assert.equal(policy.menuReadyToDecide({models:[{id:'future',text:'Test Nova',visible:true}]}),true);
 const single=policy.planSelection({models:[{id:'future',text:'Test Nova',visible:true,checked:true}]},'Test Nova');
 assert.equal(single.ready_to_decide,true);
 assert.equal(single.choice,'Test Nova');
});

test('per-turn evidence recognizes a dynamic requested model without the legacy names',()=>{
 const turn=policy.evaluateTurn({
  requestedModel:'Test Nova',selectedModel:'Test Nova',requestedThinking:'high',
  presendThinkingVerified:true,
  response:{model_evidence:['data-model="Test Nova"'],warning:null,warning_source:null},
  turnIndex:1
 });
 assert.equal(turn.actual_model,'Test Nova');
 assert.equal(turn.model_verified,true);
 assert.equal(turn.policy_status,'satisfied');
 const mismatch=policy.evaluateTurn({
  requestedModel:'Test Nova',selectedModel:'Test Nova',requestedThinking:'high',
  presendThinkingVerified:true,
  response:{model_evidence:['data-model="4 Hydrogen"'],warning:null,warning_source:null},
  turnIndex:2
 });
 assert.equal(mismatch.actual_model,'hydrogen');
 assert.equal(mismatch.model_verified,false);
 assert.equal(mismatch.policy_status,'unsatisfied');
});
