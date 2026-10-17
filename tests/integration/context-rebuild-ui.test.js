'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function ui(){
  const ctx=vm.createContext({FrontendConfig:require('../../src/frontend-config'),});
  vm.runInContext(fs.readFileSync('src/game-ui.js','utf8')+'\nthis.api=GameUI;',ctx);
  return ctx.api;
}
const info={name:'测试存档',toolCalls:12,requests:3,snapshots:2,unfinished:true};
test('rebuild button is host DEBUG only, and disables during active work',()=>{
  const api=ui(),state={active:{},mode:'debug'};
  assert.match(api.contextRebuildButtonHTML(state),/data-action="rebuild-context".*重建上下文/);
  for(const variant of [{client:true},{mode:'play'},{active:null}])assert.equal(api.contextRebuildButtonHTML({...state,...variant}),'');
  for(const key of ['running','rebuilding','switching'])assert.match(api.contextRebuildButtonHTML({...state,[key]:true}),/disabled/);
});
test('cancelling the first warning never reaches destructive confirmation',async()=>{
  let calls=0;
  assert.equal(await ui().confirmContextRebuild(info,async(message,options)=>{
    calls++;assert.match(message,/12 次工具调用/);assert.match(message,/NEXT_TURN_CACHE/);
    assert.match(message,/先回退，再重建/);assert.match(message,/未执行的旧调用将放弃/);
    assert.ok(options.choices.some(c=>c.value==='cancel'));return 'cancel';
  }),false);
  assert.equal(calls,1);
});
test('destructive action requires both confirmations and warns about losing rollback points',async()=>{
  let calls=0;
  const result=await ui().confirmContextRebuild(info,async(message,options)=>{
    if(!calls++){assert.match(options.title,/清理范围/);return 'continue';}
    assert.equal(options.danger,true);assert.equal(options.confirmLabel,'确认重建上下文');
    assert.match(message,/全部旧回退点/);assert.match(message,/无法通过回退恢复/);return true;
  });
  assert.equal(result,true);assert.equal(calls,2);
});
test('cancelling the final confirmation keeps history',async()=>{
  let calls=0;
  assert.equal(await ui().confirmContextRebuild(info,async()=>++calls===1?'continue':false),false);
  assert.equal(calls,2);
});
test('backup returns to the warning and does not authorize rebuilding',async()=>{
  const answers=['backup','continue',false];let backups=0;
  assert.equal(await ui().confirmContextRebuild(info,async()=>answers.shift(),async()=>{backups++;}),false);
  assert.equal(backups,1);assert.equal(answers.length,0);
});


test('rebuilt public and private dice render the same values and outcomes as before, while secret dice remain hidden',()=>{
  const Core=require('../../src/game-core'),VFS=require('../../src/vfs');
  const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"林"}');
  VFS.writeFile(tree,'/workspace/Player-p/背包.json','[]');
  const s=Core.createSave('骰子展示',tree);Core.beginRound(s,'',true,'');
  const args={roller:'林',description:'检查包裹',related_attr:'侦查',dice_dict:{侦查:'1d20'},calculate_only:false,
    target_value:12,compare_mode:'ge',dice_combine_mode:'sum',left_modifiers:{经验:2},right_modifiers:{视线受阻:1},
    is_secret:false,critical_success_range:null,critical_failure_range:null};
  assert.equal(Core.execute(s,'roll_dice',args,'roll-public',{fixedDiceRolls:[10]}).ok,true);
  assert.equal(Core.execute(s,'roll_dice',{...args,is_private:true,target_player:'p'},'roll-private',{fixedDiceRolls:[14]}).ok,true);
  assert.equal(Core.execute(s,'roll_dice',{...args,is_secret:true},'roll-secret',{fixedDiceRolls:[7]}).ok,true);
  const api=ui(),before=Core.visibleEvents(s,'play').filter(e=>e.type==='dice').map(e=>api.eventHTML(e,'play'));
  Core.rebuildContext(s);
  const after=Core.visibleEvents(s,'play').filter(e=>e.type==='dice').map(e=>api.eventHTML(e,'play'));
  assert.deepEqual(after,before);
  assert.match(after[0],/>10</);assert.match(after[0],/12/);assert.match(after[0],/13/);assert.match(after[0],/不通过/);
  assert.match(after[1],/私密/);assert.match(after[1],/通过/);
  assert.match(after[2],/进行了一次暗骰/);assert.doesNotMatch(after[2],/检查包裹|侦查|>7</);
});

test('composer temporarily locks during rebuild without changing ordinary draft behavior',()=>{
 assert.match(ui().composerHTML({active:{},rebuilding:true}),/正在重建上下文/);
 assert.doesNotMatch(ui().composerHTML({active:{},rebuilding:true}),/<textarea|type="submit"/);
});
