'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Core=require('../../src/game-core');
const Inputs=require('../../src/game-input-history');
const IO=require('../../src/game-import');
function save(){const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"玩家"}');VFS.writeFile(tree,'/workspace/Player-p/背包.json','[]');return Core.createSave('输入记录',tree);}
function finish(s){s.round=s.activeRound.number;s.activeRound.complete=true;s.status='waiting';}
test('last ten player rounds remain accessible after consecutive rollbacks with the correct restored input',()=>{
  const s=save();for(let i=1;i<=12;i++){Core.beginRound(s,'行动'+i);finish(s);}
  assert.deepEqual(s.inputHistory.map(r=>r.round),[3,4,5,6,7,8,9,10,11,12]);
  assert.ok(s.inputHistory.every(r=>r.roundId&&r.text==='行动'+r.round));
  Core.rollback(s);assert.equal(s.draft,'行动12');assert.equal(s.draftRound,12);
  Core.rollback(s);assert.equal(s.draft,'行动11');assert.equal(s.draftRound,11);
  assert.equal(s.inputHistory.length,10);assert.equal(s.inputHistory.find(r=>r.round===12).rolledBack,true);
  Core.beginRound(s,'改写行动11');finish(s);
  assert.equal(s.inputHistory.filter(r=>r.round===11).length,1);Core.rollback(s);assert.equal(s.draft,'改写行动11');
});
test('skipping a round does not restore a stale draft belonging to another round',()=>{
  const s=save();s.draft='第三轮内容';s.draftRound=3;Core.beginRound(s,'',false,'',{skip:true});finish(s);Core.rollback(s);
  assert.equal(s.draft,'');assert.equal(s.draftRound,1);assert.equal(s.inputHistory.length,0);
});
test('a nonempty player message sent while starting is recorded and restored by its round',()=>{
  const s=save();Core.beginRound(s,'开局时提交的人物说明',true);finish(s);
  assert.equal(s.inputHistory[0].text,'开局时提交的人物说明');assert.equal(s.inputHistory[0].round,1);
  Core.rollback(s);assert.equal(s.draft,'开局时提交的人物说明');
});
test('late draft saves cannot overwrite a different save or a round changed by rollback',()=>{
  const s=save(),owner=Inputs.owner(s);assert.equal(Inputs.setDraft(s,'原始草稿',owner),true);
  Core.beginRound(s,'行动');finish(s);Core.rollback(s);
  assert.equal(Inputs.setDraft(s,'过期回调',owner),false);assert.equal(s.draft,'行动');
  assert.equal(Inputs.setDraft(s,'其他存档',{...Inputs.owner(s),saveId:'other'}),false);
  assert.equal(Inputs.setDraft(s,'修改行动',Inputs.owner(s)),true);assert.equal(s.draft,'修改行动');
});
test('input history and draft binding survive ZIP export/import',async()=>{
  const s=save();Core.beginRound(s,'查看窗边');finish(s);Core.rollback(s);
  const blob=IO.exportSave(s),out=await IO.importSave({name:'输入.zip',arrayBuffer:()=>blob.arrayBuffer()});
  assert.equal(out.inputHistory[0].text,'查看窗边');assert.equal(out.inputHistory[0].round,1);assert.equal(out.draftRound,1);
});
