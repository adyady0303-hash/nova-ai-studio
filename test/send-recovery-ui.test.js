const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function element() {
  return {
    children: [], value: '', disabled: false, checked: false,
    append(...children) {
      for (const child of children) { child.parent = this; this.children.push(child); }
    },
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
    addEventListener() {}, focus() {}
  };
}

function sendContext(task = 'text', prompt = '  Creează un rezultat complet.\n') {
  const nodes = Object.fromEntries([
    'prompt', 'modelSelect', 'taskSelect', 'modeSelect', 'allowChanges',
    'editor', 'verifyWeb', 'messages', 'sendBtn'
  ].map(id => [id, element()]));
  Object.assign(nodes.prompt, { value: prompt });
  nodes.modelSelect.value = 'fixture-model';
  nodes.taskSelect.value = task;
  nodes.modeSelect.value = 'build';
  nodes.allowChanges.checked = true;
  nodes.editor.value = 'const original = true;';
  const initialChat = [{ role: 'user', content: 'Anterior' }, { role: 'assistant', content: 'Răspuns anterior' }];
  const storage = new Map();
  const requests = [];
  let context;
  const globals = {
    state: {
      project: 'project-one', projects: [{ id: 'project-one', name: 'Primul proiect' }],
      chat: initialChat.map(turn => ({ ...turn })), account: { role: 'owner' },
      activePath: 'app.js', files: [{ path: 'app.js' }], busy: false, dirty: false
    },
    el: id => nodes[id], document: { createElement: element },
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    chatKey: () => `nova-chat-${context.state.project}`,
    messageContainer: () => nodes.messages,
    jsonBody: value => value, setView() {}, toast() {}, resizePrompt() {},
    speakNextAssistant: false, routeSupports: () => false,
    saveFile: async () => {}, refreshFiles: async () => {}, openFile: async () => {},
    publishProject: async () => ({ published: true }), addPublishedSiteCard() {}, setWorkspaceOpen() {},
    api: async (route, body) => {
      requests.push({ route, body: JSON.parse(JSON.stringify(body)) });
      return context.respond(route, body);
    },
    respond: async () => ({ content: 'Rezultatul complet', events: [] })
  };
  context = vm.createContext(globals);
  for (const [start, end] of [
    ['function looksLikeCvCreationRequest(', 'function openCvBuilder('],
    ['function addBubble(', 'async function saveFile('],
    ['async function send()', 'el("editor").addEventListener']
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  const bubbles = role => nodes.messages.children.filter(node => node.className === `message ${role}`);
  return { context, nodes, storage, requests, initialChat, bubbles };
}

test('failed direct chat and agent turns restore the draft and retry once without duplicate history or bubbles', async t => {
  for (const task of ['auto', 'text', 'lyrics', 'code']) {
    await t.test(task, async () => {
      const draft = '  Creează un rezultat complet.\n';
      const { context, nodes, storage, requests, initialChat, bubbles } = sendContext(task, draft);
      context.respond = async () => { throw new Error('Cota API este epuizată.'); };
      await context.send();

      assert.equal(nodes.prompt.value, draft);
      assert.deepEqual(JSON.parse(JSON.stringify(context.state.chat)), initialChat);
      assert.deepEqual(JSON.parse(storage.get('nova-chat-project-one')), initialChat);
      assert.equal(bubbles('user').length, 0);
      assert.equal(bubbles('assistant').at(-1).children[1].textContent, 'Cota API este epuizată.');
      assert.equal(context.state.busy, false);
      assert.equal(nodes.sendBtn.disabled, false);
      assert.equal(nodes.messages.children.some(node => node.className === 'thinking'), false);

      context.respond = async () => ({ content: 'Rezultatul complet', events: [] });
      await context.send();
      const expectedRoute = task === 'code' ? '/api/agent' : '/api/chat';
      assert.deepEqual(requests.map(request => request.route), [expectedRoute, expectedRoute]);
      assert.equal(requests[1].body.messages.length, initialChat.length + 1);
      assert.deepEqual(requests[1].body.messages, requests[0].body.messages);
      assert.equal(context.state.chat.length, initialChat.length + 2);
      assert.equal(bubbles('user').length, 1);
      assert.equal(context.state.chat.at(-1).content, 'Rezultatul complet');
      assert.equal(nodes.prompt.value, '');
      assert.equal(JSON.parse(storage.get('nova-chat-project-one')).length, initialChat.length + 2);
    });
  }
});

test('a failed request preserves a newer composer draft', async t => {
  for (const task of ['text', 'code']) {
    await t.test(task, async () => {
      const { context, nodes, initialChat } = sendContext(task);
      context.respond = async () => {
        nodes.prompt.value = 'Un mesaj nou, scris în timpul cererii.';
        throw new Error('Motor indisponibil');
      };
      await context.send();
      assert.equal(nodes.prompt.value, 'Un mesaj nou, scris în timpul cererii.');
      assert.deepEqual(JSON.parse(JSON.stringify(context.state.chat)), initialChat);
    });
  }
});

test('post-response file refresh and publication failures retain the completed turn', async t => {
  for (const failure of ['refresh', 'publish']) {
    await t.test(failure, async () => {
      const { context, nodes, storage, initialChat, bubbles } = sendContext(failure === 'publish' ? 'business' : 'code');
      context.respond = async () => ({
        content: 'Fișierele au fost create.', events: [{ tool: 'write_file', ok: true, summary: 'app.js' }]
      });
      if (failure === 'refresh') context.refreshFiles = async () => { throw new Error('Reîncărcarea fișierelor a eșuat'); };
      else context.publishProject = async () => { throw new Error('Publicarea a eșuat'); };
      await context.send();

      assert.equal(nodes.prompt.value, '');
      assert.equal(context.state.chat.length, initialChat.length + 2);
      assert.equal(context.state.chat.at(-1).content, 'Fișierele au fost create.');
      assert.equal(JSON.parse(storage.get('nova-chat-project-one')).at(-1).content, 'Fișierele au fost create.');
      assert.equal(bubbles('user').length, 1);
      assert.equal(bubbles('assistant')[0].children[1].textContent, 'Fișierele au fost create.');
      assert.equal(bubbles('assistant').length, 2);
      assert.equal(context.state.busy, false);
    });
  }
});

test('a pre-request save failure restores the agent prompt without sending or keeping a failed turn', async () => {
  const { context, nodes, requests, initialChat } = sendContext('code', 'Salvează și repară proiectul');
  context.state.dirty = true;
  context.saveFile = async () => { throw new Error('Salvarea fișierului a eșuat'); };
  await context.send();
  assert.equal(nodes.prompt.value, 'Salvează și repară proiectul');
  assert.equal(requests.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.chat)), initialChat);
});

