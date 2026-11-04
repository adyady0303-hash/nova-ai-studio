const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function storageContext({ task = 'text', failAt = 1, failReads = false } = {}) {
  const nodes = new Map();
  function el(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', disabled: false, checked: false, children: [],
      append(child) { this.children.push(child); }, focus() {},
      addEventListener(name, callback) { this[name] = callback; }
    });
    return nodes.get(id);
  }
  el('prompt').value = 'Un text nou și complet.';
  el('modelSelect').value = 'fixture-model';
  el('taskSelect').value = task;
  el('modeSelect').value = 'build';
  const initial = [{ role: 'user', content: 'Anterior' }, { role: 'assistant', content: 'Răspuns anterior' }];
  const persisted = new Map([['nova-chat-first', JSON.stringify(initial)], ['other-setting', 'keep']]);
  const bubbles = [], notices = [], requests = [];
  let writes = 0, context;
  const globals = {
    state: { project: 'first', projects: [{ id: 'first', name: 'Primul' }],
      chat: plain(initial), account: { role: 'owner' }, activePath: null,
      files: [], busy: false, dirty: false },
    el, document: { createElement: () => ({ remove() {} }) },
    localStorage: {
      setItem(key, value) {
        if (++writes >= failAt) throw Object.assign(new Error('Storage is full'), { name: 'QuotaExceededError' });
        persisted.set(key, value);
      },
      getItem(key) {
        if (failReads) throw Object.assign(new Error('Storage is blocked'), { name: 'SecurityError' });
        return persisted.get(key) ?? null;
      }
    },
    storageKey: key => key, activeKey: () => `nova-active-${context.state.project}`,
    chatKey: () => `nova-chat-${context.state.project}`,
    messageContainer: () => el('messages'), jsonBody: value => value,
    toast: message => notices.push(message), setView() {}, setTask() {}, resizePrompt() {},
    setProjectsOpen() {}, renderProjects() {}, renderHomeProjects() {}, renderFiles() {},
    renderChat() {}, updateLines() {}, refreshPublication: async () => {},
    saveFile: async () => {}, refreshFiles: async () => {},
    speakNextAssistant: false,
    addBubble(role, content) {
      const bubble = { role, content, removed: false, remove() { this.removed = true; } };
      bubbles.push(bubble);
      return bubble;
    },
    respond: async () => ({ content: 'Résultat complet, conservé.', events: [] }),
    api: async (route, body) => {
      requests.push({ route, body: body && plain(body) });
      if (route.startsWith('/api/files?')) return { files: [] };
      if (route.startsWith('/api/file?')) return { content: 'Contenu complet' };
      if (route === '/api/projects') return { project: { id: 'second', name: body.name } };
      return context.respond(route, body);
    }
  };
  context = vm.createContext(globals);
  for (const [start, end] of [
    ['function looksLikeCvCreationRequest(', 'function openCvBuilder('],
    ['async function openFile(', 'function looksLikeCvCreationRequest('],
    ['async function send()', 'el("editor").addEventListener'],
    ['el("clearChat").addEventListener', 'el("newChatTop").addEventListener']
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  return { context, el, persisted, bubbles, notices, requests, initial };
}

test('full browser storage does not block administrator chat or code creation and keeps old saved data', async t => {
  for (const task of ['text', 'code']) {
    await t.test(task, async () => {
      const { context, el, persisted, notices, requests, initial } = storageContext({ task });
      await context.send();
      assert.equal(requests[0].route, task === 'code' ? '/api/agent' : '/api/chat');
      assert.equal(context.state.chat.length, initial.length + 2);
      assert.equal(context.state.chat.at(-1).content, 'Résultat complet, conservé.');
      assert.deepEqual(JSON.parse(context.readLocalCache('nova-chat-first')), plain(context.state.chat));
      assert.deepEqual(JSON.parse(persisted.get('nova-chat-first')), initial);
      assert.equal(persisted.get('other-setting'), 'keep');
      assert.equal(context.state.busy, false);
      assert.equal(el('sendBtn').disabled, false);
      assert.equal(notices.length, 1, 'one storage notice per page');
      el('prompt').value = 'Continuă scrierea.';
      await context.send();
      assert.equal(requests.length, 2);
      assert.equal(notices.length, 1);
    });
  }
});

test('storage filling after a successful response preserves the reply when switching projects', async () => {
  const { context, persisted, bubbles, initial } = storageContext({ failAt: 2 });
  await context.send();
  assert.equal(JSON.parse(persisted.get('nova-chat-first')).length, initial.length + 1);
  assert.equal(bubbles.filter(bubble => bubble.role === 'assistant').length, 1);
  assert.equal(bubbles.at(-1).content, 'Résultat complet, conservé.');
  await context.loadProject('second');
  assert.equal(context.state.chat.length, 0);
  await context.loadProject('first');
  assert.equal(context.state.chat.length, initial.length + 2);
  assert.equal(context.state.chat.at(-1).content, 'Résultat complet, conservé.');
});

test('provider failure with full storage still restores the draft and permits a clean retry', async () => {
  const { context, el, initial, requests, bubbles } = storageContext();
  const draft = el('prompt').value;
  context.respond = async () => { throw new Error('Furnizor indisponibil'); };
  await context.send();
  assert.equal(el('prompt').value, draft);
  assert.deepEqual(plain(context.state.chat), initial);
  assert.deepEqual(JSON.parse(context.readLocalCache('nova-chat-first')), initial);
  assert.equal(bubbles.find(bubble => bubble.role === 'user').removed, true);
  context.respond = async () => ({ content: 'Răspuns după reîncercare' });
  await context.send();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.messages, requests[1].body.messages);
  assert.equal(context.state.chat.length, initial.length + 2);
});

test('project creation and file selection continue when browser storage is full or blocked', async () => {
  const { context, el, persisted } = storageContext({ failReads: true });
  assert.equal(await context.saveNewProject('Un proiect nou'), true);
  assert.equal(context.state.project, 'second');
  assert.equal(context.readLocalCache('nova-project'), 'second');
  await context.openFile('app.js');
  assert.equal(context.state.activePath, 'app.js');
  assert.equal(el('editor').value, 'Contenu complet');
  assert.equal(context.readLocalCache('nova-active-second'), 'app.js');
  assert.equal(persisted.get('other-setting'), 'keep');
});

test('starting a new conversation does not throw or resurrect old history in the current page', async () => {
  const { context, el, persisted, initial } = storageContext();
  el('clearChat').click();
  assert.equal(context.state.chat.length, 0);
  await context.loadProject('first');
  assert.equal(context.state.chat.length, 0);
  assert.deepEqual(JSON.parse(persisted.get('nova-chat-first')), initial);
});
