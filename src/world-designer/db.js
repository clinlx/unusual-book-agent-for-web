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

  function put(storeName, obj) {
    if (memoryMode) { store(storeName).set(obj.id, structuredClone(obj)); return Promise.resolve(); }
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readwrite');
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

  // Save the exact tree and its public validation summary in one transaction.
  function putWorkspace(id, tree, validation) {
    const workspace = { id, tree }, record = { id: 'world-validation:' + id, value: validation };
    if (memoryMode) {
      store('vfs').set(id, structuredClone(workspace)); store('config').set(record.id, structuredClone(record));
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['vfs', 'config'], 'readwrite');
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || Error('工作区保存中断'));
      try { tx.objectStore('vfs').put(workspace); tx.objectStore('config').put(record); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  function all(storeName) {
    if (memoryMode) return Promise.resolve([...store(storeName).values()].map(v => structuredClone(v)));
    return new Promise((res, rej) => {
      const r = db.transaction(storeName).objectStore(storeName).getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
    });
  }

  function del(storeName, id) {
    if (memoryMode) { store(storeName).delete(id); return Promise.resolve(); }
    return new Promise((res, rej) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  async function delWhere(storeName, pred) {
    const items = await all(storeName);
    for (const it of items) if (pred(it)) await del(storeName, it.id);
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
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const tx = db.transaction('messages', 'readwrite');
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
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const tx = db.transaction('messages', 'readwrite');
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
      for (const k of [...s.keys()]) if (k.startsWith(sessionId + ':')) s.delete(k);
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const tx = db.transaction('messages', 'readwrite');
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

  return { open, put, putWorkspace, get, all, del, delWhere, wipeAll, isMemoryMode: () => memoryMode,
    putMessages, appendMessages, getMessages, getMessagesRange, getMessagesTailWhile,
    countMessages, delMessages };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DB;