test('a successful response stays in its original project after the user switches projects', async () => {
  const { context, nodes, storage, initialChat, bubbles } = sendContext('text');
  context.respond = async () => {
    context.state.project = 'project-two';
    context.state.chat = [];
    nodes.prompt.value = 'Mesaj în proiectul nou';
    return { content: 'Răspuns pentru primul proiect' };
  };
  await context.send();
  assert.equal(context.state.chat.length, 0);
  assert.equal(storage.has('nova-chat-project-two'), false);
  assert.equal(JSON.parse(storage.get('nova-chat-project-one')).length, initialChat.length + 2);
  assert.equal(JSON.parse(storage.get('nova-chat-project-one')).at(-1).content, 'Răspuns pentru primul proiect');
  assert.equal(nodes.prompt.value, 'Mesaj în proiectul nou');
  assert.equal(bubbles('assistant').length, 0);
});


test('generated code opens the written file and editor instead of leaving an unrelated active file', async () => {
  const { context } = sendContext('code');
  const opened = [], workspace = [];
  context.state.files.push({path: 'src/new.js'});
  context.respond = async () => ({content: 'Cod salvat.', events: [
    {tool: 'write_file', ok: false, path: 'missing.js'},
    {tool: 'write_file', ok: true, path: 'src/new.js'}
  ]});
  context.openFile = async (path, force) => opened.push({path, force});
  context.setWorkspaceOpen = value => workspace.push(value);
  await context.send();
  assert.deepEqual(opened, [{path: 'src/new.js', force: true}]);
  assert.deepEqual(workspace, [true]);
});

