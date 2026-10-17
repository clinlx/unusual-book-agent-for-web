'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const V=require('../../src/vfs'),C=require('../../src/game-core');
function save(){const t=V.createTree();for(const id of ['a','b']){V.writeFile(t,'/workspace/Player-'+id+'/基础信息.json',JSON.stringify({姓名:id,状态:{Alive:true,Enabled:true}}));V.writeFile(t,'/workspace/Player-'+id+'/背包.json','[]');}return C.createSave('多人',t);}
const plan={Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'};
test('trigger returns lean actions and rules without changing internal submissions',()=>{
 const s=save(),actions=[{actorId:'a',memberId:'host',requestId:'transport-id',submissionVersion:3,content:'开门',privateContent:'',skip:false,automatic:false},
  {actorId:'b',content:'假装等待',privateContent:'藏钥匙',disguise:true,skip:true,automatic:true}];
 C.beginRound(s,'重复文本',false,'',{actions});const before=structuredClone(s.activeRound.actions);
 const r=C.execute(s,'trigger_next_round',{phase_plan:plan},'trigger',{multiplayerPrompts:{ai_roles:'固定角色控制规则'}});
 a.equal(r.ok,true);a.deepEqual(r.result.actions,[{actorId:'a',content:'开门'},{actorId:'b',content:'假装等待',privateContent:'藏钥匙',disguise:true,skip:true,automatic:true}]);
 for(const key of ['action','player','phase_plan','warnings','unconsciousActors'])a.equal(Object.hasOwn(r.result,key),false,key);
 a.equal(r.result.instruction,'固定角色控制规则');a.match(r.result.disguiseInstruction,/privateContent/);a.equal(r.result.actors.length,2);a.deepEqual(s.activeRound.actions,before);
 a.deepEqual(C.execute(s,'trigger_next_round',{phase_plan:plan},'trigger'),r);
});
test('single-player actions and skips use the same lean shape; spectator hosts add no action',()=>{
 for(const skip of [false,true]){const s=save();C.beginRound(s,'观察房间',false,'',{skip});const r=C.execute(s,'trigger_next_round',{phase_plan:plan});a.equal(r.ok,true);a.equal(r.result.actions.length,1);a.equal(r.result.actions[0].actorId,s.actorId);a.equal(r.result.actions[0].content,s.activeRound.action);a.equal(r.result.actions[0].skip,skip?true:undefined);}
 const s=save();s.hostSpectator={perspective:'all'};C.beginRound(s,'房主不是行动者',false,'',{actions:[]});const r=C.execute(s,'trigger_next_round',{phase_plan:plan});a.deepEqual(r.result.actions,[]);
});
test('multi actions remain attributed and only intended private recipients see the story',()=>{
 const s=save();C.beginRound(s,'',false,'回合',{actions:[{actorId:'a',content:'开门',privateContent:'藏钥匙'},{actorId:'b',content:'等候'}],roundId:'r1'});
 const got=C.execute(s,'trigger_next_round',{phase_plan:plan},'trigger');a.equal(got.ok,true);a.equal(got.result.actions.length,2);a.equal(got.result.actions[0].privateContent,'藏钥匙');
 a.equal(C.execute(s,'private_append_story',{entries:[{id:'a',story:'独有线索'}]},'private').ok,true);
 a.equal(C.visibleEvents({...s,actorId:'b',playerPath:'/workspace/Player-b'},'play').some(e=>e.content==='独有线索'),false);
 a.equal(C.execute(s,'append_story',{skip_output:true,content:'',one_line_summary_of_content:'完成私密反馈',self_accept:true},'public').ok,true);
 a.equal(C.execute(s,'end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end').ok,true);
 a.equal(s.round,1);a.equal(s.activeRound.id,'r1');
});
test('private batch is atomic and invalid recipients never become public',()=>{
 const s=save();C.beginRound(s,'',true);a.equal(C.execute(s,'private_append_story',{entries:[{id:'a',story:'秘密'},{id:'missing',story:'泄漏'}]},'bad').ok,false);a.equal(s.events.some(e=>e.type==='story'),false);
 a.equal(C.execute(s,'append_story',{skip_output:true,one_line_summary_of_content:'空',self_accept:true},'empty').ok,false);
});
test('all unconscious injection names living actors only and rollback restores multi slot state',()=>{
 const s=save();V.writeFile(s.tree,'/workspace/Player-a/基础信息.json','{"状态":{"Alive":true,"Enabled":false}}');V.writeFile(s.tree,'/workspace/Player-b/基础信息.json','{"状态":{"Alive":false,"Enabled":false}}');
 C.beginRound(s,'',false,'',{actions:[{actorId:'a',content:'等待',automatic:true,skip:true}]});const r=C.execute(s,'trigger_next_round',{phase_plan:plan},'t');a.equal(r.ok,true);a.deepEqual(r.result.unconsciousActors,['a']);a.match(r.result.instruction,/苏醒/);a.match(r.result.instruction,/AIPC\/KPC/);C.rollback(s);a.equal(s.slots.length,2);
});
test('round archives retain separately attributed visible snapshots for every active human actor',()=>{
 const s=save();C.beginRound(s,'',true);V.writeFile(s.tree,'/workspace/Player-b/基础信息.json','{"姓名":"b","信息":"b独有",".秘密":"不公开"}');
 a.equal(C.execute(s,'append_story',{content:'共同经历',one_line_summary_of_content:'推进',self_accept:true},'story').ok,true);a.equal(C.execute(s,'end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end').ok,true);
 const archive=Object.values(V.resolve(s.tree,['workspace','过往回合历史记忆']).children)[0];const state=JSON.parse(archive.children['玩家结束状态.json'].content);
 a.equal(state.actorId,'a');a.deepEqual(Object.keys(state.actors),['a','b']);a.equal(state.actors.b.info.信息,'b独有');a.equal(state.info.信息,undefined);a.equal(JSON.stringify(state).includes('不公开'),false);
 C.beginRound(s,'',true);C.execute(s,'append_story',{content:'继续共同经历',one_line_summary_of_content:'继续',self_accept:true},'story2');C.execute(s,'end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end2');
 const next=Object.values(V.resolve(s.tree,['workspace','过往回合历史记忆']).children).find(x=>x.name.startsWith('Round_2_'));a.ok(next.children['玩家结束状态.json']);
});

test('pure private actions leave no empty player bubble in another player view',()=>{
 const s=save();C.beginRound(s,'',false,'',{actions:[{actorId:'a',content:'',privateContent:'只告诉主持人'}]});
 a.equal(C.visibleEvents(s,'play').find(e=>e.type==='player').privateContent,'只告诉主持人');
 a.equal(C.visibleEvents({...s,actorId:'b',playerPath:'/workspace/Player-b'},'play').some(e=>e.type==='player'),false);
});
