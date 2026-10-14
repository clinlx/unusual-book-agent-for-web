'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Core=require('../../src/game-core');
function setup(){
 const tree=VFS.createTree();for(const role of ['Player-pc','Player-p2','AIPC-p3','DISABLE-p4']){
  VFS.writeFile(tree,'/workspace/'+role+'/基础信息.json',JSON.stringify({姓名:role,HP:10,'.秘密':role+'秘密'}));
  VFS.writeFile(tree,'/workspace/'+role+'/背包.json',JSON.stringify([{名称:role+'物品'}]));
 }
 VFS.writeFile(tree,'/workspace/模组.md','模组开局信息');VFS.writeFile(tree,'/workspace/故事.txt','备用故事');
 return Core.createSave('自动预读',tree);
}
const stop=async()=>{throw Error('test-stop');};
const calls=s=>s.messages.flatMap(m=>m.tool_calls||[]).filter(c=>c.function.name==='read_multiple_files');
const results=s=>s.messages.filter(m=>m.role==='tool').flatMap(m=>JSON.parse(m.content).result||[]);
test('opening preload supplies real bounded tool results before the first model request and authorizes writes',async()=>{
 const s=setup();Core.beginRound(s,'',true,'开局流程');let sent;
 await assert.rejects(Core.run(s,async messages=>{sent=messages;throw Error('test-stop');},{system:'固定系统提示词'}),/test-stop/);
 assert.equal(sent[0].content,'固定系统提示词');assert.equal(calls(s).length,1);
 const paths=JSON.parse(calls(s)[0].function.arguments).paths;
 assert.equal(paths.length,7);assert.ok(paths.includes('/workspace/模组.md'));assert.ok(!paths.some(p=>/DISABLE|故事.txt/.test(p)));
 assert.equal(results(s).find(r=>r.path==='/workspace/模组.md').content,'模组开局信息');
 const assistant=sent.find(m=>m.tool_calls?.some(c=>c.id===calls(s)[0].id));assert.ok(assistant);assert.ok(sent.some(m=>m.role==='tool'&&m.tool_call_id===calls(s)[0].id));
 const profile='/workspace/AIPC-p3/基础信息.json';assert.equal(Core.execute(s,'apply_patch',{path:profile,old_str:'10',new_str:'11'}).ok,true);
 assert.equal(s.events.filter(e=>['story','player'].includes(e.type)).length,0);
 const count=s.messages.length;await assert.rejects(Core.run(s,stop),/test-stop/);assert.equal(s.messages.length,count,'resume must not append another preload');assert.equal(calls(s).length,1);
});
test('preload batches recover exactly once after interruption before a read receipt',async()=>{
 const s=setup();Core.beginRound(s,'',true,'开局');let interrupted=false;
 await assert.rejects(Core.run(s,stop,{onStep:()=>{if(!interrupted&&calls(s).length&&!results(s).length){interrupted=true;throw Error('pause-before-read');}}}),/pause-before-read/);
 const restored=structuredClone(s);await assert.rejects(Core.run(restored,stop),/test-stop/);
 assert.equal(calls(restored).length,1);assert.equal(results(restored).length,7);assert.equal(restored.events.filter(e=>e.name==='read_multiple_files').length,1);
});
test('preload falls back to story, preserves per-file errors, and leaves large files explicitly truncated',async()=>{
 const s=setup();delete s.tree.children.workspace.children['模组.md'];
 VFS.writeFile(s.tree,'/workspace/故事.txt','长'.repeat(100000));delete s.tree.children.workspace.children['Player-p2'].children['背包.json'];
 Core.beginRound(s,'',true,'开局');await assert.rejects(Core.run(s,stop),/test-stop/);
 const all=results(s),story=all.find(r=>r.path==='/workspace/故事.txt');assert.equal(story.truncated,true);assert.equal(story.totalLength,100000);assert.ok(all.reduce((n,r)=>n+(r.content?.length||0),0)<=64000);assert.ok(all.find(r=>r.path.endsWith('Player-p2/背包.json')).error);
 assert.ok(all.find(r=>r.path.endsWith('AIPC-p3/基础信息.json')).content);
});
test('ordinary rounds and already-running opening sessions do not receive a new preload',async()=>{
 for(const kind of ['ordinary','existing']){const s=setup();Core.beginRound(s,'行动',kind==='existing','流程');if(kind==='existing')s.messages.push({role:'assistant',content:'已经开始处理',round:1});await assert.rejects(Core.run(s,stop),/test-stop/);assert.equal(calls(s).length,0);}
});


test('large rosters respect the tool batch cap and retain freshness checks after preloading',async()=>{
 const s=setup();for(let n=5;n<18;n++){VFS.writeFile(s.tree,`/workspace/AIPC-p${n}/基础信息.json`,'{"姓名":"NPC"}');VFS.writeFile(s.tree,`/workspace/AIPC-p${n}/背包.json`,'[]');}
 Core.beginRound(s,'',true,'开局');await assert.rejects(Core.run(s,stop),/test-stop/);
 assert.equal(calls(s).length,2);assert.ok(calls(s).every(c=>JSON.parse(c.function.arguments).paths.length<=20));assert.equal(results(s).length,33);
 const target='/workspace/Player-pc/基础信息.json';VFS.writeFile(s.tree,target,'{"姓名":"已改变"}');assert.equal(Core.execute(s,'write_file',{path:target,content:'{}'}).ok,false);
});

test('rollback to a fresh save preloads the current files again without keeping old opening messages',async()=>{
 const s=setup();Core.beginRound(s,'',true,'开局');await assert.rejects(Core.run(s,stop),/test-stop/);
 const before=calls(s)[0].id;Core.rollback(s);assert.equal(calls(s).length,0);
 VFS.writeFile(s.tree,'/workspace/模组.md','修订后的模组');Core.beginRound(s,'',true,'开局');await assert.rejects(Core.run(s,stop),/test-stop/);
 assert.notEqual(calls(s)[0].id,before);assert.equal(results(s).find(r=>r.path==='/workspace/模组.md').content,'修订后的模组');
});
