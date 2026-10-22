'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const V=require('../../src/vfs'),C=require('../../src/game-core'),H=require('../../src/multiplayer-host'),Sync=require('../../src/multiplayer-sync'),Library=require('../../src/character-library');
async function fixture(t){
 const tree=V.createTree();for(const id of ['pc','p2']){V.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id,HP:8,MAXHP:10,'.秘密':'PRIVATE_SECRET'}));V.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[{"名称":"怀表"}]');}
 const s=C.createSave('归程',tree);s.status='waiting';s.round=3;
 let broken=false;const host=H.create({getSave:()=>s,execute:async()=>{},rollback:async()=>{},persist:async()=>{if(broken)throw Error('storage failed');}});t.after(()=>host.dispose());
 await host.initialize('pc');await host.open();await host.addMember('guest');await host.assign('guest','p2');await host.reserveSpectator('watch','all');
 const send=(id,type,payload={})=>{const r=host.state();return host.handle(id,{type,payload,requestId:crypto.randomUUID(),epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members[id].bindingVersion,roomId:r.roomId});};
 return {s,host,send,failStorage:()=>broken=true,end:()=>{s.status='ended';s.activeRound={complete:true};s.multiplayer.status='ended';}};
}
test('imprint requires complete ending and owned character; review cannot mutate or reveal hidden data',async t=>{
 const f=await fixture(t);await a.rejects(f.send('guest','character.preview'),{code:'NOT_ENDED'});f.end();
 await a.rejects(f.send('watch','character.preview'),{code:'SPECTATOR_READ_ONLY'});
 await a.rejects(f.send('host','character.preview',{actorId:'p2'}),{code:'FORBIDDEN'});
 const {character,revision}=await f.send('guest','character.preview');a.equal(character.actorId,'p2');a.equal(character.raw.info['.秘密'],'PRIVATE_SECRET');a.equal(character.info.HP,10);a.equal(JSON.parse(V.readFile(f.s.tree,'/workspace/Player-p2/基础信息.json').content).HP,8);a.equal(character.items[0].名称,'怀表');a.doesNotMatch(JSON.stringify(character.info),/PRIVATE_SECRET/);a.equal(f.s.characterImprints,undefined);
 V.writeFile(f.s.tree,'/workspace/Player-p2/基础信息.json','{"姓名":"p2","HP":9}');
 await a.rejects(f.send('guest','character.imprint',{revision}),{code:'CHARACTER_CHANGED'});a.equal(f.s.characterImprints,undefined);
});
test('imprint freezes one snapshot, retries recover it, and projection never includes other imprints',async t=>{
 const f=await fixture(t);f.end();const preview=await f.send('guest','character.preview');
 const [one,two]=await Promise.all([f.send('guest','character.imprint',{revision:preview.revision}),f.send('guest','character.imprint',{revision:preview.revision})]);a.deepEqual(one.character,two.character);a.ok(one.character.imprintId);
 V.writeFile(f.s.tree,'/workspace/Player-p2/基础信息.json','{"姓名":"different","HP":1}');
 a.deepEqual((await f.send('guest','character.preview')).character,one.character);
 const own=Sync.project(f.s,'pc',{memberId:'host',room:f.host.state()});a.equal(own.characterImprint,null);a.doesNotMatch(JSON.stringify(own),new RegExp(one.character.imprintId));
 const guest=Sync.project(f.s,'p2',{memberId:'guest',room:f.host.state()});a.equal(guest.characterImprint,one.character.imprintId);
 const hostPreview=await f.send('host','character.preview');a.equal((await f.send('host','character.imprint',{revision:hostPreview.revision})).character.actorId,'pc');
 f.s.status='waiting';await a.rejects(f.send('guest','character.imprint',{revision:preview.revision}),{code:'NOT_ENDED'});
});
test('failed host persistence does not consume imprint',async t=>{
 const f=await fixture(t);f.end();const preview=await f.send('guest','character.preview');f.failStorage();await a.rejects(f.send('guest','character.imprint',{revision:preview.revision}),/storage failed/);a.equal(f.s.characterImprints,undefined);
});
test('character names and differences preserve values and distinguish removed fields',()=>{
 a.equal(Library.defaultName('白墨',new Date(2026,9,19,8,2,3)),'白墨 2026-10-19 08:02:03');a.throws(()=>Library.name('  '));
 a.deepEqual(Library.changes({HP:3,伤势:'腿伤'},{HP:8,钱:0}),[{path:'HP',kind:'修改',before:3,after:8},{path:'伤势',kind:'移除',before:'腿伤',after:undefined},{path:'钱',kind:'新增',before:undefined,after:0}]);
});

