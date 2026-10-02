'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./world-fixture.cjs');
const config = require('../../src/world-designer/00-config');
const requiredSkill = { name: 'game-world-builder', instructions: 'BUILDER_FULL_BODY', description: 'Build worlds', files: {} };
function api() {
  assert.ok(fs.existsSync(path.join(__dirname, '../../src/world-designer/builder-tools.js')), 'virtual world validator tool must exist');
  return require('../../src/world-designer/builder-tools');
}
test('validator reads the current virtual world without writing or using host paths', () => {
  const tools = api(), f = fixture(), before = JSON.stringify(f.tree);
  const result = tools.validate(f.tree, f.root);
  assert.equal(result.valid, true); assert.deepEqual(result.errors, []);
  assert.equal(JSON.stringify(f.tree), before);
  f.write('Player-pc/背包.json', ['missing-item']);
  assert.match(tools.validate(f.tree, f.root).errors.join('\n'), /引用错误/);
  f.write('Player-pc/背包.json', []);
  assert.equal(tools.validate(f.tree, f.root).valid, true);
});
test('validator rejects paths outside workspace, traversal and prototype segments', () => {
  const tools = api(), f = fixture();
  for (const root of ['/skills/game-world-builder', '/workspace/../skills', 'C:\\world', '../world', '/workspace/__proto__', '/workspace/constructor'])
    assert.throws(() => tools.validate(f.tree, root), /workspace|路径/);
  assert.equal(tools.validate(f.tree, '/workspace/missing').valid, false);
});
test('nested worlds accept VFS absolute item references inside their own root', () => {
  const tools = api(), f = fixture();
  f.write('存档-索引-物品/key/物品基础信息.json', { 名称: '钥匙', 信息: '开门', 位置所属: 'Player-pc', 可见性: '可见', 余量: 1, Action字典: {} });
  f.write('存档-索引-物品/key/物品日志.txt', '');
  f.write('Player-pc/背包.json', [f.root + '/存档-索引-物品/key/物品基础信息.json']);
  assert.deepEqual(tools.validate(f.tree, f.root).errors, []);
  f.write('Player-pc/背包.json', ['/workspace/another/存档-索引-物品/key/物品基础信息.json']);
  assert.match(tools.validate(f.tree, f.root).errors.join('\n'), /引用错误/);
});
test('builder tool is advertised and callable only with its enabled skill', () => {
  api();
  const Agent = require('../../src/world-designer/agent'), f = fixture();
  assert.ok(Agent.toolDefinitions([requiredSkill]).some(t => t.function.name === 'validate_game_structure'));
  assert.ok(!Agent.toolDefinitions([]).some(t => t.function.name === 'validate_game_structure'));
  assert.ok(!Agent.toolDefinitions([requiredSkill], { imageSending: false }).some(t => t.function.name === 'view_image'));
  const ctx = { tree: f.tree, skills: [requiredSkill], config: config.AGENT_CONFIG };
  const out = Agent.executeTool(ctx, 'validate_game_structure', { path: f.root });
  assert.equal(out.isWrite, false); assert.equal(JSON.parse(out.result).valid, true);
  assert.match(Agent.executeTool({ ...ctx, skills: [] }, 'validate_game_structure', { path: f.root }).result, /错误.*技能/);
  assert.match(Agent.executeTool(ctx, 'validate_game_structure', {}).result, /缺少必填参数/);
});
test('builder is marked special, stays first and active despite a legacy disabled record', () => {
  const R = require('../../src/world-designer/resources');
  assert.equal(typeof R.installed, 'function');
  const skills = [{ name: 'write-novel' }, requiredSkill, { name: 'grilling' }];
  const installed = R.installed(skills);
  assert.equal(installed[0].name, 'game-world-builder');
  assert.equal(installed[0].special, true); assert.equal(installed[0].required, true);
  assert.equal(R.isRequired('game-world-builder'), true);
  assert.deepEqual(R.active(skills, new Set(['game-world-builder', 'grilling'])).map(s => s.name), ['game-world-builder', 'write-novel']);
});
test('full builder instructions are explicitly appended after the base system prompt', () => {
  const prompt = config.buildSystemPrompt([requiredSkill], 'CUSTOM_PERSONA');
  assert.ok(prompt.startsWith('CUSTOM_PERSONA'));
  assert.ok(prompt.endsWith('BUILDER_FULL_BODY'));
  assert.match(prompt, /validate_game_structure/);
  assert.equal(prompt.split('BUILDER_FULL_BODY').length, 2);
});
module.exports = { fixture };
