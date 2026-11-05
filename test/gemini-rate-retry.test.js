const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { chatWithProfile } = require('../ai-providers');
const source = fs.readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
const fn = source.slice(source.indexOf('async function chatWithResolvedTextModel('), source.indexOf('async function providerChat('));

test('Google RetryInfo exposes a precise delay without a Retry-After header', async () => {
  await assert.rejects(chatWithProfile({ id: 'gemini', apiKey: 'fixture', textModel: 'gemini-fixture' }, {
    messages: [{ role: 'user', content: 'Salut' }], fetchImpl: async () => new Response(JSON.stringify({ error: {
      message: 'Rate limited', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.2345s' }]
    } }), { status: 429 })
  }), error => error.status === 429 && error.retryAfterMs === 1235);
});
test('temporary Gemini throttling retries once on the same model; fixed quotas and long waits fail promptly', async () => {
  for (const scenario of ['temporary', 'daily', 'zero', 'long', 'repeat']) {
    let calls = 0, waits = [];
    const error = Object.assign(new Error('429'), { status: 429, retryAfterMs: scenario === 'long' ? 31000 : 1500,
      details: { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
        { quotaId: scenario === 'daily' ? 'RequestsPerDay' : 'RequestsPerMinute', quotaValue: scenario === 'zero' ? '0' : '5' }
      ] }] } } });
    const context = vm.createContext({ Date, delay: async ms => waits.push(ms), geminiOverloaded: () => false,
      missingTextModel: () => false, chatWithProfile: async (_profile, options) => {
        calls++; assert.equal(options.model, 'gemini-fixture');
        if (calls === 1 || scenario === 'repeat') throw error;
        return { message: { content: 'OK' } };
      } });
    vm.runInContext(fn, context);
    const result = context.chatWithResolvedTextModel({ id: 'gemini' }, 'gemini-fixture', {});
    if (scenario === 'temporary') assert.equal((await result).message.content, 'OK');
    else await assert.rejects(result, e => e === error);
    assert.equal(calls, ['temporary', 'repeat'].includes(scenario) ? 2 : 1);
    assert.deepEqual(waits, ['temporary', 'repeat'].includes(scenario) ? [1500] : []);
  }
});
