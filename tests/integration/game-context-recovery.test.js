'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Core=require('../../src/game-core');
const Transport=require('../../src/game-transport');
const VFS=require('../../src/vfs');
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
function save(){
  const tree=VFS.createTree();
  VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"玩家"}');
  VFS.writeFile(tree,'/workspace/Player-p/背包.json','[]');
  const s=Core.createSave('上下文恢复',tree);Core.beginRound(s,'',true,'本轮任务');return s;
}
const finish=()=>({tool_calls:[call('story','append_story',{content:'旅程继续。',one_line_summary_of_content:'继续旅程'}),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]});
const file=(s,path)=>VFS.resolve(s.tree,VFS.normalize(path))?.content;
function validProtocol(messages){
  const replied=new Set();
  for(let i=0;i<messages.length;i++){
    if(messages[i].role==='tool')assert.ok(replied.has(i),'no orphan tool replies');
    const ids=messages[i].tool_calls?.map(c=>c.id);if(!ids?.length)continue;
    assert.deepEqual(messages.slice(i+1,i+1+ids.length).map(m=>m.tool_call_id),ids);
    for(let j=1;j<=ids.length;j++)replied.add(i+j);
  }
}

test('current-round large reads automatically fit and retain an exact readable snapshot',async()=>{
  const s=save(),text='线索'.repeat(6000)+'原始结尾';VFS.writeFile(s.tree,'/workspace/large.txt',text);
  let requests=0,original;
  await Core.run(s,async messages=>{
    requests++;assert.ok(Core.estimate(messages)<=2400);validProtocol(messages);
    if(requests===1)return {tool_calls:[call('read','read_file',{path:'/workspace/large.txt',limit:120000})]};
    original=s.messages.find(m=>m.tool_call_id==='read').content;
    const compact=JSON.parse(messages.find(m=>m.tool_call_id==='read').content);
    assert.equal(compact.archived,true);assert.equal(file(s,compact.archive_path),original);
    assert.ok(compact.preview.length<=1000);assert.equal(compact.next_offset,compact.preview.length);
    assert.match(compact.note,/offset|limit/);
    const read=Core.execute(s,'read_file',{path:compact.archive_path,offset:compact.next_offset,limit:100},'chunk');
    assert.equal(read.result.content,original.slice(compact.next_offset,compact.next_offset+100));
    return finish();
  },{system:'规则',cap:2400});
  assert.equal(requests,2);assert.equal(s.status,'waiting');
  assert.equal(JSON.parse(original).result.content,text);
  assert.equal(s.messages.find(m=>m.tool_call_id==='read').content,original);
});

test('oversized completed batches including thinking and writes resume through a checkpoint without replay',async()=>{
  const s=save();let requests=0,original;
  await Core.run(s,async messages=>{
    requests++;assert.ok(Core.estimate(messages)<=2000);validProtocol(messages);
    if(requests===1)return {reasoning:'思考'.repeat(6000),tool_calls:[call('write','write_file',{path:'/workspace/proof.txt',content:'成品'.repeat(5000)})]};
    original=structuredClone(s.messages);VFS.writeFile(s.tree,'/workspace/proof.txt','手动修改');
    const checkpoint=messages.find(m=>m.content.startsWith('[本回合执行记录]'));
    assert.ok(checkpoint);const progress=JSON.parse(checkpoint.content.slice(checkpoint.content.indexOf('\n')+1));
    assert.equal(progress.triggered,true);assert.equal(progress.published,0);
    const index=JSON.parse(file(s,progress.archive_path));
    assert.deepEqual(JSON.parse(file(s,index[0].path)),original.slice(1));
    assert.ok(messages.some(m=>m.content==='本轮任务'));assert.ok(!messages.some(m=>m.tool_calls?.some(c=>c.id==='write')));
    return finish();
  },{system:'规则',cap:2000});
  assert.equal(s.status,'waiting');assert.equal(requests,2);assert.equal(file(s,'/workspace/proof.txt'),'手动修改');
  assert.equal(s.events.filter(e=>e.callId==='write').length,1);
  assert.deepEqual(s.messages.slice(0,original.length),original);
});

test('context repair leaves fitting tool reasoning and incomplete tool batches intact',()=>{
  const s=save(),message={role:'assistant',round:1,reasoning_content:'必须保留的思考',tool_calls:[call('pending','read_file',{path:'/workspace/large.txt'})]};
  s.messages.push(message);
  assert.equal(Core.context(s,'规则',1000).at(-1).reasoning_content,message.reasoning_content);
  assert.throws(()=>Core.context(s,'规'.repeat(2000),500),e=>e.code==='CONTEXT_LIMIT'&&e.used>e.cap);
  assert.deepEqual(s.messages.at(-1),message);
});

