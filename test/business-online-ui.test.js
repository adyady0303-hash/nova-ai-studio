const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const uuid='b0ab2738-5637-43a1-88f7-2c8aaf103771';
const publication={published:true,url:'/p/0123456789abcdef01234567/',project:'new-business',business:true};
const finished={requestId:uuid,state:'published',project:{id:'new-business',name:'Afacere'},content:'Site publicat.',events:[],publication};
const plain=value=>JSON.parse(JSON.stringify(value));

function setup(){
  const nodes=new Map(),storage=new Map(),requests=[],cards=[],loaded=[],notices=[];
  const el=id=>{
    if(!nodes.has(id))nodes.set(id,{value:'',disabled:false,children:[],append(child){this.children.push(child);child.parent=this;},remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);},focus(){}});
    return nodes.get(id);
  };
  el('prompt').value='Servicii de curățenie';el('taskSelect').value='business';
  let context;
  context=vm.createContext({
    state:{busy:false,project:'old-project',projects:[{id:'old-project'}],chat:[{role:'user',content:'Private previous project'}],dirty:false},
    el,document:{createElement:()=>({remove(){}})},setView(){},resizePrompt(){},renderProjects(){},setTask:task=>el('taskSelect').value=task,
    storageKey:key=>key,chatKey:(project=context.state.project)=>'chat-'+project,
    writeLocalCache:(key,value)=>storage.set(key,value),readLocalCache:key=>storage.get(key),newCvRequestId:()=>uuid,
    addBubble:(role,content)=>{const node={role,content,remove(){}};el('messages').append(node);return node;},
    messageContainer:()=>el('messages'),jsonBody:value=>plain(value),toast:value=>notices.push(value),setTimeout:callback=>callback(),
    addPublishedSiteCard:value=>cards.push(plain(value)),
    respond:async route=>route==='/api/business'?{state:'building',requestId:uuid,phase:'generare',project:finished.project}:plain(finished),
    api:async(route,body)=>{requests.push({route,body:body&&plain(body)});return context.respond(route,body);},
    loadProject:async id=>{loaded.push(id);context.state.project=id;context.state.chat=JSON.parse(storage.get('chat-'+id));}
  });
  vm.runInContext(source.slice(source.indexOf('async function sendBusinessIdea('),source.indexOf('async function openBusinessLeads(')),context);
  vm.runInContext(source.slice(source.indexOf('async function send()'),source.indexOf('el("editor").addEventListener')),context);
  return{context,el,storage,requests,cards,loaded,notices};
}

test('business send needs only the idea and receives publication from the server without a model or project prompt',async()=>{
  const {context,el,storage,requests,loaded}=setup();await context.send();
  assert.equal(requests[0].route,'/api/business');assert.equal(requests[0].body.messages[0].content,'Servicii de curățenie');
  assert.equal(requests[0].body.model,undefined);assert.equal(requests[0].body.project,undefined);
  assert.equal(JSON.stringify(requests).includes('Private previous project'),false);
  assert.deepEqual(loaded,['new-business']);
  const history=JSON.parse(storage.get('chat-new-business'));assert.deepEqual(history[1].publication,publication);
  assert.equal(el('prompt').value,'');assert.equal(context.state.busy,false);assert.equal(el('sendBtn').disabled,false);
  assert.equal(requests.some(request=>request.route==='/api/project/publish'),false);
});

test('business completion keeps unrelated unsaved editor work and still delivers the final link',async()=>{
  const {context,cards,loaded}=setup();context.state.dirty=true;
  await context.sendBusinessIdea();assert.deepEqual(loaded,[]);assert.equal(context.state.project,'old-project');assert.equal(context.state.dirty,true);
  assert.deepEqual(cards,[publication]);
});

test('a network interruption keeps the same request ID so retry does not launch a duplicate business',async()=>{
  const {context,el,requests,storage}=setup();context.respond=async()=>{throw new Error('Network unavailable');};
  await context.sendBusinessIdea();assert.equal(el('prompt').value,'Servicii de curățenie');assert.equal(JSON.parse(storage.get('nova-business-draft')).requestId,uuid);
  context.respond=async()=>plain(finished);await context.sendBusinessIdea();
  assert.equal(requests[0].body.requestId,requests[1].body.requestId);
});

test('a failed build preserves the idea and partial project without inventing a published link',async()=>{
  const {context,el,cards,storage}=setup();context.respond=async()=>({state:'failed',project:finished.project,error:'Fișierele nu au trecut verificarea.'});
  await context.sendBusinessIdea();assert.equal(cards.length,0);assert.equal(el('prompt').value,'Servicii de curățenie');
  assert.equal(context.state.projects.some(project=>project.id==='new-business'),true);assert.equal(storage.has('chat-new-business'),false);
});

test('reloading an in-flight request reuses its ID and preserves a newer composer draft',async()=>{
  const {context,el,storage,requests}=setup();storage.set('nova-business-draft',JSON.stringify({idea:'Ideea salvată',requestId:uuid}));
  context.newCvRequestId=()=>assert.fail('must reuse the saved request');
  context.respond=async()=>{el('prompt').value='O altă idee, scrisă între timp';return plain(finished);};
  await context.resumeBusinessIdea();assert.equal(requests[0].body.requestId,uuid);assert.equal(el('prompt').value,'O altă idee, scrisă între timp');
});
