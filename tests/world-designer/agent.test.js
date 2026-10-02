'use strict';
const test = require('node:test');
const assert = require('node:assert');
const VFS = require('../../src/world-designer/vfs.js');
const C = require('../../src/world-designer/00-config.js');
const Agent = require('../../src/world-designer/agent.js');

function freshTree() {
  const t = VFS.createTree();
  VFS.mkdirp(t, ['workspace']);
  VFS.mkdirp(t, ['skills']);
  return t;
}

test('executeTool: write_file 落到 VFS 并标记写操作', () => {
  const t = freshTree();
  const ctx = { tree: t, skills: C.BUILTIN_SKILLS, config: C.AGENT_CONFIG };
  const r = Agent.executeTool(ctx, 'write_file', { path: '/workspace/a.md', content: '嗨' });
  assert.strictEqual(r.isWrite, true);
  assert.match(r.result, /成功/);
  assert.strictEqual(VFS.readFile(t, '/workspace/a.md').content, '嗨');
});

test('executeTool: 错误转为字符串结果而非抛出', () => {
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  const r = Agent.executeTool(ctx, 'read_file', { path: '/workspace/none.md' });
  assert.strictEqual(r.isWrite, false);
  assert.match(r.result, /错误/);
});

test('写保护: 新文件可直接写；覆盖已存在文件须先读', () => {
  const t = freshTree();
  const ctx = { tree: t, skills: [], config: C.AGENT_CONFIG, readState: new Map() };
  // 新文件：直接写成功
  assert.match(Agent.executeTool(ctx, 'write_file', { path: '/workspace/a.md', content: 'v1' }).result, /成功/);
  // 覆盖：写入后 readState 已记录，可再次覆盖
  assert.match(Agent.executeTool(ctx, 'write_file', { path: '/workspace/a.md', content: 'v2' }).result, /成功/);
  // 未读过的已存在文件：拒绝
  ctx.readState.clear();
  assert.match(Agent.executeTool(ctx, 'write_file', { path: '/workspace/a.md', content: 'v3' }).result, /必须先.*read_file/);
  // 读后可写
  Agent.executeTool(ctx, 'read_file', { path: '/workspace/a.md' });
  assert.match(Agent.executeTool(ctx, 'write_file', { path: '/workspace/a.md', content: 'v4' }).result, /成功/);
});

test('写保护: 读后被改动则拒绝写', () => {
  const t = freshTree();
  const ctx = { tree: t, skills: [], config: C.AGENT_CONFIG, readState: new Map() };
  VFS.writeFile(t, '/workspace/a.md', 'orig', { now: 100 });
  Agent.executeTool(ctx, 'read_file', { path: '/workspace/a.md' });
  // 模拟用户手动编辑（mtime 变化）
  VFS.writeFile(t, '/workspace/a.md', 'edited', { now: 200 });
  assert.match(Agent.executeTool(ctx, 'write_file', { path: '/workspace/a.md', content: 'x' }).result, /内容与你上次读到的不一致/);
});

test('executeTool: run_skill 返回 instructions，未知工具报错文本', () => {
  const skills = [{ name: 'demo-writer', description: 'd', instructions: '# 写作流程\n步骤', files: {} }];
  const ctx = { tree: freshTree(), skills, config: C.AGENT_CONFIG };
  const r = Agent.executeTool(ctx, 'run_skill', { name: 'demo-writer' });
  assert.match(r.result, /写作流程/);
  const r2 = Agent.executeTool(ctx, 'run_skill', { name: 'none' });
  assert.match(r2.result, /错误/);
  const r3 = Agent.executeTool(ctx, 'nope', {});
  assert.match(r3.result, /未知工具/);
});

test('runTurn: 纯文本回复，无写操作', async () => {
  const transport = async () => ({ content: '你好！', tool_calls: [] });
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  const out = await Agent.runTurn(ctx, [{ role: 'user', content: 'hi' }], transport, {});
  assert.strictEqual(out.hadWrite, false);
  assert.strictEqual(out.newMessages[out.newMessages.length - 1].content, '你好！');
});

test('runTurn: 工具循环——先调工具再答复', async () => {
  let call = 0;
  const transport = async (msgs) => {
    call++;
    if (call === 1) return { content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"/workspace/x.md","content":"内容"}' } },
    ] };
    // 第二次请求应包含 tool 结果消息
    assert.strictEqual(msgs[msgs.length - 1].role, 'tool');
    return { content: '已写入', tool_calls: [] };
  };
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  const out = await Agent.runTurn(ctx, [{ role: 'user', content: '写个文件' }], transport, {});
  assert.strictEqual(out.hadWrite, true);
  assert.strictEqual(call, 2);
  assert.strictEqual(VFS.readFile(ctx.tree, '/workspace/x.md').content, '内容');
});

test('runTurn: 工具参数 JSON 非法时回传错误给模型', async () => {
  let call = 0;
  const transport = async (msgs) => {
    call++;
    if (call === 1) return { content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{bad json' } },
    ] };
    assert.match(msgs[msgs.length - 1].content, /参数解析失败/);
    return { content: 'ok', tool_calls: [] };
  };
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  await Agent.runTurn(ctx, [{ role: 'user', content: 'x' }], transport, {});
  assert.strictEqual(call, 2);
});

