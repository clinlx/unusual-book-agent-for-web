'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Knowledge=require('../../src/shared/file-knowledge');
const Core=require('../../src/game-core'),V=require('../../src/vfs');
const Agent=require('../../src/world-designer/agent'),Config=require('../../src/world-designer/00-config');
const path='/workspace/a.txt';
function fixture(engine){
 const tree=V.createTree();
 V.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"测试"}');
 V.writeFile(tree,'/workspace/Player-p/背包.json','[]');
 V.writeFile(tree,path,'alpha beta');
 const save=Core.createSave('读写依据',tree);Core.beginRound(save,'',true);
 const ctx={tree:save.tree,skills:[],config:Config.AGENT_CONFIG,readState:new Map(),turn:1},messages=[];
 let sequence=0;
 const good=out=>engine==='game'?assert.equal(out.ok,true,JSON.stringify(out)):assert.doesNotMatch(out.result,/^错误/,out.result);
 const bad=(out,re)=>assert.match(engine==='game'?out.error:out.result,re);
 function run(name,args){
  const id='evidence-'+(++sequence),call={id,type:'function',function:{name,arguments:JSON.stringify(args)}};
  const out=engine==='game'?Core.execute(save,name,args,id):Agent.executeTool(ctx,name,args,{callId:id});
  const target=engine==='game'?save.messages:messages,round=save.activeRound.number;
  target.push({role:'assistant',round,tool_calls:[call]},{role:'tool',round,tool_call_id:id,content:engine==='game'?JSON.stringify(out):out.result});
  return {out,id};
 }
 function next(){
  if(engine==='game'){
   if(!save.activeRound.triggered)good(run('trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}}).out);
   good(run('append_story',{content:'继续。',one_line_summary_of_content:'继续',self_accept:true}).out);
   good(run('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}}).out);
   Core.beginRound(save,'继续');
  }else ctx.turn++;
 }
 async function request(remove=[]){
  const keep=m=>!remove.includes(m.tool_call_id)&&!m.tool_calls?.some(c=>remove.includes(c.id));
  if(engine==='game'){save.messages=save.messages.filter(keep);Core.context(save,'规则',100000);}
  else {const kept=messages.filter(keep);messages.splice(0,messages.length,...kept);await Agent.runTurn(ctx,messages,async()=>({content:'完成'}));}
 }
 return {save,ctx,run,next,request,good,bad,read:args=>run('read_file',{path,...args}),content:()=>V.readFile(engine==='game'?save.tree:ctx.tree,path).content};
}
for(const engine of ['game','designer']){
 test(engine+': partial reads count at file level; weak edits do not renew overwrite age',async()=>{
  const f=fixture(engine);f.good(f.read({offset:1,limit:1}).out);await f.request();
  f.next();await f.request();f.good(f.run('apply_patch',{path,old_str:'alpha',new_str:'one'}).out);
  f.next();await f.request();f.good(f.run('append_file',{path,content:'!'}).out);
  f.bad(f.run('write_file',{path,content:'too old'}).out,/本回合或上一回合/);
  assert.equal(f.content(),'one beta!');
  f.good(f.read({limit:1}).out);f.good(f.run('write_file',{path,content:'fresh'}).out);
  f.next();await f.request();f.good(f.run('write_file',{path,content:'next round'}).out);
 });
 test(engine+': an unchanged read supports overwrite in the immediately following round',async()=>{
  const f=fixture(engine);f.good(f.read().out);await f.request();f.next();await f.request();
  f.good(f.run('write_file',{path,content:'next'}).out);
 });
 test(engine+': the latest patch cannot stand in for a missing original read',async()=>{
  const f=fixture(engine),base=f.read();f.good(base.out);
  f.good(f.run('apply_patch',{path,old_str:'alpha',new_str:'one'}).out);
  await f.request([base.id]);
  f.bad(f.run('write_file',{path,content:'lost'}).out,/read_file/);
  f.bad(f.run('apply_patch',{path,old_str:'one',new_str:'lost'}).out,/read_file/);
  assert.equal(f.content(),'one beta');
 });
 test(engine+': every intermediate edit is required until a new read or complete write rebases it',async()=>{
  const f=fixture(engine);f.good(f.read().out);
  const first=f.run('apply_patch',{path,old_str:'alpha',new_str:'one'});f.good(first.out);
  f.good(f.run('append_file',{path,content:'!'}).out);
  await f.request([first.id]);f.bad(f.run('append_file',{path,content:'bad'}).out,/read_file/);
  f.good(f.read({limit:1}).out);f.good(f.run('write_file',{path,content:'rebased'}).out);
  await f.request();f.good(f.run('append_file',{path,content:'!'}).out);
 });
 test(engine+': failed complete writes do not renew the overwrite deadline',async()=>{
  const f=fixture(engine),jsonPath='/workspace/state.json';
  V.writeFile(f.save.tree,jsonPath,'{"value":1}');
  f.good(f.run('read_file',{path:jsonPath}).out);
  f.next();await f.request();f.bad(f.run('write_file',{path:jsonPath,content:'{broken'}).out,/JSON/);
  f.next();await f.request();f.bad(f.run('write_file',{path:jsonPath,content:'{"value":2}'}).out,/本回合或上一回合/);
 });
 test(engine+': complete writes replace their old dependencies',async()=>{
  const f=fixture(engine),base=f.read();f.good(base.out);
  const patch=f.run('apply_patch',{path,old_str:'alpha',new_str:'one'});f.good(patch.out);
  f.good(f.run('write_file',{path,content:'new basis'}).out);
  await f.request([base.id,patch.id]);f.good(f.run('append_file',{path,content:'!'}).out);
  assert.equal(f.content(),'new basis!');
 });
 test(engine+': copy and move preserve the age and original evidence of known sources',async()=>{
  const f=fixture(engine),base=f.read();f.good(base.out);
  f.next();f.next();await f.request();
  f.good(f.run('copy',{from:path,to:'/workspace/copied.txt'}).out);
  f.good(f.run('move',{from:'/workspace/copied.txt',to:'/workspace/moved.txt'}).out);
  f.bad(f.run('write_file',{path:'/workspace/moved.txt',content:'old basis'}).out,/本回合或上一回合/);
  f.good(f.run('append_file',{path:'/workspace/moved.txt',content:'!'}).out);
  await f.request([base.id]);f.bad(f.run('append_file',{path:'/workspace/moved.txt',content:'bad'}).out,/read_file/);
 });
}
test('designer UI acceptance does not renew a model read or overwrite deadline',()=>{
 const f=fixture('designer');f.good(f.read().out);f.next();f.next();
 Agent.recordRead({tree:f.ctx.tree,readState:f.ctx.readState},path);
 f.bad(f.run('write_file',{path,content:'old'}).out,/本回合或上一回合/);
});
test('game serializable evidence survives resuming the same round and rejects unknown legacy records',()=>{
 const f=fixture('game');f.good(f.read().out);
 const restored=structuredClone(f.save);
 assert.equal(Core.execute(restored,'write_file',{path,content:'resumed'},'resume').ok,true);
 restored.activeRound.fileKnowledge={sequence:1,entries:{[path]:{sequence:1,callId:'legacy'}}};
 const out=Core.execute(restored,'write_file',{path,content:'legacy'},'legacy-write');
 assert.equal(out.ok,false);assert.match(out.error,/read_file/);
});
test('startup read receipts remain evidence, while archived receipts do not',()=>{
 const k=Knowledge.create(1);Knowledge.record(k,path,'startup');
 let forgotten=false;
 Knowledge.retain(k,[{role:'user',content:'[开局预读资料]\n'+JSON.stringify({operations:[{call_id:'startup',result:{ok:true}}]})}],()=>{forgotten=true;});
 assert.equal(forgotten,false);assert.equal(Knowledge.canOverwrite(k,path),true);
 Knowledge.retain(k,[{role:'user',content:'[开局预读资料]\n'+JSON.stringify({operations:[{call_id:'startup',result:{ok:true,archived:true}}]})}],()=>{forgotten=true;});
 assert.equal(forgotten,true);
});
test('game rollback does not inherit evidence from a discarded branch',()=>{
 const f=fixture('game');f.good(f.read().out);f.next();Core.rollback(f.save);
 Core.beginRound(f.save,'另一条分支');
 assert.equal(Core.execute(f.save,'write_file',{path,content:'unknown'},'branch-write').ok,false);
});
