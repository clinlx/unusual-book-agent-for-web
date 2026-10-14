'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Host=require('../../src/multiplayer-host'),Sync=require('../../src/multiplayer-sync');
async function setup(t,spectatorHost=false){
 const tree=VFS.createTree();for(const id of ['a','b','c']){VFS.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id,Alive:true,Enabled:true}));VFS.writeFile(tree,`/workspace/Player-${id}/背包.json`,JSON.stringify([{名称:id+'的背包'}]));}
 const save={id:'spectator-game',name:'观战测试',tree,playerPath:'/workspace/Player-a',status:'new',round:0,snapshots:[],events:[]},runs=[];
 const host=Host.create({getSave:()=>save,persist:async()=>{},execute:async actions=>{runs.push(actions);save.round++;save.status='waiting';},rollback:async({targetRound})=>{save.round=targetRound;save.status='waiting';}});t.after(()=>host.dispose());
 await host.initialize(spectatorHost?'$spectator':'a');await host.open();
 for(const id of spectatorHost?['a','b']:['b']){await host.addMember('p-'+id);await host.assign('p-'+id,id);}
 const packet=(id,type,payload={})=>{const r=host.state();return {type,payload,requestId:crypto.randomUUID(),epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members[id].bindingVersion,roomId:r.roomId};};
 return {save,host,runs,packet,send:(id,type,payload)=>host.handle(id,packet(id,type,payload))};
}
test('spectator invitations are capped, do not block opening, and reject every gameplay command',async t=>{
 const f=await setup(t);for(let i=0;i<8;i++)await f.host.reserveSpectator('watch-'+i,'none');
 await assert.rejects(f.host.reserveSpectator('extra','none'),{code:'SPECTATOR_LIMIT'});
 await f.send('host','round.start');await f.host.waitForIdle();assert.equal(f.runs.length,1);
 await f.host.joinInvitation('watch-0');
 for(const type of ['action.submit','action.skip','action.cancel','action.prepare','action.prepare.cancel','action.hostSkip','round.start','round.resume','round.advance','rollback.request','rollback.host','rollback.decide','rollback.vote','slot.mode','slot.claim.request','slot.claim.decide'])await assert.rejects(f.send('watch-0',type,{content:'越权',actorId:'a'}),{code:'SPECTATOR_READ_ONLY'});
 assert.equal(f.host.state().participants.length,2);assert.deepEqual(f.host.state().submissions,{});
});
test('spectator scope enforces public, single-player and all views; stale packets cannot restore revoked access',async t=>{
 const f=await setup(t);f.save.events=[{type:'story',content:'公开',audience:'public'},{type:'story',content:'甲秘密',audience:['a'],private:true},{type:'story',content:'乙秘密',audience:['b'],private:true},{type:'player',actorId:'a',content:'伪装',privateContent:'甲真实行动',audience:'public',disguise:true},{type:'tool',content:'内部工具绝不能泄漏'}];
 for(const [id,permission]of [['none','none'],['one','a'],['all','all']])await f.host.reserveSpectator(id,permission);
 const projector=Sync.createHost({getSave:()=>f.save,getRoom:()=>f.host.state()});
 const publicView=(await projector.sync('none')).view,single=(await projector.sync('one')).view,all=(await projector.sync('all')).view;
 assert.equal(publicView.spectator,true);assert.equal(publicView.actorId,null);assert.equal(publicView.panelsLocked,true);assert.ok(!JSON.stringify(publicView).includes('甲秘密'));assert.deepEqual(publicView.info,{});
 assert.ok(JSON.stringify(single).includes('甲秘密'));assert.ok(JSON.stringify(single).includes('甲真实行动'));assert.ok(!JSON.stringify(single).includes('乙秘密'));assert.equal(single.info.姓名,'a');assert.equal(single.actorId,null);
 assert.ok(JSON.stringify(all).includes('甲秘密'));assert.ok(JSON.stringify(all).includes('乙秘密'));assert.ok(!JSON.stringify(all).includes('内部工具'));assert.deepEqual(all.items,[]);
 const html=require('../../src/game-presentation').historyHTML(all,undefined,all);assert.ok(html.includes('甲真实行动'),'authorized private action must also appear in spectator exports');
 await assert.rejects(f.send('one','spectator.view',{view:'all'}),{code:'FORBIDDEN'});
 await f.send('all','spectator.view',{view:'b'});const old=await projector.sync('all');assert.equal(old.view.info.姓名,'b');assert.ok(!JSON.stringify(old.view).includes('甲秘密'));
 const cache=Sync.createClient();assert.equal(await cache.apply(old),true);
 await f.host.configureSpectator('all','none');const restricted=await projector.sync('all',cache.request());assert.equal(await cache.apply(restricted),true);assert.equal(await cache.apply(old),false);assert.ok(!JSON.stringify(cache.getState().view).includes('乙秘密'));
 await f.host.removeSpectator('all');await assert.rejects(projector.sync('all'),{code:'SCOPE_INVALID'});
});
test('spectating host is excluded from actions and votes, can monitor or override a vote, and retains its role on reopen',async t=>{
 const f=await setup(t,true);assert.equal(f.host.state().members.host.role,'spectator');assert.equal(f.save.actorId,null);
 await f.send('host','round.start');await f.host.waitForIdle();await f.send('p-a','action.submit',{content:'甲'});await f.send('p-b','action.submit',{content:'乙'});await f.host.waitForIdle();assert.equal(f.runs.length,2);assert.equal(f.runs[1].length,2);
 f.save.snapshots=[{round:0,inputRoundId:'r0'}];await f.send('p-a','rollback.request',{targetRound:0});let vote=f.host.state().vote;await f.send('host','rollback.decide',{voteId:vote.id,decision:'vote'});vote=f.host.state().vote;assert.deepEqual(vote.eligible.sort(),['p-a','p-b']);
 await assert.rejects(f.send('host','rollback.vote',{voteId:vote.id,approve:true}),{code:'SPECTATOR_READ_ONLY'});
 await f.send('host','rollback.decide',{voteId:vote.id,decision:'reject'});assert.equal(f.host.state().vote,null);
 await f.send('host','rollback.host',{targetRound:0,decision:'approve'});assert.equal(f.save.round,0);assert.equal(f.host.state().members.host.role,'spectator');
 await f.host.close();await f.host.initialize();assert.equal(f.host.state().members.host.actorId,null);assert.equal(f.save.hostSpectator,true);
});