test('portable item references follow warehouse transfers and preserve sibling item indexes',()=>{
 const R=require('../../src/character-records'),pairs=R.itemReferences('watch','new_watch');
 a.deepEqual(R.rewrite({Action:{path:'/workspace/存档-索引-物品/watch/效果.md'},'存档-索引-物品/watch':true},pairs),{Action:{path:'/workspace/存档-索引-物品/new_watch/效果.md'},'存档-索引-物品/new_watch':true});
 a.equal(R.rewriteFile({path:'说明.md',content:'读取 /workspace/存档-索引-物品/watch/效果.md',encoding:'utf8'},pairs).content,'读取 /workspace/存档-索引-物品/new_watch/效果.md');
 a.equal(R.rewrite('存档-索引-物品/another.json',R.itemReferences('存档-索引-物品/watch.json','new')),'存档-索引-物品/another.json');
});

test('site backup strips API configuration while retaining request responses and story history',()=>{
 const Backup=require('../../src/game-backup'),tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{}');V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');
 const save=C.createSave('故事',tree);save.requestHistory=[{body:{model:'PRIVATE_MODEL',custom_secret:'PRIVATE_KEY',messages:[{role:'user',content:'故事内容'}],tools:[]},response:{content:'回复'},usage:{total_tokens:20}}];
 const checked=Backup.validate({format:'trpg-game-site',version:1,data:{saves:[save],messages:[],events:[],config:[{id:'settings',value:{apiKey:'PRIVATE_KEY',baseUrl:'PRIVATE_URL',manualDice:true}}],characters:[],receipts:[],meta:{}},local:{'game-prepared-input:test':'draft'}});
 a.doesNotMatch(JSON.stringify(checked),/PRIVATE_/);a.deepEqual(checked.data.saves[0].requestHistory,[{body:{messages:[{role:'user',content:'故事内容'}],tools:[]},response:{content:'回复'},usage:{total_tokens:20}}]);a.equal(checked.data.config[0].value.manualDice,true);a.equal(save.requestHistory[0].body.custom_secret,'PRIVATE_KEY');
});
test('restoration preserves hidden profile and item data, restores aliases, and does not heal SAN or mutate the world',()=>{
 const Snapshot=require('../../src/character-snapshot');
 const info={状态:{生命值:0,生命值上限:12,魔力值:'2',魔力值上限:'9',SAN:20,MAXSAN:80,Alive:false},'.秘密':'藏着的身份'};
 const copy=Snapshot.restore(info);a.equal(copy.状态.生命值,12);a.equal(copy.状态.魔力值,'9');a.equal(copy.状态.SAN,20);a.equal(copy.状态.Alive,false);a.equal(info.状态.生命值,0);a.equal(copy['.秘密'],info['.秘密']);
 a.deepEqual(Snapshot.restore({HP:3,MP:1}),{HP:3,MP:1});a.deepEqual(Snapshot.restore({HP:3,MAXHP:'无'}),{HP:3,MAXHP:'无'});
 const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json',JSON.stringify(info));V.writeFile(tree,'/workspace/Player-pc/背包.json','["watch","hidden"]');V.writeFile(tree,'/workspace/存档-索引-物品/watch/物品基础信息.json','{"名称":"怀表",".机关":"内部数据","Action":{"开启":"暗格"}}');V.writeFile(tree,'/workspace/存档-索引-物品/hidden/物品基础信息.json','{"名称":"密函",".是否对玩家隐藏":true}');
 const capture=Snapshot.capture({id:'s',name:'故事',round:2,tree},{id:'pc',path:'/workspace/Player-pc'});a.equal(capture.raw.items.length,2);a.equal(capture.raw.items[0].Action.开启,'暗格');a.deepEqual(capture.raw.inventory,['watch','hidden']);a.deepEqual(capture.items,[{名称:'怀表'}]);
});
test('finished room keeps its owners across close and host reload for later imprinting',async t=>{
 const f=await fixture(t);f.s.multiplayer.members.guest.invitationActorId='p2';f.end();await f.host.close();a.equal(f.host.state().members.guest.actorId,'p2');f.host.dispose();
 const host=H.create({getSave:()=>f.s,execute:async()=>{},rollback:async()=>{}});t.after(()=>host.dispose());await host.initialize('pc');await host.open();await host.joinInvitation('guest');const r=host.state();
 a.equal(r.members.guest.actorId,'p2');a.equal(f.s.slots.find(s=>s.id==='p2').kind,'player');
 const result=await host.handle('guest',{type:'character.preview',requestId:crypto.randomUUID(),epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members.guest.bindingVersion,payload:{}});a.equal(result.character.actorId,'p2');
});
test('imported character is owned, bounded to creation, carries hidden metadata and portable inventory, and injects an ordinary one-shot instruction',async t=>{
 const f=await fixture(t),Snapshot=require('../../src/character-snapshot'),Records=require('../../src/character-records'),Slots=require('../../src/game-slots');
 const original=Snapshot.capture(f.s,f.s.slots.find(s=>s.id==='pc'));original.raw.metadata=Records.metadata({modules:['归程','归程']},'旧事',5);original.raw.info.姓名='旅行者';original.raw.info.穿戴={手腕:'watch'};original.raw.inventory=['watch'];original.raw.items=[{名称:'旧表','.秘密':'机关',位置所属:'Player-pc'}];original.raw.files=[{path:'秘密笔记.md',content:'PRIVATE_NOTE',encoding:'utf8'}];
 await a.rejects(f.send('guest','character.inject',{snapshot:original}),{code:'CHARACTER_LOCKED'});
 f.s.round=0;f.s.status='new';f.s.activeRound=null;
 await a.rejects(f.send('watch','character.inject',{snapshot:original}),{code:'SPECTATOR_READ_ONLY'});await a.rejects(f.send('guest','character.inject',{actorId:'pc',snapshot:original}),{code:'FORBIDDEN'});
 const before=JSON.stringify(f.s.tree);await a.rejects(f.send('guest','character.inject',{snapshot:{...original,raw:{...original.raw,info:{状态:{Insane:true}}}}}),/不可用/);a.equal(JSON.stringify(f.s.tree),before);
 await f.send('host','character.policy',{policy:'allow'});await f.send('guest','character.inject',{snapshot:original});const bag=JSON.parse(V.readFile(f.s.tree,'/workspace/Player-p2/背包.json').content),info=JSON.parse(V.readFile(f.s.tree,'/workspace/Player-p2/基础信息.json').content);a.equal(info.姓名,'旅行者');a.equal(info.穿戴.手腕,bag[0]);a.notEqual(bag[0],'watch');a.equal(V.readFile(f.s.tree,'/workspace/Player-p2/秘密笔记.md').content,'PRIVATE_NOTE');a.equal(C.player({...f.s,playerPath:'/workspace/Player-p2'}).items[0].名称,'旧表');
 const recaptured=Snapshot.capture(f.s,f.s.slots.find(s=>s.id==='p2'));a.deepEqual(recaptured.raw.metadata.modules,['归程','旧事']);a.equal(recaptured.raw.items[0]['.秘密'],'机关');
 const instruction=Slots.roundInstruction(f.s,true);a.match(instruction,/Player-p2.*无需检验/);a.equal(Slots.roundInstruction(f.s,false),'');a.equal(Slots.playerContext([{role:'user',content:instruction}]).length,0);
 f.s.round=1;await a.rejects(f.send('guest','character.inject',{snapshot:original}),{code:'CHARACTER_LOCKED'});
});
