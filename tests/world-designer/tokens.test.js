'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../../src/world-designer/tokens.js');

test('estimate: CJK≈1/字, ASCII≈1/4字符', () => {
  assert.strictEqual(T.estimateText('你好世界'), 4);
  assert.strictEqual(T.estimateText('abcd'), 1);
  assert.strictEqual(T.estimateText(''), 0);
  // 混合：4 CJK + 8 ASCII = 4 + 2
  assert.strictEqual(T.estimateText('你好世界abcdefgh'), 6);
});

test('estimateMessages 累加各消息内容与工具字段', () => {
  const msgs = [
    { role: 'system', content: 'abcd' },              // 1
    { role: 'user', content: '你好' },                 // 2
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', content: 'abcdefgh' },            // 2
  ];
  const n = T.estimateMessages(msgs);
  assert.ok(n >= 5 && n <= 12, '合理区间, got ' + n);
});

test('slidingWindow 保留 system 与最近消息', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
  ];
  const kept = T.slidingWindow(msgs, 1); // 上限极低，仅保留 system + 最后一条
  assert.strictEqual(kept[0].role, 'system');
  assert.strictEqual(kept[kept.length - 1].content, 'a2');
  assert.ok(kept.length < msgs.length);
});

test('轮次完整性：滑窗/切断不拆分问答与工具调用', () => {
  const turn1 = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"/workspace/a.md","content":"' + 'x'.repeat(200) + '"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '写入成功' },
    { role: 'assistant', content: 'a1 done' },
  ];
  const turn2 = [{ role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }];
  const msgs = [{ role: 'system', content: 's' }, ...turn1, ...turn2];
  // 上限设在会切进 turn1 中间的位置
  for (const cap of [1, 5, 20, 40, 60]) {
    for (const fn of [T.slidingWindow, T.truncateOldest]) {
      const kept = fn(msgs, cap);
      // 每条 tool 消息前方必须存在带该 tool_call_id 的 assistant；每条 assistant(tool_calls) 后必须跟齐全部结果
      for (let i = 0; i < kept.length; i++) {
        const m = kept[i];
        if (m.role === 'tool')
          assert.ok(kept.some(x => x.role === 'assistant' && (x.tool_calls || []).some(tc => tc.id === m.tool_call_id)), 'tool 结果不能与调用分离');
        if (m.role === 'assistant' && m.tool_calls)
          for (const tc of m.tool_calls)
            assert.ok(kept.some(x => x.role === 'tool' && x.tool_call_id === tc.id), '工具调用不能与结果分离');
        if (m.role === 'assistant' && !m.tool_calls) {
          // 该轮的 user 必须在场（问答不拆）
          const prevUser = kept.slice(0, i).reverse().find(x => x.role === 'user');
          assert.ok(prevUser, '答不能没有问');
        }
      }
    }
  }
});

test('chunkByBudget 段边界只落在轮次边界', () => {
  const msgs = [];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'user', content: 'u' + i + 'x'.repeat(40) });
    msgs.push({ role: 'assistant', content: 'a' + i + 'y'.repeat(40) });
  }
  const chunks = T.chunkByBudget(msgs, 25);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.strictEqual(c[0].role, 'user', '每段必须以 user 开头');
    assert.strictEqual(c[c.length - 1].role, 'assistant', '每段必须以 assistant 结尾');
  }
  assert.strictEqual(chunks.flat().length, msgs.length, '不丢消息');
});

test('truncateOldest 从最早非 system 开始删至低于上限', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'x'.repeat(40) },   // ~10
    { role: 'user', content: 'y'.repeat(40) },   // ~10
  ];
  const kept = T.truncateOldest(msgs, 12);
  assert.strictEqual(kept[0].role, 'system');
  assert.ok(T.estimateMessages(kept) <= 12);
  assert.strictEqual(kept[kept.length - 1].content, 'y'.repeat(40));
});

// 两种策略的语义差异：滑窗渐进（丢到刚够），切断激进（一次砍一半）
test('truncate 一次砍掉前一半轮次，即便剩下的还装得下更多', () => {
  const msgs = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: 'user', content: 'u' + i });
    msgs.push({ role: 'assistant', content: 'a' + i });
  }
  // 上限足够宽松：只需丢掉极少内容就能装下
  const cap = T.estimateMessages(msgs) - 1;
  const cut = T.truncateOldest(msgs, cap);
  const slid = T.slidingWindow(msgs, cap);
  const turnsOf = kept => kept.filter(m => m.role === 'user').length;
  assert.strictEqual(turnsOf(cut), 5, '切断应只剩一半轮次');
  assert.ok(turnsOf(slid) > turnsOf(cut), '滑窗保留的轮次应多于切断，got slid=' + turnsOf(slid));
  assert.strictEqual(cut[0].role, 'system', 'system 始终保留');
  assert.strictEqual(cut[cut.length - 1].content, 'a9', '最新一轮必须在');
});

test('truncate 砍半后仍超限时继续逐轮丢弃兜底', () => {
  const msgs = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 6; i++) msgs.push({ role: 'user', content: 'x'.repeat(400) });
  const kept = T.truncateOldest(msgs, 30);
  assert.ok(T.estimateMessages(kept) <= 30 || kept.filter(m => m.role !== 'system').length === 1,
    '要么降到上限内，要么已缩到最后一轮');
});

test('truncate 只有一轮时不丢弃（否则无内容可发）', () => {
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'x'.repeat(4000) }];
  const kept = T.truncateOldest(msgs, 5);
  assert.strictEqual(kept.filter(m => m.role === 'user').length, 1);
});

