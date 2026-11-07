"use strict";
(() => {
  const el = id => document.getElementById(id);
  const money = cents => new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  const node = (tag, text, cls) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (cls) element.className = cls; return element; };
  const status = (id, message, error = false) => { el(id).textContent = message; el(id).className = error ? 'error' : ''; };
  let locationLabel = "", point = null, restaurants = [], selected = null, cartRestaurant = null, cart = new Map(), revision = 0, sending = false, lastOrder = null;
  async function api(route, body) {
    const response = await fetch(route, { credentials: 'same-origin', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Serviciul este indisponibil. Încearcă din nou.');
    return value;
  }
  function clearCart() { cart.clear(); cartRestaurant = null; lastOrder = null; renderCart(); }
  function invalidate() { revision++; point = null; selected = null; restaurants = []; el('restaurants-list').replaceChildren(); el('menu-section').hidden = true; clearCart(); }
  async function discover(location, label, token) {
    if (token !== revision) return;
    point = location; locationLabel = label; el('selected-address').textContent = label;
    status('search-status', 'Căutăm restaurante în apropiere…');
    try {
      const query = el('food-query').value.trim();
      const data = await api('/api/restaurants/discover?' + new URLSearchParams({ ...location, q: query }));
      if (token !== revision) return;
      point = location; locationLabel = label; restaurants = data.restaurants;
      el('selected-address').textContent = label;
      status('search-status', data.warning || (restaurants.length ? `${restaurants.length} rezultate${query ? ' pentru „' + query + '”' : ''} în apropiere.` : 'Nu am găsit rezultate pentru această căutare în apropiere. Încearcă alt preparat sau schimbă adresa.'), Boolean(data.warning));
      if (data.interpretation?.translated) el('selected-address').textContent = label + ' · Am înțeles: ' + data.interpretation.term;
      renderRestaurants();
    } catch (error) { if (token === revision) status('search-status', error.message, true); }
  }
  el('food-form').addEventListener('submit', event => {
    event.preventDefault();
    if (point) { const previous = point, label = locationLabel; invalidate(); discover(previous, label, revision); }
    else el('locate').click();
  });
  document.querySelectorAll('[data-food]').forEach(button => button.addEventListener('click', () => { el('food-query').value = button.dataset.food; el('food-form').requestSubmit(); }));
  el('address-form').addEventListener('submit', async event => {
    event.preventDefault(); invalidate(); const token = revision;
    el('address-results').replaceChildren(); status('search-status', 'Căutăm adresa…');
    try {
      const data = await api('/api/restaurants/geocode?q=' + encodeURIComponent(el('address-input').value.trim()));
      if (token !== revision) return;
      status('search-status', data.results.length ? 'Alege adresa corectă din listă.' : 'Adresa nu a fost găsită. Include localitatea și țara sau folosește localizarea.');
      for (const result of data.results) {
        const button = node('button', result.label); button.type = 'button';
        button.addEventListener('click', () => {
          el('address-results').replaceChildren();
          el('order-form').elements.address.value = result.label.slice(0, 300);
          discover({ lat: result.lat, lon: result.lon }, result.label, token);
        });
        el('address-results').append(button);
      }
    } catch (error) { if (token === revision) status('search-status', error.message, true); }
  });
  el('address-input').addEventListener('input', () => { invalidate(); el('address-results').replaceChildren(); el('selected-address').textContent = 'Confirmă noua adresă înainte de alegerea preparatelor.'; });
  el('locate').addEventListener('click', () => {
    invalidate(); const token = revision; el('address-results').replaceChildren();
    if (!navigator.geolocation) { el('manual-location').open = true; return status('search-status', 'Localizarea nu este disponibilă. Introdu adresa manual.', true); }
    status('search-status', 'Așteptăm acordul pentru localizare…');
    navigator.geolocation.getCurrentPosition(position => {
      if (token !== revision) return;
      el('order-form').elements.address.value = '';
      const location = { lat: position.coords.latitude, lon: position.coords.longitude };
      discover(location, 'Locația curentă. Completează adresa exactă în formularul comenzii.', token);
    }, error => {
      if (token !== revision) return;
      el('manual-location').open = true;
      status('search-status', error.code === 1 ? 'Localizarea a fost refuzată. Poți introduce adresa manual.' : 'Locația nu a putut fi stabilită. Introdu adresa manual.', true);
    }, { timeout: 12000, maximumAge: 60000, enableHighAccuracy: false });
  });
  function image(url, alt) {
    if (!url) return null;
    const img = node('img'); img.src = url; img.alt = alt; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove(), { once: true });
    return img;
  }
  function renderRestaurants() {
    const list = el('restaurants-list'); list.replaceChildren();
    if (!restaurants.length) { list.append(node('p', 'Încearcă un preparat precum pizza, burger sau sushi, ori verifică adresa selectată. Rezultatele depind de datele disponibile în OpenStreetMap.', 'empty')); return; }
    for (const restaurant of restaurants) {
      const card = node('article', null, 'restaurant-card'), cover = image(restaurant.photo, restaurant.name), body = node('div', null, 'card-body');
      if (cover) card.append(cover);
      body.append(node('h3', restaurant.name), node('p', restaurant.address));
      if (restaurant.orderable === false) {
        body.append(node('p', `${restaurant.distanceKm} km · OpenStreetMap`), node('p', 'Consultă restaurantul pentru meniu, prețuri și livrare.'));
        for (const [url, label] of [[restaurant.menuUrl, 'Meniu pe site-ul restaurantului'], [restaurant.website, 'Site-ul restaurantului'], [restaurant.mapUrl, 'Vezi pe hartă ↗']]) {
          if (!url) continue;
          let parsed; try { parsed = new URL(url); } catch { continue; }
          if (!['http:', 'https:'].includes(parsed.protocol)) continue;
          const link = node('a', label, 'external-place-link'); link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link);
        }
        card.append(body); list.append(card); continue;
      }
      body.append(node('p', `${restaurant.distanceKm} km · ${restaurant.menu.length} preparate · EUR · Comandă prin Nova`));
      const button = node('button', 'Vezi meniul'); button.type = 'button';
      button.addEventListener('click', () => { selected = restaurant; renderMenu(); el('menu-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      body.append(button); card.append(body); list.append(card);
    }
  }
  function renderMenu() {
    el('menu-section').hidden = !selected; if (!selected) return;
    el('menu-title').textContent = selected.name + ' · Meniu'; const grid = el('menu-grid'); grid.replaceChildren();
    for (const dish of selected.menu) {
      const card = node('article', null, 'dish-card'), photo = image(dish.photo, dish.name), body = node('div', null, 'card-body');
      if (photo) card.append(photo);
      body.append(node('h3', dish.name), node('p', dish.description), node('strong', money(dish.priceCents)));
      const button = node('button', 'Adaugă în coș'); button.type = 'button';
      button.addEventListener('click', () => {
        if (sending) return;
        if (cartRestaurant && cartRestaurant.id !== selected.id) return status('order-status', 'Coșul conține preparate de la alt restaurant. Golește-l înainte de a schimba restaurantul.', true);
        const quantity = cart.get(dish.id) || 0;
        if (quantity >= 30) return status('order-status', 'Maximum 30 de porții dintr-un preparat.', true);
        cartRestaurant = selected; cart.set(dish.id, quantity + 1); lastOrder = null; renderCart(); status('order-status', 'Preparatul a fost adăugat în coș.');
      });
      body.append(node('div'), button); card.append(body); grid.append(card);
    }
  }
  function total() { return cartRestaurant ? [...cart].reduce((sum, [id, quantity]) => sum + cartRestaurant.menu.find(item => item.id === id).priceCents * quantity, 0) : 0; }
  function renderCart() {
    const list = el('cart-items'); list.replaceChildren(); el('cart-restaurant').textContent = cartRestaurant?.name || '';
    if (!cart.size) list.append(node('p', 'Coșul este gol.'));
    for (const [id, quantity] of cart) {
      const dish = cartRestaurant.menu.find(item => item.id === id), row = node('div', null, 'cart-line'), controls = node('div', null, 'quantity');
      row.append(node('span', `${dish.name} · ${money(dish.priceCents * quantity)}`));
      for (const delta of [-1, 1]) { const button = node('button', delta < 0 ? '−' : '+'); button.type = 'button'; button.setAttribute('aria-label', `${delta < 0 ? 'Scade' : 'Crește'} cantitatea pentru ${dish.name}`); button.disabled = sending;
        button.addEventListener('click', () => { if (sending) return; const next = quantity + delta; if (next > 30) return; if (next <= 0) cart.delete(id); else cart.set(id, next); if (!cart.size) cartRestaurant = null; lastOrder = null; renderCart(); });
        if (delta === 1) controls.append(node('span', String(quantity))); controls.append(button);
      }
      row.append(controls); list.append(row);
    }
    el('cart-total').textContent = money(total()); el('clear-cart').hidden = !cart.size; el('clear-cart').disabled = sending; el('send-order').disabled = !cart.size || !point || sending;
  }
  el('close-menu').addEventListener('click', () => { selected = null; renderMenu(); });
  el('clear-cart').addEventListener('click', () => { if (!sending) clearCart(); });
  el('order-form').addEventListener('submit', async event => {
    event.preventDefault(); if (sending || !point || !cartRestaurant || !cart.size) return;
    const fields = new FormData(event.currentTarget);
    const payload = { name: fields.get('name'), email: fields.get('email'), address: fields.get('address'), ...point, items: [...cart].map(([id, quantity]) => ({ id, quantity })), expectedTotalCents: total() };
    const fingerprint = JSON.stringify(payload), restaurantId = cartRestaurant.id;
    if (!lastOrder || lastOrder.fingerprint !== fingerprint) { const bytes = crypto.getRandomValues(new Uint8Array(12)); lastOrder = { fingerprint, id: [...bytes].map(x => x.toString(16).padStart(2, '0')).join('') }; }
    sending = true; renderCart(); status('order-status', 'Trimitem cererea…');
    try {
      const data = await api(`/api/restaurants/${restaurantId}/orders`, { ...payload, requestId: lastOrder.id });
      clearCart(); status('order-status', `Cererea ${data.id} a fost înregistrată pentru ${money(data.totalCents)}. Așteaptă confirmarea restaurantului; nu s-a efectuat nicio plată.`);
    } catch (error) { status('order-status', error.message, true); }
    finally { sending = false; renderCart(); }
  });
  const site = new URLSearchParams(location.search).get('site');
  if (/^[a-f0-9]{24}$/.test(site || '')) {
    el('platform-contact').hidden = false;
    el('platform-contact-form').addEventListener('submit', async event => {
      event.preventDefault(); const button = event.currentTarget.querySelector('button'); if (button.disabled) return; button.disabled = true;
      try { const fields = new FormData(event.currentTarget); await api(`/p/${site}/contact`, Object.fromEntries(fields)); event.target.reset(); status('contact-status', 'Mesajul a fost înregistrat în inboxul operatorului.'); }
      catch (error) { status('contact-status', error.message, true); } finally { button.disabled = false; }
    });
  }
})();
