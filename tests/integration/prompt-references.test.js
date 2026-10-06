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
      const definition = !fence && line.match(/^#{1,6}\s+(§[A-Z]+[1-9]\d*)\s/);
      if (definition) {
        assert.ok(!definitions.has(definition[1]), `duplicate ${definition[1]}: ${file}:${index + 1}`);
        definitions.set(definition[1], file);
      }
      for (const match of line.matchAll(/§[A-Z]+[1-9]\d*/g)) {
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
  for (const name of ['trigger_next_round', 'append_story', 'end_the_round', 'roll_dice', 'write_file', 'apply_patch']) {
    const tool = Tools.build(prompts).find(tool => tool.function.name === name);
    assert.match(tool.function.description, /§[A-Z]+[1-9]\d*/, `${name} exposes rule references to the model`);
  }
  for (const file of ['start_game', 'next_round', 'after_story', 'resume', 'need_trigger', 'need_end']) {
    assert.match(sources[`flow/${file}.md`], /§[A-Z]+[1-9]\d*/, `${file} reanchors the relevant rules`);
  }
});
