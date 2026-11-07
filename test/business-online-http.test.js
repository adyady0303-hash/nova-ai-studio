const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {startBusinessFixture}=require('../test-fixtures/business-server.cjs');

test('one business idea becomes an isolated working public site with real private customer requests',async t=>{
  const app=await startBusinessFixture(t);let built;
  await t.test('idea-only request creates files, handles model clarification internally and returns a real public URL',async()=>{
    const old=await app.owner('/api/projects',{name:'Keep existing project',empty:true});const previous=(await old.json()).project;
    await app.owner('/api/file',{project:previous.id,path:'index.html',content:'Existing work'},'PUT');
    built=await app.finish(app.owner,'ASK_FIRST servicii de curățenie');
    assert.equal(built.state,'published',JSON.stringify(built));assert.match(built.publication.url,/^\/p\/[a-f0-9]{24}\/$/);
    assert.notEqual(built.project.id,previous.id);assert.equal(built.publication.project,built.project.id);
    const html=await fetch(app.base+built.publication.url);assert.equal(html.status,200);const source=await html.text();
    assert.match(source,/Servicii locale/);assert.match(source,/data-nova-contact/);assert.match(source,/nova-contact\.js/);
    assert.doesNotMatch(html.headers.get('content-security-policy'),/allow-same-origin/);
    assert.equal((await fetch(app.base+built.publication.url+'app.js')).status,200);
    const kept=await app.owner('/api/file?project='+previous.id+'&path=index.html',undefined,'GET');assert.equal((await kept.json()).content,'Existing work');
    assert.match(app.calls()[0].messages[0].content,/Nu pune întrebări/);
    assert.doesNotMatch(built.content,/Ce nume|ce culori/);
  });
  await t.test('anonymous customer form stores a real request and keeps it out of public files',async()=>{
    const response=await app.request()(built.publication.url+'contact',{name:'Client real',email:'client@example.test',message:'Doresc o ofertă.'},'POST','null');
    assert.equal(response.status,201,await response.clone().text());assert.equal(response.headers.get('access-control-allow-origin'),'*');
    const preflight=await app.request()(built.publication.url+'contact',undefined,'OPTIONS','null');assert.equal(preflight.status,204);
    const inbox=await app.owner('/api/business/leads?project='+built.project.id,undefined,'GET');assert.equal(inbox.status,200);
    const data=await inbox.json();assert.equal(data.leads.length,1);assert.equal(data.leads[0].email,'client@example.test');
    assert.equal((await fetch(app.base+built.publication.url+'.nova-leads/'+data.leads[0].id+'.json')).status,403);
    assert.equal((await fetch(app.base+'/api/business/leads?project='+built.project.id)).status,401);
    const invalid=await app.request()(built.publication.url+'contact',{name:'x',email:'invalid',message:'test'},'POST','null');assert.equal(invalid.status,400);
  });
  await t.test('renaming the project preserves its business job and working contact form',async()=>{
    const renamed=await app.owner('/api/project/rename',{project:built.project.id,name:'Servicii redenumite'});assert.equal(renamed.status,200);
    const status=await(await app.owner('/api/business?requestId='+built.requestId,undefined,'GET')).json();
    assert.equal(status.state,'published');assert.equal(status.project.name,'Servicii redenumite');
    assert.equal((await app.request()(built.publication.url+'contact',{name:'Alt client',email:'other@example.test',message:'O cerere după redenumire'},'POST','null')).status,201);
  });
  await t.test('repeated request IDs return the same finished site without more AI calls',async()=>{
    const before=app.calls().length;
    const same=await app.finish(app.owner,'ASK_FIRST servicii de curățenie',built.requestId);
    assert.equal(same.publication.url,built.publication.url);assert.equal(app.calls().length,before);
    const changed=await app.owner('/api/business',{requestId:built.requestId,idea:'Another idea'});assert.equal(changed.status,409);
  });
  await t.test('invalid generated JavaScript is repaired before publication',async()=>{
    const result=await app.finish(app.owner,'INVALID_JS atelier de reparații');assert.equal(result.state,'published',JSON.stringify(result));
    const script=await(await fetch(app.base+result.publication.url+'app.js')).text();assert.equal(script,'window.businessReady=true;');
  });
  await t.test('unfixable output and publication failures never return a success link',async()=>{
    for(const idea of ['ALWAYS_INVALID atelier','PUBLISH_FAIL atelier','INCOMPLETE_PROVIDER_FAILURE atelier']){
      const result=await app.finish(app.owner,idea);assert.equal(result.state,'failed',JSON.stringify(result));assert.equal(result.publication,undefined);
      const files=await app.owner('/api/files?project='+result.project.id,undefined,'GET');assert.equal(files.status,200);
    }
  });
  await t.test('nearby restaurant requests use the native marketplace instead of an AI timer-only search',async()=>{
    const before=app.calls().length;
    const result=await app.finish(app.owner,'FAKE_RESTAURANTS restaurante din apropierea locației clientului cu poze, meniuri și prețuri în euro');
    assert.equal(result.state,'published',JSON.stringify(result));
    assert.equal(app.calls().length,before,'Native implementation must not ask AI to invent a data source');
    const page=await fetch(app.base+result.publication.url,{redirect:'manual'});
    assert.equal(page.status,302);assert.equal(page.headers.get('location'),'/restaurants?site='+result.publication.id);
    const appPage=await fetch(app.base+page.headers.get('location'));assert.match(await appPage.text(),/Poftigo/);
    const files=await app.owner('/api/files?project='+result.project.id,undefined,'GET');assert.equal(files.status,200);
  });
  await t.test('status polling never observes a partially written publications registry',async()=>{
    const result=await app.finish(app.owner,'SLOW_PUBLICATION atelier local');
    assert.equal(result.state,'published',JSON.stringify(result));
    assert.equal((await fetch(app.base+result.publication.url)).status,200);
  });
  await t.test('complete valid files can publish even if the final provider summary is unavailable',async()=>{
    const result=await app.finish(app.owner,'LATE_PROVIDER_FAILURE atelier');assert.equal(result.state,'published',JSON.stringify(result));
    assert.equal((await fetch(app.base+result.publication.url)).status,200);
  });
  await t.test('subscriber creation uses one unit and cannot read another workspace or its customer requests',async()=>{
    const signup=await app.request()('/api/auth/register',{username:'business-user',password:'pass1234'});assert.equal(signup.status,201);
    const visitor=app.request(signup.headers.get('set-cookie').split(';',1)[0]);
    const result=await app.finish(visitor,'SLOW_BUILD brutărie locală');assert.equal(result.state,'published',JSON.stringify(result));
    const me=await(await visitor('/api/auth/me',undefined,'GET')).json();assert.equal(me.quotaRemaining,4);
    assert.equal((await visitor('/api/business?requestId='+built.requestId,undefined,'GET')).status,404);
    assert.equal((await visitor('/api/business/leads?project='+built.project.id,undefined,'GET')).status,404);
    const calls=app.calls().length;await app.finish(visitor,'SLOW_BUILD brutărie locală',result.requestId);assert.equal(app.calls().length,calls);
    assert.equal((await(await visitor('/api/auth/me',undefined,'GET')).json()).quotaRemaining,4);
    const native=await app.finish(visitor,'Restaurante cu livrare la adresa clientului în euro');assert.equal(native.state,'published');
    assert.equal((await(await visitor('/api/auth/me',undefined,'GET')).json()).quotaRemaining,4,'Native restaurant creation does not consume AI');
  });
  await t.test('malformed ideas are rejected without generating a site',async()=>{
    for(const invalid of [null,[],false])assert.equal((await app.owner('/api/business',invalid)).status,400);
    for(const invalid of [{},{messages:'not an array'},{idea:23},{messages:[]}]){
      const response=await app.owner('/api/business',{requestId:crypto.randomUUID(),...invalid});assert.equal(response.status,400);
    }
  });
  await t.test('concurrent retries and renaming preserve one in-flight build',async()=>{
    const requestId=crypto.randomUUID(),idea='SLOW_BUILD servicii pentru birouri',before=app.calls().length;
    const responses=await Promise.all(Array.from({length:4},()=>app.owner('/api/business',{idea,requestId})));
    const jobs=await Promise.all(responses.map(async response=>{assert.equal(response.status,202);return response.json();}));
    assert.ok(jobs.every(job=>job.project.id===jobs[0].project.id));
    const renames=Array.from({length:8},(_,index)=>app.owner('/api/project/rename',{project:jobs[0].project.id,name:'Birouri '+index}));
    const polls=Array.from({length:15},()=>app.owner('/api/business?requestId='+requestId,undefined,'GET'));
    for(const response of await Promise.all([...renames,...polls]))assert.equal(response.status,200);
    const result=await app.finish(app.owner,idea,requestId);assert.equal(result.state,'published');assert.equal(result.project.name,'Birouri 7');
    assert.equal(app.calls().length-before,2);
  });
  await t.test('cross-origin creation is blocked and unpublishing stops customer submissions',async()=>{
    const response=await app.owner('/api/business',{requestId:crypto.randomUUID(),idea:'Unauthorized'},'POST','https://other.example');assert.equal(response.status,403);
    assert.equal((await app.owner('/api/project/unpublish',{project:built.project.id})).status,200);
    assert.equal((await app.request()(built.publication.url+'contact',{name:'x',email:'x@example.test',message:'after unpublish'},'POST','null')).status,404);
  });
});
