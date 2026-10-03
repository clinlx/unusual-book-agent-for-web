'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const VFS=require('../src/vfs.js');
const Core=require('../src/game-core.js');

test('failed tool rolls back only its own partial file changes and records failure',()=>{
 const s=save();Core.beginRound(s,'',true,'start');Core.execute(s,'write_file',{path:'/workspace/kept.txt',content:'keep'},'kept');
 const original=VFS.writeFile;VFS.writeFile=(...args)=>{original(...args);throw Error('injected after mutation');};
 try{const result=Core.execute(s,'write_file',{path:'/workspace/partial.txt',content:'partial'},'partial');assert.equal(result.ok,false);}finally{VFS.writeFile=original;}
 assert.equal(VFS.resolve(s.tree,['workspace','partial.txt']),null);
 assert.equal(VFS.resolve(s.tree,['workspace','kept.txt']).content,'keep');
 assert.deepEqual(s.events.find(e=>e.callId==='partial').fileChanges,[]);
 assert.equal(s.events.find(e=>e.callId==='kept').fileChanges[0].path,'/workspace/kept.txt');
});

test('missing tool reply uses committed receipt and does not repeat the mutation',async()=>{
 const s=save();Core.beginRound(s,'',true,'start');
 const tc=call('write_file',{path:'/workspace/proof.txt',content:'first'},'proof');
 s.messages.push({role:'assistant',round:1,tool_calls:[tc]});Core.execute(s,tc.function.name,JSON.parse(tc.function.arguments),tc.id);
 VFS.writeFile(s.tree,'/workspace/proof.txt','later manual change');
 await Core.run(s,async()=>({tool_calls:[call('append_story',{content:'story',one_line_summary_of_content:'summary'},'story'),call('end_the_round',{NEXT_TURN_CACHE:cache},'end')]}));
 assert.equal(VFS.resolve(s.tree,['workspace','proof.txt']).content,'later manual change');
 assert.equal(s.messages.filter(m=>m.tool_call_id==='proof').length,1);
 assert.equal(s.events.filter(e=>e.callId==='proof').length,1);
});
const cache={Story_Phase:'游戏循环'};
test('flow injection follows recovered replies and only labels cache at a truncated boundary',async()=>{
 const s=save();Core.beginRound(s,'',true,'start');s.cache={Story_Phase:'游戏循环'};
 const tc=call('generate_random_number',{min_val:1,max_val:1},'pending');s.messages.push({role:'assistant',round:1,tool_calls:[tc]});
 await Core.run(s,async messages=>{
  const tool=messages.findIndex(m=>m.tool_call_id==='pending'),resume=messages.findIndex(m=>m.content==='custom resume');
  assert.ok(tool>=0&&resume>tool);assert.equal(messages.some(m=>m.content.startsWith('custom cache\n')),false);
  return {tool_calls:[call('append_story',{content:'story',one_line_summary_of_content:'summary'},'story'),call('end_the_round',{NEXT_TURN_CACHE:cache},'end')]};
 },{resumePrompt:'custom resume',cachePrompt:'custom cache'});
 const old=save();old.messages=[{role:'assistant',content:'',round:1,tool_calls:[call('end_the_round',{NEXT_TURN_CACHE:{marker:'boundary'}},'end1')]},{role:'tool',content:'{"ok":true}',round:1,tool_call_id:'end1'},{role:'user',content:'turn2',round:2}];old.round=2;old.contextFromRound=2;old.summaries=[{round:1,content:'summary'}];old.cache={marker:'latest'};
 const messages=Core.context(old,'system',128000,{summariesPrompt:'custom summaries',cachePrompt:'custom cache'});
 assert.ok(messages.some(m=>m.content.startsWith('custom summaries\n')));
 assert.equal(messages.find(m=>m.content.startsWith('custom cache\n')).content,'custom cache\n{"marker":"boundary"}');
});
function save(){const t=VFS.createTree();VFS.writeFile(t,'/workspace/Player-p1/基础信息.json','{"姓名":"主角"}');VFS.writeFile(t,'/workspace/Player-p1/背包.json','["key"]');VFS.writeFile(t,'/workspace/存档-索引-物品/key/物品基础信息.json','{"名称":"隐藏钥匙",".是否对玩家隐藏":true}');return Core.createSave('review',t);}
function call(name,args,id){return {id,type:'function',function:{name,arguments:JSON.stringify(args)}};}
test('referenced hidden inventory entries do not appear in play panels',()=>{assert.equal(Core.player(save()).items.length,0);});
test('canonical aliases cannot bypass unique player directory protection',()=>{
 for(const suffix of ['/','/.','//']){const s=save();Core.beginRound(s,'',true,'start');assert.equal(Core.execute(s,'delete',{path:s.playerPath+suffix}).ok,false,suffix);assert.doesNotThrow(()=>Core.validateTree(s.tree));}
});
test('recursive deletion requires current reads of all descendant text files',()=>{
 const s=save();VFS.writeFile(s.tree,'/workspace/clues/secret.txt','irreplaceable');Core.beginRound(s,'',true,'start');
 assert.equal(Core.execute(s,'delete',{path:'/workspace/clues'}).ok,false);
 assert.ok(VFS.resolve(s.tree,['workspace','clues','secret.txt']));
});
test('resume after a durable end does not leave completed round running',async()=>{
 const s=save();Core.beginRound(s,'',true,'start');Core.execute(s,'append_story',{content:'story',one_line_summary_of_content:'summary'});Core.execute(s,'end_the_round',{NEXT_TURN_CACHE:cache});
 await Core.run(s,async()=>{throw Error('should not request model');});assert.equal(s.status,'waiting');
});
test('provider call IDs can be reused in a later round without skipping its calls',async()=>{
 const s=save();
 for(let i=0;i<2;i++){Core.beginRound(s,'',true,'start');await Core.run(s,async()=>({tool_calls:[call('append_story',{content:'story '+i,one_line_summary_of_content:'summary'},'call_0'),call('end_the_round',{NEXT_TURN_CACHE:cache},'call_1')]}),{maxToolLoops:1});}
 assert.equal(s.round,2);assert.equal(s.events.filter(e=>e.type==='story').length,2);
});
test('difficulty class preserves reference formula and truncation',()=>{
 const s=save();Core.beginRound(s,'',true,'start');
 for(const [subject_value,target_value,expected] of [[10,100,-10],[100,10,30],[10,10,10],[20,10,19],[10,20,0]]){
  const r=Core.execute(s,'calculate_difficulty_class',{subject_value,target_value});assert.equal(r.result.calculated_dc,expected);
 }
});
test('abort after end can resume remaining protocol results without applying later writes',async()=>{
 const s=save();Core.beginRound(s,'',true,'start');let aborted=false;
 const transport=async()=>({tool_calls:[call('append_story',{content:'story',one_line_summary_of_content:'summary'},'a'),call('end_the_round',{NEXT_TURN_CACHE:cache},'e'),call('write_file',{path:'/workspace/late.txt',content:'must not write'},'w')]});
 await assert.rejects(Core.run(s,transport,{signal:{get aborted(){return aborted;}},onStep:async()=>{if(s.activeRound.complete)aborted=true;}}),/中止/);
 assert.equal(s.messages.filter(m=>m.role==='tool').length,2);
 await Core.run(s,async()=>{throw Error('should not resend completed round');});
 assert.equal(s.status,'waiting');assert.equal(s.messages.filter(m=>m.role==='tool').length,3);
 assert.equal(VFS.resolve(s.tree,['workspace','late.txt']),null);assert.equal(s.events.filter(e=>e.type==='round_end').length,1);
});
