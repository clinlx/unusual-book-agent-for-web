'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Core=require('../../src/game-core');
const VFS=require('../../src/vfs');
const Store=require('../../src/game-store');
const History=require('../../src/game-history');
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
function save(){
  const tree=VFS.createTree();
  VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"林"}');
  VFS.writeFile(tree,'/workspace/Player-p/背包.json','[]');
  VFS.writeFile(tree,'/workspace/线索.txt','旧线索');
  const s=Core.createSave('重建测试',tree);Core.beginRound(s,'',true,'旧开局提示');
  return s;
}
function tool(s,id,name,args){
  const tc=call(id,name,args);
  s.messages.push({role:'assistant',round:s.activeRound.number,reasoning_content:'旧工具思考',tool_calls:[tc]});
  const result=Core.execute(s,name,args,id);
  s.messages.push({role:'tool',round:s.activeRound.number,tool_call_id:id,content:JSON.stringify(result)});
  return result;
}
const story=(s,id='story',text='油布包裹出现在门边。')=>tool(s,id,'append_story',{content:text,one_line_summary_of_content:'发现包裹',self_accept:true});
const end=s=>tool(s,'end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Active_Scene:'门边',custom:'保留的状态'}});
const rebuild=s=>Core.rebuildContext(s,{system:'最新系统规则',roundPrompt:'最新回合规则',startPrompt:'最新开局规则'});
const file=(s,p)=>VFS.resolve(s.tree,VFS.normalize(p))?.content;

test('rebuild removes tool evidence and requests, preserves story, cache, summaries and all world files',()=>{
  const s=save();
  tool(s,'read','read_file',{path:'/workspace/线索.txt'});
  tool(s,'write','write_file',{path:'/workspace/线索.txt',content:'已写入的线索'});
  story(s);assert.equal(end(s).ok,true);
  s.requestHistory=[{body:{messages:s.messages},response:{reasoning:'旧请求思考'}}];
  const tree=structuredClone(s.tree),cache=structuredClone(s.cache),summaries=structuredClone(s.summaries);
  const info=rebuild(s);
  assert.equal(info.snapshots,1);assert.ok(info.toolCalls>=4);
  assert.deepEqual(s.tree,tree);assert.deepEqual(s.cache,cache);assert.deepEqual(s.summaries,summaries);
  assert.equal(s.snapshots.length,0);assert.equal(s.requestHistory.length,0);
  assert.equal(s.status,'waiting');assert.deepEqual(s.activeRound.readState,{});
  assert.deepEqual(s.activeRound.receipts,{});
  for(const m of s.messages){assert.equal(m.tool_calls,undefined);assert.equal(m.tool_call_id,undefined);assert.equal(m.reasoning_content,undefined);assert.notEqual(m.role,'tool');}
  assert.ok(s.messages.some(m=>m.role==='assistant'&&m.content==='油布包裹出现在门边。'));
  const sent=Core.context(s,'最新系统规则');
  assert.equal(sent[0].content,'最新系统规则');
  assert.match(JSON.stringify(sent),/保留的状态/);assert.match(JSON.stringify(sent),/发现包裹/);
  assert.doesNotMatch(JSON.stringify(sent),/旧工具思考|旧请求思考|旧开局提示|已写入的线索/);
  assert.equal(s.events.some(e=>['tool','assistant','error','warning'].includes(e.type)),false);
  assert.throws(()=>Core.rollback(s),/没有可回退/);
});

test('current-round rebuild abandons pending calls, preserves progress, and can finish without republishing',async()=>{
  const s=save();story(s);
  const published=s.activeRound.published;
  s.messages.push({role:'assistant',round:1,tool_calls:[call('pending','write_file',{path:'/workspace/绝不能创建.txt',content:'no'})]});
  const tree=structuredClone(s.tree);
  rebuild(s);
  assert.deepEqual(s.tree,tree);assert.equal(s.activeRound.published,published);
  assert.equal(s.activeRound.triggered,true);assert.equal(s.status,'interrupted');
  let requests=0;
  await Core.run(s,async messages=>{
    requests++;assert.equal(messages.some(m=>m.role==='tool'||m.tool_calls),false);
    assert.match(JSON.stringify(messages),/最新回合规则/);
    return {tool_calls:[call('finish-new','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]};
  },{openingPreload:true,system:'最新系统规则'});
  assert.equal(requests,1);assert.equal(s.status,'waiting');
  assert.equal(s.events.filter(e=>e.type==='story').length,1);
  assert.equal(file(s,'/workspace/绝不能创建.txt'),undefined);
  assert.equal(s.activeRound.contextRebuildBaseline,undefined);
});

test('after rebuild overwrite requires a new read and changes during resumed play are still tracked',async()=>{
  const s=save();
  tool(s,'read','read_file',{path:'/workspace/线索.txt'});story(s);rebuild(s);
  assert.equal(Core.execute(s,'write_file',{path:'/workspace/线索.txt',content:'非法覆盖'},'blocked').ok,false);
  let requests=0;
  await Core.run(s,async()=>{
    if(!requests++)return {tool_calls:[call('fresh-read','read_file',{path:'/workspace/线索.txt'})]};
    return {tool_calls:[call('fresh-write','write_file',{path:'/workspace/线索.txt',content:'重新读取后修改'}),
      call('fresh-end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]};
  },{openingPreload:false});
  assert.equal(file(s,'/workspace/线索.txt'),'重新读取后修改');
  assert.ok(s.lastChanges.some(c=>c.path==='/workspace/线索.txt'));
  assert.ok(s.snapshots.length===0);
  Core.beginRound(s,'前往门口',false,'下一轮');
  assert.equal(s.snapshots.length,1);
  Core.rollback(s);
  assert.equal(file(s,'/workspace/线索.txt'),'重新读取后修改');
  assert.equal(s.messages.some(m=>m.reasoning_content==='旧工具思考'),false);
});

test('player private actions and private stories retain explicit audiences without tool wrappers',()=>{
  const s=save();s.events.push(
    {id:'player',type:'player',round:1,actorId:'p',content:'公开说辞',privateContent:'秘密行动',disguise:true,args:{action:'旧参数'}},
    {id:'private',type:'story',round:1,private:true,audience:['p'],content:'仅林知道的线索',callId:'old'},
    {id:'dice',type:'dice',round:1,roller:'林',description:'侦查',audience:['p'],secret:true,data:{raw:17,total:17,success:true},diceArgs:{dice_dict:{侦查:'1d20'}},callId:'old-dice'});
  rebuild(s);
  assert.match(s.messages.find(m=>m.origin==='rebuilt-action').content,/公开说辞.*\n.*秘密行动/s);
  assert.match(s.messages.find(m=>m.origin==='rebuilt-story').content,/受众：\["p"\]/);
  assert.match(s.messages.find(m=>m.origin==='rebuilt-dice').content,/"raw":17/);
  assert.match(s.messages.find(m=>m.origin==='rebuilt-dice').content,/"secret":true/);
  assert.equal(s.events.find(e=>e.id==='player').args,undefined);
  assert.deepEqual(s.events.find(e=>e.id==='dice').diceArgs,{dice_dict:{侦查:'1d20'}});
  assert.equal(s.events.find(e=>e.id==='private').callId,undefined);
  assert.deepEqual(s.events.find(e=>e.id==='private').audience,['p']);
});

test('preserves non-tool story events and never treats arbitrary assistant reasoning as published story',()=>{
  const s=save();s.events.push({id:'native-story',type:'story',round:1,content:'导入的正文'});
  s.messages.push({role:'assistant',content:'准备调用某工具，尚未发布的草稿',round:1});
  rebuild(s);
  assert.ok(s.messages.some(m=>m.content==='导入的正文'));
  assert.doesNotMatch(JSON.stringify(s.messages),/尚未发布的草稿/);
});

test('unsettled manual dice block rebuild without deleting anything',()=>{
  const s=save();s.pendingManualDice={callId:'pending',eventId:'dice'};
  const before=structuredClone(s);
  assert.throws(()=>rebuild(s),/先完成.*手动检定/);assert.deepEqual(s,before);
});

test('rebuild preserves game-over state and does not create a new playable round',()=>{
  const s=save();story(s);
  tool(s,'end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏结束',game_over:true}});
  rebuild(s);
  assert.equal(s.status,'ended');assert.equal(s.activeRound.complete,true);
  assert.equal(s.cache.game_over,true);
  assert.throws(()=>Core.beginRound(s,'继续'),/游戏已结束/);
});

test('cache remains available at the next context boundary even without an archive file',()=>{
  const s=save();story(s);end(s);rebuild(s);
  const root=VFS.resolve(s.tree,['workspace']);delete root.children['过往回合历史记忆'];
  Core.beginRound(s,'继续',false,'最新下一轮');s.contextFromRound=2;
  const sent=Core.context(s,'最新系统规则',10000);
  assert.match(JSON.stringify(sent),/保留的状态/);
  assert.equal(s.snapshots.length,1);
});

test('pending preset opening is not lost or published twice after rebuild',async()=>{
  const s=save();s.activeRound.presetOpening='预设正文';s.activeRound.presetPrepared=true;
  s.openingPending={prompt:'旧开局规则',instruction:'角色控制说明'};
  rebuild(s);assert.equal(s.openingPending.prompt,'最新开局规则');
  await Core.run(s,async()=>{throw Error('preset opening does not request model');},{openingPreload:false});
  assert.equal(s.status,'waiting');assert.equal(s.events.filter(e=>e.type==='story').length,1);
  assert.equal(s.events.find(e=>e.type==='story').content,'预设正文');
  rebuild(s);await Core.run(s,async()=>{throw Error('completed opening does not request model');});
  assert.equal(s.events.filter(e=>e.type==='story').length,1);
});

test('opening internal instructions are refreshed from the current file',()=>{
  const s=save();VFS.writeFile(s.tree,'/workspace/开局内部说明.md','新版世界内部说明');
  s.messages.push({role:'user',content:'[开局内部说明]\n旧版说明',round:1});
  rebuild(s);
  assert.match(JSON.stringify(s.messages),/新版世界内部说明/);
  assert.doesNotMatch(JSON.stringify(s.messages),/旧版说明/);
});

test('rebuild is durable across storage reloads and later tool history is recorded normally',async()=>{
  const db=Store.create(null);await db.open();const s=save();story(s);end(s);
  await db.putSave(s);rebuild(s);await db.putSave(s);
  const restored=await db.getSave(s.id);
  assert.deepEqual(restored.messages,s.messages);assert.deepEqual(restored.cache,s.cache);
  assert.equal(restored.snapshots.length,0);assert.equal(restored.requestHistory.length,0);
  Core.beginRound(restored,'继续',false,'下一轮');
  const result=tool(restored,'new-read','read_file',{path:'/workspace/线索.txt'});
  assert.equal(result.ok,true);assert.equal(restored.messages.at(-1).role,'tool');
});


const Host=require('../../src/multiplayer-host');
function hostFixture(){
  const s=save();story(s);end(s);let failSave=false,uid=0;
  const host=Host.create({getSave:()=>s,uid:()=>String(++uid),execute:async()=>{},rollback:async()=>{},
    persist:async()=>{if(failSave)throw Error('storage quota');},
    rebuildContext:async expected=>{
      if(expected.saveId!==s.id||expected.updatedAt!==s.updatedAt)throw Error('存档已变化');
      return rebuild(s);
    }});
  return {s,host,setFail:value=>{failSave=value;}};
}
test('host serializes rebuild and restores all history if storage commit fails',async()=>{
  const f=hostFixture();await f.host.initialize('p');
  const before=structuredClone(f.s);f.setFail(true);
  await assert.rejects(f.host.rebuildContext(Core.contextRebuildInfo(f.s)),/storage quota/);
  assert.deepEqual(f.s,before);
  f.setFail(false);await f.host.rebuildContext(Core.contextRebuildInfo(f.s));
  assert.equal(f.s.snapshots.length,0);assert.equal(f.host.state().status,'collecting');
  assert.equal(f.s.multiplayer.epoch,before.multiplayer.epoch);
  f.host.dispose();
});
test('host rejects online rebuilds and pending rollback decisions',async()=>{
  const f=hostFixture();await f.host.initialize('p');
  f.s.multiplayer.online=true;
  await assert.rejects(f.host.rebuildContext(Core.contextRebuildInfo(f.s)),/先关闭联机房间/);
  f.s.multiplayer.online=false;f.s.multiplayer.vote={status:'requested'};
  await assert.rejects(f.host.rebuildContext(Core.contextRebuildInfo(f.s)),/先完成或取消回退/);
  assert.ok(f.s.messages.some(m=>m.tool_calls));assert.equal(f.s.snapshots.length,1);
  f.host.dispose();
});
test('host resumes an interrupted rebuilt round with its original frozen actions',async()=>{
  const s=save();story(s);let runs=0,uid=0;
  const host=Host.create({getSave:()=>s,uid:()=>String(++uid),persist:async()=>{},rollback:async()=>{},
    rebuildContext:async()=>rebuild(s),
    execute:async(actions,options)=>{
      runs++;assert.equal(options.resume,true);
      assert.deepEqual(actions,[{actorId:'p',content:'原本行动'}]);
      await Core.run(s,async()=>({tool_calls:[call('new-end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]}),{openingPreload:false});
    }});
  await host.initialize('p');
  s.multiplayer.frozenActions=[{actorId:'p',content:'原本行动'}];
  await host.rebuildContext(Core.contextRebuildInfo(s));
  assert.equal(host.state().status,'interrupted');
  const r=host.state();
  await host.handle('host',{type:'round.resume',requestId:'resume-new',epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members.host.bindingVersion,payload:{}});
  await host.waitForIdle();
  assert.equal(runs,1);assert.equal(s.status,'waiting');assert.equal(host.state().status,'collecting');
  host.dispose();
});


test('published dice retain their exact results, named modifiers, rules and original visibility',()=>{
  const s=save();
  const args={roller:'林',description:'检查包裹',related_attr:'侦查',dice_dict:{侦查:'1d20'},
    calculate_only:false,target_value:12,compare_mode:'ge',dice_combine_mode:'sum',
    left_modifiers:{经验:2},right_modifiers:{视线受阻:1},is_secret:false,critical_success_range:null,critical_failure_range:null};
  const result=Core.execute(s,'roll_dice',args,'public-roll',{fixedDiceRolls:[10]});
  assert.equal(result.ok,true);assert.equal(result.result.data.total,12);assert.equal(result.result.data.target,13);
  assert.equal(result.result.data.success,false);
  Core.execute(s,'roll_dice',{...args,is_secret:true},'secret-roll',{fixedDiceRolls:[7]});
  Core.execute(s,'roll_dice',{...args,roller:'<|GM|>'},'gm-roll',{fixedDiceRolls:[2]});
  Core.execute(s,'roll_dice',{...args,is_private:true,target_player:'p'},'private-own',{fixedDiceRolls:[14]});
  VFS.writeFile(s.tree,'/workspace/Player-q/基础信息.json','{"姓名":"乙"}');
  Core.execute(s,'roll_dice',{...args,is_private:true,target_player:'q'},'private-other',{fixedDiceRolls:[18]});
  const visible=Core.visibleEvents(s,'play').filter(e=>e.type==='dice').map(({callId,...e})=>e);
  const rolls=s.events.filter(e=>e.type==='dice').map(({callId,...e})=>e);
  rebuild(s);
  assert.deepEqual(s.events.filter(e=>e.type==='dice'),rolls);
  assert.deepEqual(Core.visibleEvents(s,'play').filter(e=>e.type==='dice'),visible);
  assert.equal(visible.length,3);assert.equal(visible[1].secret,true);assert.equal(visible[1].data,undefined);
  assert.match(JSON.stringify(s.messages.find(m=>m.origin==='rebuilt-dice')),/经验/);
  assert.match(JSON.stringify(s.messages.find(m=>m.origin==='rebuilt-dice')),/视线受阻/);
  assert.match(JSON.stringify(s.messages.find(m=>m.origin==='rebuilt-dice')),/"total\\":12/);
});

test('rebuilding a new world still permits its normal first opening',()=>{
 const s=save();s.activeRound=null;s.status='new';s.messages=[];s.snapshots=[];
 rebuild(s);
 assert.equal(s.status,'new');assert.match(s.messages.at(-1).content,/尚未正式开局/);
 Core.beginRound(s,'',true,'首次开局');
 assert.equal(s.activeRound.starting,true);assert.equal(s.snapshots.length,1);
});


test('rebuilt recap precedes historical narrative while current cache and continuation stay at the tail',()=>{
 const s=save();story(s);end(s);
 Core.beginRound(s,'前往街口',false,'本轮规则');
 const summaries=structuredClone(s.summaries);rebuild(s);
 assert.equal(s.messages[0].origin,'rebuilt-summaries');
 assert.equal(s.messages[0].round,1);
 assert.equal(s.messages.at(-1).origin,'context-rebuild');
 const sent=Core.context(s,'当前系统规则');
 assert.equal(sent[0].role,'system');
 assert.match(sent[1].content,/保留的前情摘要/);
 const storyIndex=sent.findIndex(m=>m.role==='assistant'&&m.content==='油布包裹出现在门边。');
 const actionIndex=sent.findIndex(m=>m.content.includes('前往街口'));
 assert.ok(storyIndex>1);assert.ok(actionIndex>storyIndex);
 assert.match(sent.at(-1).content,/上下文已重建/);
 assert.match(sent.at(-1).content,/保留的状态/);
 assert.deepEqual(s.summaries,summaries);
});

test('existing rebuilt saves with a tail recap get corrected on the next request without clearing history again',()=>{
 const s=save();story(s);end(s);rebuild(s);
 const recap=s.messages.shift();recap.round=s.activeRound.number;s.messages.push(recap);
 const original=structuredClone(s.messages);
 const sent=Core.context(s,'当前系统规则');
 assert.match(sent[1].content,/保留的前情摘要/);
 assert.equal(sent.filter(m=>m.content.includes('[保留的前情摘要]')).length,1);
 assert.match(sent.at(-1).content,/上下文已重建/);
 assert.deepEqual(s.messages,original);
});

test('cropping old rebuilt history injects only the boundary recap, without a duplicate summary at the tail',()=>{
 const s=save();story(s);end(s);rebuild(s);
 // Emulate an already saved legacy recap tagged with the last completed round.
 const recap=s.messages.shift();recap.round=2;s.messages.push(recap);
 s.summaries.push({round:2,content:'第二轮摘要'});
 Core.beginRound(s,'第二轮玩家行动',false,'第二轮规则');s.contextFromRound=2;
 const sent=Core.context(s,'当前系统规则');
 assert.match(sent[1].content,/前情提要/);
 assert.match(sent[1].content,/第1回合：发现包裹/);
 assert.equal(sent.filter(m=>m.content.includes('[保留的前情摘要]')).length,0);
 assert.equal(sent.filter(m=>m.content.includes('第1回合：发现包裹')).length,1);
 assert.ok(sent.findIndex(m=>m.content.includes('第二轮规则'))>1);
});
