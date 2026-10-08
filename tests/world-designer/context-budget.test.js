'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Tokens=require('../../src/world-designer/tokens');
const Compress=require('../../src/world-designer/compress');
const Budget=require('../../src/world-designer/context-budget');
const Agent=require('../../src/world-designer/agent');
const VFS=require('../../src/world-designer/vfs');
const C=require('../../src/world-designer/00-config');

test('preset context limits reserve 16k only after occupancy exceeds half',()=>{
  for(const maxContextK of [128,256,512,1024]){
    const settings={maxContextK,contextLimitMode:'preset'},half=maxContextK*500;
    assert.equal(Budget.occupied(settings,half),half);
    assert.equal(Budget.occupied(settings,half+1),half+1+16000);
    assert.equal(Budget.limit(settings,half+1),maxContextK*1000-16000);
  }
  assert.equal(Budget.occupied({maxContextK:256},240000),256000);
});

test('custom limits keep their exact budget even when their value matches a preset',()=>{
  for(const maxContextK of [32,240,256,512]){
    const settings={maxContextK,contextLimitMode:'custom'};
    assert.equal(Budget.occupied(settings,maxContextK*750),maxContextK*750);
    assert.equal(Budget.limit(settings,maxContextK*750),maxContextK*1000);
  }
  assert.equal(Budget.occupied({maxContextK:240},200000),200000);
});

test('HTTP budget enforces preset reserve while allowing the same custom limit',async t=>{
  let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{requests++;return {ok:true,json:async()=>({choices:[{message:{content:'完成'}}]})};});
  const messages=[{role:'user',content:'文'.repeat(240001)}];
  await assert.rejects(Agent.createHttpTransport({baseUrl:'https://test.invalid/v1',maxContextK:256,contextLimitMode:'preset'},[],{})(messages),e=>e.code==='CONTEXT_LIMIT');
  assert.equal(requests,0);
  await Agent.createHttpTransport({baseUrl:'https://test.invalid/v1',maxContextK:256,contextLimitMode:'custom'},[],{})(messages);
  assert.equal(requests,1);
});

