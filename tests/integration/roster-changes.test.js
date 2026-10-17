'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Core=require('../../src/game-core'),V=require('../../src/vfs'),Sync=require('../../src/multiplayer-sync');
function setup(){const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"姓名":"林","状态":{"HP":10,"MAXHP":10},".秘密":"原秘密"}');V.writeFile(tree,'/workspace/Player-pc/背包.json','["钥匙"]');V.writeFile(tree,'/workspace/存档-索引-物品/钥匙/物品基础信息.json','{"名称":"钥匙","数量":1}');return Core.createSave('标记',tree);}
const write=(s,p,o)=>V.writeFile(s.tree,'/workspace/'+p,JSON.stringify(o));
function finish(s){assert.equal(Core.execute(s,'append_story',{content:'第'+s.activeRound.number+'回合故事',one_line_summary_of_content:'推进'}).ok,true);assert.equal(Core.execute(s,'end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}}).ok,true);}
function changes(s,permission='none',status='collecting'){return Sync.project(s,null,{memberId:'watch',room:{status,members:{watch:{role:'spectator',permission}},submissions:{}}}).slots[0].changes;}
test('roster compares per-section visible end state, including referenced item details, without revealing hidden updates',()=>{
 const s=setup();Core.beginRound(s,'',true,'');write(s,'Player-pc/基础信息.json',{姓名:'林',状态:{HP:10,MAXHP:10},'.秘密':'新秘密'});write(s,'存档-索引-物品/钥匙/物品基础信息.json',{名称:'钥匙',数量:2});finish(s);
 assert.deepEqual(changes(s),{info:false,items:true});assert.deepEqual(changes(s,'all'),{info:true,items:true});assert.deepEqual(changes(structuredClone(s),'all'),{info:true,items:true});
 assert.deepEqual(changes(s,'all','executing'),{info:false,items:false},'clear before the new world snapshot is published');
 Core.beginRound(s,'等待',false,'');assert.deepEqual(changes(s,'all'),{info:false,items:false});Core.execute(s,'trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}});finish(s);assert.deepEqual(changes(s,'all'),{info:false,items:false});
 Core.rollback(s);assert.deepEqual(changes(s,'all'),{info:true,items:true});
});
test('visible profile changes do not mark unchanged inventory, and missing baseline never invents changes',()=>{
 const s=setup();assert.deepEqual(changes(s),{info:false,items:false});Core.beginRound(s,'',true,'');write(s,'Player-pc/基础信息.json',{姓名:'林',状态:{HP:8,MAXHP:10},'.秘密':'原秘密'});finish(s);assert.deepEqual(changes(s),{info:true,items:false});
 s.snapshots=[];assert.deepEqual(changes(s),{info:false,items:false});
});

test('spectator details include a round baseline filtered by the same permission as current data',()=>{
 const s=setup();Core.beginRound(s,'',true,'');write(s,'Player-pc/基础信息.json',{姓名:'林',状态:{HP:8,MAXHP:10},'.秘密':'新秘密'});write(s,'存档-索引-物品/钥匙/物品基础信息.json',{名称:'钥匙',数量:2});finish(s);
 for(const permission of ['none','all','pc']){
  const room={status:'collecting',members:{watch:{role:'spectator',permission}},submissions:{}},options={room,memberId:'watch'};
  const profile=Sync.profile(s,'pc',options),bag=Sync.inventory(s,'pc',options);
  assert.equal(profile.baseline.状态.HP,10);assert.equal(profile.info.状态.HP,8);
  assert.equal(bag.baseline[0].数量,1);assert.equal(bag.items[0].数量,2);
  assert.equal(profile.baseline['.秘密'],permission==='all'?'原秘密':undefined);
  if(permission==='pc')assert.deepEqual(Sync.project(s,null,options).baseline,{info:profile.baseline,items:bag.baseline});
 }
 write(s,'Player-pc/基础信息.json',{姓名:'林','.是否对玩家隐藏':true});
 const hiddenOptions={memberId:'watch',room:{members:{watch:{role:'spectator',permission:'none'}}}};
 assert.deepEqual(Sync.profile(s,'pc',hiddenOptions).baseline,{});
 assert.deepEqual(Sync.inventory(s,'pc',hiddenOptions).baseline,[]);
 s.snapshots=[];const options={memberId:'watch',room:{members:{watch:{role:'spectator',permission:'all'}}}};
 assert.deepEqual(Sync.profile(s,'pc',options).baseline,Sync.profile(s,'pc',options).info);
});
