"use strict";
(() => {
  const el=id=>document.getElementById(id), bankForm=el('admin-bank-form'), loginForm=el('admin-login-form');
  function status(text,error=false){el('admin-status').textContent=text;el('admin-status').className=error?'error':'';}
  function lock(){bankForm.reset();el('bank-saved-at').textContent='';el('admin-bank-panel').hidden=true;el('admin-logout').hidden=true;el('admin-login-panel').hidden=false;}
  async function api(route,body,method='POST'){
    const response=await fetch(route,{credentials:'same-origin',cache:'no-store',...(body?{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(!response.ok){if(response.status===401||response.status===403)lock();throw Object.assign(new Error(data.error||'Cererea nu a putut fi finalizată.'),{status:response.status});}
    return data;
  }
  async function load(){
    const data=await api('/api/restaurants/admin/bank-settings');bankForm.reset();
    if(data.bank){for(const name of ['beneficiary','iban','bic','bankName'])bankForm.elements[name].value=data.bank[name]||'';el('bank-saved-at').textContent='Ultima salvare: '+new Date(data.bank.updatedAt).toLocaleString('ro-RO');}
    const payments=await api('/api/restaurants/admin/payments');el('stripe-status').textContent=payments.enabled?(payments.mode==='live'?'Plăți LIVE active · comision 10%.':'Mod TEST activ · fără încasări reale.'):!payments.configured?({missing_poftigo_secret:'Blocaj detectat: POFTIGO_STRIPE_SECRET_KEY lipsește din configurația platformei.',invalid_poftigo_secret:'Blocaj detectat: POFTIGO_STRIPE_SECRET_KEY are un format invalid.',invalid_public_url:'Blocaj detectat: POFTIGO_PUBLIC_URL este invalid. Folosește domeniul HTTPS fără cale sau parametri.'}[payments.configurationIssue]||'Stripe nu este conectat.'):payments.connectionError?'Conexiunea Stripe nu a putut fi verificată.':'Activare incompletă: verifică firma în Stripe, webhook-ul și setarea de activare.';
    el('admin-login-panel').hidden=true;el('admin-bank-panel').hidden=false;el('admin-logout').hidden=false;status(data.bank?'Datele bancare Poftigo sunt încărcate.':'Adaugă contul bancar pentru Poftigo.');
  }
  loginForm.addEventListener('submit',async event=>{event.preventDefault();const button=loginForm.querySelector('button');if(button.disabled)return;button.disabled=true;status('Verificăm accesul…');try{await api('/api/auth/login',{username:loginForm.elements.username.value,password:loginForm.elements.password.value});loginForm.elements.password.value='';await load();}catch(error){status(error.message,true);}finally{loginForm.elements.password.value='';button.disabled=false;}});
  bankForm.addEventListener('submit',async event=>{event.preventDefault();const button=bankForm.querySelector('button');if(button.disabled)return;const body=Object.fromEntries(new FormData(bankForm));for(const input of bankForm.querySelectorAll('input,button'))input.disabled=true;status('Salvăm datele…');try{await api('/api/restaurants/admin/bank-settings',body,'PUT');await load();status('Date bancare salvate. Verifică separat starea Stripe pentru încasările automate.');}catch(error){status(error.message,true);}finally{for(const input of bankForm.querySelectorAll('input,button'))input.disabled=false;}});
  el('admin-logout').addEventListener('click',async()=>{try{await api('/api/auth/logout',{});lock();status('Te-ai deconectat din administrare.');}catch(error){status(error.message,true);}});
  load().catch(error=>{lock();status(error.status===401?'Autentifică-te cu contul de administrator pentru a continua.':error.message,true);});
})();