test('request accounting includes reasoning, summary and tool definitions but excludes local file diffs',()=>{
  const messages=[{role:'user',content:'继续'}, {role:'assistant',content:'',reasoning_content:'思'.repeat(100),tool_calls:[{id:'a',function:{name:'write_file',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'a',content:'成功',change:{before:'旧'.repeat(10000),after:'新'.repeat(10000)}}];
  assert.ok(Tokens.estimateMessage(messages[1])>=100);
  assert.ok(Tokens.estimateMessage({role:'compressed',summary:'摘'.repeat(80)})>=80);
  const projected=Budget.project(messages),tools=[{type:'function',function:{name:'工具',description:'规'.repeat(100)}}];
  assert.equal(projected[2].change,undefined);
  assert.ok(Budget.cost(projected,tools)>Budget.cost(projected,[])+100);
});

test('single oversized completed turn can be compressed despite the twenty-response retention preference',()=>{
  const messages=[{role:'user',msgId:'u',content:'读取模组'}, {role:'assistant',content:'',tool_calls:[{id:'a',function:{name:'read_file',arguments:'{"path":"/workspace/a.md"}'}}]},
    {role:'tool',tool_call_id:'a',content:'文'.repeat(8000)}, {role:'assistant',content:'完成'}];
  const plan=Compress.planCompression(messages,{retainedBudgetTokens:1000});
  assert.ok(plan.compressCount>0);
  assert.ok(Tokens.estimateMessages(plan.keepRecent)<=1000);
  const active=Compress.planCompression(messages,{retainedBudgetTokens:1000,preserveUserId:'u'});
  assert.ok(active.keepRecent.includes(messages[0]));
  const next=Budget.project([{role:'compressed',summary:'已读取模组，后续参见文件。'},...active.keepRecent]);
  assert.equal(next.filter(m=>m.role==='tool').length,0,'an oversized completed call/result is summarized together');
});

test('compressed history never accepts a larger replacement and preserves original records',()=>{
  const user={role:'user',content:'原始问题'},answer={role:'assistant',content:'文'.repeat(1000)},messages=[user,answer];
  const out={mark:{role:'compressed',summary:'简短摘要'},keepRecent:[]};
  const folded=Budget.fold(messages,out);
  assert.equal(messages[0].displayOnly,undefined);
  assert.equal(folded[0].content,'原始问题');assert.equal(folded[0].displayOnly,true);
  assert.equal(Budget.project(folded).length,1);
  assert.throws(()=>Budget.requireReduction(messages,[{role:'compressed',summary:'大'.repeat(2000)}],[]),/未减少/);
});

test('each outgoing request must fit even if the latest whole turn cannot be trimmed',()=>{
  const messages=[{role:'system',content:'规则'}, {role:'user',content:'文'.repeat(4000)}];
  for(const mode of ['disabled','sliding','truncate'])assert.throws(()=>Budget.fit(messages,1000,[],mode),/手动点击压缩按钮或者在设置中切换上下文处理方式/);
});

test('compression requests split a giant turn into bounded transcript requests',async()=>{
  const messages=[{role:'user',content:'材'.repeat(20000)}],requests=[];
  const result=await Compress.run(messages,{keepRecentResponses:0,inputBudgetTokens:2000,requestBudgetTokens:5000,summaryBudgetTokens:200,maxWords:100,fileTree:'世界目录'},
    async request=>{requests.push(request);assert.ok(Budget.cost(request,[])<=5000);return {content:'已处理的素材摘要'};});
  assert.ok(requests.length>1);
  assert.ok(result.mark.summary);
});

test('request preflight runs again after a tool result and stops before the oversized second request',async()=>{
  const tree=VFS.createTree();VFS.mkdirp(tree,['workspace']);VFS.writeFile(tree,'/workspace/a.md','文'.repeat(8000));
  let requests=0,checks=0;const saved=[];
  await assert.rejects(Agent.runTurn({tree,skills:[],config:C.AGENT_CONFIG},[{role:'user',content:'读取文件'}],async()=>{
    requests++;return {tool_calls:[{id:'read',type:'function',function:{name:'read_file',arguments:'{"path":"/workspace/a.md"}'}}]};
  },{prepareRequest:messages=>{checks++;return Budget.fit(messages,1000);},onMessage:m=>saved.push(m)}),e=>e.code==='CONTEXT_LIMIT');
  assert.equal(checks,2);assert.equal(requests,1);assert.equal(saved[1].role,'tool');
  assert.match(saved[1].content,/文/);
});

test('HTTP boundary strips file diffs and refuses oversized input before fetch',async t=>{
  const bodies=[];
  t.mock.method(globalThis,'fetch',async(_url,opts)=>{bodies.push(JSON.parse(opts.body));return {ok:true,json:async()=>({choices:[{message:{content:'完成'}}]})};});
  const transport=Agent.createHttpTransport({baseUrl:'https://test.invalid/v1',maxContextK:1,stream:false},[],{});
  await transport([{role:'user',content:'测试'},{role:'assistant',tool_calls:[{id:'a',function:{name:'write_file',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'a',content:'成功',change:{before:'旧'.repeat(10000),after:'新'.repeat(10000)}}]);
  assert.equal(bodies[0].messages[2].change,undefined);
  await assert.rejects(transport([{role:'user',content:'文'.repeat(2000)}]),e=>e.code==='CONTEXT_LIMIT');
  assert.equal(bodies.length,1);
});

test('preflight receives request-local images across the complete tool batch',async()=>{
  const tree=VFS.createTree();const seen=[];let requests=0;
  await Agent.runTurn({tree,skills:[],config:C.AGENT_CONFIG,viewImage:()=>({pending:Promise.resolve({result:'图片',image:{path:'/a.png',dataUrl:'data:image/png;base64,AA=='}})})},
    [{role:'user',content:'查看图片'}],async()=> ++requests===1?{tool_calls:[{id:'image',function:{name:'view_image',arguments:'{"path":"/a.png"}'}}]}:{content:'看到图片'},
    {prepareRequest:(messages,images)=>{seen.push(images);return messages;}});
  assert.equal(seen.length,2);assert.equal(seen[1][0].content[1].type,'image_url');
});

test('provider context overflow includes recovery guidance even when local estimation fits',async t=>{
  t.mock.method(globalThis,'fetch',async()=>({ok:false,status:400,text:async()=>'{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}'}));
  const transport=Agent.createHttpTransport({baseUrl:'https://test.invalid/v1',maxContextK:128},[],{});
  await assert.rejects(transport([{role:'user',content:'请求'}]),error=>error.code==='CONTEXT_LIMIT'&&error.message.includes(Budget.HINT));
  assert.equal(Budget.isLimitError(new Error('429 Tokens per minute limit exceeded')),false);
});
