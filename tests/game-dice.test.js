'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const GameCore=require('../src/game-core.js');

const base=overrides=>({
  description:'侦查检定',roller:'测试者',related_attr:'侦查',is_secret:false,dice_dict:{d100:'1d100'},calculate_only:false,
  target_value:70,compare_mode:'le',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'sum',
  left_modifiers:{},right_modifiers:{},...overrides
});

test('formal dice check rejects bare integer values',()=>{
  assert.throws(()=>GameCore.dice(base({dice_dict:{d100:'1'}})),/正式检定禁止使用裸整数/);
});

test('formal dice check accepts an actual die expression',()=>{
  const result=GameCore.dice(base(),()=>0);
  assert.deepEqual(result.data.rows[0].rolls,[1]);
  assert.equal(result.data.raw,1);
  assert.equal(result.data.success,true);
});

test('calculate_only still allows integer constants',()=>{
  const result=GameCore.dice(base({description:'计算',roller:'系统',related_attr:'计算',dice_dict:{基础:'10',加值:'2'},calculate_only:true,target_value:null,compare_mode:null}));
  assert.equal(result.data.raw,12);
  assert.equal(result.data.success,null);
});

test('formal dice check accepts explicit set-force result without rolling',()=>{
  let called=0;
  const result=GameCore.dice(base({dice_dict:{d100:'set-force:1'}}),()=>{called++;return .9;});
  assert.equal(called,0);
  assert.deepEqual(result.data.rows[0].rolls,[1]);
  assert.equal(result.data.rows[0].forced,true);
  assert.equal(result.data.success,true);
});

test('formal dice check can mix rolled dice and set-force values',()=>{
  const result=GameCore.dice(base({related_attr:'混合',dice_dict:{随机:'1d6',固定:'set-force:3'},target_value:10}),()=>0);
  assert.deepEqual(result.data.rows.map(row=>row.rolls),[[1],[3]]);
  assert.equal(result.data.raw,4);
});

test('set-force supports explicit negative integers',()=>{
  const result=GameCore.dice(base({description:'固定负值',roller:'系统',related_attr:'计算',dice_dict:{固定:'set-force:-3'},calculate_only:true,target_value:null,compare_mode:null}));
  assert.equal(result.data.raw,-3);
});

test('roll_dice requires the complete argument shape at runtime',()=>{
  const args=base();delete args.related_attr;delete args.left_modifiers;
  assert.throws(()=>GameCore.dice(args),/缺少必填参数.*related_attr.*left_modifiers/);
});

test('critical ranges accept arrays and legacy comma strings',()=>{
  const arrayResult=GameCore.dice(base({critical_success_range:[1,14],critical_failure_range:[96,100]}),()=>0);
  assert.equal(arrayResult.data.special,true);
  const legacyResult=GameCore.dice(base({critical_success_range:'1,14',critical_failure_range:'96,100'}),()=>.5);
  assert.equal(legacyResult.data.target,70);
});
