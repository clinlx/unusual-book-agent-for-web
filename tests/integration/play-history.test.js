'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasPlayHistory } = require('../../src/game-presentation');
test('new worlds, empty model replies and preset notes do not enable gameplay export', () => {
  assert.equal(hasPlayHistory(null), false);
  assert.equal(hasPlayHistory({ round: 0, events: [] }), false);
  assert.equal(hasPlayHistory({ round: 0, events: [{ type: 'assistant', content: '尚未开始' }, { type: 'note', content: '导入提示' }, { type: 'story', content: '  ' }] }), false);
});
test('real gameplay enables export, including unfinished and imported games', () => {
  for (const event of [{ type: 'story', content: '第一段故事' }, { type: 'player', content: '查看门口' }, { type: 'dice', data: {} }, { type: 'round_end' }])
    assert.equal(hasPlayHistory({ round: 0, events: [event] }), true);
  assert.equal(hasPlayHistory({ round: 1, events: [] }), true);
});
test('rolling back to the untouched world disables gameplay export again', () => {
  const save = { round: 1, events: [{ type: 'story', content: '第一段故事' }] };
  assert.equal(hasPlayHistory(save), true);
  save.round = 0; save.events = [];
  assert.equal(hasPlayHistory(save), false);
});
