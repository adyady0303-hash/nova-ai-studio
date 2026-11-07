const test=require('node:test');const assert=require('node:assert/strict');const {createFoodInterpreter}=require('../restaurant-query');
test('common food words in different scripts map to the same cuisine without calling AI',async()=>{
 let calls=0;const interpret=createFoodInterpreter({translate:async()=>{calls++;throw new Error('Should not be used');}});
 for(const query of ['pizza','ПИЦЦА','піца','πίτσα','بيتزا','پیتزا','פיצה','ピザ','披萨','피자','पिज्जा','พิซซ่า'])assert.equal((await interpret(query)).lookup,'pizzeria',query);
 for(const query of ['hamburguesa','бургер','برغر','汉堡','햄버거'])assert.equal((await interpret(query)).lookup,'burger',query);
 for(const query of ['寿司','суши','سوشي','초밥'])assert.equal((await interpret(query)).lookup,'sushi',query);
 assert.ok((await interpret('pizza')).match.test('披萨 margherita'));
 assert.equal((await interpret('')).query,'');assert.equal((await interpret('')).translated,false);
 assert.equal((await interpret('مطاعم')).lookup,'[amenity=restaurant]');assert.equal((await interpret('مطاعم')).query,'');assert.equal(calls,0);
});
test('free-form multilingual requests use only search text, coalesce requests and cache interpretation',async()=>{
 const calls=[];const interpret=createFoodInterpreter({translate:async query=>{calls.push(query);return {kind:'food',term:'pizza'};}});
 const original='Ningependa kupata pizza karibu nami';
 const [one,two]=await Promise.all([interpret(original),interpret(original)]);assert.equal(one.lookup,'pizzeria');assert.deepEqual(one,two);assert.equal(calls.length,1);assert.equal(calls[0],original);assert.equal(one.translated,true);
 await interpret(original);assert.equal(calls.length,1);
});
test('restaurant identifiers survive translation and an invalid response has an honest literal fallback',async()=>{
 const brand=createFoodInterpreter({translate:async()=>({kind:'restaurant',term:'Changed brand'})});
 assert.equal((await brand('Pizza Hut')).lookup,'Pizza Hut');
 const invalid=createFoodInterpreter({translate:async()=>({kind:'food',term:'<script>alert(1)</script>'})});
 const fallback=await invalid('Je voudrais une pizza près de moi');assert.match(fallback.warning,/Traducerea/);assert.equal(fallback.lookup,'Je voudrais une pizza près de moi');
 await assert.rejects(()=>brand('a'.repeat(81)),{status:400});
});
test('public AI interpretation has a global per-minute bound and renews without blocking known aliases',async()=>{
 let time=120000,calls=0;const interpret=createFoodInterpreter({now:()=>time,translate:async query=>{calls++;return {kind:'restaurant',term:query};}});
 for(let n=0;n<12;n++)await interpret('Restaurant '+n);
 assert.match((await interpret('Another restaurant')).warning,/Traducerea/);assert.equal(calls,12);
 assert.equal((await interpret('بيتزا')).lookup,'pizzeria');assert.equal(calls,12);
 time+=60000;await interpret('Another restaurant');assert.equal(calls,13);
});