test('runTurn: 超过 maxToolLoops 强制终止', async () => {
  const transport = async () => ({ content: '', tool_calls: [
    { id: 'c', type: 'function', function: { name: 'list_dir', arguments: '{"path":"/workspace"}' } },
  ] });
  const ctx = { tree: freshTree(), skills: [], config: { ...C.AGENT_CONFIG, maxToolLoops: 3 } };
  const out = await Agent.runTurn(ctx, [{ role: 'user', content: 'x' }], transport, {});
  assert.match(out.newMessages[out.newMessages.length - 1].content, /已达最大工具调用次数/);
});

// ---------- ask_user ----------
test('runTurn abort interrupts an unanswered tool without running later writes', { timeout: 500 }, async () => {
  const controller = new AbortController(), tree = freshTree();
  let asked;
  const waiting = new Promise(resolve => { asked = resolve; });
  const ctx = { tree, skills: [], config: C.AGENT_CONFIG, askUser: () => { asked(); return new Promise(() => {}); } };
  const turn = Agent.runTurn(ctx, [], async () => ({ content: '', tool_calls: [
    { id: 'ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: '选哪个？', options: ['A', 'B'] }] }) } },
    { id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '/workspace/late.txt', content: '不应写入' }) } },
  ] }), { signal: controller.signal });
  await waiting; controller.abort();
  await assert.rejects(turn, { name: 'AbortError' });
  assert.equal(VFS.resolve(tree, ['workspace', 'late.txt']), null);
});

test('normalizeQuestions 修正畸形参数并限制数量', () => {
  const n = Agent.normalizeQuestions([
    { question: '选哪个？', header: '这是一个非常长的标签会被截断', options: [{ label: 'A', description: 'a' }, { label: 'B' }] },
    { question: '选项不足', options: [{ label: '只有一个' }] },        // 应被丢弃
    { question: '', options: [{ label: 'A' }, { label: 'B' }] },        // 无题干，丢弃
    { question: '多选题', options: ['纯字符串', { label: 'B' }], multiSelect: true },
    { question: '第四题', options: [{ label: 'A' }, { label: 'B' }] },  // 超过 3 题，丢弃
  ]);
  // 5 个输入中合法的是第 1、4、5 题（第 2 题选项不足、第 3 题无题干），上限 3 全部保留
  assert.strictEqual(n.length, 3, '过滤后再限量，不应因前面的废题吃掉后面的合法题');
  assert.deepStrictEqual(n.map(q => q.question), ['选哪个？', '多选题', '第四题']);
  assert.ok(n[0].header.length <= 12, 'header 应被截断');
  assert.strictEqual(n[0].options.length, 3, '模型给的 2 个 + 自动补的「其他」');
  assert.strictEqual(n[0].options[2].other, true);
  assert.strictEqual(n[1].multiSelect, true);
  assert.strictEqual(n[1].options[0].label, '纯字符串', '字符串选项应被接受');
});

test('normalizeQuestions 限制每题最多 4 个选项', () => {
  const n = Agent.normalizeQuestions([{ question: 'q', options: ['a','b','c','d','e','f'] }]);
  // 模型给的截到 4 个，再加程序注入的「其他」
  assert.strictEqual(n[0].options.length, 5);
  assert.deepStrictEqual(n[0].options.map(o => o.label), ['a','b','c','d','其他']);
});

test('「其他」由程序自动注入，模型无需自己写', () => {
  const n = Agent.normalizeQuestions([{ question: 'q', options: ['甲', '乙'] }]);
  const last = n[0].options[n[0].options.length - 1];
  assert.strictEqual(last.label, '其他');
  assert.strictEqual(last.other, true, '带 other 标记，UI 据此特殊处理');
});

test('模型已写「其他」时不重复注入', () => {
  for (const label of ['其他', '其它', '自定义', 'Other', 'custom']) {
    const n = Agent.normalizeQuestions([{ question: 'q', options: ['甲', '乙', label] }]);
    assert.strictEqual(n[0].options.length, 3, '已有「' + label + '」时不该再加一个');
  }
});

test('「都行」「不确定」是对选项的表态，不等于「其他」，仍要补', () => {
  // 这些表示「你替我挑」，而不是「都不合适，我另外说」——语义相反，不能当兜底项
  for (const label of ['都行', '都可以', '随便', '不确定', '以上都不选', '均可']) {
    const n = Agent.normalizeQuestions([{ question: 'q', options: ['甲', '乙', label] }]);
    assert.strictEqual(n[0].options.length, 4, '「' + label + '」不是兜底项，仍应补「其他」');
    assert.strictEqual(n[0].options[3].label, '其他');
  }
});

test('hasOtherOption 只认整词，不误伤含相同字的正常选项', () => {
  assert.strictEqual(Agent.hasOtherOption([{ label: 'IndexedDB' }, { label: '本地存储' }]), false);
  assert.strictEqual(Agent.hasOtherOption([{ label: '深色模式' }, { label: '浅色模式' }]), false);
  // 「其他人负责」含「其他」二字，但它是一个实义选项，不该被当成兜底项
  assert.strictEqual(Agent.hasOtherOption([{ label: '其他人负责' }]), false);
  assert.strictEqual(Agent.hasOtherOption([{ label: '自定义规则' }]), false);
  assert.strictEqual(Agent.hasOtherOption([{ label: '其他' }]), true);
  assert.strictEqual(Agent.hasOtherOption([{ label: ' 其他 ' }]), true, '两侧空白应忽略');
});

