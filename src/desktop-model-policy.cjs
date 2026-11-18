'use strict';
// Pure model-policy evidence for the Gemini desktop bridge.
// The request only states intent. A model is "actual" only when the current
// turn carries a concrete model marker of its own; a checked menu option is
// selection evidence, never proof of routing.
const DEFAULT_MODEL='hydrogen';
// Legacy request aliases stay readable. They are not the live menu inventory:
// the page menu is discovered structurally and may contain any model name.
const MODEL_LABELS=Object.freeze({hydrogen:'4 Hydrogen',flash:'3.8 Flash',argon:'4 Argon'});
const MODEL_ALIASES=Object.freeze(Object.keys(MODEL_LABELS));
const MODEL_SELECTOR_MAX=80;
const MODES=Object.freeze(['auto','chat','task']);
const THINKING_CONTROLS=Object.freeze(['menu','not_exposed','unknown']);
const REQUIRED_THINKING='high';
const THINKING_LEVELS=Object.freeze(['low','medium','high']);
const THINKING_TEXTS=Object.freeze({
 low:['低','低思考','低强度','low'],
 medium:['中','中思考','中强度','medium'],
 high:['高','高思考','高强度','high']
});
const POLICY_CODE='MODEL_POLICY_UNSATISFIED';
const POLICY_STATUSES=new Set(['pending','satisfied','fallback','unverified','unsatisfied']);
const ROUTING_WARNING_PATTERNS=[
 /高级模型.{0,24}(?:用量|使用|请求).{0,12}高峰/,
 /使用(?:了)?其他模型/,
 /(?:其他|另一个)模型.{0,12}(?:提供|回答|响应)/,
 /high demand/i,
 /(?:used|using|switched to) (?:a )?different model/i,
 /(?:automatically|auto)[- ]?(?:switched|selected|used).{0,48}model/i,
 /fallback to .{0,40}model/i
];
const MODEL_QUOTA=/额度|配额|限额|quota/i;
const MODEL_EXHAUSTED=/(?:已用完|用完|用尽|不足|已达上限|达到上限|已满|受限|reached|exceeded|used up|unavailable|不可用)/i;
const MODEL_UNAVAILABLE_TEXT=/(?:暂不可用|当前不可用|已不可用|(?<!可能)不可用|unavailable|not available)/i;
const RESTRICTED_HINT=/(?:^|[\s_.-])(?:upsell|locked|restricted|premium)(?:[\s_.-]|$)|升级|未解锁|受限/i;

