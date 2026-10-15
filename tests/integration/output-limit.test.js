'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Agent=require('../../src/world-designer/agent');
const GameTransport=require('../../src/game-transport');
const C=require('../../src/world-designer/00-config');
const VFS=require('../../src/world-designer/vfs');
const settings={baseUrl:'https://output.invalid/v1',model:'test',apiKey:'test-only',temperature:0.7};

function response(stream,{reason='stop',usage,message={content:'结果'}}={}){
  if(!stream)return new Response(JSON.stringify({choices:[{message,finish_reason:reason}],usage}));
  const delta={...message};
  if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((c,index)=>({...c,index}));
  const chunks=[{choices:[{delta}]},{choices:[{delta:{},finish_reason:reason}]}];
  if(usage)chunks.push({choices:[],usage});
  return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n');
}

test('designer defaults to a 16384-token output allowance and honors an explicit setting',async t=>{
  assert.equal(C.DEFAULT_SETTINGS.maxOutputTokens,16384);
  const bodies=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{bodies.push(JSON.parse(init.body));return response(false);});
  for(const maxOutputTokens of [undefined,8192,32768])await Agent.createHttpTransport({...settings,maxOutputTokens,stream:false},[])([{role:'user',content:'任务'}]);
  assert.deepEqual(bodies.map(b=>b.max_tokens),[16384,8192,32768]);
});

for(const [name,create]of [['designer',Agent.createHttpTransport],['game',GameTransport.create]])for(const stream of [false,true]){
  for(const failure of [{reason:'length'},{usage:{completion_tokens:16384}},{usage:{completion_tokens:17000}}]){
    test(name+' rejects '+(stream?'streamed':'JSON')+' output exhaustion '+JSON.stringify(failure),async t=>{
      t.mock.method(globalThis,'fetch',async()=>response(stream,failure));
      await assert.rejects(create({...settings,stream,maxOutputTokens:16384},[])([{role:'user',content:'任务'}]),e=>{
        assert.equal(e.code,'OUTPUT_LIMIT');assert.equal(e.limit,16384);assert.match(e.message,/最大输出/);return true;
      });
    });
  }
  test(name+' accepts a completed '+(stream?'streamed':'JSON')+' result below the output limit',async t=>{
    t.mock.method(globalThis,'fetch',async()=>response(stream,{usage:{prompt_tokens:200000,total_tokens:216383,completion_tokens:16383,completion_tokens_details:{reasoning_tokens:16000}}}));
    assert.equal((await create({...settings,stream,maxOutputTokens:16384},[])([{role:'user',content:'任务'}])).content,'结果');
  });
}

for(const [name,create]of [['designer',Agent.createHttpTransport],['game',GameTransport.create]])test(name+' detects a length limit in the final SSE event without a trailing separator',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'未完成'},finish_reason:'length'}]})));
  await assert.rejects(create({...settings,stream:true,maxOutputTokens:16384},[])([]),e=>e.code==='OUTPUT_LIMIT');
});

test('a truncated designer tool response never executes its writes',async t=>{
  const tree=VFS.createTree();
  const message={content:'',tool_calls:[{id:'write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'/workspace/incomplete.md',content:'不完整内容'})}}]};
  t.mock.method(globalThis,'fetch',async()=>response(true,{reason:'length',message}));
  await assert.rejects(Agent.runTurn({tree,skills:[],config:C.AGENT_CONFIG},[{role:'user',content:'写文件'}],Agent.createHttpTransport({...settings,stream:true},[])),e=>e.code==='OUTPUT_LIMIT');
  assert.equal(VFS.resolve(tree,VFS.normalize('/workspace/incomplete.md')),null);
});

test('game output checks use the final request override instead of the settings value',async t=>{
  t.mock.method(globalThis,'fetch',async()=>response(false,{usage:{completion_tokens:800}}));
  await assert.rejects(GameTransport.create({...settings,stream:false,maxOutputTokens:16384,customRequestBody:'{"max_tokens":800}'},[])([]),e=>e.code==='OUTPUT_LIMIT'&&e.limit===800);
});
