const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function voiceContext(supported = true) {
  const spoken = [], notices = [], controls = [], requests = [];
  let cancelled = 0;
  const synthesis = { cancel() { cancelled++; }, getVoices: () => [{ lang: 'ro-RO' }], speak: item => spoken.push(item) };
  const context = vm.createContext({
    window: supported ? { speechSynthesis: synthesis } : {},
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: supported ? class { constructor(text) { this.text = text; } } : undefined,
    toast: text => notices.push(text),
    api: (...args) => { requests.push(args); throw new Error('Free reading must not use an API'); },
    document: { createElement: () => ({ hidden: false, addEventListener(name, fn) { this[name] = fn; } }) }
  });
  for (const [start, end] of [
    ['function speakChatReply(', 'function startVoiceChat('],
    ['function addBrowserSpeechButton(', 'async function saveFile(']
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  return { context, synthesis, spoken, notices, controls, requests,
    row: { append: (...items) => controls.push(...items) }, cancelled: () => cancelled };
}

test('browser reading speaks the full response for free and can be stopped', () => {
  const fixture = voiceContext();
  const text = 'Un răspuns complet. '.repeat(800);
  fixture.context.addBrowserSpeechButton(fixture.row, text);
  assert.equal(fixture.controls[0].textContent, 'Ascultă în browser');
  assert.equal(fixture.controls[1].hidden, true);
  fixture.controls[0].click();
  assert.equal(fixture.spoken.length, 1);
  assert.equal(fixture.spoken[0].text, text.trim());
  assert.equal(fixture.spoken[0].lang, 'ro-RO');
  assert.equal(fixture.controls[1].hidden, false);
  fixture.controls[1].click();
  assert.equal(fixture.cancelled(), 2);
  assert.equal(fixture.controls[1].hidden, true);
  assert.equal(fixture.requests.length, 0);
});

test('unavailable browser speech gives a clear explanation without calling a provider', () => {
  const fixture = voiceContext(false);
  fixture.context.addBrowserSpeechButton(fixture.row, 'Salut!');
  fixture.controls[0].click();
  assert.match(fixture.notices[0], /nu este disponibilă/);
  assert.equal(fixture.controls[1].hidden, true);
  assert.equal(fixture.requests.length, 0);
});

test('browser speech errors leave the response available and do not call a paid API', () => {
  const fixture = voiceContext();
  fixture.synthesis.speak = () => { throw new Error('Speech unavailable'); };
  fixture.context.addBrowserSpeechButton(fixture.row, 'Salut!');
  assert.doesNotThrow(() => fixture.controls[0].click());
  assert.match(fixture.notices[0], /nu a putut porni/);
  assert.equal(fixture.controls[1].hidden, true);
  assert.equal(fixture.requests.length, 0);
});