test('ask_user 无 askUser 注入时返回可读错误而非崩溃', () => {
  const ctx = { tree: VFS.createTree(), config: C.AGENT_CONFIG, skills: [] };
  const out = Agent.executeTool(ctx, 'ask_user', { questions: [{ question: 'q', options: ['a', 'b'] }] });
  assert.match(out.result, /不支持向用户提问/);
  assert.strictEqual(out.pending, undefined);
});

test('ask_user 空问题列表报错', () => {
  const ctx = { tree: VFS.createTree(), config: C.AGENT_CONFIG, skills: [], askUser: async () => 'x' };
  assert.match(Agent.executeTool(ctx, 'ask_user', { questions: [] }).result, /错误/);
});

test('runTurn 等待 ask_user 的回答再继续', async () => {
  const tree = VFS.createTree();
  VFS.mkdirp(tree, ['workspace']);
  let asked = null;
  const ctx = {
    tree, config: C.AGENT_CONFIG, skills: [],
    askUser: async qs => { asked = qs; await new Promise(r => setTimeout(r, 20)); return '用户回答如下：\n\n问：用哪个？\n答：方案 A'; },
  };
  let call = 0;
  const transport = async msgs => {
    call++;
    if (call === 1) return { content: '', tool_calls: [{ id: 'q1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: '用哪个？', options: [{ label: '方案 A' }, { label: '方案 B' }] }] }) } }] };
    // 第二次请求时，工具结果应已包含用户的回答
    const toolMsg = msgs.find(m => m.role === 'tool' && m.tool_call_id === 'q1');
    assert.ok(toolMsg && toolMsg.content.includes('方案 A'), '回答应在下一次请求中可见');
    return { content: '好的，用方案 A。' };
  };
  const out = await Agent.runTurn(ctx, [], transport, {});
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].options.length, 3, '2 个模型选项 + 自动补的「其他」');
  assert.match(out.newMessages.find(m => m.role === 'tool').content, /方案 A/);
  assert.strictEqual(out.hadWrite, false, '提问不算写操作');
});

test('runTurn 在 askUser 抛错时不中断整轮', async () => {
  const tree = VFS.createTree();
  VFS.mkdirp(tree, ['workspace']);
  const ctx = { tree, config: C.AGENT_CONFIG, skills: [], askUser: async () => { throw new Error('对话框崩了'); } };
  let call = 0;
  const transport = async () => {
    call++;
    if (call === 1) return { content: '', tool_calls: [{ id: 'q1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: 'q', options: ['a','b'] }] }) } }] };
    return { content: '继续' };
  };
  const out = await Agent.runTurn(ctx, [], transport, {});
  assert.match(out.newMessages.find(m => m.role === 'tool').content, /对话框崩了/);
  assert.strictEqual(out.newMessages[out.newMessages.length - 1].content, '继续');
});

// ---------- goal ----------
function goalCtx(goal) {
  const tree = VFS.createTree();
  VFS.mkdirp(tree, ['workspace']);
  return { tree, config: C.AGENT_CONFIG, skills: [],
    goal: goal || { content: '', changedPending: false } };
}

test('goal set 在无目标时设立，重复 set 被拒', () => {
  const ctx = goalCtx();
  const r = Agent.executeTool(ctx, 'goal', { action: 'set', content: '写完第三章' });
  assert.strictEqual(ctx.goal.content, '写完第三章');
  assert.strictEqual(r.goalEvent.kind, 'set');
  const r2 = Agent.executeTool(ctx, 'goal', { action: 'set', content: '换一个' });
  assert.match(r2.result, /已有目标/);
  assert.strictEqual(ctx.goal.content, '写完第三章', '被拒后目标不变');
});

test('goal change 需要已有目标', () => {
  const ctx = goalCtx();
  assert.match(Agent.executeTool(ctx, 'goal', { action: 'change', content: 'x' }).result, /没有目标/);
  Agent.executeTool(ctx, 'goal', { action: 'set', content: '初始' });
  const r = Agent.executeTool(ctx, 'goal', { action: 'change', content: '修改后' });
  assert.strictEqual(ctx.goal.content, '修改后');
  assert.strictEqual(r.goalEvent.prev, '初始');
});

test('goal end 清空目标并区分 finished / break', () => {
  const ctx = goalCtx({ content: '干活', changedPending: false });
  const r = Agent.executeTool(ctx, 'goal', { action: 'end', reason: 'finished' });
  assert.strictEqual(ctx.goal.content, '');
  assert.strictEqual(r.goalEvent.reason, 'finished');

  const ctx2 = goalCtx({ content: '干活', changedPending: false });
  assert.strictEqual(Agent.executeTool(ctx2, 'goal', { action: 'end', reason: 'break' }).goalEvent.reason, 'break');
  // reason 缺失或非法时拒绝，目标保留
  const ctx3 = goalCtx({ content: '干活', changedPending: false });
  assert.match(Agent.executeTool(ctx3, 'goal', { action: 'end' }).result, /reason/);
  assert.strictEqual(ctx3.goal.content, '干活');
});

test('目标被改过而模型未获知时，禁止直接结束', () => {
  const ctx = goalCtx({ content: '新目标', changedPending: true });
  const r = Agent.executeTool(ctx, 'goal', { action: 'end', reason: 'finished' });
  assert.strictEqual(r.goalEvent.kind, 'end-rejected');
  assert.strictEqual(ctx.goal.content, '新目标', '结束被拒，目标保留');
});

test('goal 内容超长被拒', () => {
  const ctx = goalCtx();
  const r = Agent.executeTool(ctx, 'goal', { action: 'set', content: 'x'.repeat(C.GOAL_MAX_CHARS + 1) });
  assert.match(r.result, /过长/);
  assert.strictEqual(ctx.goal.content, '');
});

test('runTurn 通过 onGoalEvent 上报目标变化', async () => {
  const ctx = goalCtx();
  const events = [];
  let call = 0;
  const transport = async () => {
    call++;
    if (call === 1) return { content: '', tool_calls: [{ id: 'g1', type: 'function',
      function: { name: 'goal', arguments: JSON.stringify({ action: 'set', content: '目标A' }) } }] };
    return { content: '开始干' };
  };
  await Agent.runTurn(ctx, [], transport, { onGoalEvent: e => events.push(e) });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'set');
  assert.strictEqual(ctx.goal.content, '目标A');
});

// ---------- 写保护：只拦外部改动，不拦 AI 自己 ----------
function guardCtx() {
  const tree = VFS.createTree();
  VFS.mkdirp(tree, ['workspace']);
  return { tree, config: C.AGENT_CONFIG, skills: [], readState: new Map() };
}

test('AI 连续修改同一文件不需要反复 read', () => {
  const ctx = guardCtx();
  const run = (n, a) => Agent.executeTool(ctx, n, a).result;
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'v1' }), /成功/);
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'v2' }), /成功/, '刚写完再覆盖，不该要求重读');
  assert.match(run('apply_patch', { path: '/workspace/a.md', old_str: 'v2', new_str: 'v3' }), /成功/);
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'v4' }), /成功/, 'patch 之后覆盖也不该被拦');
});

