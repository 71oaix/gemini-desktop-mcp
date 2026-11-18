'use strict';
// Presentation-only activity text. This module never changes queue state,
// never schedules work and never calls the bridge. Task activity is derived
// from the saved task row (saved_task); health activity is derived from the
// health snapshot and, only when this health call actually probed the bridge,
// from that probe (health_probe).
const TASK_SOURCE='saved_task';
const HEALTH_PROBE='health_probe';
const HEALTH_SNAPSHOT='health_snapshot';
const OBSERVER_FAULTS=new Set(['fault','failed','error','lost','unresponsive','observer_fault']);
const ACTIVE_GENERATING='generating';

function timestamp(value){
 if(typeof value!=='string'||!value)return null;
 return Number.isFinite(Date.parse(value))?value:null;
}

function taskObservedAt(status,diagnostic){
 const candidates=[diagnostic&&diagnostic.at,status.last_activity_at,status.updated_at];
 for(const candidate of candidates){
  const value=timestamp(candidate);
  if(value)return value;
 }
 return null;
}

function observerFault(status,diagnostic){
 if(diagnostic&&diagnostic.reason==='idle_ping_failed')return 'idle_ping_failed';
 const state=typeof status.observer_state==='string'?status.observer_state.toLowerCase():'';
 if(OBSERVER_FAULTS.has(state))return 'observer_fault';
 const fault=status.observer_fault;
 if(fault===true)return 'observer_fault';
 if(typeof fault==='string'&&fault)return 'observer_fault';
 return null;
}

function taskActivity(input){
 const status=input&&typeof input==='object'?input:{};
 const diagnostic=status.diagnostic&&typeof status.diagnostic==='object'?status.diagnostic:null;
 const name=typeof status.status==='string'?status.status:'unknown';
 const reason=status.completion_unverified_reason||diagnostic?.reason||null;
 const observed_at=taskObservedAt(status,diagnostic);
 const activity=(state,summary,reason_code,next_action)=>({state,summary,reason_code,next_action,evidence_source:TASK_SOURCE,observed_at});

 // Terminal states win over stale connection fields: an old disconnected
 // event stream cannot turn a saved completion into a reconnect.
 if(name==='completed')return activity('completed','任务已完成，本地记录保存了最终结果。','completed','取回回答并核对结果；无需再次提交。');
 if(name==='failed'){
  const code=status.error_code?`（${status.error_code}）`:'';
  return activity('failed',`任务失败${code}，不会自动重发。`,'failed','查看错误码和已有结果；发送状态不明的任务不要重新提交或重发。');
 }
 if(name==='partial'){
  if(status.budget_exhausted===true)return activity('partial','执行预算已用尽，已有回答被保留；页面可能仍在生成，未确认完成。','budget_exhausted','取回已有回答并查询原任务；不要当作完成，也不要重发。');
  return activity('partial','任务只产出了部分回答，未完成。','partial','取回已有部分回答并查询或恢复原会话；不要重发。');
 }
 if(name==='needs_user_action')return activity('needs_user_action','任务需要人工处理（登录、授权、只读或页面阻碍）。','needs_user_action','处理登录、授权或只读阻碍后调用 gemini_connect；已发送的任务只恢复读取，不要重发。');
 if(name==='uncertain')return activity('uncertain','发送状态未确认，不能按普通失败或完成处理。','send_state_unknown','发送状态未确认：只查询或恢复原会话，不要重新提交或重发。');
 if(name==='retry_wait'){
  const at=timestamp(status.next_retry_at);
  return activity('reconnecting',at?`连接中断，已安排在 ${at} 后做有限次只读重连；当前进度未知。`:'连接中断，正在有限退避中等待只读重连；当前进度未知。','retry_scheduled','等待后台只读重连，不要重新提交或重发。');
 }

 // Explicit observation loss outranks an existing answer: an answer without a
 // working observer cannot prove completion.
 const fault=observerFault(status,diagnostic);
 if(fault)return activity('observation_lost',fault==='idle_ping_failed'?'完成核验失败：空闲检查无法响应，观察通道可能已失联；已有回答也不能证明完成。':'观察到观察器故障，无法确认当前进度；已有回答也不能证明完成。',fault,'观察通道已失联：只查询或恢复原会话，不要重新提交或重发。');

 if(name===ACTIVE_GENERATING){
  if(status.event_connection==='disconnected'||status.event_connection==='reconnecting'){
   return activity('reconnecting','任务生成中，但事件连接已断开，正在等待只读重连；当前进度未知。','connection_disconnected','等待后台只读重连，不要重新提交或重发。');
  }
  // A validated answer with unverified completion has a concrete blocker and
  // must not be presented as a lost observer or as completed.
  if(reason==='idle_answer_unverified'&&status.has_partial_answer===true){
   return activity('awaiting_completion','已有回答，但完成证据不足；任务仍在生成，不能判定完成。','idle_answer_unverified','先取回现有内容并继续核实；不要当作已完成，也不要重新提交。');
  }
  // The last probe answered but saw no progress. This is a quiet generation,
  // not an observation loss.
  if(reason==='idle_ping_no_progress'&&diagnostic?.idle_ping_ok===true){
   return activity('quiet','上次检查时桌面端可响应，但未观察到新进展；任务仍在生成，完成状态未验证。','idle_ping_no_progress','继续等待或稍后查询；检查可响应，不要重新提交。');
  }
  if(status.completion_unverified===true){
   return activity('quiet','完成状态未验证；上次检查没有取得足够的完成证据。','completion_unverified','继续等待或稍后查询；不要重新提交。');
  }
  // Silence alone is normal generation, never "lost".
  return activity('generating','任务仍在生成；静默本身不代表失联。','generating','继续等待或稍后查询；没有新文字不代表失联，不要重新提交。');
 }

 if(name==='submitting')return activity('submitting','正在提交任务，发送结果尚未确认。','submitting','等待发送结果确认；确认前不要重新提交或重发。');
 if(name==='queued')return activity('queued','任务在队列中，尚未开始执行。','queued','等待后台按队列执行；不要重复提交。');
 if(name==='connecting'||name==='staging'){
  return activity('preparing','正在准备桌面桥和页面，尚未提交。','preparing','继续查询准备进度，不要重新提交。');
 }
 return activity(name==='unknown'?'unknown':name,'本地记录的状态未归类，请以 status/error_code 为准。','unclassified','先查询错误码和队列记录，不要自行重发。');
}