function plainObject(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const proto=Object.getPrototypeOf(value);
 return proto===Object.prototype||proto===null;
}
function clip(value,max){
 const text=typeof value==='string'?value:(value===undefined||value===null?'':String(value));
 return text.length>max?text.slice(0,max):text;
}
function normalized(value){return clip(value,2000).replace(/\s+/g,' ').trim();}
// A selector is either a legacy alias or a bounded, whitespace-normalized
// model identifier/name supplied by the caller. It is matched against the menu
// that is actually visible; it is never used as page script or a CSS selector.
function normalizeModel(value){
 if(typeof value!=='string'||/[\u0000-\u001f\u007f]/.test(value))return null;
 const text=value.replace(/\s+/g,' ').trim();
 if(!text||text.length>MODEL_SELECTOR_MAX)return null;
 if(/[\u0000-\u001f\u007f]/.test(text))return null;
 const lower=text.toLowerCase();
 return MODEL_ALIASES.includes(lower)?lower:text;
}
function normalizeMode(value){
 if(typeof value!=='string')return null;
 return MODES.includes(value)?value:null;
}
// The visible labels may be preceded by a localized description, e.g.
// "日常帮助 4 Hydrogen" or "Code & analysis 4 Argon". Match the exact model
// name on word boundaries so "Flash-Lite" and "3.1Pro" are never mistaken
// for 3.8 Flash or 4 Argon.
function modelLabelPattern(label){
 const escaped=String(label).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s*');
 return new RegExp('(?:^|[^A-Za-z0-9_.])'+escaped+'(?![A-Za-z0-9_-])','i');
}
function normalizeModelLabel(value){
 const text=normalized(value);
 if(!text)return null;
 for(const alias of MODEL_ALIASES){
  if(modelLabelPattern(MODEL_LABELS[alias]).test(text))return alias;
 }
 if(/^hydrogen$/i.test(text))return 'hydrogen';
 if(/^argon$/i.test(text))return 'argon';
 if(/^flash$/i.test(text))return 'flash';
 return null;
}
function textMentionsSelector(value,selector){
 const wanted=normalizeModel(selector);
 const text=normalized(value);
 if(!wanted||!text)return false;
 const alias=MODEL_ALIASES.includes(wanted)?wanted:null;
 if(alias)return modelLabelPattern(MODEL_LABELS[alias]).test(text)||text.toLowerCase()===alias;
 return modelLabelPattern(wanted).test(text);
}
function modelMentionedInText(value,requestedModel){
 const text=normalized(value);
 if(!text)return null;
 const hits=new Set();
 if(/Hydrogen(?![\w-])/i.test(text))hits.add('hydrogen');
 if(/Argon(?![\w-])/i.test(text))hits.add('argon');
 if(/Flash(?![\w-])/i.test(text))hits.add('flash');
 for(const alias of MODEL_ALIASES){
  if(modelLabelPattern(MODEL_LABELS[alias]).test(text))hits.add(alias);
 }
 const requested=normalizeModel(requestedModel);
 if(requested&&!hits.has(requested)&&textMentionsSelector(text,requested))hits.add(requested);
 return hits.size===1?Array.from(hits)[0]:null;
}
function normalizeThinking(value){
 if(typeof value!=='string')return null;
 return THINKING_LEVELS.includes(value)?value:null;
}
function thinkingLevelFromText(value){
 const text=normalized(value);
 if(!text)return null;
 for(const level of THINKING_LEVELS){
  for(const label of THINKING_TEXTS[level]){
   if(text===label||text.startsWith(label+' ')||text.startsWith(label+'（')||text.startsWith(label+'(')||text.startsWith(label+':'))return level;
  }
 }
 return null;
}
function isRoutingWarning(value){
 const text=normalized(value);
 if(!text)return false;
 return ROUTING_WARNING_PATTERNS.some(pattern=>pattern.test(text));
}
function quotaLimited(value){
 const text=normalized(value);
 return !!text&&MODEL_QUOTA.test(text)&&MODEL_EXHAUSTED.test(text);
}
function checked(value){return value&&value.checked===true;}
function disabled(value){return value&&value.disabled===true;}
function visible(value){return !value||value.visible!==false;}
function optionOf(item,index){
 const text=clip(item&&item.text!==undefined?item.text:'',160);
 return {
  index,
  id:clip(item&&item.id!==undefined?item.id:'',120),
  text,
  checked:checked(item),
  disabled:disabled(item),
  visible:visible(item),
  restricted:!!item&&item.restricted===true,
  upsell:!!item&&item.upsell===true
 };
}
function menuOptions(state){
 const list=state&&Array.isArray(state.models)?state.models:[];
 return list.slice(0,40).map(optionOf).filter(item=>item.visible);
}
function thinkingOptions(state){
 const list=state&&Array.isArray(state.thinkingOptions)?state.thinkingOptions:[];
 return list.slice(0,40).map((item,index)=>({...optionOf(item,index),level:normalizeThinking(item&&item.level)||thinkingLevelFromText(item&&item.text)}))
  .filter(item=>item.visible);
}
function optionRestricted(item){
 if(!item)return false;
 if(item.restricted===true||item.upsell===true)return true;
 return RESTRICTED_HINT.test([item.id,item.text].join(' '));
}
function optionUnavailableReason(item){
 if(!item)return 'missing';
 if(item.disabled===true)return 'disabled';
 if(optionRestricted(item))return 'restricted';
 if(quotaLimited(item.text))return 'quota';
 if(MODEL_UNAVAILABLE_TEXT.test(item.text))return 'unavailable_text';
 return null;
}
// Ids are exact. Names are matched with explicit boundaries and
// must be unique. Legacy aliases only match their own historical label or id.
function optionMatchesSelector(item,selector){
 const wanted=normalizeModel(selector);
 if(!wanted)return false;
 const id=normalized(item&&item.id).toLowerCase();
 const lower=wanted.toLowerCase();
 if(id){
  if(id===lower)return true;
 }
 const text=normalized(item&&item.text);
 if(!text)return false;
 if(MODEL_ALIASES.includes(lower))return modelLabelPattern(MODEL_LABELS[lower]).test(text)||text.toLowerCase()===lower;
 return modelLabelPattern(wanted).test(text);
}
function resolveModelOptions(options,selector){
 const list=Array.isArray(options)?options:[];
 const matches=list.filter(item=>optionMatchesSelector(item,selector));
 return {selector:normalizeModel(selector),matches,ambiguous:matches.length>1,item:matches.length===1?matches[0]:null};
}
function describeOption(options,alias){
 const resolution=resolveModelOptions(options,alias);
 if(!resolution.item)return {present:resolution.matches.length>0,ambiguous:resolution.ambiguous,usable:false,matches:resolution.matches.length};
 const item=resolution.item;
 return {
  present:true,id:item.id,text:item.text,disabled:item.disabled===true,
  restricted:optionRestricted(item),quota_limited:quotaLimited(item.text),
  unavailable_text:MODEL_UNAVAILABLE_TEXT.test(item.text),
  usable:optionUnavailableReason(item)===null,checked:item.checked===true,
  ambiguous:false,matches:1
 };
}
function menuReadyToDecide(state){
 // Structural readiness only: the menu has pushed at least one visible option.
 // No model count, name list, or localized group heading is used.
 return menuOptions(state).length>0;
}
function menuSignature(state){
 return menuOptions(state).map(item=>[item.id,item.text,item.checked?1:0,item.disabled?1:0,optionRestricted(item)?1:0].join(':')).join('|');
}
function planSelection(state,requestedModel){
 const requested=normalizeModel(requestedModel)||DEFAULT_MODEL;
 const options=menuOptions(state);
 const resolution=resolveModelOptions(options,requested);
 const checkedOptions=options.filter(item=>item.checked);
 const checkedConflict=checkedOptions.length>1;
 let checkedModel=null;
 if(checkedOptions.length===1){
  const item=checkedOptions[0];
  checkedModel=normalizeModelLabel(item.text)||(optionMatchesSelector(item,requested)?requested:null);
 }
 let choice=null,reason=null,unavailableReason=null;
 if(resolution.item){
  unavailableReason=optionUnavailableReason(resolution.item);
  if(!unavailableReason)choice=requested;
  else reason=MODEL_ALIASES.includes(requested)?`${requested}_unavailable`:'model_unavailable';
 }else if(resolution.ambiguous){
  reason='model_ambiguous';
 }else if(options.length){
  reason=MODEL_ALIASES.includes(requested)?`${requested}_missing`:'model_missing';
 }else reason='menu_not_observed';
 return {
  requested_model:requested,
  menu_visible:options.length>0,
  menu_ready:menuReadyToDecide(state),
  ready_to_decide:menuReadyToDecide(state),
  menu_signature:menuSignature(state),
  options,
  checked_model:checkedModel,
  checked_option:checkedOptions.length===1?checkedOptions[0]:null,
  checked_conflict:checkedConflict,
  resolution:{kind:resolution.item?'unique':(resolution.ambiguous?'ambiguous':'none'),ambiguous:resolution.ambiguous,count:resolution.matches.length,item:resolution.item},
  choice,
  fallback_reason:null,
  reason,
  unavailable_reason:unavailableReason,
  hydrogen:describeOption(options,'hydrogen'),
  argon:describeOption(options,'argon'),
  flash:describeOption(options,'flash')
 };
}
function thinkingSnapshot(state){
 const options=thinkingOptions(state);
 const checkedLevels=Array.from(new Set(options.filter(item=>item.checked).map(item=>item.level).filter(Boolean)));
 return {
  options,
  checked_level:checkedLevels.length===1?checkedLevels[0]:null,
  checked_conflict:checkedLevels.length>1,
  entry_count:Number.isInteger(state&&state.thinkingEntryCount)?state.thinkingEntryCount:0
 };
}
function composerEvidence(state){
 const composer=state&&plainObject(state.composer)?state.composer:{};
 const text=clip(composer.model_text||'',160);
 return {
  model_text:text||null,
  model:modelMentionedInText(text),
  source:text?'composer':'none'
 };
}
function boundedList(values,maxItems,maxChars){
 if(!Array.isArray(values))return [];
 return values.slice(0,maxItems).map(value=>clip(value,maxChars));
}
function turnEvidence(response){
 if(!plainObject(response))return {model_evidence:[],warning:null,warning_source:null};
 return {
  model_evidence:boundedList(response.model_evidence,12,200),
  warning:typeof response.warning==='string'&&response.warning.trim()?clip(response.warning,320):null,
  warning_source:typeof response.warning_source==='string'?clip(response.warning_source,40):null
 };
}
function evidenceModel(list,requestedModel){
 const requested=normalizeModel(requestedModel);
 const hits=new Set();
 for(const value of Array.isArray(list)?list.slice(0,12):[]){
  const alias=normalizeModelLabel(value);
  if(alias){hits.add(alias);continue;}
  if(requested&&textMentionsSelector(value,requested))hits.add(requested);
 }
 return hits.size===1?Array.from(hits)[0]:null;
}
function presendResult({requestedModel,selectedModel,fallbackReason,thinking,menu,state,mode,requestedMode,thinkingControl}={}){
 const thought=thinking&&plainObject(thinking)?thinking:thinkingSnapshot(state);
 const modeValue=normalizeMode(mode);
 const actualMode=modeValue==='task'?'task':(modeValue==='chat'?'chat':null);
 const requiredMode=actualMode||'chat';
 const requested=normalizeMode(requestedMode)||(actualMode||'auto');
 const control=actualMode==='task'?'not_exposed':(THINKING_CONTROLS.includes(thinkingControl)?thinkingControl:(requiredMode==='chat'?(thought.options.length?'menu':'unknown'):'unknown'));
 const thinkingVerified=requiredMode==='chat'&&thought.checked_level===REQUIRED_THINKING&&!thought.checked_conflict;
 const composer=composerEvidence(state);
 return {
  requested_model:normalizeModel(requestedModel)||null,
  selected_model:normalizeModel(selectedModel)||null,
  actual_model:'unknown',
  model_verified:false,
  requested_mode:requested,
  actual_mode:actualMode,
  requested_thinking:requiredMode==='task'?'native':REQUIRED_THINKING,
  thinking_control:control,
  thinking_level:requiredMode==='task'?'native':(thinkingVerified?REQUIRED_THINKING:'unknown'),
  thinking_verified:thinkingVerified,
  fallback_reason:fallbackReason||null,
  fallback_approved:!!fallbackReason,
  routing_warning:null,
  policy_status:'pending',
  policy_satisfied:false,
  policy_code:null,
  evidence:{
   source:'menu_checked',
   checked_model:normalizeModel(selectedModel)||null,
   checked_models:menu&&menu.checked_model?[menu.checked_model]:[],
   thinking_checked:thinkingVerified?REQUIRED_THINKING:null,
   thinking_options:(thought.options||[]).slice(0,10).map(item=>({text:clip(item.text,80),level:item.level,checked:item.checked,disabled:item.disabled})),
   composer_model:composer.model_text,
   composer_source:composer.source
  }
 };
}
function evaluateTurn({requestedModel,selectedModel,requestedThinking,presendThinkingVerified,fallbackReason,response,turnIndex,state,mode,requestedMode,thinkingControl}={}){
 const requested=normalizeModel(requestedModel)||null;
 const selected=normalizeModel(selectedModel)||null;
 const actualMode=normalizeMode(mode)==='task'?'task':'chat';
 const requestedModeValue=normalizeMode(requestedMode)||(actualMode==='task'?'task':'chat');
 const taskMode=actualMode==='task';
 const preVerified=!taskMode&&presendThinkingVerified===true;
 const raw=turnEvidence(response);
 const warning=raw.warning&&isRoutingWarning(raw.warning)?raw.warning:null;
 const badgeModel=evidenceModel(raw.model_evidence,requested);
 const warningModel=warning?modelMentionedInText(warning,requested):null;
 let actualModel='unknown';
 if(warningModel&&badgeModel&&warningModel!==badgeModel)actualModel='unknown';
 else if(warningModel)actualModel=warningModel;
 else if(!warning&&badgeModel)actualModel=badgeModel;
 const modelVerified=!warning&&actualModel!=='unknown'&&actualModel===requested;
 const thinkingVerified=!warning&&preVerified;
 const thinkingLevel=taskMode?'native':(thinkingVerified?REQUIRED_THINKING:'unknown');
 const control=taskMode?'not_exposed':(THINKING_CONTROLS.includes(thinkingControl)?thinkingControl:'unknown');
 let policyStatus='unverified',policyCode=null,reason=fallbackReason||null;
 if(warning){
  policyStatus='unsatisfied';policyCode=POLICY_CODE;reason='routing_warning';
 }else if(actualModel!=='unknown'){
  if(actualModel!==requested){
   if(fallbackReason&&actualModel===selected&&thinkingVerified)policyStatus='fallback';
   else{policyStatus='unsatisfied';policyCode=POLICY_CODE;reason=reason||'model_mismatch';}
  }else if(!thinkingVerified&&!taskMode){
   policyStatus='unsatisfied';policyCode=POLICY_CODE;reason=reason||'thinking_unverified';
  }else{
   policyStatus='satisfied';
   reason=null;
  }
 }else if(!thinkingVerified&&!taskMode){
  policyStatus='unsatisfied';policyCode=POLICY_CODE;reason=reason||'thinking_unverified';
 }
 return {
  requested_model:requested,
  selected_model:selected,
  actual_model:actualModel,
  model_verified:modelVerified,
  requested_mode:requestedModeValue,
  actual_mode:actualMode,
  requested_thinking:taskMode?'native':(normalizeThinking(requestedThinking)||REQUIRED_THINKING),
  thinking_control:control,
  thinking_level:thinkingLevel,
  thinking_verified:thinkingVerified,
  fallback_reason:reason,
  fallback_approved:!!fallbackReason,
  routing_warning:warning,
  policy_status:policyStatus,
  policy_satisfied:policyStatus==='satisfied'||(policyStatus==='fallback'&&thinkingVerified),
  policy_code:policyCode,
  evidence:{
   source:'turn',
   turn_index:Number.isInteger(turnIndex)?turnIndex:null,
   model_marker:raw.model_evidence,
   warning:warning,
   warning_source:raw.warning_source,
   composer_model:composerEvidence(state).model_text
  }
 };
}
function policyFingerprint(fields){
 if(!plainObject(fields))return '';
 return JSON.stringify([fields.actual_model,fields.model_verified,fields.thinking_level,fields.thinking_verified,fields.routing_warning,fields.policy_status,fields.policy_code,fields.fallback_reason,fields.fallback_approved]);
}
function boundedEvidence(value){
 if(!plainObject(value))return null;
 const out={};
 for(const key of ['source','turn_index','checked_model','checked_models','thinking_checked','thinking_options','composer_model','composer_source','model_marker','warning','warning_source']){
  if(value[key]===undefined)continue;
  const item=value[key];
  if(Array.isArray(item))out[key]=item.slice(0,12).map(entry=>plainObject(entry)?{...entry,text:clip(entry.text,80)}:clip(entry,200));
  else if(item===null||typeof item==='number'||typeof item==='boolean')out[key]=item;
  else out[key]=clip(item,320);
 }
 return Object.keys(out).length?out:null;
}
function legacyResultFields(saved,requestedModel){
 const source=plainObject(saved)?saved:{};
 const requested=normalizeModelLabel(requestedModel)||normalizeModel(requestedModel)||normalizeModelLabel(source.requested_model)||normalizeModel(source.requested_model)||null;
 const legacySelected=normalizeModelLabel(source.selected_model)||normalizeModel(source.selected_model)||normalizeModelLabel(source.model)||normalizeModel(source.model)||null;
 const requestedMode=normalizeMode(source.requested_mode)||null;
 const actualMode=normalizeMode(source.actual_mode)||null;
 const mode=actualMode||((requestedMode==='task'||requestedMode==='chat')?requestedMode:'chat');
 const taskMode=mode==='task';
 const hasPolicy=source.requested_model!==undefined||source.actual_model!==undefined||source.model_verified!==undefined||source.policy_status!==undefined;
 if(!hasPolicy){
  // Pre-policy records only stored the label chosen before sending. Preserve it
  // as selection evidence and never promote it to the actual routed model.
  return {
   requested_model:requested,
   selected_model:legacySelected,
   actual_model:'unknown',
   model_verified:false,
   requested_mode:requestedMode,
   actual_mode:actualMode,
   requested_thinking:taskMode?'native':REQUIRED_THINKING,
   thinking_control:taskMode?'not_exposed':'unknown',
   thinking_level:taskMode?'native':'unknown',
   thinking_verified:false,
   fallback_reason:null,
   fallback_approved:false,
   routing_warning:null,
   policy_status:'unverified',
   policy_satisfied:false,
   policy_code:null,
   evidence:null
  };
 }
 const actual=normalizeModelLabel(source.actual_model)||normalizeModel(source.actual_model)||'unknown';
 const warning=typeof source.routing_warning==='string'&&source.routing_warning.trim()?clip(source.routing_warning,320):null;
 const thinkingLevel=taskMode?'native':(normalizeThinking(source.thinking_level)||'unknown');
 const thinkingVerified=!taskMode&&thinkingLevel===REQUIRED_THINKING&&source.thinking_verified===true&&!warning;
 const control=taskMode?'not_exposed':(THINKING_CONTROLS.includes(source.thinking_control)?source.thinking_control:'unknown');
 let status=POLICY_STATUSES.has(source.policy_status)?source.policy_status:'unverified';
 if(warning)status='unsatisfied';
 let code=source.policy_code===POLICY_CODE?POLICY_CODE:null;
 if(status==='unsatisfied'&&!code)code=POLICY_CODE;
 return {
  requested_model:requested,
  selected_model:normalizeModel(source.selected_model)||legacySelected,
  actual_model:actual,
  model_verified:source.model_verified===true&&actual!=='unknown'&&actual===requested&&!warning,
  requested_mode:requestedMode,
  actual_mode:actualMode,
  requested_thinking:normalizeThinking(source.requested_thinking)||(taskMode?'native':REQUIRED_THINKING),
  thinking_control:control,
  thinking_level:thinkingLevel,
  thinking_verified:thinkingVerified,
  fallback_reason:typeof source.fallback_reason==='string'?clip(source.fallback_reason,80):null,
  fallback_approved:source.fallback_approved===true,
  routing_warning:warning,
  policy_status:status,
  policy_satisfied:status==='satisfied'||(status==='fallback'&&source.fallback_approved===true&&thinkingVerified),
  policy_code:code,
  evidence:boundedEvidence(source.evidence)
 };
}
function mergeResultFields(current,incoming,requestedModel){
 const left=plainObject(current)?current:{};
 const right=plainObject(incoming)?incoming:{};
 const merged={...left,...right};
 const fields=legacyResultFields(merged,requestedModel);
 // A concrete actual model is monotonic evidence for this task; an older
 // snapshot without the turn marker must not erase it.
 const leftActual=normalizeModelLabel(left.actual_model)||normalizeModel(left.actual_model);
 if(fields.actual_model==='unknown'&&leftActual)fields.actual_model=leftActual;
 const leftWarning=typeof left.routing_warning==='string'?left.routing_warning:null;
 if(!fields.routing_warning&&leftWarning){fields.routing_warning=leftWarning;fields.policy_status='unsatisfied';fields.policy_code=POLICY_CODE;}
 if(left.policy_status==='satisfied'&&!fields.routing_warning&&fields.actual_model===fields.requested_model)fields.policy_status='satisfied';
 if(left.policy_status==='fallback'&&!fields.routing_warning&&fields.actual_model===fields.selected_model&&fields.fallback_approved)fields.policy_status='fallback';
 if(fields.policy_status==='unsatisfied')fields.policy_code=POLICY_CODE;
 if(left.model_verified===true&&fields.actual_model===fields.requested_model&&!fields.routing_warning&&fields.policy_status!=='unsatisfied')fields.model_verified=true;
 fields.policy_satisfied=fields.policy_status==='satisfied'||(fields.policy_status==='fallback'&&fields.fallback_approved===true&&fields.thinking_verified===true);
 fields.model_verified=fields.model_verified===true&&fields.actual_model===fields.requested_model;
 return fields;
}
function errorFor(fields){
 if(!fields||(fields.policy_status!=='unsatisfied'&&fields.policy_code!==POLICY_CODE))return null;
 const actual=fields.actual_model||'unknown';
 const requested=fields.requested_model||'unknown';
 const detail=fields.routing_warning?`；页面告警：${fields.routing_warning}`:`；实际=${actual}，请求=${requested}`;
 return {code:POLICY_CODE,message:`模型策略未满足：无法确认请求模型与高思考均已生效${detail}`};
}
function diagnostic(state){
 const models=menuOptions(state).slice(0,20).map(item=>({id:clip(item.id,80),text:clip(item.text,120),checked:item.checked,disabled:item.disabled,restricted:optionRestricted(item),upsell:item.upsell===true}));
 const thinking=thinkingOptions(state).slice(0,20).map(item=>({text:clip(item.text,80),level:item.level,checked:item.checked,disabled:item.disabled}));
 const responses=(state&&Array.isArray(state.responses)?state.responses.slice(-3):[]).map((response,index)=>({
  index,
  model_evidence:boundedList(response&&response.model_evidence,12,160),
  warning:typeof response?.warning==='string'?clip(response.warning,200):null
 }));
 const composer=composerEvidence(state);
 return {
  source:'fixed-dom-reader',
  models_source:'menu_observed',
  ui_verified:false,
  has_mode_menu:!!(state&&state.hasModeMenu),
  composer_model:composer.model_text,
  models,
  checked_models:models.filter(item=>item.checked).map(item=>item.text),
  thinking_entry_count:Number.isInteger(state&&state.thinkingEntryCount)?state.thinkingEntryCount:0,
  thinking_options:thinking,
  responses
 };
}


