'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const expected = ['game-world-builder', 'write-novel', 'desire-analysis', 'grilling'];
const fixture = Object.fromEntries([
  ['skill_enable_list.json', JSON.stringify([...expected, 'other-page'])],
  ...[...expected, 'other-page'].flatMap(name => [
    ['skills/' + name + '/SKILL.md', '---\nname: ' + name + '\ndescription: demo\n---\n# Guide'],
    ['skills/' + name + '/manifest.json', '{"files":[]}'],
  ]),
]);
function resources() {
  assert.ok(fs.existsSync(path.join(__dirname, '../../src/world-designer/resources.js')), 'page-scoped skill loader must exist');
  return require('../../src/world-designer/resources.js');
}
test('hosted skills come only from the world designer namespace and whitelist', async () => {
  const urls = [];
  const report = await resources().load({ href: 'https://example.test/books/designer.html?x=1', snapshot: fixture,
    fetchFn: async url => {
      urls.push(url);
      assert.ok(url.startsWith('https://example.test/books/world-designer/'));
      const key = url.split('/world-designer/')[1];
      return { ok: key in fixture, status: key in fixture ? 200 : 404, text: async () => fixture[key] };
    } });
  assert.equal(report.origin, 'external');
  assert.deepEqual(report.skills.map(s => s.name), expected);
  assert.ok(urls.length);
  assert.ok(urls.every(url => !url.includes('other-page')));
});
test('file and standalone pages load exactly four bundled skills without network', async () => {
  for (const args of [{ href: 'file:///tmp/designer.html' }, { href: 'https://example.test/designer.html', standalone: true }]) {
    const report = await resources().load({ ...args, snapshot: fixture, fetchFn: () => { throw Error('unexpected network'); } });
    assert.equal(report.origin, 'bundled');
    assert.deepEqual(report.skills.map(s => s.name), expected);
  }
});
test('a missing external skill falls back to the complete snapshot', async () => {
  const report = await resources().load({ href: 'https://example.test/designer.html', snapshot: fixture,
    fetchFn: async () => ({ ok: false, status: 404 }) });
  assert.equal(report.origin, 'bundled');
  assert.deepEqual(report.skills.map(s => s.name), expected);
});
test('a missing reference also falls back to the complete snapshot', async () => {
  const snapshot = { ...fixture,
    'skills/game-world-builder/manifest.json': '{"files":["reference/guide.md"]}',
    'skills/game-world-builder/reference/guide.md': 'Complete bundled guide',
  };
  const report = await resources().load({ href: 'https://example.test/designer.html', snapshot,
    fetchFn: async url => {
      const key = url.split('/world-designer/')[1];
      return { ok: key in snapshot && !key.endsWith('reference/guide.md'), status: 404, text: async () => snapshot[key] };
    } });
  assert.equal(report.origin, 'bundled');
  assert.equal(report.skills.find(skill => skill.name === 'game-world-builder').files['/skills/game-world-builder/reference/guide.md'], 'Complete bundled guide');
});
