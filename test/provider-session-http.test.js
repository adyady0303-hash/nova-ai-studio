const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');

const root = path.join(__dirname, '..');
async function startApp(t, {autoSelect = true} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-provider-session-'));
  const callsPath = path.join(directory, 'calls.jsonl');
  const preload = path.join(directory, 'mock.cjs');
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const record = value => fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(value) + '\\n');
    const web = require(${JSON.stringify(path.join(root, 'web-tools.js'))});
    web.callWebTool = async () => 'Source: https://example.com/article';
    const reply = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type':'application/json'}});
    const tool = (id, name, args, provider) => ({id, type:'function', function:{name, arguments:JSON.stringify(args)},
      ...(provider === 'gemini' ? {extra_content:{google:{thought_signature:'fixture-signature-' + id}}} : {})});
    global.fetch = async (url, options) => {
      const provider = {'api.openai.com':'openai', 'generativelanguage.googleapis.com':'gemini'}[new URL(url).hostname];
      if (!provider) throw new Error('Unexpected provider');
      if (new URL(url).pathname.endsWith('/models')) return reply(200, {data:[{id:provider + '-primary'}]});
      const body = JSON.parse(options.body);
      const prompt = body.messages.filter(message => message.role === 'user').at(-1).content;
      record({provider, prompt, model:body.model, messages:body.messages, type:'request'});
      if (prompt === 'FALLBACK' && provider === 'openai') return reply(429, {error:{code:'insufficient_quota', message:'fixture-private-key'}});
      const previous = body.messages.filter(message => message.role === 'assistant' && message.tool_calls?.length);
      if (previous.some(message => message.tool_calls.some(call => !call.id.startsWith(provider + '-')))) {
        return reply(400, {error:{message:'foreign tool signature'}});
      }
      if (provider === 'gemini' && previous.some(message => message.tool_calls.some(call => !call.extra_content?.google?.thought_signature))) {
        return reply(400, {error:{message:'thought signature missing'}});
      }
      const portableRounds = body.messages.filter(message => message.role === 'assistant' && message.content?.includes('Unelte cerute anterior de alt motor')).length;
      const rounds = previous.length + portableRounds;
      if (prompt === 'MID_FAILOVER' && provider === 'openai' && rounds) return reply(502, {error:{message:'gateway down'}});
      if (prompt === 'GEMINI_TO_OPENAI' && provider === 'gemini' && rounds) return reply(502, {error:{message:'gateway down'}});
      if (prompt === 'PARTIAL_FAILURE' && rounds) return reply(500, {error:{message:'fixture-private-provider-detail'}});
      if (prompt === 'CANCEL' && rounds) return new Promise((resolve,reject) => {
        const cancel = () => {record({type:'aborted', provider, prompt}); reject(options.signal.reason);};
        if (options.signal.aborted) cancel(); else options.signal.addEventListener('abort',cancel,{once:true});
      });
      const file = 'generated/' + prompt.toLowerCase() + '.txt';
      const message = rounds >= 2 ? {role:'assistant',content:'Finished by ' + provider} : {
        role:'assistant',content:null,tool_calls:[tool(provider + '-' + rounds,
          prompt.startsWith('WEB') ? 'web_search' : rounds ? 'read_file' : 'write_file',
          prompt.startsWith('WEB') ? {query:'public fixture'} : rounds ? {path:file} : {path:file,content:'Created by ' + provider}, provider)]};
      return reply(200, {model:provider + '-resolved', choices:[{message}]});
    };
  `);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: root, env: {...process.env, HOST:'127.0.0.1', PORT:String(port), NOVA_DATA_DIR:directory, DATABASE_URL:'',
      NOVA_ACCESS_USER:'owner', NOVA_ACCESS_PASSWORD:'owner-password-long-enough', NOVA_SUBSCRIBER_DAILY_AI_LIMIT:'5',
      AI_PROVIDER:'openai', AI_FALLBACK_PROVIDERS:'', OPENAI_API_KEY:'fixture-openai-secret', OPENAI_MODEL:'openai-primary',
      GEMINI_API_KEY:'fixture-gemini-secret', GEMINI_MODEL:'gemini-primary', ANTHROPIC_API_KEY:'', OPENROUTER_API_KEY:'',
      GROQ_API_KEY:'', MISTRAL_API_KEY:'', DEEPSEEK_API_KEY:'', XAI_API_KEY:'', TOGETHER_API_KEY:'', CUSTOM_OPENAI_API_KEY:''},
    stdio:['ignore','pipe','pipe']
  });
  let logs = '';
  child.stdout.on('data', data => {logs += data;});
  child.stderr.on('data', data => {logs += data;});
  t.after(async () => {
    if (child.exitCode === null) {const exit = once(child,'exit'); child.kill(); await exit;}
    fs.rmSync(directory,{recursive:true,force:true});
  });
  for (let count = 0; count < 150; count++) {
    try {if ((await fetch(base + '/healthz')).ok) break;} catch {}
    if (child.exitCode !== null) assert.fail(logs);
    await new Promise(resolve => setTimeout(resolve,10));
    if (count === 149) assert.fail('Server did not start: ' + logs);
  }
  const request = cookie => async (route, body, options = {}) => fetch(base + route, {
    method:body === undefined ? 'GET' : 'POST', ...options,
    headers:{cookie, origin:base, 'content-type':'application/json'},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})
  });
  const login = await request('')('/api/auth/login', {username:'owner', password:'owner-password-long-enough'});
  assert.equal(login.status,200);
  const owner = request(login.headers.get('set-cookie').split(';',1)[0]);
  const configured = await owner('/api/settings', {providerId:'openai', routes:{text:'openai', image:'openai', speech:'openai', autoSelect, autoFallback:false}});
  assert.equal(configured.status,200,await configured.text());
  const calls = () => fs.readFileSync(callsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  async function project(client, name) {
    const response = await client('/api/projects',{name});
    assert.equal(response.status,201);
    return (await response.json()).project.id;
  }
  const ownerProject = await project(owner,'Owner fixture');
  const agent = (client, prompt, projectId = ownerProject, options) => client('/api/agent',{
    project:projectId, model:'owner-selected', task:'code', allowChanges:true,
    messages:[{role:'user',content:prompt}]
  },options);
  return {owner, project, agent, calls, request};
}

test('automatic routing rotates between user actions and keeps provider, resolved model and signatures within agent tool rounds', async t => {
  const app = await startApp(t);
  for (const [prompt, provider, initialModel] of [['FIRST','openai','owner-selected'],['SECOND','gemini','gemini-primary']]) {
    const before = app.calls().length;
    const response = await app.agent(app.owner,prompt);
    const result = await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    assert.equal(result.provider,provider);
    assert.equal(result.model,provider + '-resolved');
    assert.equal(result.events.find(event => event.tool === 'write_file').path,'generated/' + prompt.toLowerCase() + '.txt');
    const calls = app.calls().slice(before);
    assert.deepEqual(calls.map(call => call.provider),[provider,provider,provider]);
    assert.deepEqual(calls.map(call => call.model),[initialModel,provider + '-resolved',provider + '-resolved']);
  }
});

test('quota fallback remains with the successful alternate for every subsequent tool round', async t => {
  const app = await startApp(t);
  const response = await app.agent(app.owner,'FALLBACK');
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((await response.json()).provider,'gemini');
  assert.deepEqual(app.calls().map(call => call.provider),['openai','gemini','gemini','gemini']);
});

test('web-tool chat uses one provider per action and still rotates the next action', async t => {
  const app = await startApp(t);
  for (const [prompt, provider] of [['WEB_FIRST','openai'],['WEB_SECOND','gemini']]) {
    const before = app.calls().length;
    const response = await app.owner('/api/chat',{model:'owner-selected',messages:[{role:'user',content:prompt}]});
    assert.equal(response.status,200,await response.clone().text());
    assert.equal((await response.json()).provider,provider);
    assert.deepEqual(app.calls().slice(before).map(call => call.provider),[provider,provider,provider]);
  }
});

test('subscriber agent tool continuations consume a single Nova unit', async t => {
  const app = await startApp(t);
  const registration = await app.request('')('/api/auth/register',{username:'visitor',password:'pass1234'});
  const visitor = app.request(registration.headers.get('set-cookie').split(';',1)[0]);
  const project = await app.project(visitor,'Visitor fixture');
  const response = await app.agent(visitor,'VISITOR',project);
  assert.equal(response.status,200,await response.text());
  const me = await (await visitor('/api/auth/me')).json();
  assert.equal(me.quotaRemaining,4);
  assert.deepEqual(app.calls().map(call => call.provider),['openai','openai','openai']);
});

test('failure after writing returns safe partial events and leaves the written file accessible', async t => {
  const app = await startApp(t,{autoSelect:false});
  const response = await app.agent(app.owner,'PARTIAL_FAILURE');
  const result = await response.json();
  assert.equal(response.status,503);
  assert.equal(result.providerError,true);
  assert.equal(result.partial,true);
  assert.deepEqual(result.events.map(event => ({tool:event.tool,ok:event.ok,path:event.path})),[
    {tool:'write_file',ok:true,path:'generated/partial_failure.txt'}
  ]);
  assert.ok(!JSON.stringify(result).includes('fixture-private-provider-detail'));
  const project = await (await app.owner('/api/projects')).json();
  const file = await app.owner('/api/file?project=' + project.projects[0].id + '&path=generated/partial_failure.txt');
  assert.equal(file.status,200);
  assert.equal((await file.json()).content,'Created by openai');
});

test('disconnect during a sticky continuation aborts the provider without starting another', async t => {
  const app = await startApp(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = app.agent(app.owner,'CANCEL',undefined,{signal:controller.signal});
  const rejected = assert.rejects(pending,{name:'AbortError'});
  for (let count=0; count<100 && app.calls().length<2; count++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(app.calls().length,2);
  controller.abort();
  await rejected;
  for (let count=0; count<100 && !app.calls().some(call=>call.type==='aborted'); count++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(app.calls().filter(call=>call.type==='request').map(call=>call.provider),['openai','openai']);
  assert.ok(app.calls().some(call=>call.type==='aborted'));
});


test('failover into Gemini retains completed file work as plain transcript and keeps its new tools structured', async t => {
  const app = await startApp(t);
  const response = await app.agent(app.owner,'MID_FAILOVER');
  const result = await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.equal(result.provider,'gemini');
  const calls = app.calls();
  assert.deepEqual(calls.map(call => call.provider),['openai','openai','gemini','gemini']);
  const transferred = calls[2].messages;
  assert.equal(transferred.some(message => message.role === 'tool'),false);
  assert.equal(transferred.some(message => message.tool_calls?.length),false);
  assert.ok(transferred.some(message => message.content?.includes('openai-0') && message.content.includes('generated/mid_failover.txt')));
  assert.ok(transferred.some(message => message.content?.includes('Created by openai')));
  assert.equal(calls[3].messages.filter(message => message.tool_calls?.length)[0].tool_calls[0].extra_content.google.thought_signature,'fixture-signature-gemini-1');
  assert.deepEqual(calls[1].messages.slice(0,2),calls[2].messages.slice(0,2),'user and system content is preserved');
  assert.equal(calls[1].messages.find(message => message.role === 'tool').content.includes('Fișier creat'),true);
  assert.equal(result.events.filter(event => event.tool === 'write_file').length,1,'completed writes are not replayed');
});

test('failover away from Gemini removes its opaque signatures while retaining work and tool IDs', async t => {
  const app = await startApp(t);
  const warmup = await app.owner('/api/chat',{model:'owner-selected',messages:[{role:'user',content:'plain greeting'}],task:'text'});
  assert.equal(warmup.status,200,await warmup.text());
  const before = app.calls().length;
  const response = await app.agent(app.owner,'GEMINI_TO_OPENAI');
  const result = await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.equal(result.provider,'openai');
  const calls = app.calls().slice(before);
  assert.deepEqual(calls.map(call => call.provider),['gemini','gemini','openai','openai']);
  assert.equal(JSON.stringify(calls[2].messages).includes('thought_signature'),false);
  assert.ok(calls[2].messages.some(message => message.content?.includes('gemini-0')));
  assert.ok(calls[2].messages.some(message => message.content?.includes('Created by gemini')));
  assert.equal(calls[1].messages.find(message => message.tool_calls?.length).tool_calls[0].extra_content.google.thought_signature,'fixture-signature-gemini-0','original history stays intact');
  assert.equal(result.events.filter(event => event.tool === 'write_file').length,1);
});
