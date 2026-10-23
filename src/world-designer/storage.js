'use strict';
const DesignerStorage = (() => {
  // Count JSON in bounded string chunks instead of allocating a second complete document.
  function jsonSize(value, utf8 = true, check = () => {}) {
    const encoder = utf8 ? new TextEncoder() : null, seen = new Set();
    const quoted = text => {
      let count = 2;
      for (let start = 0; start < text.length;) {
        check();
        let end = Math.min(start + 16384, text.length);
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
          && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
        const chunk = JSON.stringify(text.slice(start, end));
        count += (encoder ? encoder.encode(chunk).byteLength : chunk.length) - 2;
        start = end;
      }
      return count;
    };
    function count(item, key = '') {
      check();
      if (item && typeof item.toJSON === 'function') item = item.toJSON(key);
      if (item === null) return 4;
      if (typeof item === 'string') return quoted(item);
      if (typeof item === 'number') return Number.isFinite(item) ? String(item).length : 4;
      if (typeof item === 'boolean') return item ? 4 : 5;
      if (typeof item === 'bigint') throw new TypeError('BigInt cannot be serialized');
      if (typeof item !== 'object') return undefined;
      if (seen.has(item)) throw new TypeError('Circular JSON');
      seen.add(item);
      let total = 2, n = 0;
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) { total += (n++ ? 1 : 0) + (count(item[i], String(i)) ?? 4); }
      } else {
        for (const key of Object.keys(item)) {
          const size = count(item[key], key);
          if (size !== undefined) total += (n++ ? 1 : 0) + quoted(key) + 1 + size;
        }
      }
      seen.delete(item);
      return total;
    }
    return count(value) ?? 0;
  }
  const jsonBytes = (value, check) => jsonSize(value, true, check);
  const jsonChars = value => jsonSize(value, false);
  const nonempty = value => value != null && value !== '' && value !== false && value !== 0
    && (typeof value !== 'object' || Object.keys(value).length > 0);

  // Count editable data rather than the immutable resources mounted on every entry.
  function fileBytes(tree, seeds, check) {
    function prune(node, path = '') {
      if (!node) return null;
      if (node.type === 'file') {
        const seed = seeds[path.slice('/workspace/'.length)];
        if (path.startsWith('/workspace/') && seed !== undefined && node.encoding !== 'base64' && node.content === seed) return null;
        return node;
      }
      const children = {};
      for (const [name, child] of Object.entries(node.children || {})) {
        if (!path && name === 'skills') continue;
        const kept = prune(child, path + '/' + name);
        if (kept) children[name] = kept;
      }
      if (!Object.keys(children).length && ['', '/workspace', '/tmp'].includes(path)) return null;
      return { ...node, children };
    }
    const userTree = prune(tree);
    return userTree ? jsonBytes(userTree, check) : 0;
  }
  function chatBytes(session, messages, check) {
    const metadata = {};
    const fixedKeys = new Set(['id', 'projectId', 'groupId', 'createdAt', 'updatedAt', 'msgCount', 'messages', 'attachmentVersion']);
    for (const [key, value] of Object.entries(session)) {
      if (fixedKeys.has(key) || key.startsWith('__') || !nonempty(value)) continue;
      if (key === 'name' && /^新会话(?: \d+)?$/.test(value)) continue;
      metadata[key] = value;
    }
    return (messages.length ? jsonBytes(messages, check) : 0) + (Object.keys(metadata).length ? jsonBytes(metadata, check) : 0);
  }
  const CACHE_ID = 'storage-estimate:v1';
  async function estimate(db, seeds, { signal, maxBytes = 64 * 1024 * 1024, maxRecords = 20000, maxMs = 10000 } = {}) {
    const started = Date.now(); let scannedBytes = 0, scannedRecords = 0;
    const check = () => {
      if (signal?.aborted) throw new DOMException('统计已取消', 'AbortError');
      if (Date.now() - started > maxMs || scannedBytes > maxBytes || scannedRecords > maxRecords)
        throw new Error('数据量较大，已停止统计；文件和历史记录保留。');
    };
    check();
    const revisions = await db.storageRevisions();
    const seedKey = JSON.stringify(seeds), saved = await db.get('config', CACHE_ID);
    const cached = saved?.version === 1 ? saved.tables : {};
    const tables = {}, rebuilt = [];
    for (const name of ['sessions', 'messages', 'snapshots', 'vfs', 'groups', 'config']) {
      check();
      if (cached?.[name] && cached[name].revision === revisions[name] && (name !== 'vfs' || saved.seedKey === seedKey)) {
        tables[name] = cached[name]; continue;
      }
      const entries = new Map();
      const add = (id, bytes, count = 0) => {
        const previous = entries.get(id) || { bytes: 0, count: 0 };
        entries.set(id, { bytes: previous.bytes + bytes, count: previous.count + count });
      };
      await db.iterate(name, record => {
        scannedRecords++; check();
        const measure = value => { const size = jsonBytes(value, check); scannedBytes += size; check(); return size; };
        if (name === 'sessions') {
          const bytes = chatBytes(record, record.messages || [], check); scannedBytes += bytes; check();
          entries.set(record.id, { projectId: record.projectId, bytes });
        }
        else if (name === 'messages') {
          const { id, sessionId, seq, ...message } = record;
          add(sessionId, measure(message), 1);
        } else if (name === 'snapshots') add(record.projectId, measure(record), 1);
        else if (name === 'vfs') {
          const bytes = fileBytes(record.tree, seeds, check); scannedBytes += bytes; check(); add(record.id, bytes);
        }
        else if (name === 'groups') add(record.projectId, measure(record));
        else {
          const match = /^(?:pending|stream):(.+)$/.exec(record.id);
          if (match && nonempty(record.value)) add(match[1], measure(record));
        }
      }, { signal });
      tables[name] = { revision: revisions[name], entries: [...entries] }; rebuilt.push(name);
    }
    check();
    const latest = await db.storageRevisions();
    const stale = Object.keys(tables).some(name => latest[name] !== revisions[name]);
    // A concurrent write leaves the old revision dirty; never bless a mixed scan as current.
    if (!stale && rebuilt.length) {
      try { await db.put('config', { id: CACHE_ID, version: 1, seedKey, tables }); }
      catch (error) { console.warn('存储统计缓存未保存：', error.message); }
    }
    check();
    const perProject = new Map();
    const entry = id => {
      if (!perProject.has(id)) perProject.set(id, { chat: 0, files: 0, snaps: 0, snapCount: 0, other: 0 });
      return perProject.get(id);
    };
    const sessions = new Map(tables.sessions.entries);
    for (const session of sessions.values()) entry(session.projectId).chat += session.bytes;
    for (const [id, data] of tables.messages.entries) {
      const session = sessions.get(id);
      if (session) entry(session.projectId).chat += data.bytes + data.count + 1; // [] plus commas
    }
    for (const [id, data] of tables.snapshots.entries) { const e = entry(id); e.snaps += data.bytes; e.snapCount += data.count; }
    for (const [id, data] of tables.vfs.entries) entry(id).files += data.bytes;
    for (const name of ['groups', 'config']) for (const [id, data] of tables[name].entries) entry(id).other += data.bytes;
    const total = [...perProject.values()].reduce((sum, e) => sum + e.chat + e.files + e.snaps + e.other, 0);
    return { perProject, total, stale };
  }
  return { jsonBytes, jsonChars, fileBytes, chatBytes, estimate };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DesignerStorage;
