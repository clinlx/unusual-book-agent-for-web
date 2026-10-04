'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/world-designer/00-config.js');

test('TOOL_DEFS 含全部工具', () => {
  const names = C.TOOL_DEFS.map(t => t.function.name).sort();
  assert.deepStrictEqual(names, [
    'apply_patch', 'ask_user', 'copy', 'delete', 'goal', 'list_dir', 'move',
    'parse_document', 'read_file', 'run_skill', 'search', 'view_image', 'write_file',
  ]);
  for (const t of C.TOOL_DEFS) {
    assert.strictEqual(t.type, 'function');
    assert.ok(t.function.description.length > 10);
    assert.strictEqual(t.function.parameters.type, 'object');
  }
});

test('GOAL_TEMPLATE 渲染出目标正文与三条结束指引', () => {
  const out = C.renderTemplate(C.GOAL_TEMPLATE, { goal: '写完第三章', notice: '' });
  assert.ok(!out.includes('{{'), '模板变量应全部替换');
  assert.match(out, /<GOAL>\n写完第三章\n<\/GOAL>/);
  assert.match(out, /goal change/);
  assert.match(out, /goal end break/);
  assert.match(out, /goal end finished/);
});

test('GOAL_TEMPLATE 目标变更时前置一次性提醒', () => {
  const out = C.renderTemplate(C.GOAL_TEMPLATE,
    { goal: '改写第三章', notice: C.GOAL_CHANGED_NOTICE + '\n' });
  assert.ok(out.startsWith(C.GOAL_CHANGED_NOTICE), '提醒在最前');
  assert.match(out, /改写第三章/);
});

test('buildSystemPrompt 注入 Skill 清单（含根路径），但不注入附件与文件树', () => {
  const skills = [{ name: 's1', description: 'd1', files: { '/skills/s1/a.md': '' } }];
  const p = C.buildSystemPrompt(skills);
  assert.match(p, /s1/);
  assert.match(p, /d1/);
  assert.match(p, /根目录: \/skills\/s1/, 'Skill 根路径必须注入');
  // 附件清单在 run_skill 返回里给，背景注入不需要——文件增删会让 system 前缀失效
  assert.ok(!/附件: a\.md/.test(p), '附件列表不进 system');
  assert.ok(!p.includes('{{'), '占位符应全部替换');
  // 文件树易变，注入会让提示缓存每轮失效，故不进 system
  assert.ok(!/文件树/.test(p), '不应包含文件树内容');
});

test('buildSystemPrompt 无附件的 Skill 同样只给根目录', () => {
  const p = C.buildSystemPrompt([{ name: 'solo', description: '无附件技能', files: {} }]);
  assert.match(p, /根目录: \/skills\/solo/);
});

test('buildSystemPrompt 三段拼接：人设 + 工具说明 + Skill 清单', () => {
  const p = C.buildSystemPrompt([]);
  // 断言结构而非具体措辞：人设段照搬 AGENT_CONFIG.systemPrompt，文案改动不该弄坏测试
  assert.ok(p.startsWith(C.AGENT_CONFIG.systemPrompt), '以默认人设段开头');
  assert.match(p, /## 工具要点/, '含自动追加的工具说明');
  assert.match(p, /## 可用 Skill/, '含 Skill 清单段');
  assert.ok(p.indexOf('## 工具要点') < p.indexOf('## 可用 Skill'), '工具说明在 Skill 清单之前');
});

test('buildSystemPrompt 自定义人设只替换人设段，工具说明照旧追加', () => {
  const p = C.buildSystemPrompt([], '你是一只会写代码的猫。');
  assert.match(p, /会写代码的猫/);
  assert.ok(!p.includes(C.AGENT_CONFIG.systemPrompt), '默认人设应被替换掉');
  assert.match(p, /## 工具要点/, '工具说明不受自定义影响');
  assert.match(p, /apply_patch/, '工具细节仍在');
});

test('buildSystemPrompt 自定义人设为空白时回落到默认', () => {
  assert.ok(C.buildSystemPrompt([], '   ').startsWith(C.AGENT_CONFIG.systemPrompt));
  assert.ok(C.buildSystemPrompt([], '').startsWith(C.AGENT_CONFIG.systemPrompt));
});

test('LONG_INPUT_TEMPLATE 渲染出头尾预览与文件引用', () => {
  const body = 'H'.repeat(512) + 'M'.repeat(9000) + 'T'.repeat(512);
  const out = C.renderTemplate(C.LONG_INPUT_TEMPLATE, {
    path: '/tmp/abc.txt', total: body.length,
    headChars: 512, tailChars: 512,
    head: body.slice(0, 512), tail: body.slice(-512),
  });
  assert.ok(!out.includes('{{'), '模板变量应全部替换');
  assert.match(out, /<user_input_truncated path="\/tmp\/abc\.txt"/);
  assert.match(out, /中间省略/);
  assert.match(out, /read_file/);
  // 中段内容不应出现
  assert.ok(!out.includes('M'.repeat(50)), '中间部分必须被省略');
  assert.ok(out.includes('H'.repeat(512)) && out.includes('T'.repeat(512)));
  assert.ok(out.length < body.length, '注入内容显著短于原文');
});

test('DEFAULT_SETTINGS 默认值符合规格', () => {
  assert.strictEqual(C.DEFAULT_SETTINGS.contextOverflow, 'disabled');
  assert.strictEqual(C.DEFAULT_SETTINGS.maxContextK, 128);
  assert.strictEqual(C.DEFAULT_SETTINGS.stream, true);
});

test('validateCustomContextK 校验自定义上限', () => {
  assert.strictEqual(C.validateCustomContextK('256'), 256);
  assert.strictEqual(C.validateCustomContextK('0'), null);
  assert.strictEqual(C.validateCustomContextK('abc'), null);
  assert.strictEqual(C.validateCustomContextK('10001'), null);
});

test('GOAL_TEMPLATE 说明目标以设立时刻为基准，不是逐轮累加', () => {
  const out = C.renderTemplate(C.GOAL_TEMPLATE, { goal: '写三千字', notice: '' });
  assert.match(out, /最终状态/, '点明是状态而非增量');
  assert.match(out, /不是每轮都要再做一份的增量任务/);
  assert.match(out, /已经满足就结束/, '给出停止条件');
});

test('GOAL_SET_TEMPLATE 区分设立与修改', () => {
  const set = C.renderTemplate(C.GOAL_SET_TEMPLATE,
    { goal: '写完三章', action: '', actionText: '设立' });
  assert.ok(!set.includes('{{'), '模板变量应全部替换');
  assert.match(set, /<GOAL>\n写完三章\n<\/GOAL>/);
  assert.match(set, /用户设立了目标/);
  assert.match(set, /goal end finished/);

  const chg = C.renderTemplate(C.GOAL_SET_TEMPLATE,
    { goal: '改写第三章', action: ' action="change"', actionText: '修改' });
  assert.match(chg, /<GOAL action="change">/);
  assert.match(chg, /用户修改了目标/);
});

test('LONG_INPUT_TEMPLATE 标出中间省略了多少字', () => {
  const out = C.renderTemplate(C.LONG_INPUT_TEMPLATE, {
    path: '/tmp/a.txt', total: 20000, headChars: 512, tailChars: 512,
    midChars: 20000 - 512 - 512, head: 'H', tail: 'T',
  });
  assert.ok(!out.includes('{{'), '模板变量应全部替换');
  assert.match(out, /中间省略 18976 字/, '省略量要给具体数字，不能只说「省略」');
});