test('repeated resume failures do not accumulate identical recovery prompts or error events',async()=>{
  const s=save();
  for(let i=0;i<3;i++)await assert.rejects(Core.run(s,async()=>{throw Error('不应发请求');},{system:'规'.repeat(2000),cap:500,resumePrompt:'继续当前任务'}),/上下文上限/);
  assert.equal(s.messages.filter(m=>m.content==='继续当前任务').length,1);
  assert.equal(s.events.filter(e=>e.type==='error').length,1);
});

test('provider context rejection retries with a smaller repaired request and does not repeat tools',async()=>{
  const s=save();let requests=0;const sizes=[];
  const transport=Transport.create({baseUrl:'https://context.invalid/v1',maxContextK:20,maxOutputTokens:100,stream:false},[],{
    fetch:async(_url,init)=>{
      requests++;const messages=JSON.parse(init.body).messages;sizes.push(Core.estimate(messages));validProtocol(messages);
      if(requests===1)return new Response(JSON.stringify({choices:[{message:{tool_calls:[call('write','write_file',{path:'/workspace/proof.txt',content:'结果'.repeat(2500)})]}}]}));
      if(requests===2)return new Response('{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}',{status:400});
      return new Response(JSON.stringify({choices:[{message:finish()}]}));
    }
  });
  await Core.run(s,transport,{system:'规则',cap:19900});
  assert.equal(requests,3);assert.ok(sizes[2]<sizes[1]);assert.equal(s.status,'waiting');
  assert.equal(s.events.filter(e=>e.callId==='write').length,1);
});

test('final budget diagnostics distinguish messages, tools and maximum output from previous usage',async()=>{
  const tools=[{type:'function',function:{name:'test',description:'工具'.repeat(500),parameters:{}}}];
  const run=Transport.create({baseUrl:'https://context.invalid/v1',maxContextK:4,maxOutputTokens:16384,stream:false},tools,{fetch:async()=>{throw Error('不应发请求');}});
  await assert.rejects(run([{role:'user',content:'任务'}]),e=>{
    assert.equal(e.code,'CONTEXT_LIMIT');assert.equal(e.budget.output,16384);assert.equal(e.budget.limit,4000);
    assert.equal(e.budget.tools,Core.estimate(tools));assert.equal(e.budget.total,e.budget.input+e.budget.tools+16384);
    assert.match(e.message,/预留输出 16384/);return true;
  });
});

test('recovery archives are reused, keep later edits intact and disappear on round rollback',async()=>{
  const s=save();VFS.writeFile(s.tree,'/workspace/large.txt','线索'.repeat(4000));
  const read=call('read','read_file',{path:'/workspace/large.txt'});
  s.messages.push({role:'assistant',round:1,tool_calls:[read]});
  s.messages.push({role:'tool',round:1,tool_call_id:read.id,content:JSON.stringify(Core.execute(s,'read_file',JSON.parse(read.function.arguments),read.id))});
  const original=structuredClone(s.messages),first=Core.context(s,'规则',2400);
  const path=JSON.parse(first.find(m=>m.tool_call_id==='read').content).archive_path;
  const filesBefore=Object.keys(Core.flatten(s.tree));
  assert.deepEqual(Core.context(s,'规则',2400),first);assert.deepEqual(Object.keys(Core.flatten(s.tree)),filesBefore);
  VFS.writeFile(s.tree,path,'用户保存的内容');
  const next=Core.context(s,'规则',2400),other=JSON.parse(next.find(m=>m.tool_call_id==='read').content).archive_path;
  assert.notEqual(other,path);assert.equal(file(s,path),'用户保存的内容');assert.equal(file(s,other),original.at(-1).content);
  assert.deepEqual(Core.context(s,'规则',2400),next);
  assert.deepEqual(s.messages,original);
  Core.rollback(s);assert.ok(!Object.keys(Core.flatten(s.tree)).some(p=>p.includes('Context_Round_')));
});

