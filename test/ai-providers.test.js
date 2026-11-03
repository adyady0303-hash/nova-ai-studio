const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLATFORM_PRESETS, PLATFORM_CATALOG, catalog, createProfilesFromEnv,
  sanitizeProfileUpdate, validateProfileUpdate, isProfileConfigured,
  listProfileModels, chatWithProfile, openAiCompatibleJson,
  openAiCompatibleBytes, openAiCompatibleImageEdit, isTransientProviderError
} = require('../ai-providers');

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers }
  });
}

function customProfile(overrides = {}) {
  return {
    id: 'custom', name: 'Fixture compatible API', protocol: 'openai',
    baseUrl: 'https://models.example.test/v1', apiKey: 'fixture-secret',
    textModel: 'qwen/qwen3-32b', imageModel: 'fixture-image',
    speechModel: 'fixture-speech', voice: 'nova', ...overrides
  };
}

test('public catalog exposes every supported platform without credentials', () => {
  const expected = ['openai', 'gemini', 'anthropic', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'together', 'custom', 'ollama'];
  assert.deepEqual(Object.keys(PLATFORM_PRESETS), expected);
  assert.deepEqual(PLATFORM_CATALOG.map(item => item.id), expected);
  assert.strictEqual(catalog, PLATFORM_CATALOG);
  assert.equal(PLATFORM_PRESETS.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(PLATFORM_PRESETS.anthropic.protocol, 'anthropic');
  assert.equal(PLATFORM_PRESETS.openai.imageModel, 'gpt-image-1.5');
  assert.equal(PLATFORM_PRESETS.ollama.requiresKey, false);
  assert.equal(PLATFORM_CATALOG.some(item => Object.hasOwn(item, 'apiKey')), false);
  assert.equal(Object.isFrozen(PLATFORM_PRESETS), true);
  assert.equal(Object.isFrozen(PLATFORM_CATALOG[0].capabilities), true);
});

test('environment profiles apply settings and safely migrate a legacy compatible host', () => {
  const profiles = createProfilesFromEnv({
    OPENAI_API_KEY: 'openai-key', OPENAI_MODEL: 'gpt-fixture',
    OPENAI_BASE_URL: 'https://gateway.example.test/v1',
    GEMINI_API_KEY: 'gemini-key', ANTHROPIC_API_KEY: 'anthropic-key',
    ANTHROPIC_MODEL: 'claude-fixture', OLLAMA_URL: 'http://127.0.0.1:21434',
    OLLAMA_MODEL: 'local-fixture'
  });
  assert.equal(profiles.length, 11);
  const byId = Object.fromEntries(profiles.map(profile => [profile.id, profile]));
  assert.equal(byId.openai.baseUrl, PLATFORM_PRESETS.openai.baseUrl);
  assert.equal(byId.openai.apiKey, '');
  assert.equal(byId.openai.textModel, PLATFORM_PRESETS.openai.textModel);
  assert.equal(byId.gemini.apiKey, 'gemini-key');
  assert.equal(byId.anthropic.textModel, 'claude-fixture');
  assert.equal(byId.custom.baseUrl, 'https://gateway.example.test/v1');
  assert.equal(byId.custom.apiKey, 'openai-key');
  assert.equal(byId.ollama.baseUrl, 'http://127.0.0.1:21434');
  assert.equal(byId.ollama.textModel, 'local-fixture');

  const official = Object.fromEntries(createProfilesFromEnv({
    OPENAI_BASE_URL: PLATFORM_PRESETS.openai.baseUrl,
    OPENAI_API_KEY: 'official-key', OPENAI_MODEL: 'official-model'
  }).map(profile => [profile.id, profile]));
  assert.equal(official.openai.apiKey, 'official-key');
  assert.equal(official.openai.textModel, 'official-model');
  assert.equal(official.custom.apiKey, '');
  assert.equal(official.custom.baseUrl, '');
});

test('profile updates validate URLs and never carry a key to a new host', () => {
  const existing = sanitizeProfileUpdate(customProfile());
  const changedHost = sanitizeProfileUpdate({ id: 'custom', baseUrl: 'https://other.example.test/api', ignored: 'nope' }, existing);
  assert.equal(changedHost.apiKey, '');
  assert.equal(Object.hasOwn(changedHost, 'ignored'), false);
  assert.equal(isProfileConfigured(changedHost), true);
  const withoutUrl = sanitizeProfileUpdate({ id: 'custom', baseUrl: '' }, existing);
  assert.equal(withoutUrl.apiKey, '');
  const pivotedHost = sanitizeProfileUpdate({ id: 'custom', baseUrl: 'https://pivot.example.test/v1' }, withoutUrl);
  assert.equal(pivotedHost.apiKey, '');
  assert.equal(validateProfileUpdate({ id: 'google', apiKey: 'key' }).id, 'gemini');
  assert.throws(() => sanitizeProfileUpdate({ id: 'openai', apiKey: 123 }), { status: 400 });
  for (const baseUrl of ['ftp://example.test/v1', 'http://example.test/v1', 'https://user:pass@example.test/v1', 'https://example.test/v1?token=secret', 'https://example.test/v1#fragment']) {
    assert.throws(() => sanitizeProfileUpdate({ id: 'custom', baseUrl }), { status: 400 });
  }
  assert.equal(sanitizeProfileUpdate({ id: 'custom', baseUrl: 'http://127.0.0.1:11434/v1' }).baseUrl, 'http://127.0.0.1:11434/v1');
  assert.throws(() => sanitizeProfileUpdate({ id: 'openai', baseUrl: 'https://attacker.example.test/v1', apiKey: 'must-not-leak' }), { status: 400 });
});

test('generic OpenAI-compatible chat supports non-GPT models and normalizes tools', async () => {
  const result = await chatWithProfile(customProfile(), {
    model: 'meta-llama/Llama-4-Scout',
    messages: [{ role: 'user', content: 'Search the web' }],
    tools: [{ type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object' } } }],
    maxOutputTokens: 321, forceWebTool: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://models.example.test/v1/chat/completions');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      const headers = new Headers(options.headers);
      assert.equal(headers.get('authorization'), 'Bearer fixture-secret');
      assert.equal(headers.get('content-type'), 'application/json');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'meta-llama/Llama-4-Scout');
      assert.equal(body.max_tokens, 321);
      assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
      assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'web_search' } });
      return jsonResponse({ model: 'meta-llama/Llama-4-Scout', choices: [{ message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call-search', type: 'function', function: { name: 'web_search', arguments: { query: 'Nova' } } }]
      } }] });
    }
  });
  assert.deepEqual(result, {
    message: { role: 'assistant', content: '', tool_calls: [
      { id: 'call-search', type: 'function', function: { name: 'web_search', arguments: '{"query":"Nova"}' } }
    ] },
    model: 'meta-llama/Llama-4-Scout', provider: 'custom', providerName: 'Fixture compatible API'
  });
});

