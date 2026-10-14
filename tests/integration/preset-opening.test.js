'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Core=require('../../src/game-core'),Slots=require('../../src/game-slots');
const write=(s,name,text)=>VFS.writeFile(s.tree,'/workspace/'+name,text);
function setup(){const t=VFS.createTree();for(const role of ['Player-pc','AIPC-p2']){VFS.writeFile(t,'/workspace/'+role+'/基础信息.json','{"姓名":"测试","状态":{"HP":10,"MAXHP":10}}');VFS.writeFile(t,'/workspace/'+role+'/背包.json','[]');}const s=Core.createSave('预设',t);write(s,'模组.md','内部模组');return s;}
const stop=async()=>{throw Error('test-stop');};
const readPaths=s=>s.messages.flatMap(m=>m.tool_calls||[]).filter(c=>c.function.name==='read_multiple_files').flatMap(c=>JSON.parse(c.function.arguments).paths);
test('preset opening finishes round one through real tools without an AI request and defers preparation',async()=>{
 const s=setup();write(s,'预设第一回合.md','雨停了，站台上只剩你们。');write(s,'开局内部说明.md','暗中等待三回合');s.npcCardInstructions={'slot:p2':'擅长医学'};
 Core.beginRound(s,'',true,'原开局准备流程');await Core.run(s,()=>assert.fail('must not call AI'));
 assert.equal(s.round,1);assert.equal(s.cache.Story_Phase,'游戏前准备');assert.equal(s.activeRound.complete,true);assert.equal(s.activeRound.requestCount,0);assert.equal(readPaths(s).length,0);
 assert.equal(s.events.filter(e=>e.type==='story').length,1);assert.ok(s.events.some(e=>e.type==='round_end'));
 assert.ok(VFS.resolve(s.tree,['workspace','ROUND_CACHE.xml']));assert.equal(s.messages[0].content,'[开局内部说明]\n暗中等待三回合');
 assert.ok(!Slots.playerContext(Core.context(s,'固定系统')).some(m=>m.content.includes('暗中等待')));
 assert.doesNotMatch(JSON.stringify(Core.visibleEvents(s)),/暗中等待|原开局准备流程/);
 Core.beginRound(s,'调查站台',false,'推进流程',{presetFollowup:require('node:fs').readFileSync(require('node:path').join(__dirname,'../../assets/prompts/flow/preset_followup.md'),'utf8')});let sent;await assert.rejects(Core.run(s,async m=>{sent=m;return stop();},{system:'固定系统'}),/test-stop/);
 assert.equal(sent[0].content,'固定系统');
 assert.ok(sent.some(m=>m.content.includes('原开局准备流程')));assert.ok(sent.some(m=>m.content.includes('擅长医学')));assert.ok(sent.some(m=>m.content.includes('不要重复发布')));assert.equal(readPaths(s).length,5);
 const count=s.messages.length;await assert.rejects(Core.run(s,stop),/test-stop/);assert.equal(s.messages.length,count);
});
test('internal notes and extra reads work independently without skipping AI; old opening samples do not skip',async()=>{
 for(const options of ['note','reads','old']){const s=setup();if(options==='note')write(s,'开局内部说明.md','秘密');if(options==='reads'){write(s,'世界规则.md','规则');write(s,'开局预读.json',JSON.stringify({version:1,files:['世界规则.md','/workspace/世界规则.md','模组.md']}));}if(options==='old')write(s,'开场原文.txt','旧开场');Core.beginRound(s,'',true,'开局');await assert.rejects(Core.run(s,stop),/test-stop/);assert.equal(s.round,0);assert.equal(readPaths(s).filter(p=>p.endsWith('世界规则.md')).length,options==='reads'?1:0);}
});
test('invalid opening configuration fails before changing save state',()=>{
 for(const value of ['{','{"version":2,"files":[]}','{"version":1,"files":["../secret"]}','{"version":1,"files":["https://example.com/a"]}','{"version":1,"files":["/.reference/a"]}','{"version":1,"files":[3]}']){const s=setup();write(s,'开局预读.json',value);assert.throws(()=>Core.beginRound(s,'',true,'开局'),/开局预读/);assert.equal(s.status,'new');assert.equal(s.snapshots.length,0);}
});
test('preset tool batch resumes exactly once and rollback restores startup preparation',async()=>{
 const s=setup();write(s,'预设第一回合.md','公开开场');Core.beginRound(s,'',true,'准备');let once=false;
 await assert.rejects(Core.run(s,()=>assert.fail('AI'),{onStep:()=>{if(!once&&s.events.some(e=>e.type==='story')){once=true;throw Error('pause');}}}),/pause/);
 const restored=structuredClone(s);await Core.run(restored,()=>assert.fail('AI'));assert.equal(restored.round,1);assert.equal(restored.events.filter(e=>e.type==='story').length,1);
 Core.beginRound(restored,'行动',false,'推进');await assert.rejects(Core.run(restored,stop),/test-stop/);Core.rollback(restored);
 Core.beginRound(restored,'新行动',false,'推进');await assert.rejects(Core.run(restored,stop),/test-stop/);assert.ok(restored.messages.some(m=>m.round===2&&m.content==='准备'));
 Core.rollback(restored);Core.rollback(restored);assert.equal(restored.status,'new');assert.equal(restored.messages.length,0);assert.equal(restored.openingPending,undefined);Core.beginRound(restored,'',true,'准备');await Core.run(restored,()=>assert.fail('AI'));assert.equal(restored.events.filter(e=>e.type==='story').length,1);
});


