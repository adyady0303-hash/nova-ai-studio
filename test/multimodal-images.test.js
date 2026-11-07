const test = require('node:test');
const assert = require('node:assert/strict');
const { generateProfileImage, listProfileImageModels, listProfileModels, createProfilesFromEnv, PLATFORM_PRESETS } = require('../ai-providers');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const profile = id => ({id, apiKey: 'fixture-image-key', imageModel: id === 'gemini' ? 'models/gemini-fixture-image' : 'vendor/image-model'});
const response = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('Gemini and OpenRouter advertise images without claiming speech support and accept image environment models', () => {
  const configured = Object.fromEntries(createProfilesFromEnv({GEMINI_IMAGE_MODEL: 'models/gemini-fixture-image', OPENROUTER_IMAGE_MODEL: 'vendor/image-model'}).map(p => [p.id,p]));
  for (const id of ['gemini','openrouter']) {
    assert.equal(PLATFORM_PRESETS[id].capabilities.image, true);
    assert.equal(PLATFORM_PRESETS[id].capabilities.imageEdit, true);
    assert.equal(PLATFORM_PRESETS[id].capabilities.speech, false);
  }
  assert.equal(configured.gemini.imageModel, 'gemini-fixture-image');
  assert.equal(configured.openrouter.imageModel, 'vendor/image-model');
});

for (const editing of [false,true]) test(`Gemini native ${editing ? 'editing' : 'generation'} uses the image model and native authentication`, async () => {
  const result = await generateProfileImage(profile('gemini'), 'Un peisaj albastru', {
    ...(editing ? {image: {bytes: Buffer.from(png,'base64'), mime: 'image/png'}} : {}),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture-image:generateContent');
      assert.equal(options.headers['x-goog-api-key'], 'fixture-image-key');
      assert.equal(options.headers.authorization, undefined);
      const body = JSON.parse(options.body);
      assert.deepEqual(body.generationConfig.responseModalities, ['TEXT','IMAGE']);
      assert.equal(body.contents[0].parts[0].text, 'Un peisaj albastru');
      assert.equal(body.contents[0].parts.length, editing ? 2 : 1);
      if (editing) assert.deepEqual(body.contents[0].parts[1].inlineData, {mimeType: 'image/png',data: png});
      return response({candidates: [{content: {parts: [
        {thought: true,inlineData: {mimeType: 'image/png',data: 'dGhvdWdodA=='}},
        {text: 'Imaginea solicitată'}, {inlineData: {mimeType: 'image/jpeg',data: png}}
      ]}}]});
    }
  });
  assert.deepEqual(result.data[0], {b64_json: png,output_format: 'jpeg'});
});

for (const editing of [false,true]) test(`OpenRouter dedicated image ${editing ? 'editing' : 'generation'} preserves its documented schema`, async () => {
  const result = await generateProfileImage(profile('openrouter'), 'O ilustrație', {
    ...(editing ? {image: Buffer.from(png,'base64')} : {}),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/images');
      assert.equal(options.headers.authorization, 'Bearer fixture-image-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'vendor/image-model');
      assert.equal(body.prompt, 'O ilustrație');
      assert.equal(body.n, 1);
      if (editing) assert.deepEqual(body.input_references, [{type:'image_url',image_url:{url:`data:image/png;base64,${png}`}}]);
      else assert.equal(body.input_references, undefined);
      return response({data:[{b64_json:png,media_type:'image/webp'}]});
    }
  });
  assert.equal(result.data[0].output_format,'webp');
});

