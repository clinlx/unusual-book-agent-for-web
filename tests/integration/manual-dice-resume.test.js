'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Core=require('../../src/game-core'),VFS=require('../../src/vfs');
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
async function paused(){
  const tree=VFS.createTree();
  VFS.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"姓名":"测试者"}');
  VFS.writeFile(tree,'/workspace/Player-pc/背包.json','[]');
  const s=Core.createSave('manual-resume',tree);Core.beginRound(s,'检查门锁',false,'');
  const args={roller:'pc',description:'闪避',related_attr:'闪避',is_secret:false,dice_dict:{闪避:'1d100'},calculate_only:false,target_value:45,compare_mode:'le',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{}};
  await Core.run(s,async()=>({tool_calls:[call('roll_dice',args,'dice')]}),{manualDice:true,openingPreload:false});
  assert.ok(s.pendingManualDice);return s;
}
test('rollback clears the abandoned manual check before the same round number is reused',async()=>{
  const s=await paused();Core.rollback(s);
  assert.equal(s.pendingManualDice,undefined);
  assert.equal(s.events.some(e=>e.callId==='dice'),false);
  Core.beginRound(s,'重新行动',false,'');
  let requests=0;
  await assert.rejects(Core.run(s,async()=>{requests++;throw Error('transport reached');},{manualDice:false,openingPreload:false}),/transport reached/);
  assert.equal(requests,1);
});
test('resume repairs a legacy orphan pending check and executes the real unfinished batch',async()=>{
  const s=await paused(),stale=structuredClone(s.pendingManualDice);
  Core.rollback(s);Core.beginRound(s,'重新行动',false,'');s.pendingManualDice=stale;
  s.messages.push({role:'assistant',round:s.activeRound.number,tool_calls:[call('read_file',{path:'/workspace/Player-pc/基础信息.json'},'read')]});
  let requests=0;
  await assert.rejects(Core.run(s,async()=>{requests++;throw Error('transport reached');},{manualDice:false,openingPreload:false}),/transport reached/);
  assert.equal(requests,1);assert.equal(s.pendingManualDice,undefined);
  assert.equal(s.messages.filter(m=>m.tool_call_id==='read').length,1);
  assert.equal(s.messages.some(m=>m.tool_call_id==='dice'),false);
  assert.equal(s.events.some(e=>e.type==='dice'),false);
});
test('repair preserves a live manual check even after the setting has been turned off',async()=>{
  const s=await paused(),pending=structuredClone(s.pendingManualDice);
  assert.equal(Core.repairManualDiceEvents(s),false);
  await Core.run(s,async()=>{assert.fail('must wait for the existing check');},{manualDice:false,openingPreload:false});
  assert.deepEqual(s.pendingManualDice,pending);
  Core.resolveManualDice(s,[42]);assert.equal(s.pendingManualDice,undefined);
  assert.equal(s.events.filter(e=>e.type==='dice').length,1);
});
test('repair clears a resolved pending marker without rolling or appending another receipt',async()=>{
  const s=await paused(),pending=structuredClone(s.pendingManualDice);
  Core.resolveManualDice(s,[42]);s.pendingManualDice=pending;
  const before=structuredClone({messages:s.messages,events:s.events});
  assert.equal(Core.repairManualDiceEvents(s),true);assert.equal(s.pendingManualDice,undefined);
  assert.deepEqual({messages:s.messages,events:s.events},before);
});
