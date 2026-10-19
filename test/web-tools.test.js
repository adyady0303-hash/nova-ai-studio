const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { webUrl, publicIpv4, downloadPage, pageText, searchResults, callWebTool } = require('../web-tools');

test('web URLs and DNS validation reject private, reserved and credential destinations', async () => {
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com:8443', 'https://127.1', 'https://[::1]', 'https://169.254.169.254', 'file:///etc/passwd']) {
    assert.throws(() => webUrl(url));
  }
  for (const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','0.0.0.0','224.0.0.1','::ffff:127.0.0.1']) assert.equal(publicIpv4(address), false);
  assert.equal(publicIpv4('8.8.8.8'), true);
  await assert.rejects(downloadPage('https://example.com', {
    lookup: async () => [{ address: '127.0.0.1' }],
    request: () => assert.fail('Private address must not be contacted')
  }), /rezervate/);
});

function transport({ status = 200, type = 'text/html', body = '<h1>Hello</h1>', location } = {}, inspect = () => {}) {
  return (url, options, callback) => {
    inspect(url, options);
    const req = new EventEmitter();
    req.destroy = error => { req.emit('error', error); req.emit('close'); };
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = { 'content-type': type, location };
      res.resume = () => req.emit('close');
      callback(res);
      res.emit('data', Buffer.from(body));
      res.emit('end'); req.emit('close');
    });
    return req;
  };
}
const lookup = async () => [{ address: '8.8.8.8' }];

test('downloads pin validated DNS, enforce size/type and revalidate redirects', async () => {
  const page = await downloadPage('https://example.com', { lookup, request: transport({}, (_url, options) => {
    assert.equal(options.agent, false);
    options.lookup('example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  }) });
  assert.equal(page.body, '<h1>Hello</h1>');
  await assert.rejects(downloadPage('https://example.com', { lookup, request: transport({ type: 'application/octet-stream' }) }), /HTML/);
  await assert.rejects(downloadPage('https://example.com', { lookup, request: transport({ body: 'x'.repeat(1024 * 1024 + 1) }) }), /1 MiB/);
  await assert.rejects(downloadPage('https://example.com', { lookup, request: transport({ status: 302, location: 'https://127.0.0.1/' }) }), /rezervate/);
  await assert.rejects(downloadPage('https://example.com', { lookup, request: transport({ status: 403 }) }), /403/);
});

test('search returns source links and excerpts and page reader strips scripts', async () => {
  const rss = '<rss><channel><item><title>Nova &amp; AI</title><link>https://example.com/news</link><description>Actualizare</description></item></channel></rss>';
  assert.deepEqual(searchResults(rss), [{ title:'Nova & AI', url:'https://example.com/news', excerpt:'Actualizare' }]);
  const results = JSON.parse(await callWebTool('web_search', { query: 'Nova AI' }, async url => {
    assert.equal(new URL(url).searchParams.get('q'), 'Nova AI');
    return { body: rss, url };
  }));
  assert.equal(results.sources[0].url, 'https://example.com/news');
  assert.equal(pageText('<style>bad</style><script>bad</script><h1>Hello &amp; world</h1>'), 'Hello & world');
  const page = JSON.parse(await callWebTool('read_web_page', { url:'https://example.com' }, async url => ({ url, body:'<p>Public text</p>' })));
  assert.equal(page.text, 'Public text');
  await assert.rejects(callWebTool('web_search', { query:'' }), /500/);
  assert.throws(() => searchResults('<html>blocked</html>'), /RSS/);
});
