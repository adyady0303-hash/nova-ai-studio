const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRestaurantService, normalizeRestaurant, distanceKm, isRestaurantMarketplaceIdea } = require('../restaurants');
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
const restaurant = () => ({ name: 'Restaurant TEST', address: 'Adresă TEST', lat: 52.52, lon: 13.405, radiusKm: 5, photo, currency: 'EUR', acceptingOrders: true, menu: [{ name: 'Pizza TEST', price: '12.50', photo, available: true }] });
function service(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'nova-restaurant-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let queue = Promise.resolve();
  const options = { filesystem: () => fs, root, withLock: operation => { const next=queue.then(operation); queue=next.catch(()=>{}); return next; }, ...extra };
  return { app:createRestaurantService(options), options };
}
test('restaurant validation enforces real EUR input, delivery coordinates and safe photos',()=>{
  const valid = normalizeRestaurant(restaurant()); assert.equal(valid.menu[0].priceCents,1250);
  for(const change of [{lat:''},{lat:91},{lon:null},{radiusKm:0},{currency:'RON'},{menu:[{name:'x',price:1.111}]},{menu:[]},{photo:'javascript:alert(1)'}]) assert.throws(()=>normalizeRestaurant({...restaurant(),...change}));
  assert.ok(distanceKm({lat:52.52,lon:13.405},{lat:48.85,lon:2.35})>800);
  assert.equal(isRestaurantMarketplaceIdea('Restaurante cu livrare la locația clientului'),true);
  assert.equal(isRestaurantMarketplaceIdea('Site pentru restaurantul meu'),false);
});
test('persisted merchant catalog isolates edits and orders, verifies radius and prices, and survives reload',async t=>{
  const {app, options}=service(t);
  const row=await app.save('merchant-a',restaurant());
  assert.equal((await createRestaurantService(options).mine('merchant-a')).id,row.id);
  assert.equal(await app.mine('merchant-b'),null);
  const results=await app.search({lat:52.52,lon:13.405});assert.equal(results.restaurants.length,1);assert.equal(results.restaurants[0].owner,undefined);assert.equal(results.restaurants[0].version,undefined);
  assert.equal((await app.search({lat:48.85,lon:2.35})).restaurants.length,0);
  const body={requestId:'a'.repeat(24),name:'Client TEST',email:'test@example.test',address:'Livrare TEST',lat:52.52,lon:13.405,items:[{id:row.menu[0].id,quantity:2}],expectedTotalCents:2500};
  await assert.rejects(()=>app.order(row.id,{...body,expectedTotalCents:1}),{status:409});
  await assert.rejects(()=>app.order(row.id,{...body,lat:48.85,lon:2.35}),{status:409});
  const [first, second]=await Promise.all([app.order(row.id,body),app.order(row.id,body)]);assert.equal(first.id,second.id);assert.equal(first.totalCents,2500);
  await assert.rejects(()=>app.order(row.id,{...body,name:'Alt client'}),{status:409});
  assert.equal((await app.orders('merchant-a')).length,1);assert.deepEqual(await app.orders('merchant-b'),[]);
  await assert.rejects(()=>app.updateOrder('merchant-b',first.id,'accepted'),{status:404});
  await assert.rejects(()=>app.updateOrder('merchant-a',first.id,'completed'),{status:409});
  await app.updateOrder('merchant-a',first.id,'accepted');await app.updateOrder('merchant-a',first.id,'completed');
  assert.equal((await app.orders('merchant-a'))[0].status,'completed');
  await assert.rejects(()=>app.updateOrder('merchant-a',first.id,'declined'),{status:409});
  await assert.rejects(()=>app.save('merchant-a',restaurant()),{status:409});
  await app.save('merchant-a',{...restaurant(),version:1,acceptingOrders:false});
  assert.deepEqual((await app.search({lat:52.52,lon:13.405})).restaurants,[]);
  await app.removeOwner('merchant-a');assert.equal(await app.mine('merchant-a'),null);assert.equal((await app.orders('merchant-a')).length,0);
});
test('geocoding distinguishes an upstream outage from a genuine empty result and caches successes',async t=>{
  let calls=0;
  const {app}=service(t,{fetchImpl:async url=>{calls++;assert.equal(url.hostname,'nominatim.openstreetmap.org');return new Response(JSON.stringify([{lat:'52.52',lon:'13.405',display_name:'Adresă TEST'}]));}});
  const result=await app.geocode('Adresă TEST');assert.equal(result.results[0].lat,52.52);await app.geocode('Adresă TEST');assert.equal(calls,1);
  const broken=service(t,{fetchImpl:async()=>new Response('upstream down',{status:503})}).app;
  await assert.rejects(()=>broken.geocode('Adresă TEST'),{status:503});
  const empty=service(t,{fetchImpl:async()=>new Response('[]')}).app;
  assert.deepEqual((await empty.geocode('Adresă TEST')).results,[]);
});

