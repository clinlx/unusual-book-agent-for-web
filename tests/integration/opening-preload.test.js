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
const results=s=>{const ids=new Set(calls(s).map(c=>c.id));return s.messages.filter(m=>m.role==='tool'&&ids.has(m.tool_call_id)).flatMap(m=>JSON.parse(m.content).result||[]);};

test('opening supplies one bounded depth-four tree before reads and resumes without repeating it',async()=>{
 const s=setup();VFS.writeFile(s.tree,'/workspace/线索/一/二/三/四/深处.txt','内容无需预读');Core.beginRound(s,'',true,'开局');let paused=false;
 const treeCalls=save=>save.messages.flatMap(m=>m.tool_calls||[]).filter(c=>c.function.name==='tree');
 await assert.rejects(Core.run(s,stop,{onStep:()=>{
  if(!paused&&s.events.some(e=>e.name==='tree'&&e.success)){paused=true;throw Error('pause-after-tree');}
 }}),/pause-after-tree/);
 const restored=structuredClone(s);let sent;
 await assert.rejects(Core.run(restored,async messages=>{sent=messages;return stop();}),/test-stop/);
 assert.equal(treeCalls(restored).length,1);assert.equal(restored.events.filter(e=>e.name==='tree').length,1);
 assert.deepEqual(JSON.parse(treeCalls(restored)[0].function.arguments),{path:'/workspace',depth:4});
 const record=JSON.parse(sent.find(m=>m.content.startsWith('[开局预读资料]\n')).content.split('\n').slice(1).join('\n'));
 assert.equal(record.operations[0].name,'tree');const listing=record.operations[0].result.result;
 assert.equal(listing.depth,4);assert.equal(listing.truncated,true);assert.match(listing.tree,/模组.md|线索/);assert.ok(!listing.tree.includes('深处.txt'));
 assert.ok(!restored.activeRound.readState['/workspace/线索/一/二/三/四/深处.txt'],'directory listing does not authorize file overwrite');
 assert.equal(Core.visibleEvents(restored).some(e=>e.name==='tree'),false);
 await assert.rejects(Core.run(restored,stop),/test-stop/);assert.equal(treeCalls(restored).length,1);
});
test('opening preload supplies real bounded tool results before the first model request and authorizes writes',async()=>{
 const s=setup();Core.beginRound(s,'',true,'开局流程');let sent;
 await assert.rejects(Core.run(s,async messages=>{sent=messages;throw Error('test-stop');},{system:'固定系统提示词'}),/test-stop/);
 assert.equal(sent[0].content,'固定系统提示词');assert.equal(calls(s).length,1);
 const paths=JSON.parse(calls(s)[0].function.arguments).paths;
 assert.equal(paths.length,7);assert.ok(paths.includes('/workspace/模组.md'));assert.ok(!paths.some(p=>/DISABLE|故事.txt/.test(p)));
 assert.equal(results(s).find(r=>r.path==='/workspace/模组.md').content,'模组开局信息');
 const preload=sent.find(m=>m.content.startsWith('[开局预读资料]\n'));assert.equal(preload.role,'user');
 const record=JSON.parse(preload.content.split('\n').slice(1).join('\n')),read=record.operations.find(op=>op.name==='read_multiple_files');assert.deepEqual(read.arguments,JSON.parse(calls(s)[0].function.arguments));assert.deepEqual(read.result,JSON.parse(s.messages.find(m=>m.tool_call_id===calls(s)[0].id).content));
 assert.ok(!sent.some(m=>m.tool_calls||m.role==='tool'));
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
 const message=Core.context(s,'').find(m=>m.content.startsWith('[开局预读资料]\n')),record=JSON.parse(message.content.split('\n').slice(1).join('\n'));
 assert.deepEqual(record.operations.find(op=>op.name==='read_multiple_files').result.result,all);
});
test('ordinary rounds and already-running opening sessions do not receive a new preload',async()=>{
 for(const kind of ['ordinary','existing']){const s=setup();Core.beginRound(s,'行动',kind==='existing','流程');if(kind==='existing')s.messages.push({role:'assistant',content:'已经开始处理',round:1});await assert.rejects(Core.run(s,stop),/test-stop/);assert.equal(calls(s).length,0);}
});

