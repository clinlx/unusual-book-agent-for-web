'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const C=require('../../src/game-core'),V=require('../../src/vfs'),T=require('../../src/game-tools'),Sync=require('../../src/multiplayer-sync');
const rejected='草稿已被否定。接下来，优化和雕琢后，重新小说化的形式，身临其境地给玩家';
function save(){const tree=V.createTree();V.writeFile(tree,'/workspace/Player-p/基础信息.json','{}');V.writeFile(tree,'/workspace/Player-p/背包.json','[]');const s=C.createSave('审稿',tree);C.beginRound(s,'',true,'本轮任务');return s;}
const args={content:'雨落在屋檐上。',one_line_summary_of_content:'雨声'};
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
test('append_story requires an explicit final boolean self_accept',()=>{
 const schema=T.build({toolDescription:n=>n}).find(t=>t.function.name==='append_story').function.parameters;
 a.equal(Object.keys(schema.properties).at(-1),'self_accept');a.ok(schema.required.includes('self_accept'));a.equal(schema.properties.self_accept.type,'boolean');
 for(const extra of [{},{self_accept:null},{self_accept:'true'},{self_accept:1}]){const s=save();a.equal(C.execute(s,'append_story',{...args,...extra}).ok,false);a.equal(s.activeRound.published,0);}
 a.equal(C.execute(save(),'append_story',{self_accept:true,...args}).ok,false);
});
test('rejected drafts are failed receipts, never stories, summaries or public projections; retries use new IDs',()=>{
 const s=save(),out=C.execute(s,'append_story',{...args,self_accept:false},'rejected');
 a.deepEqual(out,{ok:false,error:rejected});a.equal(s.activeRound.published,0);a.deepEqual(s.activeRound.summary,[]);
 a.equal(s.events.some(e=>e.type==='story'),false);a.equal(s.events.at(-1).success,false);a.doesNotMatch(JSON.stringify(Sync.project(s,'p')),/雨落在屋檐上/);
 a.equal(C.execute(s,'end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'early').ok,false);
 a.deepEqual(C.execute(s,'append_story',{...args,self_accept:true},'rejected'),out);
 a.equal(C.execute(s,'append_story',{...args,self_accept:true},'accepted').ok,true);a.equal(s.activeRound.published,1);a.equal(s.events.filter(e=>e.type==='story').length,1);
});
test('context compression records rejected drafts as failed and does not treat them as published',async()=>{
 const s=save();let requests=0;
 await C.run(s,async messages=>{
   if(++requests===1)return {tool_calls:[call('draft','append_story',{content:'未接受草稿'.repeat(5000),one_line_summary_of_content:'未接受摘要',self_accept:false})]};
   const checkpoint=messages.find(m=>m.content?.startsWith('[本回合执行记录]'));a.ok(checkpoint);
   const progress=JSON.parse(checkpoint.content.split('\n').slice(1).join('\n'));a.equal(progress.published,0);a.deepEqual(progress.summary,[]);a.ok(progress.recent_calls.some(c=>c.id==='draft'&&c.ok===false));
   return {tool_calls:[call('final','append_story',{...args,self_accept:true}),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]};
 },{system:'规则',cap:2200});
 a.equal(requests,2);a.equal(s.round,1);a.doesNotMatch(JSON.stringify(s.summaries),/未接受/);
 C.rebuildContext(s,{system:'规则',roundPrompt:'继续',startPrompt:'开局'});a.doesNotMatch(JSON.stringify(s.messages),/未接受/);
});
test('private-only public completion still requires acceptance and supports editable rejection feedback',()=>{
 const s=save();a.equal(C.execute(s,'private_append_story',{entries:[{id:'p',story:'私密成品'}]},'private').ok,true);
 const skip={content:'',skip_output:true,one_line_summary_of_content:'仅私密输出'};
 a.equal(C.execute(s,'append_story',skip,'missing').ok,false);
 a.deepEqual(C.execute(s,'append_story',{...skip,self_accept:false},'reject',{storyRejected:'自定义修订反馈'}),{ok:false,error:'自定义修订反馈'});
 a.equal(s.activeRound.published,0);a.equal(s.activeRound.privatePublished,1);
 a.equal(C.execute(s,'append_story',{...skip,self_accept:true},'accept').ok,true);a.equal(s.activeRound.published,1);
});
test('old pending program-authored preset calls upgrade without assuming consent for model calls',async()=>{
 const s=save();s.activeRound.presetOpening='预设正文';s.activeRound.presetPrepared=true;
 s.messages.push({role:'assistant',round:1,origin:'preset-opening',tool_calls:[call('preset','append_story',{content:'预设正文',one_line_summary_of_content:'预设摘要'}),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏前准备'}})]});
 await C.run(s,()=>a.fail('preset does not call AI'));a.equal(s.round,1);a.equal(s.events.filter(e=>e.type==='story').length,1);
 const model=save();a.equal(C.execute(model,'append_story',args).ok,false);
});
