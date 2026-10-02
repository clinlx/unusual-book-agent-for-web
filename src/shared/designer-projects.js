'use strict';
// A read-only doorway into designer projects. Page settings, skills and chat never leave the workbench.
const DesignerProjects = (() => {
  const key = id => 'world-validation:' + id;
  function summary(report, current = true) {
    return { valid: report?.valid === true, current, checkedAt: report ? report.checkedAt || Date.now() : null,
      roots: (report?.roots || []).map(path => ({ path, valid: !report.issues.some(issue => issue.root === path) })) };
  }
  function editURL(id) { return 'designer.html#project=' + encodeURIComponent(id); }
  const safeRoot = root => typeof root === 'string' && /^\/workspace(?:\/|$)/.test(root) && !/[\\\u0000-\u001f]/.test(root) && !root.split('/').some(part => ['..', '__proto__', 'constructor', 'prototype'].includes(part));
  function eligible(value) { return value?.valid === true && value.current === true && value.roots?.length > 0 && value.roots.every(root => root.valid === true); }
  function busy(id) {
    try {
      const record = JSON.parse(globalThis.localStorage?.getItem('awl:lease:' + id) || 'null');
      return !!record?.tab && Date.now() - record.ts <= 15000;
    } catch (_) { return false; }
  }
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  async function read(action, factory = globalThis.indexedDB) {
    if (!factory) throw Error('浏览器存储不可用，请在设计者中下载 ZIP 后从文件导入');
    const db = await new Promise((resolve, reject) => {
      let missing = false, r;
      try { r = factory.open('agent-workbench'); } catch (error) { reject(error); return; }
      r.onupgradeneeded = () => { missing = true; r.transaction.abort(); }; // Never create or upgrade the designer database.
      r.onerror = () => missing ? resolve(null) : reject(r.error);
      r.onblocked = () => reject(Error('设计者数据库被占用，请关闭其他页面后重试'));
      r.onsuccess = () => resolve(r.result);
    });
    if (!db) return action(null);
    try {
      if (!['projects', 'config', 'vfs'].every(name => db.objectStoreNames.contains(name))) throw Error('设计者数据版本无法读取，请先打开世界设计者');
      return await action(db);
    } finally { db.close(); }
  }
  async function list(factory) {
    return read(async db => {
      if (!db) return [];
      const projects = await request(db.transaction('projects').objectStore('projects').getAll());
      const tx = db.transaction('config'), store = tx.objectStore('config');
      return Promise.all(projects.map(async project => {
        const record = await request(store.get(key(project.id))), validation = record?.value;
        return { id: project.id, name: project.name, validation, available: eligible(validation) && !busy(project.id) };
      }));
    }, factory);
  }
  async function load(id, root, factory) {
    if (!safeRoot(root)) throw Error('世界目录必须位于 /workspace 内');
    return read(async db => {
      if (!db) throw Error('设计者项目不存在');
      const tx = db.transaction(['projects', 'config', 'vfs']);
      const [project, record, workspace] = await Promise.all([
        request(tx.objectStore('projects').get(id)), request(tx.objectStore('config').get(key(id))), request(tx.objectStore('vfs').get(id)),
      ]);
      if (!project || !workspace?.tree) throw Error('设计者项目已删除或没有工作区');
      if (!eligible(record?.value) || busy(id)) throw Error('项目尚未通过最新校验，或正在生成内容。请先前往设计者完成校验。');
      if (!record.value.roots.some(item => item.path === root && item.valid)) throw Error('世界目录已变化，请重新选择项目');
      return { name: project.name, tree: workspace.tree, root };
    }, factory);
  }
  async function archive(project, onProgress = () => {}, deps = {}) {
    if (!safeRoot(project.root)) throw Error('世界目录必须位于 /workspace 内');
    const vfs = deps.vfs || VFS, zip = deps.zip || ZIP;
    const node = vfs.resolve(project.tree, vfs.normalize(project.root));
    if (!node || node.type !== 'dir') throw Error('世界目录不存在');
    const entries = []; let nextPaint = 0;
    async function collect(dir, prefix) {
      for (const name of Object.keys(dir.children).sort()) {
        if (!prefix && name === '.trpg-save.json') continue;
        const child = dir.children[name];
        if (child.type === 'file') entries.push({ name: prefix + name, bytes: vfs.fileBytes(child), mtime: child.mtime });
        else { entries.push({ name: prefix + name + '/', mtime: child.mtime }); await collect(child, prefix + name + '/'); }
        if (Date.now() >= nextPaint) { onProgress('正在整理世界文件：' + entries.length + ' 项'); await new Promise(resolve => setTimeout(resolve, 0)); nextPaint = Date.now() + 12; }
      }
    }
    await collect(node, '');
    if (!entries.some(item => !item.name.endsWith('/'))) throw Error('世界目录为空');
    return zip.makeZipAsync(entries, p => onProgress('正在打包世界：' + p.completed + ' / ' + p.total + ' 项', p.completed / p.total));
  }
  return { key, summary, eligible, editURL, list, load, archive };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DesignerProjects;
