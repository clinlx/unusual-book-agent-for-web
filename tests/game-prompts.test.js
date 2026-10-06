'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sourcePath = path.join(__dirname, '../src/game-prompts.js');
const load = () => require(sourcePath);

test('documented empty phase plan executes in object and serialized forms', () => {
  const round = fs.readFileSync(path.join(__dirname, '../assets/prompts/system/round.md'), 'utf8');
  const example = round.match(/```json\s*([\s\S]*?)```/);
  assert.ok(example, 'round protocol provides a complete JSON phase_plan example');
  const plan = JSON.parse(example[1]);
  const Core = require('../src/game-core'), VFS = require('../src/vfs');
  for (const input of [plan, JSON.stringify(plan)]) {
    const tree = VFS.createTree();
    VFS.writeFile(tree, '/workspace/Player-pc/基础信息.json', '{"姓名":"林青","状态":{"HP":10,"Alive":true,"Enabled":true}}');
    VFS.writeFile(tree, '/workspace/Player-pc/背包.json', '[]');
    const save = Core.createSave('提示词参数验证', tree);
    Core.beginRound(save, '观察房间', false);
    const receipt = Core.execute(save, 'trigger_next_round', {phase_plan:input}, 'documented-plan');
    assert.equal(receipt.ok, true, receipt.error);
    assert.equal(receipt.result.action, '观察房间');
    assert.deepEqual(receipt.result.phase_plan, plan);
  }
});

test('prompt module loads without browser bundle and accepts explicit default sources', () => {
  assert.ok(fs.existsSync(sourcePath), 'prompt registry is implemented');
  const prompts = load().create({ 'system.md': 'system', 'start_game.md': 'start', 'next_round.md': 'next', 'Prompt/Temp/回合提示词.md': 'round', 'runtime.md': 'runtime' });
  assert.equal(prompts.get('system.md'), 'system');
  assert.equal(prompts.roundPrompt(true), 'start');
  assert.equal(prompts.roundPrompt(false), 'next');
  assert.match(prompts.buildSystem({}, 'world'), /system[\s\S]*round[\s\S]*world/);
});

test('overrides apply equally to system and lazy resource reads, reset uses immutable defaults', () => {
  const prompts = load().create({ 'system.md': 'original', 'Prompt/KeyWords/安全性-A.md': 'calm' });
  const overrides = { 'system.md': 'custom', 'Prompt/KeyWords/安全性-A.md': 'custom calm' };
  assert.equal(prompts.get('system.md', overrides), 'custom');
  assert.match(prompts.buildSystem(overrides), /custom/);
  assert.equal(prompts.file('/prompts/Prompt/KeyWords/安全性-A.md', overrides), 'custom calm');
  assert.equal(prompts.file('Prompt/KeyWords/安全性-A.md'), 'calm');
  assert.equal(prompts.get('system.md', { 'system.md': '' }), '');
  assert.equal(prompts.get('system.md'), 'original');
  assert.throws(() => prompts.get('unknown.md', { 'unknown.md': 'injected' }), /未知/);
  assert.equal(prompts.file('/workspace/system.md'), undefined);
  assert.equal(prompts.file('/prompts/../system.md'), undefined);
});

test('source package preserves essential hosting protocol with numbered references', () => {
  const prompts = load();
  const sources = Object.fromEntries(prompts.list().map(({ id, title }) => {
    assert.ok(title);
    return [id, fs.readFileSync(path.join(__dirname, '../assets/prompts', id), 'utf8')];
  }));
  const hosted = prompts.create(sources);
  assert.ok(hosted.toolDescription('append_story').includes('追加'));
  assert.equal(hosted.toolDescription('append_story', { 'tools.json': '{"append_story":"overridden"}' }), 'overridden');
  assert.equal(hosted.toolDescription('constructor'), '');
  assert.match(hosted.toolDescription('append_file',{'tools.json':'{"append_story":"custom"}'}),/末尾/);
  assert.match(hosted.toolDescription('tree'),/展开层数/);
  assert.ok(hosted.flows().flow_no_story.includes('append_story'));
  for (const id of ['system/round.md']) {
    for (const field of ['Countdowns', 'Pending_Triggers', 'Forced_Checks']) assert.ok(hosted.get(id).includes(field), `${id} defines ${field}`);
  }
  assert.match(hosted.toolDescription('read_file'), /字符/);
  assert.match(hosted.toolDescription('generate_random_number'), /min_val.*max_val/);
  assert.match(hosted.toolDescription('roll_dice'), /dice_dict.*left_modifiers/);
  const system = hosted.buildSystem();
  assert.doesNotMatch(system,/phase\s*\d/);
  assert.match(system, /§[A-Z]+[1-9]\d*/);
  assert.match(system, /阶段收束/);
  assert.match(system, /phase_plan/);
  assert.match(system, /NEXT_TURN_CACHE/);
  assert.match(system, /多个.*追加/);
  assert.match(system, /暗骰/);
  assert.match(system, /Player-\*/);
  for (const text of Object.values(sources)) {
    assert.doesNotMatch(text, /private_update_story|update_story|check_skill_enable|\btoken\b|所有玩家|各个玩家|Player-pn/);
  }
  for (const id of ['reference/游戏前准备.md', 'reference/游戏结束.md', '游戏目录树属性规则.md', ...['A','B','C','D'].map(x => `Prompt/KeyWords/安全性-${x}.md`)]) assert.ok(hosted.file('/.reference/'+id.split('/').pop()));
});
