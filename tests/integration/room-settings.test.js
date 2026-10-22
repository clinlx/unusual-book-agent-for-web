"use strict";
const {test}=require('node:test'),a=require('node:assert/strict'),V=require('../../src/vfs'),C=require('../../src/game-core'),H=require('../../src/multiplayer-host'),Sync=require('../../src/multiplayer-sync'),Import=require('../../src/game-import');
async function setup(t,{global=true,spectator=false}={}){
 const tree=V.createTree();for(const id of ['pc','p2']){V.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id}));V.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[]');}
 const s=C.createSave('房间设置',tree),settings={manualDice:global};let fail=false;
 const h=H.create({getSave:()=>s,getSettings:()=>settings,persist:async()=>{if(fail)throw Error('disk');},execute:async()=>{},rollback:async()=>{}});t.after(()=>h.dispose());
 await h.initialize(spectator?'$spectator':'pc');await h.open();await h.addMember('guest');await h.assign('guest','p2');
 const send=(who,mode)=>{const r=h.state();return h.handle(who,{type:'room.settings',payload:{manualDice:mode},requestId:crypto.randomUUID(),epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members[who].bindingVersion});};
 return {s,h,settings,send,fail:()=>{fail=true;}};
}
test('room manual dice defaults to global and explicit on/off override without mutating other rooms or global settings',async t=>{
 const f=await setup(t),other=await setup(t);a.equal(f.h.state().manualDice,true);a.equal(f.h.state().manualDiceMode,'inherit');
 await f.send('host','off');a.equal(f.h.state().manualDice,false);a.equal(f.settings.manualDice,true);a.equal(other.h.state().manualDice,true);
 f.settings.manualDice=false;await f.send('host','on');a.equal(f.h.state().manualDice,true);
 const projected=Sync.project(f.s,'p2',{memberId:'guest',room:f.h.state()});a.equal(projected.room.manualDice,true);a.equal(projected.room.manualDiceMode,'on');
 await f.send('host','inherit');a.equal(f.h.state().manualDice,false);f.settings.manualDice=true;a.equal(f.h.state().manualDice,true);
});
test('room setting changes are host-only, validated, transactional and safe during a pending manual check',async t=>{
 const f=await setup(t,{spectator:true});await a.rejects(f.send('guest','off'),{code:'FORBIDDEN'});
 await f.h.reserveSpectator('audience');await a.rejects(f.send('audience','on'),{code:'SPECTATOR_READ_ONLY'});
 for(const invalid of [null,true,{},'false',''])await a.rejects(f.send('host',invalid),{code:'INVALID_SETTINGS'});
 f.s.multiplayer.status='executing';await a.rejects(f.send('host','off'),{code:'BUSY'});
 f.s.multiplayer.status='interrupted';f.s.pendingManualDice={eventId:'existing'};await f.send('host','off');a.deepEqual(f.s.pendingManualDice,{eventId:'existing'});
 f.fail();await a.rejects(f.send('host','on'),/disk/);a.equal(f.s.roomSettings.manualDice,'off');
});
test('room manual dice mode survives save export/import and host reload',async t=>{
 const f=await setup(t);await f.send('host','off');const blob=Import.exportSave(f.s),restored=await Import.importSave({name:'room.zip',arrayBuffer:()=>blob.arrayBuffer()});
 a.equal(restored.roomSettings.manualDice,'off');
 const h=H.create({getSave:()=>restored,getSettings:()=>({manualDice:true}),execute:async()=>{},rollback:async()=>{}});t.after(()=>h.dispose());await h.initialize();a.equal(h.state().manualDice,false);
});

test('pre-send defaults on, is host-controlled and blocks new registrations while retaining accepted actions',async t=>{
 const f=await setup(t),send=(who,type,payload)=>{const r=f.h.state();return f.h.handle(who,{type,payload,requestId:crypto.randomUUID(),epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members[who].bindingVersion});};
 a.equal(f.h.state().allowPreSubmit,true);
 await a.rejects(send('guest','room.settings',{allowPreSubmit:false}),{code:'FORBIDDEN'});
 for(const value of ['false',null,0])await a.rejects(send('host','room.settings',{allowPreSubmit:value}),{code:'INVALID_SETTINGS'});
 await send('host','room.settings',{allowPreSubmit:false});a.equal(f.h.state().allowPreSubmit,false);
 a.equal(Sync.project(f.s,'p2',{memberId:'guest',room:f.h.state()}).room.allowPreSubmit,false);
 const blob=Import.exportSave(f.s),restored=await Import.importSave({name:'room.zip',arrayBuffer:()=>blob.arrayBuffer()});a.equal(restored.roomSettings.allowPreSubmit,false);
 f.s.status='running';f.s.multiplayer.status='executing';f.s.events.push({type:'story',round:f.s.multiplayer.round,content:'正文'});
 await a.rejects(send('guest','action.prepare',{content:'先去门口'}),{code:'PRE_SUBMIT_DISABLED'});
 f.s.multiplayer.status='interrupted';await send('host','room.settings',{manualDice:'off',allowPreSubmit:true});a.equal(f.s.roomSettings.manualDice,'off');
 f.s.multiplayer.status='executing';const accepted=await send('guest','action.prepare',{content:'先去门口'});
 f.s.multiplayer.status='interrupted';await send('host','room.settings',{allowPreSubmit:false});a.equal(f.s.roomSettings.manualDice,'off');a.equal(f.h.state().preparedActions.p2.status,'queued');
 await send('guest','action.prepare.cancel',{preparedId:accepted.preparedAction.id});a.equal(f.h.state().preparedActions.p2.status,'cancelled');
 f.fail();await a.rejects(send('host','room.settings',{allowPreSubmit:true}),/disk/);a.equal(f.h.state().allowPreSubmit,false);
});
