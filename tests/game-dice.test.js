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