test('copy / move 的目标文件视同已读', () => {
  const ctx = guardCtx();
  const run = (n, a) => Agent.executeTool(ctx, n, a).result;
  run('write_file', { path: '/workspace/a.md', content: 'v1' });
  run('copy', { from: '/workspace/a.md', to: '/workspace/b.md' });
  assert.match(run('write_file', { path: '/workspace/b.md', content: 'x' }), /成功/, '副本是自己复制的，无须再读');
  run('move', { from: '/workspace/b.md', to: '/workspace/c.md' });
  assert.match(run('write_file', { path: '/workspace/c.md', content: 'y' }), /成功/, '移动目标同理');
});

test('外部改动仍然拦截，重读后放行', () => {
  const ctx = guardCtx();
  const run = (n, a) => Agent.executeTool(ctx, n, a).result;
  run('write_file', { path: '/workspace/a.md', content: 'v1' });
  VFS.writeFile(ctx.tree, '/workspace/a.md', '用户手改');     // 绕过工具，模拟外部改动
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'v2' }), /内容与你上次读到的不一致/);
  run('read_file', { path: '/workspace/a.md' });
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'v2' }), /成功/, '重读后应放行');
});

test('未读过的既有文件必须先 read', () => {
  const ctx = guardCtx();
  VFS.writeFile(ctx.tree, '/workspace/外部.md', '别处来的');
  assert.match(Agent.executeTool(ctx, 'write_file', { path: '/workspace/外部.md', content: 'q' }).result,
    /必须先用 read_file/);
});

test('删除后同名重建的文件不沿用旧读记录', () => {
  const ctx = guardCtx();
  const run = (n, a) => Agent.executeTool(ctx, n, a).result;
  run('write_file', { path: '/workspace/a.md', content: 'v1' });
  run('delete', { path: '/workspace/a.md' });
  VFS.writeFile(ctx.tree, '/workspace/a.md', '别人重建的');    // 外部重建同名文件
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'w' }), /必须先用 read_file/,
    '同名不等于同一个文件，旧记录必须作废');
});

test('同一毫秒内的外部改动也能识别（内容指纹而非 mtime）', () => {
  const ctx = guardCtx();
  const run = (n, a) => Agent.executeTool(ctx, n, a).result;
  run('write_file', { path: '/workspace/a.md', content: 'AAA' });
  // 紧接着改内容——mtime 很可能相同，只有内容判据能发现
  VFS.writeFile(ctx.tree, '/workspace/a.md', 'BBB');
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'CCC' }), /内容与你上次读到的不一致/);
});

