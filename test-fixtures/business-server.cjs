const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');

async function startBusinessFixture(t,{seed}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-business-online-'));
  if(seed)await seed(directory);
  const callsPath=path.join(directory,'calls.jsonl'),preload=path.join(directory,'provider.cjs');fs.writeFileSync(callsPath,'');
  fs.writeFileSync(preload,`
    const fs=require('node:fs');let failPublication=false,slowPublication=false;
    const originalWrite=fs.promises.writeFile.bind(fs.promises);
    fs.promises.writeFile=async(file,...args)=>{if(failPublication&&String(file).includes('published-sites.json')){failPublication=false;throw Object.assign(new Error('fixture publication failure'),{code:'EIO'});}if(slowPublication&&String(file).includes('published-sites.json')){slowPublication=false;await originalWrite(file,'',args[1]);await new Promise(resolve=>setTimeout(resolve,80));args[1]={...args[1],flag:'w'};}return originalWrite(file,...args);};
    const record=value=>fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(value)+'\\n');
    const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    const tool=(id,file,content)=>({id,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:file,content})}});
    global.fetch=async(url,options={})=>{
      if(String(url).startsWith('https://nominatim.openstreetmap.org/search'))return reply([{osm_type:'node',osm_id:123,name:'Pizzeria publică TEST',type:'restaurant',lat:'52.521',lon:'13.406',display_name:'Adresă TEST',extratags:{cuisine:'pizza',website:'https://example.test/pizza'}}]);
      if(String(url).endsWith('/models'))return reply({data:[{id:'fixture-business'}]});
      const body=JSON.parse(options.body),idea=body.messages.filter(m=>m.role==='user').at(-1).content;
      record({model:body.model,idea,messages:body.messages});
      if(body.messages[0]?.content?.startsWith('Interpret a restaurant-search query'))return reply({choices:[{message:{role:'assistant',content:JSON.stringify({kind:'food',term:'pizza'})}}],model:body.model});
      if(idea.includes('SLOW_BUILD'))await new Promise(resolve=>setTimeout(resolve,80));
      const used=body.messages.some(m=>m.role==='assistant'&&m.tool_calls?.length);
      if(used&&idea.includes('LATE_PROVIDER_FAILURE'))return reply({error:{message:'fixture unavailable'}},503);
      if(used&&idea.includes('INCOMPLETE_PROVIDER_FAILURE'))return reply({error:{message:'private fixture-key'}},401);
      if(idea.includes('ASK_FIRST')&&!body.messages.some(m=>m.role==='assistant'))return reply({choices:[{message:{role:'assistant',content:'Ce nume și ce culori preferi?'}}],model:body.model});
      const repair=idea.includes('Corectează problemele de verificare');
      if(used)return reply({choices:[{message:{role:'assistant',content:'Site creat.'}}],model:body.model});
      if(idea.includes('PUBLISH_FAIL'))failPublication=true;
      if(idea.includes('SLOW_PUBLICATION'))slowPublication=true;
      let files={
        'index.html':'<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Afacere de test</title><link rel="stylesheet" href="./styles.css"></head><body><main><h1>Servicii locale</h1><p>Solicită o ofertă adaptată cererii tale.</p></main><script src="./app.js"></script></body></html>',
        'styles.css':'body{font-family:system-ui;max-width:900px;margin:auto;padding:24px}input,textarea{font:inherit}h1{color:#1767af}',
        'app.js':'window.businessReady=true;'
      };
      if(idea.includes('INVALID_JS')&&!repair)files['app.js']='const broken = ;';
      if(idea.includes('ALWAYS_INVALID'))files['app.js']='const broken = ;';
      if(idea.includes('FAKE_RESTAURANTS'))files['app.js']="setTimeout(() => { document.body.textContent = 'Nu s-au găsit restaurante.'; },1500);";
      if(repair)files={'app.js':idea.includes('ALWAYS_INVALID')?'const broken = ;':'window.businessReady=true;'};
      if(idea.includes('INCOMPLETE_PROVIDER_FAILURE'))files={'index.html':files['index.html']};
      return reply({choices:[{message:{role:'assistant',content:null,tool_calls:Object.entries(files).map(([file,content],i)=>tool('write-'+i,file,content))}}],model:body.model});
    };
  `);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['--require',preload,'server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,
    HOST:'127.0.0.1',PORT:String(port),NOVA_DATA_DIR:directory,DATABASE_URL:'',NOVA_ACCESS_USER:'owner',NOVA_ACCESS_PASSWORD:'fixture-owner-password-long-enough',
    AI_PROVIDER:'openai',AI_FALLBACK_PROVIDERS:'',OPENAI_API_KEY:'fixture-key',OPENAI_MODEL:'fixture-business',
    GEMINI_API_KEY:'',OPENROUTER_API_KEY:'',ANTHROPIC_API_KEY:'',GROQ_API_KEY:'',MISTRAL_API_KEY:'',DEEPSEEK_API_KEY:'',XAI_API_KEY:'',TOGETHER_API_KEY:'',CUSTOM_OPENAI_API_KEY:''
  },stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}fs.rmSync(directory,{recursive:true,force:true});});
  let ready=false;for(let n=0;n<250;n++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(ready,logs);
  const request=(cookie='')=>(route,body,method='POST',origin=base)=>fetch(base+route,{method,headers:{cookie,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=await request()('/api/auth/login',{username:'owner',password:'fixture-owner-password-long-enough'});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';',1)[0],owner=request(cookie);
  const calls=()=>fs.readFileSync(callsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  async function finish(client,idea,requestId=crypto.randomUUID()){
    const accepted=await client('/api/business',{idea,requestId});assert.ok([200,202].includes(accepted.status),await accepted.clone().text());
    let result=await accepted.json();for(let n=0;n<350&&result.state==='building';n++){await new Promise(resolve=>setTimeout(resolve,10));const response=await client('/api/business?requestId='+requestId,undefined,'GET');assert.equal(response.status,200,logs);result=await response.json();}
    assert.notEqual(result.state,'building','Business job must finish');return {...result,requestId};
  }
  return {base,owner,request,cookie,calls,finish};
}

module.exports={startBusinessFixture};