test('code completion preserves edits made while the model was running', async () => {
  const { context, nodes } = sendContext('code');
  context.respond = async () => {
    context.state.dirty = true;
    nodes.editor.value = 'const unsaved = true;';
    return {content: 'Cod salvat.', events: [{tool: 'write_file', ok: true, path: 'app.js'}]};
  };
  context.openFile = async () => assert.fail('must not discard the newer editor draft');
  await context.send();
  assert.equal(nodes.editor.value, 'const unsaved = true;');
  assert.equal(context.state.dirty, true);
});


test('partial agent failure retains the submitted turn and exposes files already written without automatic publication', async t => {
  for (const task of ['code', 'business']) await t.test(task, async () => {
    const {context, nodes, storage, requests, initialChat, bubbles} = sendContext(task);
    const opened = [], workspace = [];
    context.state.files.push({path: 'generated.js'});
    context.respond = async () => {
      throw Object.assign(new Error('Motorul AI a expirat după salvare.'), {
        partial: true, events: [{tool: 'write_file', ok: true, path: 'generated.js', summary: 'Fișier salvat'}]
      });
    };
    context.openFile = async path => opened.push(path);
    context.setWorkspaceOpen = value => workspace.push(value);
    context.publishProject = async () => assert.fail('an unfinished business must not be automatically published');
    await context.send();
    assert.equal(requests.length, 1);
    assert.equal(context.state.chat.length, initialChat.length + 2);
    assert.equal(bubbles('user').length, 1);
    assert.match(context.state.chat.at(-1).content, /fișiere au fost salvate.*nu s-a finalizat/);
    assert.equal(JSON.parse(storage.get('nova-chat-project-one')).at(-1).events[0].path, 'generated.js');
    assert.deepEqual(opened, ['generated.js']);
    assert.deepEqual(workspace, task === 'code' ? [true] : []);
    assert.equal(nodes.prompt.value, '', 'the already applied instruction must not be restored as an unsubmitted draft');
    assert.equal(context.state.busy, false);
  });
});

test('partial agent failure preserves a newer editor and composer draft', async () => {
  const {context, nodes} = sendContext('code');
  context.respond = async () => {
    nodes.prompt.value = 'A separate next instruction';
    nodes.editor.value = 'new unsaved code';
    context.state.dirty = true;
    throw Object.assign(new Error('Interrupted'), {partial: true, events: [{tool: 'write_file', ok: true, path: 'app.js'}]});
  };
  context.openFile = async () => assert.fail('partial completion must not overwrite a newer draft');
  await context.send();
  assert.equal(nodes.prompt.value, 'A separate next instruction');
  assert.equal(nodes.editor.value, 'new unsaved code');
  assert.equal(context.state.dirty, true);
  assert.equal(context.state.chat.at(-1).events[0].path, 'app.js');
});

test('the HTTP wrapper retains partial file events for a failed agent response', async () => {
  const events = [{tool: 'write_file', ok: true, path: 'app.js'}];
  const context = vm.createContext({
    state: {}, window: {location: {replace() {assert.fail('provider failure must not log out the user');}}},
    fetch: async () => ({status: 503, ok: false, headers: {get: () => null},
      json: async () => ({error: 'Interrupted', providerError: true, partial: true, events})})
  });
  vm.runInContext(source.slice(source.indexOf('async function api('), source.indexOf('function encodeMessageContent(')), context);
  await assert.rejects(context.api('/api/agent'), error => error.message === 'Interrupted'
    && error.partial === true && error.events[0].path === 'app.js');
});
