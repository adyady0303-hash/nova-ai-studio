const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');

function setup() {
  const nodes=new Map(),requests=[];
  const el=id=>{
    if(!nodes.has(id))nodes.set(id,{value:'',checked:false,disabled:false,children:[],textContent:'',
      replaceChildren(...children){this.children=children;this.value=children[0]?.value||'';},add(child){this.children.push(child);}});
    return nodes.get(id);
  };
  const profile={id:'gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',apiKeyConfigured:true,capabilities:{image:true,imageEdit:true}};
  el('providerSelect').value='gemini';el('apiBaseUrl').value=profile.baseUrl;
  el('textModel').value='keep-chat-model';el('routeText').value='gemini';el('routeImage').value='openai';
  let context;
  context=vm.createContext({
    state:{account:{role:'owner'},settings:{routes:{text:'openai',image:'openai',speech:'openai',autoSelect:true,autoFallback:true}},imageCatalogModels:[],chatProviderSelection:'gemini'},
    el,providerProfile:()=>profile,editingProviderId:'gemini',providerDraftDirty:false,
    Option:class{constructor(text,value){this.textContent=text;this.value=value;}},
    respond:async()=>({models:['gemini-fixture-image'],recommendedModel:'gemini-fixture-image'}),
    api:async url=>{requests.push(url);return context.respond();},
    saveProviderSettings:async()=>{}
  });
  vm.runInContext(source.slice(source.indexOf('async function loadSavedProviderImageModels('),source.indexOf('async function testWebConnection(')),context);
  return {context,el,requests};
}

test('the image catalog selects an available image model without changing the text model',async()=>{
  const {context,el,requests}=setup();
  await context.loadSavedProviderImageModels();
  assert.equal(requests[0],'/api/ai/models?provider=gemini&capability=image');
  assert.equal(el('imageModel').value,'gemini-fixture-image');
  assert.equal(el('textModel').value,'keep-chat-model');
  assert.equal(context.providerDraftDirty,true);
});

test('use images saves only the intended image selection and restores the saved chat route',async()=>{
  const {context,el}=setup();
  el('imageModel').value='gemini-fixture-image';let selected;
  context.saveProviderSettings=async()=>{selected={image:el('routeImage').value,text:el('routeText').value,auto:el('autoSelectProvider').checked,fallback:el('autoFallback').checked,chatSelection:context.state.chatProviderSelection};};
  await context.useSelectedProviderForImages();
  assert.deepEqual(selected,{image:'gemini',text:'openai',auto:true,fallback:true,chatSelection:null});
  assert.equal(context.state.imageProviderSelection,'gemini');
});

test('image model discovery never overwrites a model typed during the request or another selected profile',async()=>{
  for(const switching of [false,true]){
    const {context,el}=setup();let resolve;
    context.respond=()=>new Promise(done=>{resolve=done;});
    const pending=context.loadSavedProviderImageModels();
    el('imageModel').value='a-new-draft';
    if(switching){context.editingProviderId='openrouter';context.state.imageCatalogRevision++;}
    resolve({models:['gemini-fixture-image'],recommendedModel:'gemini-fixture-image'});
    await pending;
    assert.equal(el('imageModel').value,'a-new-draft');
    assert.equal(el('textModel').value,'keep-chat-model');
  }
});

test('unsaved credentials must be saved before discovering image models',async()=>{
  const {context,el,requests}=setup();
  el('apiKey').value='fixture-unsaved-key';
  await context.loadSavedProviderImageModels();
  assert.equal(requests.length,0);
  assert.match(el('providerImageModelsStatus').textContent,/Salvează mai întâi cheia/);
});
