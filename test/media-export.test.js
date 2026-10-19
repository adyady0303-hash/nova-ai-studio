const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function browser({ brokenImage = false, brokenVoice = false } = {}) {
  const frames = [], tracks = [{ stop() { this.stopped = true; } }];
  let clock = 0, closed = false;
  class Image extends EventTarget {
    constructor() { super(); this.complete = !brokenImage; this.naturalWidth = brokenImage ? 0 : 1280; }
    set src(value) { if (brokenImage) queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
  }
  class Audio extends EventTarget {
    constructor() { super(); this.readyState = 1; this.duration = 8; }
    play() { return brokenVoice ? Promise.reject(Error('Playback denied')) : Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  }
  class AudioContext {
    state = 'running';
    createMediaElementSource() { return { connect() {} }; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ stop() { this.stopped = true; } }] } }; }
    resume() { return Promise.resolve(); }
    close() { closed = true; this.state = 'closed'; return Promise.resolve(); }
  }
  class MediaRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['test-video']) });
      queueMicrotask(() => this.onstop());
    }
  }
  const drawing = new Proxy({}, { get(target, name) {
    if (name === 'createRadialGradient' || name === 'createLinearGradient') return () => ({ addColorStop() {} });
    if (name === 'measureText') return () => ({ width: 100 });
    if (name === 'fillText') return text => frames.push(text);
    return () => {};
  } });
  const context = {
    window: { MediaRecorder, AudioContext }, HTMLCanvasElement: { prototype: { captureStream() {} } },
    MediaRecorder, Image, Audio, Blob, setTimeout, clearTimeout,
    document: { createElement: () => ({ getContext: () => drawing, captureStream: () => ({ getTracks: () => tracks, addTrack: track => tracks.push(track) }) }) },
    performance: { now: () => 0 },
    requestAnimationFrame(callback) { return setImmediate(() => { clock += 8000; callback(clock); }); },
    cancelAnimationFrame: clearImmediate
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function drawVideoFrame('), source.indexOf('async function generateSpeech(')), context);
  return { context, frames, tracks, isClosed: () => closed };
}

test('video export includes all 96 seconds of supported scenes and releases capture tracks', async () => {
  const { context, frames, tracks } = browser();
  const scenes = Array.from({ length: 12 }, (_, i) => ({ text: `Scene ${i + 1}`, seconds: 8, background: '#123456' }));
  const blob = await context.exportVideo({ title: 'Full video', scenes });
  assert(blob.size > 0); assert(frames.includes('Scene 12'));
  assert(tracks.every(track => track.stopped));
});

test('broken scene images fail clearly instead of silently exporting a different background', async () => {
  const { context } = browser({ brokenImage: true });
  await assert.rejects(context.exportVideo({ scenes: [{ text: 'Scene', seconds: 2, image: 'broken' }] }), /Imaginea scenei/);
});

test('failed voice playback releases recorder, tracks and audio context', async () => {
  const { context, tracks, isClosed } = browser({ brokenVoice: true });
  await assert.rejects(context.exportVideo({ title: 'Voice', voiceDataUrl: 'mock-audio', scenes: [{ text: 'Scene', seconds: 2, background: '#123456' }] }), /Playback denied/);
  assert(tracks.every(track => track.stopped)); assert(isClosed());
});

test('mixed creative specs keep valid notes and scenes when a model includes null entries', () => {
  const context = {}; vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function parseCreativeSpec('), source.indexOf('function downloadBlob(')), context);
  const music = context.parseCreativeSpec('```nova-music\n{"notes":[null,{"note":"C4","beats":1}]}\n```');
  assert.equal(music.spec.notes.length, 1);
  const video = context.parseCreativeSpec('```nova-video\n{"scenes":[null,{"text":"First"},{"text":"Second"}]}\n```');
  assert.equal(video.spec.scenes.length, 2);
});

test('an upstream AI authentication failure does not log the visitor out of Nova', async () => {
  let redirects = 0, providerError = true;
  const context = { state: { account: null }, window: { location: { replace() { redirects++; } } },
    fetch: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: 'Rejected', providerError }) }) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function api('), source.indexOf('function jsonBody(')), context);
  await assert.rejects(context.api('/api/media/speech'));
  assert.equal(redirects, 0);
  providerError = false;
  await assert.rejects(context.api('/api/auth/me'));
  assert.equal(redirects, 1);
});

test('image failure restores the prompt without overwriting a new draft', async () => {
  for (const newerDraft of ['', 'Un alt prompt']) {
    const nodes = { prompt: { value: 'Imaginea mea' }, generateImageBtn: { disabled: false } };
    const context = {
      el: id => nodes[id], setView() {}, addBubble() {}, resizePrompt() {}, jsonBody: value => value,
      document: { createElement: () => ({ remove() {} }) }, messageContainer: () => ({ append() {} }),
      api: async () => { nodes.prompt.value = newerDraft; throw Error('Provider failed'); }
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('async function generateImageFromPrompt('), source.indexOf('function addCreativeCard(')), context);
    await context.generateImageFromPrompt();
    assert.equal(nodes.prompt.value, newerDraft || 'Imaginea mea');
    assert.equal(nodes.generateImageBtn.disabled, false);
  }
});
