'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const VFS=require('../src/vfs.js');
const GameCore=require('../src/game-core.js');
const GameImport=require('../src/game-import.js');

function makeTree(){
  const tree=VFS.createTree();
  VFS.mkdirp(tree,['workspace','Player-Test']);
  VFS.writeFile(tree,'/workspace/Player-Test/基础信息.json',JSON.stringify({姓名:'测试者'}));
  VFS.writeFile(tree,'/workspace/Player-Test/背包.json','[]');
  return tree;
}

test('pending manual dice survives save ZIP export and import',async()=>{
  const save=GameCore.createSave('pending-dice',makeTree());
  GameCore.beginRound(save,'检查机关',false,'round prompt');
  const callId='call-dice-1',eventId='event-dice-1';
  const args={description:'力量检定',roller:'测试者',related_attr:'力量',is_secret:false,dice_dict:{力量:'1d20'},target_value:12,compare_mode:'ge'};
  save.messages.push({role:'assistant',content:'',round:save.activeRound.number,tool_calls:[{id:callId,type:'function',function:{name:'roll_dice',arguments:JSON.stringify(args)}}]});
  save.events.push({id:eventId,type:'dice',round:save.activeRound.number,at:Date.now(),roller:'测试者',relatedAttr:'力量',secret:false,playerRelated:true,diceArgs:args,manual:true,pending:true,callId});
  save.pendingManualDice={callId,eventId,round:save.activeRound.number,args,createdAt:Date.now()};
  save.status='interrupted';

  const blob=GameImport.exportSave(save);
  const buffer=await blob.arrayBuffer();
  const restored=await GameImport.importSave({name:'pending-dice.zip',lastModified:0,arrayBuffer:async()=>buffer});

  assert.deepEqual(restored.pendingManualDice,save.pendingManualDice);
  assert.equal(restored.status,'interrupted');
  assert.equal(restored.events.find(e=>e.id===eventId)?.pending,true);
  assert.equal(restored.messages.some(m=>m.role==='tool'&&m.tool_call_id===callId),false);
});


test('stale completed manual dice events are repaired without touching current pending dice',()=>{
  const save=GameCore.createSave('repair-dice',makeTree());
  GameCore.beginRound(save,'连续检定',false,'round prompt');
  const args1={description:'第一次',roller:'测试者',related_attr:'力量',is_secret:false,dice_dict:{力量:'1d20'},target_value:10,compare_mode:'ge'};
  const args2={description:'第二次',roller:'测试者',related_attr:'敏捷',is_secret:false,dice_dict:{敏捷:'1d20'},target_value:10,compare_mode:'ge'};
  save.events.push(
    {id:'dice-old',type:'dice',round:1,pending:true,manual:true,callId:'call-old',diceArgs:args1,roller:'测试者',relatedAttr:'力量',secret:false,playerRelated:true},
    {id:'tool-old',type:'tool',round:1,name:'roll_dice',success:true,callId:'call-old',args:args1,result:{data:{rows:[{label:'力量',formula:'1d20',rolls:[14],total:14}],mode:'sum',left:0,right:0,compare_mode:'ge',raw:14,total:14,target:10,success:true,criticalHints:[],critical:null,special:false},content:'resolved'}},
    {id:'dice-current',type:'dice',round:1,pending:true,manual:true,callId:'call-current',diceArgs:args2,roller:'测试者',relatedAttr:'敏捷',secret:false,playerRelated:true}
  );
  save.pendingManualDice={callId:'call-current',eventId:'dice-current',round:1,args:args2,createdAt:Date.now()};

  assert.equal(GameCore.repairManualDiceEvents(save),true);
  const repaired=save.events.find(e=>e.id==='dice-old'),current=save.events.find(e=>e.id==='dice-current');
  assert.equal(repaired.pending,false);
  assert.deepEqual(repaired.data.rows[0].rolls,[14]);
  assert.equal(repaired.data.success,true);
  assert.equal(current.pending,true);
});
