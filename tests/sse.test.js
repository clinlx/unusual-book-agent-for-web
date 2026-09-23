'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const SSE=require('../src/sse.js');

test('partialJsonString decodes streamed content safely',()=>{
  assert.equal(SSE.partialJsonString('{"content":"hello','content'),'hello');
  assert.equal(SSE.partialJsonString('{"content":"line\\nnext','content'),'line\nnext');
  assert.equal(SSE.partialJsonString('{"content":"quote: \\"ok\\"','content'),'quote: "ok"');
});

test('partialJsonString waits for incomplete escapes',()=>{
  assert.equal(SSE.partialJsonString('{"content":"abc\\','content'),'abc');
  assert.equal(SSE.partialJsonString('{"content":"abc\\u4e','content'),'abc');
  assert.equal(SSE.partialJsonString('{"content":"abc\\u4e16','content'),'abc世');
});

test('partialJsonString handles surrogate pairs split across chunks',()=>{
  assert.equal(SSE.partialJsonString('{"content":"x\\ud83d','content'),'x');
  assert.equal(SSE.partialJsonString('{"content":"x\\ud83d\\ude00','content'),'x😀');
});

test('accumulator joins streamed function-name fragments',()=>{
  const acc=SSE.createAccumulator();
  acc.add({choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'append_',arguments:'{"content":"a'}}]}}]});
  acc.add({choices:[{delta:{tool_calls:[{index:0,function:{name:'story',arguments:'b"}'}}]}}]});
  const [call]=acc.partial();
  assert.equal(call.function.name,'append_story');
  assert.equal(call.function.arguments,'{"content":"ab"}');
});
