'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Agent=require('../../src/world-designer/agent');
const Budget=require('../../src/world-designer/context-budget');
const C=require('../../src/world-designer/00-config');
const VFS=require('../../src/vfs');
const Core=require('../../src/game-core');
const Transport=require('../../src/game-transport');
const Args=require('../../src/shared/tool-arguments');
const settings={baseUrl:'https://arguments.invalid/v1',model:'test',stream:false};
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:args}});
const bad=call('bad','write_file','{"path":"/workspace/bad.txt","content":"unfinished');
const good=call('good','list_dir',' { "path": "/workspace" } ');
const records=()=>[{role:'user',content:'继续'},
  {role:'assistant',content:'',reasoning_content:'思考',tool_calls:[bad,good]},
  {role:'tool',tool_call_id:'bad',content:'错误: 参数解析失败'},
  {role:'tool',tool_call_id:'good',content:'目录结果'}];
function assertSafe(messages){
  const m=messages.find(m=>m.tool_calls);
  assert.equal(m.reasoning_content,'思考');
  assert.doesNotThrow(()=>JSON.parse(m.tool_calls[0].function.arguments));
  assert.deepEqual(m.tool_calls[1],good);
  assert.match(messages.find(m=>m.tool_call_id==='bad').content,/占位|替代/);
  assert.equal(messages.find(m=>m.tool_call_id==='good').content,'目录结果');
}
test('designer repairs only outgoing malformed history and keeps original records',()=>{
  const original=records(),before=structuredClone(original),sent=Budget.project(original);
  assertSafe(sent);assert.deepEqual(original,before);assert.deepEqual(Budget.project(sent),sent);
});
for(const [name,create] of [['designer',Agent.createHttpTransport],['game',Transport.create]]){
  test(name+' HTTP rejects no malformed historical arguments, including saved sessions',async t=>{
    const original=records(),before=structuredClone(original);
    t.mock.method(globalThis,'fetch',async(url,init)=>{
      assertSafe(JSON.parse(init.body).messages);
      return new Response(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));
    });
    await create(settings,[])(original);assert.deepEqual(original,before);
  });
  test(name+' preserves valid arguments byte for byte',async t=>{
    const messages=records();messages[1]={...messages[1],tool_calls:[call('bad','list_dir','{}'),good]};
    t.mock.method(globalThis,'fetch',async(url,init)=>{
      assert.deepEqual(JSON.parse(init.body).messages,messages);
      return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}));
    });
    await create(settings,[])(messages);
  });
}
test('designer skips malformed writes, continues mixed batches and reports possible service problems',async()=>{
  const tree=VFS.createTree(),warnings=[];let n=0;
  const out=await Agent.runTurn({tree,skills:[],config:C.AGENT_CONFIG},[],async messages=>{
    if(!n++)return {tool_calls:[bad,good]};
    assert.doesNotThrow(()=>JSON.parse(messages.find(m=>m.tool_calls).tool_calls[0].function.arguments));
    assert.match(messages.find(m=>m.tool_call_id==='bad').content,/模型.*服务/);
    return {content:'ok'};
  },{onWarning:message=>warnings.push(message)});
  assert.equal(n,2);assert.equal(warnings.length,1);assert.match(warnings[0],/可能.*模型.*服务/);
  assert.equal(VFS.resolve(tree,['workspace','bad.txt']),null);
  assert.equal(out.newMessages[0].tool_calls[0].function.arguments,bad.function.arguments);
});
test('game recovers a saved pending batch without repeating completed writes and shows a player-safe warning',async()=>{
  const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"林"}');
  const s=Core.createSave('测试',tree);Core.beginRound(s,'',true,'开局');
  const write=call('done','write_file',JSON.stringify({path:'/workspace/once.txt',content:'once'}));
  s.messages.push({role:'assistant',content:'',round:1,tool_calls:[write,bad]});
  const result=Core.execute(s,'write_file',JSON.parse(write.function.arguments),'done');
  assert.equal(result.ok,true);
  s.messages.push({role:'tool',tool_call_id:'done',content:JSON.stringify(result),round:1});
  let count=0;
  await Core.run(s,async messages=>{
    count++;
    for(const m of messages)for(const c of m.tool_calls||[])assert.doesNotThrow(()=>JSON.parse(c.function.arguments));
    return {tool_calls:[call('story','append_story',JSON.stringify({content:'天亮了。',one_line_summary_of_content:'天亮'})),
      call('end','end_the_round',JSON.stringify({NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'清晨',Active_Scene:'门口'}}))]};
  },{openingPreload:false,maxToolLoops:2});
  assert.equal(count,1);assert.equal(s.status,'waiting');
  assert.equal(s.events.filter(e=>e.callId==='done').length,1);
  assert.equal(VFS.resolve(s.tree,['workspace','bad.txt']),null);
  assert.equal(s.messages.find(m=>m.tool_calls).tool_calls[1].function.arguments,bad.function.arguments);
  const warning=Core.visibleEvents(s,'play').find(e=>e.code==='INVALID_TOOL_ARGUMENTS');
  assert.ok(warning);assert.match(warning.content,/可能.*模型.*服务/);
  assert.doesNotMatch(warning.content,/unfinished|bad.txt/);
});

