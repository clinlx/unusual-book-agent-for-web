'use strict';
const TempFiles = (() => {
  const vfs = typeof module !== 'undefined' ? require('./vfs.js') : VFS;
  function touch(tree, path, now = Date.now()) {
    if (!path.startsWith('/tmp/')) return;
    const node = vfs.resolve(tree, vfs.normalize(path));
    if (node && node.type === 'file') node.tmp = { lastUsedAt: now, idleTurns: 0 };
  }
  // State lives on the file node so refreshes and project switches cannot reset TTL.
  function sweep(tree, options = {}) {
    const { now = Date.now(), advance = false, used = new Set(), protect = new Set(),
      ttlTurns = 10, maxAgeMs = 7 * 86400000, maxBytes = 100 * 1024 * 1024 } = options;
    const files = [], removed = [];
    let changed = false;
    const root = vfs.resolve(tree, ['tmp']);
    function walk(node, path) {
      for (const child of Object.values(node.children)) {
        const p = path + '/' + child.name;
        if (child.type === 'dir') walk(child, p);
        else {
          if (!child.tmp) { child.tmp = { lastUsedAt: Number.isFinite(child.mtime) ? child.mtime : now, idleTurns: 0 }; changed = true; }
          if (used.has(p)) { touch(tree, p, now); changed = true; }
          else if (advance) { child.tmp.idleTurns++; changed = true; }
          // Conservative storage estimate: includes original base64, previews and metadata.
          files.push({ path: p, node: child, bytes: JSON.stringify(child).length * 2 });
        }
      }
    }
    if (!root) return { changed, removed, bytes: 0 };
    walk(root, '/tmp');
    const erase = f => { vfs.deletePath(tree, f.path); removed.push(f.path); changed = true; };
    const remaining = [];
    for (const f of files) {
      if (!protect.has(f.path) && (f.node.tmp.idleTurns >= ttlTurns || now - f.node.tmp.lastUsedAt >= maxAgeMs)) erase(f);
      else remaining.push(f);
    }
    let bytes = remaining.reduce((n, f) => n + f.bytes, 0);
    for (const f of remaining.sort((a, b) => a.node.tmp.lastUsedAt - b.node.tmp.lastUsedAt)) {
      if (bytes <= maxBytes) break;
      if (protect.has(f.path)) continue;
      erase(f); bytes -= f.bytes;
    }
    return { changed, removed, bytes };
  }
  return { touch, sweep };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TempFiles;
