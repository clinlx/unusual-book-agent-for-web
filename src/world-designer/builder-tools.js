'use strict';
// Trusted, bundled skill tools. Uploaded/edited JavaScript is never evaluated.
const BuilderTools = (() => {
  const validator = typeof module !== 'undefined' && module.exports
    ? require('../../skills/game-world-builder/scripts/validate_game_structure.js') : WorldStructureValidator;
  const schema = typeof module !== 'undefined' && module.exports
    ? require('../../skills/game-world-builder/scripts/world-schema.json') : WORLD_BUILDER_SCHEMA;
  const skillName = 'game-world-builder';
  const definitions = [{ type: 'function', function: {
    name: 'validate_game_structure',
    description: '校验当前虚拟工作区内的游戏世界目录：文件、JSON、角色、引用、物品位置。只读，不自动修复；根据 errors 用文件工具修复后重新调用。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '世界根目录，必须是 /workspace 或其子目录，例如 /workspace/my-world' } }, required: ['path'], additionalProperties: false },
  } }];
  const enabled = skills => (skills || []).some(skill => skill.name === skillName);

  function normalize(value) {
    const parts = [];
    for (const part of String(value).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return '/' + parts.join('/');
  }
  const virtualPath = {
    sep: '/',
    resolve: (...parts) => normalize(parts.reduce((base, part) => String(part).startsWith('/') ? part : base + '/' + part, '/')),
    join: (...parts) => normalize(parts.join('/')),
    basename: value => normalize(value).split('/').pop(),
    dirname: value => normalize(value).split('/').slice(0, -1).join('/') || '/',
    extname: value => { const name = virtualPath.basename(value), index = name.lastIndexOf('.'); return index > 0 ? name.slice(index) : ''; },
    isAbsolute: value => value.startsWith('/'),
    relative: (from, to) => {
      const a = normalize(from).split('/').filter(Boolean), b = normalize(to).split('/').filter(Boolean);
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
    },
  };
  function validate(tree, root) {
    if (typeof root !== 'string' || !/^\/workspace(?:\/|$)/.test(root) || /[\\:\u0000-\u001f]/.test(root)
      || root.split('/').some(part => ['..', '__proto__', 'constructor', 'prototype'].includes(part)))
      throw Error('世界路径必须位于 /workspace 内，不能包含越界路径');
    root = normalize(root);
    const nodeAt = file => {
      const normalized = normalize(file);
      if (normalized !== root && !normalized.startsWith(root + '/')) throw Error('路径超出世界目录');
      let node = tree;
      for (const part of normalized.split('/').filter(Boolean)) {
        if (node?.type !== 'dir' || !Object.hasOwn(node.children, part)) throw Error('文件不存在: ' + normalized);
        node = node.children[part];
      }
      return node;
    };
    const fs = {
      lstatSync: file => { const node = nodeAt(file); return { isDirectory: () => node.type === 'dir', isFile: () => node.type === 'file' }; },
      readdirSync: file => {
        const node = nodeAt(file);
        if (node.type !== 'dir') throw Error('不是目录: ' + file);
        return Object.entries(node.children).map(([name, child]) => ({ name, isDirectory: () => child.type === 'dir', isFile: () => child.type === 'file' }));
      },
      readFileSync: file => {
        const node = nodeAt(file);
        if (node.type !== 'file' || node.encoding === 'base64' || typeof node.content !== 'string') throw Error('不是可读取的文本文件: ' + file);
        return node.content;
      },
      realpathSync: file => { nodeAt(file); return normalize(file); },
    };
    const issues = [];
    const errors = validator.create({ fs, path: virtualPath, schema, referencePrefix: root, onIssue: issue => issues.push(issue) }).validateStructure(root);
    return { valid: errors.length === 0, path: root, errorCount: errors.length, errors, issues,
      note: errors.length ? '请修复虚拟世界文件后重新调用本工具。' : '结构校验通过；仍需完成剧情与内容自查。' };
  }
  return { definitions, enabled, validate };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BuilderTools;
