'use strict';
const test = require('node:test');
const assert = require('node:assert');
const VFS = require('../../src/world-designer/vfs.js');

function freshTree() {
  const t = VFS.createTree();
  VFS.mkdirp(t, ['workspace']);
  VFS.mkdirp(t, ['skills']);
  return t;
}

test('normalize 规范化路径并拒绝越界', () => {
  assert.deepStrictEqual(VFS.normalize('/workspace/a//b/./c'), ['workspace', 'a', 'b', 'c']);
  assert.deepStrictEqual(VFS.normalize('workspace/a/../b'), ['workspace', 'b']);
  assert.throws(() => VFS.normalize('/workspace/../../etc'), /越界/);
});

test('writeFile 自动建父目录，readFile 读回', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/a/b/note.md', '你好', { now: 1 });
  const r = VFS.readFile(t, '/workspace/a/b/note.md');
  assert.strictEqual(r.content, '你好');
  assert.strictEqual(r.totalLength, 2);
  assert.strictEqual(r.truncated, false);
});

test('写入 workspace 之外被拒绝', () => {
  const t = freshTree();
  assert.throws(() => VFS.writeFile(t, '/skills/x.md', 'x'), /只允许写入/);
  assert.throws(() => VFS.writeFile(t, '/etc/passwd', 'x'), /只允许写入/);
});

test('读取 workspace 与 skills 之外被拒绝', () => {
  const t = freshTree();
  assert.throws(() => VFS.readFile(t, '/secret.txt'), /无权访问/);
});

test('listDir 返回名称/类型/大小', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/a.txt', 'abc', { now: 1 });
  VFS.mkdirp(t, VFS.normalize('/workspace/sub'));
  const ls = VFS.listDir(t, '/workspace').map(e => ({ name: e.name, type: e.type, size: e.size }));
  assert.deepStrictEqual(
    ls.sort((x, y) => x.name.localeCompare(y.name)),
    [{ name: 'a.txt', type: 'file', size: 3 }, { name: 'sub', type: 'dir', size: 0 }]
  );
  assert.throws(() => VFS.listDir(t, '/workspace/none'), /不存在/);
});

test('deletePath 递归删除，禁止删根', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/d/x.txt', '1', { now: 1 });
  VFS.deletePath(t, '/workspace/d');
  assert.strictEqual(VFS.resolve(t, ['workspace', 'd']), null);
  assert.throws(() => VFS.deletePath(t, '/workspace'), /不能删除/);
  assert.throws(() => VFS.deletePath(t, '/workspace/none'), /不存在/);
});

test('move 重命名并防止移入自身', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/d/x.txt', '1', { now: 1 });
  VFS.move(t, '/workspace/d', '/workspace/e');
  assert.ok(VFS.resolve(t, ['workspace', 'e', 'x.txt']));
  assert.strictEqual(VFS.resolve(t, ['workspace', 'd']), null);
  VFS.writeFile(t, '/workspace/f/y.txt', '2', { now: 1 });
  assert.throws(() => VFS.move(t, '/workspace/f', '/workspace/f/inner'), /自身内部/);
  assert.throws(() => VFS.move(t, '/workspace/e', '/workspace/f'), /已存在/);
});

test('copy 深拷贝互不影响，可从 skills 拷入 workspace', () => {
  const t = freshTree();
  VFS.mkdirp(t, ['skills', 'demo']);
  VFS.resolve(t, ['skills', 'demo']).children['t.md'] =
    { type: 'file', name: 't.md', content: '模板', mtime: 0 };
  VFS.copy(t, '/skills/demo/t.md', '/workspace/t.md');
  VFS.writeFile(t, '/workspace/t.md', '改动', { now: 2 });
  assert.strictEqual(VFS.resolve(t, ['skills', 'demo', 't.md']).content, '模板');
  assert.throws(() => VFS.copy(t, '/workspace/t.md', '/skills/x.md'), /只允许写入/);
});

