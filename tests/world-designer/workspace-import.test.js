'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Importer = require('../../src/world-designer/workspace-import.js');
const VFS = require('../../src/world-designer/vfs.js');
const ZIP = require('../../src/world-designer/zip.js');
const file = (name, bytes, relativePath = '') => ({ name, webkitRelativePath: relativePath,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer });

test('dropped ordinary files use the captured File even when entry.file fails on file URLs', async () => {
  const direct = file('local.txt', [65]);
  const data = { files: [direct], items: [{ getAsFile: () => direct, webkitGetAsEntry: () => ({
    name: 'local.txt', isFile: true, file: (_, fail) => fail(new DOMException('Malformed URI', 'EncodingError')),
  }) }] };
  assert.deepEqual(await Importer.droppedFiles(data), [direct]);
});

test('dropped directories preserve hierarchy and fail clearly without partially importing unreadable folders', async () => {
  const child = { isFile: true, name: 'child.txt', file: resolve => resolve({ ...file('child.txt', [66]), lastModified: 123, size: 1 }) };
  let batches = 0;
  const folder = { isDirectory: true, name: 'folder', createReader: () => ({ readEntries: resolve => resolve(batches++ ? [] : [child]) }) };
  const data = { files: [], items: [{ webkitGetAsEntry: () => folder }] };
  const result = await Importer.droppedFiles(data);
  assert.equal(result[1].webkitRelativePath, 'folder/child.txt');
  assert.equal(result[1].lastModified, 123);
  folder.createReader = () => ({ readEntries: (_, fail) => fail(new DOMException('Malformed URI', 'EncodingError')) });
  await assert.rejects(Importer.droppedFiles(data), /上传文件夹.*HTTP/);
});

test('folder paths and unknown text extensions are preserved', async () => {
  const entries = await Importer.prepare([file('note.custom', [104, 105], 'project/note.custom')]);
  const tree = VFS.createTree();
  Importer.apply(tree, '/workspace', entries);
  assert.equal(VFS.readFile(tree, '/workspace/project/note.custom').content, 'hi');
});

test('mixed ZIP imports retain binary bytes, text and empty folders', async () => {
  const zip = ZIP.makeZip([{ name: 'empty/' }, { name: 'text.md', text: 'hello' },
    { name: 'photo.png', bytes: Uint8Array.from([0, 255, 128]) }]);
  const entries = await Importer.prepare([{ name: 'test.zip', arrayBuffer: () => zip.arrayBuffer() }], { extractZip: true });
  assert.equal(entries.filter(e => e.encoding === 'base64').length, 1);
  const tree = VFS.createTree();
  Importer.apply(tree, '/workspace', entries);
  assert.equal(VFS.resolve(tree, ['workspace', 'empty']).type, 'dir');
  assert.deepEqual(VFS.fileBytes(VFS.resolve(tree, ['workspace', 'photo.png'])), Uint8Array.from([0, 255, 128]));
});

test('unsafe archive paths cannot escape or pollute the workspace', async () => {
  for (const name of ['../escape.txt', '/tmp/escape.txt', 'a/../../escape.txt', '__proto__/bad', 'C:/bad']) {
    const zip = ZIP.makeZip([{ name, text: 'bad' }]);
    await assert.rejects(Importer.prepare([{ name: 'bad.zip', arrayBuffer: () => zip.arrayBuffer() }], { extractZip: true }), /路径/);
  }
});

test('import collision preserves existing files and nested folder layout', async () => {
  const tree = VFS.createTree();
  VFS.writeFile(tree, '/workspace/project', 'existing');
  const entries = await Importer.prepare([file('a.txt', [65], 'project/a.txt'), file('b.txt', [66], 'project/b.txt')]);
  const preview = Importer.plan(tree, '/workspace', entries);
  assert.equal(preview.conflicts.length, 1);
  assert.equal(preview.conflicts[0].canReplace, false);
  assert.throws(() => Importer.apply(tree, '/workspace', entries), /冲突/);
  Importer.apply(tree, '/workspace', entries, { [preview.conflicts[0].id]: 'keep' });
  assert.equal(VFS.readFile(tree, '/workspace/project').content, 'existing');
  assert.equal(VFS.readFile(tree, '/workspace/project-2/a.txt').content, 'A');
  assert.equal(VFS.readFile(tree, '/workspace/project-2/b.txt').content, 'B');
});

