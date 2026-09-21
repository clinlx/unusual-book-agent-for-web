'use strict';
const ZIP = (() => {
  async function inflateRaw(bytes) {
    if (bytes.length === 0) return new Uint8Array(0);
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await stream.arrayBuffer());
  }

  async function parseZip(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('不是有效的 zip 文件');
    const count = dv.getUint16(eocd + 10, true);
    let ptr = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const files = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) throw new Error('中央目录损坏');
      const method = dv.getUint16(ptr + 10, true);
      const time = dv.getUint16(ptr + 12, true), date = dv.getUint16(ptr + 14, true);
      const month = (date >> 5) & 15, day = date & 31;
      const mtime = month >= 1 && month <= 12 && day >= 1 && day <= 31
        ? new Date(1980 + (date >> 9), month - 1, day, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime() : null;
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true);
      const extraLen = dv.getUint16(ptr + 30, true);
      const commentLen = dv.getUint16(ptr + 32, true);
      const localOff = dv.getUint32(ptr + 42, true);
      const name = dec.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = bytes.subarray(dataStart, dataStart + compSize);
      let raw;
      if (method === 0) raw = comp;
      else if (method === 8) raw = await inflateRaw(comp);
      else throw new Error('不支持的压缩方法: ' + method);
      const isDir = name.endsWith('/');
      files.push({ name, isDir, text: isDir ? '' : dec.decode(raw), bytes: raw, mtime });
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }
  function crc32(bytes) {
    const t = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  
  function makeZip(entries) {
    const enc = new TextEncoder();
    const locals = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const data = e.name.endsWith('/') ? new Uint8Array(0) : (e.bytes || enc.encode(e.text || ''));
      const crc = crc32(data);
      const stamp = Number.isFinite(e.mtime) ? new Date(e.mtime) : null;
      const valid = stamp && stamp.getFullYear() >= 1980 && stamp.getFullYear() <= 2107;
      const time = valid ? (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1) : 0;
      const date = valid ? ((stamp.getFullYear() - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate() : 0;
      const lh = new Uint8Array(30 + nameBytes.length + data.length);
      const ldv = new DataView(lh.buffer);
      ldv.setUint32(0, 0x04034b50, true);
      ldv.setUint16(4, 20, true);        
      ldv.setUint16(6, 0x0800, true);    
      ldv.setUint16(8, 0, true);         
      ldv.setUint16(10, time, true);
      ldv.setUint16(12, date, true);
      ldv.setUint32(14, crc, true);
      ldv.setUint32(18, data.length, true);
      ldv.setUint32(22, data.length, true);
      ldv.setUint16(26, nameBytes.length, true);
      ldv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      lh.set(data, 30 + nameBytes.length);
      locals.push(lh);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(ch.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, time, true);
      cdv.setUint16(14, date, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, data.length, true);
      cdv.setUint32(24, data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);
      offset += lh.length;
    }
    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true);
    edv.setUint16(10, entries.length, true);
    edv.setUint32(12, centralSize, true);
    edv.setUint32(16, offset, true);
    const parts = [...locals, ...central, eocd];
    return new Blob(parts, { type: 'application/zip' });
  }

  return { parseZip, inflateRaw, makeZip, crc32 };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ZIP;
