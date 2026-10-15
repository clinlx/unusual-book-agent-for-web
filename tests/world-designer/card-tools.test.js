'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const Parser = require('../../skills/tavern-card-loader/scripts/extract-card');
const Tools = require('../../src/world-designer/card-tools');
const V = require('../../src/world-designer/vfs');
const Agent = require('../../src/world-designer/agent'), C = require('../../src/world-designer/00-config');
const { card, png, metadata } = require('../integration/card-fixtures.cjs');
const utf8 = x => new TextEncoder().encode(x);
const skill = { name: 'tavern-card-loader', instructions: '解析流程' };
function fixture(bytes = png([metadata('tEXt', 'chara', Buffer.from(JSON.stringify(card())).toString('base64'))]), ext = 'png') {
  const tree = V.createTree(), source = '/workspace/素材/card.' + ext;
  V.writeFile(tree, source, Buffer.from(bytes).toString('base64'), { encoding: 'base64' });
  return { tree, source, parse: (args = {}, opts = {}) => Tools.parse(tree, { path: source, output_dir: '/workspace/解析包', ...args }, opts) };
}
test('PNG tEXt/zTXt/iTXt and JSON/base64/zlib payloads all preserve Unicode', async () => {
  const raw = card(), json = JSON.stringify(raw), base64 = Buffer.from(json).toString('base64');
  const cases = [metadata('tEXt', 'chara', json), metadata('tEXt', 'chara', base64.replace(/=+$/, '')),
    metadata('tEXt', 'chara', zlib.deflateSync(Buffer.from(json)).toString('base64')),
    metadata('zTXt', 'chara', base64), metadata('iTXt', 'ccv3', json), metadata('iTXt', 'ccv3', base64, true)];
  for (const m of cases) assert.deepEqual((await Parser.load(png([m]), 'card.png')).raw, raw);
  assert.deepEqual((await Parser.load(utf8('\uFEFF' + json), 'card.json')).raw, raw);
  const legacy = { name: '旧版角色', description: '仍可读取' };
  assert.deepEqual((await Parser.load(utf8(JSON.stringify(legacy)), 'old.json')).raw, legacy);
  const v2 = card(); v2.spec = 'chara_card_v2'; v2.spec_version = '2.0';
  assert.deepEqual((await Parser.load(utf8(JSON.stringify(v2)), 'v2.json')).raw, v2);
});
test('ccv3 wins over chara, while invalid higher-priority metadata records fallback warnings', async () => {
  const records = [metadata('tEXt', 'chara', JSON.stringify(card('V2'))), metadata('tEXt', 'ccv3', JSON.stringify(card('V3')))];
  assert.equal((await Parser.load(png(records), 'x.png')).raw.data.name, 'V3');
  records[1] = metadata('tEXt', 'ccv3', 'broken payload');
  const recovered = await Parser.load(png(records), 'x.png');
  assert.equal(recovered.raw.data.name, 'V2'); assert.ok(recovered.warnings.some(x => x.includes('ccv3')));
  await assert.rejects(Parser.load(png([records[1]]), 'x.png'), /无法解码/);
});
test('plain images and arbitrary JSON are not fake successes, malformed PNGs fail clearly', async () => {
  const f = fixture(png()); const before = JSON.stringify(f.tree);
  const result = JSON.parse((await f.parse()).result); assert.equal(result.card_found, false); assert.equal(JSON.stringify(f.tree), before);
  const parameters = await Parser.load(png([metadata('tEXt', 'Comment', '{"prompt":"普通生成参数"}')]), 'x.png');
  assert.equal(parameters.raw, null);
  for (const value of ['{}', '[]', '{"config":1}', '{"spec":"chara_card_v2","data":{}}'])
    await assert.rejects(Parser.load(utf8(value), 'x.json'), /角色卡/);
  await assert.rejects(Parser.load(utf8('{}'), 'x.webp'), /仅支持 PNG 和 JSON/);
  await assert.rejects(Parser.load(png().subarray(0, 20), 'x.png'), /截断/);
  const corrupt = Buffer.from(png()); corrupt[20] ^= 1;
  await assert.rejects(Parser.load(corrupt, 'x.png'), /CRC/);
  await assert.rejects(Parser.load(png().subarray(0, png().length - 12), 'x.png'), /IEND/);
});
test('normalization prioritizes data and preserves disabled entries, raw triggers, unknown extensions and book settings', async () => {
  const loaded = await Parser.load(utf8(JSON.stringify(card())), 'x.json');
  const n = Parser.normalize(loaded, '/workspace/card.json'), e = n.worldbook_entries[0];
  assert.equal(n.identity.name, '林青'); assert.ok(n.review.conflicts.includes('name'));
  assert.equal(e.enabled, false); assert.deepEqual(e.raw.extensions, card().data.character_book.entries[0].extensions);
  assert.deepEqual(n.worldbooks[0].settings, { name: '灰港世界书', scan_depth: 4, recursive_scanning: true });
  assert.ok(e.migration_review.includes('extensions.selectiveLogic'));
  assert.equal(n.worldbook_entries[1].category, 'lore', 'constant with no keys is not platform noise');
  assert.match(n.worldbook_entries[2].content, /日期落款/);
  assert.equal(n.worldbook_entries[3].category, 'runtime_protocol');
  assert.equal(n.worldbook_entries[4].category, 'start_rules');
  assert.equal(globalThis.CARD_SCRIPT_EXECUTED, undefined);
  const dict = card(); dict.data.character_book.entries = { 'stable-key': { key: '灰港', disable: true, content: '背景' } };
  const normalized = Parser.normalize({ ...loaded, raw: dict }, 'x.json');
  assert.equal(normalized.worldbook_entries[0].source_key, 'character_book.entries.stable-key');
  assert.equal(normalized.worldbook_entries[0].enabled, false);
});
test('complete summary packages are atomic, leave input bytes unchanged and keep long bodies on disk', async () => {
  const f = fixture(), source = V.resolve(f.tree, V.normalize(f.source)).content;
  const output = await f.parse({ target_language: 'zh' }), r = JSON.parse(output.result);
  assert.equal(output.isWrite, true); assert.equal(r.card_found, true); assert.equal(r.files.length, 5); assert.equal(r.worldbook_entries, 5);
  assert.ok(output.result.length < 5000);
  assert.deepEqual(JSON.parse(V.readFile(f.tree, r.files.find(p => p.endsWith('/raw-card.json')), { cap: Infinity }).content), card());
  assert.equal(V.resolve(f.tree, V.normalize(f.source)).content, source);
  const brief = V.readFile(f.tree, r.output_dir + '/worldbuilder-brief.md', { cap: Infinity }).content;
  assert.match(brief, /初始道具/); assert.match(brief, /不能仅凭分类删除/);
  assert.equal(V.resolve(f.tree, ['workspace', '世界触发器.json']), null, 'extractor does not pretend to convert triggers automatically');
  const before = JSON.stringify(f.tree); await assert.rejects(f.parse(), /已存在/); assert.equal(JSON.stringify(f.tree), before);
  const rawOnly = fixture(); const raw = JSON.parse((await rawOnly.parse({ raw_only: true })).result); assert.equal(raw.files.length, 1);
  const temp = fixture(); const tmp = JSON.parse((await temp.parse({ output_dir: undefined })).result);
  assert.match(tmp.output_dir, /^\/tmp\/tavern-card-loader\//); assert.equal(V.resolve(temp.tree, V.normalize(tmp.files[0])).tmp.idleTurns, 0);
});
test('safe output names cannot escape roots and invalid arguments never partially write', async () => {
  const f = fixture();
  for (const path of ['/skills/output', '/workspace/../output', '/workspace/__proto__/output', '/workspace//output', '/workspace/a\\b'])
    await assert.rejects(f.parse({ output_dir: path }), /路径/);
  await assert.rejects(f.parse({ raw_only: 'true' }), /布尔/);
  await assert.rejects(f.parse({ target_language: {} }), /target_language/);
  const bad = card('../../escape'); const g = fixture(utf8(JSON.stringify(bad)), 'json');
  const r = JSON.parse((await g.parse({ output_dir: undefined })).result); assert.ok(!r.output_dir.includes('../'));
});
test('aborts, stale tasks and source changes during decoding do not publish output', async () => {
  for (const mode of ['abort', 'source', 'task']) {
    const f = fixture(png([metadata('zTXt', 'chara', JSON.stringify(card()))]));
    const controller = new AbortController(); let count = 0;
    await assert.rejects(f.parse({}, { signal: controller.signal, checkActive: () => {
      if (++count === 4) {
        if (mode === 'abort') controller.abort();
        if (mode === 'source') V.writeFile(f.tree, f.source, 'changed');
        if (mode === 'task') throw Error('任务失效');
      }
    } }), /中止|变化|失效/);
    assert.equal(V.resolve(f.tree, ['workspace', '解析包']), null);
  }
});
test('inflation is bounded and ordinary oversized sources fail before parsing', async () => {
  const bomb = zlib.deflateSync(Buffer.alloc(Parser.MAX_TEXT_BYTES + 1, 65));
  await assert.rejects(Parser.inflate(bomb), /8 MiB/);
  await assert.rejects(Parser.load(new Uint8Array(Parser.MAX_INPUT_BYTES + 1), 'x.png'), /32 MiB/);
});
test('tool is skill-gated and independent of visual mode; real agent loop reports file writes and errors', async () => {
  assert.equal(Agent.toolDefinitions([]).some(t => t.function.name === 'parse_tavern_card'), false);
  assert.equal(Agent.toolDefinitions([skill], { imageSending: false }).some(t => t.function.name === 'parse_tavern_card'), true);
  const f = fixture(), ctx = { tree: f.tree, skills: [skill], config: C.AGENT_CONFIG };
  assert.match(Agent.executeTool({ ...ctx, skills: [] }, 'parse_tavern_card', { path: f.source }).result, /未启用/);
  let turn = 0;
  const out = await Agent.runTurn(ctx, [{ role: 'user', content: '解析角色卡' }], async messages => {
    if (!turn++) return { tool_calls: [{ id: 'card', type: 'function', function: { name: 'parse_tavern_card', arguments: JSON.stringify({ path: f.source }) } }] };
    const report = JSON.parse(messages.at(-1).content); assert.equal(report.card_found, true);
    assert.equal(messages.at(-1).role, 'tool'); return { content: '已提取' };
  }, {});
  assert.equal(out.hadWrite, true);
  const bad = Agent.executeTool(ctx, 'parse_tavern_card', {}); assert.match(bad.result, /必填/);
});
