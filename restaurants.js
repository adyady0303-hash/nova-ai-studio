"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { bankConfiguration } = require("./billing");
const { createFoodInterpreter, normalize: normalizeFoodText } = require("./restaurant-query");
const fail = (status, message) => Object.assign(new Error(message), { status });
const ID = /^[a-f0-9]{24}$/;
function text(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw fail(400, `Completează ${name} (maximum ${max} caractere).`);
  return value.trim();
}
function coordinate(value, max) {
  if (value === "" || value == null || typeof value === "boolean" || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > max) throw fail(400, "Locația nu este validă.");
  return Number(value);
}
function coordinates(value) { return { lat: coordinate(value.lat, 90), lon: coordinate(value.lon, 180) }; }
function photo(value) {
  if (!value) return "";
  if (typeof value !== "string" || value.length > 180000) throw fail(400, "Fotografia este prea mare. Folosește o imagine mai mică sau un URL HTTPS.");
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password && value.length <= 2048) return url.href; } catch {}
  throw fail(400, "Fotografia trebuie să fie PNG, JPEG, WebP sau un URL HTTPS.");
}
function normalizeRestaurant(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "Datele restaurantului nu sunt valide.");
  if (body.currency !== "EUR") throw fail(400, "Introdu prețurile efective în euro (EUR).");
  const point = coordinates(body);
  const radiusKm = Number(body.radiusKm);
  if (!Number.isFinite(radiusKm) || radiusKm < 0.1 || radiusKm > 50) throw fail(400, "Zona de livrare trebuie să fie între 0,1 și 50 km.");
  if (!Array.isArray(body.menu) || body.menu.length > 50) throw fail(400, "Meniul poate avea maximum 50 de preparate.");
  const ids = new Set();
  const menu = body.menu.map(item => {
    if (!item || typeof item !== "object") throw fail(400, "Preparatul nu este valid.");
    const price = Number(item.price);
    if (item.price === "" || !Number.isFinite(price) || price <= 0 || price > 10000 || Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) throw fail(400, "Prețul trebuie să fie pozitiv, în euro, cu maximum două zecimale.");
    const id = ID.test(item.id || "") ? item.id : crypto.randomBytes(12).toString("hex");
    if (ids.has(id)) throw fail(400, "Preparatele trebuie să aibă identificatori diferiți.");
    ids.add(id);
    return { id, name: text(item.name, "numele preparatului", 120), description: typeof item.description === "string" ? item.description.trim().slice(0, 600) : "", priceCents: Math.round(price * 100), photo: photo(item.photo), available: item.available !== false };
  });
  const value = { name: text(body.name, "numele restaurantului", 120), address: text(body.address, "adresa restaurantului", 300), ...point, radiusKm, currency: "EUR", photo: photo(body.photo), acceptingOrders: body.acceptingOrders === true, menu };
  if (value.acceptingOrders && (!menu.some(item => item.available) || !value.photo)) throw fail(400, "Adaugă fotografia restaurantului și cel puțin un preparat disponibil înainte de activare.");
  if (Buffer.byteLength(JSON.stringify(value)) > 850000) throw fail(413, "Fotografiile și meniul depășesc limita. Redu dimensiunea imaginilor.");
  return value;
}
function distanceKm(a, b) {
  const rad = x => x * Math.PI / 180;
  const deltaLat = rad(b.lat - a.lat), deltaLon = rad(b.lon - a.lon);
  const x = Math.sin(deltaLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
}
function publicRestaurant(row) {
  const { owner, version, ...value } = row;
  return { ...value, menu: value.menu.filter(item => item.available) };
}
function isRestaurantMarketplaceIdea(idea) {
  const request = String(idea).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /restaurant/.test(request) && /apropiere|locati|adresa|livrar|nearby|location|delivery|address/.test(request);
}
function createRestaurantService({ filesystem, root, withLock, assertPrincipalActive = async () => {}, fetchImpl = (...args) => fetch(...args), payments, translateQuery, nominatimEndpoint = process.env.NOVA_NOMINATIM_URL || "https://nominatim.openstreetmap.org/search" }) {
  const file = path.join(root, "data", "restaurant-catalog.json");
  const orderFile = id => path.join(root, "data", "restaurant-orders", id + ".json");
  async function read(filePath, initial) {
    try { return JSON.parse(await filesystem().promises.readFile(filePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return initial; throw error; }
  }
  async function write(filePath, value) {
    const fs = filesystem().promises;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = filePath + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, filePath);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  const catalog = () => read(file, []);
  const connectFile=owner=>path.join(root,'data','poftigo-connect',crypto.createHash('sha256').update(owner).digest('hex')+'-'+(payments?.config()?.mode||'unconfigured')+'.json');
  async function connection(owner){return read(connectFile(owner),null);}
  async function connectStatus(owner){
    const entry=await connection(owner);let ready=false;
    if(entry&&payments?.config())ready=await payments.ready(entry.id);
    if(entry)await withLock(()=>write(connectFile(owner),{...entry,ready}));
    return{configured:Boolean(payments?.config()),connected:Boolean(entry),ready,mode:payments?.config()?.mode||null};
  }
  async function connect(owner,country,acceptedCommission){
    if(acceptedCommission!==true)throw fail(400,'Confirmă comisionul Poftigo de 10% înainte de conectare.');
    if(!payments)throw fail(503,'Stripe nu este conectat.');
    if(!await mine(owner))throw fail(409,'Salvează mai întâi profilul restaurantului.');
    let id;await withLock(async()=>{await assertPrincipalActive(owner);const previous=await connection(owner);const account=await payments.onboarding(owner,previous?.id,String(country||'').toUpperCase());id=account.id;await write(connectFile(owner),{id,ready:false,commissionPercent:10,acceptedAt:new Date().toISOString()});});
    return payments.onboardingLink(id);
  }
  async function paymentOption(owner){const c=payments?.config(),entry=c&&await connection(owner);return Boolean(c?.enabled&&c.webhook&&entry?.ready&&entry.commissionPercent===10);}
  async function finishCheckout(restaurant,row,orders){
    if(row.payment.mode!==payments?.config()?.mode)throw fail(409,'Modul de plată s-a schimbat. Reîncarcă pagina și creează o comandă nouă.');
    if(row.payment.status!=='awaiting_payment')return{received:true,id:row.id,totalCents:row.totalCents,currency:'EUR',status:row.status,paymentStatus:row.payment.status};
    if(!row.payment.sessionId){const session=await payments.checkout(restaurant,row,row.payment.destination);row.payment.sessionId=session.id;row.payment.checkoutUrl=session.url;await write(orderFile(restaurant.id),orders);}
    return{received:true,id:row.id,totalCents:row.totalCents,currency:'EUR',status:row.status,paymentStatus:row.payment.status,checkoutUrl:row.payment.checkoutUrl};
  }
  async function verifiedPayment(restaurant,row){
    const session=await payments.checkoutSession(row.payment.sessionId);
    if(session.payment_status!=='paid')return false;
    const pi=await payments.paymentIntent(typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id);
    if(session.amount_total!==row.totalCents||session.currency!=='eur'||pi.status!=='succeeded'||pi.amount_received!==row.totalCents||pi.currency!=='eur'||pi.application_fee_amount!==row.payment.feeCents||pi.transfer_data?.destination!==row.payment.destination||pi.metadata?.poftigo_order!==row.id||pi.metadata?.poftigo_restaurant!==restaurant.id||Boolean(session.livemode)!==(payments.config().mode==='live'))throw fail(409,'Plata Stripe nu corespunde comenzii.');
    row.payment.intentId=pi.id;row.payment.status='paid';return true;
  }
  async function refundOrder(row){const refund=await payments.refund(row);row.payment.status=refund.status==='succeeded'?'refunded':'refund_pending';row.payment.refundId=refund.id;}
  async function webhook(raw,signature){
    if(!payments)throw fail(503,'Stripe nu este conectat.');const event=payments.event(raw,signature),object=event.data?.object||{};
    if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','charge.refunded'].includes(event.type))return{received:true};
    let restaurantId,orderId;
    if(event.type==='charge.refunded'){const pi=await payments.paymentIntent(typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id);restaurantId=pi.metadata?.poftigo_restaurant;orderId=pi.metadata?.poftigo_order;}
    else{restaurantId=object.metadata?.poftigo_restaurant;orderId=object.metadata?.poftigo_order;}
    if(!ID.test(restaurantId||'')||!ID.test(orderId||''))return{received:true};
    return withLock(async()=>{
      const restaurant=(await catalog()).find(row=>row.id===restaurantId);if(!restaurant)return{received:true};
      const orders=await read(orderFile(restaurantId),[]),row=orders.find(row=>row.id===orderId);if(!row?.payment||row.payment.mode!==payments.config()?.mode)return{received:true};
      if(event.type.startsWith('checkout.')&&row.payment.sessionId&&row.payment.sessionId!==object.id)return{received:true};
      if(event.type.startsWith('checkout.')&&!row.payment.sessionId)row.payment.sessionId=object.id;
      if(event.type==='checkout.session.expired'){const session=await payments.checkoutSession(object.id);if(session.status==='expired'&&row.payment.status==='awaiting_payment'){row.payment.status='expired';row.status='declined';}}
      else if(event.type==='charge.refunded'){
        const pi=await payments.paymentIntent(typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id);
        if(pi.id===row.payment.intentId&&pi.metadata?.poftigo_order===row.id&&object.refunded===true&&object.amount_refunded===row.totalCents){row.payment.status='refunded';row.status='declined';}
      }else if(!['refunded','refund_pending'].includes(row.payment.status)&&await verifiedPayment(restaurant,row)){if(row.status==='awaiting_payment')row.status='pending';else if(row.status==='declined')await refundOrder(row);}
      await write(orderFile(restaurantId),orders);return{received:true};
    });
  }

  const bankFile = path.join(root, 'data', 'poftigo-payment-settings.json');
  async function adminBank() { return read(bankFile, null); }
  async function saveAdminBank(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Completează datele bancare.');
    const bank = bankConfiguration({ iban: body.iban, beneficiary: body.beneficiary });
    if (!bank) throw fail(400, 'Completează beneficiarul și un IBAN valid pentru încasări în EUR.');
    const bic = String(body.bic || '').replace(/\s/g, '').toUpperCase();
    if (bic && !/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic)) throw fail(400, 'Codul BIC/SWIFT trebuie să aibă 8 sau 11 caractere valide.');
    const bankName = String(body.bankName || '').trim();
    if (bankName.length > 120) throw fail(400, 'Numele băncii poate avea maximum 120 de caractere.');
    const value = { ...bank, bic, bankName, currency: 'EUR', updatedAt: new Date().toISOString() };
    return withLock(async () => { await write(bankFile, value); return value; });
  }

  async function mine(owner) { return (await catalog()).find(row => row.owner === owner) || null; }
  async function save(owner, body) {
    const value = normalizeRestaurant(body);
    return withLock(async () => {
      await assertPrincipalActive(owner);
      const rows = await catalog(), index = rows.findIndex(row => row.owner === owner), previous = rows[index];
      if (Number(body.version || 0) !== (previous?.version || 0)) throw fail(409, "Restaurantul a fost modificat în altă fereastră. Reîncarcă înainte de salvare.");
      const row = { ...value, id: previous?.id || crypto.randomBytes(12).toString("hex"), owner, version: (previous?.version || 0) + 1, updatedAt: new Date().toISOString() };
      if (index >= 0) rows[index] = row; else rows.push(row);
      await write(file, rows);
      return row;
    });
  }
  async function search(point) {
    point = coordinates(point);
    const rows = await catalog(), restaurants = [];
    for (const row of rows) {
      if (!row.acceptingOrders) continue;
      const distance = distanceKm(point, row);
      if (distance <= row.radiusKm) restaurants.push({ ...publicRestaurant(row), cardPaymentsAvailable: await paymentOption(row.owner), distanceKm: Math.round(distance * 10) / 10 });
    }
    restaurants.sort((a, b) => a.distanceKm - b.distanceKm);
    return { restaurants: restaurants.slice(0, 50), source: "Restaurante înscrise în Poftigo", coverage: "Zona de livrare este declarată de fiecare restaurant." };
  }
  async function order(id, body) {
    if (!ID.test(id)) throw fail(404, "Restaurantul nu există.");
    if (!body || typeof body !== "object") throw fail(400, "Comanda nu este validă.");
    const customer = { name: text(body.name, "numele", 120), email: text(body.email, "emailul", 254), address: text(body.address, "adresa de livrare", 300), ...coordinates(body) };
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(customer.email)) throw fail(400, "Adresa de email nu este validă.");
    if (!ID.test(body.requestId || "")) throw fail(400, "Identificatorul comenzii nu este valid.");
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw fail(400, "Alege cel puțin un preparat.");
    return withLock(async () => {
      const restaurant = (await catalog()).find(row => row.id === id);
      if (!restaurant) throw fail(404, "Restaurantul nu există.");
      await assertPrincipalActive(restaurant.owner);
      const orders = await read(orderFile(id), []);
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ customer, items: body.items, ...(body.payOnline===true?{payOnline:true}:{}) })).digest("hex");
      const previous = orders.find(row => row.requestId === body.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw fail(409, "Identificatorul aparține altei comenzi.");
        if(previous.payment)return finishCheckout(restaurant,previous,orders);
        return { received: true, id: previous.id, totalCents: previous.totalCents, currency: "EUR", status: previous.status };
      }
      if (!restaurant.acceptingOrders) throw fail(409, "Restaurantul nu primește cereri de comandă acum.");
      if (distanceKm(customer, restaurant) > restaurant.radiusKm) throw fail(409, "Adresa este în afara zonei de livrare declarate.");
      const selected = new Set();
      const items = body.items.map(item => {
        const dish = restaurant.menu.find(dish => dish.id === item.id && dish.available);
        if (!dish || selected.has(item.id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 30) throw fail(409, "Meniul sau cantitatea s-a schimbat. Verifică din nou coșul.");
        selected.add(item.id);
        return { id: dish.id, name: dish.name, quantity: item.quantity, priceCents: dish.priceCents };
      });
      const totalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
      if (body.expectedTotalCents !== totalCents) throw fail(409, "Prețurile s-au schimbat. Reîncarcă restaurantele și verifică totalul înainte de trimitere.");
      if (orders.length >= 5000) throw fail(409, "Inboxul restaurantului este plin. Contactează restaurantul.");
      const row = { id: crypto.randomBytes(12).toString("hex"), requestId: body.requestId, fingerprint, customer, items, totalCents, currency: "EUR", status: "pending", createdAt: new Date().toISOString() };
      if(body.payOnline===true){
        if(!payments||!await paymentOption(restaurant.owner))throw fail(409,'Restaurantul nu are plățile online activate.');
        const entry=await connection(restaurant.owner);row.status='awaiting_payment';row.payment={status:'awaiting_payment',mode:payments.config().mode,feeCents:Math.round(totalCents*.10),destination:entry.id};
      }
      orders.push(row);
      await write(orderFile(id), orders);
      if(row.payment)return finishCheckout(restaurant,row,orders);
      return { received: true, id: row.id, totalCents, currency: "EUR", status: row.status };
    });
  }
  async function orders(owner) {
    const restaurant = await mine(owner);
    if (!restaurant) return [];
    return (await read(orderFile(restaurant.id), [])).slice(-100).reverse().map(({ fingerprint, requestId, ...row }) => row);
  }
  async function updateOrder(owner, id, status) {
    if (!["accepted", "declined", "completed"].includes(status)) throw fail(400, "Starea comenzii nu este validă.");
    return withLock(async () => {
      await assertPrincipalActive(owner);
      const restaurant = await mine(owner);
      if (!restaurant) throw fail(404, "Restaurantul nu există.");
      const rows = await read(orderFile(restaurant.id), []), row = rows.find(row => row.id === id);
      if (!row) throw fail(404, "Comanda nu există.");
      if (row.status !== status && !(row.status === "pending" && ["accepted", "declined"].includes(status)) && !(row.status === "awaiting_payment" && status === "declined") && !(row.status === "accepted" && status === "completed") && !(row.payment?.status === "paid" && ["accepted", "completed"].includes(row.status) && status === "declined")) throw fail(409, "Tranziția comenzii nu este permisă.");
      if(row.payment){
        if(row.payment.mode!==payments?.config()?.mode)throw fail(409,'Această comandă aparține altui mod Stripe. Gestioneaz-o în modul inițial.');
        if(status==='accepted'&&row.payment.status!=='paid')throw fail(409,'Plata nu este confirmată de Stripe.');
        if(status==='declined'&&row.status!==status){
          if(row.payment.status==='awaiting_payment'){
            if(row.payment.sessionId){const session=await payments.checkoutSession(row.payment.sessionId);if(session.status==='open'){try{await payments.expireCheckout(session.id);}catch(error){if(!await verifiedPayment(restaurant,row))throw error;}}else await verifiedPayment(restaurant,row);}
            if(row.payment.status==='awaiting_payment')row.payment.status='expired';
          }
          if(row.payment.status==='paid')await refundOrder(row);
        }
      }
      row.status = status;
      await write(orderFile(restaurant.id), rows);
      return { id: row.id, status };
    });
  }
  async function assertCanRemoveOwner(owner){
    return withLock(async()=>{const restaurant=await mine(owner);if(!restaurant)return;const orders=await read(orderFile(restaurant.id),[]);if(orders.some(row=>row.payment?.mode==='live'&&!['refunded','expired'].includes(row.payment.status)))throw fail(409,'Închide sau rambursează tranzacțiile Stripe înainte de ștergerea contului.');});
  }
  async function removeOwner(owner) {
    return withLock(async () => {
      const rows = await catalog(), mine = rows.filter(row => row.owner === owner);
      for(const restaurant of mine){const orders=await read(orderFile(restaurant.id),[]);if(orders.some(row=>row.payment?.mode==='live'&&!['refunded','expired'].includes(row.payment.status)))throw fail(409,'Contul are tranzacții Stripe de închis. Contactează administratorul înainte de ștergere.');}
      await write(file, rows.filter(row => row.owner !== owner));
      for (const row of mine) await filesystem().promises.unlink(orderFile(row.id)).catch(error => { if (error.code !== "ENOENT") throw error; });
    });
  }
  let lastNominatim = 0, pendingNominatim = 0, nominatimQueue = Promise.resolve();
  async function nominatim(url) {
    if (pendingNominatim >= 4) throw fail(429, "Căutarea este ocupată. Încearcă din nou în câteva secunde.");
    pendingNominatim++;
    const operation = nominatimQueue.catch(() => {}).then(async () => {
      const wait = 1100 - (Date.now() - lastNominatim);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      lastNominatim = Date.now();
      let response;
      try { response = await fetchImpl(url, { headers: { "User-Agent": "Poftigo/2.7.7 (https://www.nova-ai-studio.eu/about)", "Accept": "application/json" }, signal: AbortSignal.timeout(10000) }); }
      catch { throw fail(503, "Serviciul OpenStreetMap este indisponibil temporar. Încearcă din nou."); }
      if (!response.ok) throw fail(503, "Serviciul OpenStreetMap este indisponibil temporar. Încearcă din nou.");
      let data;
      try { data = await response.json(); } catch { throw fail(503, "Serviciul OpenStreetMap a returnat un răspuns invalid."); }
      if (!Array.isArray(data)) throw fail(503, "Serviciul OpenStreetMap a returnat un răspuns invalid.");
      return data;
    });
    nominatimQueue = operation;
    try { return await operation; } finally { pendingNominatim--; }
  }
  const nearbyCache = new Map(), nearbyInFlight = new Map();
  const normalizeQuery = normalizeFoodText;
  const interpretQuery = createFoodInterpreter({ translate: translateQuery });
  function matchesFood(value, query) { return !query.query || (query.match ? query.match.test(normalizeQuery(value)) : normalizeQuery(value).includes(query.query)); }
  function publicLink(value) {
    try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch {}
    return '';
  }
  async function nearby(point, query) {
    const center = { lat: Number(point.lat.toFixed(4)), lon: Number(point.lon.toFixed(4)) };
    const key = center.lat + ':' + center.lon + ':' + query.lookup;
    const cached = nearbyCache.get(key);
    if (cached && Date.now() - cached.at < 15 * 60000) return cached.rows;
    if (nearbyInFlight.has(key)) return nearbyInFlight.get(key);
    const operation = (async () => {
      const latDelta = 5.2 / 111.2, lonDelta = 5.2 / (111.2 * Math.max(.01, Math.cos(center.lat * Math.PI / 180)));
      const box = [Math.max(-180, center.lon - lonDelta), Math.min(90, center.lat + latDelta), Math.min(180, center.lon + lonDelta), Math.max(-90, center.lat - latDelta)].join(',');
      const url = new URL(nominatimEndpoint);
      url.search = new URLSearchParams({ q: query.lookup, format: 'jsonv2', limit: '30', extratags: '1', addressdetails: '1', bounded: '1', viewbox: box }).toString();
      const data = await nominatim(url), rows = [], seen = new Set();
      for (const item of data) {
        if (!item || !['restaurant', 'fast_food', 'cafe', 'food_court', 'pub', 'bar', 'biergarten'].includes(item.type) || !['node', 'way', 'relation'].includes(item.osm_type) || !Number.isSafeInteger(Number(item.osm_id)) || !item.name) continue;
        let location; try { location = coordinates(item); } catch { continue; }
        const tags = item.extratags || {}, cuisine = String(tags.cuisine || '');
        if (!matchesFood(item.name + ' ' + cuisine + ' ' + (tags.brand || ''), query)) continue;
        const id = 'osm-' + item.osm_type + '-' + item.osm_id;
        if (seen.has(id)) continue; seen.add(id);
        const address = item.address || {};
        const website = publicLink(tags.website || tags['contact:website']);
        const menuUrl = publicLink(tags['website:menu'] || tags['contact:menu'] || tags.menu);
        const photoUrl = publicLink(tags.image);
        rows.push({ id, name: String(item.name).slice(0, 200), ...location, address: [address.road, address.house_number, address.city || address.town || address.village].filter(Boolean).join(', ') || String(item.display_name || '').slice(0, 400), cuisine, photo: photoUrl.startsWith('https:') ? photoUrl : '', menu: [], orderable: false, source: 'OpenStreetMap', website, menuUrl, mapUrl: 'https://www.openstreetmap.org/' + item.osm_type + '/' + item.osm_id });
      }
      if (nearbyCache.size >= 500) nearbyCache.delete(nearbyCache.keys().next().value);
      nearbyCache.set(key, { rows, at: Date.now() });
      return rows;
    })();
    nearbyInFlight.set(key, operation);
    try { return await operation; } finally { nearbyInFlight.delete(key); }
  }
  async function discover(input) {
    const point = coordinates(input), query = await interpretQuery(input.q);
    const local = (await search(point)).restaurants.filter(row => matchesFood(row.name + ' ' + row.menu.map(item => item.name + ' ' + item.description).join(' '), query)).map(row => ({ ...row, orderable: true, source: 'Nova' }));
    let external, warning = query.warning || '';
    try { external = await nearby(point, query); }
    catch (error) {
      if (!local.length) throw error;
      external = []; warning = [warning, 'Căutarea pe hartă este indisponibilă temporar. Afișăm doar rezultatele înscrise în Poftigo.'].filter(Boolean).join(' ');
    }
    const restaurants = [...local];
    for (const row of external) {
      const distance = distanceKm(point, row);
      if (distance > 5 || local.some(local => normalizeQuery(local.name) === normalizeQuery(row.name) && distanceKm(local, row) < .2)) continue;
      restaurants.push({ ...row, distanceKm: Math.round(distance * 10) / 10 });
    }
    restaurants.sort((a, b) => a.distanceKm - b.distanceKm);
    return { restaurants: restaurants.slice(0, 50), query: query.query, interpretation: { original: query.original, term: query.interpreted, translated: query.translated }, radiusKm: 5, warning, source: 'Poftigo și OpenStreetMap', attribution: '© OpenStreetMap contributors', coverage: 'Rezultatele de pe hartă nu confirmă livrarea, meniurile sau prețurile.' };
  }
  const geocodes = new Map();
  async function geocode(query) {
    query = text(query, "adresa de căutat", 240);
    if (query.length < 4) throw fail(400, "Introdu strada, numărul și localitatea.");
    const cached = geocodes.get(query);
    if (cached && Date.now() - cached.at < 3600000) return cached.value;
    const url = new URL(nominatimEndpoint);
    url.search = new URLSearchParams({ q: query, format: "jsonv2", limit: "5" }).toString();
    const data = await nominatim(url);
    const value = { results: data.slice(0, 5).filter(row => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon)) && typeof row.display_name === "string").map(row => ({ ...coordinates(row), label: row.display_name.slice(0, 500) })), attribution: "© OpenStreetMap contributors" };
    if (geocodes.size >= 500) geocodes.delete(geocodes.keys().next().value);
    geocodes.set(query, { at: Date.now(), value });
    return value;
  }
  return { mine, save, search, order, orders, updateOrder, removeOwner, geocode, discover, adminBank, saveAdminBank, connectStatus, connect, webhook, assertCanRemoveOwner };
}
module.exports = { createRestaurantService, normalizeRestaurant, distanceKm, isRestaurantMarketplaceIdea };
