'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../../src/world-designer/pending.js');

const mk = (before, after, turn) => ({ path: '/workspace/a.md', before, after, turn: turn || 1 });

// ---------- record ----------
test('record 记录变更；回到原状则移除', () => {
  const s = {};
  P.record(s, '/a', 'x', 'y', { scope: 'last' });
  assert.ok(s['/a']);
  P.record(s, '/a', 'y', 'x', { scope: 'last' });   // last 模式下 baseline 换成 y
  assert.strictEqual(s['/a'].before, 'y');
  const s2 = {};
  P.record(s2, '/a', 'x', 'x', { scope: 'last' });  // 无实质变更
  assert.strictEqual(s2['/a'], undefined);
});

test('scope=last 每轮覆盖 baseline，只审最后一次改动', () => {
  const s = {};
  P.record(s, '/a', 'v1', 'v2', { scope: 'last', turn: 1 });
  P.record(s, '/a', 'v2', 'v3', { scope: 'last', turn: 2 });
  assert.strictEqual(s['/a'].before, 'v2', 'baseline 应为上一轮结果');
  assert.strictEqual(s['/a'].after, 'v3');
});

test('scope=accumulate 保留最早 baseline，跨轮累积', () => {
  const s = {};
  P.record(s, '/a', 'v1', 'v2', { scope: 'accumulate', turn: 1 });
  P.record(s, '/a', 'v2', 'v3', { scope: 'accumulate', turn: 2 });
  assert.strictEqual(s['/a'].before, 'v1', 'baseline 应保持最初值');
  assert.strictEqual(s['/a'].after, 'v3');
});

test('scope=accumulate 改回原状时移除条目', () => {
  const s = {};
  P.record(s, '/a', 'v1', 'v2', { scope: 'accumulate' });
  P.record(s, '/a', 'v2', 'v1', { scope: 'accumulate' });
  assert.strictEqual(s['/a'], undefined, '净变更为零应不再待审');
});

// ---------- hunks ----------
test('hunks 把连续增删归为一段，分离的算多段', () => {
  const e = mk('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng');
  const hs = P.hunks(e);
  assert.strictEqual(hs.length, 2, '两处不相邻的改动 = 两个 hunk');
  assert.ok(hs.every(h => h.type === 'mod'));
});

test('hunks 标注新旧行区间', () => {
  const e = mk('a\nb\nc', 'a\nX\nc');
  const h = P.hunks(e)[0];
  assert.strictEqual(h.oldStart, 2);
  assert.strictEqual(h.newStart, 2);
});

test('hunks 区分纯新增与纯删除', () => {
  assert.strictEqual(P.hunks(mk('a\nc', 'a\nb\nc'))[0].type, 'add');
  assert.strictEqual(P.hunks(mk('a\nb\nc', 'a\nc'))[0].type, 'del');
});

test('hunks 处理整文件新建与删除', () => {
  const add = P.hunks(mk(null, 'x\ny'));
  assert.strictEqual(add[0].type, 'add');
  assert.strictEqual(add[0].whole, true);
  const del = P.hunks(mk('x\ny', null));
  assert.strictEqual(del[0].type, 'del');
  assert.strictEqual(del[0].whole, true);
});

// ---------- summarize ----------
test('summarize 给出增删行数与 hunk 数', () => {
  const s = P.summarize(mk('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng'));
  assert.strictEqual(s.added, 2);
  assert.strictEqual(s.removed, 2);
  assert.strictEqual(s.hunks, 2);
});

test('summarize 新建/删除整文件', () => {
  assert.deepStrictEqual(P.summarize(mk(null, 'a\nb')), { added: 2, removed: 0, hunks: 1, whole: 'add' });
  assert.deepStrictEqual(P.summarize(mk('a\nb\nc', null)), { added: 0, removed: 3, hunks: 1, whole: 'del' });
});

// ---------- rebuild：核心正确性 ----------
test('rebuild 不拒绝任何 hunk = 保持 AI 的新内容', () => {
  const e = mk('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng');
  assert.strictEqual(P.rebuild(e, []), e.after);
});

test('rebuild 拒绝全部 hunk = 完全回退到 baseline', () => {
  const e = mk('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng');
  const allIds = P.hunks(e).map(h => h.id);
  assert.strictEqual(P.rebuild(e, allIds), e.before);
});