test('pizza discovery includes real nearby map places without enrollment, filters and deduplicates',async t=>{
  let calls=0;
  const {app}=service(t,{fetchImpl:async url=>{
    calls++;assert.equal(url.hostname,'nominatim.openstreetmap.org');assert.equal(url.searchParams.get('q'),'pizzeria');assert.equal(url.searchParams.get('bounded'),'1');assert.ok(url.searchParams.has('viewbox'));
    return new Response(JSON.stringify([
      {osm_type:'node',osm_id:1,name:'Pizzeria din zonă TEST',type:'restaurant',lat:'52.521',lon:'13.406',extratags:{cuisine:'pizza',website:'https://example.test/restaurant'}},
      {osm_type:'node',osm_id:1,name:'Pizzeria duplicat TEST',type:'restaurant',lat:'52.521',lon:'13.406'},
      {osm_type:'node',osm_id:2,name:'Pizzeria departe TEST',type:'restaurant',lat:'53',lon:'13.4'},
      {osm_type:'node',osm_id:3,name:'Sushi TEST',type:'restaurant',lat:'52.521',lon:'13.406',extratags:{cuisine:'sushi'}},
      {osm_type:'node',osm_id:4,name:'Pizzeria link invalid TEST',type:'restaurant',lat:'52.522',lon:'13.406',extratags:{website:'javascript:alert(1)'}},
      {osm_type:'node',osm_id:5,name:'Restaurant TEST',type:'restaurant',lat:'52.52',lon:'13.405',extratags:{cuisine:'pizza'}}
    ]));
  }});
  await app.save('merchant',restaurant());
  const [one,two]=await Promise.all([app.discover({lat:52.52,lon:13.405,q:'pizza'}),app.discover({lat:52.52,lon:13.405,q:'pizza'})]);
  assert.equal(calls,1);assert.equal(one.restaurants.length,3);assert.deepEqual(one,two);
  assert.equal(one.restaurants.filter(row=>row.orderable).length,1);
  const places=one.restaurants.filter(row=>!row.orderable);assert.equal(places.length,2);assert.ok(places.every(row=>!row.owner&&row.menu.length===0));
  assert.equal(places.find(row=>row.id==='osm-node-4').website,'');
  assert.ok(places.every(row=>row.distanceKm<=5));assert.match(one.attribution,/OpenStreetMap/);
  await app.discover({lat:52.52,lon:13.405,q:'pizza'});assert.equal(calls,1);
});
test('map outage never masquerades as no nearby restaurants, with honest local fallback',async t=>{
  const {app}=service(t,{fetchImpl:async()=>new Response('unavailable',{status:503})});
  await assert.rejects(()=>app.discover({lat:52.52,lon:13.405,q:'pizza'}),{status:503});
  await app.save('merchant',restaurant());
  const result=await app.discover({lat:52.52,lon:13.405,q:'pizza'});assert.equal(result.restaurants.length,1);assert.match(result.warning,/indisponibilă/);
  await assert.rejects(()=>app.discover({lat:'',lon:13.405,q:'pizza'}),{status:400});
  await assert.rejects(()=>app.discover({lat:52.52,lon:13.405,q:'a'.repeat(81)}),{status:400});
});
