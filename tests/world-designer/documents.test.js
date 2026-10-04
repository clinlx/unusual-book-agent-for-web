'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Documents = require('../../src/world-designer/documents');
const VFS = require('../../src/world-designer/vfs');
function fixture() {
  const tree = VFS.createTree(); VFS.writeFile(tree, '/workspace/source.docx', 'UEs=', { encoding: 'base64' });
  const args = { path: '/workspace/source.docx', format: 'text', output: 'return' };
  const runtime = { docx: async () => ({ text: '0123456789', info: {} }) };
  return { tree, args, runtime, parse(extra = {}, options = {}) { return Documents.parse(tree, { ...args, ...extra }, { runtime, ...options }); } };
}
test('text delivery bounds are explicit and saved text keeps the full extracted content', async () => {
  const f = fixture(), direct = JSON.parse((await f.parse({ offset: 2, limit: 3 })).result);
  assert.equal(direct.text, '234'); assert.equal(direct.total_characters, 10); assert.equal(direct.next_offset, 5);
  await f.parse({ output: 'file', output_path: '/workspace/export/text.txt' });
  assert.equal(VFS.readFile(f.tree, '/workspace/export/text.txt').content, '0123456789');
  await assert.rejects(f.parse({ output: 'file', output_path: '/workspace/export/text.txt' }), /已存在/);
});
test('document and output paths cannot escape writable roots or replace the original', async () => {
  const f = fixture(), before = JSON.stringify(f.tree);
  for (const path of ['/skills/a.docx', '/workspace/../a.docx', '/workspace/../../skills/a.docx', '/workspace/__proto__/a.docx', '/workspace/a\\b.docx', '/workspace//a.docx'])
    await assert.rejects(f.parse({ path }), /路径/);
  await assert.rejects(f.parse({ output: 'file', output_path: '/workspace/source.docx' }), /已存在/);
  await assert.rejects(f.parse({ output: 'file', output_path: '/skills/out.txt' }), /路径/);
  assert.equal(JSON.stringify(f.tree), before);
});
test('unsupported documents, invalid modes and missing output locations fail before parsing', async () => {
  const f = fixture();
  await assert.rejects(f.parse({ path: '/workspace/a.doc' }), /仅支持 PDF 和 DOCX/);
  await assert.rejects(f.parse({ path: '/workspace/missing.pdf' }), /不存在/);
  await assert.rejects(f.parse({ format: 'html' }), /format/);
  await assert.rejects(f.parse({ output: 'file' }), /路径/);
  await assert.rejects(f.parse({ output: 'file', output_path: '/workspace/text.txt', limit: 3 }), /仅用于/);
  await assert.rejects(f.parse({ format: 'images', offset: 0 }), /图片模式/);
  await assert.rejects(f.parse({ offset: -1 }), /offset/);
});
test('page ranges describe continuation and reject excess pages or non-integer bounds', () => {
  assert.deepEqual(Documents.pages(30, { format: 'images', start_page: 6 }), { start_page: 6, end_page: 10, total_pages: 30, next_page: 11 });
  for (const args of [{ start_page: 0 }, { start_page: 2, end_page: 1 }, { end_page: 31 }, { end_page: 6 }, { start_page: 1.5 }])
    assert.throws(() => Documents.pages(30, { format: 'images', ...args }), /页码/);
});
test('abort and source mutation during asynchronous parsing leave output paths untouched', async () => {
  for (const mutate of [false, true]) {
    const f = fixture(), controller = new AbortController();
    f.runtime.docx = async () => {
      if (mutate) VFS.writeFile(f.tree, f.args.path, 'UEtBQkM=', { encoding: 'base64' }); else controller.abort();
      return { text: 'parsed', info: {} };
    };
    await assert.rejects(f.parse({ output: 'file', output_path: '/workspace/out.txt' }, { signal: controller.signal }), /中止|变化/);
    assert.equal(VFS.resolve(f.tree, VFS.normalize('/workspace/out.txt')), null);
  }
});
test('image file outputs preserve PNG bytes and previews and do not partially overwrite on a conflict', async () => {
  const f = fixture(), image = page => ({ page, width: 10, height: 10, dataUrl: 'data:image/png;base64,AQID' });
  f.runtime.docx = async () => ({ info: { total_pages: 2 }, images: [image(1), image(2)] });
  VFS.writeFile(f.tree, '/workspace/pages/page-0002.png', 'existing');
  const before = JSON.stringify(f.tree);
  await assert.rejects(f.parse({ format: 'images', output: 'file', output_dir: '/workspace/pages' }), /已存在/);
  assert.equal(JSON.stringify(f.tree), before);
  const direct = await f.parse({ format: 'images' }); assert.equal(direct.images.length, 2); assert.equal(JSON.stringify(f.tree), before);
  const saved = JSON.parse((await f.parse({ format: 'images', output: 'file', output_dir: '/tmp/pages' })).result);
  const node = VFS.resolve(f.tree, VFS.normalize(saved.pages[0].path));
  assert.deepEqual([...VFS.fileBytes(node)], [1, 2, 3]); assert.equal(node.image.dataUrl, 'data:image/png;base64,AQID');
});
