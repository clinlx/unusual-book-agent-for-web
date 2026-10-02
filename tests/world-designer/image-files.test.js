'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const VFS = require('../../src/world-designer/vfs.js');
const TempFiles = require('../../src/world-designer/temp-files.js');
const Images = require('../../src/world-designer/images.js');

test('tmp age survives serialization, reads reset it, workspace stays intact', () => {
  let tree = VFS.createTree();
  VFS.writeFile(tree, '/tmp/images/a.png', 'AAAA', { encoding: 'base64', now: 100 });
  VFS.writeFile(tree, '/workspace/a.png', 'AAAA', { encoding: 'base64', now: 100 });
  TempFiles.touch(tree, '/tmp/images/a.png', 100);
  for (let i = 0; i < 9; i++) TempFiles.sweep(tree, { now: 101 + i, advance: true, ttlTurns: 10 });
  tree = JSON.parse(JSON.stringify(tree));
  assert.equal(VFS.resolve(tree, ['tmp', 'images', 'a.png']).tmp.idleTurns, 9);
  TempFiles.touch(tree, '/tmp/images/a.png', 111);
  TempFiles.sweep(tree, { now: 111, advance: true, used: new Set(['/tmp/images/a.png']), ttlTurns: 10 });
  assert.equal(VFS.resolve(tree, ['tmp', 'images', 'a.png']).tmp.idleTurns, 0);
  for (let i = 0; i < 10; i++) TempFiles.sweep(tree, { now: 112 + i, advance: true, ttlTurns: 10 });
  assert.equal(VFS.resolve(tree, ['tmp', 'images', 'a.png']), null);
  assert.ok(VFS.resolve(tree, ['workspace', 'a.png']));
});

test('wall clock expiry and size cap remove old data including previews', () => {
  const tree = VFS.createTree();
  VFS.writeFile(tree, '/tmp/old.txt', 'x', { now: 10 });
  VFS.writeFile(tree, '/tmp/recent.txt', 'x', { now: 90 });
  VFS.resolve(tree, ['tmp', 'recent.txt']).image = { dataUrl: 'data:large-preview' };
  TempFiles.sweep(tree, { now: 100, maxAgeMs: 50, maxBytes: 1000 });
  assert.equal(VFS.resolve(tree, ['tmp', 'old.txt']), null);
  assert.ok(VFS.resolve(tree, ['tmp', 'recent.txt']));
  TempFiles.sweep(tree, { now: 100, maxBytes: 2 });
  assert.equal(VFS.resolve(tree, ['tmp', 'recent.txt']), null);
});

test('image reference history contains paths only, with clear expiry and disabled notices', () => {
  const tree = VFS.createTree();
  VFS.writeFile(tree, '/tmp/images/a.png', 'AAAA', { encoding: 'base64' });
  VFS.resolve(tree, ['tmp', 'images', 'a.png']).image = { dataUrl: 'data:image/png;base64,AAAA', width: 20, height: 10 };
  const msg = { role: 'user', msgId: 'one', content: '看看', attachments: [{ path: '/tmp/images/a.png' }] };
  assert.equal(Images.messageContent(msg, tree, { enabled: true, activeId: 'one' })[1].type, 'image_url');
  const history = Images.messageContent(msg, tree, { enabled: true });
  assert.match(history, /view_image/);
  assert.ok(!history.includes('base64'));
  assert.match(Images.messageContent(msg, tree, { enabled: false, activeId: 'one' }), /关闭/);
  VFS.deletePath(tree, '/tmp/images/a.png');
  assert.match(Images.messageContent(msg, tree, { enabled: true, activeId: 'one' }), /过期/);
});

test('resize and crop preserve aspect ratio, never upscale, validate coordinates', () => {
  assert.deepEqual(Images.fit(4000, 2000, 2048), { width: 2048, height: 1024 });
  assert.deepEqual(Images.fit(100, 50, 2048), { width: 100, height: 50 });
  assert.throws(() => Images.cropRect(100, 100, { x: 90, y: 0, width: 20, height: 10 }), /裁剪/);
});

test('magic bytes, not file extension, identify supported raster formats', () => {
  assert.equal(Images.detectMime(Uint8Array.from([137,80,78,71,13,10,26,10])), 'image/png');
  assert.equal(Images.detectMime(new TextEncoder().encode('<svg/>')), null);
  assert.equal(Images.detectMime(new TextEncoder().encode('fake.png')), null);
});

test('oversized dimensions are rejected before browser decoding', async () => {
  const bytes = new Uint8Array(24);
  bytes.set([137,80,78,71,13,10,26,10]);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(16, 100000); dv.setUint32(20, 1);
  await assert.rejects(Images.prepare(bytes), /边长/);
  dv.setUint32(16, 10000); dv.setUint32(20, 10000);
  await assert.rejects(Images.prepare(bytes), /像素/);
  dv.setUint32(16, 9000); dv.setUint32(20, 1000);
  assert.deepEqual(Images.dimensions(bytes, 'image/png'), { width: 9000, height: 1000 });
});

test('GIF, JPEG, BMP and all WebP header variants reject excessive source dimensions before decoding', async () => {
  const gif = Uint8Array.from([71,73,70,56,57,97,0x40,0x9c,1,0]); // 40000 x 1
  const jpeg = Uint8Array.from([255,216,255,192,0,11,8,0,1,0x9c,0x40,1,1,0x11,0]);
  const bmp = new Uint8Array(26); bmp.set([66,77]);
  const bdv = new DataView(bmp.buffer); bdv.setUint32(14, 40, true); bdv.setInt32(18, 40000, true); bdv.setInt32(22, 1, true);
  const webp = (kind, payload) => {
    const bytes = new Uint8Array(20 + payload.length), dv = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('RIFF')); bytes.set(new TextEncoder().encode('WEBP' + kind), 8);
    dv.setUint32(4, bytes.length - 8, true); dv.setUint32(16, payload.length, true); bytes.set(payload, 20);
    return bytes;
  };
  const extended = webp('VP8X', [0,0,0,0,0x3f,0x9c,0,0,0,0]);
  const lossy = webp('VP8 ', [0,0,0,0x9d,1,0x2a,0x10,0x27,0x10,0x27]); // 10000 x 10000
  const lossless = webp('VP8L', [0x2f,0xff,0xff,0xff,0x0f]); // 16384 x 16384
  for (const bytes of [gif, jpeg, bmp, extended, lossy, lossless]) await assert.rejects(Images.prepare(bytes), /边长|像素/);
});