test('readFile 超限截断并支持 offset/limit 分段', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/big.txt', 'x'.repeat(100), { now: 1 });
  const r1 = VFS.readFile(t, '/workspace/big.txt', { cap: 30 });
  assert.strictEqual(r1.returned, 30);
  assert.strictEqual(r1.truncated, true);
  assert.strictEqual(r1.totalLength, 100);
  const r2 = VFS.readFile(t, '/workspace/big.txt', { cap: 30, offset: 90 });
  assert.strictEqual(r2.returned, 10);
  assert.strictEqual(r2.truncated, false);
  const r3 = VFS.readFile(t, '/workspace/big.txt', { cap: 30, offset: 0, limit: 999 });
  assert.strictEqual(r3.returned, 30); // limit 不可超过 cap
  const r4 = VFS.readFile(t, '/workspace/big.txt', { cap: 30, offset: 1000 });
  assert.strictEqual(r4.returned, 0);
});

test('writeFile 超过 cap 报错', () => {
  const t = freshTree();
  assert.throws(() => VFS.writeFile(t, '/workspace/a.txt', 'x'.repeat(11), { cap: 10 }), /上限/);
});

test('applyPatch 唯一匹配替换；不唯一或找不到则报错', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/a.md', 'aaa bbb aaa', { now: 1 });
  assert.throws(() => VFS.applyPatch(t, '/workspace/a.md', 'aaa', 'z'), /多次/);
  assert.throws(() => VFS.applyPatch(t, '/workspace/a.md', 'ccc', 'z'), /未在文件中找到/);
  assert.throws(() => VFS.applyPatch(t, '/workspace/a.md', '', 'z'), /不能为空/);
  VFS.applyPatch(t, '/workspace/a.md', 'bbb', 'BBB', { now: 2 });
  assert.strictEqual(VFS.readFile(t, '/workspace/a.md').content, 'aaa BBB aaa');
  assert.throws(() => VFS.applyPatch(t, '/workspace/a.md', 'BBB', 'y'.repeat(50), { cap: 10 }), /上限/);
  assert.throws(() => VFS.applyPatch(t, '/skills/x.md', 'a', 'b'), /只允许写入/);
});

test('search 同时匹配文件名与内容，按 target 过滤', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/notes/todo.md', '第一行\nTODO: 修复\n第三行', { now: 1 });
  VFS.writeFile(t, '/workspace/todo-list.txt', '无关内容', { now: 1 });
  const both = VFS.search(t, { pattern: 'todo', target: 'both' });
  // 大小写敏感：'todo' 匹配文件名 todo.md 与 todo-list.txt，不匹配内容 'TODO'
  assert.deepStrictEqual(both.hits.map(h => h.kind).sort(), ['name', 'name']);
  const content = VFS.search(t, { pattern: 'TODO', target: 'content' });
  assert.strictEqual(content.hits.length, 1);
  assert.strictEqual(content.hits[0].path, '/workspace/notes/todo.md');
  assert.strictEqual(content.hits[0].line, 2);
  const name = VFS.search(t, { pattern: '^todo', target: 'name' });
  assert.strictEqual(name.hits.length, 2);
});

test('search 非法正则报错、结果封顶', () => {
  const t = freshTree();
  assert.throws(() => VFS.search(t, { pattern: '([' }), /非法正则/);
  for (let i = 0; i < 30; i++) VFS.writeFile(t, `/workspace/f${i}.txt`, 'hit', { now: 1 });
  const r = VFS.search(t, { pattern: 'hit', target: 'content', limit: 10 });
  assert.strictEqual(r.hits.length, 10);
  assert.strictEqual(r.capped, true);
});

test('overview 生成缩进树且可截断', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/a/x.md', '1', { now: 1 });
  VFS.writeFile(t, '/workspace/b.md', '2', { now: 1 });
  const s = VFS.overview(t);
  assert.match(s, /a\/\n  x\.md\nb\.md/);
  const cut = VFS.overview(t, 1);
  assert.match(cut, /已截断/);
  const empty = VFS.overview(freshTree());
  assert.strictEqual(empty, '(空)');
});
