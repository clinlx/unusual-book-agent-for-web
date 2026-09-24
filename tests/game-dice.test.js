'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const GameCore=require('../src/game-core.js');

test('formal dice check rejects bare integer values',()=>{
  assert.throws(()=>GameCore.dice({
    description:'侦查',
    roller:'测试者',
    related_attr:'侦查',
    is_secret:false,
    dice_dict:{侦查:'1'},
    target_value:70,
    compare_mode:'le'
  }),/正式检定.*NdM/);
});

test('formal dice check accepts an actual die expression',()=>{
  const result=GameCore.dice({
    description:'侦查',
    roller:'测试者',
    related_attr:'侦查',
    is_secret:false,
    dice_dict:{侦查:'1d100'},
    target_value:70,
    compare_mode:'le'
  },()=>0);
  assert.deepEqual(result.data.rows[0].rolls,[1]);
  assert.equal(result.data.raw,1);
  assert.equal(result.data.success,true);
});

test('calculate_only still allows integer constants',()=>{
  const result=GameCore.dice({
    description:'计算',
    roller:'系统',
    is_secret:false,
    dice_dict:{基础:'10',加值:'2'},
    calculate_only:true
  });
  assert.equal(result.data.raw,12);
  assert.equal(result.data.success,null);
});


test('formal dice check accepts explicit set-force result without rolling',()=>{
  let called=0;
  const result=GameCore.dice({
    description:'强制结果',
    roller:'测试者',
    related_attr:'侦查',
    is_secret:false,
    dice_dict:{侦查:'set-force:1'},
    target_value:70,
    compare_mode:'le'
  },()=>{called++;return .9;});
  assert.equal(called,0);
  assert.deepEqual(result.data.rows[0].rolls,[1]);
  assert.equal(result.data.rows[0].forced,true);
  assert.equal(result.data.raw,1);
  assert.equal(result.data.success,true);
});

test('formal dice check can mix rolled dice and set-force values',()=>{
  const result=GameCore.dice({
    description:'混合检定',
    roller:'测试者',
    is_secret:false,
    dice_dict:{随机:'1d6',固定:'set-force:3'},
    target_value:10,
    compare_mode:'le'
  },()=>0);
  assert.deepEqual(result.data.rows.map(row=>row.rolls),[[1],[3]]);
  assert.equal(result.data.raw,4);
});

test('set-force supports explicit negative integers',()=>{
  const result=GameCore.dice({
    description:'固定负值',
    roller:'系统',
    is_secret:false,
    dice_dict:{固定:'set-force:-3'},
    calculate_only:true
  });
  assert.equal(result.data.raw,-3);
});
