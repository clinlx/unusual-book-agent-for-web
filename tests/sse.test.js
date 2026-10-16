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


test('empty streamed type is a placeholder while unsupported later types are still rejected',()=>{
 const acc=SSE.createAccumulator();
 acc.add({choices:[{delta:{tool_calls:[{index:0,id:'read',type:'',function:{name:'read_file',arguments:'{"path":'}}]}}]});
 acc.add({choices:[{delta:{tool_calls:[{index:0,type:'function',function:{arguments:'"/workspace/a"}'}}]}}]});
 assert.equal(acc.result().tool_calls[0].type,'function');
 assert.equal(acc.result().tool_calls[0].function.arguments,'{"path":"/workspace/a"}');
 assert.throws(()=>acc.add({choices:[{delta:{tool_calls:[{index:0,type:'custom'}]}}]}),e=>e.code==='MODEL_PROTOCOL_ERROR'&&/"custom"/.test(e.message));
});

test('normalizing a completed call keeps the original response unchanged',()=>{
 const message={content:'',tool_calls:[{id:'x',type:'',function:{name:'list_dir',arguments:' {} '}}]};
 const before=structuredClone(message),normalized=SSE.checkMessage(message);
 assert.deepEqual(message,before);
 assert.equal(normalized.tool_calls[0].type,'function');
 assert.equal(normalized.tool_calls[0].function.arguments,' {} ');
});

test('an inferred function must still provide its name and string arguments',()=>{
 for(const fn of [{arguments:'{}'},{name:'list_dir',arguments:{}},{name:'list_dir'}])
   assert.throws(()=>SSE.checkMessage({tool_calls:[{id:'x',type:'',function:fn}]}),e=>e.code==='MODEL_PROTOCOL_ERROR');
});
