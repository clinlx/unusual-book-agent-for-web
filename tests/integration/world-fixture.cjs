'use strict';
const fs = require('node:fs');
const path = require('node:path');
const VFS = require('../../src/world-designer/vfs');
function fixture() {
  const tree = VFS.createTree(), root = '/workspace/world';
  const write = (file, content) => VFS.writeFile(tree, root + '/' + file, typeof content === 'string' ? content : JSON.stringify(content));
  for (const dir of ['存档-索引-NPC', '存档-索引-物品', '存档-旧']) VFS.mkdir(tree, root + '/' + dir);
  for (const file of ['模组.md', '开场白.md', '样例开场.md', '剧情线与进度/主线剧情.md', '世界状态和世界规则/世界规则.md', '世界状态和世界规则/掷骰规则.md', '世界状态和世界规则/检定与触发器索引.md', '存档-世界/世界日志.txt']) write(file, '测试世界。'.repeat(30));
  write('世界状态和世界规则/世界共识.json', { 世界时间: '第一天' });
  const doc = fs.readFileSync(path.join(__dirname, '../../skills/game-world-builder/reference/WorldDataContract.md'), 'utf8');
  write('Player-pc/基础信息.json', JSON.parse(doc.split('```json\n')[1].split('```')[0]));
  for (const file of ['关系记忆.json', '格式化记忆.json', '关系图.json', '待办与目标.json']) write('Player-pc/' + file, {});
  write('Player-pc/背包.json', []); write('Player-pc/日志.txt', '');
  return { tree, root, write };
}
module.exports = { fixture };