// ---------- 上下文完整性净化（防死锁） ----------
const tc = (id, name) => ({ id, type: 'function', function: { name: name || 'write_file', arguments: '{}' } });

test('sanitize 丢弃缺结果的工具调用（中止/裁剪产生的半截）', () => {
  const msgs = [
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [tc('a1')] },   // 结果缺失
  ];
  const out = T.sanitizeMessages(msgs);
  assert.strictEqual(out.length, 1, '无文本无有效调用的 assistant 应整条丢弃');
  assert.strictEqual(out[0].role, 'user');
});

test('sanitize 缺结果但有文本时，退化为普通 assistant 而非丢弃', () => {
  const out = T.sanitizeMessages([
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '我说了些话', tool_calls: [tc('a1')] },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].tool_calls, undefined, '应剥掉无结果的 tool_calls');
  assert.strictEqual(out[1].content, '我说了些话');
});

test('sanitize 丢弃孤立的 tool 结果（找不到发起者）', () => {
  const out = T.sanitizeMessages([
    { role: 'user', content: 'u' },
    { role: 'tool', tool_call_id: 'ghost', content: '结果' },
    { role: 'assistant', content: '回答' },
  ]);
  assert.deepStrictEqual(out.map(m => m.role), ['user', 'assistant']);
});

test('sanitize 部分结果齐备时只保留齐备的那些', () => {
  const out = T.sanitizeMessages([
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [tc('ok1'), tc('missing')] },
    { role: 'tool', tool_call_id: 'ok1', content: 'r1' },
  ]);
  const asst = out.find(m => m.role === 'assistant');
  assert.strictEqual(asst.tool_calls.length, 1);
  assert.strictEqual(asst.tool_calls[0].id, 'ok1');
  assert.ok(out.some(m => m.role === 'tool' && m.tool_call_id === 'ok1'));
});

test('sanitize 完整的调用链原样保留', () => {
  const msgs = [
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [tc('a1'), tc('a2')] },
    { role: 'tool', tool_call_id: 'a1', content: 'r1' },
    { role: 'tool', tool_call_id: 'a2', content: 'r2' },
    { role: 'assistant', content: '完成' },
  ];
  assert.deepStrictEqual(T.sanitizeMessages(msgs), msgs);
});

test('sanitize 后的结果一定自洽（任意截断都不产生非法上下文）', () => {
  const full = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [tc('t1')] },
    { role: 'tool', tool_call_id: 't1', content: 'r1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: '', tool_calls: [tc('t2'), tc('t3')] },
    { role: 'tool', tool_call_id: 't2', content: 'r2' },
    { role: 'tool', tool_call_id: 't3', content: 'r3' },
  ];
  // 穷举所有前缀/后缀截断，净化后都必须自洽
  for (let i = 0; i <= full.length; i++) {
    for (let j = i; j <= full.length; j++) {
      const out = T.sanitizeMessages(full.slice(i, j));
      const ids = new Set();
      for (const m of out) if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) ids.add(c.id);
      const resIds = new Set(out.filter(m => m.role === 'tool').map(m => m.tool_call_id));
      for (const id of ids) assert.ok(resIds.has(id), `切片[${i},${j}) 调用 ${id} 缺结果`);
      for (const id of resIds) assert.ok(ids.has(id), `切片[${i},${j}) 结果 ${id} 无发起者`);
    }
  }
});

test('sanitize 容忍 null/畸形消息不崩溃', () => {
  const out = T.sanitizeMessages([null, { role: 'user', content: 'u' }, {}, { role: 'tool' }]);
  assert.deepStrictEqual(out.map(m => m.role), ['user']);
});

/* ---------- pruneReasoning：思考内容按轮次裁决 ---------- */

test('pruneReasoning 剥掉无工具轮次的思考，保留有工具轮次的', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    // 第 1 轮：纯问答，思考可剥
    { role: 'user', content: '问1' },
    { role: 'assistant', content: '答1', reasoning_content: '思考1' },
    // 第 2 轮：有工具调用，整轮思考必须保留
    { role: 'user', content: '问2' },
    { role: 'assistant', content: '', reasoning_content: '思考2a',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '结果' },
    { role: 'assistant', content: '答2', reasoning_content: '思考2b' },
    // 第 3 轮：又是纯问答
    { role: 'user', content: '问3' },
    { role: 'assistant', content: '答3', reasoning_content: '思考3' },
  ];
  const out = T.pruneReasoning(msgs);
  assert.strictEqual(out.length, msgs.length, '只动字段，不动消息条数');
  const think = out.filter(m => 'reasoning_content' in m);
  assert.deepStrictEqual(think.map(m => m.reasoning_content), ['思考2a', '思考2b'],
    '工具轮的思考全保留（含调用后的收尾消息），纯问答轮的全剥掉');
  // DeepSeek 400 的高危点：带 tool_calls 的那条必须还带着思考
  const toolAsst = out.find(m => m.tool_calls);
  assert.strictEqual(toolAsst.reasoning_content, '思考2a');
});

test('pruneReasoning 不改原消息对象（剥离走拷贝）', () => {
  const asst = { role: 'assistant', content: '答', reasoning_content: '思考' };
  const msgs = [{ role: 'user', content: '问' }, asst];
  const out = T.pruneReasoning(msgs);
  assert.ok(!('reasoning_content' in out[1]), '输出里已剥离');
  assert.strictEqual(asst.reasoning_content, '思考', '内存里的原消息不能被改——界面还要显示思考卡');
});

test('pruneReasoning 对无思考的历史原样通过', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'user', content: '问' },
    { role: 'assistant', content: '答' },
  ];
  assert.deepStrictEqual(T.pruneReasoning(msgs), msgs);
});
