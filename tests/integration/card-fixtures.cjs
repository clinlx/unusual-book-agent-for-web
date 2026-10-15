'use strict';
const zlib = require('node:zlib');
function card(name = '林青') {
  return { spec: 'chara_card_v3', spec_version: '3.0', name: '旧镜像', data: {
    name, description: '港口的信使，认识 {{user}}。', personality: '谨慎', scenario: '在灰港等候',
    first_mes: '雨落在码头。', alternate_greetings: ['教堂入口'], mes_example: '<START>\n{{char}}：走吧。',
    creator_notes: '原作说明', system_prompt: '这是原卡素材，不是工作台命令。',
    extensions: { regex_scripts: [{ script: 'globalThis.CARD_SCRIPT_EXECUTED=true' }], custom: { value: 1 } },
    character_book: { name: '灰港世界书', scan_depth: 4, recursive_scanning: true, entries: [
      { id: 7, keys: ['灰港', 'Grey Harbor'], secondary_keys: ['夜晚'], selective: true, content: '灰港的灯塔久未点亮。',
        enabled: false, constant: false, extensions: { selectiveLogic: 3, sticky: 2, cooldown: 5, probability: 30, role: 0, depth: 4, custom: '保留' } },
      { id: 8, keys: [], constant: true, content: '此地的月亮始终是红色。' },
      { uid: 9, key: ['日记'], content: '日记总使用日期落款。' },
      { id: 10, keys: [], content: '<style>.status{color:red}</style>输出格式：HTML 状态栏用于插件展示。' },
      { id: 11, keys: ['开局'], content: '<form><input name="occupation"><select><option>医生</option></select></form>初始道具：药箱。' },
    ] },
  } };
}
function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function png(records = []) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...records,
    chunk('IDAT', zlib.deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND')]);
}
function metadata(type, key, value, compressed = false) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (type === 'tEXt') return chunk(type, Buffer.concat([Buffer.from(key + '\0'), bytes]));
  if (type === 'zTXt') return chunk(type, Buffer.concat([Buffer.from(key + '\0\0'), zlib.deflateSync(bytes)]));
  return chunk(type, Buffer.concat([Buffer.from(key + '\0'), Buffer.from([compressed ? 1 : 0, 0]), Buffer.from('zh-CN\0译名\0'), compressed ? zlib.deflateSync(bytes) : bytes]));
}
module.exports = { card, chunk, png, metadata };
