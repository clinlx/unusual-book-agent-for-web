'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Core=require('../../src/game-core'),V=require('../../src/vfs');
const Agent=require('../../src/world-designer/agent'),Config=require('../../src/world-designer/00-config');
function setup(){const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"姓名":"测试"}');V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');const s=Core.createSave('参数',tree);Core.beginRound(s,'',true);return s;}
test('game rejects ambiguous story and round arguments without publishing or completing',()=>{
 const cases=[
  ['append_story',{content:'正文',one_line_summary_of_content:'摘要',skip_output:'false'},'skip_output'],
  ['private_append_story',{entries:[{id:'pc',story:'有效私密'},null]},'entries[1]'],
  ['private_append_story',{entries:[{id:'pc',story:'有效私密'},{id:'pc',story:3}]},'entries[1].story'],
  ['end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',game_over:'false'}},'NEXT_TURN_CACHE.game_over'],
  ['trigger_next_round',{phase_plan:{Countdowns:'无',Forced_Checks:'无',Pending_Triggers:[null]}},'phase_plan.Pending_Triggers[0]'],
  ['trigger_next_round',{phase_plan:'invalid json'},'phase_plan'],
  ['random_select',{items:['甲','乙'],weights:{0:1,1:2}},'weights'],
 ];
 for(const [name,args,field]of cases){const s=setup();if(name==='end_the_round')assert.equal(Core.execute(s,'append_story',{content:'开局',one_line_summary_of_content:'开局'}).ok,true);
  const state=()=>JSON.stringify({events:s.events.filter(e=>e.type!=='tool'),tree:s.tree,cache:s.cache});const before=state();const r=Core.execute(s,name,args);
  assert.equal(r.ok,false,JSON.stringify({name,args,r}));assert.ok(r.error.includes(field),r.error);
  assert.equal(state(),before);assert.ok(!s.activeRound.complete);
 }
});
test('designer rejects malformed controls before async callbacks or state changes',()=>{
 const cases=[
  ['view_image',{path:'/workspace/a.png',crop:{x:0,y:0,width:0,height:2}},'crop.width'],
  ['view_image',{path:'/workspace/a.png',crop:[]},'crop'],
  ['parse_document',{path:'/workspace/a.pdf',format:'txt',output:'return'},'format'],
  ['parse_document',{path:'/workspace/a.pdf',format:'text',output:'file'},'output_path'],
  ['parse_document',{path:'/workspace/a.pdf',format:'images',output:'file'},'output_dir'],
  ['parse_document',{path:'/workspace/a.pdf',format:'text',output:'return',start_page:3,end_page:1},'end_page'],
  ['parse_tavern_card',{path:'/workspace/a.png',raw_only:'false'},'raw_only'],
  ['ask_user',{questions:[{question:'选什么？',options:['甲','乙'],multiSelect:'false'}]},'questions[0].multiSelect'],
  ['run_skill',{name:'  '},'name'],
  ['goal',{action:'end',reason:'invalid'},'reason'],
 ];
 for(const [name,args,field]of cases){let called=0;const callback=()=>{called++;return Promise.resolve({});};const ctx={tree:setup().tree,config:Config.AGENT_CONFIG,skills:[{name:'tavern-card-loader'}],goal:{content:'保留目标'},viewImage:callback,parseDocument:callback,parseCard:callback,askUser:callback};
  const r=Agent.executeTool(ctx,name,args);assert.equal(called,0);assert.equal(r.pending,undefined,JSON.stringify({name,args,r}));assert.ok(r.result.includes(field),r.result);assert.equal(ctx.goal.content,'保留目标');
 }
});
test('valid legacy forms and optional values retain their behavior',()=>{
 const s=setup();const plan={Countdowns:'无',Forced_Checks:'无',Pending_Triggers:[],extra:'保留'};
 assert.equal(Core.execute(s,'trigger_next_round',{phase_plan:JSON.stringify(plan)}).ok,true);
 const r=Core.execute(s,'random_select',{options:[{name:'甲',weight:2},{name:'乙',weight:3}],weights:[1]},undefined,{random:()=>0});
 assert.equal(r.ok,true);assert.deepEqual(r.result.details.map(x=>x.weight),[1,3]);
 const ctx={tree:s.tree,config:Config.AGENT_CONFIG,askUser:qs=>Promise.resolve(qs)};
 const q=Agent.executeTool(ctx,'ask_user',{questions:[{question:'选什么？',options:['甲','乙'],multiSelect:false}]});assert.ok(q.pending);
 assert.doesNotMatch(Agent.executeTool(ctx,'list_dir',{path:'/workspace',limit:0,output_dir:null}).result,/错误/);
});

test('dice enum validation rejects inherited object properties and retains legacy ranges',()=>{
 const args={description:'侦查',roller:'pc',related_attr:'侦查',is_secret:false,dice_dict:{d100:'1d100'},calculate_only:false,target_value:50,compare_mode:'le',critical_success_range:'[1,5]',critical_failure_range:'96,100',dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{}};
 const s=setup();assert.equal(Core.execute(s,'roll_dice',args,undefined,{random:()=>0.2}).ok,true);
 for(const compare_mode of ['toString','constructor','__proto__']){const r=Core.execute(s,'roll_dice',{...args,compare_mode});assert.equal(r.ok,false);assert.match(r.error,/compare_mode/);}
});

test('published schemas specify bounds and preserve canonical valid formats',()=>{
 const game=require('../../src/game-tools').build({toolDescription:()=>''});
 const schema=(tools,name)=>tools.find(t=>t.function.name===name).function.parameters.properties;
 const dice=schema(game,'roll_dice');assert.equal(dice.dice_dict.minProperties,1);
 const pattern=new RegExp(dice.dice_dict.additionalProperties.pattern);
 for(const formula of ['1d100','-2D6','set-force:-1',' SET-FORCE:2 ','3'])assert.ok(pattern.test(formula),formula);
 assert.ok(!pattern.test('d100'));assert.equal(schema(game,'random_select').items.minItems,1);
 for(const tools of [game,Config.TOOL_DEFS]){
  assert.equal(schema(tools,'read_file').offset.minimum,0);assert.equal(schema(tools,'read_file').limit.minimum,1);
  assert.equal(schema(tools,'apply_patch').old_str.minLength,1);assert.equal(schema(tools,'apply_patch').new_str.minLength,undefined);
 }
 const crop=schema(Config.TOOL_DEFS,'view_image').crop;assert.equal(crop.properties.x.minimum,0);assert.equal(crop.properties.width.minimum,1);
 assert.equal(schema(Config.TOOL_DEFS,'ask_user').questions.maxItems,3);
});
