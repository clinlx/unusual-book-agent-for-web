'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const game = require('../../src/vfs.js');
const designer = require('../../src/world-designer/vfs.js');
test('shared VFS retains page-specific readable and writable roots', () => {
  const tree = game.createTree();
  for (const root of ['workspace', '.reference', 'skills', 'tmp']) {
    game.mkdirp(tree, [root]);
    tree.children[root].children['test.md'] = { type: 'file', content: root };
  }
  assert.equal(game.readFile(tree, '/.reference/test.md').content, '.reference');
  assert.throws(() => game.writeFile(tree, '/.reference/test.md', 'bad'));
  assert.throws(() => game.readFile(tree, '/skills/test.md'));
  assert.throws(() => game.writeFile(tree, '/tmp/test.md', 'bad'));
  assert.equal(designer.readFile(tree, '/skills/test.md').content, 'skills');
  assert.throws(() => designer.writeFile(tree, '/skills/test.md', 'bad'));
  assert.throws(() => designer.readFile(tree, '/.reference/test.md'));
  designer.writeFile(tree, '/tmp/test.md', 'temporary');
  assert.equal(designer.readFile(tree, '/tmp/test.md').content, 'temporary');
});
test('both pages use one SSE/ZIP/diff/Markdown implementation and retain lease timing', () => {
  for (const name of ['sse', 'zip', 'diff', 'md'])
    assert.equal(require('../../src/' + name), require('../../src/world-designer/' + name));
  assert.equal(require('../../src/lease').EXPIRY, 8000);
  assert.equal(require('../../src/world-designer/lease').EXPIRY, 15000);
});