for(const raw of ['',undefined,null,{},'null','[]','12','"text"','{"x":}'])test('invalid argument shape is never executed: '+JSON.stringify(raw),()=>{
  assert.throws(()=>Args.parse(raw),e=>e.code==='INVALID_TOOL_ARGUMENTS');
  const original=[{role:'assistant',tool_calls:[call('x','list_dir',raw)]},{role:'tool',tool_call_id:'x',content:'错误'}];
  const sent=Args.project(original);
  assert.equal(sent[0].tool_calls[0].function.arguments,'{}');
  assert.match(sent[1].content,/占位/);
  assert.equal(original[0].tool_calls[0].function.arguments,raw);
});

for(const [name,create]of [['designer',Agent.createHttpTransport],['game',Transport.create]])test(name+' streaming arguments preserve repeated fragments and isolate malformed parallel calls',async t=>{
  let n=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(n++){
      const body=JSON.parse(init.body),calls=body.messages.find(m=>m.tool_calls).tool_calls;
      assert.equal(calls[0].function.arguments,'{"content":"哈哈"}');
      assert.equal(calls[1].function.arguments,'{}');
      return new Response('data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'\n\n');
    }
    const chunks=[
      [{index:0,...call('ok','write_file','{"content":"')},{index:1,...call('bad','write_file','{"content":')}],
      [{index:0,function:{arguments:'哈'}},{index:1,function:{arguments:'broken'}}],
      [{index:0,function:{arguments:'哈'}}],
      [{index:0,function:{arguments:'"}'}}],
    ];
    return new Response(chunks.map(tool_calls=>'data: '+JSON.stringify({choices:[{delta:{tool_calls}}]})+'\n\n').join(''));
  });
  const transport=create({...settings,stream:true},[]),result=await transport([]);
  assert.equal(result.tool_calls[0].function.arguments,'{"content":"哈哈"}');
  assert.equal(result.tool_calls[1].function.arguments,'{"content":broken');
  await transport([{role:'assistant',content:'',tool_calls:result.tool_calls},
    {role:'tool',tool_call_id:'ok',content:'成功'},{role:'tool',tool_call_id:'bad',content:'错误'}]);
});

test('game validates malformed history from custom request body after merging',async t=>{
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assertSafe(JSON.parse(init.body).messages);
    return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}));
  });
  await Transport.create({...settings,customRequestBody:JSON.stringify({messages:records()})},[])([]);
});

test('designer does not repeat the warning for previously reported malformed history',async()=>{
  let warnings=0;
  await Agent.runTurn({tree:VFS.createTree(),skills:[],config:C.AGENT_CONFIG},records(),async()=>({content:'ok'}),
    {warnedToolCallIds:['bad'],onWarning:()=>warnings++});
  assert.equal(warnings,0);
});

test('game does not warn again about recovered history on a later normal round',async()=>{
  const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"林"}');
  const s=Core.createSave('测试',tree);Core.beginRound(s,'',true,'开局');
  s.messages.push(...records().map(m=>({...m,round:0})));
  s.events.push({type:'warning',code:'INVALID_TOOL_ARGUMENTS',callIds:['bad'],round:0,content:Args.NOTICE});
  await Core.run(s,async()=>({tool_calls:[call('story','append_story','{"content":"天亮了。","one_line_summary_of_content":"天亮"}'),
    call('end','end_the_round','{"NEXT_TURN_CACHE":{"Story_Phase":"游戏循环"}}')]}),{openingPreload:false});
  assert.equal(s.events.filter(e=>e.code==='INVALID_TOOL_ARGUMENTS').length,1);
});