test('disabling preload skips automatic reads and ignores opening read configuration',async()=>{
 for(const config of ['{','{"version":1,"files":["missing.md"]}']){
  const s=setup();VFS.writeFile(s.tree,'/workspace/开局预读.json',config);VFS.writeFile(s.tree,'/workspace/开局内部说明.md','仍然生效的内部说明');
  Core.beginRound(s,'',true,'开局',{openingPreload:false});let sent;
  await assert.rejects(Core.run(s,async messages=>{sent=messages;return stop();},{openingPreload:false}),/test-stop/);
  assert.equal(calls(s).length,0);assert.equal(results(s).length,0);assert.deepEqual(s.activeRound.openingExtraReads,[]);
  assert.ok(sent.some(m=>m.role==='user'&&m.content==='[开局内部说明]\n仍然生效的内部说明'));
  assert.ok(!sent.some(m=>m.content.startsWith('[开局预读资料]')));
  assert.equal(Core.execute(s,'write_file',{path:'/workspace/Player-pc/基础信息.json',content:'{}'}).ok,false,'disabled preload must not authorize writes');
 }
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

test('restored startup records project without mutating history and preserve model tool reasoning',async()=>{
 const s=setup();Core.beginRound(s,'',true,'开局');await assert.rejects(Core.run(s,stop),/test-stop/);
 const restored=JSON.parse(JSON.stringify(s)),localId=calls(restored)[0].id;
 // Providers can reuse a local call ID in a later round; only the local receipt is projected.
 restored.messages.push({role:'assistant',content:'检查文件',round:2,reasoning_content:'模型真实思考',tool_calls:[{id:localId,type:'function',function:{name:'read_file',arguments:'{"path":"/workspace/模组.md"}'}}]},
  {role:'tool',round:2,tool_call_id:localId,content:'{"ok":true,"result":{"content":"真实调用回执"}}'});
 const before=structuredClone(restored),sent=Core.context(restored,'固定规则');
 assert.deepEqual(restored,before);assert.deepEqual(Core.context(restored,'固定规则'),sent);
 assert.equal(sent.filter(m=>m.tool_calls).length,1);assert.equal(sent.find(m=>m.tool_calls).reasoning_content,'模型真实思考');
 assert.equal(sent.filter(m=>m.role==='tool').length,1);assert.match(sent.find(m=>m.role==='tool').content,/真实调用回执/);
});

test('DeepSeek-shaped streaming and non-streaming requests accept preload data and replay real reasoning',async()=>{
 const Transport=require('../../src/game-transport');
 for(const stream of [false,true]){
  const s=setup();Core.beginRound(s,'',true,'开局');let requests=0;
  const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
  const transport=Transport.create({baseUrl:'https://api.deepseek.com',model:'deepseek-reasoner',stream,reasoningEffort:'high'},[{type:'function',function:{name:'read_file'}}],{
   fetch:async(_url,init)=>{
    const body=JSON.parse(init.body);requests++;assert.equal(body.thinking.type,'enabled');
    assert.ok(body.messages.some(m=>m.role==='user'&&m.content.startsWith('[开局预读资料]\n')));
    for(const m of body.messages.filter(m=>m.tool_calls))assert.equal(m.reasoning_content,'保留模型思考');
    if(requests===1)assert.ok(!body.messages.some(m=>m.tool_calls||m.role==='tool'));
    else {assert.equal(requests,2);assert.equal(body.messages.find(m=>m.role==='tool').tool_call_id,'model-read');}
    const message={content:'',reasoning_content:'保留模型思考',tool_calls:requests===1?[tool('model-read','read_file',{path:'/workspace/模组.md'})]:[
     tool('story','append_story',{content:'开场正文',one_line_summary_of_content:'开场'}),tool('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]};
    return stream?new Response('data: '+JSON.stringify({choices:[{delta:{...message,tool_calls:message.tool_calls.map((c,index)=>({...c,index}))},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n'):
     new Response(JSON.stringify({choices:[{message,finish_reason:'tool_calls'}]}));
   }
  });
  await Core.run(s,transport);assert.equal(requests,2);assert.equal(s.status,'waiting');
  assert.equal(s.events.filter(e=>e.type==='story').length,1);
 }
});


test('retired journals are skipped in legacy opening lists without deleting historical files or fictional diaries',async()=>{
 const s=setup(),journal='/workspace/Player-pc/日志.txt',diary='/workspace/线索/航海日记.txt';
 VFS.writeFile(s.tree,journal,'旧存档独有经历');VFS.writeFile(s.tree,diary,'剧情线索');
 VFS.writeFile(s.tree,'/workspace/开局预读.json',JSON.stringify({version:1,files:[journal,'存档-世界/世界日志.txt','物品/物品日志.txt','场景/场景日志.txt',diary]}));
 Core.beginRound(s,'',true,'开局');
 // A restored round can still carry a list created by an older build.
 s.activeRound.openingExtraReads.push(journal);
 await assert.rejects(Core.run(s,stop),/test-stop/);
 const paths=calls(s).flatMap(c=>JSON.parse(c.function.arguments).paths);
 assert.ok(!paths.some(p=>p.endsWith('日志.txt')));assert.ok(paths.includes(diary));
 assert.equal(VFS.resolve(s.tree,VFS.normalize(journal)).content,'旧存档独有经历');
});
