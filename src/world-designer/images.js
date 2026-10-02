'use strict';
const Images = (() => {
  const vfs = typeof module !== 'undefined' ? require('./vfs.js') : VFS;
  const tokens = typeof module !== 'undefined' ? require('./tokens.js') : Tokens;
  const MAX_INPUT_BYTES = 32 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
  const MAX_SOURCE_SIDE = 32768;
  const MAX_SOURCE_PIXELS = 40 * 1024 * 1024;
  function detectMime(bytes) {
    const starts = a => a.every((v, i) => bytes[i] === v);
    if (starts([137,80,78,71,13,10,26,10])) return 'image/png';
    if (starts([255,216,255])) return 'image/jpeg';
    const s = String.fromCharCode(...bytes.subarray(0, 16));
    if (/^GIF8[79]a/.test(s)) return 'image/gif';
    if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'image/webp';
    if (s.startsWith('BM')) return 'image/bmp';
    if (s.slice(4, 8) === 'ftyp' && /avif|avis/.test(s.slice(8))) return 'image/avif';
    return null;
  }
  // 只读尺寸头，避免先解码极端大图后才发现内存风险。解码后还会再次校验。
  function dimensions(bytes, mime) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pair = (width, height) => ({ width, height });
    if (mime === 'image/png' && bytes.length >= 24) return pair(dv.getUint32(16), dv.getUint32(20));
    if (mime === 'image/gif' && bytes.length >= 10) return pair(dv.getUint16(6, true), dv.getUint16(8, true));
    if (mime === 'image/bmp' && bytes.length >= 26) {
      if (dv.getUint32(14, true) === 12) return pair(dv.getUint16(18, true), dv.getUint16(20, true));
      return pair(Math.abs(dv.getInt32(18, true)), Math.abs(dv.getInt32(22, true)));
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset++] !== 255) break;
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
        if (offset + 2 > bytes.length) break;
        const length = dv.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) break;
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7)
          return pair(dv.getUint16(offset + 5), dv.getUint16(offset + 3));
        offset += length;
      }
    }
    if (mime === 'image/webp') {
      for (let p = 12; p + 8 <= bytes.length;) {
        const kind = String.fromCharCode(...bytes.subarray(p, p + 4)), size = dv.getUint32(p + 4, true), start = p + 8;
        if (start + size > bytes.length) break;
        const u24 = i => bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16;
        if (kind === 'VP8X' && size >= 10) return pair(1 + u24(start + 4), 1 + u24(start + 7));
        if (kind === 'VP8 ' && size >= 10) return pair(dv.getUint16(start + 6, true) & 0x3fff, dv.getUint16(start + 8, true) & 0x3fff);
        if (kind === 'VP8L' && size >= 5) {
          const bits = dv.getUint32(start + 1, true);
          return pair(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
        }
        p = start + size + (size % 2);
      }
    }
    return null;
  }
  function checkDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
      throw new Error('图片尺寸无效');
    if (Math.max(width, height) > MAX_SOURCE_SIDE) throw new Error('图片原始边长超过 32768 像素，请先缩小图片');
    if (width * height > MAX_SOURCE_PIXELS) throw new Error('图片像素超过 40 Mi 像素，请先缩小图片');
  }
  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
  }
  function fromDataUrl(url) {
    const match = /^data:(image\/[\w.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url);
    if (!match) throw new Error('不是有效的图片数据');
    return Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  }
  function fit(width, height, maxSide = 2048) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }
  function cropRect(width, height, crop) {
    if (!crop) return { x: 0, y: 0, width, height };
    const c = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
    if (!Object.values(c).every(Number.isInteger) || c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0 ||
      c.x + c.width > width || c.y + c.height > height) throw new Error('裁剪坐标无效或超出原图范围');
    return c;
  }
  async function decode(blob) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob); } catch (_) { /* Some browser decoders only support Image. */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch (_) { throw new Error('无法解码图片，请转换为 PNG、JPEG 或 WebP 后重试'); }
    finally { URL.revokeObjectURL(url); }
  }
  async function prepare(bytes, options = {}) {
    if (bytes.length > MAX_INPUT_BYTES) throw new Error('图片超过本地处理上限 32 MiB，请先缩小图片');
    const mime = detectMime(bytes);
    if (!mime) throw new Error('不支持或无效的图片格式，请转换为 PNG、JPEG 或 WebP');
    const header = dimensions(bytes, mime);
    if (header) checkDimensions(header.width, header.height);
    const bitmap = await decode(new Blob([bytes], { type: mime }));
    try {
      const sourceWidth = bitmap.naturalWidth || bitmap.width, sourceHeight = bitmap.naturalHeight || bitmap.height;
      checkDimensions(sourceWidth, sourceHeight);
      const crop = cropRect(sourceWidth, sourceHeight, options.crop);
      let size = fit(crop.width, crop.height);
      const canvas = document.createElement('canvas');
      let output;
      for (let attempt = 0; attempt < 6; attempt++) {
        canvas.width = size.width; canvas.height = size.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('浏览器无法处理图片');
        ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
        const format = mime === 'image/jpeg' ? 'image/jpeg' : attempt === 0 ? 'image/png' : 'image/webp';
        const blob = await new Promise(resolve => canvas.toBlob(resolve, format, 0.9));
        if (!blob) throw new Error('图片转换失败');
        output = new Uint8Array(await blob.arrayBuffer());
        if (output.length <= MAX_OUTPUT_BYTES) return { dataUrl: 'data:' + blob.type + ';base64,' + base64(output),
          width: size.width, height: size.height, sourceWidth, sourceHeight, mime: blob.type };
        // First try changing encoding; then reduce dimensions if still too large.
        if (attempt > 0) size = fit(size.width, size.height, Math.floor(Math.max(size.width, size.height) * 0.8));
      }
      throw new Error('压缩后图片仍过大，请裁剪或缩小后重试');
    } finally { if (bitmap.close) bitmap.close(); }
  }
  function store(tree, path, bytes, prepared, now = Date.now()) {
    vfs.writeFile(tree, path, base64(bytes), { encoding: 'base64', now });
    const node = vfs.resolve(tree, vfs.normalize(path));
    node.image = prepared;
    node.tmp = { lastUsedAt: now, idleTurns: 0 };
    return { path, name: path.split('/').pop(), width: prepared.sourceWidth, height: prepared.sourceHeight };
  }
  function resolve(tree, path) {
    if (!tree || typeof path !== 'string') return null;
    const parts = vfs.normalize(path);
    if (!['workspace', 'tmp'].includes(parts[0])) throw new Error('图片路径只允许 /workspace/ 或 /tmp/');
    const node = vfs.resolve(tree, parts);
    return node && node.type === 'file' ? node : null;
  }
  function messageContent(message, tree, options = {}) {
    const refs = message.attachments || [];
    if (!refs.length) return message.content;
    const text = [tokens.contentText(message.content)], parts = [];
    for (const ref of refs) {
      const node = resolve(tree, ref.path);
      text.push('[图片附件: ' + ref.path + (ref.width ? `，原图 ${ref.width}×${ref.height}` : '') +
        (!node ? '，已过期或已删除，需要用户重新粘贴' : !options.enabled ? '，图片发送已关闭' : '，可用 view_image 按需查看或裁剪') + ']');
      if (node?.image && options.enabled && options.activeId && message.msgId === options.activeId)
        parts.push({ type: 'image_url', image_url: { url: node.image.dataUrl } });
    }
    return parts.length ? [{ type: 'text', text: text.join('\n') }, ...parts] : text.join('\n');
  }
  return { detectMime, dimensions, base64, fromDataUrl, fit, cropRect, prepare, store, resolve, messageContent, MAX_INPUT_BYTES };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Images;
