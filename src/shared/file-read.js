'use strict';
const FileRead = (() => {
  function read(content, options = {}) {
    const cap = options.cap || 8000;
    const tail = options.tail_chars;
    if (tail !== undefined) {
      if (!Number.isSafeInteger(tail) || tail < 1) throw Error('tail_chars 必须是正整数');
      if (options.offset !== undefined || options.limit !== undefined) throw Error('tail_chars 不能与 offset 或 limit 同时使用');
    }
    const limit = tail === undefined ? Math.min(options.limit || options.defaultLimit || cap, cap) : Math.min(tail, cap);
    const offset = tail === undefined ? Math.max(0, options.offset || 0) : Math.max(0, content.length - limit);
    const text = content.slice(offset, offset + limit);
    return { content: text, totalLength: content.length, offset, returned: text.length, truncated: offset + text.length < content.length };
  }
  // Request-local advice only: no automatic enlargement, retries or denied reads.
  const owners = new WeakMap();
  function hint(owner, path, version, result, scope = 0) {
    if (!owner || typeof owner !== 'object') return '';
    let group = owners.get(owner);
    if (!group || group.scope !== scope) {
      group = { scope, files: new Map() };
      owners.set(owner, group);
    }
    const files = group.files, small = result.returned > 0 && result.returned < 2048 && result.truncated;
    let state = files.get(path);
    if (!state && !small) return '';
    if (!state || state.version !== version) {
      state = { version, count: 0, end: -1, offset: -1, warned: false };
      files.set(path, state);
    }
    const adjacent = result.offset >= state.offset && result.offset <= state.end;
    state.count = small ? (adjacent ? state.count + 1 : 1) : 0;
    state.offset = result.offset; state.end = result.offset + result.returned;
    if (state.count < 3 || state.warned) return '';
    state.warned = true;
    return '已连续小步读取同一文件。继续阅读可将 limit 增至 8000–32000；定位文件末尾可用 tail_chars:4000；定位中间内容可先 search，再按 read_offset 跳读。truncated 只表示后面还有内容，不要求全部读完。';
  }
  return { read, hint };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FileRead;
