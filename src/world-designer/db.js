'use strict';
const DB = (() => {
  const NAME = 'agent-workbench', VERSION = 2;
  let db = null;
  let memoryMode = false;
  const mem = {}; // 降级：store → Map

  function open() {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(NAME, VERSION); }
      catch (_) { memoryMode = true; return resolve(null); }
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['config', 'projects', 'sessions', 'groups', 'vfs', 'snapshots', 'userSkills']) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
        }
        // v2：消息拆表。会话记录只存元数据，消息逐条存这里，
        // 键为 `${sessionId}:${seq(定宽)}`，按 sessionId 建索引以便整会话读取/删除。
        if (!d.objectStoreNames.contains('messages')) {
          const ms = d.createObjectStore('messages', { keyPath: 'id' });
          ms.createIndex('bySession', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => { memoryMode = true; resolve(null); };
    });
  }

  function store(name) { if (!mem[name]) mem[name] = new Map(); return mem[name]; }

  const trackedStores = new Set(['sessions', 'messages', 'snapshots', 'vfs', 'groups', 'config']);
  const isUsageConfig = id => /^(?:pending|stream):/.test(String(id));
  const revision = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36);
  function dirtyRecords(names) {
    return [...new Set(names)].filter(name => trackedStores.has(name))
      .map(name => ({ id: 'storage-revision:' + name, value: revision() }));
  }
  function markMemoryDirty(names) {
    for (const record of dirtyRecords(names)) store('config').set(record.id, record);
  }
  // Revision and data commit atomically, including writes from other tabs.
  function writeTransaction(names, dirty = names) {
    const tx = db.transaction([...new Set([...names, 'config'])], 'readwrite');
    for (const record of dirtyRecords(dirty)) tx.objectStore('config').put(record);
    return tx;
  }
  async function storageRevisions() {
    const result = {};
    for (const name of trackedStores) result[name] = (await get('config', 'storage-revision:' + name))?.value || 'legacy';
    return result;
  }

  function put(storeName, obj) {
    const dirty = storeName === 'config' && !isUsageConfig(obj.id) ? [] : [storeName];
    if (memoryMode) { store(storeName).set(obj.id, structuredClone(obj)); markMemoryDirty(dirty); return Promise.resolve(); }
    return new Promise((res, rej) => {
      const tx = writeTransaction([storeName], dirty);
      tx.objectStore(storeName).put(obj);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  function get(storeName, id) {
    if (memoryMode) { const v = store(storeName).get(id); return Promise.resolve(v ? structuredClone(v) : undefined); }
    return new Promise((res, rej) => {
      const r = db.transaction(storeName).objectStore(storeName).get(id);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }

  // Save the editable tree and its public validation summary in one transaction.
  function storedTree(tree) {
    const { skills, ...children } = tree.children || {};
    return { ...tree, children }; // Mounted page resources are rebuilt on entry.
  }
  function putWorkspace(id, tree, validation) {
    const workspace = { id, tree: storedTree(tree) }, record = { id: 'world-validation:' + id, value: validation };
    if (memoryMode) {
      store('vfs').set(id, structuredClone(workspace)); store('config').set(record.id, structuredClone(record));
      markMemoryDirty(['vfs']);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const tx = writeTransaction(['vfs', 'config'], ['vfs']);
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || Error('工作区保存中断'));
      try { tx.objectStore('vfs').put(workspace); tx.objectStore('config').put(record); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  // Reset a single project's growing data atomically, retaining its identity and global settings.
  async function resetProjectData(project, session, tree, validation) {
    const id = project.id;
    const sessions = (await all('sessions')).filter(s => s.projectId === id);
    const sessionIds = new Set(sessions.map(s => s.id));
    const predicates = {
      sessions: item => item.projectId === id,
      messages: item => sessionIds.has(item.sessionId),
      groups: item => item.projectId === id,
      snapshots: item => item.projectId === id,
      config: item => ['pending:' + id, 'stream:' + id, 'world-validation:' + id].includes(item.id),
    };
    const writes = {
      projects: project, sessions: session, vfs: { id, tree: storedTree(tree) },
      config: { id: 'world-validation:' + id, value: validation },
    };
    if (memoryMode) {
      for (const [name, predicate] of Object.entries(predicates))
        for (const [key, item] of store(name)) if (predicate(item)) store(name).delete(key);
      for (const [name, item] of Object.entries(writes)) store(name).set(item.id, structuredClone(item));
      markMemoryDirty(Object.keys(predicates).concat('vfs'));
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = writeTransaction([...new Set([...Object.keys(predicates), ...Object.keys(writes)])]);
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || Error('项目清理中断'));
      for (const [name, predicate] of Object.entries(predicates)) {
        const os = tx.objectStore(name), request = os.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { if (predicate(cursor.value)) cursor.delete(); cursor.continue(); }
          else if (writes[name]) os.put(writes[name]);
        };
      }
      for (const [name, item] of Object.entries(writes)) if (!predicates[name]) tx.objectStore(name).put(item);
    });
  }

  function all(storeName) {
    if (memoryMode) return Promise.resolve([...store(storeName).values()].map(v => structuredClone(v)));
    return new Promise((res, rej) => {
      const r = db.transaction(storeName).objectStore(storeName).getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
    });
  }

  // The visitor is synchronous: one record is retained, and each cursor step yields to the browser.
  async function iterate(storeName, visit, { signal, maxRecords = Infinity, maxMs = Infinity } = {}) {
    const started = Date.now(); let count = 0;
    const check = () => {
      if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError');
      if (count > maxRecords || Date.now() - started > maxMs) throw new Error('数据较多，已停止读取');
    };
    check();
    if (memoryMode) {
      for (const value of store(storeName).values()) {
        count++; check(); visit(structuredClone(value));
        if (count % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      check(); return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName), request = tx.objectStore(storeName).openCursor();
      let error;
      const abort = () => { error = new DOMException('读取已取消', 'AbortError'); try { tx.abort(); } catch (_) { /* already completed */ } };
      signal?.addEventListener('abort', abort, { once: true });
      const finish = fn => { signal?.removeEventListener('abort', abort); fn(); };
      tx.oncomplete = () => finish(resolve);
      tx.onabort = tx.onerror = () => finish(() => reject(error || tx.error || Error('读取失败')));
      request.onsuccess = () => {
        try {
          check();
          const cursor = request.result;
          if (cursor) { count++; check(); visit(cursor.value); if (!signal?.aborted) cursor.continue(); }
        } catch (err) { error = err; tx.abort(); }
      };
    });
  }
  async function snapshotHeaders(projectId) {
    const revision = (await get('config', 'storage-revision:snapshots'))?.value || 'legacy';
    const cached = await get('config', 'snapshot-directory:v1');
    if (cached?.revision === revision) return cached.headers.filter(snap => snap.projectId === projectId);
    const headers = [];
    await iterate('snapshots', snap => {
      headers.push({ id: snap.id, projectId: snap.projectId, turnRef: snap.turnRef, createdAt: snap.createdAt });
    }, { maxRecords: 20000, maxMs: 8000 });
    if (((await get('config', 'storage-revision:snapshots'))?.value || 'legacy') === revision) {
      try { await put('config', { id: 'snapshot-directory:v1', revision, headers }); }
      catch (error) { console.warn('撤回目录缓存未保存：', error.message); }
    }
    return headers.filter(snap => snap.projectId === projectId);
  }
  function del(storeName, id) {
    const dirty = storeName === 'config' && !isUsageConfig(id) ? [] : [storeName];
    if (memoryMode) { store(storeName).delete(id); markMemoryDirty(dirty); return Promise.resolve(); }
    return new Promise((res, rej) => {
      const tx = writeTransaction([storeName], dirty);
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error);
    });
  }

  function delWhere(storeName, pred) {
    if (memoryMode) {
      for (const [key, item] of store(storeName)) if (pred(item)) store(storeName).delete(key);
      markMemoryDirty([storeName]); return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const tx = writeTransaction([storeName]), request = tx.objectStore(storeName).openCursor();
      let error;
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(error || tx.error);
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (cursor) { if (pred(cursor.value)) cursor.delete(); cursor.continue(); }
        } catch (err) { error = err; tx.abort(); }
      };
    });
  }

  /* ---------- messages 表：按会话分片存取 ----------
     会话记录只留元数据，消息逐条存 messages 表。这样追加一条消息就是写一条记录，
     而不是把整个 messages 数组重写一遍——消息越多，原来的写入越慢。
     键 `${sessionId}:${seq}` 定宽补零，保证 IDBKeyRange 的字典序等于时间序。 */
  const SEQ_WIDTH = 9;
  const SEQ_MAX = Number('9'.repeat(SEQ_WIDTH));
  const msgKey = (sessionId, seq) => sessionId + ':' + String(seq).padStart(SEQ_WIDTH, '0');
  // [fromSeq, beforeSeq) 的键区间；两端可省，默认覆盖整个会话
  const seqRange = (sessionId, fromSeq, beforeSeq) => IDBKeyRange.bound(
    msgKey(sessionId, fromSeq || 0),
    msgKey(sessionId, beforeSeq != null ? beforeSeq - 1 : SEQ_MAX));
  // 剥掉内部管理字段，还原成纯消息对象
  const stripRow = r => { const { id, sessionId: _s, seq, ...rest } = r; return rest; };

  // 覆盖某会话 fromSeq 起的消息（seq 从 fromSeq 连续编号），fromSeq 之前的不动。
  // 批量写在单个事务里完成。省略 fromSeq 即整段覆盖。
  function putMessages(sessionId, msgs, fromSeq) {
    const from = fromSeq || 0;
    if (memoryMode) {
      const s = store('messages');
      const lo = msgKey(sessionId, from);
      for (const k of [...s.keys()]) if (k.startsWith(sessionId + ':') && k >= lo) s.delete(k);
      msgs.forEach((m, i) => s.set(msgKey(sessionId, from + i), structuredClone({ ...m, id: msgKey(sessionId, from + i), sessionId, seq: from + i })));
      markMemoryDirty(['messages']);
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const tx = writeTransaction(['messages']);
      const os = tx.objectStore('messages');
      os.delete(seqRange(sessionId, from));
      msgs.forEach((m, i) => os.put({ ...m, id: msgKey(sessionId, from + i), sessionId, seq: from + i }));
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  // 追加若干条消息（不动已有的）。fromSeq 由调用方给出，通常是当前长度。
  function appendMessages(sessionId, msgs, fromSeq) {
    if (!msgs.length) return Promise.resolve();
    if (memoryMode) {
      const s = store('messages');
      msgs.forEach((m, i) => { const seq = fromSeq + i; s.set(msgKey(sessionId, seq), structuredClone({ ...m, id: msgKey(sessionId, seq), sessionId, seq })); });
      markMemoryDirty(['messages']);
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const tx = writeTransaction(['messages']);
      const os = tx.objectStore('messages');
      msgs.forEach((m, i) => { const seq = fromSeq + i; os.put({ ...m, id: msgKey(sessionId, seq), sessionId, seq }); });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  // 读取某会话的消息。opts.limit 给定时只取最后 limit 条（游标反向走，不必全表扫）。
  function getMessages(sessionId, opts) {
    const limit = opts && opts.limit;
    if (memoryMode) {
      const out = memRows(sessionId).map(stripRow);
      return Promise.resolve(limit ? out.slice(-limit) : out);
    }
    return new Promise((res, rej) => {
      const os = db.transaction('messages').objectStore('messages');
      if (!limit) {
        const r = os.getAll(seqRange(sessionId));
        r.onsuccess = () => res((r.result || []).map(stripRow));
        r.onerror = () => rej(r.error);
        return;
      }
      const out = [];
      const cur = os.openCursor(seqRange(sessionId), 'prev');   // 从最新往回读
      cur.onsuccess = () => {
        const c = cur.result;
        if (c && out.length < limit) { out.push(stripRow(c.value)); c.continue(); }
        else res(out.reverse());
      };
      cur.onerror = () => rej(cur.error);
    });
  }

  // 内存降级下按 seq 正序取出某会话的原始行
  function memRows(sessionId, fromSeq, beforeSeq) {
    return [...store('messages').entries()]
      .filter(([k]) => k.startsWith(sessionId + ':'))
      .sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([, v]) => structuredClone(v))
      .filter(r => (fromSeq == null || r.seq >= fromSeq) && (beforeSeq == null || r.seq < beforeSeq));
  }

  // 取 [fromSeq, beforeSeq) 区间的消息，用于向上翻页时补读更早的一批。
  function getMessagesRange(sessionId, fromSeq, beforeSeq) {
    if (beforeSeq <= fromSeq) return Promise.resolve([]);
    if (memoryMode) return Promise.resolve(memRows(sessionId, fromSeq, beforeSeq).map(stripRow));
    return new Promise((res, rej) => {
      const r = db.transaction('messages').objectStore('messages')
        .getAll(seqRange(sessionId, fromSeq, beforeSeq));
      r.onsuccess = () => res((r.result || []).map(stripRow));
      r.onerror = () => rej(r.error);
    });
  }

  /* 从最新一条往回读，每读一条就交给 keepGoing(msg, count) 判定要不要继续往前。
     触发停止的那条本身仍然收入——调用方用它当边界（比如压缩块要连同摘要一起留下）。
     返回 { messages(时间正序), fromSeq(首条的绝对序号), hasMore(前面还有没有) }。 */
  function getMessagesTailWhile(sessionId, keepGoing) {
    const finish = (out, firstSeq, hasMore) =>
      ({ messages: out.reverse(), fromSeq: out.length ? firstSeq : 0, hasMore });
    if (memoryMode) {
      const rows = memRows(sessionId);
      const out = [];
      let firstSeq = 0, hasMore = false;
      for (let i = rows.length - 1; i >= 0; i--) {
        const m = stripRow(rows[i]);
        out.push(m); firstSeq = rows[i].seq;
        if (!keepGoing(m, out.length)) { hasMore = i > 0; break; }
      }
      return Promise.resolve(finish(out, firstSeq, hasMore));
    }
    return new Promise((res, rej) => {
      const out = [];
      let firstSeq = 0;
      const cur = db.transaction('messages').objectStore('messages')
        .openCursor(seqRange(sessionId), 'prev');
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return res(finish(out, firstSeq, false));
        const m = stripRow(c.value);
        out.push(m); firstSeq = c.value.seq;
        if (keepGoing(m, out.length)) c.continue();
        else res(finish(out, firstSeq, firstSeq > 0));
      };
      cur.onerror = () => rej(cur.error);
    });
  }

  function countMessages(sessionId) {
    if (memoryMode) {
      let n = 0;
      for (const k of store('messages').keys()) if (k.startsWith(sessionId + ':')) n++;
      return Promise.resolve(n);
    }
    return new Promise((res, rej) => {
      const r = db.transaction('messages').objectStore('messages').count(seqRange(sessionId));
      r.onsuccess = () => res(r.result || 0); r.onerror = () => rej(r.error);
    });
  }

  function delMessages(sessionId) {
    if (memoryMode) {
      const s = store('messages');
      for (const k of s.keys()) if (k.startsWith(sessionId + ':')) s.delete(k);
      markMemoryDirty(['messages']);
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const tx = writeTransaction(['messages']);
      tx.objectStore('messages').delete(seqRange(sessionId));
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  function wipeAll() {
    if (memoryMode) { for (const k of Object.keys(mem)) delete mem[k]; return Promise.resolve(); }
    db.close(); db = null;
    return new Promise((res) => {
      const r = indexedDB.deleteDatabase(NAME);
      r.onsuccess = r.onerror = r.onblocked = () => res();
    });
  }

  return { iterate, snapshotHeaders, storageRevisions, open, put, putWorkspace, resetProjectData, get, all, del, delWhere, wipeAll, isMemoryMode: () => memoryMode,
    putMessages, appendMessages, getMessages, getMessagesRange, getMessagesTailWhile,
    countMessages, delMessages };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DB;
