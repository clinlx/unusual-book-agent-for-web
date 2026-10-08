'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../src/game-core');
const VFS = require('../../src/vfs');
const Transport = require('../../src/game-transport');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function save() {
  const tree = VFS.createTree();
  VFS.writeFile(tree, '/workspace/Player-p/基础信息.json', '{"姓名":"玩家"}');
  VFS.writeFile(tree, '/workspace/Player-p/背包.json', '[]');
  return Core.createSave('预算测试', tree);
}
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: '完成' } }] }));

test('game rechecks after tool results, stops before a second request, and resumes without repeating writes', async () => {
  const s = save(); VFS.writeFile(s.tree, '/workspace/large.txt', '文'.repeat(4000)); Core.beginRound(s, '', true, '开局');
  let requests = 0;
  await assert.rejects(Core.run(s, async () => {
    requests++; return { tool_calls: [call('write', 'write_file', { path: '/workspace/proof.txt', content: '已经写入' }),
      call('read', 'read_file', { path: '/workspace/large.txt' })] };
  }, { system: '规则', cap: 1000 }), /上下文上限/);
  assert.equal(requests, 1); assert.equal(s.status, 'interrupted'); assert.equal(s.messages.filter(m => m.role === 'tool').length, 2);
  VFS.writeFile(s.tree, '/workspace/proof.txt', '中断后的手动编辑');
  await Core.run(s, async messages => {
    requests++; assert.ok(messages.some(m => m.tool_call_id === 'read' && m.content.includes('文')));
    return { tool_calls: [call('story', 'append_story', { content: '旅程继续。', one_line_summary_of_content: '继续旅程' }),
      call('end', 'end_the_round', { NEXT_TURN_CACHE: { Story_Phase: '游戏循环' } })] };
  }, { system: '规则', cap: 20000 });
  assert.equal(requests, 2); assert.equal(s.status, 'waiting');
  assert.equal(VFS.readFile(s.tree, '/workspace/proof.txt').content, '中断后的手动编辑');
  assert.equal(s.events.filter(e => e.callId === 'write').length, 1);
});

test('old-read compaction never matches a reused call ID from the current round', () => {
  const s = save(), old = JSON.stringify({ ok: true, result: { content: '旧'.repeat(6000) } }), current = JSON.stringify({ ok: true, result: { content: '新'.repeat(3000) } });
  s.round = 1; s.activeRound = { number: 2 };
  s.messages = [{ role: 'user', content: '第一轮', round: 1 }, { role: 'assistant', round: 1, tool_calls: [call('same', 'read_file', { path: '/workspace/old.txt' })] },
    { role: 'tool', tool_call_id: 'same', round: 1, content: old }, { role: 'user', content: '第二轮', round: 2 },
    { role: 'assistant', round: 2, tool_calls: [call('same', 'read_file', { path: '/workspace/current.txt' })] }, { role: 'tool', tool_call_id: 'same', round: 2, content: current }];
  const sent = Core.context(s, '系统', 4000), results = sent.filter(m => m.role === 'tool');
  assert.equal(JSON.parse(results[0].content).archived, true);
  assert.equal(results[1].content, current);
  assert.equal(s.messages[2].content, old); assert.equal(s.messages[5].content, current);
});

test('context transformations are accounted for before a game request', async () => {
  const s = save(); Core.beginRound(s, '', true, '开局'); let requests = 0;
  await assert.rejects(Core.run(s, async () => { requests++; return {}; }, {
    system: '展开', cap: 500, transformContext: text => text === '展开' ? '规'.repeat(2000) : text,
  }), /上下文上限/);
  assert.equal(requests, 0); assert.equal(s.messages[0].content, '开局');
});

test('game transport checks the final overridden messages, tools and output reservation before fetch', async () => {
  for (const customRequestBody of [
    { messages: [{ role: 'user', content: '文'.repeat(2000) }] },
    { tools: [{ type: 'function', function: { name: 'large', description: '规'.repeat(2000), parameters: {} } }] },
    { max_tokens: 2000 }, { max_completion_tokens: 2000 },
  ]) {
    let requests = 0, recorded = 0;
    const transport = Transport.create({ baseUrl: 'https://game.invalid/v1', maxContextK: 1, maxOutputTokens: 100, stream: false, customRequestBody: JSON.stringify(customRequestBody) }, [], {
      fetch: async () => { requests++; return reply(); }, onRequest: () => { recorded++; },
    });
    await assert.rejects(transport([{ role: 'user', content: '继续' }]), /上下文上限/);
    assert.equal(requests, 0); assert.equal(recorded, 0);
  }
});

test('game input budget uses merged tool definitions and output limits and does not clamp an invalid budget upward', () => {
  const tools = [{ type: 'function', function: { name: 'test', description: '规'.repeat(500), parameters: {} } }];
  const settings = { maxContextK: 4, maxOutputTokens: 100, customRequestBody: JSON.stringify({ max_tokens: 800, tools }) };
  assert.equal(Transport.inputBudget(settings, []), 4000 - 800 - Core.estimate(tools));
  assert.ok(Transport.inputBudget({ maxContextK: 1, maxOutputTokens: 2000 }, []) < 0);
});

test('provider context overflow reports recovery guidance and does not retry as a thinking-field failure', async () => {
  let requests = 0;
  const transport = Transport.create({ baseUrl: 'https://game.invalid/v1', maxContextK: 240, maxOutputTokens: 100, stream: false }, [], {
    fetch: async () => { requests++; return new Response('{"error":{"code":"context_length_exceeded","message":"reasoning plus input exceeds maximum context length"}}', { status: 400 }); },
  });
  await assert.rejects(transport([{ role: 'user', content: '继续' }]), e => e.code === 'CONTEXT_LIMIT' && e.message.includes('继续本轮'));
  assert.equal(requests, 1);
});