function healthObservedAt(probeOk){
 return probeOk?new Date().toISOString():null;
}

function healthActivity(input){
 const health=input&&typeof input==='object'?input:{};
 const bridge=health.bridge&&typeof health.bridge==='object'?health.bridge:{};
 const processInfo=health.process&&typeof health.process==='object'?health.process:{};
 const desktop=health.desktop&&typeof health.desktop==='object'?health.desktop:{};
 const queue=health.queue&&typeof health.queue==='object'?health.queue:{};
 const connection=typeof health.connection==='string'?health.connection:'not_started';
 const probeOk=bridge.probe_ok===true;
 const probeCode=bridge.probe_error&&typeof bridge.probe_error==='object'?bridge.probe_error.code:null;
 const generating=Number.isInteger(queue.generating_count)?queue.generating_count:0;
 const processFresh=processInfo.supervisor_heartbeat_fresh===true||processInfo.worker_heartbeat_fresh===true;
 const stopRequested=health.stop_requested===true||processInfo.stop_requested===true||connection==='stopped';
 const observed_at=healthObservedAt(probeOk);
 const source=probeOk?HEALTH_PROBE:HEALTH_SNAPSHOT;
 const activity=(state,summary,reason_code,next_action)=>({state,summary,reason_code,next_action,evidence_source:source,observed_at});

 if(stopRequested)return activity('stopped','后台收到停止标记，正在按正常流程退出；这不是任务失败。','stop_requested','等待后台退出后再 connect；不要强制结束进程。');
 if(['not_installed','version_mismatch','configuration_missing'].includes(desktop.status))return activity('needs_user_action','客户端未安装、版本不符或桥接配置未通过校验，当前不能执行任务。',desktop.status,'先修复固定版本客户端或桥接安装；不要重新提交已有任务。');
 if(bridge.read_only===true||desktop.status==='needs_user_action'||connection==='needs_user_action'){
  return activity('needs_user_action','桌面端只读、未登录或页面未就绪，需要人工处理。','needs_user_action','处理登录、授权或只读阻碍后调用 gemini_connect；已发送任务只恢复读取。');
 }
 if(bridge.discovered===true&&!probeOk){
  return activity('reconnecting',`桌面桥已发现但本次探测失败${probeCode?`（${probeCode}）`:''}；当前无法证实页面可响应。`,'bridge_probe_failed','确认桌面客户端正常打开后重新 health 或 connect；不要重发发送状态不明的任务。');
 }
 if(processFresh&&!probeOk&&bridge.discovered!==true){
  return activity('reconnecting','后台心跳仍在，但未发现桌面桥；当前无法证实页面可响应。','bridge_not_discovered','确认桌面客户端与桥接已启动后重新 health 或 connect。');
 }
 if(probeOk&&generating>0){
  return activity('working',`桌面桥探测正常，当前有 ${generating} 个任务在生成。`,'generating','继续用 gemini_status 查询；不要重复提交。');
 }
 if(probeOk){
  return activity('idle',processFresh?'后台已运行且桌面桥可响应，当前空闲；0 个任务不是故障。':'桌面桥可响应，后台未运行；当前 0 个任务，提交时会按需启动。','idle','可直接提交新任务，后台会按需启动；无需重发旧任务。');
 }
 if(!processFresh)return activity('not_running','后台未启动，当前 0 个任务是正常状态；可按需启动。','not_running','需要时先 connect 或直接提交；后台会按需启动，不要重发旧任务。');
 return activity('reconnecting','后台进程存在但桌面桥状态不明，当前无法证实页面可响应。','bridge_unknown','重新 health 或 connect 确认桌面桥；不要重发发送状态不明的任务。');
}

module.exports={taskActivity,healthActivity,TASK_SOURCE,HEALTH_PROBE,HEALTH_SNAPSHOT};
