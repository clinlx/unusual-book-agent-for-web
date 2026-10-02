'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Agent = require('../../src/world-designer/agent.js');
const { AGENT_CONFIG } = require('../../src/world-designer/00-config.js');
const VFS = require('../../src/world-designer/vfs.js');

test('view_image sends actual image only after all tool results and persists no image bytes', async () => {
  const calls = [
    { id: 'img', type: 'function', function: { name: 'view_image', arguments: '{"path":"/workspace/a.png"}' } },
    { id: 'ls', type: 'function', function: { name: 'list_dir', arguments: '{"path":"/workspace"}' } },
  ];
  const tree = VFS.createTree(); VFS.mkdirp(tree, ['workspace']);
  const ctx = { tree, config: AGENT_CONFIG, viewImage: async () => ({ dataUrl: 'data:image/png;base64,AAAA', width: 5, height: 5 }) };
  let request = 0;
  const result = await Agent.runTurn(ctx, [{ role: 'user', content: '看图' }], async msgs => {
    if (++request === 1) return { tool_calls: calls };
    assert.deepEqual(msgs.slice(-3).map(m => m.role), ['tool', 'tool', 'user']);
    assert.equal(msgs.at(-1).content[1].image_url.url, 'data:image/png;base64,AAAA');
    return { content: '看到了' };
  });
  assert.ok(!JSON.stringify(result.newMessages).includes('base64'));
  assert.match(result.newMessages[1].content, /a.png/);
});

test('view_image is rejected when unavailable and async decode failures become tool errors', async () => {
  assert.match(Agent.executeTool({ config: AGENT_CONFIG }, 'view_image', { path: '/workspace/a.png' }).result, /关闭|不可用/);
  const ctx = { config: AGENT_CONFIG, viewImage: async () => { throw new Error('无法解码图片'); } };
  let requests = 0;
  await Agent.runTurn(ctx, [{ role: 'user', content: '看图' }], async msgs => {
    if (++requests === 1) return { tool_calls: [{ id: 'img', type: 'function', function: { name: 'view_image', arguments: '{"path":"/workspace/a.png"}' } }] };
    assert.match(msgs.at(-1).content, /无法解码/);
    return { content: '图片无效' };
  });
});
