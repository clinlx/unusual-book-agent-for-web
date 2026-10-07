'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Prompts = require('../../src/game-prompts');
const Tools = require('../../src/game-tools');

function checkReferences(sources) {
  const definitions = new Map();
  const references = [];
  for (const [file, text] of Object.entries(sources)) {
    let fence = null;
    text.split(/\r?\n/).forEach((line, index) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1][0];
        else if (fence === marker[1][0]) fence = null;
      }
      const definition = !fence && line.match(/^(?:#{1,6}\s+|-\s+\*\*|\*\*)(§(?:0|[A-Z]+[1-9]\d*))(?:\s|\*\*)/);
      if (definition) {
        assert.ok(!definitions.has(definition[1]), `duplicate ${definition[1]}: ${file}:${index + 1}`);
        definitions.set(definition[1], file);
      }
      for (const match of line.matchAll(/§(?:0|[A-Z]+[1-9]\d*)/g)) {
        references.push({ id: match[0], file, line: index + 1 });
      }
    });
  }
  for (const { id, file, line } of references) {
    assert.ok(definitions.has(id), `unresolved ${id}: ${file}:${line}`);
  }
  return definitions;
}

test('prompt reference audit rejects dangling IDs and duplicate definitions', () => {
  assert.throws(() => checkReferences({ a: '# §T1 Draft\nSee §P1' }), /unresolved §P1/);
  assert.throws(() => checkReferences({ a: '# §T1 Draft', b: '## §T1 Other' }), /duplicate §T1/);
  assert.throws(() => checkReferences({ a: '```\n# §T1 only an example\n```\nSee §T1' }), /unresolved §T1/);
  assert.equal(checkReferences({ a: '# §T1 Draft\nSee §P1', b: '## §P1 Agency\nSee §T1' }).size, 2);
});

function markdownSources(root) {
  const files = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(files, markdownSources(file));
    else if (file.endsWith('.md')) files[file] = fs.readFileSync(file, 'utf8');
  }
  return files;
}

test('designer skills resolve IDs locally and cannot reference game prompt resources', () => {
  for (const relative of ['skills/game-world-builder', 'assets/world-designer/skills/write-novel']) {
    const sources = markdownSources(path.join(__dirname, '../..', relative));
    assert.ok(checkReferences(sources).size > 0, relative);
    for (const [file, text] of Object.entries(sources)) {
      assert.doesNotMatch(text, /\/\.reference\/|assets\/prompts\/|system\/(?:host|round|runtime)\.md|主持人侧/, file);
    }
  }
  // 相同编号可在两个独立上下文中各有含义，不能拿另一端的定义补齐缺项。
  assert.equal(checkReferences({ designer: '# §T1 设计器自己的规则' }).size, 1);
  assert.equal(checkReferences({ game: '# §T1 游戏自己的规则' }).size, 1);
  assert.throws(() => checkReferences({ designer: '见 §T1' }), /unresolved §T1/);
});

test('game prompts reference only game resources and cannot read designer skill files', () => {
  const sources = Object.fromEntries(Prompts.list().map(({ id }) => [id,
    fs.readFileSync(path.join(__dirname, '../../assets/prompts', id), 'utf8')]));
  for (const [id, text] of Object.entries(sources)) {
    assert.doesNotMatch(text, /\/skills\/|world-designer|game-world-builder|write-novel|OpeningCraft\.md|WorldDataContract\.md/, id);
  }
  const prompts = Prompts.create(sources);
  for (const file of ['/skills/game-world-builder/SKILL.md', '/skills/write-novel/references/prose-and-formatting.md']) {
    assert.equal(prompts.file(file), undefined, file);
  }
});

test('all registered game prompt IDs resolve to unique definitions and discoverable documents', () => {
  const sources = Object.fromEntries(Prompts.list().map(({ id }) => [id,
    fs.readFileSync(path.join(__dirname, '../../assets/prompts', id), 'utf8')]));
  const definitions = checkReferences(sources);
  assert.ok(definitions.size > 0, 'game prompts define numbered rules');
  const prompts = Prompts.create(sources);
  const system = prompts.buildSystem();
  for (const [id, file] of definitions) {
    assert.ok(system.includes(id), `${id} is discoverable from the system index`);
    if (file.startsWith('reference/')) {
      const resource = '/.reference/' + file.slice('reference/'.length);
      assert.ok(system.includes(resource), `${file} has a system routing entry`);
      assert.equal(prompts.file(resource), sources[file], `${file} is readable at runtime`);
    } else {
      assert.ok(file.startsWith('system/'), `${id} is defined in a system or reference document`);
    }
  }
  for (const [file, text] of Object.entries(sources)) {
    if (!file.endsWith('.md')) continue;
    assert.equal([...text.matchAll(/^\s*```/gm)].length % 2, 0, `${file} has an unclosed code fence`);
  }
  for (const file of ['start_game', 'next_round', 'after_story', 'resume', 'need_trigger', 'need_end']) {
    assert.match(sources[`flow/${file}.md`], /§[A-Z]+[1-9]\d*/, `${file} reanchors the relevant rules`);
  }
});

test('current workflow keeps disclosure, equipment and two-pass review separate from host rules', () => {
  const read = id => fs.readFileSync(path.join(__dirname, '../../assets/prompts', id), 'utf8');
  const host = read('system/host.md'), runtime = read('system/runtime.md'), round = read('system/round.md');
  assert.match(host, /^\*\*§T8 露骨写作/m);
  assert.match(runtime, /^### §T12 发布前的两遍修订/m);
  assert.match(round, /§T12 第一遍修订[\s\S]*§T12 第二遍/);
  assert.match(host, /^\*\*§N6 剧本强制力/m);
  assert.match(runtime, /^#### §N11 NPC 发言的四道检查/m);
  assert.match(round, /拟披露的信息先过 §N11/);
  assert.match(host, /^\*\*§C3 何时检定/m);
  assert.match(round, /^### §C6 装备与修正/m);
});

test('fixed tool descriptions remain self-contained when users replace every prompt', () => {
  const sources = Object.fromEntries(Prompts.list().map(({ id }) => [id,
    fs.readFileSync(path.join(__dirname, '../../assets/prompts', id), 'utf8')]));
  const prompts = Prompts.create(sources);
  const overrides = Object.fromEntries(Prompts.list().filter(({ id }) => id !== 'flow/tools.json')
    .map(({ id }) => [id, '自定义世界规则：使用自己的流程与文风。']));
  const defaults = Tools.build(prompts);
  const custom = Tools.build(prompts, overrides);
  assert.deepEqual(custom, defaults);
  for (const tool of custom) {
    assert.ok(tool.function.description.trim(), tool.function.name);
    assert.doesNotMatch(tool.function.description, /§|\/\.reference\/|\/skills\//,
      `${tool.function.name} must not depend on editable prompt rules`);
  }
});