test('Anthropic adapter converts system, tools, tool_use and tool_result both ways', async () => {
  const profile = sanitizeProfileUpdate({ id: 'anthropic', apiKey: 'anthropic-secret', textModel: 'claude-fixture' });
  const tools = [
    { type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
    { type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }
  ];
  const result = await chatWithProfile(profile, {
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Weather in Cluj?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_weather', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Cluj"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_weather', content: '{"temperature":18}' }
    ],
    tools, maxOutputTokens: 222, forceWebTool: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.redirect, 'error');
      const headers = new Headers(options.headers);
      assert.equal(headers.get('x-api-key'), 'anthropic-secret');
      assert.equal(headers.get('anthropic-version'), '2023-06-01');
      assert.equal(headers.has('authorization'), false);
      const body = JSON.parse(options.body);
      assert.equal(body.system, 'Be concise.');
      assert.equal(body.max_tokens, 222);
      assert.deepEqual(body.tool_choice, { type: 'tool', name: 'web_search' });
      assert.deepEqual(body.tools[0], {
        name: 'get_weather', description: 'Weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } }
      });
      assert.deepEqual(body.messages[1].content[0], {
        type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Cluj' }
      });
      assert.deepEqual(body.messages[2].content[0], {
        type: 'tool_result', tool_use_id: 'toolu_weather', content: '{"temperature":18}'
      });
      return jsonResponse({ model: 'claude-fixture', role: 'assistant', content: [
        { type: 'text', text: 'I will verify. ' },
        { type: 'tool_use', id: 'toolu_search', name: 'web_search', input: { query: 'Cluj weather' } }
      ] });
    }
  });
  assert.deepEqual(result, {
    message: { role: 'assistant', content: 'I will verify. ', tool_calls: [
      { id: 'toolu_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"Cluj weather"}' } }
    ] },
    model: 'claude-fixture', provider: 'anthropic', providerName: 'Anthropic'
  });
});

test('model listing keeps non-GPT IDs and uses protocol-specific headers', async () => {
  const compatible = await listProfileModels(customProfile(), {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://models.example.test/v1/models');
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fixture-secret');
      return jsonResponse({ data: [{ id: 'qwen/qwen3-32b' }, { id: 'deepseek-r1' }, { id: 'qwen/qwen3-32b' }, { nope: true }] });
    }
  });
  assert.deepEqual(compatible, ['qwen/qwen3-32b', 'deepseek-r1']);

  const anthropic = await listProfileModels({ id: 'anthropic', apiKey: 'anthropic-secret' }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/models');
      assert.equal(new Headers(options.headers).get('x-api-key'), 'anthropic-secret');
      return jsonResponse({ data: [{ id: 'claude-a' }, { id: 'claude-b' }] });
    }
  });
  assert.deepEqual(anthropic, ['claude-a', 'claude-b']);

  const gemini = await listProfileModels({ id: 'gemini', apiKey: 'gemini-secret', textModel: 'models/gemini-2.5-flash' }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer gemini-secret');
      return jsonResponse({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-2.5-pro' }] });
    }
  });
  assert.deepEqual(gemini, ['gemini-2.5-flash', 'gemini-2.5-pro']);

  const ollama = await listProfileModels({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/tags');
      assert.equal(new Headers(options.headers).has('authorization'), false);
      return jsonResponse({ models: [{ name: 'qwen3:latest' }, { model: 'gemma3:12b' }] });
    }
  });
  assert.deepEqual(ollama, ['qwen3:latest', 'gemma3:12b']);
});

