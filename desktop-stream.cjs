'use strict';
const http=require('node:http');
const {StringDecoder}=require('node:string_decoder');
class SSEParser{
 constructor(onEvent,{maxBytes=2*1024*1024}={}){this.onEvent=onEvent;this.maxBytes=maxBytes;this.decoder=new StringDecoder('utf8');this.buffer='';this.data=[];this.type='message';this.id=null;this.bytes=0;}
 push(chunk){
  this.buffer+=this.decoder.write(chunk);
  let end;
  while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end).replace(/\r$/,'');this.buffer=this.buffer.slice(end+1);this.line(line);}
  if(Buffer.byteLength(this.buffer)+this.bytes>this.maxBytes)throw Error('SSE_FRAME_TOO_LARGE');
 }
 line(line){
  this.bytes+=Buffer.byteLength(line)+1;if(this.bytes>this.maxBytes)throw Error('SSE_FRAME_TOO_LARGE');
  if(line===''){
   if(this.data.length)this.onEvent({type:this.type,id:this.id,data:JSON.parse(this.data.join('\n'))});
   this.type='message';this.data=[];this.bytes=0;return;
  }
  if(line.startsWith(':'))return;
  const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon),value=colon<0?'':line.slice(colon+1).replace(/^ /,'');
  if(field==='data')this.data.push(value);else if(field==='event')this.type=value;else if(field==='id'&&!value.includes('\0'))this.id=value;
 }
}
// One connection attempt. Caller persists its cursor before advancing and owns reconnect policy.
function openEventStream({discovery,cursor,signal,onEvent,heartbeatTimeoutMs=45000}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(Object.assign(Error('aborted'),{code:'ABORT_ERR'}));return;}
  let timer,response,settled=false,chain=Promise.resolve(),queued=0,queuedBytes=0;
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);request.destroy();response?.destroy();error?reject(error):resolve();};
  const abort=()=>finish(Object.assign(Error('aborted'),{code:'ABORT_ERR'}));
  const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(Object.assign(Error('event heartbeat missing'),{code:'EVENT_HEARTBEAT_LOST'})),heartbeatTimeoutMs);};
  const headers={Host:`127.0.0.1:${discovery.port}`,Authorization:`Bearer ${discovery.token}`,Accept:'text/event-stream'};
  if(cursor)headers['Last-Event-ID']=`${cursor.instance_id}:${cursor.seq}`;
  const request=http.request({host:'127.0.0.1',port:discovery.port,path:'/events',method:'GET',agent:false,headers},res=>{
   response=res;
   if(res.statusCode!==200||!/^text\/event-stream\b/.test(res.headers['content-type']||'')){finish(Object.assign(Error('event stream rejected'),{code:'EVENT_STREAM_REJECTED',status:res.statusCode}));return;}
   const parser=new SSEParser(event=>{
    if(!['task','reset','heartbeat'].includes(event.type))throw Error('EVENT_TYPE_INVALID');
    const eventBytes=Buffer.byteLength(JSON.stringify(event));queuedBytes+=eventBytes;queued++;
    if(queuedBytes>4*1024*1024)throw Error('EVENT_CONSUMER_OVERFLOW');
    arm();response.pause();
    chain=chain.then(()=>settled?undefined:onEvent(event)).then(()=>{queued--;queuedBytes-=eventBytes;if(!settled&&queued===0)response.resume();}).catch(finish);
   });
   res.on('data',chunk=>{try{parser.push(chunk);}catch(error){finish(error);}});
   res.on('error',finish);
   res.on('end',()=>chain.then(()=>finish(Object.assign(Error('event stream closed'),{code:'EVENT_STREAM_CLOSED'})),finish));
  });
  request.on('error',finish);signal?.addEventListener('abort',abort,{once:true});arm();request.end();
 });
}
module.exports={SSEParser,openEventStream};
