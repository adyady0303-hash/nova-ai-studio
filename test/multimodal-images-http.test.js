const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const root = path.join(__dirname,'..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('Gemini and OpenRouter images work through authenticated routes, catalogs and subscriber quotas without OpenAI', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-multimodal-http-'));
  const callsPath=path.join(directory,'calls.jsonl'), preload=path.join(directory,'mock.cjs');
  fs.writeFileSync(callsPath,'');
  fs.writeFileSync(preload,`
    const fs=require('node:fs');
    const record=value=>fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(value)+'\\n');
    const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    global.fetch=async(url,options={})=>{
      const parsed=new URL(url), body=options.body?JSON.parse(options.body):null;
      const provider=parsed.hostname==='generativelanguage.googleapis.com'?'gemini':parsed.hostname==='openrouter.ai'?'openrouter':'';
      if(!provider)throw new Error('Unexpected provider destination');
      const headers=new Headers(options.headers);
      if(provider==='gemini'&&parsed.pathname.startsWith('/v1beta/models')) {
        if(headers.get('x-goog-api-key')!=='fixture-gemini-key'||headers.has('authorization'))throw new Error('Wrong native Gemini auth');
      } else if(headers.get('authorization')!=='Bearer fixture-openrouter-key')throw new Error('Wrong OpenRouter auth');
      record({provider,path:parsed.pathname,body});
      if(parsed.pathname==='/v1beta/models')return reply({models:[{name:'models/gemini-fixture-image',supportedGenerationMethods:['generateContent']},{name:'models/gemini-chat-only'}]});
      if(parsed.pathname==='/api/v1/images/models')return reply({data:[{id:'vendor/raster',architecture:{input_modalities:['text','image'],output_modalities:['image']}},{id:'vendor/chat',architecture:{output_modalities:['text']}}]});
      const prompt=provider==='gemini'?body?.contents?.[0]?.parts?.[0]?.text:body?.prompt;
      if(prompt==='WAIT_CANCEL')return new Promise((resolve,reject)=>{
        const cancel=()=>{record({provider,type:'aborted'});reject(options.signal.reason);};
        if(options.signal.aborted)cancel();else options.signal.addEventListener('abort',cancel,{once:true});
      });
      if(prompt==='PROVIDER_QUOTA')return reply({error:{message:'Private provider detail fixture-gemini-key fixture-openrouter-key'}},429);
      if(provider==='gemini') {
        if(parsed.pathname!=='/v1beta/models/gemini-fixture-image:generateContent')throw new Error('Wrong Gemini model or route');
        return reply({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:${JSON.stringify(png)}}}]}}]});
      }
      if(parsed.pathname!=='/api/v1/images')throw new Error('Wrong OpenRouter route');
      return reply({data:[{b64_json:${JSON.stringify(png)},media_type:'image/png'}]});
    };
  `);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--require',preload,'server.js'],{cwd:root,env:{...process.env,
    HOST:'127.0.0.1',PORT:String(port),NOVA_DATA_DIR:directory,DATABASE_URL:'',
    NOVA_ACCESS_USER:'nova',NOVA_ACCESS_PASSWORD:'fixture-password-long-enough',NOVA_SUBSCRIBER_DAILY_AI_LIMIT:'5',
    AI_PROVIDER:'gemini',AI_FALLBACK_PROVIDERS:'',OPENAI_API_KEY:'',
    GEMINI_API_KEY:'fixture-gemini-key',GEMINI_IMAGE_MODEL:'',
    OPENROUTER_API_KEY:'fixture-openrouter-key',OPENROUTER_IMAGE_MODEL:'vendor/raster',
    ANTHROPIC_API_KEY:'',GROQ_API_KEY:'',MISTRAL_API_KEY:'',DEEPSEEK_API_KEY:'',XAI_API_KEY:'',TOGETHER_API_KEY:'',CUSTOM_OPENAI_API_KEY:''
  },stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}fs.rmSync(directory,{recursive:true,force:true});});
  let started=false;
  for(let n=0;n<200;n++){
    if(child.exitCode!==null)assert.fail(logs);
    try{if((await fetch(base+'/healthz')).ok){started=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(started,logs);
  const request=(cookie='')=>(route,body,method='POST',options={})=>fetch(base+route,{...options,method,headers:{cookie,origin:base,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=await request()('/api/auth/login',{username:'nova',password:'fixture-password-long-enough'});
  assert.equal(login.status,200);
  const owner=request(login.headers.get('set-cookie').split(';',1)[0]);
  const calls=()=>fs.readFileSync(callsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const configure=async id=>{
    const response=await owner('/api/settings',{providerId:id,imageModel:id==='gemini'?'gemini-fixture-image':'vendor/raster',
      routes:{text:'gemini',image:id,speech:'openai',autoSelect:false,autoFallback:false}});
    assert.equal(response.status,200,await response.text());
  };

  await t.test('startup selects a ready image provider instead of a text-only configured profile',async()=>{
    const data=await(await owner('/api/settings',undefined,'GET')).json();
    assert.equal(data.settings.routes.image,'openrouter');
    assert.equal(data.settings.providers.find(p=>p.id==='gemini').ready.image,false);
    assert.equal(data.settings.providers.find(p=>p.id==='openrouter').ready.image,true);
  });

  for(const id of ['gemini','openrouter'])await t.test(id+' catalog, generation and editing stay on the selected image provider',async()=>{
    const catalog=await owner('/api/ai/models?provider='+id+'&capability=image',undefined,'GET');
    assert.equal(catalog.status,200,await catalog.clone().text());
    const discovered=await catalog.json();
    assert.deepEqual(discovered.models,[id==='gemini'?'gemini-fixture-image':'vendor/raster']);
    assert.equal(discovered.capability,'image');
    await configure(id);
    for(const editing of [false,true]){
      const response=await owner('/api/media/image'+(editing?'/edit':''),{prompt:'Un peisaj',model:'forged-model',...(editing?{image:`data:image/png;base64,${png}`}:{})});
      const body=await response.json();
      assert.equal(response.status,200,JSON.stringify(body));
      assert.equal(body.provider,id);
      assert.equal(body.dataUrl,`data:image/png;base64,${png}`);
      assert.equal(body.model,id==='gemini'?'gemini-fixture-image':'vendor/raster');
      if(editing){
        const sent=calls().at(-1).body;
        if(id==='gemini')assert.equal(sent.contents[0].parts[1].inlineData.data,png);
        else assert.equal(sent.input_references[0].image_url.url,`data:image/png;base64,${png}`);
      }
    }
    const settings=await(await owner('/api/settings',undefined,'GET')).json();
    assert.equal(settings.settings.routes.text,'gemini');
    const selected=settings.settings.providers.find(p=>p.id===id);
    assert.equal(selected.ready.image,true);assert.equal(selected.capabilities.imageEdit,true);
    assert.equal(JSON.stringify(settings).includes('fixture-'+id+'-key'),false);
  });

  await t.test('provider quota is reported safely and is not a Nova administrator quota',async()=>{
    const response=await owner('/api/media/image',{prompt:'PROVIDER_QUOTA'});
    const body=await response.text();
    assert.equal(response.status,429);assert.match(body,/credit|cotă API/);
    assert.doesNotMatch(body,/Private provider detail|fixture-.*-key/);
    assert.equal(response.headers.get('x-nova-ai-remaining'),null);
  });

  await t.test('subscriber images charge once and cannot change the provider/model or inspect catalogs',async()=>{
    const signup=await request()('/api/auth/register',{username:'image-visitor',password:'pass1234'});
    assert.equal(signup.status,201,await signup.clone().text());
    const visitor=request(signup.headers.get('set-cookie').split(';',1)[0]);
    assert.equal((await visitor('/api/ai/models?provider=gemini&capability=image',undefined,'GET')).status,403);
    for(let n=0;n<5;n++){
      const response=await visitor('/api/media/image',{prompt:'Subscriber image',provider:'openai',model:'forged'});
      assert.equal(response.status,200);assert.equal(response.headers.get('x-nova-ai-remaining'),String(4-n));
      assert.equal((await response.json()).provider,'openrouter');
      assert.equal(calls().at(-1).body.model,'vendor/raster');
    }
    assert.equal((await visitor('/api/media/image',{prompt:'Beyond quota'})).status,429);
    assert.equal((await owner('/api/media/image',{prompt:'Owner remains available'})).status,200);
  });

  for(const id of ['gemini','openrouter'])await t.test(id+' disconnect cancels native image work',async()=>{
    await configure(id);
    const before=calls().length,controller=new AbortController();
    const pending=owner('/api/media/image',{prompt:'WAIT_CANCEL'},'POST',{signal:controller.signal});
    const rejected=assert.rejects(pending,{name:'AbortError'});
    for(let n=0;n<200&&!calls().slice(before).some(call=>call.body?.prompt==='WAIT_CANCEL'||call.body?.contents?.[0]?.parts?.[0]?.text==='WAIT_CANCEL');n++)await new Promise(resolve=>setTimeout(resolve,5));
    controller.abort();await rejected;
    for(let n=0;n<200&&!calls().slice(before).some(call=>call.type==='aborted');n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(calls().slice(before).some(call=>call.type==='aborted'&&call.provider===id));
  });
});
