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
  assert.ok(places.every(row=>row.distanceKm<=20));assert.match(one.attribution,/OpenStreetMap/);
  await app.discover({lat:52.52,lon:13.405,q:'pizza'});assert.equal(calls,1);
});
test('discovery covers twenty kilometres in both map bounds and results, including linked photos beyond five kilometres',async t=>{
  const center={lat:52.52,lon:13.405};
  const north=km=>({...center,lat:center.lat+km/6371*180/Math.PI});
  const metadataTitles=[];
  const {app}=service(t,{fetchImpl:async url=>{
    if(url.hostname==='nominatim.openstreetmap.org'){
      const [west,top,east,bottom]=url.searchParams.get('viewbox').split(',').map(Number);
      assert.equal(url.searchParams.get('bounded'),'1');
      assert.ok(top>=north(20).lat&&bottom<=north(-20).lat,'The upstream bounds must cover twenty kilometres north and south');
      const longitudeDelta=20/(111.2*Math.cos(center.lat*Math.PI/180));
      assert.ok(west<=center.lon-longitudeDelta&&east>=center.lon+longitudeDelta,'The upstream bounds must cover twenty kilometres east and west');
      return new Response(JSON.stringify([
        mapPlace(101,{wikimedia_commons:'File:Pizzeria_10km.jpg'},north(10)),
        mapPlace(102,{},north(19.9)),
        mapPlace(103,{wikimedia_commons:'File:Outside_20km.jpg'},north(20.1))
      ]));
    }
    assert.equal(url.origin,'https://commons.wikimedia.org');
    metadataTitles.push(url.searchParams.get('titles'));
    return commonsResponse(url.searchParams.get('titles'));
  }});
  const result=await app.discover({...center,q:'pizza'});
  assert.equal(result.radiusKm,20);
  assert.deepEqual(result.restaurants.map(row=>row.id),['osm-node-101','osm-node-102']);
  assert.deepEqual(result.restaurants.map(row=>row.distanceKm),[10,19.9]);
  assert.ok(result.restaurants.every(row=>row.orderable===false&&row.source==='OpenStreetMap'));
  assert.deepEqual(metadataTitles,['File:Pizzeria 10km.jpg'],'Photo enrichment must share the discovery radius without looking up places outside it');
  assert.match(result.restaurants[0].photo,/^https:\/\/upload\.wikimedia\.org\//);
  assert.equal(result.restaurants[1].photo,'');
});
test('registered restaurants remain discoverable beyond their delivery area without widening delivery or enabling checkout',async t=>{
  const payments={
    config:()=>({mode:'test',enabled:true,webhook:'fixture-webhook'}),
    onboarding:async()=>({id:'acct_discovery_fixture'}),
    onboardingLink:async()=>({url:'https://connect.stripe.com/fixture'}),
    ready:async()=>true
  };
  const {app}=service(t,{payments,fetchImpl:async url=>{assert.equal(url.hostname,'nominatim.openstreetmap.org');return new Response('[]');}});
  const owner='merchant-discovery-private';
  const row=await app.save(owner,{...restaurant(),menu:[...restaurant().menu,{name:'Preparat ascuns TEST',price:'20.00',available:false}]});
  await app.connect(owner,'DE',true);await app.connectStatus(owner);
  const outside={lat:row.lat+10/6371*180/Math.PI,lon:row.lon};
  const far=await app.discover({...outside,q:'pizza'}), visible=far.restaurants.find(item=>item.id===row.id);
  assert.equal(far.radiusKm,20);assert.ok(visible,'An active merchant ten kilometres away remains discoverable');
  assert.equal(visible.source,'Nova');assert.equal(visible.distanceKm,10);assert.equal(visible.radiusKm,5);
  assert.equal(visible.orderable,false);assert.equal(visible.cardPaymentsAvailable,false);
  assert.equal(visible.owner,undefined);assert.equal(visible.version,undefined);
  assert.deepEqual(visible.menu.map(item=>item.name),['Pizza TEST']);
  assert.doesNotMatch(JSON.stringify(visible),/merchant-discovery-private|Preparat ascuns TEST/);
  assert.equal((await app.search(outside)).restaurants.length,0,'The delivery-oriented search keeps its existing radius semantics');
  const body={requestId:'d'.repeat(24),name:'Client TEST',email:'test@example.test',address:'Livrare TEST',...outside,items:[{id:row.menu[0].id,quantity:1}],expectedTotalCents:1250};
  await assert.rejects(()=>app.order(row.id,body),error=>error.status===409&&/afara zonei de livrare/.test(error.message));
  assert.equal((await app.mine(owner)).radiusKm,5);assert.deepEqual(await app.orders(owner),[]);
  const near=await app.discover({lat:row.lat,lon:row.lon,q:'pizza'}), nearby=near.restaurants.find(item=>item.id===row.id);
  assert.equal(nearby.orderable,true);assert.equal(nearby.cardPaymentsAvailable,true,'The same connected merchant can take payment within its declared delivery area');
});
test('map outage never masquerades as no nearby restaurants, with honest local fallback',async t=>{
  const {app}=service(t,{fetchImpl:async()=>new Response('unavailable',{status:503})});
  await assert.rejects(()=>app.discover({lat:52.52,lon:13.405,q:'pizza'}),{status:503});
  await app.save('merchant',restaurant());
  const result=await app.discover({lat:52.52,lon:13.405,q:'pizza'});assert.equal(result.restaurants.length,1);assert.match(result.warning,/indisponibilă/);
  await assert.rejects(()=>app.discover({lat:'',lon:13.405,q:'pizza'}),{status:400});
  await assert.rejects(()=>app.discover({lat:52.52,lon:13.405,q:'a'.repeat(81)}),{status:400});
});

function mapPlace(id, extratags, extra = {}) {
  return { osm_type:'node', osm_id:id, name:'Pizzeria Commons TEST '+id, type:'restaurant', lat:'52.521', lon:'13.406', extratags:{cuisine:'pizza',...extratags}, ...extra };
}
function commonsResponse(title, changes = {}) {
  return new Response(JSON.stringify({query:{pages:[{ns:6,title,imageinfo:[{
    url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Pizzeria_TEST.jpg', mime:'image/jpeg',
    thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Pizzeria_TEST.jpg/900px-Pizzeria_TEST.jpg', thumbmime:'image/jpeg',
    extmetadata:{ Artist:{value:'<a href="https://commons.wikimedia.org/wiki/User:TEST">Jane &amp; John</a><script>hidden()</script>'}, LicenseShortName:{value:'CC BY-SA 4.0'}, LicenseUrl:{value:'http://creativecommons.org/licenses/by-sa/4.0/'} }, ...changes
  }]}]}}));
}
test('map photos resolve only linked Commons files with plain credits, reuse in-flight/cache, and prefer existing HTTPS images',async t=>{
  let mapCalls=0, commonsCalls=0;
  const {app}=service(t,{fetchImpl:async(url,options)=>{
    if(url.hostname==='nominatim.openstreetmap.org'){
      mapCalls++;
      return new Response(JSON.stringify([
        mapPlace(11,{wikimedia_commons:'File:Pizzeria_TEST.jpg'}),
        mapPlace(12,{image:'File:Pizzeria TEST.jpg'}),
        mapPlace(13,{image:'https://restaurant.example.test/facade.jpg',wikimedia_commons:'File:Do_not_fetch.jpg'})
      ]));
    }
    commonsCalls++;assert.equal(url.origin,'https://commons.wikimedia.org');assert.equal(url.pathname,'/w/api.php');
    assert.equal(url.searchParams.get('titles'),'File:Pizzeria TEST.jpg');assert.equal(url.searchParams.get('prop'),'imageinfo');
    assert.match(url.searchParams.get('iiprop'),/thumbmime/);assert.equal(options.redirect,'error');
    return commonsResponse('File:Pizzeria TEST.jpg');
  }});
  const result=await app.discover({lat:52.52,lon:13.405,q:'pizza'});
  assert.equal(commonsCalls,1,'Two OSM records for the same file share one metadata lookup');
  const resolved=result.restaurants.filter(row=>row.id!=='osm-node-13');
  assert.equal(resolved.length,2);assert.ok(resolved.every(row=>row.orderable===false&&row.menu.length===0));
  for(const row of resolved){
    assert.match(row.photo,/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/thumb\//);
    assert.equal(row.photoSourceUrl,'https://commons.wikimedia.org/wiki/File:Pizzeria_TEST.jpg');
    assert.equal(row.photoAttribution,'Jane & John · CC BY-SA 4.0');
    assert.equal(row.photoLicenseUrl,'https://creativecommons.org/licenses/by-sa/4.0/');
  }
  assert.equal(result.restaurants.find(row=>row.id==='osm-node-13').photo,'https://restaurant.example.test/facade.jpg');
  await app.discover({lat:52.5203,lon:13.405,q:'pizza'});
  assert.equal(mapCalls,2);assert.equal(commonsCalls,1,'A different map search reuses cached Commons metadata');
});
test('Commons enrichment is bounded to six nearby matching places and never invents photos for other map results',async t=>{
  const fetched=[];
  const {app}=service(t,{fetchImpl:async url=>{
    if(url.hostname==='nominatim.openstreetmap.org')return new Response(JSON.stringify([
      mapPlace(20,{wikimedia_commons:'File:Far_away.jpg'},{lat:'53'}),
      mapPlace(21,{wikimedia_commons:'File:Not_a_restaurant.jpg'},{type:'hotel'}),
      mapPlace(22,{wikimedia_commons:'File:Sushi.jpg'},{name:'Sushi TEST',extratags:{cuisine:'sushi',wikimedia_commons:'File:Sushi.jpg'}}),
      ...Array.from({length:9},(_,index)=>mapPlace(30+index,{wikimedia_commons:'File:Pizzeria_'+index+'.jpg'}))
    ]));
    assert.equal(url.hostname,'commons.wikimedia.org');fetched.push(url.searchParams.get('titles'));
    return commonsResponse(url.searchParams.get('titles'));
  }});
  const result=await app.discover({lat:52.52,lon:13.405,q:'pizza'});
  assert.equal(fetched.length,6);assert.ok(fetched.every(title=>/^File:Pizzeria \d\.jpg$/.test(title)));
  assert.equal(result.restaurants.length,9);assert.equal(result.restaurants.filter(row=>row.photo).length,6);
  assert.ok(result.restaurants.every(row=>row.orderable===false&&row.source==='OpenStreetMap'));
});
test('hostile photo metadata and incomplete credits leave actual map restaurants discoverable without server-side URL fetches',async t=>{
  let commonsCalls=0;
  const {app}=service(t,{fetchImpl:async(url,options)=>{
    if(url.hostname==='nominatim.openstreetmap.org')return new Response(JSON.stringify([
      mapPlace(41,{wikimedia_commons:'https://127.0.0.1/private'}),
      mapPlace(42,{wikimedia_commons:'Category:Restaurants'}),
      mapPlace(43,{wikimedia_commons:'File:One.jpg|File:Two.jpg'}),
      mapPlace(44,{wikimedia_commons:'File:Unsafe.jpg'}),
      mapPlace(45,{wikimedia_commons:'File:No_credit.jpg'}),
      mapPlace(46,{wikimedia_commons:'File:Redirect.jpg'})
    ]));
    commonsCalls++;assert.equal(url.origin,'https://commons.wikimedia.org');assert.equal(options.redirect,'error');
    const title=url.searchParams.get('titles');
    if(title==='File:Unsafe.jpg')return commonsResponse(title,{thumburl:'https://upload.wikimedia.org.attacker.example.test/photo.jpg',url:'https://127.0.0.1/private'});
    if(title==='File:No credit.jpg')return commonsResponse(title,{extmetadata:{Artist:{value:''},LicenseShortName:{value:'CC BY-SA 4.0'},LicenseUrl:{value:'https://creativecommons.org/licenses/by-sa/4.0/'}}});
    return new Response(null,{status:302,headers:{location:'http://169.254.169.254/private'}});
  }});
  const result=await app.discover({lat:52.52,lon:13.405,q:'pizza'});
  assert.equal(commonsCalls,3);assert.equal(result.restaurants.length,6);
  assert.ok(result.restaurants.every(row=>row.photo===''&&row.orderable===false&&!row.photoAttribution));
  assert.equal(result.warning,'');
  await app.discover({lat:52.5203,lon:13.405,q:'pizza'});
  assert.equal(commonsCalls,3,'Negative results are cached rather than repeatedly calling an unavailable source');
});
test('slow Commons metadata times out without hiding restaurants or waiting for a stalled response body',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let startMetadata, metadataSignal;
  const started=new Promise(resolve=>{startMetadata=resolve;});
  const {app}=service(t,{fetchImpl:async(url,options)=>{
    if(url.hostname==='nominatim.openstreetmap.org')return new Response(JSON.stringify([mapPlace(51,{wikimedia_commons:'File:Slow.jpg'})]));
    metadataSignal=options.signal;startMetadata();
    return {ok:true,json:()=>new Promise(()=>{})};
  }});
  const pending=app.discover({lat:52.52,lon:13.405,q:'pizza'});
  await started;await Promise.resolve();t.mock.timers.tick(4000);
  const result=await pending;
  assert.equal(metadataSignal.aborted,true);assert.equal(result.restaurants.length,1);
  assert.equal(result.restaurants[0].id,'osm-node-51');assert.equal(result.restaurants[0].photo,'');
  assert.equal(result.restaurants[0].orderable,false);assert.equal(result.warning,'');
});