// 审阅结果对「已读指纹」的影响：AI 收到的是「写入成功」，它默认文件就是自己写的那样。
// 接受 → 事实与预期一致，不该逼它重读；拒绝 → 内容已被退回，必须重读。
// UI 层负责在两种分支里同步/清除指纹，这里验证 agent 侧的判据能配合这两种做法。
test('接受审阅：指纹同步后可继续写，无需重读', () => {
  const ctx = guardCtx();
  const run = (n, a) => Agent.executeTool(ctx, n, a).result;
  run('write_file', { path: '/workspace/a.md', content: 'AI 版' });
  // 模拟 UI 的「接受」：文件保持 AI 写的内容，同步指纹
  Agent.recordRead(ctx, '/workspace/a.md');
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'AI 版2' }), /成功/);
});

test('拒绝审阅：清掉指纹后必须重读才能写', () => {
  const ctx = guardCtx();
  const run = (n, a) => Agent.executeTool(ctx, n, a).result;
  run('write_file', { path: '/workspace/a.md', content: 'AI 版' });
  // 模拟 UI 的「拒绝」：内容退回旧版 + 清掉指纹
  VFS.writeFile(ctx.tree, '/workspace/a.md', '旧版');
  ctx.readState.delete('/workspace/a.md');
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'x' }), /必须先用 read_file/);
  run('read_file', { path: '/workspace/a.md' });
  assert.match(run('write_file', { path: '/workspace/a.md', content: 'x' }), /成功/);
});

// ---------- read_file 上限分层 ----------
test('readCapFor: /skills/ 下用更高默认上限', () => {
  const cfg = C.AGENT_CONFIG;
  assert.strictEqual(Agent.readCapFor(cfg, '/workspace/a.md'), cfg.readCharLimit);
  assert.strictEqual(Agent.readCapFor(cfg, '/skills/x/ref.md'), cfg.skillReadCharLimit);
  assert.strictEqual(Agent.readCapFor(cfg, 'skills/x/ref.md'), cfg.skillReadCharLimit,
    '相对路径也该识别');
  assert.strictEqual(Agent.readCapFor(cfg, '/skillsets/a.md'), cfg.readCharLimit,
    '前缀相似但不是 skills，不该提额');
});

test('readCapFor: 模型显式传 limit 时以它为准，但夹在硬上限内', () => {
  const cfg = C.AGENT_CONFIG;
  assert.strictEqual(Agent.readCapFor(cfg, '/workspace/a.md', 500), 500);
  assert.strictEqual(Agent.readCapFor(cfg, '/skills/a.md', 100), 100, 'skills 下也听模型的');
  assert.strictEqual(Agent.readCapFor(cfg, '/workspace/a.md', 9e9), cfg.readCharLimitMax,
    '超大 limit 必须被硬上限夹住');
  // 非法值回落到默认
  assert.strictEqual(Agent.readCapFor(cfg, '/workspace/a.md', 0), cfg.readCharLimit);
  assert.strictEqual(Agent.readCapFor(cfg, '/workspace/a.md', -5), cfg.readCharLimit);
  assert.strictEqual(Agent.readCapFor(cfg, '/workspace/a.md', NaN), cfg.readCharLimit);
});

test('read_file 实际生效：skills 长文件一次读完，workspace 超长才截断', () => {
  const tree = VFS.createTree();
  VFS.mkdirp(tree, ['workspace']);
  const d = VFS.mkdirp(tree, ['skills', 'demo']);
  // /skills/ 只读，按 skill-loader 的方式直接挂节点
  d.children['ref.md'] = { type: 'file', content: '资'.repeat(12000), mtime: Date.now() };
  const ctx = { tree, skills: [], config: C.AGENT_CONFIG, readState: new Map() };
  const r = Agent.executeTool(ctx, 'read_file', { path: '/skills/demo/ref.md' });
  assert.ok(!/文件片段/.test(r.result), '12000 字的参考资料不该被截断');

  VFS.writeFile(tree, '/workspace/big.md', 'x'.repeat(40000), { cap: 200000 });
  assert.match(Agent.executeTool(ctx, 'read_file', { path: '/workspace/big.md' }).result,
    /未读，用 offset=/, '超过默认上限要标出省略量并给出续读参数');
  assert.ok(!/文件片段/.test(Agent.executeTool(ctx, 'read_file',
    { path: '/workspace/big.md', limit: 40000 }).result), '显式 limit 后应一次读完');
});

test('read_file 片段读取：首尾都标出省略了多少字符', () => {
  const tree = VFS.createTree();
  VFS.mkdirp(tree, ['workspace']);
  const ctx = { tree, skills: [], config: C.AGENT_CONFIG, readState: new Map() };
  VFS.writeFile(tree, '/workspace/x.md', 'A'.repeat(100000), { cap: 200000 });

  // 从中间读：前后都省略了，两头都必须说清楚
  const mid = Agent.executeTool(ctx, 'read_file', { path: '/workspace/x.md', offset: 40000, limit: 1000 }).result;
  assert.match(mid, /共 100000 字符，本次返回 40000–41000/, '开头交代总量与本次范围');
  assert.match(mid, /前面还有 40000 字符未读/, '头部省略量——这是原来完全缺失的信息');
  assert.match(mid, /后面还有 59000 字符未读，用 offset=41000 继续读/, '尾部省略量与续读参数');

  // 从头读但没读完：不该谎报头部有省略
  const head = Agent.executeTool(ctx, 'read_file', { path: '/workspace/x.md', limit: 1000 }).result;
  assert.ok(!/前面还有/.test(head), 'offset=0 时没有头部省略');
  assert.match(head, /后面还有 99000 字符未读/);

  // 读到末尾：明确告知已到底，避免模型无谓续读
  const tail = Agent.executeTool(ctx, 'read_file', { path: '/workspace/x.md', offset: 99500 }).result;
  assert.match(tail, /前面还有 99500 字符未读/);
  assert.match(tail, /已到文件末尾/);
  assert.ok(!/后面还有/.test(tail));

  // 完整读取：不加任何包装，避免污染正文
  VFS.writeFile(tree, '/workspace/s.md', '短内容');
  assert.strictEqual(Agent.executeTool(ctx, 'read_file', { path: '/workspace/s.md' }).result, '短内容');
});

