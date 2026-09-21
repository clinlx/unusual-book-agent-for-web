'use strict';
const WorkspaceImport = (() => {
  const vfs = typeof module !== 'undefined' ? require('./vfs.js') : VFS;
  const zip = typeof module !== 'undefined' ? require('./zip.js') : ZIP;

  function safePath(name) {
    const path = String(name).replace(/\\/g, '/').replace(/\/$/, '');
    const parts = path.split('/');
    if (!path || path.startsWith('/') || parts.some(p => !p || p === '.' || p === '..' ||
        ['__proto__', 'constructor', 'prototype'].includes(p) || /[:\u0000-\u001f]/.test(p)))
      throw new Error('不安全的导入路径: ' + name);
    return path;
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768)
      s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
  }

  function entry(name, bytes, isDir = false, mtime) {
    name = safePath(name);
    if (isDir) return { name, isDir: true };
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      
      const binaryExt = /\.(pdf|docx?|xlsx?|xlsm|pptx?|od[pts]|pages|numbers|key|epub|png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic|zip|rar|7z|gz|tar|mp[34]|wav|ogg|webm|mov|exe|dll|wasm|ttf|woff2?|db|sqlite3?)$/i;
      if (binaryExt.test(name) || /[\u0000-\u0008\u000e-\u001f]/.test(text)) text = null;
    } catch (_) { text = null; }
    const metadata = { name, size: bytes.length, mtime: Number.isFinite(mtime) ? mtime : null };
    return text === null ? { ...metadata, content: toBase64(bytes), encoding: 'base64' }
      : { ...metadata, content: text };
  }

  async function prepare(files, { extractZip = false } = {}) {
    const entries = [];
    for (const file of files) {
      if (file.isDir) { entries.push(entry(file.name, null, true)); continue; }
      const name = safePath(file.webkitRelativePath || file.name);
      const buffer = await file.arrayBuffer();
      if (extractZip) {
        if (!/\.zip$/i.test(name)) throw new Error('解压入口只接受 ZIP 文件');
        for (const item of await zip.parseZip(buffer)) entries.push({
          ...entry(item.name, item.bytes, item.isDir, item.mtime), source: name,
        });
      } else entries.push(entry(name, new Uint8Array(buffer), false, file.lastModified));
    }
    return entries;
  }

  
  function plan(original, destDir, entries, choices = {}) {
    if (!/^\/workspace(?:\/|$)/.test(destDir) || vfs.normalize(destDir).join('/') !== destDir.slice(1))
      throw new Error('只能导入工作区路径');
    const tree = vfs.clone(original);
    if (destDir === '/workspace' && !vfs.resolve(tree, ['workspace'])) vfs.mkdirp(tree, ['workspace']);
    if (vfs.resolve(tree, vfs.normalize(destDir))?.type !== 'dir') throw new Error('目标文件夹不存在');
    const dirMap = new Map(), conflicts = [], imported = new Set();
    const unique = path => {
      const m = path.match(/^(.*?)(\.[^/.]+)?$/);
      let target = path, i = 2;
      while (vfs.resolve(tree, vfs.normalize(target))) target = m[1] + '-' + i++ + (m[2] || '');
      return target;
    };
    const metadata = (node, source) => ({ type: node.isDir || node.type === 'dir' ? 'dir' : 'file',
      size: node.isDir || node.type === 'dir' ? null : node.size ?? vfs.fileBytes({ ...node, type: 'file' }).length,
      mtime: node.mtime ?? null, source });
    function conflict(id, target, item) {
      const node = vfs.resolve(tree, vfs.normalize(target));
      const canReplace = node.type === 'file' && !item.isDir;
      const choice = choices[id] || 'keep';
      if (!['keep', 'skip', 'replace'].includes(choice)) throw new Error('无效的冲突处理方式');
      if (choice === 'replace' && !canReplace) throw new Error('文件与文件夹重名时不能覆盖');
      const result = choice === 'skip' ? null : choice === 'keep' ? unique(target) : target;
      conflicts.push({ id, path: target, result, choice, canReplace,
        existing: metadata(node, imported.has(target) ? '本次上传' : '工作区'),
        incoming: metadata(item, item.source || '本次上传') });
      return result;
    }
    function directory(relative) {
      if (!relative) return destDir;
      if (dirMap.has(relative)) return dirMap.get(relative);
      const parts = relative.split('/'), name = parts.pop();
      const parent = directory(parts.join('/'));
      if (parent === null) { dirMap.set(relative, null); return null; }
      let target = parent + '/' + name;
      const node = vfs.resolve(tree, vfs.normalize(target));
      if (node && node.type !== 'dir') target = conflict('dir:' + relative, target, { isDir: true });
      if (target !== null) vfs.mkdirp(tree, vfs.normalize(target));
      dirMap.set(relative, target);
      return target;
    }
    let count = 0;
    for (const [index, item] of entries.entries()) {
      const name = safePath(item.name);
      if (item.isDir) { directory(name); continue; }
      const parts = name.split('/'), leaf = parts.pop();
      const parent = directory(parts.join('/'));
      if (parent === null) continue;
      let target = parent + '/' + leaf;
      if (vfs.resolve(tree, vfs.normalize(target))) target = conflict('file:' + index, target, item);
      if (target === null) continue;
      vfs.writeFile(tree, target, item.content, { encoding: item.encoding });
      
      vfs.resolve(tree, vfs.normalize(target)).mtime = item.mtime ?? null;
      imported.add(target);
      count++;
    }
    return { tree, count, conflicts };
  }

  function apply(tree, destDir, entries, choices = {}) {
    const result = plan(tree, destDir, entries, choices);
    if (result.conflicts.some(c => !Object.hasOwn(choices, c.id))) throw new Error('请先确认文件冲突处理方式');
    Object.assign(tree, result.tree);
    return result.count;
  }

  
  async function droppedFiles(dataTransfer) {
    const roots = [...(dataTransfer.items || [])].map(i => ({
      entry: i.webkitGetAsEntry?.(), file: i.getAsFile?.(),
    })).filter(root => root.entry || root.file);
    if (!roots.length) return [...dataTransfer.files];
    const out = [];
    async function walk(item, prefix) {
      const name = prefix + item.name;
      if (item.isFile) {
        const file = await new Promise((resolve, reject) => item.file(resolve, reject));
        out.push({ name: file.name, webkitRelativePath: prefix ? name : '', lastModified: file.lastModified,
          size: file.size, arrayBuffer: () => file.arrayBuffer() });
      } else if (item.isDirectory) {
        out.push({ name, isDir: true });
        const reader = item.createReader();
        while (true) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await walk(child, name + '/');
        }
      }
    }
    for (const root of roots) {
      
      if (!root.entry?.isDirectory && root.file) { out.push(root.file); continue; }
      try { await walk(root.entry, ''); }
      catch (error) {
        if (root.entry?.isDirectory) throw new Error('浏览器无法读取拖入的文件夹，请使用“上传 → 上传文件夹”，或通过 HTTP/HTTPS 打开页面后重试。', { cause: error });
        throw error;
      }
    }
    return out;
  }
  return { prepare, plan, apply, droppedFiles };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorkspaceImport;
