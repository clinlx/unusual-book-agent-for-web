'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Retry=require('../../src/shared/request-retry');
const Config=require('../../src/frontend-config');
const Agent=require('../../src/world-designer/agent');
const Transport=require('../../src/game-transport');
const Core=require('../../src/game-core');
const VFS=require('../../src/vfs');
const settings={baseUrl:'https://retry.invalid/v1',model:'retry-test',stream:false,autoRetry:true,maxConsecutiveFailures:3,retryCooldownSeconds:0};
const reply=message=>new Response(JSON.stringify({choices:[{message,finish_reason:'stop'}]}));
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('both profiles default to opt-out, three total failures and five seconds',()=>{
  for(const profile of ['game','designer'])assert.deepEqual(Retry.validate(Config.defaults(profile)),{autoRetry:false,maxConsecutiveFailures:3,retryCooldownSeconds:5});
  for(const value of [0,1.2,101,Infinity])assert.throws(()=>Retry.validate({maxConsecutiveFailures:value}));
  for(const value of [-1,3601,NaN])assert.throws(()=>Retry.validate({retryCooldownSeconds:value}));
});

for(const [name,create] of [['game',Transport.create],['designer',Agent.createHttpTransport]]) {
  test(name+': disabled ignores legacy retries; enabled stops on third failure',async t=>{
    let count=0;const retries=[];
    const fetch=async()=>{count++;return new Response('unavailable',{status:503});};
    t.mock.method(globalThis,'fetch',fetch);
    for(const autoRetry of [false,true]){
      count=0;retries.length=0;
      await assert.rejects(create({...settings,autoRetry,maxRetries:10},[],{fetch,onRetry:info=>retries.push(info.failures)})([]),/503/);
      assert.equal(count,autoRetry?3:1);assert.deepEqual(retries,autoRetry?[1,2]:[]);
    }
  });
  test(name+': success resets count for the next request; network failures recover',async t=>{
    let count=0;const failures=[];
    const fetch=async()=>{count++;if(count%3)throw new TypeError('Failed to fetch');return reply({content:'OK'});};
    t.mock.method(globalThis,'fetch',fetch);
    const request=create(settings,[],{fetch,onRetry:info=>failures.push(info.failures)});
    assert.equal((await request([])).content,'OK');assert.equal((await request([])).content,'OK');
    assert.deepEqual(failures,[1,2,1,2]);assert.equal(count,6);
  });
  test(name+': auth, bad parameters, context and output limits do not retry',async t=>{
    for(const [status,body] of [[401,'invalid key'],[400,'bad parameter'],[400,'context_length_exceeded'],[200,JSON.stringify({choices:[{message:{content:'cut'},finish_reason:'length'}]})]]){
      let count=0;const fetch=async()=>{count++;return new Response(body,{status});};
      t.mock.method(globalThis,'fetch',fetch);
      await assert.rejects(create(settings,[],{fetch})([]));assert.equal(count,1);
    }
  });
  test(name+': stopping during cooldown prevents any further attempt',async t=>{
    let count=0;const controller=new AbortController();
    const fetch=async()=>{count++;return new Response('busy',{status:429});};
    t.mock.method(globalThis,'fetch',fetch);
    const request=create({...settings,retryCooldownSeconds:5},[],{fetch,signal:controller.signal,onRetry:()=>setTimeout(()=>controller.abort(),5)});
    await assert.rejects(request([]),{name:'AbortError'});assert.equal(count,1);
  });
  test(name+': failed stream buffers reset before retry; incomplete calls never escape',async t=>{
    let count=0,preview='',resets=0;
    const fetch=async()=>{
      if(++count>1)return new Response('data: '+JSON.stringify({choices:[{delta:{content:'complete'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
      let read=0;
      return {ok:true,body:new ReadableStream({pull(controller){if(read++)controller.error(new Error('connection lost'));else controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'partial',tool_calls:[{index:0,id:'partial',type:'function',function:{name:'write_file',arguments:'{"path":'}}]}}]})+'\n\n'));}})};
    };
    t.mock.method(globalThis,'fetch',fetch);
    const result=await create({...settings,stream:true},[],{fetch,onDelta:t=>preview+=t,onAttempt:()=>{preview='';resets++;},onRetry:()=>{preview='';}})([]);
    assert.equal(result.content,'complete');assert.equal(preview,'complete');assert.deepEqual(result.tool_calls,[]);assert.equal(resets,2);
  });
}

