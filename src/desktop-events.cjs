'use strict';
// Durable bounded replay for the authenticated desktop event stream.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const MAX_EVENTS=1000,MAX_BYTES=10*1024*1024;
class EventJournal extends EventEmitter{
 constructor({filename,instanceId=crypto.randomUUID(),maxEvents=MAX_EVENTS,maxBytes=MAX_BYTES}={}){
  super();this.filename=filename;this.instanceId=instanceId;this.maxEvents=maxEvents;this.maxBytes=maxBytes;
  this.sequence=0;this.events=[];this.previousInstance=null;
  if(filename&&fs.existsSync(filename)){
   const saved=JSON.parse(fs.readFileSync(filename,'utf8'));
   if(saved.schema!==2||!Array.isArray(saved.events)||!Number.isSafeInteger(saved.sequence))throw Error('EVENT_JOURNAL_CORRUPT');
   this.previousInstance=saved.instance_id;
  }
 }
 commit(document){
  if(!this.filename)return;
  fs.mkdirSync(path.dirname(this.filename),{recursive:true});
  const temporary=this.filename+'.'+crypto.randomUUID()+'.tmp';
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(document));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.renameSync(temporary,this.filename);}catch(error){try{fs.unlinkSync(temporary);}catch{}throw error;}
 }
 append(type,payload){
  const event=JSON.parse(JSON.stringify({instance_id:this.instanceId,seq:this.sequence+1,type,...payload}));
  // Envelope fields cannot be supplied or overridden by renderer data.
  event.instance_id=this.instanceId;event.seq=this.sequence+1;event.type=type;
  const encoded=JSON.stringify(event);
  if(Buffer.byteLength(encoded)>Math.min(this.maxBytes,2*1024*1024-1024))throw Error('EVENT_TOO_LARGE');
  const events=[...this.events,event];
  let bytes=events.reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item)),0);
  while(events.length>this.maxEvents||bytes>this.maxBytes){bytes-=Buffer.byteLength(JSON.stringify(events.shift()));}
  this.commit({schema:2,instance_id:this.instanceId,sequence:event.seq,events});
  this.sequence=event.seq;this.events=events;
  this.emit('event',event);return event;
 }
 replay({instance_id,seq=0}={}){
  const oldest=this.events[0]?.seq||this.sequence+1;
  if(instance_id!==this.instanceId||!Number.isSafeInteger(seq)||seq<oldest-1||seq>this.sequence)return {reset:true,instance_id:this.instanceId,seq:this.sequence,events:[]};
  return {reset:false,instance_id:this.instanceId,seq:this.sequence,events:this.events.filter(e=>e.seq>seq)};
 }
 subscribe(response,cursor,{heartbeatMs=15000,maxBufferedBytes=4*1024*1024}={}){
  let closed=false,waiting=false,pendingBytes=0;
  const pending=[];
  const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);this.off('event',onEvent);response.off('close',cleanup);response.off('drain',drain);pending.length=0;};
  const drain=()=>{waiting=false;pump();};
  const pump=()=>{
   if(closed||waiting)return;
   while(pending.length){
    const {chunk,size}=pending.shift();pendingBytes-=size;
    if(response.writableLength+size>maxBufferedBytes){cleanup();response.destroy();return;}
    if(response.write(chunk)===false){waiting=true;response.once('drain',drain);return;}
   }
  };
  const send=(type,data,id)=>{
   if(closed)return;
   const chunk=(id?`id: ${id}\n`:'')+`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,size=Buffer.byteLength(chunk);
   if(pendingBytes+size>Math.max(this.maxBytes+256*1024,maxBufferedBytes)){cleanup();response.destroy();return;}
   pending.push({chunk,size});pendingBytes+=size;pump();
  };
  const onEvent=e=>send('task',e,`${e.instance_id}:${e.seq}`);
  const timer=setInterval(()=>send('heartbeat',{instance_id:this.instanceId,seq:this.sequence}),heartbeatMs);
  timer.unref?.();response.on('close',cleanup);
  const replay=this.replay(cursor);
  if(replay.reset)send('reset',{instance_id:replay.instance_id,seq:replay.seq});
  else for(const event of replay.events)onEvent(event);
  if(!closed)this.on('event',onEvent);
  return cleanup;

 }
}
module.exports={EventJournal,MAX_EVENTS,MAX_BYTES};
