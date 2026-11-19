const test = require('node:test');
const assert = require('node:assert/strict');
const { startBusinessFixture } = require('../test-fixtures/business-server.cjs');

test('marketplace photographs load anonymously as WebP and support HEAD without authentication', async t => {
  const app = await startBusinessFixture(t);
  for (const name of ['hero', 'pizza', 'burger', 'sushi']) {
    const url = app.base + '/images/ammafood-' + name + '.webp';
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const image = Buffer.from(await response.arrayBuffer());
    assert.equal(image.toString('ascii', 0, 4), 'RIFF');
    assert.equal(image.toString('ascii', 8, 12), 'WEBP');
    assert.ok(image.length > 1000, 'A photograph must be returned, not the login page');
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), image.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.match(head.headers.get('cache-control'), /public/);
  }
});