test('cooldown actually waits and max failure count one performs no retries',async()=>{
  let count=0;const times=[];
  const request=Retry.wrap(async()=>{times.push(performance.now());if(++count===1)throw Object.assign(Error('network'),{code:'MODEL_NETWORK_ERROR'});return 'OK';},{...settings,retryCooldownSeconds:.03});
  assert.equal(await request(),'OK');assert.ok(times[1]-times[0]>=20);
  count=0;await assert.rejects(Retry.wrap(async()=>{count++;throw Object.assign(Error('timeout'),{code:'MODEL_TIMEOUT'});},{...settings,maxConsecutiveFailures:1})());assert.equal(count,1);
});

test('game timeout retries with a fresh request signal',async()=>{
  let count=0;
  const fetch=async(_url,{signal})=>{
    assert.equal(signal.aborted,false);
    if(++count===1)return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    return reply({content:'recovered'});
  };
  const result=await Transport.create({...settings,httpTimeoutSeconds:1},[],{fetch})([]);
  assert.equal(result.content,'recovered');assert.equal(count,2);
});

test('local storage failures are never treated as model failures',async()=>{
  let count=0;
  await assert.rejects(Transport.create(settings,[],{fetch:async()=>{count++;return reply({content:'unused'});},onRequest:()=>{throw new DOMException('storage full','QuotaExceededError');}})([]),{name:'QuotaExceededError'});
  assert.equal(count,0);
  assert.equal(Retry.networkError(new DOMException('offline','NetworkError')).code,'MODEL_NETWORK_ERROR');
});

test('designer retries only failed request after a tool write, without replaying the write',async t=>{
  const tree=VFS.createTree();VFS.mkdirp(tree,['workspace']);let count=0,writes=0;
  t.mock.method(globalThis,'fetch',async()=>{count++;if(count===1)return reply({tool_calls:[call('write','write_file',{path:'/workspace/a.md',content:'once'})]});if(count===2)return new Response('busy',{status:503});return reply({content:'done'});});
  const result=await Agent.runTurn({tree,skills:[],config:{maxToolLoops:10}},[],Agent.createHttpTransport(settings,[],{}),{onToolEnd:()=>writes++});
  assert.equal(count,3);assert.equal(writes,1);assert.equal(result.hadWrite,true);assert.equal(VFS.readFile(tree,'/workspace/a.md').content,'once');
});

test('game retries only failed request after tool execution and commits one story',async()=>{
  const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"玩家"}');VFS.writeFile(tree,'/workspace/Player-p/背包.json','[]');
  const save=Core.createSave('重试测试',tree);Core.beginRound(save,'继续',true,'本轮任务');let count=0;
  const fetch=async()=>{count++;if(count===1)return reply({tool_calls:[call('write','write_file',{path:'/workspace/once.md',content:'once'})]});if(count===2)return new Response('busy',{status:503});return reply({tool_calls:[call('story','append_story',{content:'继续旅程',one_line_summary_of_content:'继续',self_accept:true}),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]});};
  await Core.run(save,Transport.create(settings,[],{fetch}),{openingPreload:false,maxToolLoops:10});
  assert.equal(count,3);assert.equal(save.messages.filter(m=>m.role==='tool'&&m.tool_call_id==='write').length,1);
  assert.equal(save.events.filter(e=>e.type==='story').length,1);assert.equal(save.activeRound.complete,true);
});