// auto is a request alias, not a surface. Chat and task are the only real modes.
function surfaceMode(value){
 const mode=normalizeMode(value);
 return (mode==='chat'||mode==='task')?mode:null;
}
// Decide whether the page mode control should be clicked. A continued
// conversation already has its mode; re-asserting chat or task must not click.
function planSurfaceAction(input={}){
 const requested=surfaceMode(input.requestedMode);
 const observed=surfaceMode(input.observedMode);
 const parent=surfaceMode(input.parentMode);
 if(input.continueConversation===true){
  return {action:'keep',mode:observed||parent||requested,reason:'continue-inherit'};
 }
 const target=requested||observed;
 if(!target)return {action:'error',code:'MODE_UNIDENTIFIED',message:'无法从页面识别当前是对话还是任务模式；未发送，请确认 Gemini 界面显示分段按钮'};
 if(!requested||observed===target)return {action:'keep',mode:target,reason:observed===target?'already-on-target':'auto-keep'};
 return {action:'switch',mode:target,reason:'explicit-switch'};
}

module.exports={
 DEFAULT_MODEL,MODEL_LABELS,MODEL_ALIASES,MODEL_SELECTOR_MAX,MODES,REQUIRED_THINKING,THINKING_LEVELS,THINKING_TEXTS,THINKING_CONTROLS,POLICY_CODE,
 normalizeModel,normalizeModelLabel,modelLabelPattern,normalizeMode,modelMentionedInText,textMentionsSelector,normalizeThinking,thinkingLevelFromText,
 isRoutingWarning,quotaLimited,optionRestricted,optionUnavailableReason,optionMatchesSelector,resolveModelOptions,menuOptions,thinkingOptions,menuReadyToDecide,menuSignature,planSelection,thinkingSnapshot,composerEvidence,
 presendResult,evaluateTurn,policyFingerprint,legacyResultFields,mergeResultFields,errorFor,diagnostic,surfaceMode,planSurfaceAction
};