test('rebuild 只拒绝一个 hunk，另一个保留', () => {
  const e = mk('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng');
  const hs = P.hunks(e);
  // 拒绝第一处（b 的改动），保留第二处（f→F）
  assert.strictEqual(P.rebuild(e, [hs[0].id]), 'a\nb\nc\nd\ne\nF\ng');
  // 反过来
  assert.strictEqual(P.rebuild(e, [hs[1].id]), 'a\nB\nc\nd\ne\nf\ng');
});

test('rebuild 不丢失未变更区间（context 压缩陷阱）', () => {
  // 中间有大段未改动内容，若用 context:0 的 gap 重建会整段丢失
  const before = ['head', ...Array.from({ length: 30 }, (_, i) => 'keep' + i), 'tail'].join('\n');
  const after = before.replace('head', 'HEAD').replace('tail', 'TAIL');
  const e = mk(before, after);
  assert.strictEqual(P.rebuild(e, []), after);
  assert.strictEqual(P.rebuild(e, P.hunks(e).map(h => h.id)), before);
  const hs = P.hunks(e);
  const partial = P.rebuild(e, [hs[0].id]);
  assert.ok(partial.includes('keep15'), '中间未变更内容必须保留');
  assert.ok(partial.startsWith('head'), '被拒的首行回退');
  assert.ok(partial.endsWith('TAIL'), '未拒的尾行保留');
});

test('rebuild 处理纯新增 hunk', () => {
  const e = mk('a\nc', 'a\nb\nc');
  assert.strictEqual(P.rebuild(e, []), 'a\nb\nc');
  assert.strictEqual(P.rebuild(e, [0]), 'a\nc');
});

test('rebuild 处理纯删除 hunk', () => {
  const e = mk('a\nb\nc', 'a\nc');
  assert.strictEqual(P.rebuild(e, []), 'a\nc');
  assert.strictEqual(P.rebuild(e, [0]), 'a\nb\nc');
});

test('rebuild 整文件新建被拒 = 回到 null（删除）', () => {
  assert.strictEqual(P.rebuild(mk(null, 'x'), [0]), null);
});

test('rebuild 整文件删除被拒 = 恢复原内容', () => {
  assert.strictEqual(P.rebuild(mk('x\ny', null), [0]), 'x\ny');
});

test('rebuild 中文内容逐段接受/拒绝', () => {
  const e = mk('第一行\n第二行\n第三行', '第一行\n改过的第二行\n第三行');
  assert.strictEqual(P.rebuild(e, []), '第一行\n改过的第二行\n第三行');
  assert.strictEqual(P.rebuild(e, [0]), '第一行\n第二行\n第三行');
});

test('rebuild 多 hunk 任意组合都自洽', () => {
  const before = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9';
  const after = 'l1\nX2\nl3\nl4\nX5\nl6\nl7\nl8\nX9';
  const e = mk(before, after);
  const hs = P.hunks(e);
  assert.strictEqual(hs.length, 3);
  // 逐一枚举 8 种组合，确认每种都能正确重建
  for (let mask = 0; mask < 8; mask++) {
    const rejected = hs.filter((_, i) => mask & (1 << i)).map(h => h.id);
    const got = P.rebuild(e, rejected);
    const want = ['l1', mask & 1 ? 'l2' : 'X2', 'l3', 'l4', mask & 2 ? 'l5' : 'X5',
      'l6', 'l7', 'l8', mask & 4 ? 'l9' : 'X9'].join('\n');
    assert.strictEqual(got, want, 'mask=' + mask);
  }
});

// ---------- 目录红点 ----------
test('dirHasPending 判断目录下是否有待审变更', () => {
  const s = { '/workspace/docs/a.md': {}, '/workspace/b.md': {} };
  assert.strictEqual(P.dirHasPending(s, '/workspace/docs'), true);
  assert.strictEqual(P.dirHasPending(s, '/workspace/other'), false);
  assert.strictEqual(P.dirHasPending(s, '/workspace'), true);
});

test('dirHasPending 不把同前缀的兄弟目录算进来', () => {
  const s = { '/workspace/docs2/a.md': {} };
  assert.strictEqual(P.dirHasPending(s, '/workspace/docs'), false);
});

test('count 统计待审文件数', () => {
  assert.strictEqual(P.count({ '/a': {}, '/b': {} }), 2);
  assert.strictEqual(P.count({}), 0);
});
