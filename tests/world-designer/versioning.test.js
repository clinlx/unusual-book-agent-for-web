'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../../src/world-designer/versioning.js');

const snaps = [
  { id: 1, projectId: 'p', turnRef: { sessionId: 'A', msgIndex: 0 }, tree: { v: 1 }, createdAt: 10 },
  { id: 2, projectId: 'p', turnRef: { sessionId: 'A', msgIndex: 2 }, tree: { v: 2 }, createdAt: 20 },
  { id: 3, projectId: 'p', turnRef: { sessionId: 'B', msgIndex: 0 }, tree: { v: 3 }, createdAt: 30 },
  { id: 4, projectId: 'p', turnRef: { sessionId: 'A', msgIndex: 4 }, tree: { v: 4 }, createdAt: 40 },
];

test('planRollback 返回目标树与需删除的后续快照', () => {
  const plan = V.planRollback(snaps, 2);
  assert.deepStrictEqual(plan.restoreTree, { v: 2 });      // 快照存的是该轮开始前的状态
  assert.deepStrictEqual(plan.deleteIds, [2, 3, 4]);       // 目标及其后全部删除
});

test('planRollback 检测跨 Session 冲突', () => {
  const plan = V.planRollback(snaps, 2);
  assert.deepStrictEqual(plan.conflictSessions, ['B']);    // B 的进度将被丢弃
  const plan2 = V.planRollback(snaps, 4);
  assert.deepStrictEqual(plan2.conflictSessions, []);      // 4 之后无其他 Session 快照
});

test('planRollback 找不到快照时报错', () => {
  assert.throws(() => V.planRollback(snaps, 99), /不存在/);
});

test('findSnapshotForTurn 按 turnRef 查找', () => {
  const s = V.findSnapshotForTurn(snaps, 'A', 2);
  assert.strictEqual(s.id, 2);
  assert.strictEqual(V.findSnapshotForTurn(snaps, 'A', 99), null);
});

// 回归：msgIndex 是数组下标，删除其他轮次后会整体前移，导致历史轮次的
// 回滚按钮失配（表现为「只有最新一轮有按钮」）。改为优先用稳定的 msgId 匹配。
test('findSnapshotForTurn 优先按 msgId 匹配，不受下标变动影响', () => {
  const snaps = [
    { id: 's1', turnRef: { sessionId: 'A', msgIndex: 0, msgId: 'm-aaa' }, tree: {}, createdAt: 1 },
    { id: 's2', turnRef: { sessionId: 'A', msgIndex: 4, msgId: 'm-bbb' }, tree: {}, createdAt: 2 },
  ];
  // 删掉前面的轮次后，原本 index=4 的消息现在 index=2，但 msgId 不变
  assert.strictEqual(V.findSnapshotForTurn(snaps, 'A', 2, 'm-bbb').id, 's2');
  assert.strictEqual(V.findSnapshotForTurn(snaps, 'A', 0, 'm-aaa').id, 's1');
  // msgId 对不上时不应误匹配到同下标的其他快照
  assert.strictEqual(V.findSnapshotForTurn(snaps, 'A', 4, 'm-zzz'), null);
});

test('findSnapshotForTurn 对没有 msgId 的老数据回落到下标', () => {
  const legacy = [{ id: 'old', turnRef: { sessionId: 'A', msgIndex: 2 }, tree: {}, createdAt: 1 }];
  assert.strictEqual(V.findSnapshotForTurn(legacy, 'A', 2).id, 'old');
  assert.strictEqual(V.findSnapshotForTurn(legacy, 'A', 3), null);
});

test('findSnapshotForTurn 新旧数据混存时互不干扰', () => {
  const mixed = [
    { id: 'old', turnRef: { sessionId: 'A', msgIndex: 2 }, tree: {}, createdAt: 1 },
    { id: 'new', turnRef: { sessionId: 'A', msgIndex: 2, msgId: 'm-x' }, tree: {}, createdAt: 2 },
  ];
  // 带 msgId 查询命中新数据；不带 msgId 时只认没有 msgId 的老快照
  assert.strictEqual(V.findSnapshotForTurn(mixed, 'A', 2, 'm-x').id, 'new');
  assert.strictEqual(V.findSnapshotForTurn(mixed, 'A', 2).id, 'old');
});
