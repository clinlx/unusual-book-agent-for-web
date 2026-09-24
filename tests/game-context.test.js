'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const VFS=require('../src/vfs.js');
const GameCore=require('../src/game-core.js');

function makeSave(){
  const tree=VFS.createTree();
  VFS.mkdirp(tree,['workspace','Player-Test']);
  VFS.writeFile(tree,'/workspace/Player-Test/基础信息.json',JSON.stringify({姓名:'测试者'}));
  VFS.writeFile(tree,'/workspace/Player-Test/背包.json','[]');
  return GameCore.createSave('context-prefix',tree);
}
function endCall(round,marker){
  return {role:'assistant',round,content:'',tool_calls:[{id:'end-'+round,type:'function',function:{name:'end_the_round',arguments:JSON.stringify({NEXT_TURN_CACHE:{Story_Phase:'游戏循环',marker}})}}]};
}

test('full history stays append-only and does not synthesize latest cache near the prefix',()=>{
  const s=makeSave();
  s.messages=[
    {role:'user',round:1,content:'round-1'},
    endCall(1,'r1'),
    {role:'tool',round:1,tool_call_id:'end-1',content:'{"ok":true}'},
    {role:'user',round:2,content:'round-2'}
  ];
  s.round=1;
  s.cache={Story_Phase:'游戏循环',marker:'latest'};
  const out=GameCore.context(s,'SYSTEM',100000,{cachePrompt:'CACHE'});
  assert.deepEqual(out.map(m=>m.content),['SYSTEM','round-1','','{"ok":true}','round-2']);
  assert.equal(out.some(m=>typeof m.content==='string'&&m.content.startsWith('CACHE\n')),false);
});

test('after truncation the injected cache is fixed to the truncation boundary',()=>{
  const s=makeSave();
  s.messages=[
    {role:'user',round:1,content:'round-1'},
    endCall(1,'r1'),
    {role:'tool',round:1,tool_call_id:'end-1',content:'{"ok":true}'},
    {role:'user',round:2,content:'round-2'},
    endCall(2,'r2'),
    {role:'tool',round:2,tool_call_id:'end-2',content:'{"ok":true}'},
    {role:'user',round:3,content:'round-3'}
  ];
  s.summaries=[{round:1,content:'summary-1'}];
  s.round=2;
  s.contextFromRound=2;
  s.cache={Story_Phase:'游戏循环',marker:'latest-a'};

  const first=GameCore.context(s,'SYSTEM',100000,{cachePrompt:'CACHE',summariesPrompt:'SUMMARY'});
  assert.equal(first[0].content,'SYSTEM');
  assert.match(first[1].content,/^SUMMARY\n/);
  assert.match(first[2].content,/^CACHE\n/);
  assert.match(first[2].content,/"marker":"r1"/);
  assert.doesNotMatch(first[2].content,/latest-a/);

  s.cache={Story_Phase:'游戏循环',marker:'latest-b'};
  const second=GameCore.context(s,'SYSTEM',100000,{cachePrompt:'CACHE',summariesPrompt:'SUMMARY'});
  assert.deepEqual(second.slice(0,3).map(m=>m.content),first.slice(0,3).map(m=>m.content));
});
