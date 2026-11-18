const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {EventJournal}=require('../desktop-events.cjs');
test('events are durable before delivery and replay explicitly resets expired cursors',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-events-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const filename=path.join(dir,'events.json'),journal=new EventJournal({filename,instanceId:'a',maxEvents:2});
 journal.on('event',e=>assert.equal(JSON.parse(fs.readFileSync(filename)).sequence,e.seq));
 journal.append('state',{task_id:'one'});journal.append('answer',{revision:1});journal.append('answer',{revision:2});
 assert.equal(journal.replay({instance_id:'a',seq:0}).reset,true);
 assert.deepEqual(journal.replay({instance_id:'a',seq:1}).events.map(e=>e.seq),[2,3]);
 assert.equal(journal.replay({instance_id:'wrong',seq:2}).reset,true);
 assert.equal(new EventJournal({filename,instanceId:'b'}).replay({instance_id:'a',seq:3}).reset,true);
});
test('failed persistence never publishes or advances sequence',()=>{
 const j=new EventJournal();let calls=0;j.on('event',()=>calls++);j.commit=()=>{throw Error('disk full');};
 assert.throws(()=>j.append('state',{}),/disk full/);assert.equal(calls,0);assert.equal(j.sequence,0);
});
test('slow consumers disconnect and release listeners; envelope cannot be overwritten',()=>{
 const j=new EventJournal({instanceId:'real'}),response=new EventEmitter();response.writableLength=100;response.write=()=>{};let destroyed=false;response.destroy=()=>{destroyed=true;response.emit('close');};
 j.subscribe(response,{instance_id:'real',seq:0},{maxBufferedBytes:120});
 const event=j.append('state',{instance_id:'fake',seq:100,type:'fake'});
 assert.equal(event.instance_id,'real');assert.equal(event.seq,1);assert.equal(event.type,'state');
 assert.equal(destroyed,true);assert.equal(j.listenerCount('event'),0);
});
test('a legal 1 MiB answer fits an empty connection; oversized encoded frames reject before publish',()=>{
 const j=new EventJournal({instanceId:'large'}),response=new EventEmitter();let writes=0,destroyed=false;
 response.writableLength=0;response.write=()=>{writes++;};response.destroy=()=>{destroyed=true;};
 const close=j.subscribe(response,{instance_id:'large',seq:0});
 j.append('answer',{answer:'x'.repeat(1024*1024)});
 assert.equal(writes,1);assert.equal(destroyed,false);
 assert.throws(()=>j.append('answer',{answer:'\u0001'.repeat(1024*1024)}),/EVENT_TOO_LARGE/);
 assert.equal(j.sequence,1);close();
});
