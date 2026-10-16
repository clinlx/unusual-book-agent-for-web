'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Reads=require('../../src/shared/file-read'),Arguments=require('../../src/shared/tool-arguments');
const V=require('../../src/vfs'),Core=require('../../src/game-core');
const Agent=require('../../src/world-designer/agent'),Config=require('../../src/world-designer/00-config');
const path='/workspace/notes.txt';
function fixture(engine,content='x'.repeat(10000)+'END'){
 const tree=V.createTree();V.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"测试"}');V.writeFile(tree,'/workspace/Player-p/背包.json','[]');
 V.writeFile(tree,path,content);
 const save=Core.createSave('读取导航',tree);Core.beginRound(save,'',true);
 const ctx={tree:save.tree,skills:[],config:Config.AGENT_CONFIG,readState:new Map(),turn:1};let id=0;
 const run=(name,args)=>engine==='game'?Core.execute(save,name,args,'read-'+(++id)):Agent.executeTool(ctx,name,args,{callId:'read-'+(++id)});
 const good=out=>engine==='game'?assert.equal(out.ok,true,JSON.stringify(out)):assert.doesNotMatch(out.result,/^错误/,out.result);
 const read=args=>{const out=run('read_file',{path,...args});good(out);return out.result;};
 return {save,ctx,run,good,read,hint:result=>engine==='game'?result.read_hint||'':result.includes('[读取建议]')?'hint':''};
}
test('ordinary read defaults and paging retain their existing response shape',()=>{
 assert.deepEqual(Reads.read('abcdef',{cap:3}),{content:'abc',totalLength:6,offset:0,returned:3,truncated:true});
 assert.deepEqual(Reads.read('abcdef',{offset:2,limit:3,cap:5}),{content:'cde',totalLength:6,offset:2,returned:3,truncated:true});
 assert.equal(Reads.read('abcdef',{defaultLimit:2,cap:5}).content,'ab');
});
test('tail reads handle empty/short files, cap the actual tail and report its real offset',()=>{
 assert.deepEqual(Reads.read('',{tail_chars:4000}),{content:'',totalLength:0,offset:0,returned:0,truncated:false});
 assert.equal(Reads.read('abc',{tail_chars:4000}).content,'abc');
 assert.deepEqual(Reads.read('0123456789',{tail_chars:8,cap:4}),{content:'6789',totalLength:10,offset:6,returned:4,truncated:false});
 for(const args of [{tail_chars:0},{tail_chars:-1},{tail_chars:1.5},{tail_chars:null},{tail_chars:3,offset:0},{tail_chars:3,limit:3}])
  assert.throws(()=>Reads.read('abc',args),/tail_chars/);
});
test('shared validation rejects ambiguous tail requests before reading',()=>{
 for(const tail_chars of [0,-1,1.5,null,Number.MAX_SAFE_INTEGER+1])assert.match(Arguments.validateFiles('read_file',{path,tail_chars}),/tail_chars/);
 assert.match(Arguments.validateFiles('read_file',{path,tail_chars:3,offset:0}),/tail_chars/);
 assert.match(Arguments.validateFiles('read_file',{path,tail_chars:3,limit:3}),/tail_chars/);
 assert.equal(Arguments.validateFiles('read_file',{path,tail_chars:4000}),null);
});
for(const engine of ['game','designer']){
 test(engine+': tail reads navigate to the end and still establish normal write evidence',()=>{
  const f=fixture(engine),result=f.read({tail_chars:3});
  if(engine==='game'){assert.equal(result.content,'END');assert.equal(result.offset,10000);assert.equal(result.returned,3);assert.equal(result.truncated,false);}
  else {assert.match(result,/10000–10003/);assert.match(result,/END/);assert.match(result,/已到文件末尾/);}
  f.good(f.run('apply_patch',{path,old_str:'END',new_str:'DONE'}));
  assert.match(V.readFile(f.save.tree,path,{cap:20000}).content,/DONE$/);
 });
 test(engine+': oversized tail requests return the final capped segment',()=>{
  const text='a'.repeat(140000)+'THE END',f=fixture(engine,text),result=f.read({tail_chars:999999});
  if(engine==='game'){assert.equal(result.content,text.slice(-120000));assert.equal(result.returned,120000);assert.equal(result.offset,text.length-120000);}
  else {assert.match(result,/THE END/);assert.match(result,new RegExp((text.length-120000)+'–'+text.length));}
 });
 test(engine+': tail cannot be combined with offset or limit and invalid requests do not unlock files',()=>{
  const f=fixture(engine);
  for(const args of [{tail_chars:3,offset:0},{tail_chars:3,limit:3},{tail_chars:0},{tail_chars:null}]){
   const out=f.run('read_file',{path,...args});assert.match(engine==='game'?out.error:out.result,/tail_chars/);
  }
  const out=f.run('write_file',{path,content:'unread'});assert.match(engine==='game'?out.error:out.result,/read_file/);
 });
 test(engine+': a third adjacent small read gives one hint without changing the requested data',()=>{
  const f=fixture(engine);
  assert.equal(f.hint(f.read({offset:0,limit:400})), '');
  assert.equal(f.hint(f.read({offset:400,limit:400})), '');
  const third=f.read({offset:800,limit:400});assert.ok(f.hint(third));
  if(engine==='game')assert.equal(third.returned,400);else assert.match(third,/800–1200/);
  assert.equal(f.hint(f.read({offset:1200,limit:400})), '');
 });
 test(engine+': jumps, larger pages and repeated tail reads do not get small-step hints',()=>{
  const f=fixture(engine);
  for(const offset of [0,3000,6000])assert.equal(f.hint(f.read({offset,limit:400})), '');
  for(const offset of [0,2048,4096])assert.equal(f.hint(f.read({offset,limit:2048})), '');
  for(let i=0;i<4;i++)assert.equal(f.hint(f.read({tail_chars:400})), '');
 });
 test(engine+': small batched rereads get the same one-time guidance',()=>{
  const f=fixture(engine);let hinted=0;
  for(let i=0;i<4;i++){const out=f.run('read_multiple_files',{paths:[path],limit:400});f.good(out);
   const results=engine==='game'?out.result:JSON.parse(out.result);
   assert.equal(results[0].returned,400);if(results[0].read_hint)hinted++;
  }
  assert.equal(hinted,1);
 });
 test(engine+': file-scoped search exposes usable offsets and nearby text for late matches on long lines',()=>{
  const content='前言\r\n'+ '前'.repeat(1500)+'😀已获线索编号：油布包',f=fixture(engine,content);
  const out=f.run('search',{path,pattern:'已获线索编号',target:'content'});f.good(out);
  let offset;
  if(engine==='game'){
   const hit=out.result.hits[0];assert.equal(hit.offset,content.indexOf('已获线索编号'));assert.equal(hit.line,2);
   assert.equal(hit.match_length,'已获线索编号'.length);assert.match(hit.text,/油布包/);offset=hit.read_offset;
  }else{assert.match(out.result,/油布包/);assert.match(out.result,/offset=/);offset=Number(/read_offset=(\d+)/.exec(out.result)[1]);}
  const result=f.read({offset,limit:600});assert.match(engine==='game'?result.content:result,/已获线索编号/);
 });
}
test('readonly game reference resources support the same tail options',()=>{
 const f=fixture('game'),text='reference '.repeat(1000)+'END';
 const out=Core.execute(f.save,'read_file',{path:'/.reference/book.md',tail_chars:3},'reference-tail',{resource:()=>text});
 assert.equal(out.ok,true);assert.equal(out.result.content,'END');assert.equal(out.result.offset,text.length-3);
});
test('search preserves directory traversal and result limits, and skips binary content',()=>{
 const tree=V.createTree();V.writeFile(tree,'/workspace/nested/a.txt','before\nneedle\nneedle');V.writeFile(tree,'/workspace/b.bin','needle',{encoding:'base64'});
 const r=V.search(tree,{path:'/workspace',pattern:'needle',target:'content',limit:1});
 assert.equal(r.hits.length,1);assert.equal(r.capped,true);assert.equal(r.hits[0].path,'/workspace/nested/a.txt');
 assert.equal(r.hits[0].offset,'before\n'.length);
});
test('hint counters reset for a changed file or a new user round',()=>{
 const owner={},result=offset=>({offset,returned:400,truncated:true});
 assert.equal(Reads.hint(owner,path,'v1',result(0),1),'');assert.equal(Reads.hint(owner,path,'v1',result(400),1),'');
 assert.ok(Reads.hint(owner,path,'v1',result(800),1));
 assert.equal(Reads.hint(owner,path,'v1',result(0),2),'');assert.equal(Reads.hint(owner,path,'v1',result(400),2),'');
 assert.equal(Reads.hint(owner,path,'v2',result(800),2),'');assert.equal(Reads.hint(owner,path,'v2',result(1200),2),'');
 assert.ok(Reads.hint(owner,path,'v2',result(1600),2));
});
test('both tool schemas expose optional tail_chars with offset/limit exclusions',()=>{
 const game=require('../../src/game-tools').build({toolDescription:()=>''});
 for(const tools of [game,Config.TOOL_DEFS]){
  const p=tools.find(t=>t.function.name==='read_file').function.parameters;
  assert.equal(p.properties.tail_chars.type,'integer');assert.deepEqual(p.required,['path']);
  assert.equal(p.not.anyOf.length,2);
 }
});
