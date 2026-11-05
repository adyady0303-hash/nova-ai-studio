const test = require('node:test');
const assert = require('node:assert/strict');
const { callWebTool } = require('../web-tools');

const urls = ['https://ai.google.dev/gemini/errors', 'https://docs.ai.google.dev/gemini/503',
  'https://ai.google.dev.attacker.example/gemini/errors', 'https://gemini.google.com/',
  'https://ai.google.dev/gemini-other'];
const download = async () => ({ body: '<rss><channel>' + urls.map(url =>
  `<item><title>Source</title><link>${url}</link><description>Excerpt</description></item>`).join('') + '</channel></rss>' });

test('site queries enforce domain and path boundaries when Bing ignores the operator', async () => {
  const result = JSON.parse(await callWebTool('web_search', { query: 'site:ai.google.dev/gemini HTTP 503' }, download));
  assert.deepEqual(result.sources.map(source => source.url), urls.slice(0, 2));
});
test('unscoped and negative-site queries retain normal results; unmatched scope returns no invented sources', async () => {
  for (const query of ['Gemini HTTP 503', '-site:ai.google.dev Gemini']) {
    const result = JSON.parse(await callWebTool('web_search', { query }, download));
    assert.deepEqual(result.sources.map(source => source.url), (await JSON.parse(await callWebTool('web_search', { query: 'Gemini' }, download))).sources.map(source => source.url));
  }
  const result = JSON.parse(await callWebTool('web_search', { query: 'site:example.org Gemini' }, download));
  assert.deepEqual(result.sources, []);
});
