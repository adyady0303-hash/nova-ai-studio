const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('automatic images recover OpenAI quota using saved Gemini/OpenRouter keys and live models',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-image-failover-'));
  const callsPath=path.join(directory,'calls.jsonl'),preload=path.join(directory,'mock.cjs');
  fs.writeFileSync(callsPath,'');
  fs.writeFileSync(preload,`
    const fs=require('node:fs');
    const originalTimeout=AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout=ms=>originalTimeout(ms>=30000?Math.ceil(ms/100):ms);
    const record=value=>fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(value)+'\\n');
    const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    global.fetch=async(url,options={})=>{
      const parsed=new URL(url),provider={'api.openai.com':'openai','generativelanguage.googleapis.com':'gemini','openrouter.ai':'openrouter'}[parsed.hostname];
      if(!provider)throw new Error('Unexpected provider');
      if(parsed.pathname.endsWith('/models')){
        record({provider,type:'catalog'});
        if(provider==='gemini')return reply(200,{models:[{name:'models/gemini-chat-only'},{name:'models/gemini-fixture-image',supportedGenerationMethods:['generateContent']}]});
        if(provider==='openrouter')return reply(200,{data:[
          {id:'vendor/image-only',architecture:{input_modalities:['text'],output_modalities:['image']}},
          {id:'vendor/edit',architecture:{input_modalities:['text','image'],output_modalities:['image']}}
        ]});
        return reply(200,{data:[]});
      }
      const body=typeof options.body==='string'?JSON.parse(options.body):Object.fromEntries(options.body.entries());
      const prompt=provider==='gemini'?body.contents[0].parts[0].text:body.prompt;
      record({provider,type:'generation',prompt,body});
      if(provider==='openai')return reply(429,{error:{message:'private diagnostic fixture-openai-key',code:'insufficient_quota'}});
      if(prompt==='ALL_QUOTA')return reply(429,{error:{message:'fixture quota'}});
      if(provider==='gemini'&&prompt==='GEMINI_TIMEOUT')return new Promise((resolve,reject)=>{
        const cancel=()=>reject(options.signal.reason);
        if(options.signal.aborted)cancel();else options.signal.addEventListener('abort',cancel,{once:true});
      });
      if(provider==='gemini'&&prompt==='GEMINI_UNAVAILABLE')return reply(503,{error:{message:'unavailable'}});
      if(provider==='gemini'&&prompt==='GEMINI_AUTH')return reply(403,{error:{message:'private diagnostic fixture-gemini-key'}});
      if(provider==='gemini'&&prompt==='GEMINI_BLOCKED')return reply(200,{promptFeedback:{blockReason:'SAFETY'}});
      if(provider==='gemini')return reply(200,{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:${JSON.stringify(png)}}}]}}]});
      return reply(200,{data:[{b64_json:${JSON.stringify(png)},media_type:'image/png'}]});
    };
  `);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['--require',preload,'server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,
    HOST:'127.0.0.1',PORT:String(port),NOVA_DATA_DIR:directory,DATABASE_URL:'',
    NOVA_ACCESS_USER:'owner',NOVA_ACCESS_PASSWORD:'fixture-password',NOVA_SUBSCRIBER_DAILY_AI_LIMIT:'5',
    AI_PROVIDER:'openai',AI_FALLBACK_PROVIDERS:'',AI_IMAGE_AUTO_SELECT:'true',
    OPENAI_API_KEY:'fixture-openai-key',GEMINI_API_KEY:'fixture-gemini-key',GEMINI_IMAGE_MODEL:'',
    OPENROUTER_API_KEY:'fixture-router-key',OPENROUTER_IMAGE_MODEL:'',
    ANTHROPIC_API_KEY:'',GROQ_API_KEY:'',MISTRAL_API_KEY:'',DEEPSEEK_API_KEY:'',XAI_API_KEY:'',TOGETHER_API_KEY:'',CUSTOM_OPENAI_API_KEY:''
  },stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}fs.rmSync(directory,{recursive:true,force:true});});
  let ready=false;
  for(let n=0;n<200;n++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(ready,logs);
  const request=(cookie='')=>(route,body,method='POST')=>fetch(base+route,{method,headers:{cookie,origin:base,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=await request()('/api/auth/login',{username:'owner',password:'fixture-password'});assert.equal(login.status,200);
  const owner=request(login.headers.get('set-cookie').split(';',1)[0]);
  const calls=()=>fs.readFileSync(callsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

  await t.test('quota recovery discovers a real Gemini image model without manual model configuration',async()=>{
    const response=await owner('/api/media/image',{prompt:'An image without manual configuration'}),body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.provider,'gemini');assert.equal(body.model,'gemini-fixture-image');
    assert.equal(body.dataUrl,'data:image/png;base64,'+png);
    assert.deepEqual(calls().filter(call=>call.type==='generation').map(call=>call.provider),['openai','gemini']);
    const settings=await(await owner('/api/settings',undefined,'GET')).json();
    assert.equal(settings.settings.routes.image,'openai','temporary recovery does not rewrite the saved route');
    assert.equal(settings.settings.routes.autoImageSelect,true);
    assert.equal(settings.settings.providers.find(p=>p.id==='gemini').imageModel,'','discovered model is scoped to the action');
    assert.equal(settings.settings.imageRoutingReady.image,true);
  });

  await t.test('Gemini outage recovers via OpenRouter and edits use a model that accepts image input',async()=>{
    const before=calls().length;
    const response=await owner('/api/media/image/edit',{prompt:'GEMINI_UNAVAILABLE',image:'data:image/png;base64,'+png}),body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.provider,'openrouter');assert.equal(body.model,'vendor/edit');assert.equal(body.edited,true);
    const attempts=calls().slice(before).filter(call=>call.type==='generation');
    assert.deepEqual(attempts.map(call=>call.provider),['openai','gemini','openrouter']);
    assert.equal(attempts[2].body.input_references[0].image_url.url,'data:image/png;base64,'+png);
  });

  await t.test('a timed-out provider leaves time for the next provider to produce an image',async()=>{
    const before=calls().length,response=await owner('/api/media/image',{prompt:'GEMINI_TIMEOUT'}),body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.provider,'openrouter');
    assert.deepEqual(calls().slice(before).filter(call=>call.type==='generation').map(call=>call.provider),['openai','gemini','openrouter']);
  });

  await t.test('all provider quotas fail clearly after one visit to each provider',async()=>{
    const before=calls().length,response=await owner('/api/media/image',{prompt:'ALL_QUOTA'}),body=await response.text();
    assert.equal(response.status,429);assert.match(body,/OpenAI.*cotă API.*Google Gemini.*cotă API.*OpenRouter.*cotă API/);
    assert.deepEqual(calls().slice(before).filter(call=>call.type==='generation').map(call=>call.provider),['openai','gemini','openrouter']);
    assert.doesNotMatch(body,/fixture-.*key|private diagnostic/);
  });

  await t.test('authentication and content-policy failures stop recovery instead of trying another service',async()=>{
    for(const [prompt,status] of [['GEMINI_AUTH',403],['GEMINI_BLOCKED',422]]){
      const before=calls().length,response=await owner('/api/media/image',{prompt}),body=await response.text();
      assert.equal(response.status,status,body);assert.doesNotMatch(body,/fixture-.*key|private diagnostic/);
      assert.deepEqual(calls().slice(before).filter(call=>call.type==='generation').map(call=>call.provider),['openai','gemini']);
    }
  });

  await t.test('subscriber recovery uses one Nova unit while administrator remains unlimited',async()=>{
    const signup=await request()('/api/auth/register',{username:'image-user',password:'pass1234'});assert.equal(signup.status,201);
    const visitor=request(signup.headers.get('set-cookie').split(';',1)[0]);
    const response=await visitor('/api/media/image',{prompt:'A subscriber image'});
    assert.equal(response.status,200);assert.equal(response.headers.get('x-nova-ai-remaining'),'4');
    assert.equal((await response.json()).provider,'gemini');
    assert.equal((await owner('/api/media/image',{prompt:'An owner image'})).headers.get('x-nova-ai-remaining'),null);
  });

  await t.test('explicit manual image mode keeps the selected provider and does not discover alternatives',async()=>{
    const saved=await owner('/api/settings',{providerId:'openai',selectForImages:true,routes:{text:'openai',image:'openai',speech:'openai',autoSelect:false,autoFallback:false,autoImageSelect:true}});
    const settings=await saved.json();assert.equal(saved.status,200,JSON.stringify(settings));
    assert.equal(settings.settings.routes.autoImageSelect,false,'explicit selection overrides the automatic checkbox');
    const before=calls().length,response=await owner('/api/media/image',{prompt:'Manual provider'});
    assert.equal(response.status,429);assert.deepEqual(calls().slice(before).map(call=>call.provider),['openai']);
    const pinned=await owner('/api/settings',{providerId:'gemini',imageModel:'gemini-fixture-image',selectForImages:true,
      routes:{text:'openai',image:'openai',speech:'openai',autoSelect:false,autoFallback:false,autoImageSelect:true}});
    const selected=await pinned.json();assert.equal(pinned.status,200,JSON.stringify(selected));
    assert.equal(selected.settings.routes.image,'gemini');assert.equal(selected.settings.routes.text,'openai');
    assert.equal(selected.settings.routes.autoImageSelect,false);
    const after=calls().length,generated=await owner('/api/media/image',{prompt:'Explicit Gemini'});
    assert.equal(generated.status,200);assert.equal((await generated.json()).provider,'gemini');
    assert.deepEqual(calls().slice(after).map(call=>call.provider),['gemini']);
  });
});
