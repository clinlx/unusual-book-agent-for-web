'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const GameTransport=require('../src/game-transport.js');

function response(body,status=200){
  return {ok:status>=200&&status<300,status,body:null,json:async()=>body,text:async()=>JSON.stringify(body)};
}

test('custom request body adds and deeply overrides fields after standard settings',async()=>{
  let sent;
  const settings={
    baseUrl:'https://example.test/v1',apiKey:'key',model:'model-a',stream:false,maxOutputTokens:100,
    reasoningEffort:'none',temperature:.7,topP:.9,frequencyPenalty:.2,presencePenalty:.1,seed:42,
    customRequestBody:JSON.stringify({temperature:.25,extra_body:{chat_template_kwargs:{enable_thinking:true}},stream_options:{include_usage:true}})
  };
  const run=GameTransport.create(settings,[],{
    fetch:async(_url,init)=>{sent=JSON.parse(init.body);return response({choices:[{message:{content:'OK'}}]});}
  });
  await run([{role:'user',content:'hello'}]);
  assert.equal(sent.temperature,.25);
  assert.equal(sent.top_p,.9);
  assert.equal(sent.frequency_penalty,.2);
  assert.equal(sent.presence_penalty,.1);
  assert.equal(sent.seed,42);
  assert.deepEqual(sent.extra_body,{chat_template_kwargs:{enable_thinking:true}});
  assert.deepEqual(sent.stream_options,{include_usage:true});
});

test('custom request body recursively merges objects and overwrites arrays/scalars',()=>{
  const merged=GameTransport.mergeBody({a:{x:1,y:2},list:[1,2],value:1},{a:{y:9,z:3},list:[7],value:4,newField:true});
  assert.deepEqual(merged,{a:{x:1,y:9,z:3},list:[7],value:4,newField:true});
});

test('custom request body must be a JSON object',()=>{
  assert.throws(()=>GameTransport.customBody({customRequestBody:'[1,2]'}),/必须是 JSON 对象/);
  assert.throws(()=>GameTransport.customBody({customRequestBody:'{bad'}),/不是有效 JSON/);
});
