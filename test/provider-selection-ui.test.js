const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
const section = (start,end) => source.slice(source.indexOf(start),source.indexOf(end));
test('reopening settings preserves the edited Gemini profile while the current chat route is OpenAI', async () => {
  let selected;
  const context = vm.createContext({ editingProviderId:'gemini', state:{},
    api:async()=>({settings:{platform:'openai',providers:[{id:'openai'},{id:'gemini'}]}}),
    providerProfiles:settings=>settings.providers,renderProviderProfile:id=>{selected=id;},
    renderProviderOptions(){},renderRoutes(){},renderSearchSettings(){},renderDashboardProviders(){},updateCapabilityControls(){},refreshHealth:async()=>{} });
  vm.runInContext(section('async function loadProviderSettings(', 'function unsavedAiDraft('),context);
  await context.loadProviderSettings();
  assert.equal(selected,'gemini');
});
test('explicit Gemini choice pins chat and disables rotation and fallback while retaining media routes', async () => {
 const nodes={providerSelect:{value:'gemini'},routeText:{value:'openai'},routeImage:{value:'openai'},routeSpeech:{value:'openai'},autoSelectProvider:{checked:true},autoFallback:{checked:true}};
 let saved;
 const context=vm.createContext({el:id=>nodes[id],providerProfile:()=>({capabilities:{text:true}}),providerDraftDirty:false,
  saveProviderSettings:async()=>{saved={route:nodes.routeText.value,auto:nodes.autoSelectProvider.checked,fallback:nodes.autoFallback.checked,image:nodes.routeImage.value,speech:nodes.routeSpeech.value};}});
 vm.runInContext(section('async function useSelectedProviderForChat(', 'async function saveProviderSettings('),context);
 await context.useSelectedProviderForChat();
 assert.deepEqual(saved,{route:'gemini',auto:false,fallback:false,image:'openai',speech:'openai'});
});
test('an older health response cannot overwrite a newly saved Gemini selection', async () => {
 const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',style:{}});return nodes.get(id);};
 let done;const settings={platform:'openai'};
 const context=vm.createContext({state:{settings},el,api:()=>new Promise(resolve=>{done=resolve;})});
 vm.runInContext(section('async function refreshHealth(', 'function updateCapabilityControls('),context);
 const pending=context.refreshHealth();context.state.settings={platform:'gemini'};
 el('connectionText').textContent='Gemini';done({connected:true,provider:'openai'});await pending;
 assert.equal(el('connectionText').textContent,'Gemini');
});
