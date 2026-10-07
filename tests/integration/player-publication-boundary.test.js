'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const VFS = require('../../src/vfs');
const Core = require('../../src/game-core');
const Presentation = require('../../src/game-presentation');

test('player and referenced item panels preserve public facts and hide nested host notes', () => {
  const tree = VFS.createTree();
  const write = (path, value) => VFS.writeFile(tree, '/workspace/' + path, JSON.stringify(value));
  write('Player-pc/基础信息.json', {
    姓名: '马丁', 职业: '档案员', 说明: '受雇调查旧宅',
    '.主持人备注': '玩家选择默认角色；后台建卡依据',
    状态: { Alive: true, Enabled: true },
    证件: { 信息: '市图书馆工作证', '.秘密': '尚未揭示的身份' },
  });
  write('Player-pc/背包.json', ['address']);
  write('存档-索引-物品/address/物品基础信息.json', {
    名称: '地址', 信息: '纸条上写着柳树街十二号。', 余量: '1 张（可复读）',
    '.主持人备注': '这是前往旧宅的触发物，不向玩家宣布其剧情用途',
    附件: [{ 信息: '蓝色墨迹', '.用途': '后续鉴定依据' }],
    触发器: [{ 地点: '旧宅', 结果: '尚未公开的事件' }],
  });
  const save = Core.createSave('公开边界', tree);
  const view = Core.player(save);
  assert.equal(view.info.说明, '受雇调查旧宅');
  assert.deepEqual(view.info.证件, { 信息: '市图书馆工作证' });
  assert.equal(view.items[0].余量, '1 张（可复读）');
  assert.deepEqual(view.items[0].附件, [{ 信息: '蓝色墨迹' }]);
  assert.doesNotMatch(JSON.stringify(view), /后台建卡|尚未揭示|触发物|鉴定依据|尚未公开/);
});

test('ordinary description fields are public even when their text is a writer note', () => {
  const data = { 说明: '此处为后续剧情埋伏笔', 信息: '文字资料 1 交付物' };
  assert.deepEqual(Core.filterVisible(data), data);
  assert.deepEqual(Core.filterVisible(data, true), data);
});

test('item placement fields are hidden in live panels and replay exports without changing saved data', () => {
  for (const key of ['位置所属', 'Owner', 'Location', '详细放置位置', 'DetailLocation', 'detail_location']) {
    for (const referenced of [false, true]) {
      const tree = VFS.createTree();
      const item = { 名称: '铜钥匙', 信息: '钥匙上刻着编号。', [key]: 'SECRET_PLACEMENT',
        附件: [{ 名称: '吊牌', [key]: 'SECRET_NESTED_PLACEMENT' }] };
      VFS.writeFile(tree, '/workspace/Player-pc/基础信息.json', '{"姓名":"马丁"}');
      VFS.writeFile(tree, '/workspace/Player-pc/背包.json', JSON.stringify(referenced ? ['key'] : [item]));
      VFS.writeFile(tree, '/workspace/存档-索引-物品/key/物品基础信息.json', JSON.stringify(item));
      VFS.writeFile(tree, '/workspace/过往回合历史记忆/Round_1_Time_2026/玩家结束状态.json',
        JSON.stringify({ info: { 姓名: '马丁' }, items: [item] }));
      const save = Core.createSave('位置隐藏', tree);
      const before = structuredClone(save.tree);
      const view = Core.player(save);
      assert.equal(view.items[0].名称, '铜钥匙');
      assert.equal(view.items[0].信息, '钥匙上刻着编号。');
      assert.doesNotMatch(JSON.stringify(view), /SECRET_/, key);
      const html = Presentation.historyHTML(save, undefined, { info: view.info, items: [item] });
      assert.doesNotMatch(html, /SECRET_/, 'replay: ' + key);
      assert.deepEqual(save.tree, before, 'projection must preserve original files: ' + key);
    }
  }
});
