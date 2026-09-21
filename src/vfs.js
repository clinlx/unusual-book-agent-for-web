'use strict';
const VFS = (() => {
  function createTree() { return { type: 'dir', name: '', children: {} }; }

  function normalize(path) {
    if (typeof path !== 'string') throw new Error('路径必须是字符串');
    const parts = [];
    for (const seg of path.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (!parts.length) throw new Error('路径越界: ' + path);
        parts.pop();
      } else parts.push(seg);
    }
    return parts;
  }

  
  function assertReadable(parts) {
    if (parts[0] !== 'workspace' && parts[0] !== '.reference')
      throw new Error('无权访问该路径');
  }
  
  function assertWritable(parts) {
    if (parts[0] !== 'workspace')
      throw new Error('只允许写入 /workspace/ 下');
  }

  function resolve(tree, parts) {
    let node = tree;
    for (const p of parts) {
      if (node.type !== 'dir' || !node.children[p]) return null;
      node = node.children[p];
    }
    return node;
  }

  function nowTs() { return typeof Date.now === 'function' ? Date.now() : 0; }

  function mkdirp(tree, parts, opts = {}) {
    let node = tree;
    for (const p of parts) {
      if (!node.children[p]) node.children[p] = { type: 'dir', name: p, children: {}, ctime: opts.now !== undefined ? opts.now : nowTs(), mtime: opts.now !== undefined ? opts.now : nowTs() };
      node = node.children[p];
      if (node.type !== 'dir') throw new Error('路径中存在同名文件: ' + p);
    }
    return node;
  }

  function readFile(tree, path, opts = {}) {
    const parts = normalize(path);
    assertReadable(parts);
    const node = resolve(tree, parts);
    if (!node) throw new Error('文件不存在: ' + path);
    if (node.type !== 'file') throw new Error('不是文件: ' + path);
    if (node.encoding === 'base64') throw new Error('该文件不能作为文本读取');
    const cap = opts.cap || 8000;
    const offset = Math.max(0, opts.offset || 0);
    const limit = Math.min(opts.limit || cap, cap);
    const content = node.content.slice(offset, offset + limit);
    return {
      content,
      totalLength: node.content.length,
      offset,
      returned: content.length,
      truncated: offset + content.length < node.content.length,
    };
  }

  function writeFile(tree, path, content, opts = {}) {
    const parts = normalize(path);
    assertWritable(parts);
    if (parts.length < 2) throw new Error('非法文件路径: ' + path);
    if (opts.cap && content.length > opts.cap)
      throw new Error('内容超过单次写入上限 ' + opts.cap + ' 字符，请先写入部分内容再用 apply_patch 分段追加');
    const dir = mkdirp(tree, parts.slice(0, -1), opts);
    const name = parts[parts.length - 1];
    const existing = dir.children[name];
    if (existing && existing.type === 'dir') throw new Error('同名目录已存在: ' + path);
    const ts = opts.now !== undefined ? opts.now : nowTs();
    dir.children[name] = { type: 'file', name, content: String(content), mtime: ts, ctime: (existing && existing.ctime !== undefined) ? existing.ctime : ts };
    if (opts.encoding === 'base64') dir.children[name].encoding = 'base64';
  }

  function fileBytes(node) {
    if (node.encoding === 'base64') return Uint8Array.from(atob(node.content), c => c.charCodeAt(0));
    return new TextEncoder().encode(node.content);
  }
  function byteSize(node) {
    return node.encoding === 'base64'
      ? node.content.length * 3 / 4 - (node.content.endsWith('==') ? 2 : node.content.endsWith('=') ? 1 : 0)
      : new TextEncoder().encode(node.content).length;
  }

  function listDir(tree, path) {
    const parts = normalize(path);
    assertReadable(parts);
    const node = resolve(tree, parts);
    if (!node) throw new Error('目录不存在: ' + path);
    if (node.type !== 'dir') throw new Error('不是目录: ' + path);
    return Object.values(node.children).map(c => ({
      name: c.name,
      type: c.type,
      size: c.type === 'file' ? (c.encoding === 'base64' ? byteSize(c) : c.content.length) : Object.keys(c.children).length,
      ...(c.encoding === 'base64' ? { binary: true } : {}),
      ctime: c.ctime,
      mtime: c.mtime,
    }));
  }

  function deletePath(tree, path) {
    const parts = normalize(path);
    assertWritable(parts);
    if (parts.length < 2) throw new Error('不能删除工作区根目录');
    const parent = resolve(tree, parts.slice(0, -1));
    const name = parts[parts.length - 1];
    if (!parent || parent.type !== 'dir' || !parent.children[name])
      throw new Error('路径不存在: ' + path);
    delete parent.children[name];
  }

  function clone(node) {
    return (typeof structuredClone === 'function')
      ? structuredClone(node)
      : JSON.parse(JSON.stringify(node));
  }

  function move(tree, from, to) {
    const fromParts = normalize(from); assertWritable(fromParts);
    const toParts = normalize(to); assertWritable(toParts);
    if (fromParts.length < 2) throw new Error('不能移动工作区根目录');
    if ((toParts.join('/') + '/').startsWith(fromParts.join('/') + '/'))
      throw new Error('不能移动到自身内部');
    const node = resolve(tree, fromParts);
    if (!node) throw new Error('路径不存在: ' + from);
    const destParent = mkdirp(tree, toParts.slice(0, -1));
    const destName = toParts[toParts.length - 1];
    if (destParent.children[destName]) throw new Error('目标已存在: ' + to);
    const srcParent = resolve(tree, fromParts.slice(0, -1));
    delete srcParent.children[node.name];
    node.name = destName;
    destParent.children[destName] = node;
  }

  function copy(tree, from, to) {
    const fromParts = normalize(from); assertReadable(fromParts);
    const toParts = normalize(to); assertWritable(toParts);
    const node = resolve(tree, fromParts);
    if (!node) throw new Error('路径不存在: ' + from);
    const destParent = mkdirp(tree, toParts.slice(0, -1));
    const destName = toParts[toParts.length - 1];
    if (destParent.children[destName]) throw new Error('目标已存在: ' + to);
    const copied = clone(node);
    copied.name = destName;
    destParent.children[destName] = copied;
  }

  function applyPatch(tree, path, oldStr, newStr, opts = {}) {
    const parts = normalize(path);
    assertWritable(parts);
    const node = resolve(tree, parts);
    if (!node || node.type !== 'file') throw new Error('文件不存在: ' + path);
    if (node.encoding === 'base64') throw new Error('非文本文件不能应用文本补丁');
    if (!oldStr) throw new Error('old_str 不能为空');
    if (opts.cap && (oldStr.length > opts.cap || String(newStr).length > opts.cap))
      throw new Error('补丁内容超过上限 ' + opts.cap + ' 字符，请拆分为多次补丁');
    const first = node.content.indexOf(oldStr);
    if (first === -1) throw new Error('old_str 未在文件中找到，请先 read_file 确认内容');
    if (node.content.indexOf(oldStr, first + 1) !== -1)
      throw new Error('old_str 在文件中出现多次，请提供更长的唯一片段');
    node.content = node.content.slice(0, first) + String(newStr) + node.content.slice(first + oldStr.length);
    node.mtime = opts.now !== undefined ? opts.now : nowTs();
  }

  
  function mkdir(tree, path, opts = {}) {
    const parts = normalize(path);
    assertWritable(parts);
    if (parts.length < 2) throw new Error('非法目录路径: ' + path);
    const parent = resolve(tree, parts.slice(0, -1));
    const name = parts[parts.length - 1];
    if (parent && parent.children[name]) throw new Error('已存在同名文件或目录: ' + name);
    mkdirp(tree, parts, opts);
  }

  
  function stat(tree, path) {
    const parts = normalize(path);
    const node = resolve(tree, parts);
    if (!node) throw new Error('路径不存在: ' + path);
    const info = { type: node.type, name: node.name || '/', ctime: node.ctime, mtime: node.mtime };
    if (node.type === 'file') {
      info.chars = node.encoding === 'base64' ? 0 : node.content.length;
      info.bytes = byteSize(node);
      info.lines = node.encoding === 'base64' ? 0 : node.content.length ? node.content.split('\n').length : 0;
    } else {
      let files = 0, dirs = 0, chars = 0;
      (function walk(n) {
        for (const c of Object.values(n.children)) {
          if (c.type === 'file') { files++; chars += c.encoding === 'base64' ? 0 : c.content.length; }
          else { dirs++; walk(c); }
        }
      })(node);
      info.files = files; info.dirs = dirs; info.chars = chars;
    }
    return info;
  }

  function search(tree, opts) {
    const { pattern, path = '/workspace', target = 'both', limit = 100, perFile = 10 } = opts;
    let re;
    try { re = new RegExp(pattern); } catch (e) { throw new Error('非法正则: ' + e.message); }
    const parts = normalize(path);
    assertReadable(parts);
    const root = resolve(tree, parts);
    if (!root || root.type !== 'dir') throw new Error('目录不存在: ' + path);
    const hits = [];
    let capped = false;
    (function walk(node, prefix) {
      if (capped) return;
      for (const name of Object.keys(node.children).sort()) {
        if (capped) return;
        const child = node.children[name];
        const p = prefix + '/' + name;
        if ((target === 'name' || target === 'both') && re.test(name)) {
          hits.push({ kind: 'name', path: p, type: child.type });
          if (hits.length >= limit) { capped = true; return; }
        }
        if (child.type === 'file' && child.encoding !== 'base64' && (target === 'content' || target === 'both')) {
          const lines = child.content.split('\n');
          let n = 0;
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              hits.push({ kind: 'content', path: p, line: i + 1, text: lines[i].slice(0, 200) });
              if (hits.length >= limit) { capped = true; return; }
              if (++n >= perFile) break;
            }
          }
        }
        if (child.type === 'dir') walk(child, p);
      }
    })(root, '/' + parts.join('/'));
    return { hits, capped };
  }

  function overview(tree, max = 200) {
    const ws = resolve(tree, ['workspace']);
    const lines = [];
    let n = 0, truncated = false;
    (function walk(node, indent) {
      if (!node) return;
      for (const name of Object.keys(node.children).sort()) {
        if (n >= max) { truncated = true; return; }
        const c = node.children[name];
        n++;
        lines.push(indent + (c.type === 'dir' ? name + '/' : name));
        if (c.type === 'dir') walk(c, indent + '  ');
      }
    })(ws, '');
    if (truncated) lines.push('…(已截断)');
    return lines.length ? lines.join('\n') : '(空)';
  }

  return { createTree, normalize, resolve, mkdir, mkdirp, readFile, writeFile, fileBytes, listDir, deletePath, move, copy, clone, applyPatch, search, overview, stat };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = VFS;

