const test=require('node:test');
const assert=require('node:assert/strict');
const {businessProjectName,validateBusinessFiles,addBusinessContact,contactScript,normalizeBusinessContact}=require('../business-site');
const html='<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><h1>Servicii</h1><script src="./app.js"></script></body></html>';

test('business publication validates real files and parses scripts without executing generated code',()=>{
  const files={'index.html':html,'styles.css':'body{color:blue}','app.js':'globalThis.__businessScriptExecuted=true;'};
  assert.deepEqual(validateBusinessFiles(files),[]);assert.equal(globalThis.__businessScriptExecuted,undefined);
  assert.ok(validateBusinessFiles({...files,'app.js':'const broken = ;'}).some(issue=>issue.includes('JavaScript invalid')));
  assert.ok(validateBusinessFiles({...files,'app.js':'import x from "some-package";'}).length);
  assert.ok(validateBusinessFiles({...files,'index.html':html.replace('./app.js','/app.js')}).length);
  assert.ok(validateBusinessFiles({...files,'styles.css':''}).length);
  assert.ok(businessProjectName('x'.repeat(500)).length<=80);
});

test('contact installation supplies working fields, repairs incomplete forms and remains idempotent',()=>{
  for(const source of [html,html.replace('<h1>Servicii</h1>','<form data-nova-contact><input name="email"></form>')]){
    const installed=addBusinessContact(source);
    for(const name of ['name','email','message'])assert.match(installed,new RegExp('name="'+name+'"'));
    assert.equal((installed.match(/src="\.\/nova-contact\.js"/g)||[]).length,1);
    assert.equal(addBusinessContact(installed),installed);
  }
  assert.doesNotThrow(()=>new(require('node:vm').Script)(contactScript));
});

test('public customer requests validate contact data and discard unrelated submitted fields',()=>{
  assert.deepEqual(normalizeBusinessContact({name:' Client ',email:'test@example.com',message:' Mesaj ',principal:'owner',project:'forged'}),{name:'Client',email:'test@example.com',message:'Mesaj'});
  for(const body of [null,{name:'x',email:'invalid',message:'test'},{name:'x',email:'a@example.com',message:'x'.repeat(4001)}])assert.throws(()=>normalizeBusinessContact(body),e=>e.status===400);
});

test('nearby restaurant request rejects the published timer-only search instead of accepting three valid files',()=>{
  const files = {
    'index.html': html.replace('<h1>Servicii</h1>', '<input id="address-input"><div id="restaurants-list"></div><p>Total: €0.00</p>'),
    'styles.css': 'body{color:blue}',
    'app.js': `// In reality we would use fetch('/restaurants') and navigator.geolocation.getCurrentPosition here.
      const list = document.getElementById('restaurants-list');
      setTimeout(() => { list.innerHTML = '<p>Nu s-au găsit restaurante.</p>'; }, 1500);`
  };
  const issues = validateBusinessFiles(files, {idea:'Restaurante din apropierea locației clientului, poze, meniuri și prețuri în euro'});
  assert.ok(issues.some(issue => issue.includes('sursă de date')));
  assert.ok(issues.some(issue => issue.includes('localizarea')));
  assert.ok(issues.some(issue => issue.includes('fotografiilor')));
  assert.ok(issues.some(issue => issue.includes('meniurilor')));
  assert.ok(!issues.some(issue => issue.includes('adresei de livrare')));
});

test('restaurant requirements follow the idea and leave ordinary business pages unaffected',()=>{
  const files = {'index.html':html,'styles.css':'body{}','app.js':'window.ready=true;'};
  assert.deepEqual(validateBusinessFiles(files, {idea:'Un restaurant local cu formular de contact'}), []);
  const issues = validateBusinessFiles(files, {idea:'Restaurante care livrează la adresa clientului cu prețuri în euro'});
  for (const text of ['sursă de date','localizarea','adresei de livrare','euro']) assert.ok(issues.some(issue => issue.includes(text)),text);
});

test('source checks accept location and data-request wiring without claiming a provider was tested',()=>{
  const files = {
    'index.html':html.replace('<h1>Servicii</h1>', '<input autocomplete="street-address"><img alt="Preparat"><div id="menu"></div><p>EUR</p>'),
    'styles.css':'body{}',
    'app.js':`async function search(address) {
      const response = await fetch('/restaurant-source?address=' + encodeURIComponent(address));
      if (!response.ok) throw new Error('Serviciu indisponibil');
      return response.json();
    }
    function locate(success, failure) { navigator.geolocation.getCurrentPosition(success, failure); }`
  };
  assert.deepEqual(validateBusinessFiles(files,{idea:'Restaurante din apropiere cu poze, meniuri și prețuri în euro'}),[]);
});
