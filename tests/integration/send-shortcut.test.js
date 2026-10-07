'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Shortcut = require('../../src/shared/send-shortcut');

test('both pages use and reverse the same control-enter shortcut pair', () => {
    const plain = { key: 'Enter' };
    const modified = { key: 'Enter', ctrlKey: true };
    assert.deepEqual([Shortcut.action(plain), Shortcut.action(modified)], ['newline', 'send']);
    assert.deepEqual([Shortcut.action(plain, true), Shortcut.action(modified, true)], ['send', 'newline']);
  assert.equal(Shortcut.action({ key: 'Enter', metaKey: true }, false, 'control'), 'send');
  assert.equal(Shortcut.action({ key: 'Enter', metaKey: true }, true, 'control'), 'newline');
});

test('composition and unrelated modified keys do not trigger send', () => {
  for (const reversed of [false, true]) {
    for (const event of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 },
      { key: 'Enter', altKey: true }, { key: 'Enter', shiftKey: true }, { key: 'Escape' }]) {
      assert.equal(Shortcut.action(event, reversed), null);
    }
  }
});