test('run_skill 返回尾注：声明流程优先于临场判断', () => {
  const skills = [{ name: 'demo', description: 'd', instructions: '# 流程\n步骤一',
    files: { '/skills/demo/ref.md': '资料' } }];
  const ctx = { tree: freshTree(), skills, config: C.AGENT_CONFIG };
  const out = Agent.executeTool(ctx, 'run_skill', { name: 'demo' }).result;
  assert.match(out, /# 流程/, 'Skill 正文仍在');
  assert.match(out, /根目录: \/skills\/demo/);
  assert.match(out, /优先于你的临场判断/, '尾注声明流程的权威性');
  assert.match(out, /read_file/, '指明参考资料怎么取');
  assert.match(out, /不要在回复里提及/, '要求内化，不暴露来源');
  // 尾注在正文之后，模型读完流程紧接着看到执行要求
  assert.ok(out.indexOf('# 流程') < out.indexOf('优先于你的临场判断'));
});

test('runTurn 把思考挂成 API 规范字段 reasoning_content', async () => {
  const transport = async () => ({ content: '正文回答', reasoning: '内心推演过程', tool_calls: [] });
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  const out = await Agent.runTurn(ctx, [{ role: 'user', content: 'hi' }], transport, {});
  const asst = out.newMessages[out.newMessages.length - 1];
  assert.strictEqual(asst.content, '正文回答');
  // 字段名必须是 reasoning_content：DeepSeek 思考模式带 tools 时要求原样回传，
  // 用别的名字等于没传，会 400
  assert.strictEqual(asst.reasoning_content, '内心推演过程');
  assert.ok(!('reasoning' in asst), '不留非规范字段名');
});

test('runTurn 无思考时不产生该字段（老 transport 兼容）', async () => {
  const transport = async () => ({ content: '普通回答', tool_calls: [] });
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  const out = await Agent.runTurn(ctx, [{ role: 'user', content: 'hi' }], transport, {});
  const last = out.newMessages[out.newMessages.length - 1];
  assert.ok(!('reasoning_content' in last) && !('reasoning' in last),
    '没有思考就不该带空字段，落库和回传都干净');
});

test('工具循环：同轮内的 reasoning_content 随历史回传给下一次请求', async () => {
  // DeepSeek 硬性要求——带 tools 的请求，后续所有请求必须完整回传 reasoning_content，
  // 缺了会 400。工具循环的第二次请求就是最容易漏掉的地方。
  let call = 0;
  const seen = [];
  const transport = async (msgs) => {
    call++;
    if (call === 1) return { content: '', reasoning: '我需要先读文件',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"/workspace"}' } }] };
    // 第二次请求：历史里那条 assistant 必须带着第一次的思考
    seen.push(...msgs.filter(m => m.role === 'assistant'));
    return { content: '看完了', reasoning: '文件不多，直接回答', tool_calls: [] };
  };
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  const out = await Agent.runTurn(ctx, [{ role: 'user', content: '看看目录' }], transport, {});
  assert.strictEqual(call, 2);
  assert.strictEqual(seen.length, 1, '第二次请求里应有一条 assistant 历史');
  assert.strictEqual(seen[0].reasoning_content, '我需要先读文件', '同轮思考必须回传');
  assert.ok(Array.isArray(seen[0].tool_calls) && seen[0].tool_calls.length, '且与 tool_calls 同在一条消息上');
  // 两轮的思考各自独立，不串味
  const finalMsg = out.newMessages[out.newMessages.length - 1];
  assert.strictEqual(finalMsg.reasoning_content, '文件不多，直接回答');
});

/* ---------- 思考强度：请求字段与方言降级 ---------- */

test('applyThinkingFields 第 0 层：全量方言字段（DeepSeek/Qwen/vLLM 等）', () => {
  const b = Agent.applyThinkingFields({}, 'none');
  assert.deepStrictEqual(b.thinking, { type: 'disabled' });
  assert.strictEqual(b.enable_thinking, false, '兼容 Qwen 等的布尔开关字段');
  // 用户明确要求：关闭时强度也一并发 none，只发开关会被某些实现当作「未指定」
  assert.strictEqual(b.reasoning_effort, 'none');
  assert.deepStrictEqual(b.reasoning, { effort: 'none' });
});

test('applyThinkingFields 开启档：同时发开关与强度', () => {
  for (const lv of ['low', 'high', 'xhigh', 'max']) {
    const b = Agent.applyThinkingFields({}, lv);
    assert.deepStrictEqual(b.thinking, { type: 'enabled' }, lv + ' 应开启思考');
    assert.strictEqual(b.enable_thinking, true, lv);
    assert.strictEqual(b.reasoning_effort, lv);
    assert.deepStrictEqual(b.reasoning, { effort: lv });
  }
});

test('applyThinkingFields 第 1 层：只留 OpenAI 官方认的 reasoning_effort', () => {
  // OpenAI / Azure 对未知字段直接 400，降级后必须只剩这一个
  const b = Agent.applyThinkingFields({}, 'low', 1);
  assert.strictEqual(b.reasoning_effort, 'low');
  for (const f of ['thinking', 'enable_thinking', 'reasoning']) {
    assert.strictEqual(f in b, false, '第 1 层不应再发 ' + f);
  }
});

test('applyThinkingFields 第 1 层关闭档：reasoning_effort=none 即 OpenAI 的关闭方式', () => {
  const b = Agent.applyThinkingFields({}, 'none', 1);
  assert.strictEqual(b.reasoning_effort, 'none');
  assert.strictEqual('thinking' in b, false);
});

test('applyThinkingFields 第 2 层：一个思考字段都不发', () => {
  const b = Agent.applyThinkingFields({ model: 'm' }, 'max', 2);
  for (const f of ['thinking', 'enable_thinking', 'reasoning_effort', 'reasoning']) {
    assert.strictEqual(f in b, false, '第 2 层不应发 ' + f);
  }
  assert.strictEqual(b.model, 'm');
});

test('isThinkFieldError 只认领点名思考字段的 400/422', () => {
  const msg = "Unrecognized request argument supplied: enable_thinking";
  assert.strictEqual(Agent.isThinkFieldError(400, msg), true);
  assert.strictEqual(Agent.isThinkFieldError(422, "invalid reasoning_effort"), true);
  // 其他 400 不能被误当成字段问题，否则真实报错会被静默重试掉
  assert.strictEqual(Agent.isThinkFieldError(400, 'invalid api key'), false);
  assert.strictEqual(Agent.isThinkFieldError(401, msg), false, '鉴权失败不该重试');
  assert.strictEqual(Agent.isThinkFieldError(500, msg), false, '服务端错误不该当字段问题');
});

test('applyThinkingFields 非法/缺省值回落到 high（界面的「中」）', () => {
  for (const bad of [undefined, null, '', 'medium', 'ULTRA']) {
    const b = Agent.applyThinkingFields({}, bad);
    assert.strictEqual(b.reasoning_effort, 'high', String(bad) + ' 应回落');
    assert.strictEqual(b.enable_thinking, true);
  }
});

test('EFFORT_LEVELS 顺序即滑块档位顺序', () => {
  assert.deepStrictEqual(Agent.EFFORT_LEVELS, ['none', 'low', 'high', 'xhigh', 'max']);
});

test('applyThinkingFields 不动 body 上的其他字段', () => {
  const b = Agent.applyThinkingFields({ model: 'm', messages: [], tools: [1] }, 'low');
  assert.strictEqual(b.model, 'm');
  assert.deepStrictEqual(b.tools, [1]);
});

/* ---------- transport：遇到 400 自动降级 ---------- */

function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return handler(body, calls.length);
  };
  return calls;
}
const okJson = () => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
});
const err400 = (msg) => ({ ok: false, status: 400, text: async () => msg });
const S = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'k', temperature: 1, stream: false, reasoningEffort: 'high' };

