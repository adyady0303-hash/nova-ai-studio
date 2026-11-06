const test=require('node:test');
const assert=require('node:assert/strict');
const {chatWithProfile}=require('../ai-providers');
const profile={id:'openrouter',apiKey:'fixture-openrouter-secret',textModel:'fixture/model'};
const messages=[{role:'user',content:'Salut'}];
const reply=(status,body,headers={})=>new Response(JSON.stringify(body),{status,headers});
const success=()=>reply(200,{model:'fixture/model',choices:[{message:{role:'assistant',content:'Salut!'}}]});
test('a temporary OpenRouter502 retries the identical request once and returns the real reply',async()=>{
 const sent=[];const stamps=[];
 const result=await chatWithProfile(profile,{messages,fetchImpl:async(url,options)=>{
  assert.equal(new URL(url).hostname,'openrouter.ai');sent.push(JSON.parse(options.body));stamps.push(Date.now());
  return sent.length===1?reply(502,{error:{message:'gateway error'}}):success();
 }});
 assert.equal(result.message.content,'Salut!');assert.equal(result.provider,'openrouter');
 assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.ok(stamps[1]-stamps[0]>=900);
});
test('a persistent502 stops after two attempts instead of looping',async()=>{
 let calls=0;await assert.rejects(chatWithProfile(profile,{messages,fetchImpl:async()=>{calls++;return reply(502,{error:{message:'gateway'}});}}),e=>e.status===502&&e.provider==='openrouter');assert.equal(calls,2);
});
test('a malformed model field is classified and can recover instead of leaking a TypeError',async()=>{
 let calls=0;const result=await chatWithProfile(profile,{messages,fetchImpl:async()=>++calls===1?reply(200,{model:{toString:4},choices:[{message:{content:'bad'}}]}):success()});assert.equal(result.message.content,'Salut!');assert.equal(calls,2);
});
for(const status of [400,401,402,403,429])test('OpenRouter '+status+' is never retried',async()=>{
 let calls=0;await assert.rejects(chatWithProfile(profile,{messages,fetchImpl:async()=>{calls++;return reply(status,{error:{message:'rejected'}});}}),e=>e.status===status);assert.equal(calls,1);
});
test('Retry-After beyond the operation deadline does not trigger an early retry',async()=>{
 let calls=0;await assert.rejects(chatWithProfile(profile,{messages,timeout:100,fetchImpl:async()=>{calls++;return reply(502,{error:{message:'later'}},{'retry-after':'2'});}}),e=>e.status===502);assert.equal(calls,1);
});
test('cancellation during backoff prevents a second request',async()=>{
 let calls=0;const controller=new AbortController();
 const pending=chatWithProfile(profile,{messages,signal:controller.signal,fetchImpl:async()=>{calls++;return reply(502,{error:{message:'gateway'}});}});
 setTimeout(()=>controller.abort(),30);await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1);
});