test('Gemini removes the catalog models prefix before chat requests', async () => {
  const profile = sanitizeProfileUpdate({ id: 'gemini', apiKey: 'gemini-secret', textModel: 'models/gemini-2.5-flash' });
  assert.equal(profile.textModel, 'gemini-2.5-flash');
  await chatWithProfile(profile, {
    model: 'models/gemini-2.5-flash', messages: [{ role: 'user', content: 'Salut' }],
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      assert.equal(JSON.parse(options.body).model, 'gemini-2.5-flash');
      return jsonResponse({ model: 'gemini-2.5-flash', choices: [{ message: { role: 'assistant', content: 'Salut!' } }] });
    }
  });
});

test('chat adapters propagate caller cancellation to every provider protocol', async t => {
  const profiles = [
    customProfile(),
    { id: 'anthropic', apiKey: 'anthropic-secret', textModel: 'claude-fixture' },
    { id: 'ollama', baseUrl: 'http://127.0.0.1:11434', textModel: 'local-fixture' }
  ];
  for (const profile of profiles) {
    await t.test(profile.id, async () => {
      const controller = new AbortController();
      const reason = new DOMException('Caller disconnected', 'AbortError');
      let requests = 0;
      await assert.rejects(chatWithProfile(profile, {
        messages: [{ role: 'user', content: 'Continue creating the project' }],
        signal: controller.signal,
        fetchImpl: async (_url, options) => {
          requests++;
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.signal.aborted, false);
          controller.abort(reason);
          assert.equal(options.signal.aborted, true, 'caller cancellation must reach the transport signal');
          options.signal.throwIfAborted();
        }
      }), error => error.status === 504 && error.cause === reason);
      assert.equal(requests, 1);
    });
  }
});

test('authenticated helpers reject route/header escapes and retain HTTP status', async () => {
  const profile = customProfile();
  await assert.rejects(openAiCompatibleJson(profile, 'https://attacker.example.test/steal', {
    fetchImpl: () => assert.fail('invalid route must not be fetched')
  }), { status: 400 });
  await assert.rejects(openAiCompatibleJson(profile, '/models', {
    headers: { authorization: 'Bearer replacement' },
    fetchImpl: () => assert.fail('reserved header must not be fetched')
  }), { status: 400 });
  await assert.rejects(openAiCompatibleJson(profile, '/models', {
    fetchImpl: async () => jsonResponse({ error: { message: 'slow down', code: 'rate_limit' } }, 429)
  }), error => error.status === 429 && error.code === 'rate_limit' && /slow down/.test(error.message));
});

test('media helpers authenticate bytes and leave multipart boundaries to fetch', async () => {
  const profile = customProfile();
  const audio = await openAiCompatibleBytes(profile, '/audio/speech', { input: 'Salut' }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://models.example.test/v1/audio/speech');
      const headers = new Headers(options.headers);
      assert.equal(headers.get('authorization'), 'Bearer fixture-secret');
      assert.equal(headers.get('content-type'), 'application/json');
      return new Response(Buffer.from('fixture-audio'), { headers: { 'content-type': 'audio/mpeg; charset=binary' } });
    }
  });
  assert.deepEqual(audio, { mime: 'audio/mpeg', base64: Buffer.from('fixture-audio').toString('base64') });

  const edited = await openAiCompatibleImageEdit(profile, {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png', extension: 'png'
  }, 'Add stars', {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://models.example.test/v1/images/edits');
      const headers = new Headers(options.headers);
      assert.equal(headers.get('authorization'), 'Bearer fixture-secret');
      assert.equal(headers.has('content-type'), false);
      assert(options.body instanceof FormData);
      assert.equal(options.body.get('model'), 'fixture-image');
      assert.equal(options.body.get('prompt'), 'Add stars');
      return jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] });
    }
  });
  assert.deepEqual(edited, { data: [{ b64_json: 'aW1hZ2U=' }] });
});

test('transient provider errors distinguish retryable failures', () => {
  for (const error of [
    Object.assign(new Error('rate limited'), { status: 429 }),
    Object.assign(new Error('overloaded'), { status: 529 }),
    Object.assign(new Error('network'), { code: 'ECONNRESET' }),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    Object.assign(new Error('wrapper'), { cause: Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }) }),
    Object.assign(new Error('anthropic overload'), { details: { error: { type: 'overloaded_error' } } })
  ]) assert.equal(isTransientProviderError(error), true);
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isTransientProviderError(Object.assign(new Error('permanent'), { status })), false);
  }
  assert.equal(isTransientProviderError(null), false);
});