test('spectator export/import and rollback preserve host identity and interrupted progress',async t=>{
 const Core=require('../../src/game-core'),IO=require('../../src/game-import');
 const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-a/基础信息.json','{"姓名":"甲"}');VFS.writeFile(tree,'/workspace/Player-a/背包.json','[]');
 const source=Core.createSave('观战存档',tree);source.hostSpectator=true;source.actorId=null;source.slotsConfigured=true;
 Core.beginRound(source,'',true,'',{actions:[]});
 const bytes=IO.exportSave(source),restored=await IO.importSave({name:'观战.zip',arrayBuffer:()=>bytes.arrayBuffer()});
 const host=Host.create({getSave:()=>restored,execute:async()=>{},rollback:async()=>{}});t.after(()=>host.dispose());await host.initialize();
 assert.equal(host.state().status,'interrupted');assert.equal(restored.slots[0].kind,'player');
 Core.rollback(restored);assert.equal(restored.actorId,null);assert.equal(restored.hostSpectator,true);
});

test('spectator views filter private dice, pending actions and profile access at the host',async t=>{
 const f=await setup(t);for(const [id,permission]of [['none','none'],['one','a'],['all','all']])await f.host.reserveSpectator(id,permission);
 f.save.events=[{type:'dice',roller:'Player-b',rollerKind:'player',rollerId:'b',private:true,targetPlayer:'b',audience:['b'],description:'乙的私密检定',data:{total:37}},{type:'dice',roller:'<|GM|>',rollerKind:'gm',audience:'public',description:'不公开的裁定'}];
 f.host.state();f.save.multiplayer.submissions={b:{content:'乙公开说辞',privateContent:'乙真实意图',disguise:true}};
 const projector=Sync.createHost({getSave:()=>f.save,getRoom:()=>f.host.state()});
 const all=(await projector.sync('all')).view,one=(await projector.sync('one')).view,none=(await projector.sync('none')).view;
 assert.equal(all.events.length,1);assert.equal(all.events[0].data.total,37);assert.equal(one.events.length,0);assert.equal(none.events.length,0);
 assert.equal(all.pendingActions[0].privateContent,'乙真实意图');assert.equal(none.pendingActions[0].privateContent,undefined);assert.equal(one.pendingActions[0].privateContent,undefined);
 assert.equal(Sync.profile(f.save,'b',{room:f.host.state(),memberId:'one'}).name,'b');
 assert.equal(Sync.inventory(f.save,'a',{room:f.host.state(),memberId:'all'}).items.length,1);
});


