'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Data=require('../../src/game-data');
function completeCard(){return {姓名:'乙',性别:'女',外貌:'短发',穿戴:{},性格:'谨慎',职业:'医生',身份:'调查员',说话习惯:'温和',原则:'救人','喜好/厌恶':'喜欢阅读',技能:{},属性:{},主动技能:[],状态:{HP:10,MAXHP:10,MP:5,MAXMP:5,Enabled:true,Alive:true},buff栏:[],当前位置:'车站'};}
test('invitation checks only the selected character info, including disabled and AIPC slots',()=>{
  for(const prefix of ['Player','DISABLE','AIPC']){
    const tree=VFS.createTree(),dir='/workspace/'+prefix+'-b',path=dir+'/基础信息.json';
    VFS.writeFile(tree,path,JSON.stringify(completeCard()));
    VFS.writeFile(tree,'/workspace/Player-a/基础信息.json','{}');
    const before=JSON.stringify(tree);
    assert.deepEqual(Data.validateCharacterInfo({tree},dir),[]);
    assert.equal(JSON.stringify(tree),before);
    const incomplete=completeCard();delete incomplete.状态.Enabled;
    VFS.writeFile(tree,path,JSON.stringify(incomplete));assert.match(Data.validateCharacterInfo({tree},dir).join('\n'),/状态字段缺失.*Enabled/);
  }
});
test('missing, malformed, incomplete and wrongly shaped character cards produce diagnostics',()=>{
  const tree=VFS.createTree(),dir='/workspace/DISABLE-b',path=dir+'/基础信息.json';
  assert.match(Data.validateCharacterInfo({tree},dir).join('\n'),/文件缺失.*基础信息/);
  for(const text of ['{broken','[]','null','{}']){
    VFS.writeFile(tree,path,text);const before=JSON.stringify(tree),issues=Data.validateCharacterInfo({tree},dir);
    assert.ok(issues.length>0,text);assert.ok(issues.every(x=>x.includes(path)));assert.equal(JSON.stringify(tree),before);
  }
  const card=completeCard();card.穿戴=[];card.主动技能=['broken'];
  VFS.writeFile(tree,path,JSON.stringify(card));const issues=Data.validateCharacterInfo({tree},dir).join('\n');
  assert.match(issues,/穿戴格式/);assert.match(issues,/对象格式/);
});
