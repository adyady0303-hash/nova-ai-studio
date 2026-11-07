"use strict";
const crypto=require('node:crypto');
const {verifyWebhook}=require('./billing');
const fail=(message,status=503)=>Object.assign(new Error(message),{status});
const accountId=value=>/^acct_[A-Za-z0-9]+$/.test(value||'');
function createPoftigoPayments({env=process.env,request=(...args)=>fetch(...args)}={}){
 function configurationIssue(){
  const key=String(env.POFTIGO_STRIPE_SECRET_KEY||'').trim();
  if(!key)return 'missing_poftigo_secret';
  if(!/^sk_(test|live)_[A-Za-z0-9_]+$/.test(key))return 'invalid_poftigo_secret';
  try{
   const url=new URL(env.POFTIGO_PUBLIC_URL||'https://www.nova-ai-studio.eu');
   if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error();
  }catch{return 'invalid_public_url';}
  return null;
 }
 function config(){
  const key=String(env.POFTIGO_STRIPE_SECRET_KEY||'').trim(),webhook=String(env.POFTIGO_STRIPE_WEBHOOK_SECRET||'').trim();
  let origin;try{const u=new URL(env.POFTIGO_PUBLIC_URL||'https://www.nova-ai-studio.eu');if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error();origin=u.origin;}catch{return null;}
  return /^sk_(test|live)_[A-Za-z0-9_]+$/.test(key)?{key,webhook,origin,mode:key.startsWith('sk_live_')?'live':'test',enabled:env.POFTIGO_PAYMENTS_ENABLED==='true'}:null;
 }
 async function stripe(route,fields,idempotencyKey){
  const c=config();if(!c)throw fail('Stripe nu este conectat pentru Poftigo.');
  const headers={authorization:'Bearer '+c.key,'Stripe-Version':'2024-06-20'};
  if(fields)headers['content-type']='application/x-www-form-urlencoded';if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
  let response;try{response=await request('https://api.stripe.com/v1'+route,{method:fields?'POST':'GET',headers,...(fields?{body:new URLSearchParams(fields).toString()}:{}),signal:AbortSignal.timeout(12000)});}catch{throw fail('Conexiunea Stripe nu este disponibilă. Încearcă din nou.');}
  const data=await response.json().catch(()=>null);if(!response.ok||!data)throw fail('Stripe nu a putut finaliza operația. Verifică configurarea în administrare.');return data;
 }
 let platformCache;
 async function platform(){const c=config();if(!c)return null;if(platformCache&&platformCache.mode===c.mode&&Date.now()-platformCache.at<30000)return platformCache.account;const account=await stripe('/account');platformCache={mode:c.mode,at:Date.now(),account};return account;}
 async function summary(){
  const c=config();if(!c)return{configured:false,enabled:false,mode:null,commissionPercent:10,webhookConfigured:false,platformReady:false,configurationIssue:configurationIssue()};
  let ready=false,connectionError=false;try{const a=await platform();ready=Boolean(a.charges_enabled&&a.payouts_enabled);}catch{connectionError=true;}
  return{configured:true,enabled:Boolean(c.enabled&&c.webhook&&ready),requestedEnabled:c.enabled,mode:c.mode,commissionPercent:10,webhookConfigured:Boolean(c.webhook),platformReady:ready,connectionError,configurationIssue:null};
 }
 async function ensureEnabled(){const s=await summary();if(!s.configured||!s.enabled||!s.webhookConfigured||!s.platformReady)throw fail('Plățile Poftigo nu sunt activate sau contul Stripe nu este verificat.');return config();}
 async function connected(id){if(!accountId(id))throw fail('Restaurantul nu este conectat la Stripe.',409);return stripe('/accounts/'+id);}
 async function onboarding(owner,existing,country){
  const c=config();if(!c)throw fail('Administratorul trebuie să conecteze mai întâi Stripe pentru Poftigo.');
  if(!/^[A-Z]{2}$/.test(country||''))throw fail('Introdu codul țării firmei restaurantului, de exemplu RO sau DE.',400);
  const account=existing?await connected(existing):await stripe('/accounts',{type:'express',country,'capabilities[card_payments][requested]':'true','capabilities[transfers][requested]':'true','metadata[poftigo_owner]':owner},'poftigo-connect-'+c.mode+'-'+crypto.createHash('sha256').update(owner).digest('hex'));
  return account;
 }
 async function onboardingLink(id){const c=config();if(!c||!accountId(id))throw fail('Conectarea Stripe nu este disponibilă.');const data=await stripe('/account_links',{account:id,type:'account_onboarding',return_url:c.origin+'/restaurants/manage?stripe=return',refresh_url:c.origin+'/restaurants/manage?stripe=refresh'});return{url:safeUrl(data.url,'connect.stripe.com')};}
 async function ready(id){try{const c=await ensureEnabled(),a=await connected(id);return Boolean(c&&a.charges_enabled&&a.payouts_enabled&&a.capabilities?.card_payments==='active'&&a.capabilities?.transfers==='active');}catch{return false;}}
 function safeUrl(url,host){try{const u=new URL(url);if(u.protocol==='https:'&&u.hostname===host&&!u.username&&!u.password)return u.href;}catch{}throw fail('Stripe a returnat o adresă invalidă.');}
 async function checkout(restaurant,row,destination){
  if(row.totalCents<50)throw fail('Plata online în EUR necesită un total de cel puțin 0,50 EUR.',400);
  const c=await ensureEnabled();if(!await ready(destination))throw fail('Restaurantul nu poate primi plăți online acum.',409);
  const fields={mode:'payment','payment_method_types[0]':'card',customer_email:row.customer.email,success_url:c.origin+'/restaurants?payment=return',cancel_url:c.origin+'/restaurants?payment=cancel','metadata[poftigo_restaurant]':restaurant.id,'metadata[poftigo_order]':row.id,'payment_intent_data[metadata][poftigo_restaurant]':restaurant.id,'payment_intent_data[metadata][poftigo_order]':row.id,'payment_intent_data[application_fee_amount]':String(row.payment.feeCents),'payment_intent_data[transfer_data][destination]':destination,'payment_intent_data[on_behalf_of]':destination};
  row.items.forEach((item,i)=>Object.assign(fields,{[`line_items[${i}][price_data][currency]`]:'eur',[`line_items[${i}][price_data][unit_amount]`]:String(item.priceCents),[`line_items[${i}][price_data][product_data][name]`]:item.name,[`line_items[${i}][quantity]`]:String(item.quantity)}));
  const s=await stripe('/checkout/sessions',fields,'poftigo-checkout-'+c.mode+'-'+row.id);if(!/^cs_[A-Za-z0-9_]+$/.test(s.id||''))throw fail('Răspuns Stripe invalid.');return{id:s.id,url:safeUrl(s.url,'checkout.stripe.com')};
 }
 async function paymentIntent(id){if(!/^pi_[A-Za-z0-9]+$/.test(id||''))throw fail('Identificator de plată invalid.',400);return stripe('/payment_intents/'+id);}
 async function checkoutSession(id){if(!/^cs_[A-Za-z0-9_]+$/.test(id||''))throw fail('Identificator de plată invalid.',400);return stripe('/checkout/sessions/'+id);}
 async function expireCheckout(id){return stripe('/checkout/sessions/'+id+'/expire',{});}
 async function refund(row){
  if(!row.payment?.intentId)throw fail('Plata comenzii nu este confirmată.',409);
  return stripe('/refunds',{payment_intent:row.payment.intentId,reverse_transfer:'true',refund_application_fee:'true'},'poftigo-refund-'+config()?.mode+'-'+row.id);
 }
 function event(raw,signature){const c=config();return verifyWebhook(raw,signature,c?.webhook);}
 return{config,configurationIssue,summary,connected,onboarding,onboardingLink,ready,checkout,paymentIntent,checkoutSession,refund,event,expireCheckout};
}
module.exports={createPoftigoPayments};
