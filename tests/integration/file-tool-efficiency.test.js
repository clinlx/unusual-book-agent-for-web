'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Core=require('../../src/game-core'),V=require('../../src/vfs');
const Agent=require('../../src/world-designer/agent'),Config=require('../../src/world-designer/00-config');
function fixture(engine){
 const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"姓名":"测试"}');V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');V.writeFile(tree,'/workspace/a.txt','alpha beta');
 const save=Core.createSave('测试',tree);Core.beginRound(save,'',true);
 const ctx={tree:save.tree,skills:[],config:Config.AGENT_CONFIG,readState:new Map()};
 const run=(name,args,id)=>engine==='game'?Core.execute(save,name,args,id):Agent.executeTool(ctx,name,args,{callId:id});
 const good=r=>engine==='game'?assert.equal(r.ok,true,JSON.stringify(r)):assert.doesNotMatch(r.result,/^错误/,r.result);
 const bad=(r,re)=>{if(engine==='game')assert.equal(r.ok,false);else assert.equal(r.isWrite,false);assert.match(engine==='game'?r.error:r.result,re);};
 const read=()=>good(run('read_file',{path:'/workspace/a.txt'}));
 return {save,ctx,run,good,bad,read,content:()=>V.readFile(save.tree,'/workspace/a.txt').content};
}
for(const engine of ['game','designer']){
 test(engine+' successful writes refresh knowledge, failed writes do not, external edits invalidate it',()=>{
  const f=fixture(engine),{run,good,bad,read}=f;read();
  good(run('apply_patch',{path:'/workspace/a.txt',old_str:'alpha',new_str:'one'}));
  good(run('apply_patch',{path:'/workspace/a.txt',old_str:'beta',new_str:'two'}));
  good(run('write_file',{path:'/workspace/a.txt',content:'whole'}));
  good(run('apply_patch',{path:'/workspace/a.txt',old_str:'whole',new_str:'next'}));
  good(run('append_file',{path:'/workspace/a.txt',content:'!'}));
  bad(run('apply_patch',{path:'/workspace/a.txt',old_str:'absent',new_str:'bad'}),/old_str/);
  good(run('apply_patch',{path:'/workspace/a.txt',old_str:'next!',new_str:'known'}));
  V.writeFile(f.save.tree,'/workspace/a.txt','known externally');
  bad(run('apply_patch',{path:'/workspace/a.txt',old_str:'known',new_str:'lost'}),/read_file/);
  read();good(run('apply_patch',{path:'/workspace/a.txt',old_str:'known',new_str:'safe'}));
  assert.equal(f.content(),'safe externally');
 });
 test(engine+' applies sequential patch batches atomically and validates only final JSON',()=>{
  const {run,good,bad,read,content,save}=fixture(engine);read();
  good(run('apply_patch',{path:'/workspace/a.txt',patches:[{old_str:'alpha',new_str:'first'},{old_str:'first beta',new_str:'done'}]},'batch'));
  assert.equal(content(),'done');
  bad(run('apply_patch',{path:'/workspace/a.txt',patches:[{old_str:'done',new_str:'part'},{old_str:'missing',new_str:''}]}),/patches\[1\]/);
  assert.equal(content(),'done');
  good(run('write_file',{path:'/workspace/test.json',content:'{"a":1,"b":2}'}));
  good(run('apply_patch',{path:'/workspace/test.json',patches:[{old_str:'1',new_str:'TEMP'},{old_str:'TEMP',new_str:'3'}]}));
  assert.equal(V.readFile(save.tree,'/workspace/test.json').content,'{"a":3,"b":2}');
  bad(run('apply_patch',{path:'/workspace/a.txt',old_str:'done',new_str:'x',patches:[]}),/patches|混用|同时/);
  bad(run('apply_patch',{path:'/workspace/a.txt',patches:[{old_str:'done',new_str:4}]}),/patches\[0\].new_str/);
 });
 test(engine+' unrelated tool calls do not expire unchanged file knowledge',()=>{
  const {run,good,read}=fixture(engine);read();
  for(let i=0;i<40;i++)good(run('list_dir',{path:'/workspace'}));
  good(run('write_file',{path:'/workspace/a.txt',content:'overwrite'}));
 });
 test(engine+' batched reads provide per-file results and unlock subsequent edits',()=>{
  const {run,good,save}=fixture(engine);
  const r=run('read_multiple_files',{paths:['/workspace/a.txt','/workspace/missing.txt']});good(r);
  const result=engine==='game'?r.result:JSON.parse(r.result);
  assert.equal(result.length,2);assert.match(result[0].content,/alpha/);assert.match(result[1].error,/不存在/);
  good(run('apply_patch',{path:'/workspace/a.txt',old_str:'alpha',new_str:'new'}));
  assert.equal(V.readFile(save.tree,'/workspace/a.txt').content,'new beta');
 });
 test(engine+' transfers only known contents through copy or move and invalidates deleted subtrees',()=>{
  const {run,good,bad,save}=fixture(engine);
  good(run('copy',{from:'/workspace/a.txt',to:'/workspace/unread.txt'}));
  bad(run('write_file',{path:'/workspace/unread.txt',content:'unknown'}),/read_file/);
  good(run('write_file',{path:'/workspace/folder/a.txt',content:'known'}));
  good(run('move',{from:'/workspace/folder',to:'/workspace/moved'}));
  good(run('apply_patch',{path:'/workspace/moved/a.txt',old_str:'known',new_str:'fresh'}));
  good(run('delete',{path:'/workspace/moved'}));
  V.writeFile(save.tree,'/workspace/moved/a.txt','fresh');
  bad(run('write_file',{path:'/workspace/moved/a.txt',content:'recreated'}),/read_file/);
 });
}
test('game knowledge crosses rounds but expires when its evidence leaves the actual context',()=>{
 const f=fixture('game');f.good(f.run('write_file',{path:'/workspace/new.txt',content:'created'},'known'));
 const call={id:'known',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'/workspace/new.txt',content:'created'})}};
 f.save.messages.push({role:'assistant',round:1,tool_calls:[call]},{role:'tool',round:1,tool_call_id:'known',content:JSON.stringify(f.save.activeRound.receipts.known)});
 Core.context(f.save,'规则',10000);f.good(f.run('apply_patch',{path:'/workspace/new.txt',old_str:'created',new_str:'known'},'patch'));
 f.save.messages=[];Core.context(f.save,'规则',10000);
 f.bad(f.run('write_file',{path:'/workspace/new.txt',content:'lost'}),/read_file/);
 f.read();f.good(f.run('append_story',{content:'开局',one_line_summary_of_content:'开局'}));f.good(f.run('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}}));Core.beginRound(f.save,'继续');
 f.good(f.run('apply_patch',{path:'/workspace/a.txt',old_str:'alpha',new_str:'new'}));
});
test('designer retains evidence in context but cannot carry it into a different or compressed chat',async()=>{
 const {ctx}=fixture('designer');let step=0;
 const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
 await Agent.runTurn(ctx,[],async()=>++step===1?{tool_calls:[call('write','write_file',{path:'/workspace/new.txt',content:'one'})]}:step===2?{tool_calls:[call('patch','apply_patch',{path:'/workspace/new.txt',old_str:'one',new_str:'two'})]}:{content:'done'});
 assert.equal(V.readFile(ctx.tree,'/workspace/new.txt').content,'two');
 step=0;const out=await Agent.runTurn(ctx,[],async()=>++step===1?{tool_calls:[call('lost','write_file',{path:'/workspace/new.txt',content:'wrong'})]}:{content:'done'});
 assert.match(out.newMessages.find(m=>m.tool_call_id==='lost').content,/read_file/);assert.equal(V.readFile(ctx.tree,'/workspace/new.txt').content,'two');
});
