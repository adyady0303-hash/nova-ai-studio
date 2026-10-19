const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { webUrl, publicIpv4, downloadPage, pageText, searchResults, callWebTool, createWebHealthChecker } = require('../web-tools');

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

function transport({ status = 200, type = 'text/html', body = '<h1>Hello</h1>', location, encoding }  = {}, inspect = () => {}) {
  return (url, options, callback) => {
    inspect(url, options);
    const req = new EventEmitter();
    req.destroy = error => { req.emit('error', error); req.emit('close'); };
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = { 'content-type': type, location, 'content-encoding': encoding };
      res.resume = () => req.emit('close');
      res.destroy = () => req.emit('close');
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

test('search keeps valid HTTP sources, skips malformed entries and deduplicates URLs', () => {
  const item = (link, title = 'Sursă') => `<item><title>${title}</title><link>${link}</link><description>Text</description></item>`;
  const results = searchResults(`<rss>${item('not-a-url')}${item('http://example.com/news')}${item('https://127.0.0.1/')}${item('javascript:alert(1)')}${item('http://example.com/news')}${item('https://example.org/')}</rss>`);
  assert.deepEqual(results.map(result => result.url), ['http://example.com/news', 'https://example.org/']);
});

test('DNS failure and timeout surface useful errors without contacting the destination', async () => {
  await assert.rejects(downloadPage('https://example.com', {
    lookup: async () => { throw Object.assign(new Error('temporary failure'), { code: 'EAI_AGAIN' }); },
    request: () => assert.fail('No resolved destination')
  }), /EAI_AGAIN.*DNS/);
  await assert.rejects(downloadPage('https://example.com', {
    lookup: () => new Promise(() => {}), request: () => assert.fail('DNS never resolved')
  }, 0, Date.now() + 20), /DNS/);
  await assert.rejects(downloadPage('https://example.com', {
    lookup: async () => [{ address:'8.8.8.8' }, { address:'10.0.0.1' }],
    request: () => assert.fail('Mixed public/private DNS must be rejected')
  }), /rezervate/);
});

test('page downloads reject aborted bodies and decode declared legacy charsets', async () => {
  await assert.rejects(downloadPage('https://example.com', {
    lookup,
    request: (_url, _options, callback) => {
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = 200; res.headers = { 'content-type':'text/html' };
        callback(res); res.emit('data', Buffer.from('partial')); res.emit('aborted'); req.emit('close');
      });
      return req;
    }
  }), /întrerupt/);
  const page = await downloadPage('https://example.com', {
    lookup, request: transport({ type:'text/html; charset=windows-1252', body: Buffer.from([0x63,0x61,0x66,0xe9]) })
  });
  assert.equal(page.body, 'café');
  await assert.rejects(callWebTool('web_search', null), /invalide/);
  await assert.rejects(callWebTool('read_web_page', []), /invalide/);
});

test('RSS search accepts text/xml responses and extracts cited source links', async () => {
  const rss = '<rss version="2.0"><channel><item><title>Știre de azi</title><link>https://example.com/stiri</link><description>Rezumat verificat</description></item></channel></rss>';
  for (const type of ['text/xml; charset=utf-8', 'application/xml; charset=UTF-8', 'application/rss+xml; charset=utf-8']) {
    const result = JSON.parse(await callWebTool('web_search', { query: 'știrile de astăzi' }, url => downloadPage(url, {
      lookup, request: transport({ type, body: rss })
    })));
    assert.deepEqual(result.sources, [{ title:'Știre de azi', url:'https://example.com/stiri', excerpt:'Rezumat verificat' }]);
  }
});

test('compressed XML is decoded with a strict uncompressed size limit', async () => {
  const zlib = require('node:zlib');
  const xml = '<rss><channel><item><title>Nova</title><link>https://example.com/</link></item></channel></rss>';
  for (const [encoding, compress] of [['gzip',zlib.gzipSync], ['br',zlib.brotliCompressSync], ['deflate',zlib.deflateSync]]) {
    const page = await downloadPage('https://example.com/', { lookup, request: transport({ type:' Text/XML ; charset=utf-8', encoding, body:compress(xml) }) });
    assert.equal(page.body, xml);
  }
  await assert.rejects(downloadPage('https://example.com/', {
    lookup, request: transport({ type:'text/xml', encoding:'gzip', body:zlib.gzipSync('x'.repeat(1024 * 1024 + 1)) })
  }), /decomprimată.*1 MiB/);
  await assert.rejects(downloadPage('https://example.com/', {
    lookup, request: transport({ type:'text/xml', encoding:'gzip', body:'invalid' })
  }), /comprimate/);
  await assert.rejects(downloadPage('https://example.com/', {
    lookup, request: transport({ type:'application/json', body:'{}' })
  }), /format primit: application\/json/);
});

test('web health requires actual sources, caches and shares concurrent checks, then retries', async () => {
  let time = Date.now(), calls = 0;
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const check = createWebHealthChecker(async () => { calls++; return response; }, () => time);
  const first = check(), second = check();
  assert.equal(calls,1);
  resolve({ body:'<rss><item><title>Nova</title><link>https://example.com/</link></item></rss>' });
  assert.deepEqual(await first, await second);
  assert.equal((await check()).connected, true);
  assert.equal(calls,1);
  time += 60001;
  await check();
  assert.equal(calls,2);
  const empty = createWebHealthChecker(async () => ({ body:'<rss></rss>' }));
  assert.equal((await empty()).connected, false);
  const failed = createWebHealthChecker(async () => { throw new Error('DNS indisponibil'); });
  assert.deepEqual(await failed(), await failed());
  assert.equal((await failed()).connected,false);
  assert.equal((await failed()).error,'DNS indisponibil');
});
