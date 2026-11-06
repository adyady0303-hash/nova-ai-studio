const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
const flush = () => new Promise(setImmediate);

function setup() {
  const nodes = new Map(), requests = [], storage = new Map(), notices = [];
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, {value: '', hidden: false, textContent: ''});
    return nodes.get(id);
  };
  el('editor').value = 'const original = true;';
  let context;
  context = vm.createContext({
    state: {project: 'first', activePath: 'app.js', files: [{path: 'app.js'}], dirty: false, chat: []},
    el, confirm: () => true,
    renderFiles() {}, renderProjects() {}, renderHomeProjects() {}, renderChat() {}, updateLines() {},
    readLocalCache: key => storage.get(key), writeLocalCache: (key, value) => storage.set(key, value),
    activeKey: () => 'active-' + context.state.project,
    chatKey: () => 'chat-' + context.state.project,
    refreshPublication: async () => {}, toast: notice => notices.push(notice),
    respond: async route => route.startsWith('/api/files?') ? {files: [{path: 'app.js'}]} : {content: 'file content'},
    api: async (route, options = {}) => {
      requests.push({route, options});
      return context.respond(route, options);
    }
  });
  vm.runInContext(source.slice(source.indexOf('async function saveFile('), source.indexOf('async function loadProjects(')), context);
  return {context, el, requests, storage, notices};
}

test('save acknowledgement preserves newer edits and the dirty marker', async () => {
  const {context, el, requests} = setup(), write = deferred();
  context.state.dirty = true;
  context.respond = async (route, options) => options.method === 'PUT' ? write.promise : {files: [{path: 'app.js'}]};
  const pending = context.saveFile();
  await flush();
  el('editor').value = 'const newerDraft = true;';
  write.resolve({saved: true});
  await pending;
  assert.equal(JSON.parse(requests[0].options.body).content, 'const original = true;');
  assert.equal(el('editor').value, 'const newerDraft = true;');
  assert.equal(context.state.dirty, true);
  assert.equal(el('dirtyMark').hidden, false);
});

test('overlapping saves reach the server in order and the latest version clears dirty', async () => {
  const {context, el, requests} = setup(), first = deferred(), second = deferred();
  let writes = 0;
  context.state.dirty = true;
  context.respond = async (route, options) => options.method === 'PUT'
    ? (++writes === 1 ? first.promise : second.promise) : {files: [{path: 'app.js'}]};
  const oldSave = context.saveFile();
  await flush();
  el('editor').value = 'const latest = true;';
  const latestSave = context.saveFile();
  await flush();
  assert.equal(writes, 1, 'a newer save must not overtake an older write');
  first.resolve({saved: true});
  await flush();
  assert.equal(writes, 2);
  const bodies = requests.filter(request => request.options.method === 'PUT').map(request => JSON.parse(request.options.body));
  assert.deepEqual(bodies.map(body => body.content), ['const original = true;', 'const latest = true;']);
  second.resolve({saved: true});
  await Promise.all([oldSave, latestSave]);
  assert.equal(context.state.dirty, false);
  assert.equal(el('dirtyMark').hidden, true);
});

test('a late file list cannot replace files after switching projects', async () => {
  const {context} = setup(), oldList = deferred();
  context.respond = () => oldList.promise;
  const pending = context.refreshFiles(false);
  context.state.project = 'second';
  context.state.files = [{path: 'second.js'}];
  context.state.activePath = 'second.js';
  oldList.resolve({files: [{path: 'old.js'}]});
  await pending;
  assert.equal(context.state.files[0].path, 'second.js');
  assert.equal(context.state.activePath, 'second.js');
});

test('the most recently selected file wins when reads complete out of order', async () => {
  const {context, el, storage} = setup(), oldRead = deferred(), newRead = deferred();
  context.respond = route => route.includes('old.js') ? oldRead.promise : newRead.promise;
  const oldPending = context.openFile('old.js');
  const newPending = context.openFile('new.js');
  newRead.resolve({content: 'new file'});
  await newPending;
  oldRead.resolve({content: 'old file'});
  await oldPending;
  assert.equal(context.state.activePath, 'new.js');
  assert.equal(el('editor').value, 'new file');
  assert.equal(storage.get('active-first'), 'new.js');
});

test('late reads preserve edits typed while opening a file', async () => {
  const {context, el} = setup(), read = deferred();
  context.respond = () => read.promise;
  const pending = context.openFile('next.js', true);
  context.state.dirty = true;
  el('editor').value = 'a draft typed while loading';
  read.resolve({content: 'next file'});
  await pending;
  assert.equal(context.state.activePath, 'app.js');
  assert.equal(el('editor').value, 'a draft typed while loading');
  assert.equal(context.state.dirty, true);
});

test('an old project read cannot populate the new project editor', async () => {
  const {context, el, storage} = setup(), read = deferred();
  context.respond = () => read.promise;
  const pending = context.openFile('old.js');
  context.state.project = 'second';
  context.state.activePath = 'second.js';
  el('editor').value = 'second content';
  read.resolve({content: 'first content'});
  await pending;
  assert.equal(el('editor').value, 'second content');
  assert.equal(context.state.activePath, 'second.js');
  assert.equal(storage.has('active-second'), false);
});

test('the latest project selection wins and old files cannot be saved into a loading project', async () => {
  const {context, el, requests} = setup(), oldList = deferred();
  context.respond = async route => {
    if (route === '/api/files?project=old') return oldList.promise;
    if (route.startsWith('/api/files?')) return {files: [{path: 'new.js'}]};
    return {content: 'new project content'};
  };
  const oldPending = context.loadProject('old');
  assert.equal(context.state.activePath, null);
  assert.equal(el('editor').value, '');
  await context.saveFile();
  assert.equal(requests.some(request => request.options.method === 'PUT'), false);
  await context.loadProject('new');
  oldList.resolve({files: [{path: 'old.js'}]});
  await oldPending;
  assert.equal(context.state.project, 'new');
  assert.equal(context.state.files[0].path, 'new.js');
  assert.equal(context.state.activePath, 'new.js');
  assert.equal(el('editor').value, 'new project content');
});

test('new edits during automatic save keep the current project open', async () => {
  const {context, el} = setup(), write = deferred();
  context.state.dirty = true;
  context.respond = async (route, options) => options.method === 'PUT' ? write.promise : {files: [{path: 'app.js'}]};
  const pending = context.loadProject('second');
  await flush();
  el('editor').value = 'new unsaved work';
  write.resolve({saved: true});
  await pending;
  assert.equal(context.state.project, 'first');
  assert.equal(context.state.dirty, true);
  assert.equal(el('editor').value, 'new unsaved work');
});


test('file list refresh does not reload an editor with unsaved changes', async () => {
  const {context, el, requests} = setup();
  context.state.dirty = true;
  el('editor').value = 'unsaved content';
  await context.refreshFiles();
  assert.equal(requests.length, 1);
  assert.equal(el('editor').value, 'unsaved content');
  assert.equal(context.state.dirty, true);
});

test('a draft typed while the new project list loads is not discarded by its first file', async () => {
  const {context, el} = setup(), list = deferred();
  context.respond = async () => list.promise;
  const pending = context.loadProject('second');
  el('editor').value = 'a new project draft';
  context.state.dirty = true;
  list.resolve({files: [{path: 'second.js'}]});
  await pending;
  assert.equal(el('editor').value, 'a new project draft');
  assert.equal(context.state.dirty, true);
  assert.equal(context.state.activePath, null);
});
