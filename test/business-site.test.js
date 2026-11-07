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
