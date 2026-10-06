'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Core=require('../../src/game-core'),V=require('../../src/vfs');
const vm=require('node:vm'),fs=require('node:fs');
const args=overrides=>({description:'理智检定',roller:'林砚',related_attr:'SAN',is_secret:false,calculate_only:false,
  dice_dict:{检定:'1d100'},target_value:60,compare_mode:'le',critical_success_range:[1,1],critical_failure_range:[100,100],
  dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{},...overrides});
function save(){const t=V.createTree();V.writeFile(t,'/workspace/Player-pc/基础信息.json','{"姓名":"林砚","状态":{"Alive":true,"Enabled":true}}');V.writeFile(t,'/workspace/Player-pc/背包.json','[]');const s=Core.createSave('dice isolation',t);Core.beginRound(s,'',true);return s;}

test('mixed SAN and loss dice in independent mode are rejected before rolling',()=>{
  let rolls=0;
  assert.throws(()=>Core.dice(args({dice_dict:{D100:'1d100',损失量:'1d3'},dice_combine_mode:'independent'}),()=>{rolls++;return .5;}),/independent.*拆.*roll_dice/);
  assert.equal(rolls,0);
});

test('independent batches reject mixed count, sign and actual/fixed dice specifications',()=>{
  for(const pair of [['1d6','2d6'],['1d6','-1d6'],['1d100','set-force:42']])
    assert.throws(()=>Core.dice(args({dice_dict:{甲:pair[0],乙:pair[1]},dice_combine_mode:'independent'})),/independent/);
});

test('same-spec independent checks keep row outcomes isolated and have no aggregate verdict',()=>{
  const r=Core.dice(args({dice_dict:{甲:'1d100',乙:'01D100'},dice_combine_mode:'independent'}),()=>.5,[1,42]).data;
  assert.equal(r.rows[0].special,true);assert.equal(r.rows[1].special,false);assert.deepEqual(r.rows[1].criticalHints,[]);
  assert.equal(r.success,null);assert.equal(r.critical,null);assert.deepEqual(r.criticalHints,[]);
  assert.equal(r.special,false);
  assert.equal(r.rows[1].compare_mode,'le');assert.equal(r.rows[1].left,0);assert.equal(r.rows[1].right,0);
});

test('sum of independent rows cannot generate a false critical result',()=>{
  const r=Core.dice(args({dice_dict:{甲:'1d100',乙:'1d100'},dice_combine_mode:'independent',critical_success_range:[50,50]}),()=>.5,[20,30]).data;
  assert.ok(r.rows.every(row=>!row.special));assert.equal(r.special,false);assert.deepEqual(r.criticalHints,[]);
});

test('calculate-only loss ignores critical ranges entirely',()=>{
  const r=Core.dice(args({description:'理智损失',dice_dict:{损失量:'1d3'},calculate_only:true,target_value:null,compare_mode:null}),()=>.5,[1]);
  assert.equal(r.data.total,1);assert.equal(r.data.success,null);assert.deepEqual(r.data.criticalHints,[]);assert.equal(r.data.critical,null);
  assert.doesNotMatch(r.content,/大成功|大失败|通过/);
});

test('independent calculations never emit per-row critical hints',()=>{
  const r=Core.dice(args({calculate_only:true,target_value:null,compare_mode:null,dice_dict:{甲:'1d3',乙:'1d3'},dice_combine_mode:'independent'}),()=>.5,[1,1]);
  assert.ok(r.data.rows.every(row=>row.success===null&&!row.special&&!row.criticalHints.length));
  assert.doesNotMatch(r.content,/大成功|大失败/);
});

test('separate SAN and loss tool calls do not carry critical state into calculation',()=>{
  const s=save();const check=Core.execute(s,'roll_dice',args({dice_dict:{SAN:'set-force:1'}}),'san');
  const loss=Core.execute(s,'roll_dice',args({description:'理智损失',calculate_only:true,dice_dict:{损失量:'set-force:1'},target_value:null,compare_mode:null}),'loss');
  assert.equal(check.ok,true);assert.equal(check.result.data.special,true);assert.equal(loss.ok,true);assert.equal(loss.result.data.special,false);assert.deepEqual(loss.result.data.criticalHints,[]);
  const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(require.resolve('../../src/game-ui'),'utf8')+'\nthis.api=GameUI;',ctx);
  const html=ctx.api.eventHTML(s.events.find(e=>e.type==='dice'&&e.callId==='loss'),'play');
  assert.match(html,/仅计算/);assert.doesNotMatch(html,/大成功|大失败|通过/);
});

test('aggregate damage with different components still supports sum',()=>{
  const r=Core.dice(args({dice_dict:{基础伤害:'2d6',附加伤害:'1d4'},calculate_only:true,target_value:null,compare_mode:null}),()=>.5,[3,4,2]);
  assert.equal(r.data.total,9);assert.equal(r.data.special,false);
});

test('independent UI shows row comparison modifiers only when they apply',()=>{
  const r=Core.dice(args({dice_dict:{甲:'1d100',乙:'1d100'},dice_combine_mode:'independent',left_modifiers:{修正:10}}),()=>.5,[1,42]).data;
  const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(require.resolve('../../src/game-ui'),'utf8')+'\nthis.api=GameUI;',ctx);
  const html=ctx.api.eventHTML({type:'dice',playerRelated:true,data:r},'play');
  assert.equal((html.match(/class="dice-modifier"/g)||[]).length,1);
  assert.match(html,/52/);assert.match(html,/dice-compare/);assert.match(html,/大成功/);
});

test('mixed independent request is rejected before a manual dice prompt exists',async()=>{
  const s=save();let requests=0;
  const call=(name,a,id)=>({id,function:{name,arguments:JSON.stringify(a)}});
  await Core.run(s,async()=>({tool_calls:++requests===1?[call('roll_dice',args({dice_dict:{检定:'1d100',损失:'1d3'},dice_combine_mode:'independent'}),'mixed')]:[
    call('append_story',{content:'等待分别结算检定与损失。',one_line_summary_of_content:'等待结算'},'story'),
    call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end')]}),{manualDice:true});
  assert.equal(s.pendingManualDice,undefined);assert.equal(s.events.filter(e=>e.type==='dice').length,0);
  assert.match(s.messages.find(m=>m.tool_call_id==='mixed').content,/independent/);
});
