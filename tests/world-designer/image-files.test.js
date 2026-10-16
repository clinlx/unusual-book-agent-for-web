'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const VFS = require('../../src/world-designer/vfs.js');
const TempFiles = require('../../src/world-designer/temp-files.js');
const Images = require('../../src/world-designer/images.js');
const CardTools = require('../../src/world-designer/card-tools.js');
const Parser = require('../../skills/tavern-card-loader/scripts/extract-card.js');
const { card, png, metadata, chunk } = require('../integration/card-fixtures.cjs');

test('PNG gate skips pixels and unrelated metadata without invoking the full parser', async t => {
  let calls = 0;
  t.mock.method(Parser, 'load', async () => { calls++; throw Error('ordinary image must not be parsed'); });
  for (const bytes of [png(), png([chunk('IDAT', Buffer.from('chara\0ccv3\0{"name":"fake"}'))]),
    png([metadata('tEXt', 'Software', 'ordinary image')]), png([metadata('tEXt', 'Comment', 'plain photo description')]),
    Uint8Array.from([255,216,255])]) {
    assert.equal(Parser.probePng(bytes), null);
    assert.equal(await CardTools.inspectImage(bytes), null);
  }
  assert.equal(calls, 0);
});

test('PNG card detection validates text and compressed metadata, leaving ordinary comments as images', async () => {
  const json = JSON.stringify(card());
  for (const record of [metadata('tEXt', 'chara', Buffer.from(json).toString('base64')),
    metadata('zTXt', 'chara', json), metadata('iTXt', 'ccv3', json, true), metadata('tEXt', 'Comment', json)]) {
    assert.deepEqual(await Images.prepare(png([record]), { enabled: false }), { kind: 'tavern-card', status: 'confirmed' });
  }
  assert.equal(await CardTools.inspectImage(png([metadata('tEXt', 'Comment', 'plain photo description')])), null);
});

test('damaged card metadata and excessive chunk counts are quarantined instead of falling back to visual output', async t => {
  const broken = png([metadata('tEXt', 'ccv3', 'broken payload')]);
  assert.equal((await Images.prepare(broken)).status, 'suspected');
  const corrupt = png([metadata('tEXt', 'chara', JSON.stringify(card()))]);
  corrupt[47] ^= 1;
  assert.equal((await Images.prepare(corrupt)).status, 'suspected');
  const many = png(Array.from({ length: 8192 }, () => chunk('ruSt')));
  t.mock.method(Parser, 'load', () => { throw Error('chunk limit must stop before full parsing'); });
  assert.equal((await Images.prepare(many)).reason, 'chunk-limit');
});

test('intercepted cards preserve original bytes and emit only a file path and extraction hint', async () => {
  const bytes = png([metadata('tEXt', 'chara', JSON.stringify(card()))]), tree = VFS.createTree();
  const ref = Images.store(tree, '/tmp/tavern-cards/source.img', bytes, await Images.prepare(bytes));
  assert.equal(ref.path, '/tmp/tavern-cards/source.png');
  const node = Images.resolve(tree, ref.path);
  assert.deepEqual(VFS.fileBytes(node), new Uint8Array(bytes));
  assert.equal(node.image, undefined);
  assert.equal(node.tmp.idleTurns, 0);
  for (const enabled of [true, false]) {
    const content = Images.messageContent({ content: '', msgId: 'card', attachments: [ref] }, tree, { enabled, activeId: 'card' });
    assert.equal(typeof content, 'string');
    assert.match(content, /疑似 PNG 角色卡文件/); assert.match(content, /parse_tavern_card/);
    assert.ok(content.includes(ref.path)); assert.doesNotMatch(content, /base64|这是原卡素材|<script/);
  }
  const output = JSON.parse((await CardTools.parse(tree, { path: ref.path, raw_only: true })).result);
  assert.equal(output.card_found, true);
  VFS.deletePath(tree, ref.path);
  assert.match(Images.messageContent({ attachments: [ref] }, tree), /过期/);
});

test('old visual previews are reclassified once, and mixed messages only send ordinary image pixels', async () => {
  const tree = VFS.createTree(), bytes = png([metadata('tEXt', 'ccv3', JSON.stringify(card()))]);
  VFS.writeFile(tree, '/tmp/old-card.png', Images.base64(bytes), { encoding: 'base64' });
  Images.resolve(tree, '/tmp/old-card.png').image = { dataUrl: 'data:image/png;base64,OLD_CARD_COVER' };
  const ref = { path: '/tmp/old-card.png' };
  assert.equal(await Images.checkReference(tree, ref), true);
  assert.equal(await Images.checkReference(tree, ref), false);
  assert.equal(ref.kind, 'tavern-card');
  const photo = Images.store(tree, '/tmp/photo.png', png(), { dataUrl: 'data:image/png;base64,PHOTO', cardCheckVersion: 1 });
  const content = Images.messageContent({ msgId: 'mixed', attachments: [ref, photo] }, tree, { enabled: true, activeId: 'mixed' });
  assert.equal(content.length, 2);
  assert.equal(content[1].image_url.url, 'data:image/png;base64,PHOTO');
  assert.doesNotMatch(JSON.stringify(content), /OLD_CARD_COVER/);
});

test('card inspection aborts propagate and never turn cancelled work into a suspicious file', async () => {
  let checks = 0;
  await assert.rejects(CardTools.inspectImage(png([metadata('zTXt', 'chara', JSON.stringify(card()))]), {
    check: () => { if (++checks > 1) throw new DOMException('cancelled', 'AbortError'); },
  }), { name: 'AbortError' });
});

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
