'use strict';
// Only explicitly exported world archives cross this boundary; settings and skills do not.
const WorldHandoff = (() => {
  const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
  const saveId = id => { if (!validId(id)) throw Error('世界交接编号无效'); return 'world-handoff-' + id; };
  function fromHash(hash) {
    const id = new URLSearchParams(String(hash).replace(/^#/, '')).get('handoff');
    if (id !== null) saveId(id);
    return id;
  }
  function roots(tree) {
    const found = [];
    function walk(node, path) {
      if (node?.type !== 'dir') return;
      // Include unfinished worlds so a missing player can be diagnosed in its own directory.
      if (Object.entries(node.children).some(([name, child]) =>
        (child.type === 'dir' && (/^Player-/.test(name) || name === '世界状态和世界规则')) ||
        (child.type === 'file' && name === '模组.md'))) { found.push(path); return; }
      for (const [name, child] of Object.entries(node.children)) if (child.type === 'dir') walk(child, path + '/' + name);
    }
    walk(tree?.children?.workspace, '/workspace');
    return found.length ? found : ['/workspace'];
  }
  function create(factory = globalThis.indexedDB) {
    let connection;
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    async function open() {
      if (!factory) throw Error('浏览器不支持本地交接存储，请导出 ZIP 后手动导入');
      if (!connection) connection = new Promise((resolve, reject) => {
        let r;
        try { r = factory.open('world-play-handoff', 1); } catch (e) { reject(e); return; }
        r.onupgradeneeded = () => r.result.createObjectStore('transfers', { keyPath: 'id' });
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(Error('交接数据库被其他页面占用，请关闭其他页面后重试'));
        r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); connection = null; }; resolve(r.result); };
      }).catch(error => { connection = null; throw error; });
      return connection;
    }
    async function transaction(mode, action) {
      const db = await open(), tx = db.transaction('transfers', mode);
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || Error('交接存储事务中断')); });
      try { const result = await action(tx.objectStore('transfers')); await done; return result; }
      catch (error) { try { tx.abort(); } catch (_) {} await done.catch(() => {}); throw error; }
    }
    async function get(id) { saveId(id); return transaction('readonly', store => request(store.get(id))); }
    async function put(blob, name) {
      if (!(blob instanceof Blob) || !blob.size) throw Error('世界 ZIP 为空');
      const id = crypto.randomUUID();
      await transaction('readwrite', store => request(store.add({ id, name: String(name || '新世界'), blob, createdAt: Date.now(), status: 'pending' })));
      return id;
    }
    async function complete(id) {
      await transaction('readwrite', async store => {
        const record = await request(store.get(id));
        if (record) { delete record.blob; record.status = 'complete'; record.completedAt = Date.now(); await request(store.put(record)); }
      });
    }
    async function prune() {
      await transaction('readwrite', store => new Promise((resolve, reject) => {
        const r = store.openCursor(), cutoff = Date.now() - 7 * 86400000;
        r.onerror = () => reject(r.error);
        r.onsuccess = () => { const cursor = r.result; if (!cursor) return resolve(); if ((cursor.value.completedAt || cursor.value.createdAt) < cutoff) cursor.delete(); cursor.continue(); };
      }));
    }
    return { get, put, complete, prune };
  }
  return { create, roots, fromHash, saveId };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorldHandoff;
