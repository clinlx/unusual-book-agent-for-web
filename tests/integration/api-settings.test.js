'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameTransport = require('../../src/game-transport.js');
const Agent = require('../../src/world-designer/agent.js');

const root = 'https://settings.invalid/gateway/v1';
const addresses = [root, root + '/', root + '/chat/completions',
  root + '/chat/completions///', '  ' + root + '/chat/completions/  ',
  root + '/chat/completions/chat/completions'];
const settings = { apiKey: 'test-only', model: 'settings-test', stream: false, temperature: 0.7 };
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
  { headers: { 'Content-Type': 'application/json' } });

for (const [name, create] of [['game', GameTransport.create], ['designer', Agent.createHttpTransport]]) {
  test(name + ' sends chat requests to one endpoint for base and complete API addresses', async t => {
    const urls = [];
    const fetch = async url => { urls.push(url); return reply(); };
    t.mock.method(globalThis, 'fetch', fetch);
    for (const baseUrl of addresses) {
      const result = await create({ ...settings, baseUrl }, [], { fetch })([{ role: 'user', content: 'hello' }]);
      assert.equal(result.content, 'OK');
    }
    assert.deepEqual(urls, addresses.map(() => root + '/chat/completions'));
  });
}

test('game model listing accepts complete chat endpoints without using them as the API root', async () => {
  const urls = [];
  for (const baseUrl of addresses) {
    const result = await GameTransport.listModels({ ...settings, baseUrl }, {
      fetch: async url => {
        urls.push(url);
        return new Response(JSON.stringify({ data: [{ id: 'settings-test' }] }));
      },
    });
    assert.deepEqual(result.models, ['settings-test']);
  }
  assert.deepEqual(urls, addresses.map(() => root + '/models'));
});
