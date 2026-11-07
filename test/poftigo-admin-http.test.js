const test=require('node:test');const assert=require('node:assert/strict');const {startBusinessFixture}=require('../test-fixtures/business-server.cjs');
test('Poftigo banking is owner-only, validated, persisted and separate from Nova subscription receipts',async t=>{
 const app=await startBusinessFixture(t),route='/api/restaurants/admin/bank-settings';
 const landing=await fetch(app.base+'/restaurants/admin');assert.equal(landing.status,200);const html=await landing.text();assert.match(html,/Autentificare administrator/);assert.match(html,/noindex/);assert.doesNotMatch(html,/DE893704/);
 assert.equal((await fetch(app.base+route)).status,401);
 const signup=await app.request()('/api/auth/register',{username:'restaurant-banking-test',password:'pass1234'});const merchant=app.request(signup.headers.get('set-cookie').split(';',1)[0]);
 assert.equal((await merchant(route,undefined,'GET')).status,403);
 const body={beneficiary:'Poftigo TEST',iban:'DE89 3704 0044 0532 0130 00',bic:'COBADEFFXXX',bankName:'Bank TEST'};
 assert.equal((await merchant(route,body,'PUT')).status,403);
 assert.equal((await app.owner(route,body,'PUT','https://attacker.example')).status,403);
 const initial=await(await app.owner(route,undefined,'GET')).json();assert.equal(initial.bank,null);assert.equal(initial.automaticPayments,false);
 assert.equal((await app.owner(route,{...body,iban:'DE00370400440532013000'},'PUT')).status,400);
 assert.equal((await app.owner(route,{...body,bic:'invalid'},'PUT')).status,400);
 const saved=await app.owner(route,body,'PUT');assert.equal(saved.status,200);const result=await saved.json();assert.equal(result.bank.iban,'DE89370400440532013000');assert.equal(result.automaticPayments,false);
 const loaded=await(await app.owner(route,undefined,'GET')).json();assert.deepEqual(loaded.bank,result.bank);
 const publicResult=await(await fetch(app.base+'/api/restaurants/search?lat=52.52&lon=13.405')).text();assert.doesNotMatch(publicResult,/DE893704|COBADEFF|Poftigo TEST/);
 const nova=await(await app.owner('/api/billing/bank-orders',undefined,'GET')).json();assert.equal(nova.bank,null,'Saving Poftigo bank details must not redirect Nova subscriptions');
 assert.equal((await merchant(route,undefined,'GET')).status,403,'Merchant remains unable to read after saving');
});