test('emergency checkpoints retain frozen actions, trigger plan, published progress and dice outcomes',()=>{
  const s=save(),plan={Countdowns:'钟声还剩两次',Pending_Triggers:[{Event:'门口的来客'}],Forced_Checks:'已完成侦查'};
  s.activeRound.action='去门口';s.activeRound.actions=[{actorId:'p',content:'等候',privateContent:'察看钥匙'}];
  const calls=[call('trigger','trigger_next_round',{phase_plan:plan}),
    call('dice','roll_dice',{description:'确认动静',roller:'p',related_attr:'侦查',is_secret:false,dice_dict:{侦查:'1d100'},calculate_only:false,target_value:60,compare_mode:'le',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{}}),
    call('story','append_story',{content:'你已到达门口。',one_line_summary_of_content:'到达门口'})];
  s.messages.push({role:'assistant',round:1,reasoning_content:'推理'.repeat(6000),tool_calls:calls});
  for(const c of calls)s.messages.push({role:'tool',round:1,tool_call_id:c.id,content:JSON.stringify(Core.execute(s,c.function.name,JSON.parse(c.function.arguments),c.id,{random:()=>.2}))});
  const state=structuredClone(s.activeRound),out=Core.context(s,'规则',2000);validProtocol(out);
  const progress=JSON.parse(out.find(m=>m.content.startsWith('[本回合执行记录]')).content.split('\n').slice(1).join('\n'));
  assert.deepEqual(progress.actions,state.actions);assert.equal(progress.action,'去门口');assert.deepEqual(progress.phase_plan,plan);
  assert.equal(progress.published,1);assert.deepEqual(progress.summary,['到达门口']);
  assert.equal(progress.recent_calls.find(c=>c.id==='dice').dice.total,21);
  assert.deepEqual(s.activeRound,state);
});

test('API rate limits and fixed custom messages do not cause context recovery retries',async()=>{
  for(const [status,body]of [[429,'{"error":{"message":"tokens per minute rate limit exceeded"}}'],[400,'{"error":{"code":"context_length_exceeded"}}']]){
    const s=save();let requests=0;
    s.messages.push({role:'assistant',round:1,content:'思考'.repeat(4000)});
    const run=Transport.create({baseUrl:'https://context.invalid/v1',maxContextK:20,maxOutputTokens:100,stream:false,maxRetries:0,
      customRequestBody:JSON.stringify({messages:[{role:'user',content:'固定内容'}]})},[],{fetch:async()=>{requests++;return new Response(body,{status});}});
    await assert.rejects(Core.run(s,run,{system:'规则',cap:19000}));
    assert.equal(requests,1);
  }
});

test('oversized turn input is moved to a readable file without hiding the next requested chunk',async()=>{
  const s=save(),input='玩家行动：'+ '观察房间。'.repeat(2400)+'最后确认窗户';
  s.messages[0].content=input;
  const original=structuredClone(s.messages);let requests=0,archive;
  await Core.run(s,async messages=>{
    requests++;assert.ok(Core.estimate(messages)<=2400);validProtocol(messages);
    const index=JSON.parse(messages.find(m=>m.content.startsWith('[上下文资料索引]')).content.split('\n').slice(1).join('\n'));
    archive=index.archive_path;
    assert.equal(JSON.parse(file(s,archive))[0].content,input);
    assert.match(index.instruction,/玩家行动|受众/);
    if(requests===1)return {tool_calls:[call('input-chunk','read_file',{path:archive,offset:0,limit:300})]};
    const reply=JSON.parse(messages.find(m=>m.tool_call_id==='input-chunk').content);
    assert.equal(reply.result.content,file(s,archive).slice(0,300));
    return finish();
  },{system:'规则',cap:2400});
  assert.equal(s.status,'waiting');assert.equal(requests,2);
  assert.deepEqual(s.messages.slice(0,original.length),original);
});

test('oversized restored summaries and boundary cache cannot block the next turn locally',()=>{
  const s=save(),cache={Story_Phase:'游戏循环',Event:'线索'.repeat(6000)+'缓存结尾'};
  s.activeRound.number=2;s.messages[0].round=2;s.contextFromRound=2;
  s.summaries=[{round:1,content:'前情'.repeat(6000)+'前情结尾'}];
  s.snapshots.push({round:1,cache});
  const original=structuredClone(s),sent=Core.context(s,'规则',2400);validProtocol(sent);
  assert.ok(Core.estimate(sent)<=2400);assert.equal(sent[0].content,'规则');
  const index=JSON.parse(sent.find(m=>m.content.startsWith('[上下文资料索引]')).content.split('\n').slice(1).join('\n'));
  const stored=JSON.parse(file(s,index.archive_path));
  assert.match(stored[0].content,/前情结尾/);
  assert.deepEqual(JSON.parse(stored[1].content.split('\n').slice(1).join('\n')),cache);
  assert.equal(stored.at(-1).content,'本轮任务');
  assert.deepEqual(s.messages,original.messages);assert.deepEqual(s.summaries,original.summaries);
  assert.deepEqual(Core.context(s,'规则',2400),sent);
});

