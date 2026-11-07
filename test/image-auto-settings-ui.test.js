const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createProfilesFromEnv,sanitizeProfileUpdate}=require('../ai-providers');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const client=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');

test('upgrading an old OpenAI image route enables recovery and explicit saved image choices stay respected',()=>{
  const context=vm.createContext({
    environmentProfiles:createProfilesFromEnv({OPENAI_API_KEY:'fixture-openai-key',GEMINI_API_KEY:'fixture-gemini-key'}),
    aiConfig:{routes:{text:'openai',image:'openai',speech:'openai',autoImageSelect:true},search:{provider:'auto',keys:{}}},
    AI_SETTINGS_SCHEMA_VERSION:5,sanitizeProfileUpdate,cleanSearchKey:value=>typeof value==='string'?value.trim():'',process:{env:{}}
  });
  vm.runInContext(server.slice(server.indexOf('function normalizedAiConfig('),server.indexOf('function applyStoredAiSettings(')),context);
  const settings=image=>({schemaVersion:5,routes:{text:'openai',image,speech:'openai'}});
  assert.equal(context.normalizedAiConfig(settings('openai')).routes.autoImageSelect,true);
  assert.equal(context.normalizedAiConfig(settings('gemini')).routes.autoImageSelect,false);
  const manual=settings('openai');manual.routes.autoImageSelect=false;
  assert.equal(context.normalizedAiConfig(manual).routes.autoImageSelect,false);
  const automatic=settings('gemini');automatic.routes.autoImageSelect=true;
  assert.equal(context.normalizedAiConfig(automatic).routes.autoImageSelect,true);
});

test('automatic image controls use server readiness even when the primary profile is unavailable or alternatives are hidden',()=>{
  const primary={id:'openai',ready:{image:false,imageEdit:false},capabilities:{image:true,imageEdit:true}};
  const context=vm.createContext({state:{settings:{routes:{autoImageSelect:true},imageRoutingReady:{image:true,imageEdit:false}}},
    providerProfiles:()=>[primary],routeProfile:()=>primary});
  vm.runInContext(client.slice(client.indexOf('function routeSupports('),client.indexOf('async function refreshHealth(')),context);
  assert.equal(context.routeSupports('image'),true);
  assert.equal(context.routeSupports('imageEdit'),false);
  context.state.settings.routes.autoImageSelect=false;
  assert.equal(context.routeSupports('image'),false);
});
