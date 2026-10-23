'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Storage = require('../../src/world-designer/storage');
const VFS = require('../../src/world-designer/vfs');
const { SEED_FILES } = require('../../src/world-designer/00-config');
function seed() {
  const tree = VFS.createTree(); VFS.mkdirp(tree, ['workspace']); VFS.mkdirp(tree, ['skills']);
  for (const [name, content] of Object.entries(SEED_FILES)) VFS.writeFile(tree, '/workspace/' + name, content);
  tree.children.skills.children['fixed.md'] = { type: 'file', content: '固定技能'.repeat(20000) };
  return tree;
}
test('fixed resources have no user footprint, but even shorter edited seeds count', () => {
  const tree = seed();
  assert.equal(Storage.fileBytes(tree, SEED_FILES), 0);
  VFS.writeFile(tree, '/workspace/README.md', '改');
  assert.ok(Storage.fileBytes(tree, SEED_FILES) > 0);
  VFS.writeFile(tree, '/workspace/README.md', SEED_FILES['README.md']);
  assert.equal(Storage.fileBytes(tree, SEED_FILES), 0, 'mtime changes alone do not count a restored seed');
  VFS.mkdirp(tree, ['workspace', '空目录']);
  assert.ok(Storage.fileBytes(tree, SEED_FILES) > 0, 'user-created empty folders remain counted');
});
test('temporary binary data, images and empty sessions are accounted for separately', () => {
  const tree = seed();
  VFS.mkdirp(tree, ['tmp']); VFS.writeFile(tree, '/tmp/image.png', 'aGVsbG8=');
  tree.children.tmp.children['image.png'].encoding = 'base64';
  assert.ok(Storage.fileBytes(tree, SEED_FILES) > 0);
  const session = { id: 'a', projectId: 'p', name: '新会话 1', createdAt: 1, msgCount: 0, attachmentVersion: 1, draft: null };
  assert.equal(Storage.chatBytes(session, []), 0);
  assert.ok(Storage.chatBytes({ ...session, draft: [{ t: 'image', v: 'base64-image' }] }, []) > 0);
  assert.ok(Storage.chatBytes(session, [{ role: 'user', content: '中文消息' }]) > '中文消息'.length);
});
test('totals include snapshots, pending changes, interrupted output, groups and nonempty drafts', async () => {
  const stores = {
    sessions: [{ id: 'a', projectId: 'p', name: '新会话', draft: [{ t: 'text', v: '草稿' }] }],
    snapshots: [{ id: 'snap', projectId: 'p', tree: seed() }],
    vfs: [{ id: 'p', tree: seed() }], groups: [{ id: 'g', projectId: 'p', name: '分组' }],
    config: [{ id: 'pending:p', value: { before: '旧文件' } }, { id: 'stream:p', value: { content: '未完成输出' } },
      { id: 'pending:empty', value: {} }, { id: 'world-validation:p', value: { checkedAt: 42, valid: true } }],
  };
  const result = await Storage.estimate({ storageRevisions: async () => ({}), get: async () => null, put: async () => {},
    iterate: async (name, visit) => { for (const record of stores[name] || []) visit(record); } }, SEED_FILES);
  const p = result.perProject.get('p');
  assert.equal(p.files, 0); assert.equal(p.snapCount, 1); assert.ok(p.snaps > 0); assert.ok(p.chat > 0); assert.ok(p.other > 0);
  assert.equal(result.total, p.files + p.snaps + p.chat + p.other);
  assert.equal(result.perProject.has('empty'), false);
});


test('bounded JSON sizing matches native JSON for escapes, Unicode and chunk boundaries', () => {
  for (const value of [null, true, false, 0, -0, NaN, Infinity, [undefined, , null], { skip: undefined, a: 1 },
    '"\\\n\t\u0001', '\ud800', '\udfff', '甲🌙'.repeat(20000), 'a'.repeat(16383) + '🌙',
    { a: '文字', nested: [new Date('2026-10-23T00:00:00Z'), { x: 'a'.repeat(40000) }] }]) {
    assert.equal(Storage.jsonBytes(value), Buffer.byteLength(JSON.stringify(value)));
    assert.equal(Storage.jsonChars(value), JSON.stringify(value).length);
  }
});

