'use strict';
const ZIP = (() => {
  async function inflateRaw(bytes) {
    if (bytes.length === 0) return new Uint8Array(0);
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await stream.arrayBuffer());
  }


  const UTF8_LOOSE = new TextDecoder('utf-8');
  const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

  function decodeWith(label, bytes, fatal = true) {
    try { return new TextDecoder(label, { fatal }).decode(bytes); }
    catch (_) { return null; }
  }

  function unicodePathFromExtra(extra, rawName) {
    for (let off = 0; off + 4 <= extra.length;) {
      const id = extra[off] | (extra[off + 1] << 8);
      const size = extra[off + 2] | (extra[off + 3] << 8);
      off += 4;
      if (off + size > extra.length) break;
      if (id === 0x7075 && size >= 5 && extra[off] === 1) {
        const storedCrc = (extra[off + 1] | (extra[off + 2] << 8) |
          (extra[off + 3] << 16) | (extra[off + 4] << 24)) >>> 0;
        if (storedCrc === crc32(rawName)) {
          const decoded = decodeWith('utf-8', extra.subarray(off + 5, off + size), true);
          if (decoded !== null) return decoded;
        }
      }
      off += size;
    }
    return null;
  }

  function legacyNameScore(text, label) {
    let score = label === 'gb18030' ? 0.35 : label === 'big5' ? 0.25 : 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0xfffd) score -= 100;
      else if (cp < 0x20 || cp === 0x7f) score -= 20;
      else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) score += 2.2;
      else if (cp >= 0x3040 && cp <= 0x30ff) score += 1.8;
      else if (cp >= 0xac00 && cp <= 0xd7af) score += 1.8;
      else if (cp < 0x80) score += 0.05;
      else score += 0.2;
    }
    return score;
  }

  function decodeZipName(rawName, flags, extra) {
    // Info-ZIP Unicode Path Extra Field (0x7075) is the most reliable source
    // for archives whose legacy filename bytes are not UTF-8.
    const unicodeName = unicodePathFromExtra(extra, rawName);
    if (unicodeName !== null) return unicodeName;

    // General-purpose bit 11 explicitly declares UTF-8 filenames.
    if (flags & 0x0800) return UTF8_LOOSE.decode(rawName);

    // Some writers store UTF-8 correctly but forget to set bit 11.
    try { return UTF8_FATAL.decode(rawName); }
    catch (_) {}

    // Legacy ZIPs have no universal filename encoding. Try common East Asian
    // encodings and choose the most plausible lossless decoding.
    const candidates = [];
    for (const label of ['gb18030', 'big5', 'shift_jis', 'euc-kr']) {
      const text = decodeWith(label, rawName, true);
      if (text !== null) candidates.push({ text, score: legacyNameScore(text, label) });
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].text;
    }

    // Last resort preserves the previous replacement-character behavior.
    return UTF8_LOOSE.decode(rawName);
  }

  const PNG_SIGNATURE = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];

  function findPngEnd(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return -1;
    if (bytes.length < 20) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let ptr = 8, sawIHDR = false;
    while (ptr + 12 <= bytes.length) {
      const len = dv.getUint32(ptr, false);
      if (len > 0x7fffffff) return -1;
      const end = ptr + 12 + len;
      if (end > bytes.length) return null;
      const type = String.fromCharCode(bytes[ptr + 4], bytes[ptr + 5], bytes[ptr + 6], bytes[ptr + 7]);
      if (!sawIHDR) {
        if (type !== 'IHDR' || len !== 13) return -1;
        sawIHDR = true;
      }
      ptr = end;
      if (type === 'IEND') return len === 0 ? ptr : -1;
    }
    return null;
  }

  function extractPngPrefix(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer), end = findPngEnd(bytes);
    return Number.isInteger(end) && end > 0 ? bytes.slice(0, end) : null;
  }

  function zipArchiveBase(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 22) return null;
    const dv = new DataView(arrayBuffer);
    const floor = Math.max(0, bytes.length - 22 - 0xffff);
    for (let eocd = bytes.length - 22; eocd >= floor; eocd--) {
      if (dv.getUint32(eocd, true) !== 0x06054b50) continue;
      const commentLen = dv.getUint16(eocd + 20, true);
      if (eocd + 22 + commentLen !== bytes.length) continue;
      const count = dv.getUint16(eocd + 10, true);
      const centralSize = dv.getUint32(eocd + 12, true);
      const centralOffset = dv.getUint32(eocd + 16, true);
      const base = eocd - centralSize - centralOffset;
      if (base < 0) continue;
      const central = base + centralOffset;
      if (count && (central + 4 > bytes.length || dv.getUint32(central, true) !== 0x02014b50)) continue;
      return { base, eocd, count, centralSize, centralOffset };
    }
    return null;
  }

  async function parseZip(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const info = zipArchiveBase(arrayBuffer);
    if (!info) throw new Error('不是有效的 zip 文件');
    const {base:archiveBase,count,centralOffset} = info;
    let ptr = archiveBase + centralOffset;
    const files = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) throw new Error('中央目录损坏');
      const flags = dv.getUint16(ptr + 8, true);
      const method = dv.getUint16(ptr + 10, true);
      const time = dv.getUint16(ptr + 12, true), date = dv.getUint16(ptr + 14, true);
      const month = (date >> 5) & 15, day = date & 31;
      const mtime = month >= 1 && month <= 12 && day >= 1 && day <= 31
        ? new Date(1980 + (date >> 9), month - 1, day, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime() : null;
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true);
      const extraLen = dv.getUint16(ptr + 30, true);
      const commentLen = dv.getUint16(ptr + 32, true);
      const localOff = archiveBase + dv.getUint32(ptr + 42, true);
      const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
      const extraBytes = bytes.subarray(ptr + 46 + nameLen, ptr + 46 + nameLen + extraLen);
      const name = decodeZipName(nameBytes, flags, extraBytes);
      
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = bytes.subarray(dataStart, dataStart + compSize);
      let raw;
      if (method === 0) raw = comp;
      else if (method === 8) raw = await inflateRaw(comp);
      else throw new Error('不支持的压缩方法: ' + method);
      const isDir = name.endsWith('/');
      files.push({ name, isDir, text: isDir ? '' : UTF8_LOOSE.decode(raw), bytes: raw, mtime });
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

  return { parseZip, findPngEnd, extractPngPrefix, zipArchiveBase, inflateRaw, makeZip, crc32 };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ZIP;