test('ordinary upload preserves ZIP while explicit archive upload extracts it', async () => {
  const zip = ZIP.makeZip([{ name: 'inner.txt', text: 'hello' }]);
  const files = [{ name: 'test.zip', lastModified: 123456, arrayBuffer: () => zip.arrayBuffer() }];
  const entries = await Importer.prepare(files);
  assert.equal(entries[0].name, 'test.zip');
  assert.equal(entries[0].encoding, 'base64');
  assert.equal(entries[0].mtime, 123456);
  assert.equal(entries[0].size, zip.size);
  await assert.rejects(Importer.prepare([file('a.txt', [65])], { extractZip: true }), /ZIP/);
});

test('ZIP modification dates survive export and import within DOS two-second precision', async () => {
  const mtime = new Date(2025, 4, 3, 12, 13, 24).getTime();
  const archive = ZIP.makeZip([{ name: 'dated.txt', text: 'dated', mtime }, { name: 'unknown.txt', text: 'unknown' }]);
  const entries = await Importer.prepare([{ name: 'test.zip', arrayBuffer: () => archive.arrayBuffer() }], { extractZip: true });
  assert.equal(entries[0].mtime, mtime);
  assert.equal(entries[1].mtime, null);
});

test('conflicts are reviewed without mutations and support independent choices', async () => {
  const tree = VFS.createTree();
  for (const name of ['a', 'b', 'c']) VFS.writeFile(tree, '/workspace/' + name, 'old', { now: 100 });
  const entries = await Importer.prepare(['a', 'b', 'c'].map(name => ({ ...file(name, [65, 66]), lastModified: 200 })));
  const before = JSON.stringify(tree), preview = Importer.plan(tree, '/workspace', entries);
  assert.equal(JSON.stringify(tree), before);
  assert.deepEqual(preview.conflicts.map(c => [c.existing.size, c.incoming.size, c.existing.mtime, c.incoming.mtime]),
    [[3, 2, 100, 200], [3, 2, 100, 200], [3, 2, 100, 200]]);
  assert.throws(() => Importer.apply(tree, '/workspace', entries), /冲突/);
  assert.equal(JSON.stringify(tree), before);
  const choices = Object.fromEntries(preview.conflicts.map((c, i) => [c.id, ['replace', 'skip', 'keep'][i]]));
  assert.equal(Importer.apply(tree, '/workspace', entries, choices), 2);
  assert.equal(VFS.readFile(tree, '/workspace/a').content, 'AB');
  assert.equal(VFS.readFile(tree, '/workspace/b').content, 'old');
  assert.equal(VFS.readFile(tree, '/workspace/c').content, 'old');
  assert.equal(VFS.readFile(tree, '/workspace/c-2').content, 'AB');
  assert.equal(VFS.resolve(tree, ['workspace', 'a']).mtime, 200);
});

test('batch duplicates and type collisions require choices; skipping folder skips descendants', () => {
  const tree = VFS.createTree();
  VFS.mkdirp(tree, ['workspace', 'dir']);
  const entries = [{ name: 'same', content: 'first' }, { name: 'same', content: 'second' }, { name: 'dir', content: 'file' }];
  const preview = Importer.plan(tree, '/workspace', entries);
  assert.equal(preview.conflicts.length, 2);
  assert.equal(preview.conflicts[0].existing.source, '本次上传');
  assert.equal(preview.conflicts[1].canReplace, false);
  assert.throws(() => Importer.apply(tree, '/workspace', entries, { 'file:1': 'keep', 'file:2': 'replace' }), /覆盖/);
  VFS.writeFile(tree, '/workspace/blocked', 'original');
  const skipped = Importer.plan(tree, '/workspace', [{ name: 'blocked/a', content: 'a' }, { name: 'blocked/b', content: 'b' }], { 'dir:blocked': 'skip' });
  assert.equal(skipped.count, 0);
  assert.equal(VFS.resolve(skipped.tree, ['workspace', 'blocked-2']), null);
});
