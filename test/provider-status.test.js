const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderStatus } = require('../provider-status');

function gemini(overrides = {}) {
  return {
    id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    textModel: 'gemini-2.5-flash', apiKey: 'fixture-private-gemini-key', ...overrides
  };
}

test('a configured provider starts unchecked and records actual successful model and safe failure recovery', () => {
  const instant = Date.UTC(2026, 10, 3, 12);
  const status = createProviderStatus({ now: () => instant });
  const profile = gemini();
  assert.deepEqual(status.get(profile), {
    state: 'unchecked', checkedAt: null, model: profile.textModel, error: ''
  });
  status.success(profile, { model: 'gemini-3-flash', ignoredResponse: { private: profile.apiKey } });
  assert.deepEqual(status.get(profile), {
    state: 'available', checkedAt: new Date(instant).toISOString(), model: 'gemini-3-flash', error: ''
  });
  status.failure(profile, Object.assign(new Error('private quota response'), { status: 429 }), 'Cota API este epuizată.');
  assert.deepEqual(status.get(profile), {
    state: 'quota', checkedAt: new Date(instant).toISOString(), model: profile.textModel, error: 'Cota API este epuizată.'
  });
  status.success(profile, { model: profile.textModel });
  assert.equal(status.get(profile).state, 'available');
  assert.equal(status.get(profile).error, '');
});

test('recent provider outcomes distinguish authentication, transport, response, timeout and model failures', () => {
  const status = createProviderStatus();
  const profile = gemini();
  const cases = [
    [{ status: 401 }, 'auth_error'],
    [{ status: 403 }, 'auth_error'],
    [{ status: 502, failureKind: 'network', code: 'ENOTFOUND' }, 'network_error'],
    [{ status: 502, failureKind: 'invalid_response' }, 'invalid_response'],
    [{ status: 504, failureKind: 'timeout' }, 'timeout'],
    [{ status: 408 }, 'timeout'],
    [{ status: 404, failureKind: 'http', upstreamStatus: 404 }, 'model_error'],
    [{ status: 400 }, 'model_error'],
    [{ status: 503, failureKind: 'http', upstreamStatus: 503 }, 'unavailable'],
    [{}, 'unavailable']
  ];
  for (const [details, expected] of cases) {
    status.failure(profile, Object.assign(new Error('untrusted provider response'), details), 'Mesaj sigur.');
    assert.equal(status.get(profile).state, expected);
    assert.equal(status.get(profile).error, 'Mesaj sigur.');
  }
});

test('configuration changes invalidate previous outcomes including credential replacements', () => {
  const status = createProviderStatus();
  const profile = gemini();
  for (const change of [
    { apiKey: 'fixture-replacement-key' },
    { textModel: 'gemini-3-flash' },
    { baseUrl: 'https://different.example/v1' }
  ]) {
    status.success(profile, { model: profile.textModel });
    const next = { ...profile, ...change };
    assert.deepEqual(status.get(next), { state: 'unchecked', checkedAt: null, model: next.textModel, error: '' });
  }
  status.success(profile, { model: profile.textModel });
  assert.equal(status.get({ ...profile, id: 'custom' }).state, 'unchecked');
});

test('runtime observations expire after sixty seconds and a new result starts a fresh interval', () => {
  let instant = Date.UTC(2026, 10, 3, 12);
  const status = createProviderStatus({ now: () => instant });
  const profile = gemini();
  status.failure(profile, { status: 503 }, 'Serviciul nu răspunde.');
  instant += 59999;
  assert.equal(status.get(profile).state, 'unavailable');
  instant += 1;
  assert.deepEqual(status.get(profile), { state: 'unchecked', checkedAt: null, model: profile.textModel, error: '' });
  status.success(profile, { model: 'gemini-3-flash' });
  assert.equal(status.get(profile).checkedAt, new Date(instant).toISOString());
  instant += 59999;
  assert.equal(status.get(profile).state, 'available');
});

test('public observations contain only safe fields and never retain raw credentials or errors', () => {
  const status = createProviderStatus();
  const profile = gemini({ baseUrl: 'https://fixture-user:fixture-password@private.example/v1?key=fixture-query-secret' });
  const failure = Object.assign(new Error(`private response ${profile.apiKey}`), {
    status: 503, details: { authorization: profile.apiKey }, cause: new Error('private nested cause')
  });
  status.failure(profile, failure, 'Furnizorul a răspuns cu HTTP 503.');
  const result = status.get(profile);
  assert.deepEqual(Object.keys(result).sort(), ['checkedAt', 'error', 'model', 'state']);
  const serialized = JSON.stringify(result);
  for (const secret of [profile.apiKey, 'fixture-user', 'fixture-password', 'private.example', 'fixture-query-secret', 'private response', 'private nested cause']) {
    assert.ok(!serialized.includes(secret));
  }
  result.state = 'available';
  result.error = 'Changed by caller';
  assert.equal(status.get(profile).state, 'unavailable');
  assert.equal(status.get(profile).error, 'Furnizorul a răspuns cu HTTP 503.');
  status.failure(profile, failure);
  assert.equal(status.get(profile).error, '', 'raw exception messages are never used as fallback text');
});

test('clearing one provider preserves other observations and clearing all removes runtime history', () => {
  const status = createProviderStatus();
  const first = gemini();
  const second = gemini({ id: 'openai', textModel: 'gpt-test' });
  status.success(first, { model: first.textModel });
  status.failure(second, { status: 429 }, 'Cota API este epuizată.');
  status.clear(first.id);
  assert.equal(status.get(first).state, 'unchecked');
  assert.equal(status.get(second).state, 'quota');
  status.clear();
  assert.equal(status.get(second).state, 'unchecked');
});
