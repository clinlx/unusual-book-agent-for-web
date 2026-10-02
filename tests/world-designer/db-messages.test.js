'use strict';
// messages 拆表：Node 下走 memoryMode 分支（indexedDB 不存在 → open 落入降级），
// 键序、追加、限量读取、按会话删除的语义与 IndexedDB 分支一致。
const test = require('node:test');
const assert = require('node:assert');
const DB = require('../../src/world-designer/db.js');

test.before(async () => { await DB.open(); assert.ok(DB.isMemoryMode(), 'Node 下应进入内存降级'); });

test('putMessages / getMessages 保持顺序往返', async () => {
  await DB.putMessages('s1', [
    { role: 'user', content: '一' },
    { role: 'assistant', content: '二' },
    { role: 'user', content: '三' },
  ]);
  const back = await DB.getMessages('s1');
  assert.deepStrictEqual(back.map(m => m.content), ['一', '二', '三']);
  // 内部管理字段不应泄漏回消息对象
  assert.ok(!('sessionId' in back[0]) && !('seq' in back[0]) && !('id' in back[0]));
});

test('appendMessages 只追加，不动已有消息', async () => {
  await DB.putMessages('s2', [{ role: 'user', content: 'a' }]);
  await DB.appendMessages('s2', [{ role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], 1);
  const back = await DB.getMessages('s2');
  assert.deepStrictEqual(back.map(m => m.content), ['a', 'b', 'c']);
});

test('getMessages limit 取的是最后 N 条', async () => {
  await DB.putMessages('s3', Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: '第' + i })));
  const tail = await DB.getMessages('s3', { limit: 3 });
  assert.deepStrictEqual(tail.map(m => m.content), ['第7', '第8', '第9']);
});

test('countMessages / delMessages 只影响目标会话', async () => {
  await DB.putMessages('sA', [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }]);
  await DB.putMessages('sB', [{ role: 'user', content: 'z' }]);
  assert.strictEqual(await DB.countMessages('sA'), 2);
  assert.strictEqual(await DB.countMessages('sB'), 1);
  await DB.delMessages('sA');
  assert.strictEqual(await DB.countMessages('sA'), 0);
  assert.strictEqual(await DB.countMessages('sB'), 1, '删 sA 不能伤到 sB');
});

test('putMessages 整段覆盖会清掉旧的多余条目', async () => {
  await DB.putMessages('s4', Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: 'v1-' + i })));
  await DB.putMessages('s4', [{ role: 'user', content: 'v2-0' }]);   // 变短
  const back = await DB.getMessages('s4');
  assert.deepStrictEqual(back.map(m => m.content), ['v2-0'], '旧的 4 条不该残留');
  assert.strictEqual(await DB.countMessages('s4'), 1);
});

test('会话隔离：id 前缀相似不串扰', async () => {
  await DB.putMessages('ab', [{ role: 'user', content: 'AB' }]);
  await DB.putMessages('abc', [{ role: 'user', content: 'ABC' }]);
  assert.deepStrictEqual((await DB.getMessages('ab')).map(m => m.content), ['AB']);
  assert.deepStrictEqual((await DB.getMessages('abc')).map(m => m.content), ['ABC']);
});

/* ---------- 尾部载入：压缩块 / token 上限做边界 ---------- */

test('getMessagesTailWhile 在压缩块处停下，并把压缩块本身收进来', async () => {
  await DB.putMessages('t1', [
    { role: 'user', content: '很早的提问' },
    { role: 'assistant', content: '很早的回答' },
    { role: 'compressed', summary: '早前摘要', count: 2 },
    { role: 'user', content: '最近的提问' },
    { role: 'assistant', content: '最近的回答' },
  ]);
  const r = await DB.getMessagesTailWhile('t1', m => m.role !== 'compressed');
  assert.deepStrictEqual(r.messages.map(m => m.role),
    ['compressed', 'user', 'assistant'], '摘要块是边界，且要一起留下');
  assert.strictEqual(r.fromSeq, 2, '首条的库内序号');
  assert.strictEqual(r.hasMore, true, '前面还有未载入的');
});

test('getMessagesTailWhile 读到头时 hasMore 为假、fromSeq 归零', async () => {
  await DB.putMessages('t2', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  const r = await DB.getMessagesTailWhile('t2', () => true);
  assert.deepStrictEqual(r.messages.map(m => m.content), ['a', 'b']);
  assert.strictEqual(r.fromSeq, 0);
  assert.strictEqual(r.hasMore, false, '全部载入后不该说还有更多');
});

test('getMessagesTailWhile 空会话返回空数组', async () => {
  const r = await DB.getMessagesTailWhile('t-empty', () => true);
  assert.deepStrictEqual(r.messages, []);
  assert.strictEqual(r.fromSeq, 0);
  assert.strictEqual(r.hasMore, false);
});

test('getMessagesTailWhile 按累计 token 停下', async () => {
  await DB.putMessages('t3', Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: '第' + i })));
  let n = 0;
  const r = await DB.getMessagesTailWhile('t3', () => ++n < 5);
  assert.strictEqual(r.messages.length, 5, '触发停止的那条也收下');
  assert.deepStrictEqual(r.messages.map(m => m.content), ['第15', '第16', '第17', '第18', '第19']);
  assert.strictEqual(r.fromSeq, 15);
});

test('getMessagesRange 取指定区间，右开左闭', async () => {
  await DB.putMessages('t4', Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: 'm' + i })));
  const seg = await DB.getMessagesRange('t4', 2, 5);
  assert.deepStrictEqual(seg.map(m => m.content), ['m2', 'm3', 'm4']);
  assert.deepStrictEqual(await DB.getMessagesRange('t4', 3, 3), [], '空区间返回空');
  const head = await DB.getMessagesRange('t4', 0, 2);
  assert.deepStrictEqual(head.map(m => m.content), ['m0', 'm1']);
});

test('putMessages 带 fromSeq 只覆盖尾段，前缀原样保留', async () => {
  await DB.putMessages('t5', Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: 'old' + i })));
  // 模拟「只载入尾部 3 条，改动后回写」：前 3 条不该被动
  await DB.putMessages('t5', [{ role: 'user', content: 'new3' }, { role: 'user', content: 'new4' }], 3);
  const all = await DB.getMessages('t5');
  assert.deepStrictEqual(all.map(m => m.content), ['old0', 'old1', 'old2', 'new3', 'new4'],
    '前缀保留，尾段被替换且变短的部分被清掉');
  assert.strictEqual(await DB.countMessages('t5'), 5);
});
