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
  const result = await Storage.estimate({ all: async key => stores[key], getMessages: async () => [] }, SEED_FILES);
  const p = result.perProject.get('p');
  assert.equal(p.files, 0); assert.equal(p.snapCount, 1); assert.ok(p.snaps > 0); assert.ok(p.chat > 0); assert.ok(p.other > 0);
  assert.equal(result.total, p.files + p.snaps + p.chat + p.other);
  assert.equal(result.perProject.has('empty'), false);
});
