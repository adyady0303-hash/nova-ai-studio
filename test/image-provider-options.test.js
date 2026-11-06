const test = require('node:test');
const assert = require('node:assert/strict');
const { openAiCompatibleImageEdit } = require('../ai-providers');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const profile = { id: 'openai', apiKey: 'fixture-key', imageModel: 'dall-e-2' };
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

test('DALL-E 2 edits omit unsupported quality and ask for durable base64 image output', async () => {
  let calls = 0;
  const result = await openAiCompatibleImageEdit(profile, png, 'Schimbă fundalul în albastru', {
    quality: 'high',
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/images/edits');
      const form = options.body;
      assert.equal(form.get('model'), 'dall-e-2');
      assert.equal(form.has('quality'), false, 'DALL-E 2 rejects the GPT-image quality parameter');
      assert.equal(form.get('response_format'), 'b64_json', 'saved images must not depend on an expiring DALL-E URL');
      assert.equal(form.get('size'), '1024x1024');
      assert.equal(form.get('n'), '1');
      assert.equal(form.get('image').type, 'image/png');
      return response({ data: [{ b64_json: png.toString('base64') }] });
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.data[0].b64_json, png.toString('base64'));
});

test('GPT-image edits retain high quality and omit the legacy response format parameter', async () => {
  const result = await openAiCompatibleImageEdit({ ...profile, imageModel: 'gpt-image-1.5' }, png, 'Păstrează persoana', {
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.get('quality'), 'high');
      assert.equal(options.body.has('response_format'), false, 'GPT-image does not accept the legacy response_format parameter');
      return response({ data: [{ b64_json: png.toString('base64') }] });
    }
  });
  assert.equal(result.data[0].b64_json, png.toString('base64'));
});

test('compatible model-specific quality options stay unchanged', async () => {
  await openAiCompatibleImageEdit({ id: 'custom', baseUrl: 'https://images.example.test/v1', imageModel: 'custom-edit' }, png, 'Edit', {
    quality: 'standard',
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.get('quality'), 'standard');
      assert.equal(options.body.has('response_format'), false);
      return response({ data: [{ b64_json: png.toString('base64') }] });
    }
  });
});
