'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/vfs');
const Core = require('../src/game-core');
const Triggers = require('../src/game-world-triggers');
const Rules = require('../skills/game-world-builder/scripts/world-trigger-rules');
const Import = require('../src/game-import');
const Store = require('../src/game-store');
const Validation = require('../src/shared/file-write-validation');
const Builder = require('../src/world-designer/builder-tools');
function save(entries, config = {}) {
  const tree = V.createTree();
  V.writeFile(tree, '/workspace/Player-pc/基础信息.json', '{"姓名":"林青","状态":{"HP":10},"当前位置":"教堂"}');
  V.writeFile(tree, '/workspace/Player-pc/背包.json', '[]');
  V.writeFile(tree, '/workspace/世界触发器.json', JSON.stringify({ version: 1, entries, ...config }));
  return Core.createSave('触发测试', tree);
}
const entry = (id, extra = {}) => ({ id, keywords: ['钟楼'], content: '资料-' + id, ...extra });
const inject = s => Core.context(s, '系统', 100000).find(m => m.content.startsWith(Triggers.HEADER));
const data = s => { const m = inject(s); return m ? JSON.parse(m.content.slice(Triggers.HEADER.length)) : { entries: [] }; };
const ids = s => data(s).entries.map(e => e.id);
function begin(s, text = '前往钟楼', options = {}) { Core.beginRound(s, text, false, '当前任务', options); }
function finish(s, story = '继续前行') {
  s.activeRound.triggered = true;
  assert.equal(Core.execute(s, 'append_story', { content: story, one_line_summary_of_content: story ,self_accept:true}, 'story-' + s.activeRound.number).ok, true);
  assert.equal(Core.execute(s, 'end_the_round', { NEXT_TURN_CACHE: { Story_Phase: '游戏循环' } }, 'end-' + s.activeRound.number).ok, true);
}
test('没有配置的旧世界不改变请求；关闭规则不注入', () => {
  const s = save([entry('a')]); V.deletePath(s.tree, '/workspace/世界触发器.json'); begin(s);
  assert.deepEqual(Core.context(s, '系统').map(m => m.content), ['系统', '当前任务']);
  const off = save([entry('a')], { enabled: false }); begin(off); assert.deepEqual(ids(off), []);
});
test('关键词从正式事件读取，不扫描任务、思考、工具回执、草稿或注入正文', () => {
  const s = save([entry('a'), entry('b', { keywords: ['资料-a'] })]); begin(s, '检查门'); s.draft = '钟楼';
  s.messages.push({ role: 'user', content: '钟楼', internal: true, round: 1 },
    { role: 'assistant', content: '钟楼', reasoning_content: '钟楼', round: 1 },
    { role: 'tool', content: '钟楼', tool_call_id: 'ignored', round: 1 });
  assert.deepEqual(ids(s), []);
  s.events.push({ id: 'new', type: 'story', round: 1, content: '钟楼亮起灯光' });
  assert.deepEqual(ids(s), ['a']); assert.deepEqual(ids(s), ['a']);
  assert.equal(s.messages.some(m => m.content.startsWith(Triggers.HEADER)), false);
});
test('扫描窗口按玩家回合计数，不丢同轮的其他玩家；story 按消息计数', () => {
  const s = save([entry('a', { sources: ['player'] }), entry('b', { sources: ['story'] })]);
  begin(s, '', { actions: [{ actorId: 'alice', content: '前往钟楼' }, { actorId: 'bob', content: '等一下' }] });
  assert.deepEqual(ids(s), ['a']); finish(s, '钟楼的钟声');
  begin(s, '去港口'); assert.deepEqual(ids(s), ['b']);
  s.activeRound.triggered = true; Core.execute(s, 'append_story', { content: '港口的汽笛', one_line_summary_of_content: '汽笛' ,self_accept:true}, 'next-story');
  assert.deepEqual(ids(s), ['b'], '已经激活的本轮资料持续到本轮结束');
  const fresh = save([entry('a', { sources: ['story'] })]); begin(fresh, '去港口');
  fresh.events.push({ id: 'old', type: 'story', content: '钟楼', round: 1 }, { id: 'last', type: 'story', content: '港口', round: 1 });
  assert.deepEqual(ids(fresh), []);
});
test('私密来源主动选择，角色过滤在窗口截取前生效，公开正文不归属于特定角色', () => {
  const s = save([entry('public'), entry('secret', { sources: ['private_player'], actorIds: ['alice'] }),
    entry('private-story', { sources: ['private_story'], actorIds: ['alice'] }), entry('wrong', { sources: ['private_story'], actorIds: ['bob'] }),
    entry('actor-public', { sources: ['story'], actorIds: ['alice'] })]);
  begin(s, '', { actions: [{ actorId: 'alice', content: '等待', privateContent: '潜入钟楼' }, { actorId: 'bob', content: '等待', privateContent: '离开' }] });
  s.events.push({ id: 'private', type: 'story', round: 1, content: '钟楼里藏有密信', audience: ['alice'], private: true });
  assert.deepEqual(ids(s), ['private-story', 'secret']);
  s.events.push({ id: 'public', type: 'story', round: 1, content: '钟楼' });
  assert.deepEqual(ids(s), ['private-story', 'public', 'secret']);
  assert.equal(Core.visibleEvents(s, 'play').some(e => e.type === 'world_trigger'), false);
});
test('关键词与四种附加逻辑、跨消息窗口和同消息范围', () => {
  const window = [{ text: '钟楼' }, { text: '夜晚' }];
  for (const [mode, keys, expected] of [['any', ['夜晚', '白天'], true], ['all', ['夜晚', '白天'], false],
    ['notAny', ['白天'], true], ['notAll', ['夜晚', '白天'], true]]) {
    const e = entry('a', { secondary: { mode, keys } }); assert.equal(Triggers.matches(e, window).ok, expected);
  }
  const e = entry('a', { secondary: { mode: 'any', keys: ['夜晚'] } });
  assert.equal(Triggers.matches({ ...e, matchScope: 'event' }, window).ok, false);
  assert.equal(Triggers.matches(e, [{ text: '钟' }, { text: '楼' }]).ok, false);
});
test('大小写、英文整词与中文默认子串匹配', () => {
  assert.equal(Triggers.matches(entry('a', { keywords: ['king'], wholeWords: true }), [{ text: 'liking' }]).ok, false);
  assert.equal(Triggers.matches(entry('a', { keywords: ['king'], wholeWords: true }), [{ text: 'King!' }]).ok, true);
  assert.equal(Triggers.matches(entry('a', { keywords: ['King'], caseSensitive: true }), [{ text: 'king' }]).ok, false);
  assert.equal(Triggers.matches(entry('a'), [{ text: '走向钟楼内部' }]).ok, true);
});
test('常驻条目在同事件范围且没有可扫描事件时仍注入，并继续遵守状态条件', () => {
  const when = { file: 'Player-pc/基础信息.json', path: ['状态', 'HP'], op: 'gte', value: 10 };
  const s = save([entry('constant', { constant: true, keywords: undefined, matchScope: 'event',
    sources: ['private_player'], actorIds: ['absent'], when })]);
  Core.beginRound(s, '', true, '开场');
  assert.deepEqual(ids(s), ['constant']);
  V.writeFile(s.tree, '/workspace/Player-pc/基础信息.json', '{"状态":{"HP":9}}');
  assert.deepEqual(ids(s), []);
  const conditional = entry('secondary', { constant: true, matchScope: 'event', secondary: { mode: 'any', keys: ['夜晚'] } });
  assert.equal(Triggers.matches(conditional, []).ok, false);
  assert.equal(Triggers.matches(conditional, [{ text: '夜晚' }]).ok, true);
});
test('状态条件严格比较、嵌套逻辑、缺失字段与 JSON 损坏', () => {
  const condition = { file: 'Player-pc/基础信息.json', path: ['状态', 'HP'], op: 'gte', value: 10 };
  const s = save([entry('state', { constant: true, when: { all: [condition, { not: { ...condition, op: 'eq', value: '10' } }] } })]);
  begin(s, '等待'); assert.deepEqual(ids(s), ['state']);
  V.writeFile(s.tree, '/workspace/Player-pc/基础信息.json', '{"状态":{"HP":9}}'); assert.deepEqual(ids(s), []);
  V.writeFile(s.tree, '/workspace/Player-pc/基础信息.json', '{"状态":{"HP":10}}'); assert.deepEqual(ids(s), ['state']);
  const load = () => ({ list: ['a'], nil: null, text: 'abc' });
  for (const [path, op, value, expected] of [[['missing'], 'ne', 1, false], [['missing'], 'exists', false, true],
    [['nil'], 'exists', true, true], [['list'], 'contains', 'a', true], [['text'], 'contains', 'bc', true], [['text'], 'in', ['abc'], true]]) {
    assert.equal(Triggers.testCondition({ file: 'x', path, op, value }, load), expected);
  }
  V.writeFile(s.tree, '/workspace/Player-pc/基础信息.json', '{bad'); assert.throws(() => inject(s), /合法 JSON/);
});
test('持续、冷却、once 和回合限制按回合而非请求计数', () => {
  const s = save([entry('timed', { duration: 2, cooldown: 2 }), entry('once', { once: true }), entry('late', { minRound: 3, maxRound: 3 })]);
  begin(s); assert.deepEqual(ids(s), ['once', 'timed']);
  const initial = structuredClone(s.worldTriggers); const count = s.events.filter(e => e.type === 'world_trigger').length;
  for (let i = 0; i < 5; i++) inject(s);
  assert.deepEqual(s.worldTriggers, initial); assert.equal(s.events.filter(e => e.type === 'world_trigger').length, count);
  finish(s); begin(s, '等待'); assert.deepEqual(ids(s), ['timed']); finish(s);
  begin(s); assert.deepEqual(ids(s), ['late']); finish(s);
  begin(s); assert.deepEqual(ids(s), []); finish(s);
  begin(s); assert.deepEqual(ids(s), ['timed']);
});
test('预算与互斥选择不消耗未入选条目，priority 和 order 相互独立', () => {
  const s = save([entry('a', { constant: true, priority: 100, order: 10, group: 'place', content: '长'.repeat(5000), once: true }),
    entry('b', { constant: true, priority: 10, order: 5, group: 'place' }), entry('c', { constant: true, priority: 0, order: -1 })], { budgetTokens: 600 });
  begin(s); assert.deepEqual(ids(s), ['c', 'b']); assert.equal(s.worldTriggers.entries.a, undefined);
  const reasons = s.events.findLast(e => e.type === 'world_trigger').decisions;
  assert.equal(reasons.find(e => e.id === 'a').reason, 'budget');
  const other = save([entry('a', { group: 'same' }), entry('b', { group: 'same' })]); begin(other);
  assert.deepEqual(ids(other), ['a']);
});
test('文件内容作为 user 资料注入，保留真实工具思考但不授予写入凭证', () => {
  const s = save([entry('file', { content: undefined, file: '资料/钟楼.md' })]);
  V.writeFile(s.tree, '/workspace/资料/钟楼.md', '内部秘密'); begin(s);
  s.messages.push({ role: 'assistant', round: 1, content: '', reasoning_content: '真实思考', tool_calls: [{ id: 'r', type: 'function', function: { name: 'read_file', arguments: '{"path":"/workspace/Player-pc/背包.json"}' } }] },
    { role: 'tool', round: 1, tool_call_id: 'r', content: '{"ok":true}' });
  const sent = Core.context(s, '系统'); assert.equal(sent.at(-1).role, 'user'); assert.match(sent.at(-1).content, /内部秘密/);
  assert.equal(sent.find(m => m.tool_calls)?.reasoning_content, '真实思考');
  assert.equal(Core.execute(s, 'write_file', { path: '/workspace/资料/钟楼.md', content: '修改' }, 'w').ok, false);
  const transformed = Core.context(s, '系统', 100000, { transformContext: x => x.replace(/内部秘密/g, '映射') });
  assert.match(transformed.at(-1).content, /映射/);
});
test('上下文整理保持当前触发资料原文；放不下时明确失败', () => {
  const s = save([entry('a', { content: '秘密'.repeat(100), constant: true })]); begin(s);
  s.messages.push({ role: 'user', round: 1, content: '大量输入'.repeat(3000) });
  const sent = Core.context(s, '系统', 1300); assert.ok(Core.estimate(sent) <= 1300);
  assert.match(sent.at(-1).content, /秘密/); assert.ok(sent.some(m => m.content.includes('上下文资料索引')));
  assert.throws(() => Core.context(s, '系统', 100), /上下文上限/);
});
test('存储刷新、完整 ZIP 导入导出、回退恢复触发运行状态；老快照兼容', async () => {
  const s = save([entry('once', { once: true })]); begin(s); inject(s);
  const store = Store.create(null); await store.open(); await store.putSave(s); const reloaded = await store.getSave(s.id);
  assert.deepEqual(ids(reloaded), ['once']); assert.deepEqual(reloaded.worldTriggers, s.worldTriggers);
  const blob = Import.exportSave(s), buffer = await blob.arrayBuffer();
  const imported = await Import.importSave({ name: '触发.zip', arrayBuffer: async () => buffer });
  assert.deepEqual(imported.worldTriggers, s.worldTriggers); assert.deepEqual(ids(imported), ['once']);
  finish(imported); begin(imported); assert.deepEqual(ids(imported), []);
  Core.rollback(imported); assert.equal(imported.round, 1); assert.ok(imported.worldTriggers.entries.once);
  Core.rollback(imported); assert.equal(imported.worldTriggers, undefined);
  begin(imported); assert.deepEqual(ids(imported), ['once']);
});
test('配置变化重置对应条目，删除条目不注入；缺失文件给出明确错误', () => {
  const s = save([entry('a', { once: true })]); begin(s); inject(s); finish(s); begin(s); assert.deepEqual(ids(s), []);
  V.writeFile(s.tree, '/workspace/世界触发器.json', JSON.stringify({ version: 1, entries: [entry('a', { once: true, content: '新资料' })] }));
  assert.deepEqual(ids(s), ['a']);
  V.writeFile(s.tree, '/workspace/世界触发器.json', '{"version":1,"entries":[]}'); assert.deepEqual(ids(s), []); assert.deepEqual(s.worldTriggers.entries, {});
  V.writeFile(s.tree, '/workspace/世界触发器.json', JSON.stringify({ version: 1, entries: [entry('a', { content: undefined, file: '缺失.md' })] }));
  assert.throws(() => inject(s), /无法读取文本文件/);
});
test('规则 schema 拒绝歧义、越界、脚本及不支持的迁移字段，写入与设计器共用校验', () => {
  const cases = [
    { version: 2, entries: [] }, { version: 1, entries: [{ ...entry('a'), position: 4 }] },
    { version: 1, entries: [entry('a'), entry('a')] }, { version: 1, entries: [entry('a', { keywords: [] })] },
    { version: 1, entries: [entry('a', { when: { script: 'return true' } })] },
    ...['../x', '/workspace/x', 'https://x', 'a\\b', 'workspace/x', '__proto__/x'].map(file => ({ version: 1, entries: [entry('a', { content: undefined, file })] })),
    { version: 1, entries: [entry('a', { when: { file: 'x.json', path: ['__proto__'], op: 'eq', value: 1 } })] },
  ];
  for (const value of cases) assert.throws(() => Rules.parse(JSON.stringify(value)), /世界触发器/);
  assert.throws(() => Validation.validate('/workspace/世界触发器.json', ''), /世界触发器/);
  const s = save([entry('a', { content: undefined, file: 'missing.md' })]);
  const result = Builder.validate(s.tree, '/workspace'); assert.ok(result.errors.some(e => e.includes('missing.md')));
  const good = { version: 1, entries: [entry('a')] }; assert.doesNotThrow(() => Rules.parse('\uFEFF' + JSON.stringify(good)));
});
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
test('真实请求循环在新 story 后激活，完整工具批次后注入；中断继续不重复计时', async () => {
  const s = save([entry('a', { once: true, sources: ['story'] })]); Core.beginRound(s, '', true, '开场');
  let requests = 0;
  const transport = async messages => {
    requests++;
    if (requests === 1) { assert.equal(messages.some(m => m.content.startsWith(Triggers.HEADER)), false);
      return { reasoning: '真实思考', tool_calls: [call('append_story', { content: '钟楼在雾中浮现', one_line_summary_of_content: '出现' ,self_accept:true}, 'story')] }; }
    assert.match(messages.at(-1).content, /资料-a/); assert.equal(messages.at(-2).role, 'tool');
    assert.equal(messages.find(m => m.tool_calls)?.reasoning_content, '真实思考');
    throw Error('模拟断网');
  };
  await assert.rejects(Core.run(s, transport, { openingPreload: false }), /模拟断网/);
  const ledger = structuredClone(s.worldTriggers);
  await Core.run(s, async messages => { assert.match(messages.at(-1).content, /资料-a/); return { tool_calls: [call('end_the_round', { NEXT_TURN_CACHE: { Story_Phase: '游戏循环' } }, 'end')] }; });
  assert.deepEqual(s.worldTriggers, ledger); assert.equal(s.round, 1);
});
test('预设开场在首次 AI 回合仍作为 story 参与扫描', async () => {
  const s = save([entry('opening', { sources: ['story'] })]); V.writeFile(s.tree, '/workspace/预设第一回合.md', '钟楼传来钟声');
  Core.beginRound(s, '', true, '开局');
  await Core.run(s, async () => { throw Error('预设不发请求'); });
  begin(s, '等待'); assert.deepEqual(ids(s), ['opening']);
});
