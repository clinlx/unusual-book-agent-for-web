'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SSE = require('../../src/world-designer/sse.js');

test('splitSSE 处理跨块边界的 data 行', () => {
  const p = SSE.createParser();
  let events = [];
  events = events.concat(p.push('data: {"a":1}\n\ndata: {"b":'));
  events = events.concat(p.push('2}\n\n'));
  assert.deepStrictEqual(events, ['{"a":1}', '{"b":2}']);
});

test('accumulator 拼接流式文本增量', () => {
  const acc = SSE.createAccumulator();
  acc.add({ choices: [{ delta: { content: '你' } }] });
  acc.add({ choices: [{ delta: { content: '好' } }] });
  const r = acc.result();
  assert.strictEqual(r.content, '你好');
  assert.deepStrictEqual(r.tool_calls, []);
});

test('accumulator 按 index 组装分片 tool_calls', () => {
  const acc = SSE.createAccumulator();
  acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] });
  acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] });
  acc.add({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_dir', arguments: '' } }] } }] });
  const r = acc.result();
  assert.strictEqual(r.tool_calls.length, 2);
  assert.strictEqual(r.tool_calls[0].id, 'c1');
  assert.strictEqual(r.tool_calls[0].function.name, 'read_file');
  assert.strictEqual(r.tool_calls[0].function.arguments, '{"path":"a"}');
  assert.strictEqual(r.tool_calls[1].function.name, 'list_dir');
});

test('accumulator.partial 暴露流式中间快照', () => {
  const acc = SSE.createAccumulator();
  // 第一片只有工具名，参数还没开始
  acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '' } }] } }] });
  let p = acc.partial();
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].function.name, 'write_file', '工具名很早就到齐，可以先显示');
  // 参数逐字拼进来，中途是残缺 JSON
  acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/works' } }] } }] });
  p = acc.partial();
  assert.strictEqual(p[0].function.arguments, '{"path":"/works');
  assert.throws(() => JSON.parse(p[0].function.arguments), '中途确实不是合法 JSON');
  // 收齐后 partial 与 result 一致
  acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'pace/a.md","content":"hi"}' } }] } }] });
  assert.deepStrictEqual(acc.partial(), acc.result().tool_calls);
  assert.deepStrictEqual(JSON.parse(acc.partial()[0].function.arguments),
    { path: '/workspace/a.md', content: 'hi' });
});

test('accumulator.partial 在无工具调用时返回空数组', () => {
  const acc = SSE.createAccumulator();
  acc.add({ choices: [{ delta: { content: '只是文字' } }] });
  assert.deepStrictEqual(acc.partial(), []);
});

/* ---------- 思考内容（reasoning_content）---------- */

test('accumulator 拼接流式思考增量，与正文互不混淆', () => {
  const acc = SSE.createAccumulator();
  acc.add({ choices: [{ delta: { reasoning_content: '让我想' } }] });
  acc.add({ choices: [{ delta: { reasoning_content: '想…' } }] });
  acc.add({ choices: [{ delta: { content: '答案是' } }] });
  acc.add({ choices: [{ delta: { content: ' 42' } }] });
  const r = acc.result();
  assert.strictEqual(r.reasoning, '让我想想…');
  assert.strictEqual(r.content, '答案是 42', '思考不得混进正文');
});

test('accumulator 兼容 reasoning 字段名（部分实现不带 _content 后缀）', () => {
  const acc = SSE.createAccumulator();
  acc.add({ choices: [{ delta: { reasoning: '思路A' } }] });
  assert.strictEqual(acc.result().reasoning, '思路A');
});

test('readReasoning 只认字符串，对象形态的 reasoning 不算', () => {
  assert.strictEqual(SSE.readReasoning({ reasoning_content: '想法' }), '想法');
  assert.strictEqual(SSE.readReasoning({ reasoning: '想法2' }), '想法2');
  assert.strictEqual(SSE.readReasoning({ reasoning: { effort: 'high' } }), '', '对象不是思考文本');
  assert.strictEqual(SSE.readReasoning({}), '');
  assert.strictEqual(SSE.readReasoning(null), '');
  // reasoning_content 优先于 reasoning
  assert.strictEqual(SSE.readReasoning({ reasoning_content: 'A', reasoning: 'B' }), 'A');
});

test('accumulator 无思考内容时 reasoning 为空串', () => {
  const acc = SSE.createAccumulator();
  acc.add({ choices: [{ delta: { content: '纯正文' } }] });
  assert.strictEqual(acc.result().reasoning, '');
});
