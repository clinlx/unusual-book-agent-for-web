'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Compress = require('../../src/world-designer/compress.js');
const C = require('../../src/world-designer/00-config.js');

function mkTurn(i, big) {
  return [
    { role: 'user', content: '问题' + i + (big ? 'x'.repeat(300) : '') },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, function: { name: 'write_file', arguments: JSON.stringify({ path: '/workspace/f' + i + '.md' }) } }] },
    { role: 'tool', tool_call_id: 'c' + i, content: '写入成功' },
    { role: 'assistant', content: '回答' + i },
  ];
}

test('renderTranscript 保持问答与工具在同一文本流、超长结果头尾预览+省略提示', () => {
  const msgs = [
    { role: 'user', content: '写文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"/workspace/a.md"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'z'.repeat(5000) },
    { role: 'assistant', content: '完成，代码块：```js\nconst x = "{{notavar}}";\n```' },
  ];
  const t = Compress.renderTranscript(msgs, C.COMPRESS_CONFIG);
  assert.match(t, /【用户】写文件/);
  assert.match(t, /【工具】write_file \/workspace\/a\.md/);
  assert.match(t, /【结果】z+\n…\(中间省略 \d+ 字\)…\nz+/, '超长结果保留头尾、中间省略');
  assert.match(t, /\{\{notavar\}\}/, '代码块内的花括号原样保留');
});

test('renderTranscript 短结果不截断（未超过阈值原样保留）', () => {
  const msgs = [{ role: 'tool', tool_call_id: 'c1', content: '写入成功' }];
  const t = Compress.renderTranscript(msgs, C.COMPRESS_CONFIG);
  assert.strictEqual(t, '【结果】写入成功');
});

test('renderTranscript 暴露 write_file 的真实内容，不只是文件名', () => {
  const msgs = [{ role: 'assistant', content: '', tool_calls: [
    { id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: '/workspace/a.js', content: 'const answer = 42;' }) } },
  ] }];
  const t = Compress.renderTranscript(msgs, C.COMPRESS_CONFIG);
  assert.match(t, /【工具】write_file \/workspace\/a\.js/);
  assert.match(t, /内容: const answer = 42;/);
});

test('renderTranscript 暴露 apply_patch 的新旧内容', () => {
  const msgs = [{ role: 'assistant', content: '', tool_calls: [
    { id: 'c1', function: { name: 'apply_patch', arguments: JSON.stringify({ path: '/workspace/a.js', old_str: 'const x = 1;', new_str: 'const x = 2;' }) } },
  ] }];
  const t = Compress.renderTranscript(msgs, C.COMPRESS_CONFIG);
  assert.match(t, /【工具】apply_patch \/workspace\/a\.js/);
  assert.match(t, /- const x = 1;/);
  assert.match(t, /\+ const x = 2;/);
});

test('renderTranscript 头尾预览长度按配置生效', () => {
  const cfg = { transcriptPreviewChars: 20, transcriptHeadChars: 5, transcriptTailChars: 5 };
  const msgs = [{ role: 'tool', tool_call_id: 'c1', content: 'a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(10) }];
  const t = Compress.renderTranscript(msgs, cfg);
  assert.match(t, /^【结果】aaaaa\n…\(中间省略 20 字\)…\nccccc$/);
});

test('planCompression 保留最近轮原文，其余按预算切段且不拆轮', () => {
  const msgs = [];
  for (let i = 0; i < 6; i++) msgs.push(...mkTurn(i, true));
  const plan = Compress.planCompression(msgs, { keepRecentTurns: 2, inputBudgetTokens: 200 });
  // 保留最近 2 轮 = 8 条
  assert.strictEqual(plan.keepRecent.length, 8);
  assert.strictEqual(plan.keepRecent[0].content.startsWith('问题4'), true);
  assert.ok(plan.chunks.length >= 2, '低预算下应切成多段，got ' + plan.chunks.length);
  for (const c of plan.chunks) {
    assert.strictEqual(c[0].role, 'user', '段首必须是 user');
    // 段内每个 tool_call 都有对应结果
    for (const m of c) if (m.role === 'assistant' && m.tool_calls)
      for (const tc of m.tool_calls)
        assert.ok(c.some(x => x.role === 'tool' && x.tool_call_id === tc.id), '工具调用与结果同段');
  }
});

test('run 接力压缩：多段时上一段摘要注入下一段（双请求）', async () => {
  const msgs = [];
  for (let i = 0; i < 6; i++) msgs.push(...mkTurn(i, true));
  const calls = [];
  const transport = async (reqMsgs) => {
    calls.push(reqMsgs);
    return { content: '摘要#' + calls.length };
  };
  const out = await Compress.run(msgs, { keepRecentTurns: 2, inputBudgetTokens: 200, fileTree: 'a.md' }, transport);
  assert.ok(calls.length >= 2, '应发起至少两次请求');
  // 第二次请求应包含第一次的摘要，并标明它是已压缩内容
  assert.match(calls[1][1].content, /已压缩摘要/);
  assert.match(calls[1][1].content, /摘要#1/);
  assert.match(calls[1][1].content, /本段原始对话/);
  // 第二次起使用接力系统提示：说明分段进度并要求压缩心得
  assert.match(calls[1][0].content, /分段接力压缩/);
  assert.match(calls[1][0].content, /压缩心得/);
  assert.match(calls[1][0].content, /第 2 段/);
  // 首段用普通模板，不谈接力
  assert.ok(!calls[0][0].content.includes('压缩心得'), '首段不应要求压缩心得');
  // 模板变量注入
  assert.match(calls[0][0].content, /a\.md/);
  assert.match(calls[0][0].content, new RegExp(String(C.COMPRESS_CONFIG.maxWords)));
  assert.ok(!calls[0][0].content.includes('{{'), '模板变量应全部替换');
  assert.ok(!calls[1][0].content.includes('{{'), '接力模板变量也应全部替换');
  assert.strictEqual(out.mark.role, 'compressed');
  assert.strictEqual(out.mark.summary, '摘要#' + calls.length);
  assert.strictEqual(out.mark.count, 16); // 4 轮 × 4 条
  assert.strictEqual(out.keepRecent.length, 8);
});

test('keepRecentTurns 默认保留最近 20 轮', () => {
  assert.strictEqual(C.COMPRESS_CONFIG.keepRecentTurns, 20);
  const msgs = [];
  for (let i = 0; i < 25; i++) msgs.push(...mkTurn(i, false));
  const plan = Compress.planCompression(msgs, {});   // 用默认 keepRecentTurns
  assert.strictEqual(plan.keepRecent.length, 20 * 4, '最近 20 轮 × 每轮 4 条不参与压缩');
  assert.strictEqual(plan.compressCount, 5 * 4, '其余 5 轮参与压缩');
  assert.strictEqual(plan.keepRecent[0].content, '问题5');
});

test('run 消息太少（全在保留窗口内）返回 null', async () => {
  const msgs = [...mkTurn(0, false)];
  const out = await Compress.run(msgs, { keepRecentTurns: 2 }, async () => ({ content: 'x' }));
  assert.strictEqual(out, null);
});

test('renderTemplate 值含 $ 与代码块时不被展开', () => {
  const s = C.renderTemplate('A{{v}}B', { v: 'money $& ```code```' });
  assert.strictEqual(s, 'Amoney $& ```code```B');
});
