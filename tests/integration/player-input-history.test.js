'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Core=require('../../src/game-core');
const Inputs=require('../../src/game-input-history');
const IO=require('../../src/game-import');
test('submission feedback is scoped to the current player and collecting round',()=>{
  const s={client:true,active:{id:'save',actorId:'a'},room:{roomId:'room',roundId:'r2',epoch:0,status:'collecting'}};
  const feedback={saveId:'save',actorId:'a',roomId:'room',roundId:'r2',epoch:0,status:'pending',content:'查看窗户',privateContent:'藏钥匙'};
  s.actionFeedback=feedback;assert.equal(Inputs.submission(s).status,'pending');
  feedback.status='accepted';assert.equal(Inputs.submission(s).status,'accepted');
  for(const patch of [{roundId:'r3'},{epoch:1},{status:'executing'},{bindingVersion:1}])assert.equal(Inputs.submission({...s,room:{...s.room,...patch}}),null);
  assert.equal(Inputs.submission({...s,active:{...s.active,actorId:'b'}}),null);
  feedback.status='cancelled';s.room.submitted=true;assert.equal(Inputs.submission(s),null);
  s.actionFeedback=null;assert.equal(Inputs.submission(s).status,'accepted');
});
function save(){const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"玩家"}');VFS.writeFile(tree,'/workspace/Player-p/背包.json','[]');return Core.createSave('输入记录',tree);}
function finish(s){s.round=s.activeRound.number;s.activeRound.complete=true;s.status='waiting';}

test('draft typed during execution belongs to the next round and remains valid when the round finishes',()=>{
 const s=save();Core.beginRound(s,'本轮行动');const binding=Inputs.owner(s);
 assert.equal(binding.round,2);assert.equal(Inputs.setDraft(s,'预先写好的下一轮行动',binding),true);
 finish(s);assert.equal(Inputs.owner(s).round,2);assert.equal(s.draftRound,2);assert.equal(s.draft,'预先写好的下一轮行动');
 assert.equal(Inputs.setDraft(s,'刚结束时仍可保存的下一轮草稿',binding),true);
});

test('a new draft written after submitting while waiting for other players is carried into execution',()=>{
 const s=save();s.inputHistory=[{round:1,roundId:'r1',text:'本轮行动',status:'accepted',draftState:{draft:'本轮行动',privateDraft:''}}];
 s.draft='等待队友时写好的下一轮';s.privateDraft='下一轮的秘密';s.draftRound=1;
 Core.beginRound(s,'本轮行动',false,'',{roundId:'r1',actions:[{actorId:'p',content:'本轮行动'}]});
 assert.equal(s.draft,'等待队友时写好的下一轮');assert.equal(s.privateDraft,'下一轮的秘密');assert.equal(s.draftRound,2);
});
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
