const test = require('node:test');
const assert = require('node:assert/strict');
const { chatWithProfile } = require('../ai-providers');

const profile = { id: 'gemini', apiKey: 'fixture-not-real', textModel: 'gemini-3.6-flash' };
const tools = [
  { type: 'function', function: { name: 'list_files', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'write_file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } }
];
const reply = message => new Response(JSON.stringify({ choices: [{ message }], model: profile.textModel }), { status: 200, headers: { 'content-type': 'application/json' } });

test('Gemini file tools accept no-argument functions and preserve signatures across consecutive tool rounds', async () => {
  const original = JSON.stringify(tools);
  const messages = [{ role: 'user', content: 'Create index.html' }];
  const signatures = ['opaque-list-signature', 'opaque-write-signature'];
  let calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).hostname, 'generativelanguage.googleapis.com');
    const body = JSON.parse(options.body);
    assert.equal(Object.hasOwn(body.tools[0].function, 'parameters'), false);
    assert.deepEqual(body.tools[1], tools[1]);
    if (calls) {
      const previous = body.messages.filter(message => message.role === 'assistant').at(-1);
      assert.equal(previous.tool_calls[0].extra_content.google.thought_signature, signatures[calls - 1]);
    }
    const index = calls++;
    if (index === 2) return reply({ role: 'assistant', content: 'Created index.html' });
    return reply({ role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: {
      name: index ? 'write_file' : 'list_files', arguments: index ? JSON.stringify({ path: 'index.html', content: '<h1>Nova</h1>' }) : '{}'
    }, extra_content: { google: { thought_signature: signatures[index] }, ignored: 'do not copy arbitrary metadata' } }] });
  };
  for (let index = 0; index < 3; index++) {
    const result = await chatWithProfile(profile, { messages, tools, fetchImpl });
    if (index === 2) assert.equal(result.message.content, 'Created index.html');
    else {
      assert.equal(Object.hasOwn(result.message.tool_calls[0].extra_content, 'ignored'), false);
      messages.push(result.message, { role: 'tool', tool_call_id: `call-${index}`, content: index ? 'Written' : '[]' });
    }
  }
  assert.equal(calls, 3);
  assert.equal(JSON.stringify(tools), original, 'provider adaptation must not change shared tool definitions');
});

test('other compatible providers keep their original function schema and omit Google metadata', async () => {
  const result = await chatWithProfile({ id: 'openai', apiKey: 'fixture-not-real', textModel: 'fixture-model' }, {
    messages: [{ role: 'user', content: 'List files' }], tools,
    fetchImpl: async (url, options) => {
      assert.deepEqual(JSON.parse(options.body).tools, tools);
      return reply({ role: 'assistant', content: null, tool_calls: [{ id: 'call', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'not-for-this-provider' } } }] });
    }
  });
  assert.equal(Object.hasOwn(result.message.tool_calls[0], 'extra_content'), false);
});
