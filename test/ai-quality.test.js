const test = require('node:test');
const assert = require('node:assert/strict');
const { accuracyPrompt, collectSources, answerWithSources, speechOptions } = require('../ai-quality');

test('accuracy instructions use the actual supplied date and require evidence for changing facts', () => {
  const prompt = accuracyPrompt(new Date('2026-10-20T08:00:00Z'));
  assert.match(prompt, /2026-10-20/);
  assert.match(prompt, /surse oficiale/);
  assert.match(prompt, /Nu inventa/);
});

test('source footer contains only collected valid public-web results, deduplicated', () => {
  const sources = [];
  for (const result of ['null', 'invalid', JSON.stringify({ sources: [null, { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com/' }, { title: 'Official', url: 'https://example.com/' }] }), JSON.stringify({ url: 'https://example.com/', text: 'Read page' })]) collectSources(result, sources);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://example.com/');
  assert.match(answerWithSources('Answer', sources, true), /Surse consultate:\nOfficial: https:\/\/example.com\//);
});

test('required verification cannot return an unsupported model claim as verified information', () => {
  const answer = answerWithSources('Unverified claim: price is 999 EUR', [], true);
  assert.doesNotMatch(answer, /999/);
  assert.match(answer, /nu pot fi confirmate/);
  assert.equal(answerWithSources('Ordinary chat', [], false), 'Ordinary chat');
});

test('per-request voice and pace are validated without modifying server defaults', () => {
  assert.deepEqual(speechOptions({ voice: 'coral', speed: 0.85 }), { voice: 'coral', speed: 0.85 });
  assert.deepEqual(speechOptions({}), {});
  for (const body of [{ voice: 'not-a-voice' }, { speed: '1' }, { speed: 8 }, { speed: null }]) assert.throws(() => speechOptions(body), { status: 400 });
});

const { automaticWebSearch, needsWebRetry } = require('../ai-quality');
test('automatic search uses the latest public freshness question without forcing creative writing', () => {
  assert.equal(automaticWebSearch([{role:'user',content:'Care sunt ultimele versiuni Node?'}]), true);
  assert.equal(automaticWebSearch([{role:'user',content:'Știri azi din România'}]), true);
  assert.equal(automaticWebSearch([{role:'user',content:'Scrie versuri despre azi'}]), false);
  assert.equal(automaticWebSearch([{role:'user',content:'Știri azi'}, {role:'assistant',content:'OK'}, {role:'user',content:'Salut'}]), false);
});
test('missing knowledge triggers a search retry but ordinary answers and technical errors do not', () => {
  for (const answer of ['Nu am informații despre acest subiect.', 'Nu pot confirma această informație.', 'I cannot verify that information.']) assert.equal(needsWebRetry(answer), true);
  for (const answer of ['Salut! Cu ce te ajut?', 'Eroare API: cheia este invalidă.', 'Nu pot modifica fișierele.']) assert.equal(needsWebRetry(answer), false);
});
