const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function element() {
  return { children: [], value: '', disabled: false, style: {},
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  };
}

function setup() {
  const nodes = Object.fromEntries(['prompt', 'sendBtn', 'generateImageBtn', 'messages'].map(id => [id, element()]));
  nodes.prompt.value = 'Un peisaj la apus';
  const stored = new Map(), notices = [], requests = [];
  let context;
  context = vm.createContext({
    URL, state: { project: 'first', chat: [], busy: false }, activeMessageStream: null,
    el: id => nodes[id], document: { createElement: element },
    available: true, routeSupports: () => context.available,
    setView() {}, resizePrompt() {}, updateHomeHistory() {},
    updateCapabilityControls: () => { nodes.generateImageBtn.disabled = !context.available; },
    chatKey: () => 'chat-' + context.state.project,
    writeLocalCache: (key, value) => stored.set(key, value),
    messageContainer: () => context.activeMessageStream || nodes.messages,
    addBubble: (role, content) => { const node = element(); node.role = role; node.textContent = content; nodes.messages.append(node); },
    toast: message => notices.push(message), jsonBody: value => value,
    mediaMetadata: label => label, safeMediaName: () => 'image.png',
    respond: async () => ({dataUrl: 'data:image/png;base64,aW1hZ2U=', model: 'saved-image-model', provider: 'custom'}),
    api: async (route, body) => { requests.push({route, body}); return context.respond(); }
  });
  for (const [start, end] of [
    ['function safeImageResultUrl(', 'function selectedSpeechOptions('],
    ['function addImageCard(', 'let imageEditPreviewUrl'],
    ['function renderChat()', 'function messageContainer()']
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  return {context, nodes, stored, notices, requests};
}

test('image generation saves the real result and renders it when reopening the conversation', async () => {
  const {context, nodes, stored, requests} = setup();
  await context.generateImageFromPrompt();
  assert.equal(requests.length, 1);
  const history = JSON.parse(stored.get('chat-first'));
  assert.equal(history.length, 2);
  assert.equal(history[1].media.result.model, 'saved-image-model');
  context.state.chat = history;
  context.renderChat();
  const imageCard = nodes.messages.children[0].children.at(-1);
  assert.equal(imageCard.children[2].src, history[1].media.result.dataUrl);
  assert.equal(imageCard.children[3].download, 'image.png');
  assert.equal(context.state.busy, false);
  assert.equal(nodes.sendBtn.disabled, false);
});

test('missing image configuration explains the problem and preserves the draft', async () => {
  const {context, nodes, notices, requests} = setup();
  context.available = false;
  await context.generateImageFromPrompt();
  assert.equal(requests.length, 0);
  assert.match(notices[0], /model de imagini/);
  assert.equal(nodes.prompt.value, 'Un peisaj la apus');
});

test('image requests are serialized and a late result remains in its original conversation', async () => {
  const {context, stored, requests} = setup();
  let complete;
  context.respond = () => new Promise(resolve => {complete = resolve;});
  const pending = context.generateImageFromPrompt();
  await context.generateImageFromPrompt();
  assert.equal(requests.length, 1);
  context.state.project = 'second';
  context.state.chat = [];
  complete({dataUrl: 'data:image/png;base64,aW1hZ2U=', model: 'saved-model'});
  await pending;
  assert.equal(context.state.chat.length, 0);
  assert.equal(stored.has('chat-second'), false);
  assert.equal(JSON.parse(stored.get('chat-first'))[1].media.result.model, 'saved-model');
});

test('failed generation restores the draft and leaves no fabricated image in history', async () => {
  const {context, nodes, stored} = setup();
  context.respond = async () => {throw new Error('Provider unavailable');};
  await context.generateImageFromPrompt();
  assert.equal(nodes.prompt.value, 'Un peisaj la apus');
  assert.equal(context.state.chat.length, 0);
  assert.equal(stored.size, 0);
  assert.equal(nodes.messages.children.at(-1).textContent, 'Provider unavailable');
  assert.equal(context.state.busy, false);
});
