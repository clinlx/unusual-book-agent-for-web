const {test}=require('node:test'),assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Core=require('../../src/game-core'),Slots=require('../../src/game-slots'),Sync=require('../../src/multiplayer-sync');
function save(){const t=VFS.createTree();for(const prefix of ['Player-a','AIPC-b','DISABLE-c','KPC-guide']){VFS.writeFile(t,`/workspace/${prefix}/基础信息.json`,JSON.stringify({姓名:prefix}));VFS.writeFile(t,`/workspace/${prefix}/背包.json`,'[]');}return Core.createSave('控制方式',t);}
function finish(s){if(!s.activeRound.starting)Core.execute(s,'trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}},'trigger'+s.activeRound.number);Core.execute(s,'append_story',{content:'玩家看见的正文',one_line_summary_of_content:'开局',self_accept:true},'story'+s.activeRound.number);const r=Core.execute(s,'end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end'+s.activeRound.number);assert.equal(r.ok,true,JSON.stringify(r));}
test('first start injects human/AIPC/KPC setup into compressible internal messages without changing the system prefix',()=>{
 const s=save();s.npcCardInstructions={'slot:b':'外科医生'};Core.beginRound(s,'',true,'开始');
 const injected=s.messages.filter(m=>m.internal);assert.equal(injected.length,1);assert.equal(injected[0].role,'user');
 for(const word of ['1人游戏','Player-a','AIPC-b','KPC-guide','互补','掷骰','外科医生','不得'])assert.ok(injected[0].content.includes(word),word);
 assert.ok(!injected[0].content.includes('DISABLE-c'));assert.ok(Core.context(s,'系统',1e6).some(m=>m.content===injected[0].content));
 assert.deepEqual(Core.context(s,'系统',1e6).filter(m=>m.role==='system'),[{role:'system',content:'系统'}]);
 assert.ok(!Core.visibleEvents(s,'debug').some(e=>String(e.content).includes('角色控制')));
 const view=Sync.project(s,'a');assert.ok(!JSON.stringify(view).includes('外科医生'));
 assert.ok(!Slots.playerContext(Core.context(s,'系统',1e6)).some(m=>m.content===injected[0].content));
});
test('NPC requirements are scoped to the final NPC roster and injected only at the first start',()=>{
 const s=save();s.npcCardInstructions={'slot:a':'PLAYER_REQUIREMENT','slot:b':'NPC_REQUIREMENT','slot:c':'DISABLED_REQUIREMENT','kpc:guide':'KPC_REQUIREMENT'};
 const first=Slots.roundInstruction(s,true,{openPlayerSlots:['b']});
 assert.match(first,/KPC_REQUIREMENT/);assert.doesNotMatch(first,/PLAYER_REQUIREMENT|NPC_REQUIREMENT|DISABLED_REQUIREMENT/);
 assert.equal(Slots.roundInstruction(s,true,{openPlayerSlots:['b']}),'');
 assert.doesNotMatch(Slots.roundInstruction(s,false),/KPC_REQUIREMENT|NPC_REQUIREMENT/);
 const other=save();other.npcCardInstructions={'slot:b':'外科医生','kpc:guide':'熟悉当地交通'};
 Core.beginRound(other,'',true);const message=other.messages.find(m=>m.internal);
 assert.equal(message.role,'user');assert.match(message.content,/AIPC-b.*外科医生/);assert.match(message.content,/KPC-guide.*熟悉当地交通/);
 finish(other);Core.beginRound(other,'下一回合');assert.equal(other.messages.filter(m=>m.internal&&m.content.includes('外科医生')).length,1);
});

test('slot instructions use editable external templates and preserve supplied text literally',()=>{
 const fs=require('node:fs'),Prompts=require('../../src/game-prompts');
 const id='flow/slot_control.json',source=fs.readFileSync('assets/prompts/'+id,'utf8');
 const p=Prompts.create({[id]:source}),templates=p.slotControl();
 assert.ok(Prompts.list().some(item=>item.id===id));assert.ok(!Object.keys(p.flows()).some(key=>key.includes('slot_control')));
 const custom=p.slotControl({[id]:JSON.stringify({...templates,opening_roster:'ROSTER {player_count} {player_slots}',npc_requirement:'CARD {actor} {requirements}'})});
 const s=save();s.npcCardInstructions={'slot:b':'$& {actor}'};
 const instruction=Slots.roundInstruction(s,true,{slotPrompts:custom});
 assert.match(instruction,/ROSTER 1 "Player-a"/);assert.ok(instruction.includes('CARD "AIPC-b" "$& {actor}"'));
 assert.deepEqual(Core.context(s,'固定系统',1e6).filter(m=>m.role==='system'),[{role:'system',content:'固定系统'}]);
});
test('disabled slots lock from round two while NPC/player slots switch and temporary suspension stays reopenable',()=>{
 const s=save();Slots.assertConfigure(s,'c','ai');Core.beginRound(s,'',true);finish(s);Core.beginRound(s,'第二回合');finish(s);
 assert.equal(Slots.locked(s,'c'),true);assert.throws(()=>Slots.assertConfigure(s,'c','player'),/已锁定/);assert.throws(()=>Slots.assertConfigure(s,'b','disabled'),/已锁定/);
 Slots.assertConfigure(s,'b','player');Slots.setMode(s,'b','player');Slots.setMode(s,'b','disabled');
 assert.equal(Slots.locked(s,'b'),false);Slots.assertConfigure(s,'b','player');
});

test('the first round retains slot configuration and freezes its final roster when round two starts',()=>{
 const s=save();Core.beginRound(s,'',true);
 assert.equal(Slots.locked(s,'c'),false);Slots.assertConfigure(s,'c','player');
 assert.throws(()=>Slots.setMode(s,'c','ai'),/执行/);
 finish(s);Slots.assertConfigure(s,'c','ai');Slots.setMode(s,'c','player');Slots.setMode(s,'c','ai');
 Slots.assertConfigure(s,'b','disabled');Slots.setMode(s,'b','disabled');
 Core.beginRound(s,'第二回合');
 assert.equal(s.round,1);assert.equal(Slots.locked(s,'b'),true);assert.equal(Slots.locked(s,'c'),false);
 assert.equal(s.slotControlState.initialModes.c,'ai');assert.equal(s.slotControlState.initialModes.b,'disabled');
 const instruction=s.messages.filter(m=>m.internal).at(-1).content;
 assert.match(instruction,/AIPC-c.*启用/);assert.match(instruction,/DISABLE-b.*关闭/);
 assert.doesNotMatch(instruction,/Player-c/);
 assert.ok(!JSON.stringify(Sync.project(s,'a')).includes('角色控制·内部指令'));
 Core.rollback(s);assert.equal(Slots.locked(s,'b'),false);Slots.assertConfigure(s,'b','ai');Slots.setMode(s,'b','ai');
 Core.beginRound(s,'重新开始第二回合');assert.equal(Slots.locked(s,'b'),false);assert.equal(s.slotControlState.initialModes.b,'ai');
});

test('first-round offline invitations remain reopenable after the second-round boundary freezes',()=>{
 const s=save();Core.beginRound(s,'',true);finish(s);
 Core.beginRound(s,'第二回合',false,'',{openPlayerSlots:['c']});
 assert.equal(Slots.locked(s,'c',{openPlayerSlots:['c']}),false);
 assert.equal(s.slotControlState.initialModes.c,'player');
});
test('control changes collapse to final state and rollback restores the comparison baseline',()=>{
 const s=save();Core.beginRound(s,'',true);finish(s);
 Slots.setMode(s,'b','player');Slots.setMode(s,'b','ai');Core.beginRound(s,'行动',false);assert.equal(s.messages.filter(m=>m.internal).length,1);finish(s);
 Slots.setMode(s,'b','player');Core.beginRound(s,'行动',false);let instructions=s.messages.filter(m=>m.internal);assert.equal(instructions.length,2);assert.match(instructions[1].content,/中途加入|私密/);finish(s);
 Slots.setMode(s,'b','ai');Core.beginRound(s,'行动',false);instructions=s.messages.filter(m=>m.internal);assert.equal(instructions.length,3);assert.match(instructions[2].content,/AI扮演/);
 Core.rollback(s);Core.beginRound(s,'行动',false);assert.equal(s.messages.filter(m=>m.internal).length,3);
});
test('first-round rollback unlocks disabled slots, and configured offline open slots count as human',()=>{
 const s=save();Core.beginRound(s,'',true,'',{openPlayerSlots:['b']});assert.match(s.messages.find(m=>m.internal).content,/2人游戏/);Core.rollback(s);assert.equal(Slots.locked(s,'c'),false);assert.equal(s.slotControlState,undefined);
});
test('offline pending room configuration is not reported as an actual NPC-to-player control change',()=>{
 const s=save();Core.beginRound(s,'',true);finish(s);Core.beginRound(s,'行动',false,'',{openPlayerSlots:['b']});
 assert.equal(s.messages.filter(m=>m.internal).length,1);assert.equal(s.slotControlState.lastModes.b,'ai');
});
test('internal instructions may leave the context window and are absent from player story exports',()=>{
 const s=save();Core.beginRound(s,'',true);finish(s);Core.beginRound(s,'行动',false);finish(s);s.contextFromRound=2;
 const context=Core.context(s,'不变的系统前缀',1e6);assert.ok(!context.some(m=>m.content.includes('角色控制·内部指令')));
 assert.equal(context[0].content,'不变的系统前缀');
 const html=require('../../src/game-presentation').historyHTML(s,text=>text,Core.player(s));assert.ok(!html.includes('角色控制·内部指令'));
});
test('host authority rejects reopening locked slots through invitations, claims and direct assignments',async t=>{
 const s=save();Core.beginRound(s,'',true);finish(s);Core.beginRound(s,'第二回合');finish(s);
 const Host=require('../../src/multiplayer-host'),host=Host.create({getSave:()=>s,execute:async()=>{},rollback:async()=>{}});t.after(()=>host.dispose());
 await host.initialize('a');await host.open();await host.addMember('guest');
 await assert.rejects(host.reserveInvitation('invited','c'),/已锁定/);await assert.rejects(host.assign('guest','c'),/已锁定/);
 const r=host.state();await assert.rejects(host.handle('host',{type:'slot.mode',requestId:'closed-slot',epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members.host.bindingVersion,payload:{actorId:'c',kind:'ai'}}),/已锁定/);
});

test('host authority allows enabling a disabled invitation slot after the first round',async t=>{
 const s=save();Core.beginRound(s,'',true);finish(s);
 const Host=require('../../src/multiplayer-host'),host=Host.create({getSave:()=>s,execute:async()=>{},rollback:async()=>{}});t.after(()=>host.dispose());
 await host.initialize('a');await host.open();await host.reserveInvitation('invited','c');
 assert.equal(host.state().members.invited.invitationActorId,'c');
});
