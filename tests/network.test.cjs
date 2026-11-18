const test=require('node:test');
const assert=require('node:assert/strict');
const {pageFault,retryNetwork,networkError}=require('../src/browser.cjs');
test('region restrictions pause instead of retrying or switching access routes',async()=>{
 for(const pageText of ['Gemini 尚不支持你所在的国家或地区','Gemini is not currently supported in your country','Gemini isn’t available in your country'])assert.match(pageFault({pageText}),/^REGION_UNSUPPORTED/);
 let attempts=0;await assert.rejects(()=>retryNetwork(async()=>{attempts++;throw Error('REGION_UNSUPPORTED: 请用户恢复连接');},async()=>{assert.fail('region restriction must not be retried');},{sleep:async()=>{}}),/REGION_UNSUPPORTED/);
 assert.equal(attempts,1);assert.equal(pageFault({pageText:'你好，需要我做什么？',online:true}),null);
 assert.equal(pageFault({pageText:'历史聊天标题：Gemini is not currently supported in your country',controls:[{label:'打开模式选择器'}],online:true}),null);
});
test('temporary network errors recover with bounded backoff and no message resubmission',async()=>{
 let reads=0,recoveries=0;const delays=[];
 const value=await retryNetwork(async()=>{if(++reads<3)throw Error('NETWORK_TRANSIENT');return 'original conversation result';},async()=>{recoveries++;},{sleep:async ms=>delays.push(ms)});
 assert.equal(value,'original conversation result');assert.equal(reads,3);assert.equal(recoveries,2);assert.deepEqual(delays,[3000,8000]);
 reads=0;await assert.rejects(()=>retryNetwork(async()=>{reads++;throw Error('net::ERR_CONNECTION_RESET');},async()=>{},{sleep:async()=>{}}),/需要用户恢复连接/);assert.equal(reads,4);
 assert.equal(networkError(Error('browser connection timeout; approval needed')),false);
 assert.match(pageFault({online:false,pageText:''}),/^NETWORK_TRANSIENT/);
});
