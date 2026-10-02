'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

test('one build delivers the game and the complete offline-capable workbench', () => {
  const obsolete = path.join(root, 'dist/world-designer/skills/obsolete-skill');
  fs.mkdirSync(obsolete, { recursive: true });
  fs.writeFileSync(path.join(obsolete, 'SKILL.md'), '# Old generated resource');
  execFileSync(process.execPath, ['build.js'], { cwd: root, stdio: 'pipe' });
  assert.ok(fs.existsSync(path.join(root, 'dist/designer.html')), 'the standalone designer must be generated');
  const expectedSkills = ['write-novel', 'desire-analysis', 'grilling', 'game-world-builder'];
  for (const obsoleteName of ['world-designer', 'world-designer.html', 'world-designer.standalone.html'])
    assert.equal(fs.existsSync(path.join(root, 'dist', obsoleteName)), false, 'remove obsolete generated artifact '+obsoleteName);
  for (const name of ['index.html', 'designer.html']) {
    const html = fs.readFileSync(path.join(root, 'dist', name), 'utf8');
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
    assert.doesNotMatch(html, /\/\*__(?:STYLES|SCRIPTS)__\*\//);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
    assert.ok(scripts.length);
    for (const [, source] of scripts) assert.doesNotThrow(() => new vm.Script(source), name);
    if (name === 'designer.html') {
      assert.match(html, /<title>世界设计者<\/title>/);
      const skills = JSON.parse(html.match(/const BUNDLED_SKILLS = (.*);/)[1]);
      assert.deepEqual(JSON.parse(skills['skill_enable_list.json']), expectedSkills);
      assert.deepEqual([...new Set(Object.keys(skills).filter(key => key.startsWith('skills/')).map(key => key.split('/')[1]))].sort(), [...expectedSkills].sort());
      assert.ok(skills['skills/write-novel/SKILL.md']);
      assert.ok(skills['skills/write-novel/references/standard-workflow.md']);
      assert.match(html, /const WORLD_DESIGNER_STANDALONE = true/);
      assert.equal(skills['skills/game-world-builder/SKILL.md'], fs.readFileSync(path.join(root, 'skills/game-world-builder/SKILL.md'), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
      assert.ok(skills['skills/game-world-builder/reference/WorldDataContract.md']);
      assert.ok(skills['skills/game-world-builder/scripts/validate_game_structure.js']);
    } else {
      assert.doesNotMatch(html, /BUNDLED_SKILLS|WORLD_DESIGNER_STANDALONE/);
    }
  }
});
