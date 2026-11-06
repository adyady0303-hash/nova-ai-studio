const test=require('node:test');
const assert=require('node:assert/strict');
const {chatWithProfile}=require('../ai-providers');
const profile={id:'openrouter',apiKey:'fixture-not-real',textModel:'fixture/model'};
const request={messages:[{role:'user',content:'Salut'}]};
test('OpenRouter null JSON is a classified invalid response instead of an unhandled exception',async()=>{
 await assert.rejects(chatWithProfile(profile,{...request,fetchImpl:async()=>new Response('null')}),e=>e.provider==='openrouter'&&e.status===502&&e.failureKind==='invalid_response'&&!(e instanceof TypeError));
});
for(const [code,status,kind] of [['UND_ERR_SOCKET',502,'network'],['UND_ERR_BODY_TIMEOUT',504,'timeout']]){
 test('OpenRouter interrupted response preserves '+code,async()=>{
  await assert.rejects(chatWithProfile(profile,{...request,fetchImpl:async()=>({status:200,ok:true,text:async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('private transport detail'),{code})});}})}),e=>e.provider==='openrouter'&&e.status===status&&e.failureKind===kind&&e.code===code);
 });
}
for(const status of [401,402,429,503]){
 test('OpenRouter error embedded in HTTP 200 retains provider status '+status,async()=>{
  await assert.rejects(chatWithProfile(profile,{...request,fetchImpl:async()=>new Response(JSON.stringify({error:{code:status,message:'private upstream message'}}))}),e=>e.provider==='openrouter'&&e.status===status&&e.failureKind==='provider_error'&&e.upstreamStatus===200);
 });
}
test('an unreadable HTTP error keeps the actual HTTP status',async()=>{
 await assert.rejects(chatWithProfile(profile,{...request,fetchImpl:async()=>({status:503,ok:false,text:async()=>{throw new Error('private body detail');}})}),e=>e.provider==='openrouter'&&e.status===503&&e.failureKind==='http'&&e.upstreamStatus===503);
});
