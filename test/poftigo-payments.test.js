const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPoftigoPayments}=require('../poftigo-payments');const {createRestaurantService}=require('../restaurants');
function fixture(t,live=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'poftigo-payments-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const env={POFTIGO_STRIPE_SECRET_KEY:live?'sk_live_fixture':'sk_test_fixture',POFTIGO_STRIPE_WEBHOOK_SECRET:'whsec_fixture',POFTIGO_PAYMENTS_ENABLED:'true',POFTIGO_PUBLIC_URL:'https://example.test'};
 const calls=[],state={paid:false,platformReady:true,total:0,fee:0,metadata:{},session:'cs_test_fixture',intent:'pi_fixture',sessionStatus:'open'};
 const request=async(url,options)=>{
  assert.equal(new URL(url).hostname,'api.stripe.com');assert.equal(options.headers['Stripe-Version'],'2024-06-20');assert.ok(options.signal);const route=new URL(url).pathname.replace('/v1',''),fields=new URLSearchParams(options.body||'');calls.push({route,method:options.method,fields,idempotency:options.headers['Idempotency-Key']});
  let data;
  if(route==='/account')data={id:'acct_platform',charges_enabled:state.platformReady,payouts_enabled:state.platformReady};
  else if(route==='/accounts')data={id:'acct_restaurant'};
  else if(route==='/accounts/acct_restaurant')data={id:'acct_restaurant',charges_enabled:true,payouts_enabled:true,capabilities:{card_payments:'active',transfers:'active'}};
  else if(route==='/account_links')data={url:'https://connect.stripe.com/setup/test'};
  else if(route==='/checkout/sessions'&&options.method==='POST'){
   state.fee=Number(fields.get('payment_intent_data[application_fee_amount]'));state.metadata={poftigo_restaurant:fields.get('metadata[poftigo_restaurant]'),poftigo_order:fields.get('metadata[poftigo_order]')};
   state.total=Number(fields.get('line_items[0][price_data][unit_amount]'))*Number(fields.get('line_items[0][quantity]'));
   assert.equal(fields.get('payment_intent_data[transfer_data][destination]'),'acct_restaurant');assert.equal(fields.get('payment_intent_data[on_behalf_of]'),'acct_restaurant');assert.equal(state.fee,Math.round(state.total*.1));data={id:state.session,url:'https://checkout.stripe.com/c/pay/test'};
  }else if(route==='/checkout/sessions/'+state.session)data={id:state.session,status:state.paid?'complete':state.sessionStatus,livemode:live,payment_status:state.paid?'paid':'unpaid',currency:'eur',amount_total:state.total,payment_intent:state.intent};
  else if(route==='/checkout/sessions/'+state.session+'/expire'){state.sessionStatus='expired';data={id:state.session,status:'expired'};}
  else if(route==='/payment_intents/'+state.intent)data={id:state.intent,status:'succeeded',amount_received:state.total,currency:'eur',application_fee_amount:state.fee,transfer_data:{destination:'acct_restaurant'},metadata:state.metadata};
  else if(route==='/refunds'){assert.equal(fields.get('reverse_transfer'),'true');assert.equal(fields.get('refund_application_fee'),'true');data={id:'re_fixture',status:'succeeded'};}
  else throw new Error('Unexpected Stripe route '+route);
  return new Response(JSON.stringify(data),{status:200});
 };
 const payments=createPoftigoPayments({env,request});let queue=Promise.resolve();const withLock=op=>{const next=queue.then(op);queue=next.catch(()=>{});return next;};
 const app=createRestaurantService({filesystem:()=>fs,root,withLock,payments});
 function signed(type,overrides={}){const raw=Buffer.from(JSON.stringify({id:'evt_fixture',type,data:{object:{id:state.session,metadata:state.metadata,...overrides}}}));const timestamp=Math.floor(Date.now()/1000);return[raw,`t=${timestamp},v1=${crypto.createHmac('sha256',env.POFTIGO_STRIPE_WEBHOOK_SECRET).update(timestamp+'.').update(raw).digest('hex')}`];}
 return{app,payments,env,calls,state,signed};
}
const restaurant={name:'Restaurant PAYMENTS TEST',address:'Berlin TEST',lat:52.52,lon:13.405,radiusKm:5,currency:'EUR',photo:'https://example.test/food.jpg',acceptingOrders:true,menu:[{name:'Pizza TEST',price:'15.00'}]};
async function onboard(f){const row=await f.app.save('merchant',restaurant);await assert.rejects(()=>f.app.connect('merchant','DE',false),{status:400});await f.app.connect('merchant','DE',true);assert.equal((await f.app.connectStatus('merchant')).ready,true);return row;}
function body(row){return{requestId:'d'.repeat(24),name:'Client TEST',email:'client@example.test',address:'Berlin TEST',lat:52.52,lon:13.405,items:[{id:row.menu[0].id,quantity:2}],expectedTotalCents:3000,payOnline:true};}
test('Checkout takes a server-calculated 10% fee and only verified payment enables acceptance; refusal refunds once',async t=>{
 const f=fixture(t),row=await onboard(f),payload=body(row);
 assert.equal((await f.app.search({lat:52.52,lon:13.405})).restaurants[0].cardPaymentsAvailable,true);
 const order=await f.app.order(row.id,payload);assert.match(order.checkoutUrl,/^https:\/\/checkout.stripe.com/);assert.equal(f.state.fee,300);
 const retry=await f.app.order(row.id,payload);assert.equal(order.id,retry.id);assert.equal(f.calls.filter(c=>c.route==='/checkout/sessions'&&c.method==='POST').length,1);
 await assert.rejects(()=>f.app.updateOrder('merchant',order.id,'accepted'),{status:409});
 const [raw,sig]=f.signed('checkout.session.completed');await assert.rejects(()=>f.app.webhook(raw,'t=0,v1='+'0'.repeat(64)),{status:400});
 await f.app.webhook(raw,sig);assert.equal((await f.app.orders('merchant'))[0].payment.status,'awaiting_payment','An unpaid Stripe session or a success URL must not confirm payment');
 f.state.paid=true;await f.app.webhook(raw,sig);await f.app.webhook(raw,sig);let stored=(await f.app.orders('merchant'))[0];assert.equal(stored.payment.status,'paid');assert.equal(stored.payment.mode,'test');assert.equal(stored.status,'pending');
 await f.app.updateOrder('merchant',order.id,'accepted');await f.app.updateOrder('merchant',order.id,'declined');await f.app.updateOrder('merchant',order.id,'declined');stored=(await f.app.orders('merchant'))[0];assert.equal(stored.payment.status,'refunded');assert.equal(f.calls.filter(c=>c.route==='/refunds').length,1);
});
test('unpaid checkout can expire, mode changes cannot charge test orders live, and unverified platforms stay disabled',async t=>{
 const f=fixture(t),row=await onboard(f);const order=await f.app.order(row.id,body(row));await f.app.updateOrder('merchant',order.id,'declined');assert.equal((await f.app.orders('merchant'))[0].payment.status,'expired');
 f.env.POFTIGO_STRIPE_SECRET_KEY='sk_live_different';await assert.rejects(()=>f.app.order(row.id,body(row)),{status:409});
 const blocked=fixture(t);blocked.state.platformReady=false;assert.equal((await blocked.payments.summary()).enabled,false);assert.equal(await blocked.payments.ready('acct_restaurant'),false);
});
test('live transactions block account removal until refund; wrong amount is never treated as paid',async t=>{
 const f=fixture(t,true),row=await onboard(f),order=await f.app.order(row.id,body(row));await assert.rejects(()=>f.app.assertCanRemoveOwner('merchant'),{status:409});
 f.state.paid=true;f.state.total=100;const [raw,sig]=f.signed('checkout.session.completed');await assert.rejects(()=>f.app.webhook(raw,sig),{status:409});
 f.state.total=3000;await f.app.webhook(raw,sig);await f.app.updateOrder('merchant',order.id,'declined');await f.app.assertCanRemoveOwner('merchant');
});
test('no Stripe configuration exposes no secrets and never enables automatic payments',async()=>{
 const app=createPoftigoPayments({env:{},request:()=>{throw new Error('Must not request Stripe');}});const summary=await app.summary();assert.equal(summary.enabled,false);assert.equal(summary.configured,false);assert.equal(summary.commissionPercent,10);await assert.rejects(()=>app.checkout({},{}),{status:503});
});