test('spectating host may advance unconscious players but cannot bypass conscious submissions',async t=>{
 const f=await setup(t,true);await f.send('host','round.start');await f.host.waitForIdle();
 await assert.rejects(f.send('host','round.advance'),{code:'ACTIVE_PLAYERS'});
 for(const id of ['a','b'])VFS.writeFile(f.save.tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id,Enabled:false,Alive:true}));
 await f.send('host','round.advance');await f.host.waitForIdle();assert.equal(f.runs.length,2);
});


test('spectator roster and details respect effective perspective and omit missing resources',async t=>{
 const f=await setup(t);for(const [id,permission]of [['none','none'],['all','all']])await f.host.reserveSpectator(id,permission);
 VFS.writeFile(f.save.tree,'/workspace/Player-a/基础信息.json',JSON.stringify({姓名:'甲',性别:'女',状态:{HP:6,MAXHP:10,MP:0,MAXMP:8,SAN:42,MAXSAN:80,Alive:true,Enabled:true},'.秘密':'角色秘密'}));
 VFS.writeFile(f.save.tree,'/workspace/Player-a/背包.json',JSON.stringify([{名称:'公开物品'},{名称:'隐藏物品',可见性:'Hide'},{名称:'点号隐藏物品','.是否对玩家隐藏':true},'密封信']));
 VFS.writeFile(f.save.tree,'/workspace/存档-索引-物品/密封信/物品基础信息.json',JSON.stringify({名称:'密封信','.是否对玩家隐藏':true,'.内容':'密文'}));
 const projector=Sync.createHost({getSave:()=>f.save,getRoom:()=>f.host.state()});
 const pub=(await projector.sync('none')).view,all=(await projector.sync('all')).view;
 const a=pub.slots.find(s=>s.id==='a'),b=pub.slots.find(s=>s.id==='b');
 assert.equal(a.gender,'女');assert.equal(a.condition,'受伤');assert.equal(a.itemCount,1);assert.equal(a.vitals.hp.value,6);assert.equal(a.vitals.mp.value,0);assert.equal(a.vitals.san.max,80);assert.equal(b.vitals.hp,null);
 assert.equal(all.slots.find(s=>s.id==='a').itemCount,4);assert.ok(!JSON.stringify(pub).includes('角色秘密'));assert.ok(!JSON.stringify(all.slots).includes('密文'),'roster sends summaries, not full inventories');
 const options=memberId=>({memberId,room:f.host.state()});
 assert.equal(Sync.profile(f.save,'a',options('none')).info['.秘密'],undefined);
 const detail=Sync.profile(f.save,'a',options('all'));assert.equal(detail.info['.秘密'],'角色秘密');assert.equal(detail.omniscient,true);
 assert.equal(Sync.inventory(f.save,'a',options('none')).items.length,1);const full=Sync.inventory(f.save,'a',options('all'));assert.equal(full.items.length,4);assert.equal(full.items[3]['.内容'],'密文');
 const P=require('../../src/game-presentation');assert.ok(P.fields(detail.info,detail.info,'info',{showHidden:detail.omniscient}).includes('角色秘密'));assert.ok(!P.fields(detail.info).includes('角色秘密'));
 await f.send('all','spectator.view',{view:'a'});assert.equal(Sync.inventory(f.save,'a',options('all')).items.length,1);assert.equal(Sync.profile(f.save,'a',options('all')).omniscient,false);
 await assert.rejects(projector.sync('unknown'),{code:'SCOPE_INVALID'});assert.throws(()=>Sync.profile(f.save,'a',options('unknown')),{code:'PROFILE_UNAVAILABLE'});
 VFS.writeFile(f.save.tree,'/workspace/Player-a/基础信息.json',JSON.stringify({姓名:'甲',Alive:false,Enabled:false}));assert.equal((await projector.sync('none')).view.slots.find(s=>s.id==='a').condition,'死亡');
 VFS.writeFile(f.save.tree,'/workspace/Player-a/基础信息.json',JSON.stringify({姓名:'甲',Alive:true,Enabled:false}));assert.equal((await projector.sync('none')).view.slots.find(s=>s.id==='a').condition,'异常');
});
