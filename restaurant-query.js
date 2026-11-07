"use strict";

const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const groups = [
  ['restaurants', '[amenity=restaurant]', /restaurant/, ['restaurant','restaurants','restaurante','restaurantes','ristoranti','restaurantele','рестораны','ресторани','مطاعم','رستوران','מסעדות','レストラン','餐厅','餐廳','식당','रेस्तरां']],
  ['pizza', 'pizzeria', /pizza|pizzer/, ['pizza','pizze','pizzeria','pizzerie','pizzerii','pizzas','piza','пицца','піца','пица','πίτσα','بيتزا','پیتزا','פיצה','ピザ','ピッツァ','披萨','披薩','比萨','피자','पिज़्ज़ा','पिज्जा','พิซซ่า']],
  ['burger', 'burger', /burger|hamburg/, ['burger','burgers','hamburger','hamburgeri','hamburguesa','hamburguesas','hambúrguer','hamburguer','гамбургер','бургер','برغر','برجر','همبرگر','המבורגר','ハンバーガー','汉堡','漢堡','햄버거','बर्गर','เบอร์เกอร์']],
  ['sushi', 'sushi', /sushi|susi|寿司|壽司|суши|суші|سوشي|초밥/, ['sushi','susi','suşi','суши','суші','суші','سوشي','سوشی','סושי','寿司','壽司','すし','スシ','초밥','스시','सुशी']],
  ['kebab', 'kebab', /kebab|doner|döner|shawarma|shaorma/, ['kebab','kebap','döner','doner','shawarma','shaorma','шаурма','кебаб','شاورما','كباب','کباب','שווארמה','ケバブ','烤肉串','케밥']],
  ['pasta', 'pasta', /pasta|pates|pâtes|spaghett|macaron|noodle/, ['pasta','paste','paste italienesti','pâtes','pates','spaghetti','nudeln','макароны','паста','معكرونة','مكرونة','پاستا','פסטה','パスタ','意大利面','義大利麵','파스타','पास्ता']],
  ['coffee', 'cafe', /coffee|cafe|café|kaffee|espresso/, ['coffee','cafe','café','cafea','kaffee','caffè','caffe','café','кофе','кава','قهوة','قهوه','קפה','コーヒー','咖啡','커피','कॉफी']],
];
const aliases = new Map();
for (const [term, lookup, baseMatch, names] of groups) {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(baseMatch.source + '|' + names.map(name => escape(normalize(name))).join('|'), 'u');
  for (const name of names) aliases.set(normalize(name), { term, lookup, match });
}
function food(term) { return aliases.get(normalize(term)); }
const fail = (status, message) => Object.assign(new Error(message), { status });
function createFoodInterpreter({ translate, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  let minute = 0, used = 0;
  function descriptor(original, term, kind, warning = '') {
    if (kind === 'restaurant' && original) term = original;
    const known = kind === 'food' && food(term);
    return { original, query: known?.term === 'restaurants' ? '' : normalize(known ? known.term : term), lookup: known ? known.lookup : term, match: known ? known.match : null, kind, interpreted: known ? known.term : term, translated: normalize(original) !== normalize(known ? known.term : term), warning };
  }
  return async value => {
    if (typeof value !== 'string' && value != null) throw fail(400, 'Căutarea trebuie să fie text.');
    const original = String(value || '').trim();
    if ([...original].length > 80 || /[\u0000-\u001f\u007f]/.test(original)) throw fail(400, 'Caută un preparat sau restaurant folosind maximum 80 de caractere.');
    if (!original) return { original: '', query: '', lookup: '[amenity=restaurant]', match: null, kind: 'restaurant', interpreted: '', translated: false, warning: '' };
    const known = food(original);
    if (known) return descriptor(original, known.term, 'food');
    const key = normalize(original), cached = cache.get(key);
    if (cached && now() - cached.at < 86400000) return descriptor(original, cached.term, cached.kind);
    const fallback = () => descriptor(original, original, 'restaurant', 'Traducerea automată nu este disponibilă momentan. Căutăm textul introdus; poți încerca un termen precum pizza.');
    if (!translate) return descriptor(original, original, 'restaurant');
    if (!pending.has(key)) {
      if (Math.floor(now() / 60000) !== minute) { minute = Math.floor(now() / 60000); used = 0; }
      if (used >= 12 || pending.size >= 4) return fallback();
      used++;
      const task = (async () => {
        const result = await translate(original);
        if (!result || !['food', 'restaurant'].includes(result.kind) || typeof result.term !== 'string') throw fail(503, 'Răspuns de traducere invalid.');
        const term = result.term.trim();
        if (!term || [...term].length > 80 || !/^[\p{L}\p{N}\p{M}\s'’"&().-]+$/u.test(term)) throw fail(503, 'Termen de căutare invalid.');
        // Restaurant and chain names are identifiers, not text to translate.
        const entry = { term: result.kind === 'restaurant' ? original : term, kind: result.kind, at: now() };
        if (cache.size >= 500) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
        return entry;
      })();
      pending.set(key, task);
    }
    try { const result = await pending.get(key); return descriptor(original, result.term, result.kind); }
    catch { return fallback(); }
    finally { pending.delete(key); }
  };
}
module.exports = { createFoodInterpreter, normalize };