test('a large recovery checkpoint is itself recoverable and preserves the full execution state',()=>{
  const s=save(),action='寻找线索'.repeat(3000),summary='已经调查'.repeat(3000);
  s.activeRound.action=action;s.activeRound.actions=[{actorId:'p',content:action,privateContent:'私密行动'}];
  s.activeRound.summary=[summary];s.activeRound.published=1;
  const write=call('write','write_file',{path:'/workspace/proof.txt',content:'结果'.repeat(4000)});
  s.messages.push({role:'assistant',round:1,tool_calls:[write]});
  s.messages.push({role:'tool',round:1,tool_call_id:write.id,content:JSON.stringify(Core.execute(s,'write_file',JSON.parse(write.function.arguments),write.id))});
  const original=structuredClone(s.messages),sent=Core.context(s,'规则',2400);validProtocol(sent);
  assert.ok(Core.estimate(sent)<=2400);
  const index=JSON.parse(sent.find(m=>m.content.startsWith('[上下文资料索引]')).content.split('\n').slice(1).join('\n'));
  const inputs=JSON.parse(file(s,index.archive_path)),checkpoint=inputs.find(m=>m.content.startsWith('[本回合执行记录]'));
  const progress=JSON.parse(checkpoint.content.split('\n').slice(1).join('\n'));
  assert.deepEqual(progress.actions,s.activeRound.actions);assert.equal(progress.action,action);
  assert.deepEqual(progress.summary,[summary]);assert.equal(progress.published,1);
  const batches=JSON.parse(file(s,progress.archive_path));
  assert.deepEqual(JSON.parse(file(s,batches[0].path)),original.slice(1));
  assert.deepEqual(s.messages,original);
});

test('accumulated short flow reminders also fit without dropping their order or writing on failed recovery',()=>{
  const s=save();
  for(let i=0;i<100;i++)s.messages.push({role:'user',round:1,internal:true,content:'第'+i+'条：请根据当前进度继续完成本回合，不要重复执行已经完成的操作。'});
  const before=Object.keys(Core.flatten(s.tree));
  assert.throws(()=>Core.context(s,'规'.repeat(3000),1000),e=>e.code==='CONTEXT_LIMIT');
  assert.deepEqual(Object.keys(Core.flatten(s.tree)),before);
  const sent=Core.context(s,'规则',1200);assert.ok(Core.estimate(sent)<=1200);validProtocol(sent);
  const index=JSON.parse(sent.find(m=>m.content.startsWith('[上下文资料索引]')).content.split('\n').slice(1).join('\n'));
  assert.deepEqual(JSON.parse(file(s,index.archive_path)),s.messages.map(m=>({role:m.role,content:m.content})));
});


test('compressed dice checkpoints retain comparison rules and independent outcomes with exact receipts archived',async()=>{
 const s=save();let requests=0;
 const args={description:'两次侦查',roller:'Player-p',related_attr:'侦查',is_secret:false,dice_dict:{甲:'set-force:42',乙:'set-force:80'},calculate_only:false,target_value:70,compare_mode:'le',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'independent',left_modifiers:{},right_modifiers:{}};
 await Core.run(s,async messages=>{
  if(++requests===1)return {reasoning:'检查'.repeat(6000),tool_calls:[call('dice-checkpoint','roll_dice',args)]};
  const checkpoint=messages.find(m=>m.content.startsWith('[本回合执行记录]'));assert.ok(checkpoint);
  const progress=JSON.parse(checkpoint.content.split('\n').slice(1).join('\n')),d=progress.recent_calls.find(c=>c.id==='dice-checkpoint').dice;
  assert.equal(d.compare_mode,'le');assert.equal(d.mode,'independent');assert.equal(d.rows.length,2);
  assert.deepEqual(d.rows.map(r=>[r.label,r.total,r.compare_mode,r.target,r.success]),[['甲',42,'le',70,true],['乙',80,'le',70,false]]);
  const index=JSON.parse(file(s,progress.archive_path));assert.ok(index.some(entry=>file(s,entry.path).includes('compare_mode')));
  return finish();
 },{system:'规则',cap:2200});assert.equal(requests,2);
});