test('preset preparation survives full save export/import and extra reads use current files',async()=>{
 const Import=require('../../src/game-import'),s=setup();write(s,'预设第一回合.md','公开开场');write(s,'开局预读.json',JSON.stringify({version:1,files:['规则.md']}));write(s,'规则.md','旧规则');
 Core.beginRound(s,'',true,'初始化要求');await Core.run(s,()=>assert.fail('AI'));
 const zip=Import.exportSave(s),restored=await Import.importSave({name:'save.zip',arrayBuffer:async()=>zip.arrayBuffer()});
 assert.equal(restored.openingPending.prompt,'初始化要求');write(restored,'规则.md','新规则');Core.beginRound(restored,'行动',false,'推进');let sent;
 await assert.rejects(Core.run(restored,async m=>{sent=m;return stop();}),/test-stop/);assert.ok(sent.some(m=>m.role==='tool'&&m.content.includes('新规则')));assert.ok(!sent.some(m=>m.role==='tool'&&m.content.includes('旧规则')));
});
test('failed preset tool can be repaired and resumed without requesting AI or duplicating story',async()=>{
 const s=setup();write(s,'预设第一回合.md','公开开场');write(s,'AIPC-p2/基础信息.json','{');Core.beginRound(s,'',true,'准备');
 await assert.rejects(Core.run(s,()=>assert.fail('AI')),/预设开场执行失败/);write(s,'AIPC-p2/基础信息.json','{"姓名":"修复角色"}');
 await Core.run(s,()=>assert.fail('AI'));assert.equal(s.round,1);assert.equal(s.events.filter(e=>e.type==='story').length,1);
});
test('players and all spectator perspectives receive the preset story but never internal startup data',async()=>{
 const Sync=require('../../src/multiplayer-sync'),s=setup();write(s,'预设第一回合.md','公开开场');write(s,'开局内部说明.md','暗中计划');Core.beginRound(s,'',true,'秘密准备');await Core.run(s,()=>assert.fail('AI'));
 for(const permission of ['player','none','all','pc']){const member=permission==='player'?{actorId:'pc'}:{role:'spectator',permission,perspective:permission},room={roomId:'room',epoch:0,roundId:'r2',status:'collecting',members:{guest:{...member,bindingVersion:1,connected:true}},submissions:{}};
 const host=Sync.createHost({getSave:()=>s,getRoom:()=>room}),packet=await host.sync('guest');assert.match(JSON.stringify(packet),/公开开场/);assert.doesNotMatch(JSON.stringify(packet),/暗中计划|秘密准备|openingPending|read_multiple_files/);assert.equal(packet.view.round,1);}
});
