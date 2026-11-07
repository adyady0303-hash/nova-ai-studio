const test=require('node:test');
const assert=require('node:assert/strict');
const {startBusinessFixture}=require('../test-fixtures/business-server.cjs');
const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
test('native restaurant HTTP flow persists a real menu and a private order, without AI or payment',async t=>{
  const app=await startBusinessFixture(t);
  assert.equal((await fetch(app.base+'/restaurants')).status,200);
  assert.equal((await fetch(app.base+'/api/restaurants/mine')).status,401);
  const signup=await app.request()('/api/auth/register',{username:'merchant-test',password:'pass1234'});
  const merchant=app.request(signup.headers.get('set-cookie').split(';',1)[0]);
  const before=await (await merchant('/api/auth/me',undefined,'GET')).json();
  const value={name:'Local TEST',address:'Adresă TEST',lat:52.52,lon:13.405,radiusKm:4,photo,currency:'EUR',acceptingOrders:true,menu:[{name:'Preparat TEST',price:9.95,photo}]};
  const saved=await merchant('/api/restaurants/mine',value,'PUT');assert.equal(saved.status,200,await saved.clone().text());const row=(await saved.json()).restaurant;
  const search=await (await fetch(app.base+'/api/restaurants/search?lat=52.52&lon=13.405')).json();assert.equal(search.restaurants.length,1);assert.equal(search.restaurants[0].owner,undefined);
  const body={requestId:'b'.repeat(24),name:'Client TEST',email:'client@example.test',address:'Adresă TEST',lat:52.52,lon:13.405,items:[{id:row.menu[0].id,quantity:2}],expectedTotalCents:1990};
  assert.equal((await app.request()('/api/restaurants/'+row.id+'/orders',body,'POST','https://attacker.example')).status,403);
  const response=await app.request()('/api/restaurants/'+row.id+'/orders',body);assert.equal(response.status,201,await response.clone().text());const order=await response.json();assert.equal(order.totalCents,1990);
  assert.equal((await fetch(app.base+'/api/restaurants/mine/orders')).status,401);
  assert.equal((await (await app.owner('/api/restaurants/mine/orders',undefined,'GET')).json()).orders.length,0);
  assert.equal((await (await merchant('/api/restaurants/mine/orders',undefined,'GET')).json()).orders.length,1);
  assert.equal((await merchant('/api/restaurants/mine/orders/'+order.id,{status:'accepted'},'PATCH')).status,200);
  const after=await (await merchant('/api/auth/me',undefined,'GET')).json();assert.equal(after.quotaRemaining,before.quotaRemaining);
  assert.equal((await merchant('/api/restaurants/mine',{...value,version:1},'PUT','https://attacker.example')).status,403);
  assert.equal((await merchant('/api/auth/account',{confirmation:'merchant-test'},'DELETE')).status,200);
  const empty=await (await fetch(app.base+'/api/restaurants/search?lat=52.52&lon=13.405')).json();assert.equal(empty.restaurants.length,0);
});

test('the reported incomplete publication upgrades with backups while unrelated sites stay isolated',async t=>{
  const fs=require('node:fs'),path=require('node:path');let root;
  const id='e90b8660cff0e648a383bda3',other='f'.repeat(24);
  const app=await startBusinessFixture(t,{seed(directory){
    root=directory;
    for(const project of ['reported-delivery','untouched-delivery']){
      const dir=path.join(directory,'projects',project);fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'.nova-project.json'),JSON.stringify({name:'Nova Delivery',businessRequestId:'fixture-business'}));
      fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><title>Nova Delivery</title><p>Original TEST</p>');
      fs.writeFileSync(path.join(dir,'app.js'),"setTimeout(()=>{restaurantsList.innerHTML='No restaurants';},1500);");
      fs.writeFileSync(path.join(dir,'styles.css'),'body{color:red}');
    }
    fs.mkdirSync(path.join(directory,'data'),{recursive:true});
    fs.writeFileSync(path.join(directory,'data','published-sites.json'),JSON.stringify({version:1,sites:{[id]:{principal:'owner',project:'reported-delivery'},[other]:{principal:'owner',project:'untouched-delivery'}}}));
  }});
  const migrated=await fetch(app.base+'/p/'+id+'/',{redirect:'manual'});assert.equal(migrated.status,302);assert.equal(migrated.headers.get('location'),'/restaurants?site='+id);
  const backups=fs.readdirSync(path.join(root,'data','backups','reported-delivery'));assert.ok(backups.some(name=>name.startsWith('index.html.')&&name.endsWith('.bak')));
  const original=await fetch(app.base+'/p/'+other+'/');assert.equal(original.status,200);assert.match(await original.text(),/Original TEST/);
  assert.equal((await app.request()('/p/'+id+'/contact',{name:'Client',email:'client@example.test',message:'Contact TEST'},'POST','null')).status,201);
});

test('a food keyword finds nearby public map restaurants without any merchant enrollment',async t=>{
  const app=await startBusinessFixture(t);
  const response=await fetch(app.base+'/api/restaurants/discover?lat=52.52&lon=13.405&q=pizza');assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.restaurants.length,1);assert.equal(data.restaurants[0].source,'OpenStreetMap');assert.equal(data.restaurants[0].orderable,false);assert.match(data.restaurants[0].name,/Pizzeria/);
  assert.equal((await fetch(app.base+'/api/restaurants/discover?q=pizza')).status,400);
});

test('multilingual HTTP search normalizes words and asks AI only for the free-form query text',async t=>{
  const app=await startBusinessFixture(t);
  for(const q of ['пицца','بيتزا','ピザ','披萨']){
    const response=await fetch(app.base+'/api/restaurants/discover?lat=52.52&lon=13.405&q='+encodeURIComponent(q));assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.restaurants.length,1);assert.equal(data.interpretation.term,'pizza');
  }
  assert.equal(app.calls().length,0);
  const q='Je voudrais une pizza près de moi';
  const response=await fetch(app.base+'/api/restaurants/discover?lat=52.52&lon=13.405&q='+encodeURIComponent(q));assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.restaurants.length,1);assert.equal(data.interpretation.term,'pizza');
  assert.equal(app.calls().length,1);assert.equal(app.calls()[0].messages.find(message=>message.role==='user').content,q);
});