test('transport abort cancels an idle stream reader without waiting for another chunk', { timeout: 500 }, async () => {
  const original = global.fetch, controller = new AbortController();
  let started, cancelled = false;
  const waiting = new Promise(resolve => { started = resolve; });
  global.fetch = async () => new Response(new ReadableStream({ pull() { started(); }, cancel() { cancelled = true; } }));
  try {
    const request = Agent.createHttpTransport({ ...S, stream: true }, [], { signal: controller.signal })([]);
    await waiting; controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(cancelled, true);
  } finally { global.fetch = original; }
});

test('transport：OpenAI 对未知字段 400 时自动减字段重试并成功', async () => {
  const calls = mockFetch((body, n) =>
    n === 1 && 'enable_thinking' in body
      ? err400('Unrecognized request argument supplied: enable_thinking')
      : okJson());
  const r = await Agent.createHttpTransport({ ...S, model: 'gpt-5.2-a' }, [], {})([]);
  assert.strictEqual(r.content, 'ok');
  assert.strictEqual(calls.length, 2, '应重试一次');
  assert.strictEqual('enable_thinking' in calls[1], false, '重试时不该再带方言字段');
  assert.strictEqual(calls[1].reasoning_effort, 'high', '仍应保留官方字段');
});

test('transport：连 reasoning_effort 也不认时降到不发任何思考字段', async () => {
  const calls = mockFetch((body) =>
    'reasoning_effort' in body ? err400('Unrecognized request argument supplied: reasoning_effort') : okJson());
  const r = await Agent.createHttpTransport({ ...S, model: 'gpt-5.2-b' }, [], {})([]);
  assert.strictEqual(r.content, 'ok');
  assert.strictEqual(calls.length, 3, '两次降级后成功');
  assert.strictEqual('reasoning_effort' in calls[2], false);
});

