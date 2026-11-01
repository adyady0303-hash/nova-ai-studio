const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const functions = source.slice(source.indexOf('function updateVoiceChatButtons('), source.indexOf('function iconFor('));

test('voice chat transcribes Romanian speech, submits it and restores button state', () => {
  const classes = new Set();
  const attributes = new Map();
  const nodes = {
    prompt: { value: '', style: {} },
    homePrompt: { value: '' },
    voiceChatBtn: {
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
      setAttribute(name, value) { attributes.set(name, value); }, title: ''
    },
    homeVoiceChatBtn: {
      classList: { toggle() {} }, setAttribute() {}, title: ''
    }
  };
  let recognition;
  class Recognition {
    constructor() { recognition = this; }
    start() { this.onstart(); }
    stop() { this.onend(); }
  }
  let sent = 0;
  const context = vm.createContext({
    window: { SpeechRecognition: Recognition },
    state: { busy: false },
    el: id => nodes[id],
    toast() {}, resizePrompt() {}, setView() {},
    looksLikeCvCreationRequest: () => false,
    send: () => { sent++; }
  });
  vm.runInContext(`let voiceRecognition = null, speakNextAssistant = false; ${functions}`, context);
  context.startVoiceChat('prompt');
  assert.equal(recognition.lang, 'ro-RO');
  assert.equal(recognition.interimResults, true);
  assert.equal(classes.has('listening'), true);
  recognition.onresult({ results: [Object.assign([{ transcript: 'Salut Nova' }], { isFinal: true })] });
  recognition.onend();
  assert.equal(nodes.prompt.value, 'Salut Nova');
  assert.equal(sent, 1);
  assert.equal(classes.has('listening'), false);
  assert.equal(attributes.get('aria-pressed'), 'false');
});

test('voice chat reports browsers without speech recognition', () => {
  let notice = '';
  const context = vm.createContext({
    window: {}, state: { busy: false }, el: () => null,
    toast: value => { notice = value; }, resizePrompt() {}, setView() {},
    looksLikeCvCreationRequest: () => false, send() {}
  });
  vm.runInContext(`let voiceRecognition = null, speakNextAssistant = false; ${functions}`, context);
  context.startVoiceChat('prompt');
  assert.match(notice, /nu este disponibilă/i);
});
