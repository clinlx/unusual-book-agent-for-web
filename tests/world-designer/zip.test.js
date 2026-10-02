'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const ZIP = require('../../src/world-designer/zip.js');

// 构造一个最小 zip（本地文件头 + 中央目录 + EOCD），支持 stored(0)/deflate(8)
function makeZip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  function u16(n) { return [n & 255, (n >> 8) & 255]; }
  function u32(n) { return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]; }
  for (const e of entries) {
    const nameBytes = Array.from(enc.encode(e.name));
    const raw = Array.from(enc.encode(e.content));
    let data, method;
    if (e.method === 8) { data = Array.from(zlib.deflateRawSync(Buffer.from(e.content))); method = 8; }
    else { data = raw; method = 0; }
    const crc = 0; // 校验不验证 CRC
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...data,
    ];
    const central = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...nameBytes,
    ];
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const centralStart = offset;
  const centralBytes = centrals.flat();
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(centralBytes.length), ...u32(centralStart), ...u16(0),
  ];
  return new Uint8Array([...locals.flat(), ...centralBytes, ...eocd]).buffer;
}

test('parseZip 列出条目（stored 与 deflate）', async () => {
  const buf = makeZip([
    { name: 'a.txt', content: 'hello', method: 0 },
    { name: 'dir/b.md', content: '你好世界', method: 8 },
  ]);
  const files = await ZIP.parseZip(buf);
  const map = Object.fromEntries(files.map(f => [f.name, f.text]));
  assert.strictEqual(map['a.txt'], 'hello');
  assert.strictEqual(map['dir/b.md'], '你好世界');
});

test('parseZip 对无 EOCD 的数据报错', async () => {
  await assert.rejects(() => ZIP.parseZip(new Uint8Array([1, 2, 3]).buffer), /不是有效的 zip/);
});

test('makeZip 生成的 zip 可被 parseZip 读回（含目录与中文）', async () => {
  const blob = ZIP.makeZip([
    { name: 'dir/' },
    { name: 'dir/a.txt', text: 'hello' },
    { name: 'b.md', text: '你好世界' },
  ]);
  const buf = await blob.arrayBuffer();
  const files = await ZIP.parseZip(buf);
  const map = Object.fromEntries(files.map(f => [f.name, f.text]));
  assert.strictEqual(map['dir/a.txt'], 'hello');
  assert.strictEqual(map['b.md'], '你好世界');
  assert.ok(files.find(f => f.name === 'dir/' && f.isDir));
});
