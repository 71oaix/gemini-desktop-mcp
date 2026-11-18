const test=require('node:test'),assert=require('node:assert/strict');
const {SSEParser}=require('../desktop-stream.cjs');
test('SSE preserves unicode across arbitrary byte boundaries and CRLF frames',()=>{
 const events=[],parser=new SSEParser(e=>events.push(e));
 const bytes=Buffer.from('id: instance:7\r\nevent: task\r\ndata: {"answer":"中文🙂"}\r\n\r\n');
 for(const byte of bytes)parser.push(Buffer.from([byte]));
 assert.deepEqual(events,[{id:'instance:7',type:'task',data:{answer:'中文🙂'}}]);
});
test('SSE rejects unlimited incomplete frames and malformed JSON',()=>{
 assert.throws(()=>new SSEParser(()=>{},{maxBytes:20}).push(Buffer.from('data: '+ 'x'.repeat(50))),/TOO_LARGE/);
 assert.throws(()=>new SSEParser(()=>{}).push(Buffer.from('data: broken\n\n')),SyntaxError);
});
test('event transport authenticates, resumes a cursor and serializes asynchronous consumers',async t=>{
 const http=require('node:http');const {openEventStream}=require('../desktop-stream.cjs');
 const server=http.createServer((req,res)=>{
  assert.equal(req.url,'/events');assert.equal(req.headers.authorization,'Bearer secret-fixture');
  assert.equal(req.headers['last-event-id'],'epoch:4');assert.equal(req.headers.origin,undefined);
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write(Array.from({length:100},(_,i)=>`event: task\ndata: {"seq":${i+5}}\n\n`).join(''));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const controller=new AbortController(),seen=[];
 const result=openEventStream({discovery:{port:server.address().port,token:'secret-fixture'},cursor:{instance_id:'epoch',seq:4},signal:controller.signal,onEvent:async e=>{
  seen.push('start'+e.data.seq);await new Promise(resolve=>setImmediate(resolve));seen.push('end'+e.data.seq);
  if(e.data.seq===104)controller.abort();
 }});
 await assert.rejects(result,e=>e.code==='ABORT_ERR');
 assert.deepEqual(seen,Array.from({length:100},(_,i)=>['start'+(i+5),'end'+(i+5)]).flat());
});
test('large retained replay drains progressively instead of disconnecting a healthy consumer',async t=>{
 const http=require('node:http'),{EventJournal}=require('../desktop-events.cjs'),{openEventStream}=require('../desktop-stream.cjs');
 const journal=new EventJournal({instanceId:'large-replay'});
 for(let i=0;i<6;i++)journal.append('answer',{answer:'x'.repeat(1024*1024)});
 const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();journal.subscribe(res,{instance_id:'large-replay',seq:0});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const controller=new AbortController(),seen=[];
 const promise=openEventStream({discovery:{port:server.address().port,token:'fixture'},signal:controller.signal,onEvent:async event=>{
  seen.push(event.data.seq);await new Promise(resolve=>setImmediate(resolve));if(event.data.seq===6)controller.abort();
 }});
 await assert.rejects(promise,e=>e.code==='ABORT_ERR');assert.deepEqual(seen,[1,2,3,4,5,6]);
});
