'use strict';
const DesignerStorage = (() => {
  const bytes = value => new TextEncoder().encode(value).byteLength;
  const jsonBytes = value => bytes(JSON.stringify(value));
  const nonempty = value => value != null && value !== '' && value !== false && value !== 0
    && (typeof value !== 'object' || Object.keys(value).length > 0);

  // Count editable data rather than the immutable resources mounted on every entry.
  function fileBytes(tree, seeds) {
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
    return userTree ? jsonBytes(userTree) : 0;
  }
  function chatBytes(session, messages) {
    const metadata = {};
    const fixedKeys = new Set(['id', 'projectId', 'groupId', 'createdAt', 'updatedAt', 'msgCount', 'messages', 'attachmentVersion']);
    for (const [key, value] of Object.entries(session)) {
      if (fixedKeys.has(key) || key.startsWith('__') || !nonempty(value)) continue;
      if (key === 'name' && /^新会话(?: \d+)?$/.test(value)) continue;
      metadata[key] = value;
    }
    return (messages.length ? jsonBytes(messages) : 0) + (Object.keys(metadata).length ? jsonBytes(metadata) : 0);
  }
  async function estimate(db, seeds) {
    const [sessions, snapshots, workspaces, groups, config] = await Promise.all([
      db.all('sessions'), db.all('snapshots'), db.all('vfs'), db.all('groups'), db.all('config'),
    ]);
    const perProject = new Map();
    const entry = id => {
      if (!perProject.has(id)) perProject.set(id, { chat: 0, files: 0, snaps: 0, snapCount: 0, other: 0 });
      return perProject.get(id);
    };
    for (const session of sessions) entry(session.projectId).chat += chatBytes(session, await db.getMessages(session.id));
    for (const snap of snapshots) { const e = entry(snap.projectId); e.snaps += jsonBytes(snap); e.snapCount++; }
    for (const workspace of workspaces) entry(workspace.id).files += fileBytes(workspace.tree, seeds);
    for (const group of groups) entry(group.projectId).other += jsonBytes(group);
    for (const record of config) {
      const match = /^(?:pending|stream):(.+)$/.exec(record.id);
      if (match && nonempty(record.value)) entry(match[1]).other += jsonBytes(record);
    }
    const total = [...perProject.values()].reduce((sum, e) => sum + e.chat + e.files + e.snaps + e.other, 0);
    return { perProject, total };
  }
  return { fileBytes, chatBytes, estimate };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DesignerStorage;