test('transport：同一 baseUrl+model 记住层级，后续请求不再试错', async () => {
  const calls = mockFetch((body, n) =>
    'enable_thinking' in body ? err400('Unrecognized request argument supplied: enable_thinking') : okJson());
  const t = Agent.createHttpTransport({ ...S, model: 'gpt-5.2-c' }, [], {});
  await t([]);
  const after = calls.length;
  await t([]);
  assert.strictEqual(calls.length, after + 1, '第二轮只发一次请求');
  assert.strictEqual('enable_thinking' in calls[calls.length - 1], false);
});

test('transport：与思考无关的 400 照常抛出，不吞不重试', async () => {
  const calls = mockFetch(() => err400('Incorrect API key provided'));
  await assert.rejects(
    () => Agent.createHttpTransport({ ...S, model: 'gpt-5.2-d' }, [], {})([]),
    /API 错误 400/);
  assert.strictEqual(calls.length, 1, '不该重试');
});

/* ---------- 工具参数预检 ----------
   tools 的 JSON Schema 对多数服务只是给模型看的说明书，不约束解码。
   模型漏字段、发错类型都真实发生过，报错必须点明是哪个参数错在哪。 */

test('参数预检：缺少必填参数时明确报出字段名', () => {
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  // 截图里的真实场景：apply_patch 没带 path
  const r = Agent.executeTool(ctx, 'apply_patch', { old_str: 'a', new_str: 'b' });
  assert.match(r.result, /缺少必填参数 path/);
  assert.match(r.result, /old_str/, '应列出该工具的完整必填清单');
  assert.strictEqual(r.isWrite, false);
});

test('参数预检：类型不符时说清期望与实际', () => {
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  // path 发成对象 —— 正是「路径必须是字符串」那条无头报错的来源
  const r = Agent.executeTool(ctx, 'read_file', { path: { file: '/workspace/a.md' } });
  assert.match(r.result, /参数 path 需要字符串，收到 object/);
  const r2 = Agent.executeTool(ctx, 'read_file', { path: ['/workspace/a.md'] });
  assert.match(r2.result, /收到 array/, '数组要与普通对象区分开');
});

test('参数预检：数字型字符串就地纠正，不打回重试', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/a.md', '0123456789');
  const ctx = { tree: t, skills: [], config: C.AGENT_CONFIG };
  // offset/limit 发成 "3" 语义无歧义，纠正即可
  const r = Agent.executeTool(ctx, 'read_file', { path: '/workspace/a.md', offset: '3', limit: '4' });
  assert.doesNotMatch(r.result, /错误/);
  assert.match(r.result, /3456/);
});

test('参数预检：非整数的数字字段照常报错', () => {
  const t = freshTree();
  VFS.writeFile(t, '/workspace/a.md', 'x');
  const ctx = { tree: t, skills: [], config: C.AGENT_CONFIG };
  const r = Agent.executeTool(ctx, 'read_file', { path: '/workspace/a.md', offset: 'abc' });
  assert.match(r.result, /参数 offset 需要整数/);
});

test('参数预检：合法参数照常放行', () => {
  const t = freshTree();
  const ctx = { tree: t, skills: [], config: C.AGENT_CONFIG, readState: new Map() };
  assert.match(Agent.executeTool(ctx, 'write_file', { path: '/workspace/a.md', content: '嗨' }).result, /成功/);
  assert.match(Agent.executeTool(ctx, 'list_dir', { path: '/workspace' }).result, /a\.md/);
});

test('参数预检：不认识的额外字段不拦（各家模型爱加，无害）', () => {
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  const r = Agent.executeTool(ctx, 'list_dir', { path: '/workspace', recursive: true });
  assert.doesNotMatch(r.result, /错误/);
});

test('参数串非法 JSON 时，错误提示带上长度并给出分次写入的出路', async () => {
  let call = 0, toolResult = '';
  const transport = async (msgs) => {
    call++;
    if (call === 1) return { content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"/workspace/x.md","content":"很长的内容' } },
    ] };
    toolResult = msgs[msgs.length - 1].content;
    return { content: 'ok', tool_calls: [] };
  };
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  await Agent.runTurn(ctx, [{ role: 'user', content: 'x' }], transport, {});
  assert.match(toolResult, /参数解析失败/);
  assert.match(toolResult, /字符/, '应报出收到多少字符，便于模型判断是否被截断');
  assert.match(toolResult, /apply_patch/, '应给出分次写入的出路');
});

test('参数是 JSON 数组或裸值时按参数错误处理，不当成对象', async () => {
  let toolResult = '', call = 0;
  const transport = async (msgs) => {
    call++;
    if (call === 1) return { content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '["/workspace"]' } },
    ] };
    toolResult = msgs[msgs.length - 1].content;
    return { content: 'ok', tool_calls: [] };
  };
  const ctx = { tree: freshTree(), skills: [], config: C.AGENT_CONFIG };
  await Agent.runTurn(ctx, [{ role: 'user', content: 'x' }], transport, {});
  assert.match(toolResult, /参数必须是 JSON 对象/);
});
