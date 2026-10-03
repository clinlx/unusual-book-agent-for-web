'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const VFS = require('../../src/world-designer/vfs');
const Builder = require('../../src/world-designer/builder-tools');
const { fixture } = require('./world-fixture.cjs');
const validation = () => require('../../src/world-designer/validation');

test('merged opening instructions replace the two legacy opening files', () => {
  const f = fixture();
  VFS.deletePath(f.tree, f.root + '/开场白.md');
  VFS.deletePath(f.tree, f.root + '/样例开场.md');
  f.write('开场说明.md', '## 主持人开场白\n' + '主持说明。'.repeat(30) + '\n## 样例开场\n' + '开场小说。'.repeat(30));
  assert.deepEqual(Builder.validate(f.tree, f.root).errors, []);
  f.write('开场说明.md', '太短');
  assert.ok(Builder.validate(f.tree, f.root).issues.some(i => i.message.includes('内容过短') && i.path === f.root + '/开场说明.md'));
});

test('fixed openings accept the renamed original text without changing its contents', () => {
  const f = fixture(), original = '开场原文\n\n  原有对白与空白。\n';
  f.write('故事.txt', '既定主角');
  f.write('开场原文.txt', original);
  assert.deepEqual(Builder.validate(f.tree, f.root).errors, []);
  assert.equal(VFS.readFile(f.tree, f.root + '/开场原文.txt').content, original);
});

test('worlds without opening files report the new opening instructions path', () => {
  const f = fixture();
  VFS.deletePath(f.tree, f.root + '/开场白.md');
  VFS.deletePath(f.tree, f.root + '/样例开场.md');
  const result = Builder.validate(f.tree, f.root);
  assert.deepEqual(result.issues.map(i => i.path), [f.root + '/开场说明.md']);
});

test('diagnostics carry exact file paths, including field errors and punctuation in names', () => {
  const f = fixture();
  f.write('世界状态和世界规则/世界共识.json', {});
  f.write('Player-pc/基础信息.json', { 姓名: '张三', 状态: {} });
  f.write('资料/有 空格:符号.json', '{');
  const result = Builder.validate(f.tree, f.root);
  assert.ok(result.issues?.length, 'structured diagnostics must exist');
  assert.deepEqual(result.issues.map(i => i.message), result.errors);
  assert.ok(result.issues.some(i => i.message.includes('世界时间') && i.path === f.root + '/世界状态和世界规则/世界共识.json'));
  assert.ok(result.issues.some(i => i.message.includes('/状态') && i.path === f.root + '/Player-pc/基础信息.json'));
  assert.ok(result.issues.some(i => i.path === f.root + '/资料/有 空格:符号.json'));
});

test('validation covers multiple worlds and incomplete nested worlds without a player', () => {
  const f = fixture(), v = validation();
  assert.equal(v.check(f.tree).valid, true);
  f.write('../unfinished/模组.md', '未完成');
  const result = v.check(f.tree);
  assert.deepEqual(result.roots.sort(), ['/workspace/unfinished', f.root].sort());
  assert.equal(result.valid, false);
  assert.ok(result.issues.every(i => i.root === '/workspace/unfinished'));
  assert.equal(v.check(f.tree, [f.root]).valid, true);
});

test('error navigation chooses the existing file or nearest existing parent without escaping workspace', () => {
  const f = fixture(), v = validation();
  const file = f.root + '/Player-pc/基础信息.json';
  assert.deepEqual(v.locate(f.tree, file), { path: file, directory: f.root + '/Player-pc', file: true });
  assert.deepEqual(v.locate(f.tree, f.root + '/不存在/二级/缺失.json'), { path: f.root, directory: f.root, file: false });
  assert.deepEqual(v.locate(f.tree, f.root + '/Player-pc/缺失.json'), { path: f.root + '/Player-pc', directory: f.root + '/Player-pc', file: false });
  assert.throws(() => v.locate(f.tree, '/skills/secret'), /workspace/);
  assert.throws(() => v.locate(f.tree, '/workspace/../skills/secret'), /workspace/);
});

test('unexpected validator errors produce a failing report rather than a green status', () => {
  const f = fixture(), old = Builder.validate;
  try {
    Builder.validate = () => { throw Error('无法读取文件'); };
    const report = validation().check(f.tree);
    assert.equal(report.valid, false);
    assert.match(report.issues[0].message, /无法读取文件/);
    assert.equal(report.issues[0].path, f.root);
  } finally { Builder.validate = old; }
});

test('play preview validates the unsaved text without modifying the live world', () => {
  const f = fixture(), v = validation(), before = JSON.stringify(f.tree);
  const preview = v.withDraft(f.tree, f.root + '/世界状态和世界规则/世界共识.json', '{}');
  assert.equal(v.check(preview).valid, false);
  assert.equal(v.check(f.tree).valid, true);
  assert.equal(JSON.stringify(f.tree), before);
  assert.equal(VFS.readFile(preview, f.root + '/世界状态和世界规则/世界共识.json').content, '{}');
});

test('repair message includes each exact diagnostic and directs tools to validate the repaired worlds', () => {
  const f = fixture(), v = validation();
  assert.throws(() => v.repairMessage(v.check(f.tree)), /没有需要修复/);
  f.write('世界状态和世界规则/世界共识.json', '{}');
  const report = v.check(f.tree), text = v.repairMessage(report);
  assert.match(text, /请自动修复当前工作区/);
  assert.match(text, /validate_game_structure/);
  assert.match(text, /保留现有故事/);
  for (const issue of report.issues) { assert.ok(text.includes(issue.message)); assert.ok(text.includes(issue.path)); }
});
