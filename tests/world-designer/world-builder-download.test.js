'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Resources=require('../../src/world-designer/resources');
test('world builder download contains its original SKILL.md and every bundled attachment only',()=>{
  const snapshot={'skills/game-world-builder/SKILL.md':fs.readFileSync('skills/game-world-builder/SKILL.md','utf8'),
    'skills/game-world-builder/reference/guide.md':'指南','skills/game-world-builder/scripts/validate.js':'脚本',
    'skills/write-novel/SKILL.md':'不要下载','skills/game-world-builder/../bad.txt':'越界'};
  const entries=Resources.worldBuilderDownload(snapshot);
  assert.deepEqual(entries.map(e=>e.name),['game-world-builder/SKILL.md','game-world-builder/reference/guide.md','game-world-builder/scripts/validate.js']);
  assert.equal(entries[0].text,snapshot['skills/game-world-builder/SKILL.md']);
  assert.throws(()=>Resources.worldBuilderDownload({}),/尚未加载/);
});
