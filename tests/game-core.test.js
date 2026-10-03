'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const VFS = require('../src/vfs.js');
let Core; try { Core = require('../src/game-core.js'); } catch (_) { Core = {}; }
function tree() {
  const t=VFS.createTree(); VFS.mkdirp(t,['workspace']);
  VFS.writeFile(t,'/workspace/Player-p1/基础信息.json',JSON.stringify({姓名:'林青',属性:{生命:10},'.秘密':'幕后',buff栏:[{名称:'潜伏','.是否对玩家隐藏':true},{名称:'疲惫'}]}));
  VFS.writeFile(t,'/workspace/Player-p1/背包.json','["key"]');
  VFS.writeFile(t,'/workspace/存档-索引-物品/key/物品基础信息.json','{"名称":"铜钥匙",".触发器":"终局","描述":"泛绿的铜"}');
  return t;
}
function save(){assert.equal(typeof Core.createSave,'function','提供新的存档核心');return Core.createSave('测试',tree());}
const plan={Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'};
test('append_file preserves content and receipts prevent duplicate append',()=>{
 const s=save();VFS.writeFile(s.tree,'/workspace/log.txt','原文');Core.beginRound(s,'',true,'开局');
 assert.equal(Core.execute(s,'append_file',{path:'/workspace/log.txt',content:'新增'},'unread').ok,false);
 Core.execute(s,'read_file',{path:'/workspace/log.txt'},'read');
 const args={path:'/workspace/log.txt',content:'\n新增'};
 const r=Core.execute(s,'append_file',args,'append');assert.equal(r.ok,true);
 Core.execute(s,'append_file',args,'append');
 assert.equal(VFS.resolve(s.tree,['workspace','log.txt']).content,'原文\n新增');
 assert.equal(s.events.find(e=>e.callId==='append').fileChanges[0].before,'原文');
 assert.equal(Core.execute(s,'append_file',{path:'/.reference/system.md',content:'改'},'readonly').ok,false);
 assert.equal(Core.execute(s,'append_file',{path:'/workspace/missing.txt',content:'改'},'missing').ok,false);
});
test('tree respects depth, includes directories, and does not read file contents',()=>{
 const s=save();VFS.writeFile(s.tree,'/workspace/a/b/c.txt','秘密内容');Core.beginRound(s,'',true,'开局');
 const shallow=Core.execute(s,'tree',{path:'/workspace/a',depth:1},'shallow');assert.equal(shallow.ok,true);
 assert.match(shallow.result.tree,/b/);assert.doesNotMatch(shallow.result.tree,/c.txt|秘密内容/);assert.equal(shallow.result.truncated,true);
 const deep=Core.execute(s,'tree',{path:'/workspace/a',depth:3},'deep');assert.match(deep.result.tree,/c.txt/);assert.equal(deep.result.truncated,false);
 assert.equal(Core.execute(s,'tree',{path:'/workspace/a',depth:-1},'invalid').ok,false);
 const resource=Core.execute(s,'tree',{path:'/.reference',depth:3},'prompts',{resourceList:['/.reference/system.md','/.reference/reference/rule.md']});
 assert.match(resource.result.tree,/rule.md/);
});
const cache={Story_Phase:'游戏循环',Game_World_Time:'清晨',Active_Scene:'门口'};
function call(name,args,id=name){return {id,type:'function',function:{name,arguments:JSON.stringify(args)}};}
test('只接受单个 Player，不创建默认角色',()=>{
  const s=save(); assert.equal(s.playerPath,'/workspace/Player-p1');
  VFS.mkdir(s.tree,'/workspace/Player-p2'); assert.throws(()=>Core.createSave('双人',s.tree),/一个|单个|多/);
  const t=VFS.createTree();VFS.mkdirp(t,['workspace']);assert.throws(()=>Core.createSave('空',t),/Player|玩家/);
});
test('主角面板过滤隐藏字段、隐藏 buff 和物品脚本',()=>{
  const p=Core.player(save()); assert.equal(p.info.姓名,'林青');
  assert.ok(!JSON.stringify(p).includes('幕后'));assert.ok(!JSON.stringify(p).includes('终局'));
  assert.equal(p.info.buff栏.length,1);assert.equal(p.items[0].名称,'铜钥匙');
});
test('工具顺序、phase_plan 回执、正文追加和幂等性',()=>{
  const s=save();s.draft='推门';Core.beginRound(s,'推门',false,'本轮推进');
  assert.equal(s.draft,'','已经提交的行动不能在刷新后重新作为草稿出现');
  assert.equal(Core.execute(s,'append_story',{content:'门开了',one_line_summary_of_content:'开门'},'early').ok,false);
  assert.equal(Core.execute(s,'trigger_next_round',{},'bad').ok,false);
  assert.equal(Core.execute(s,'trigger_next_round',{phase_plan:plan},'trigger').ok,true);
  assert.equal(Core.execute(s,'end_the_round',{NEXT_TURN_CACHE:cache},'earlyend').ok,false);
  const args={content:'门开了。',one_line_summary_of_content:'推开门'};
  Core.execute(s,'append_story',args,'story');Core.execute(s,'append_story',args,'story');
  assert.equal(s.events.filter(e=>e.type==='story').length,1);
  assert.equal(Core.execute(s,'end_the_round',{NEXT_TURN_CACHE:cache},'end').ok,true);
  assert.equal(s.round,1);assert.equal(s.status,'waiting');assert.deepEqual(s.cache,cache);
  assert.equal(s.events.filter(e=>e.type==='round_end').length,1);
});
test('先读后写、回合快照和回退恢复所有状态',()=>{
  const s=save();Core.beginRound(s,'',true,'开局');
  const path='/workspace/Player-p1/基础信息.json';
  assert.equal(Core.execute(s,'write_file',{path,content:'{"姓名":"改名"}'},'w0').ok,false);
  Core.execute(s,'read_file',{path},'r');Core.execute(s,'write_file',{path,content:'{"姓名":"改名"}'},'w');
  Core.execute(s,'append_story',{content:'晨光亮起。',one_line_summary_of_content:'开场'},'a');
  Core.execute(s,'end_the_round',{NEXT_TURN_CACHE:cache},'e');
  assert.ok(s.lastChanges.some(c=>c.path===path));
  Core.rollback(s);assert.equal(Core.player(s).info.姓名,'林青');assert.equal(s.round,0);assert.equal(s.events.length,0);assert.equal(s.messages.length,0);
});
test('玩家暗骰保留占位事件，随机结果按调用 ID 缓存',()=>{
  const s=save();Core.beginRound(s,'',true,'开局');
  const a={description:'心理学',roller:'林青',related_attr:'心理学',is_secret:false,calculate_only:false,dice_dict:{观察:'1d100'},target_value:50,compare_mode:'le',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{}};
  let rolls=0;
  const x=Core.execute(s,'roll_dice',a,'dice',{random:()=>{rolls++;return .5;}}),y=Core.execute(s,'roll_dice',a,'dice');
  assert.equal(x.ok,true);assert.deepEqual(x,y);assert.equal(rolls,1);assert.equal(s.events.filter(e=>e.type==='dice').length,1);
  const shown=Core.visibleEvents(s,'play').filter(e=>e.type==='dice');
  assert.equal(shown.length,1);assert.equal(shown[0].secret,true);
  assert.equal(Core.visibleEvents(s,'debug').filter(e=>e.type==='dice').length,1);
});
test('玩家骰者支持姓名、完整目录名和短 ID，NPC 检定仅在 DEBUG 可见',()=>{
  const s=save();
  for(const roller of ['林青','林 青','Player-p1','p1','主角'])assert.equal(Core.dicePlayerRelated(s,{roller}),true,roller);
  const npc={type:'dice',roller:'站务员',secret:false,playerRelated:false};s.events.push(npc);
  assert.equal(Core.visibleEvents(s,'play').includes(npc),false);
  assert.equal(Core.visibleEvents(s,'debug').includes(npc),true);
  VFS.writeFile(s.tree,s.playerPath+'/基础信息.json','{"姓名":"Sam"}');
  assert.equal(Core.dicePlayerRelated(s,{roller:'Sam'}),true);
  assert.equal(Core.dicePlayerRelated(s,{roller:'am'}),false,'normalization must preserve the letter s');
});
test('中断后补齐未执行工具，不重复故事，并保留完整工具结果批次',async()=>{
  const s=save();Core.beginRound(s,'',true,'开场');
  let requests=0,aborted=false;
  const transport=async()=>{requests++;return {content:'内部内容',tool_calls:[call('append_story',{content:'雨落下。',one_line_summary_of_content:'下雨'},'a'),call('end_the_round',{NEXT_TURN_CACHE:cache},'e')]};};
  await assert.rejects(Core.run(s,transport,{system:'系统',onStep:async()=>{if(s.events.some(e=>e.type==='story'))aborted=true;},signal:{get aborted(){return aborted;}}}),/中止/);
  assert.equal(s.events.filter(e=>e.type==='story').length,1);
  await Core.run(s,transport,{system:'系统'});
  assert.equal(requests,1);assert.equal(s.status,'waiting');assert.equal(s.events.filter(e=>e.type==='story').length,1);
  assert.equal(s.messages.filter(m=>m.role==='tool').length,2);
});
test('折半切断保留系统与当前完整回合，本地历史不丢失',()=>{
  const s=save();
  for(let i=0;i<6;i++){
    Core.beginRound(s,'',true,'开局'+i);
    s.messages.push({role:'assistant',content:'长'.repeat(300),round:i+1});
    Core.execute(s,'append_story',{content:'故事'+i,one_line_summary_of_content:'概要'+i},'a'+i);
    Core.execute(s,'end_the_round',{NEXT_TURN_CACHE:cache},'e'+i);
  }
  const len=s.messages.length,events=s.events.length;
  const sent=Core.context(s,'系统',1400);assert.equal(sent[0].role,'system');
  assert.equal(s.messages.length,len);assert.equal(s.events.length,events);
  assert.ok(s.contextFromRound>1);assert.ok(sent.some(m=>m.content.includes('开局5')));
});
test('同批结束后的额外写入被阻止',async()=>{
  const s=save();Core.beginRound(s,'',true,'开局');
  await Core.run(s,async()=>({tool_calls:[call('append_story',{content:'开场',one_line_summary_of_content:'开场'}),call('end_the_round',{NEXT_TURN_CACHE:cache}),call('write_file',{path:'/workspace/坏.txt',content:'不应发生'})]}),{system:'系统'});
  assert.equal(VFS.resolve(s.tree,['workspace','坏.txt']),null);
  assert.equal(s.messages.filter(m=>m.role==='tool').length,3);
});
test('提示词目录可列举，设置覆盖后读取同一内容',()=>{
  const s=save();Core.beginRound(s,'',true,'开局');
  const resources={'/.reference/system.md':'覆盖正文','/.reference/reference/开始.md':'开始规则'};
  const options={resource:p=>resources[p],resourceList:Object.keys(resources)};
  const list=Core.execute(s,'list_dir',{path:'/.reference'},'list-p',options);
  assert.equal(list.ok,true);assert.ok(list.result.some(x=>x.name==='system.md'));assert.ok(list.result.some(x=>x.name==='reference'&&x.type==='dir'));
  assert.equal(Core.execute(s,'read_file',{path:'/.reference/system.md'},'read-p',options).result.content,'覆盖正文');
});
