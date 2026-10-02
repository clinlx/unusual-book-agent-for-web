'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../../scripts/bundle-skills.js');
const L = require('../../src/world-designer/skill-loader.js');

// 在临时目录搭一个 dist 结构
function scaffold(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-bundle-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}
const SKILL_MD = '---\nname: demo-skill\ndescription: 演示技能\n---\n# 流程\n见 references/guide.md\n';

test('buildSnapshot 收集启用清单里的 Skill 及其附件', () => {
  const root = scaffold({
    'skill_enable_list.json': '["demo-skill"]',
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/manifest.json': '{"files":["references/guide.md"]}',
    'skills/demo-skill/references/guide.md': '指南正文',
  });
  const { snapshot, stats } = B.buildSnapshot(root, {});
  assert.strictEqual(snapshot['skill_enable_list.json'], '["demo-skill"]');
  assert.strictEqual(snapshot['skills/demo-skill/SKILL.md'], SKILL_MD);
  assert.strictEqual(snapshot['skills/demo-skill/references/guide.md'], '指南正文');
  assert.strictEqual(stats.length, 1);
  assert.strictEqual(stats[0].files, 3);
});

test('buildSnapshot 只烘启用的 Skill，未启用的不进包', () => {
  const root = scaffold({
    'skill_enable_list.json': '["on-skill"]',
    'skills/on-skill/SKILL.md': '---\nname: on-skill\ndescription: d\n---\n正文',
    'skills/off-skill/SKILL.md': '---\nname: off-skill\ndescription: d\n---\n正文',
  });
  const { snapshot } = B.buildSnapshot(root, {});
  assert.ok(snapshot['skills/on-skill/SKILL.md']);
  assert.ok(!Object.keys(snapshot).some(k => k.includes('off-skill')));
});

test('buildSnapshot 统一 CRLF 与 BOM，保证 frontmatter 可解析', () => {
  const root = scaffold({
    'skill_enable_list.json': '["crlf-skill"]',
    'skills/crlf-skill/SKILL.md': '﻿---\r\nname: crlf-skill\r\ndescription: 中文\r\n---\r\n正文\r\n',
  });
  const { snapshot } = B.buildSnapshot(root, {});
  const md = snapshot['skills/crlf-skill/SKILL.md'];
  assert.ok(!/\r/.test(md), '不应残留 CR');
  assert.ok(!md.startsWith('﻿'), '不应残留 BOM');
});

test('buildSnapshot 跳过二进制与非文本扩展名，并给出警告', () => {
  const root = scaffold({
    'skill_enable_list.json': '["demo-skill"]',
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/logo.png': 'fake',
  });
  fs.writeFileSync(path.join(root, 'skills/demo-skill/data.md'), Buffer.from([0x41, 0x00, 0x42]));
  const warns = [];
  const { snapshot } = B.buildSnapshot(root, { warn: m => warns.push(m) });
  assert.ok(!snapshot['skills/demo-skill/logo.png'], '非文本扩展名不进包');
  assert.ok(!snapshot['skills/demo-skill/data.md'], '含 NUL 的文件不进包');
  assert.ok(warns.some(w => w.includes('logo.png')));
  assert.ok(warns.some(w => w.includes('data.md')));
});

test('buildSnapshot 缺 SKILL.md 或目录不存在时跳过并警告', () => {
  const root = scaffold({
    'skill_enable_list.json': '["ghost", "no-md"]',
    'skills/no-md/readme.md': 'x',
  });
  const warns = [];
  const { snapshot, stats } = B.buildSnapshot(root, { warn: m => warns.push(m) });
  assert.strictEqual(stats.length, 0);
  assert.ok(warns.some(w => w.includes('ghost')));
  assert.ok(warns.some(w => w.includes('SKILL.md')));
  assert.ok(snapshot['skill_enable_list.json'], '清单本身仍应保留');
});

test('buildSnapshot 无清单或清单损坏时返回 null 而非抛错', () => {
  assert.strictEqual(B.buildSnapshot(scaffold({}), {}), null);
  const warns = [];
  assert.strictEqual(B.buildSnapshot(scaffold({ 'skill_enable_list.json': '{oops' }), { warn: m => warns.push(m) }), null);
  assert.ok(warns.some(w => w.includes('解析失败')));
});

// ---------- 快照 → SkillLoader 端到端 ----------
test('createBundleFetcher 让 loadAll 用快照完成完整加载', async () => {
  const root = scaffold({
    'skill_enable_list.json': '["demo-skill"]',
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/manifest.json': '{"files":["references/guide.md"]}',
    'skills/demo-skill/references/guide.md': '指南正文',
  });
  const { snapshot } = B.buildSnapshot(root, {});
  const rep = await L.loadAll(L.createBundleFetcher(snapshot));
  assert.strictEqual(rep.available, true);
  assert.deepStrictEqual(rep.errors, []);
  assert.strictEqual(rep.skills.length, 1);
  const sk = rep.skills[0];
  assert.strictEqual(sk.name, 'demo-skill');
  assert.strictEqual(sk.builtin, true);
  assert.strictEqual(sk.source, 'manifest');
  assert.strictEqual(sk.files['/skills/demo-skill/references/guide.md'], '指南正文');
});

test('快照无 manifest 时回退正文引用扫描（快照里没有目录索引）', async () => {
  const root = scaffold({
    'skill_enable_list.json': '["demo-skill"]',
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/references/guide.md': '指南正文',
  });
  const { snapshot } = B.buildSnapshot(root, {});
  const rep = await L.loadAll(L.createBundleFetcher(snapshot));
  assert.strictEqual(rep.skills[0].source, 'reference-scan');
  assert.strictEqual(rep.skills[0].files['/skills/demo-skill/references/guide.md'], '指南正文');
});

test('createBundleFetcher 缺失路径抛错、JSON 损坏可辨识', async () => {
  const get = L.createBundleFetcher({ 'a.json': '{"x":1}', 'bad.json': '{oops' });
  assert.deepStrictEqual(await get('a.json', 'json'), { x: 1 });
  assert.deepStrictEqual(await get('./a.json', 'json'), { x: 1 }, '应容忍前导 ./');
  await assert.rejects(() => get('missing.json', 'json'), /打包内不存在/);
  await assert.rejects(() => get('bad.json', 'json'), /JSON 解析失败/);
});

test('空快照时 loadAll 静默返回 available=false', async () => {
  const rep = await L.loadAll(L.createBundleFetcher({}));
  assert.strictEqual(rep.available, false);
  assert.deepStrictEqual(rep.errors, []);
});
