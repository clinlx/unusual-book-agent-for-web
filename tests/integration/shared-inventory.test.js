'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Core=require('../../src/game-core'),Sync=require('../../src/multiplayer-sync');
function fixture(){
 const tree=VFS.createTree();for(const id of ['a','b']){VFS.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id}));VFS.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[]');}
 const save=Core.createSave('背包分享',tree),room={roomId:'room',epoch:0,members:{host:{actorId:'a'},guest:{actorId:'b'}}};
 const write=(id,item)=>VFS.writeFile(save.tree,`/workspace/存档-索引-物品/${id}/物品基础信息.json`,JSON.stringify(item));
 const bag=items=>VFS.writeFile(save.tree,'/workspace/Player-a/背包.json',JSON.stringify(items));
 return {save,room,tree:save.tree,write,bag};
}
test('shared inventories filter negative visibility values on referenced and inline items before publication',()=>{
 assert.equal(typeof Sync.inventory,'function');const f=fixture(),items=[];
 for(const [i,visibility]of [false,'false',' FALSE ','否','不可见','暂时不可见','隐藏（暗格）','Hide','hIdE from players','HIDDEN','Invisible'].entries()){
  const id='secret-'+i;f.write(id,{名称:id,可见性:visibility});items.push(id,{名称:'inline-'+id,Visibility:visibility});
 }
 f.write('public',{名称:'公用灯笼',信息:'灯上刻着“No hiding”。',可见性:'可见',位置所属:'SECRET_OWNER','.秘密':'SECRET_NOTE',附件:[{信息:'铜制吊牌','.隐藏用途':'SECRET_ATTACHMENT'}],Action字典:{动作:'SECRET_ACTION'}});
 items.push('public',{名称:'公开地图',visibility:true},{名称:'旧格式雨伞'},{名称:'冲突隐藏',可见性:true,Visibility:false},{名称:'点键隐藏',可见性:true,'.是否对玩家隐藏':true});f.bag(items);
 const original=structuredClone(f.tree),out=Sync.inventory(f.save,'a',{room:f.room,memberId:'guest'});
 assert.equal(out.actorId,'a');assert.equal(out.name,'a');assert.deepEqual(out.items.map(x=>x.名称),['公用灯笼','公开地图','旧格式雨伞']);
 assert.doesNotMatch(JSON.stringify(out),/SECRET_|secret-|inline-secret|位置所属|Action字典|隐藏用途/);assert.deepEqual(f.tree,original);
 assert.ok(Core.player(f.save).items.some(x=>x.名称==='secret-0'),'owner inventory is unaffected');
});
test('inventory authorization matches profiles and hidden character cards disclose no inventory',()=>{
 assert.equal(typeof Sync.inventory,'function');const f=fixture();f.write('key',{名称:'PRIVATE_KEY'});f.bag(['key']);
 assert.throws(()=>Sync.inventory(f.save,'../Player-a',{room:f.room,memberId:'guest'}));
 assert.throws(()=>Sync.inventory(f.save,'a',{room:f.room,memberId:'stranger'}));
 f.room.members.lobby={actorId:null};assert.throws(()=>Sync.inventory(f.save,'a',{room:f.room,memberId:'lobby'}));
 delete f.room.members.host;assert.throws(()=>Sync.inventory(f.save,'a',{room:f.room,memberId:'guest'}));
 f.room.members.host={actorId:'a'};VFS.writeFile(f.tree,'/workspace/Player-a/基础信息.json','{"姓名":"PRIVATE_NAME",".是否对玩家隐藏":true}');
 assert.deepEqual(Sync.inventory(f.save,'a',{room:f.room,memberId:'guest'}),{actorId:'a',name:'角色',items:[],omniscient:false});
});
