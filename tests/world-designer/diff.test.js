'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../../src/world-designer/diff.js');

// ---------- 分词 ----------
test('tokenize 拉丁按词、数字成组、标点独立', () => {
  assert.deepStrictEqual(D.tokenize('foo_bar = 12.5;'), ['foo_bar', ' ', '=', ' ', '12.5', ';']);
});

test('tokenize 中文逐字切分（无空格语言的关键）', () => {
  assert.deepStrictEqual(D.tokenize('你好世界'), ['你', '好', '世', '界']);
});

test('tokenize 中英混排', () => {
  assert.deepStrictEqual(D.tokenize('设置 apiKey 为空'), ['设', '置', ' ', 'apiKey', ' ', '为', '空']);
});

// ---------- 行内词级 diff ----------
test('diffWords 只标出变化的词，其余为 eq', () => {
  const ops = D.diffWords('const a = 1;', 'const a = 42;');
  assert.strictEqual(ops.filter(o => o.type === 'eq').map(o => o.text).join(''), 'const a = ;');
  assert.deepStrictEqual(ops.filter(o => o.type === 'del').map(o => o.text), ['1']);
  assert.deepStrictEqual(ops.filter(o => o.type === 'add').map(o => o.text), ['42']);
});

test('diffWords 在中文句子里定位到改动的字（不退化为整行替换）', () => {
  const ops = D.diffWords('今天天气很好', '今天天气很差');
  const eq = ops.filter(o => o.type === 'eq').map(o => o.text).join('');
  assert.strictEqual(eq, '今天天气很');
  assert.deepStrictEqual(ops.filter(o => o.type === 'del').map(o => o.text), ['好']);
  assert.deepStrictEqual(ops.filter(o => o.type === 'add').map(o => o.text), ['差']);
});

test('diffWords 合并相邻同类 token', () => {
  const ops = D.diffWords('abc', 'xyz');
  assert.deepStrictEqual(ops, [{ type: 'del', text: 'abc' }, { type: 'add', text: 'xyz' }]);
});

test('diffWords 两边相同时全为 eq', () => {
  const ops = D.diffWords('same line', 'same line');
  assert.ok(ops.every(o => o.type === 'eq'));
});

// ---------- 行级 diff ----------
test('diffLines 纯新增：全部计入 added', () => {
  const r = D.diffLines('', 'a\nb\nc');
  assert.strictEqual(r.added, 3);
  assert.strictEqual(r.removed, 0);
});

test('diffLines 相似行配对为 mod，并给出新旧行号', () => {
  const r = D.diffLines('line one\nline two\nline three', 'line one\nline TWO changed\nline three');
  const mod = r.rows.find(x => x.type === 'mod');
  assert.ok(mod, '应产生 mod 行');
  assert.strictEqual(mod.oldNo, 2);
  assert.strictEqual(mod.newNo, 2);
  assert.strictEqual(r.changed, 1);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.removed, 1);
});

test('diffLines 完全不相似的行不配对，保持独立 del/add', () => {
  const r = D.diffLines('aaaaaaaa', 'zzzzzzzz');
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(r.rows.filter(x => x.type === 'del').length, 1);
  assert.strictEqual(r.rows.filter(x => x.type === 'add').length, 1);
});

test('diffLines 未变更区间压缩为 gap', () => {
  const oldT = Array.from({ length: 40 }, (_, i) => 'line' + i).join('\n');
  const newT = oldT.replace('line20', 'line20 modified');
  const r = D.diffLines(oldT, newT, { context: 2 });
  const gaps = r.rows.filter(x => x.type === 'gap');
  assert.ok(gaps.length >= 1, '应有 gap');
  assert.ok(r.rows.filter(x => x.type === 'eq').length <= 4, '上下文行应受 context 限制');
});

test('diffLines 保留公共前后缀不误报', () => {
  const r = D.diffLines('a\nb\nc', 'a\nb\nc');
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.removed, 0);
  assert.ok(r.rows.every(x => x.type === 'eq' || x.type === 'gap'));
});

test('diffLines 超长行被截断且不抛错', () => {
  const long = 'x'.repeat(D.LIMITS.maxLineChars + 500);
  const r = D.diffLines(long, long + 'y');
  const row = r.rows.find(x => x.type === 'mod' || x.type === 'add' || x.type === 'del');
  assert.ok(row);
  const text = row.newText || row.text;
  assert.ok(text.length < D.LIMITS.maxLineChars + 100, '超长行应被截断');
});

test('diffLines 行数超上限时置 truncated 标记', () => {
  const oldT = Array.from({ length: 600 }, (_, i) => 'a' + i).join('\n');
  const newT = Array.from({ length: 600 }, (_, i) => 'b' + i).join('\n');
  const r = D.diffLines(oldT, newT, { maxLines: 50 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.rows.length, 50);
});

test('diffLines 大文件不超时（退化路径可用）', () => {
  const oldT = Array.from({ length: 3000 }, (_, i) => 'line ' + i).join('\n');
  const newT = Array.from({ length: 3000 }, (_, i) => 'line ' + (i % 2 ? i : i + 'x')).join('\n');
  const t0 = process.hrtime.bigint();
  const r = D.diffLines(oldT, newT);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(r.rows.length > 0);
  assert.ok(ms < 4000, '耗时应在合理范围，实际 ' + ms.toFixed(0) + 'ms');
});

// ---------- 摘要 ----------
test('summarize create 统计全部行为新增', () => {
  assert.deepStrictEqual(D.summarize('create', '', 'a\nb'), { added: 2, removed: 0, changed: 0 });
});

test('summarize create 空文件为 0 行', () => {
  assert.deepStrictEqual(D.summarize('create', '', ''), { added: 0, removed: 0, changed: 0 });
});

test('summarize delete 统计全部行为删除', () => {
  assert.deepStrictEqual(D.summarize('delete', 'a\nb\nc', ''), { added: 0, removed: 3, changed: 0 });
});

test('summarize modify 与 diffLines 一致', () => {
  const s = D.summarize('modify', 'a\nb\nc', 'a\nB\nc\nd');
  assert.strictEqual(s.added, 2);
  assert.strictEqual(s.removed, 1);
});
