"use strict";
(() => {
  const el = id => document.getElementById(id), form = el('restaurant-form');
  const node = (tag, text, cls) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (cls) element.className = cls; return element; };
  const money = cents => new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  let version = 0, uploadedPhoto = '', saving = false, photoJobs = 0;
  function status(message, error = false) { el('manage-status').textContent = message; el('manage-status').className = error ? 'error' : ''; }
  async function api(route, body, method = 'POST') {
    const response = await fetch(route, { credentials: 'same-origin', ...(body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (response.status === 401) { form.hidden = true; el('orders-section').hidden = true; el('login-needed').hidden = false; }
    if (!response.ok) throw new Error(value.error || 'Cererea nu a putut fi finalizată.');
    return value;
  }
  async function compress(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12000000) throw new Error('Alege o fotografie PNG, JPEG sau WebP de maximum 12 MB.');
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas'), ratio = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * ratio); canvas.height = Math.round(bitmap.height * ratio);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const value = canvas.toDataURL('image/jpeg', .65);
      if (value.length > 180000) throw new Error('Fotografia este prea mare după redimensionare. Alege o imagine mai simplă.');
      return value;
    } finally { bitmap.close(); }
  }
  function updatePhotoPreview(value) { el('restaurant-photo-preview').hidden = !value; if (value) el('restaurant-photo-preview').src = value; }
  el('restaurant-photo-file').addEventListener('change', async event => {
    photoJobs++;
    try { uploadedPhoto = await compress(event.target.files[0]); form.elements.photo.value = ''; updatePhotoPreview(uploadedPhoto); status('Fotografie pregătită. Salvează restaurantul pentru publicare.'); }
    catch (error) { status(error.message, true); } finally { photoJobs--; }
  });
  form.elements.photo.addEventListener('input', () => { uploadedPhoto = ''; updatePhotoPreview(form.elements.photo.value); });
  function addDish(dish = {}) {
    const row = node('fieldset', null, 'menu-editor'); row.dataset.id = dish.id || '';
    const title = node('legend', 'Preparat'); row.append(title);
    const field = (label, name, type = 'text', value = '') => {
      const wrapper = node('label', label), input = node('input'); input.name = name; input.type = type; input.value = value; wrapper.append(input); row.append(wrapper); return input;
    };
    const name = field('Denumire', 'dishName', 'text', dish.name || ''); name.required = true; name.maxLength = 120;
    const description = field('Ingrediente, alergeni și descriere', 'dishDescription', 'text', dish.description || ''); description.maxLength = 600;
    const price = field('Preț în EUR', 'dishPrice', 'number', dish.priceCents ? (dish.priceCents / 100).toFixed(2) : ''); price.min = '.01'; price.max = '10000'; price.step = '.01'; price.required = true;
    const photoInput = field('Fotografie preparat · URL HTTPS', 'dishPhoto', 'url', dish.photo?.startsWith('https:') ? dish.photo : '');
    let dishUpload = dish.photo?.startsWith('data:') ? dish.photo : '';
    const preview = node('img', null, 'preview-photo'); preview.alt = 'Fotografia preparatului'; preview.hidden = !dish.photo; if (dish.photo) preview.src = dish.photo; row.append(preview);
    const upload = field('Sau încarcă fotografia preparatului', 'dishPhotoFile', 'file'); upload.accept = 'image/png,image/jpeg,image/webp';
    upload.addEventListener('change', async () => {
      photoJobs++;
      try { dishUpload = await compress(upload.files[0]); photoInput.value = ''; preview.src = dishUpload; preview.hidden = false; status('Fotografie pregătită. Salvează meniul pentru publicare.'); }
      catch (error) { status(error.message, true); } finally { photoJobs--; }
    });
    photoInput.addEventListener('input', () => { dishUpload = ''; preview.hidden = !photoInput.value; if (photoInput.value) preview.src = photoInput.value; });
    const availableLabel = node('label', null, 'check'), available = node('input'); available.type = 'checkbox'; available.checked = dish.available !== false; availableLabel.append(available, document.createTextNode('Disponibil în meniu')); row.append(availableLabel);
    const remove = node('button', 'Elimină preparatul', 'secondary'); remove.type = 'button'; remove.addEventListener('click', () => row.remove()); row.append(remove);
    row.valueForSave = () => ({ id: row.dataset.id, name: name.value, description: description.value, price: price.value, photo: dishUpload || photoInput.value, available: available.checked });
    el('menu-editor').append(row);
  }
  el('add-dish').addEventListener('click', () => { if (el('menu-editor').children.length >= 50) return status('Maximum 50 de preparate.', true); addDish(); });
  let addressRevision = 0;
  form.elements.address.addEventListener('input', () => { addressRevision++; el('restaurant-address-results').replaceChildren(); form.elements.lat.value = ''; form.elements.lon.value = ''; });
  el('find-restaurant-address').addEventListener('click', async () => {
    const token = ++addressRevision; status('Căutăm adresa restaurantului…'); el('restaurant-address-results').replaceChildren();
    try {
      const data = await api('/api/restaurants/geocode?q=' + encodeURIComponent(form.elements.address.value));
      if (token !== addressRevision) return;
      status(data.results.length ? 'Selectează adresa corectă a restaurantului.' : 'Adresa nu a fost găsită. Verifică localitatea și țara.');
      for (const result of data.results) { const button = node('button', result.label, 'secondary'); button.type = 'button'; button.addEventListener('click', () => { form.elements.address.value = result.label.slice(0, 300); form.elements.lat.value = result.lat; form.elements.lon.value = result.lon; el('restaurant-address-results').replaceChildren(); status('Locație aleasă. Verifică raza de livrare și salvează.'); }); el('restaurant-address-results').append(button); }
    } catch (error) { if (token === addressRevision) status(error.message, true); }
  });
  el('locate-restaurant').addEventListener('click', () => {
    const token = ++addressRevision;
    if (!navigator.geolocation) return status('Localizarea nu este disponibilă. Caută adresa sau introdu coordonatele.', true);
    navigator.geolocation.getCurrentPosition(position => { if (token !== addressRevision) return; form.elements.lat.value = position.coords.latitude; form.elements.lon.value = position.coords.longitude; status('Coordonate alese. Asigură-te că te afli la restaurant și completează adresa exactă.'); }, () => { if (token === addressRevision) status('Localizarea nu a fost permisă sau nu este disponibilă. Poți căuta adresa.', true); }, { timeout: 12000 });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return; if (photoJobs) return status('Așteaptă pregătirea fotografiilor înainte de salvare.', true);
    const body = { name: form.elements.name.value, address: form.elements.address.value, lat: form.elements.lat.value, lon: form.elements.lon.value, radiusKm: form.elements.radiusKm.value, photo: uploadedPhoto || form.elements.photo.value, currency: 'EUR', acceptingOrders: form.elements.acceptingOrders.checked, version, menu: [...el('menu-editor').children].map(row => row.valueForSave()) };
    saving = true; for (const input of form.querySelectorAll('input,button,textarea')) input.disabled = true; status('Salvăm restaurantul…');
    try {
      const data = await api('/api/restaurants/mine', body, 'PUT'); version = data.restaurant.version;
      [...el('menu-editor').children].forEach((row, i) => { row.dataset.id = data.restaurant.menu[i].id; });
      status(data.restaurant.acceptingOrders ? 'Restaurant salvat și activ. Clienții din zona declarată îl pot găsi.' : 'Restaurant salvat ca inactiv. Activează primirea cererilor când meniul este gata.');
    } catch (error) { status(error.message, true); } finally { saving = false; for (const input of form.querySelectorAll('input,button,textarea')) input.disabled = false; }
  });
  async function paymentStatus(){
    try{const data=await api('/api/restaurants/mine/payments');el('merchant-payments').hidden=false;el('connect-stripe').disabled=!data.configured;el('merchant-stripe-status').textContent=data.ready?(data.mode==='live'?'Plăți online active.':'Mod TEST activ; nu încasezi bani reali.'):!data.configured?'Administratorul trebuie să conecteze mai întâi Stripe pentru Poftigo.':data.connected?'Restaurant conectat; mai sunt verificări sau setări de activare de completat.':'Conectează contul Stripe al restaurantului.';}catch(error){el('merchant-stripe-status').textContent=error.message;}
  }
  el('refresh-stripe').addEventListener('click',paymentStatus);
  el('connect-stripe').addEventListener('click',async()=>{
    if(!el('stripe-consent').checked){el('merchant-stripe-status').textContent='Confirmă autorizarea și comisionul înainte de conectare.';return;}
    const button=el('connect-stripe');button.disabled=true;
    try{const data=await api('/api/restaurants/mine/payments',{country:el('stripe-country').value.trim().toUpperCase(),acceptedCommission:el('stripe-consent').checked});const url=new URL(data.url);if(url.protocol!=='https:'||url.hostname!=='connect.stripe.com')throw new Error('Adresa Stripe nu este validă.');location.assign(url.href);}catch(error){el('merchant-stripe-status').textContent=error.message;button.disabled=false;}
  });
  const labels = { awaiting_payment:'Așteaptă plata', pending: 'În așteptare', accepted: 'Acceptată', declined: 'Refuzată', completed: 'Finalizată' };
  async function loadOrders() {
    el('orders-status').textContent = 'Încărcăm cererile…';
    try {
      const data = await api('/api/restaurants/mine/orders'), list = el('restaurant-orders'); list.replaceChildren(); el('orders-status').textContent = data.orders.length ? 'Ultimele 100 de cereri. Contactează clientul pentru confirmare; emailurile nu sunt trimise automat.' : 'Nu ai primit încă cereri.';
      for (const order of data.orders) {
        const card = node('article', null, 'order-card'); card.append(node('h3', `${labels[order.status]} · ${money(order.totalCents)}`), node('p', `${order.customer.name}\n${order.customer.email}\n${order.customer.address}`), node('p', new Date(order.createdAt).toLocaleString('ro-RO')));
        if(order.payment)card.append(node('p',(order.payment.mode==='test'?'TEST · fără bani reali · ':'')+'Plată: '+({awaiting_payment:'în așteptare',paid:'confirmată',refunded:'rambursată',refund_pending:'rambursare în curs',expired:'expirată'}[order.payment.status]||order.payment.status)+' · Comision Poftigo: '+money(order.payment.feeCents)));
        const items = node('ul'); for (const item of order.items) items.append(node('li', `${item.quantity} × ${item.name} · ${money(item.priceCents * item.quantity)}`)); card.append(items);
        const actions = node('div', null, 'order-actions');
        for (const state of order.status === 'pending' ? ['accepted', 'declined'] : order.status === 'awaiting_payment' ? ['declined'] : order.status === 'accepted' ? (order.payment?.status==='paid'?['completed','declined']:['completed']) : order.status==='completed'&&order.payment?.status==='paid'?['declined']:[]) {
          const button = node('button', state === 'accepted' ? 'Acceptă cererea' : state === 'declined' ? (order.payment?.status==='paid'?'Refuză / rambursează plata':'Refuză cererea') : 'Marchează finalizată', 'secondary'); button.type = 'button';
          button.addEventListener('click', async () => { if(state==='declined'&&order.payment?.status==='paid'&&!confirm('Confirmi rambursarea plății de '+money(order.totalCents)+' către client?'))return; button.disabled = true; try { await api(`/api/restaurants/mine/orders/${order.id}`, { status: state }, 'PATCH'); await loadOrders(); } catch (error) { el('orders-status').textContent = error.message; button.disabled = false; } }); actions.append(button);
        }
        card.append(actions); list.append(card);
      }
    } catch (error) { el('orders-status').textContent = error.message; }
  }
  el('refresh-orders').addEventListener('click', loadOrders);
  (async () => {
    try {
      const data = await api('/api/restaurants/mine'), restaurant = data.restaurant;
      if (restaurant) { version = restaurant.version; for (const name of ['name', 'address', 'lat', 'lon', 'radiusKm']) form.elements[name].value = restaurant[name]; form.elements.acceptingOrders.checked = restaurant.acceptingOrders; uploadedPhoto = restaurant.photo.startsWith('data:') ? restaurant.photo : ''; form.elements.photo.value = uploadedPhoto ? '' : restaurant.photo; updatePhotoPreview(restaurant.photo); restaurant.menu.forEach(addDish); }
      else addDish();
      form.hidden = false; el('orders-section').hidden = false; status(restaurant ? 'Datele restaurantului sunt încărcate.' : 'Completează profilul și meniul pentru înscriere.'); await loadOrders(); await paymentStatus();
    } catch (error) { status(error.message, true); }
  })();
})();