const DB = require('../../src/world-designer/db');
async function trackedDatabase() {
  await DB.open(); await DB.wipeAll();
  const scans = [], db = { ...DB, iterate: async (name, visit, options) => { scans.push(name); return DB.iterate(name, visit, options); },
    all: () => { throw Error('bulk read forbidden'); }, getMessages: () => { throw Error('full conversation read forbidden'); } };
  return { db, scans };
}
test('statistics persist only totals, reuse cache, and rescan only dirty stores', async () => {
  const { db, scans } = await trackedDatabase();
  await DB.put('sessions', { id: 's', projectId: 'p', name: '新会话', attachmentVersion: 1 });
  await DB.putMessages('s', [{ role: 'user', content: '保密正文' }]);
  await DB.putWorkspace('p', seed(), {});
  const first = await Storage.estimate(db, SEED_FILES);
  assert.equal(first.perProject.get('p').chat, Buffer.byteLength(JSON.stringify(await DB.getMessages('s'))));
  assert.equal(scans.length, 6);
  assert.doesNotMatch(JSON.stringify(await DB.get('config', 'storage-estimate:v1')), /保密正文/);
  scans.length = 0;
  assert.deepEqual(await Storage.estimate(db, SEED_FILES), first);
  assert.deepEqual(scans, []);
  const tree = seed(); VFS.writeFile(tree, '/workspace/世界.md', '新资料');
  await DB.putWorkspace('p', tree, {});
  const updated = await Storage.estimate(db, SEED_FILES);
  assert.ok(updated.total > first.total); assert.deepEqual(scans, ['vfs']);
  scans.length = 0;
  await DB.put('config', { id: 'settings', value: { model: 'changed' } });
  await Storage.estimate(db, SEED_FILES); assert.deepEqual(scans, []);
  await DB.delMessages('s'); await Storage.estimate(db, SEED_FILES); assert.deepEqual(scans, ['messages']);
});
test('cancelled, oversized and concurrent scans never publish a fresh cache', async () => {
  const { db } = await trackedDatabase();
  await DB.put('snapshots', { id: 'a', projectId: 'p', tree: seed() });
  await assert.rejects(Storage.estimate(db, SEED_FILES, { maxBytes: 1 }), /停止统计/);
  assert.equal(await DB.get('config', 'storage-estimate:v1'), undefined);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Storage.estimate(db, SEED_FILES, { signal: controller.signal }), { name: 'AbortError' });
  let changed = false;
  const racing = { ...db, iterate: async (name, visit, options) => {
    await db.iterate(name, visit, options);
    if (name === 'snapshots' && !changed) { changed = true; await DB.put('snapshots', { id: 'b', projectId: 'p' }); }
  } };
  assert.equal((await Storage.estimate(racing, SEED_FILES)).stale, true);
  assert.equal(await DB.get('config', 'storage-estimate:v1'), undefined);
  const final = await Storage.estimate(db, SEED_FILES);
  assert.equal(final.stale, false); assert.equal(final.perProject.get('p').snapCount, 2);
});
test('snapshot directory contains no trees, invalidates on writes and retains recoverable data', async () => {
  await trackedDatabase();
  await DB.put('snapshots', { id: 'a', projectId: 'p', tree: seed(), turnRef: { sessionId: 's', msgIndex: 0 }, createdAt: 1 });
  await DB.put('snapshots', { id: 'b', projectId: 'other', tree: seed(), createdAt: 2 });
  assert.deepEqual((await DB.snapshotHeaders('p')).map(s => s.id), ['a']);
  assert.ok(!(await DB.snapshotHeaders('p'))[0].tree);
  assert.ok((await DB.get('snapshots', 'a')).tree);
  await DB.delWhere('snapshots', s => s.projectId === 'p');
  assert.deepEqual(await DB.snapshotHeaders('p'), []);
  assert.equal((await DB.snapshotHeaders('other')).length, 1);
});
