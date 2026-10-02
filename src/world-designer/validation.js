'use strict';
// Validation and navigation use explicit diagnostic paths, never parse human-readable messages.
const WorldValidation = (() => {
  const node = typeof module !== 'undefined' && module.exports;
  const builder = node ? require('./builder-tools') : BuilderTools;
  const vfs = node ? require('./vfs') : VFS;
  const handoff = node ? require('../shared/world-handoff') : WorldHandoff;
  function check(tree, roots = handoff.roots(tree)) {
    const issues = [];
    for (const root of roots) {
      try { issues.push(...builder.validate(tree, root).issues.map(issue => ({ ...issue, root }))); }
      catch (error) { issues.push({ root, path: root, message: '[校验失败] ' + error.message }); }
    }
    return { valid: issues.length === 0, roots, issues };
  }
  function locate(tree, path) {
    if (!/^\/workspace(?:\/|$)/.test(path) || /[\\\u0000-\u001f]/.test(path) || path.split('/').includes('..'))
      throw Error('错误路径必须位于 /workspace 内');
    const parts = vfs.normalize(path);
    let target;
    while (parts.length && !(target = vfs.resolve(tree, parts))) parts.pop();
    if (parts[0] !== 'workspace') throw Error('/workspace 不存在');
    const actual = '/' + parts.join('/'), file = target.type === 'file';
    return { path: actual, directory: file ? '/' + parts.slice(0, -1).join('/') : actual, file };
  }
  // A play confirmation validates the text that will be saved, without altering the editor or VFS.
  function withDraft(tree, path, content) {
    locate(tree, path); // Enforce the workspace boundary even when a parent has disappeared.
    const copy = { ...tree, children: { ...tree.children } }, parts = vfs.normalize(path);
    let parent = copy;
    for (const name of parts.slice(0, -1)) {
      const child = parent.children[name];
      parent.children[name] = child ? { ...child, children: { ...child.children } } : { type: 'dir', name, children: {} };
      parent = parent.children[name];
    }
    const name = parts.at(-1);
    if (parent.children[name]) parent.children[name] = { ...parent.children[name] };
    vfs.writeFile(copy, path, content);
    return copy;
  }
  function repairMessage(report) {
    if (!report || report.valid || !report.issues.length) throw Error('当前没有需要修复的格式错误');
    return '请自动修复当前工作区中的世界格式错误。先读取相关文件，按下面的错误报告逐项使用文件工具修复；保留现有故事、人物与设定，只修改解决错误所需的内容，不要删除内容来绕过校验。\n'
      + '修复后对各世界目录调用 validate_game_structure，继续处理剩余错误，直到校验通过；最后简要说明修改结果。如果无法解决，请明确说明仍存在的问题与原因。\n\n'
      + '## 错误报告\n\n世界目录：\n' + report.roots.map(root => '- ' + root).join('\n')
      + '\n\n发现 ' + report.issues.length + ' 项错误：\n' + report.issues.map((issue, i) => `${i + 1}. ${issue.message}\n   路径：${issue.path}`).join('\n');
  }
  return { check, locate, withDraft, repairMessage };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorldValidation;
