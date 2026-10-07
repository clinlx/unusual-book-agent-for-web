'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Prompts = require('../../src/game-prompts');
const Tools = require('../../src/game-tools');
const Transport = require('../../src/game-transport');

test('tool building still accepts a description-only prompt provider', () => {
  const tools = Tools.build({ toolDescription: name => name });
  assert.equal(tools.find(tool => tool.function.name === 'append_story').function.description, 'append_story');
  assert.deepEqual(tools.find(tool => tool.function.name === 'append_story').function.parameters.required,
    ['content', 'one_line_summary_of_content']);
});

test('parameter prompts reach the HTTP request without altering tool contracts', async () => {
  const base = { append_story: '发布正文', parameter_descriptions: {
    append_story: { content: '连贯的场景终稿', one_line_summary_of_content: '已发生事件摘要' },
    trigger_next_round: { phase_plan: '本轮恢复结果' },
    unknown_tool: { invented_argument: '忽略不存在的工具参数' },
  } };
  const prompts = Prompts.create({ 'flow/tools.json': JSON.stringify(base) });
  const described = Tools.build(prompts);
  const plain = Tools.build(Prompts.create({ 'flow/tools.json': JSON.stringify({ append_story: base.append_story }) }));
  const strip = value => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key, field]) => key !== 'description' || typeof field !== 'string')
      .map(([key, field]) => [key, strip(field)])) : value;
  assert.deepEqual(strip(described), strip(plain), 'descriptions cannot change names, types, enums or required fields');
  let sent;
  const run = Transport.create({ baseUrl: 'https://example.test/v1', model: 'test', stream: false, reasoningEffort: 'none' }, described, {
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
    },
  });
  await run([{ role: 'user', content: '本轮输入' }]);
  const story = sent.tools.find(tool => tool.function.name === 'append_story');
  assert.equal(story.function.parameters.properties.content.description, base.parameter_descriptions.append_story.content);
  assert.equal(sent.tools.find(tool => tool.function.name === 'trigger_next_round')
    .function.parameters.properties.phase_plan.description, base.parameter_descriptions.trigger_next_round.phase_plan);
});

test('partial parameter prompt overrides retain defaults and do not mutate shared string schemas', () => {
  const prompts = Prompts.create({ 'flow/tools.json': JSON.stringify({ parameter_descriptions: {
    append_story: { content: '小说正文', one_line_summary_of_content: '事件摘要' },
    write_file: { content: '世界文件内容' },
  } }) });
  const overrides = { 'tools.json': JSON.stringify({ parameter_descriptions: { append_story: { content: '自定义正文说明' } } }) };
  const changed = Tools.build(prompts, overrides);
  const story = changed.find(tool => tool.function.name === 'append_story').function.parameters.properties;
  assert.equal(story.content.description, '自定义正文说明');
  assert.equal(story.one_line_summary_of_content.description, '事件摘要');
  assert.equal(changed.find(tool => tool.function.name === 'write_file').function.parameters.properties.content.description, '世界文件内容');
  assert.equal(Tools.build(prompts).find(tool => tool.function.name === 'append_story')
    .function.parameters.properties.content.description, '小说正文');
});

test('bundled parameter descriptions target existing arguments and remain self-contained', () => {
  const sources = Object.fromEntries(Prompts.list().map(({ id }) => [id,
    fs.readFileSync(path.join(__dirname, '../../assets/prompts', id), 'utf8')]));
  const prompts = Prompts.create(sources), tools = Tools.build(prompts);
  const metadata = JSON.parse(sources['flow/tools.json']).parameter_descriptions;
  assert.ok(metadata, 'parameter prompts are part of the bundled prompt source');
  assert.equal(prompts.toolDescription('parameter_descriptions'), '', 'metadata is not a tool description');
  for (const [name, fields] of Object.entries(metadata)) {
    const tool = tools.find(tool => tool.function.name === name);
    assert.ok(tool, name);
    for (const [field, text] of Object.entries(fields)) {
      assert.ok(Object.hasOwn(tool.function.parameters.properties, field), `${name}.${field}`);
      assert.equal(tool.function.parameters.properties[field].description, text);
      assert.ok(text.trim());
      assert.doesNotMatch(text, /§|\/\.reference\/|\/skills\//, `${name}.${field}`);
    }
  }
});
