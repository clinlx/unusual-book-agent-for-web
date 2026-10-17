'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Agent=require('../../src/world-designer/agent');
const C=require('../../src/world-designer/00-config');
const VFS=require('../../src/vfs');
const Core=require('../../src/game-core');
const Transport=require('../../src/game-transport');
const SSE=require('../../src/shared/sse');
const Args=require('../../src/shared/tool-arguments');
const settings={baseUrl:'https://response-errors.invalid/v1',model:'test',temperature:0.7};
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:args}});
const bad=id=>call(id,'write_file','{"path":');
const finish=()=>({tool_calls:[call('story','append_story','{"content":"天亮了。","one_line_summary_of_content":"天亮","self_accept":true}'),
  call('end','end_the_round','{"NEXT_TURN_CACHE":{"Story_Phase":"游戏循环"}}')]});
function game(){
  const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"林"}');
  const s=Core.createSave('测试',tree);Core.beginRound(s,'',true,'开局');return s;
}
const stream=json=>'data: '+JSON.stringify(json)+'\n\n';
const transports=[['designer',Agent.createHttpTransport],['game',Transport.create]];
for(const [name,create]of transports){
  test(name+' assembles argument deltas with empty, null or omitted type fields',async t=>{
    const chunks=[
      {index:0,...call('read','read_file','{"path":')},
      {index:0,type:'',function:{arguments:'"/workspace'}},
      {index:0,type:null,function:{arguments:'/a.txt'}},
      {index:0,function:{arguments:'"}'}},
    ];
    t.mock.method(globalThis,'fetch',async()=>new Response(chunks.map(tc=>stream({choices:[{delta:{tool_calls:[tc]}}]})).join('')+
      stream({choices:[{delta:{},finish_reason:'tool_calls'}]})));
    const result=await create({...settings,stream:true},[])([]);
    assert.equal(result.tool_calls[0].type,'function');
    assert.equal(result.tool_calls[0].function.name,'read_file');
    assert.equal(result.tool_calls[0].function.arguments,'{"path":"/workspace/a.txt"}');
  });
  for(const type of ['',null,undefined])test(name+' normalizes an absent completed call type: '+JSON.stringify(type),async t=>{
    const tc={...call('read','read_file',' { "path": "/workspace/a.txt" } '),type};
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{tool_calls:[tc]},finish_reason:'tool_calls'}]})));
    const result=await create({...settings,stream:false},[])([]);
    assert.equal(result.tool_calls[0].type,'function');
    assert.equal(result.tool_calls[0].function.arguments,tc.function.arguments);
    assert.equal(tc.type,type);
  });
  for(const streamMode of [false,true])for(const type of ['custom','tool',0,{}]){
    test(name+' rejects an unsupported tool type in '+(streamMode?'SSE':'JSON')+': '+JSON.stringify(type),async t=>{
      const tc={index:0,...call('read','read_file','{"path":"/workspace/a.txt"}'),type};
      const body=streamMode?stream({choices:[{delta:{tool_calls:[tc]}}]}):JSON.stringify({choices:[{message:{tool_calls:[tc]}}]});
      t.mock.method(globalThis,'fetch',async()=>new Response(body));
      await assert.rejects(create({...settings,stream:streamMode},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR'&&/实际收到/.test(e.message));
    });
  }
  test(name+' never infers a callable function from an empty type alone',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'empty',type:''}]}}]})));
    await assert.rejects(create({...settings,stream:false},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR');
  });
  test(name+' rejects malformed SSE data instead of dropping it',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[{delta:{content:'部分正文'}}]})+'data: {"choices":\n\n'));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR'&&/SSE/.test(e.message));
  });
  for(const body of [null,[],{}, {choices:[{}]}, {choices:[{message:{tool_calls:{}}}]},
    {choices:[{message:{tool_calls:[call('x','', '{}')]}}]},
    {choices:[{message:{tool_calls:[call('x','list_dir',{})]}}]}]){
    test(name+' rejects damaged response structure '+JSON.stringify(body),async t=>{
      t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(body)));
      await assert.rejects(create({...settings,stream:false},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR');
    });
  }
  test(name+' reports invalid JSON response body as a protocol failure',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response('{"choices":'));
    await assert.rejects(create({...settings,stream:false},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR');
  });
  for(const streamMode of [false,true])test(name+' surfaces service errors in '+(streamMode?'SSE':'JSON'),async t=>{
    const data={error:{message:'服务暂不可用'}};
    t.mock.method(globalThis,'fetch',async()=>new Response(streamMode?stream(data):JSON.stringify(data)));
    await assert.rejects(create({...settings,stream:streamMode},[])([]),e=>e.code==='MODEL_RESPONSE_ERROR'&&/服务暂不可用/.test(e.message));
  });
  for(const args of [{},null,[]])test(name+' rejects non-string argument fragments before coercion: '+JSON.stringify(args),async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[{delta:{tool_calls:[{index:0,...call('x','list_dir',args)}]}}]})));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR');
  });
  test(name+' validates completed streamed headers without rejecting intermediate fragments',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[{delta:{tool_calls:[{index:0,id:'x',function:{arguments:'{}'}}]}}]})));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR');
  });
  test(name+' keeps intentional reader aborts distinct from failures',async t=>{
    t.mock.method(globalThis,'fetch',async()=>({ok:true,body:{getReader:()=>({
      read:async()=>{throw Object.assign(Error('cancelled'),{name:'AbortError'});},cancel:async()=>{},releaseLock(){}
    })}}));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.name==='AbortError'&&e.code!=='MODEL_STREAM_ERROR');
  });
  test(name+' reports reader failure separately from parameter mistakes',async t=>{
    t.mock.method(globalThis,'fetch',async()=>({ok:true,body:{getReader:()=>({
      read:async()=>{throw Error('socket closed');},cancel:async()=>{},releaseLock(){}
    })}}));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.code==='MODEL_STREAM_ERROR'&&e.cause.message==='socket closed');
  });
  test(name+' rejects a non-stream message envelope in SSE',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[{message:{content:'wrong envelope'}}]})));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR');
  });
  test(name+' rejects a stream containing only usage events',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[],usage:{completion_tokens:0}})));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR');
  });
  test(name+' rejects an empty stream',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response('data: [DONE]\n\n'));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.code==='MODEL_PROTOCOL_ERROR');
  });
  test(name+' preserves recoverable argument JSON errors for the tool receipt',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[{delta:{tool_calls:[{index:0,...bad('x')}]}}]})+
      stream({choices:[{delta:{},finish_reason:'tool_calls'}]})));
    const result=await create({...settings,stream:true},[])([]);
    assert.equal(result.tool_calls[0].function.arguments,'{"path":');
    assert.throws(()=>Args.parse(result.tool_calls[0].function.arguments),e=>e.code==='INVALID_TOOL_ARGUMENTS');
  });
  test(name+' handles CRLF and JSON split across network chunks',async t=>{
    const payload=stream({choices:[{delta:{content:'ok'},finish_reason:'stop'}]}).replace(/\n/g,'\r\n');
    const chunks=Array.from(payload,ch=>new TextEncoder().encode(ch));
    t.mock.method(globalThis,'fetch',async()=>({ok:true,body:{getReader:()=>({
      read:async()=>chunks.length?{value:chunks.shift(),done:false}:{done:true},
      cancel:async()=>{},releaseLock(){}
    })}}));
    assert.equal((await create({...settings,stream:true},[])([])).content,'ok');
  });
  test(name+' preserves output-limit classification for incomplete tool headers',async t=>{
    t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[{delta:{tool_calls:[{index:0,id:'x',function:{arguments:'{"path":'}}]},finish_reason:'length'}]})));
    await assert.rejects(create({...settings,stream:true},[])([]),e=>e.code==='OUTPUT_LIMIT');
  });
  test(name+' never executes partial writes from a damaged response',async t=>{
    const write=call('write','write_file','{"path":"/workspace/not-written.txt","content":"no"}');
    t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[{delta:{tool_calls:[{index:0,...write}]}}]})+'data: broken\n\n'));
    const transport=create({...settings,stream:true},[]);
    if(name==='designer'){
      const tree=VFS.createTree(),messages=[];
      await assert.rejects(Agent.runTurn({tree,skills:[],config:C.AGENT_CONFIG},[],transport,{onMessage:m=>messages.push(m)}),e=>e.code==='MODEL_PROTOCOL_ERROR');
      assert.equal(VFS.resolve(tree,['workspace','not-written.txt']),null);
      assert.equal(messages.length,0);
    }else{
      const s=game();
      await assert.rejects(Core.run(s,transport,{openingPreload:false}),e=>e.code==='MODEL_PROTOCOL_ERROR');
      assert.equal(VFS.resolve(s.tree,['workspace','not-written.txt']),null);
      assert.equal(s.status,'interrupted');
      assert.match(s.events.at(-1).content,/模型响应协议异常/);
      assert.equal(s.events.at(-1).code,'MODEL_PROTOCOL_ERROR');
    }
  });
}
test('designer does not swallow errors raised by streaming callbacks',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(stream({choices:[{delta:{content:'ok'}}]})));
  await assert.rejects(Agent.createHttpTransport({...settings,stream:true},[],{onDelta(){throw Error('callback failed');}})([]),/callback failed/);
});
test('designer distinguishes ordinary validation errors and supports model correction',async()=>{
  const warnings=[],tree=VFS.createTree();let n=0;
  const result=await Agent.runTurn({tree,skills:[],config:C.AGENT_CONFIG},[],async messages=>{
    if(!n++)return {tool_calls:[call('missing','read_file','{}')]};
    assert.match(messages.find(m=>m.tool_call_id==='missing').content,/缺少必填参数 path/);
    return {content:'已理解，需要提供 path'};
  },{onWarning:message=>warnings.push(message)});
  assert.equal(warnings.length,0);assert.equal(result.newMessages.length,3);
});
test('game distinguishes ordinary validation errors from malformed JSON',async()=>{
  const s=game();let n=0;
  await Core.run(s,async messages=>{
    if(!n++)return {tool_calls:[call('missing','read_file','{}')]};
    assert.match(messages.find(m=>m.tool_call_id==='missing').content,/缺少必填参数 path/);
    return finish();
  },{openingPreload:false});
  assert.equal(s.events.filter(e=>e.code==='INVALID_TOOL_ARGUMENTS').length,0);
});
test('designer escalates at three malformed calls and does not flood warnings',async()=>{
  const warnings=[];let n=0;
  await Agent.runTurn({tree:VFS.createTree(),skills:[],config:C.AGENT_CONFIG},[],async()=>{
    n++;return n<=4?{tool_calls:[bad('bad-'+n)]}:{content:'结束'};
  },{onWarning:(message,ids,detail)=>warnings.push({message,ids,...detail})});
  assert.deepEqual(warnings.map(w=>w.count),[1,2,3,4]);
  assert.deepEqual(warnings.map(w=>w.show),[true,false,true,false]);
  assert.doesNotMatch(warnings[0].message,/模型.*服务/);
  assert.match(warnings[2].message,/多次.*检查模型或服务/);
});
test('designer retains escalation count when continuing the same turn',async()=>{
  const warnings=[];
  await Agent.runTurn({tree:VFS.createTree(),skills:[],config:C.AGENT_CONFIG},[{role:'assistant',tool_calls:[bad('third')]}],async()=>({content:'结束'}),
    {argumentWarningCount:2,onWarning:(message,ids,detail)=>warnings.push({message,...detail})});
  assert.equal(warnings[0].count,3);assert.equal(warnings[0].show,true);
  assert.match(warnings[0].message,/多次/);
});
test('game escalates once per round and resumes without repeated warnings',async()=>{
  const s=game();let n=0;
  await Core.run(s,async()=>++n<=4?{tool_calls:[bad('bad-'+n)]}:finish(),{openingPreload:false});
  const warnings=s.events.filter(e=>e.code==='INVALID_TOOL_ARGUMENTS');
  assert.equal(warnings.length,2);assert.equal(warnings[0].callIds.length,4);
  assert.doesNotMatch(warnings[0].content,/模型.*服务/);
  assert.equal(warnings[1].repeated,true);assert.match(warnings[1].content,/多次/);
  const previous=s.events.length;
  await Core.run(s,async()=>{throw Error('should not request');},{openingPreload:false});
  assert.equal(s.events.length,previous);
  Core.beginRound(s,'继续',false,'下一回合');
  let requests=0;
  await Core.run(s,async()=>++requests===1?{tool_calls:[call('trigger','trigger_next_round','{"phase_plan":{"Countdowns":"无","Pending_Triggers":[],"Forced_Checks":"无"}}'),bad('next-round')]}:finish(),{openingPreload:false});
  const nextWarnings=s.events.filter(e=>e.code==='INVALID_TOOL_ARGUMENTS'&&e.round===s.activeRound.number);
  assert.equal(nextWarnings.length,1);assert.equal(nextWarnings[0].repeated,false);
  assert.doesNotMatch(nextWarnings[0].content,/模型.*服务/);
});
test('SSE parser accepts whitespace after DONE and ignores empty data',()=>{
  const parser=SSE.createParser();
  assert.deepEqual(parser.push('data: \r\ndata: [DONE]  \r\n\r\n'),[]);
});
