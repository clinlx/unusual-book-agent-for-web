'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const V=require('../src/vfs'),C=require('../src/game-core');
function save(){const t=V.createTree();V.writeFile(t,'/workspace/Player-p/基础信息.json',JSON.stringify({name:'林青',当前位置:'秘密房间',Principles:'秘密原则',状态:{HP:10,MAXHP:12}}));V.writeFile(t,'/workspace/Player-p/背包.json',JSON.stringify([{名称:'钥匙',剧情台本:'秘密剧情',Action:{解锁:'暗门'},位置所属:'密室'}]));return C.createSave('测试',t);}
const plan={Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'};
const diceArgs=overrides=>({description:'检定',roller:'青',related_attr:'观察',is_secret:false,dice_dict:{检定:'1d100'},calculate_only:false,target_value:50,compare_mode:'le',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{},...overrides});
test('reference visibility aliases never reach player panels',()=>{const p=C.player(save());assert.equal(p.name,'林青');assert.doesNotMatch(JSON.stringify(p),/秘密|暗门|密室/);});
test('phase plan rejects whitespace and objects without consuming action',()=>{const s=save();C.beginRound(s,'行动');assert.equal(C.execute(s,'trigger_next_round',{phase_plan:{...plan,Countdowns:' ',Forced_Checks:{}}},'bad').ok,false);assert.equal(s.activeRound.triggered,false);});
test('new call ids cannot publish the same story twice but distinct segments work',()=>{const s=save();C.beginRound(s,'',true);const a={content:'故事',one_line_summary_of_content:'摘要'};assert.equal(C.execute(s,'append_story',a,'a').ok,true);assert.equal(C.execute(s,'append_story',a,'b').ok,false);assert.equal(C.execute(s,'append_story',{...a,content:'下一段'},'c').ok,true);assert.equal(s.events.filter(e=>e.type==='story').length,2);});
test('structural warnings accompany success and name missing references',()=>{const s=save();V.writeFile(s.tree,'/workspace/Player-p/背包.json','["missing"]');C.beginRound(s,'',true);const r=C.execute(s,'append_story',{content:'故事',one_line_summary_of_content:'摘要'},'a');assert.equal(r.ok,true);assert.match(JSON.stringify(r.result.warnings),/missing/);assert.match(JSON.stringify(r.result.warnings),/世界规则|世界状态/);});
test('cache reference checks start after initial three rounds',()=>{for(const round of [0,3]){const s=save();s.round=round;C.beginRound(s,'',true);C.execute(s,'append_story',{content:'故事',one_line_summary_of_content:'摘要'},'a');const r=C.execute(s,'end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Current_Story_Progress:{所在文件:'ghost.md',剧情关键词:'ghost'}}},'b');assert.equal(r.ok,true);assert.equal((r.result.warnings||[]).some(x=>x.includes('ghost.md')),round===3);}});
test('rollback recovers submitted action and story carries world time',()=>{const s=save();s.status='waiting';s.cache={Game_World_Time:'秋夜'};C.beginRound(s,'敲门');C.execute(s,'trigger_next_round',{phase_plan:plan},'t');C.execute(s,'append_story',{content:'门开了',one_line_summary_of_content:'开门'},'a');assert.equal(s.events.find(e=>e.type==='story').worldTime,'秋夜');C.rollback(s);assert.equal(s.draft,'敲门');});
test('structural audit covers character lists, scene references, and exact reference filenames',()=>{
 const D=require('../src/game-data'),s=save();
 for(const p of ['关系记忆.json','格式化记忆.json','关系图.json','待办与目标.json'])V.writeFile(s.tree,'/workspace/Player-p/'+p,'{}');
 V.writeFile(s.tree,'/workspace/Player-p/日志.txt','');
 V.writeFile(s.tree,'/workspace/Player-p/基础信息.json',JSON.stringify({Name:'青',Gender:'女',Appearance:'黑发',Wearing:{足部:'key'},Personality:'谨慎',Occupation:'调查员',Identity:'访客',SpeakingStyle:'平静',Principles:'保密',Preferences:'咖啡',Skills:{观察:40},Stats:{},ActiveSkills:[],Status:{HP:10,MaxHealth:12,MP:5,MaxMana:10,Enabled:true,Alive:true},Buffs:[],Location:'站台'}));
 V.writeFile(s.tree,'/workspace/Player-p/背包.json','["key"]');
 V.writeFile(s.tree,'/workspace/存档-索引-物品/key/物品基础信息.json',JSON.stringify({Name:'钥匙',Description:'铜',Owner:'主角',Visibility:true,Amount:1,Actions:{}}));V.writeFile(s.tree,'/workspace/存档-索引-物品/key/物品日志.txt','');
 for(const dir of ['剧情线与进度','世界状态和世界规则','存档-索引-NPC','存档-世界','存档-旧'])V.mkdirp(s.tree,['workspace',dir]);
 for(const p of ['剧情线与进度/主线剧情.md','世界状态和世界规则/世界规则.md','世界状态和世界规则/掷骰规则.md','存档-世界/世界日志.txt'])V.writeFile(s.tree,'/workspace/'+p,'规则');
 V.writeFile(s.tree,'/workspace/世界状态和世界规则/世界共识.json','{"WorldTime":"夜晚"}');
 assert.deepEqual(D.validate(s),[]);
 V.writeFile(s.tree,'/workspace/存档-世界/车站/场景信息.json','{}');V.writeFile(s.tree,'/workspace/存档-世界/车站/NPC列表.json','["不存在的NPC"]');
 const warnings=D.validate(s).join('\n');assert.match(warnings,/场景台本/);assert.match(warnings,/不存在的NPC/);assert.doesNotMatch(warnings,/角色日志/);
});
test('reference keyword checks inspect actual contents and phase plans return soft warnings',()=>{
 const s=save();s.round=3;V.writeFile(s.tree,'/workspace/剧情.md','正确关键词');C.beginRound(s,'查看');
 const r=C.execute(s,'trigger_next_round',{phase_plan:{...plan,Pending_Triggers:[{所在文件:'剧情.md',事件关键词:'错误关键词'}]}},'t');assert.equal(r.ok,true);assert.match(r.result.warnings.join(''),/关键词缺失/);
 const D=require('../src/game-data');assert.deepEqual(D.references(s,[{所在文件:'剧情.md',事件关键词:'正确关键词'}]),[]);
});
test('phase-plan tool schema agrees with its nonempty text runtime contract',()=>{const Tools=require('../src/game-tools');const tool=Tools.build({toolDescription:()=>''}).find(x=>x.function.name==='trigger_next_round');const shape=tool.function.parameters.properties.phase_plan.anyOf.find(x=>x.type==='object');assert.equal(shape.properties.Countdowns.type,'string');assert.equal(shape.properties.Forced_Checks.type,'string');});
test('player projection rejects invalid JSON root shapes for stale fallback',()=>{const s=save();V.writeFile(s.tree,'/workspace/Player-p/基础信息.json','null');assert.throws(()=>C.player(s),/对象/);});

test('critical dice show possible hints and suppress ordinary comparison',()=>{const r=C.dice(diceArgs({dice_dict:{检定:'set-force:1'},left_modifiers:{加值:100},critical_success_range:[1,1],critical_failure_range:[100,100]}));assert.match(r.content,/可能是大成功/);assert.doesNotMatch(r.content,/可能是大失败/);assert.match(r.content,/已省略比较/);assert.doesNotMatch(r.content,/未通过|通过/);});
test('overlapping closed critical ranges fail before rolling and emit no dice event',()=>{
 for(const [success,failure] of [[[1,5],[5,10]],[[1,10],[3,4]],[[5,8],[1,6]],[[1,1],[1,1]]]){
  const s=save();C.beginRound(s,'',true);let rolls=0;
  const args=diceArgs({critical_success_range:success,critical_failure_range:failure});
  const r=C.execute(s,'roll_dice',args,'overlap',{random:()=>{rolls++;return .5;}});
  assert.equal(r.ok,false);assert.match(r.error,/重叠/);assert.equal(rolls,0);assert.equal(s.events.filter(e=>e.type==='dice').length,0);
  assert.equal(C.execute(s,'roll_dice',{...args,critical_success_range:'[1,5]',critical_failure_range:'[96,100]'},'corrected',{random:()=>.5}).ok,true);
 }
 assert.throws(()=>C.dice(diceArgs({calculate_only:true,critical_success_range:[1,5],critical_failure_range:[5,9]})),/重叠/);
});
test('random selection reports weights and probabilities',()=>{const s=save();C.beginRound(s,'',true);const r=C.execute(s,'random_select',{items:['甲','乙'],weights:[1,3]},'random',{random:()=>0});assert.equal(r.result.selected,'甲');assert.deepEqual(r.result.details.map(x=>x.probability),[.25,.75]);});

test('player sections can refresh independently when another JSON file breaks',()=>{const s=save();V.writeFile(s.tree,'/workspace/Player-p/背包.json','{');assert.equal(C.player(s,'info').name,'林青');V.writeFile(s.tree,'/workspace/Player-p/背包.json','[]');V.writeFile(s.tree,'/workspace/Player-p/基础信息.json','{');assert.deepEqual(C.player(s,'items').items,[]);});
