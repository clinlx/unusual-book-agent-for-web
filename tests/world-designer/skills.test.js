'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../../src/world-designer/skills.js');

test('parseFrontmatter 提取 name 与 description', () => {
  const md = '---\nname: my-skill\ndescription: 测试用\n---\n# 正文\n步骤';
  const fm = S.parseFrontmatter(md);
  assert.strictEqual(fm.name, 'my-skill');
  assert.strictEqual(fm.description, '测试用');
  assert.strictEqual(fm.body.trim(), '# 正文\n步骤');
});

test('stripGarbage 剔除垃圾文件与目录', () => {
  const files = [
    { name: 'skill/SKILL.md', text: 'x' },
    { name: '__MACOSX/foo', text: '' },
    { name: 'skill/.DS_Store', text: '' },
    { name: 'skill/Thumbs.db', text: '' },
    { name: 'skill/ref.md', text: 'y' },
  ];
  const clean = S.stripGarbage(files);
  assert.deepStrictEqual(clean.map(f => f.name).sort(), ['skill/SKILL.md', 'skill/ref.md']);
});

test('findRoot 兼容自身为根与单文件夹包裹两种布局', () => {
  assert.strictEqual(S.findRoot([{ name: 'SKILL.md' }, { name: 'ref.md' }]), '');
  assert.strictEqual(S.findRoot([{ name: 'pkg/SKILL.md' }, { name: 'pkg/ref.md' }]), 'pkg/');
});

test('buildSkill 成功：返回 skill 对象与挂载文件', () => {
  const files = [
    { name: 'my-skill/SKILL.md', text: '---\nname: my-skill\ndescription: d\n---\n正文', isDir: false },
    { name: 'my-skill/tpl.md', text: '模板', isDir: false },
    { name: 'my-skill/__MACOSX/z', text: '', isDir: false },
  ];
  const r = S.buildSkill(files, { existingNames: [] });
  assert.strictEqual(r.skill.name, 'my-skill');
  assert.strictEqual(r.skill.description, 'd');
  assert.strictEqual(r.skill.instructions.trim(), '正文');
  assert.deepStrictEqual(r.skill.files, { '/skills/my-skill/tpl.md': '模板' });
  assert.deepStrictEqual(r.warnings, []);
});

test('buildSkill 脚本文件产生警告但不失败', () => {
  const files = [
    { name: 'SKILL.md', text: '---\nname: s2\ndescription: d\n---\n正文', isDir: false },
    { name: 'run.py', text: 'print(1)', isDir: false },
    { name: 'x.js', text: '1', isDir: false },
  ];
  const r = S.buildSkill(files, { existingNames: [] });
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /脚本/);
  assert.ok(r.skill.files['/skills/s2/run.py']); // 仍挂载，仅不执行
});

test('buildSkill 失败：缺 SKILL.md / 重名 / 非法 name', () => {
  assert.throws(() => S.buildSkill([{ name: 'ref.md', text: 'x', isDir: false }], { existingNames: [] }), /缺少 SKILL\.md/);
  const ok = [{ name: 'SKILL.md', text: '---\nname: dup\ndescription: d\n---\n正文', isDir: false }];
  assert.throws(() => S.buildSkill(ok, { existingNames: ['dup'] }), /已存在/);
  const bad = [{ name: 'SKILL.md', text: '---\nname: Bad Name!\ndescription: d\n---\n正文', isDir: false }];
  assert.throws(() => S.buildSkill(bad, { existingNames: [] }), /名称不合法/);
});

// 回归：Windows 上编辑的 SKILL.md 是 CRLF 行尾，早期 parseFrontmatter 硬要求
// ^---\n，导致每行尾残留 \r、name/description 全部解析不出，合法 Skill 被误判
// 为「名称不合法」。BOM 同理会让 ^--- 匹配失败。
test('parseFrontmatter 兼容 CRLF 行尾', () => {
  const fm = S.parseFrontmatter('---\r\nname: write-novel\r\ndescription: 中文说明\r\n---\r\n# 标题\r\n正文');
  assert.strictEqual(fm.name, 'write-novel');
  assert.strictEqual(fm.description, '中文说明');
  assert.ok(!/\r/.test(fm.body), 'body 不应残留 \r');
  assert.strictEqual(fm.body, '# 标题\n正文');
});

test('parseFrontmatter 兼容 UTF-8 BOM 与裸 CR', () => {
  const bom = S.parseFrontmatter('﻿---\nname: a-b\ndescription: d\n---\n正文');
  assert.strictEqual(bom.name, 'a-b');
  const cr = S.parseFrontmatter('---\rname: a-b\rdescription: d\r---\r正文');
  assert.strictEqual(cr.name, 'a-b');
});

test('parseFrontmatter 无 frontmatter 时 body 也已归一化', () => {
  assert.strictEqual(S.parseFrontmatter('# 标题\r\n正文').body, '# 标题\n正文');
});

test('buildSkill 接受 CRLF Skill 并归一化附件文本', () => {
  const files = [
    { name: 'SKILL.md', text: '---\r\nname: crlf-skill\r\ndescription: d\r\n---\r\n正文', isDir: false },
    { name: 'references/style.md', text: '第一行\r\n第二行', isDir: false },
  ];
  const r = S.buildSkill(files, { existingNames: [] });
  assert.strictEqual(r.skill.name, 'crlf-skill');
  assert.strictEqual(r.skill.files['/skills/crlf-skill/references/style.md'], '第一行\n第二行');
});