test('text-only, thought-only, blocked and unsafe image outputs are never presented as generated images', async () => {
  const scenarios = [
    ['gemini',{candidates:[{content:{parts:[{text:'Cannot create images'}]}}]},502],
    ['gemini',{candidates:[{content:{parts:[{thought:true,inlineData:{mimeType:'image/png',data:png}}]}}]},502],
    ['gemini',{promptFeedback:{blockReason:'SAFETY'}},422],
    ['gemini',{candidates:[{finishReason:'IMAGE_SAFETY'}]},422],
    ['openrouter',{data:[{b64_json:png,media_type:'image/svg+xml'}]},502],
    ['openrouter',{choices:[{message:{content:'An image description'}}]},502],
    ['openrouter',{data:[{b64_json:'not base64 data'}]},502]
  ];
  for (const [id,payload,status] of scenarios) await assert.rejects(generateProfileImage(profile(id),'test',{fetchImpl:async()=>response(payload)}), e => e.status===status && e.provider===id);
});

test('image provider authentication and quota errors retain their status and are not retried', async () => {
  for (const id of ['gemini','openrouter']) for (const status of [401,402,403,429,503]) {
    let calls=0;
    await assert.rejects(generateProfileImage(profile(id),'test',{fetchImpl:async()=>{calls++;return response({error:{message:'fixture provider error'}},status);}}), e => e.status===status && e.provider===id);
    assert.equal(calls,1);
  }
});

test('Gemini image discovery follows native pages and excludes plain chat and Imagen predict models', async () => {
  let calls=0;
  const models=await listProfileImageModels(profile('gemini'),{fetchImpl:async(url,options)=>{
    assert.equal(options.headers['x-goog-api-key'],'fixture-image-key');
    if (++calls===1) {
      assert.match(url,/\/v1beta\/models\?pageSize=1000$/);
      return response({models:[{name:'models/gemini-2.5-flash'},{name:'models/imagen-fixture'},{name:'models/gemini-fixture-image',supportedGenerationMethods:['generateContent']}],nextPageToken:'page 2'});
    }
    assert.match(url,/pageToken=page%202$/);
    return response({models:[{name:'models/gemini-fixture-image'},{name:'models/gemini-next-image',supportedGenerationMethods:['generateContent']}]});
  }});
  assert.deepEqual(models,['gemini-fixture-image','gemini-next-image']);
  assert.equal(calls,2);
});

test('OpenRouter image discovery uses its image catalog rather than guessing from chat model names', async () => {
  const models=await listProfileImageModels(profile('openrouter'),{fetchImpl:async(url)=>{
    assert.equal(url,'https://openrouter.ai/api/v1/images/models');
    return response({data:[{id:'vendor/arbitrary-name',architecture:{output_modalities:['image']}},{id:'vendor/chat',architecture:{output_modalities:['text']}},{id:'vendor/image-model'}]});
  }});
  assert.deepEqual(models,['vendor/arbitrary-name','vendor/image-model']);
});

test('missing credentials and invalid native model identifiers are rejected before any network call', async () => {
  let calls=0;const fetchImpl=async()=>{calls++;return response({});};
  await assert.rejects(generateProfileImage({id:'gemini',imageModel:'gemini-fixture-image'},'test',{fetchImpl}), e=>e.status===400);
  await assert.rejects(generateProfileImage({...profile('gemini'),imageModel:'../../other-host'},'test',{fetchImpl}), e=>e.status===400);
  assert.equal(calls,0);
});

test('OpenRouter text discovery excludes image-only models using output metadata', async () => {
  const models=await listProfileModels(profile('openrouter'),{fallback:false,fetchImpl:async()=>response({data:[
    {id:'vendor/image-only',architecture:{output_modalities:['image']}},
    {id:'vendor/chat',architecture:{output_modalities:['text']}},
    {id:'vendor/multimodal',architecture:{output_modalities:['text','image']}}
  ]})});
  assert.deepEqual(models,['vendor/chat','vendor/multimodal']);
});

test('a malformed repeated Gemini catalog page cannot cause an unbounded loop', async () => {
  let calls=0;
  await assert.rejects(listProfileImageModels(profile('gemini'),{fetchImpl:async()=>{
    calls++;return response({models:[],nextPageToken:'repeated-page'});
  }}), e=>e.status===502&&e.failureKind==='invalid_response');
  assert.equal(calls,2);
});
