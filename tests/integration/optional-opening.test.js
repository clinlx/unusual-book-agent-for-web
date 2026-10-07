'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const VFS = require('../../src/vfs');
const Core = require('../../src/game-core');
const Data = require('../../src/game-data');
const Agent = require('../../src/world-designer/agent');
const Config = require('../../src/world-designer/00-config');

test('missing opening resources are optional in tools and cache references; unrelated files still fail', () => {
  const tree=VFS.createTree();
  VFS.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"姓名":"测试"}');
  VFS.writeFile(tree,'/workspace/Player-pc/背包.json','[]');
  const save=Core.createSave('无开场文件',tree);
  Core.beginRound(save,'',true);
  const ctx={tree,skills:[],config:Config.AGENT_CONFIG,readState:new Map()};
  for(const name of ['开场说明.md','开场白.md','样例开场.md','开场原文.txt','开场剧情.txt']){
    const path='/workspace/'+name;
    const result=Core.execute(save,'read_file',{path},name);
    assert.equal(result.ok,true,result.error);
    assert.equal(result.result.exists,false);
    assert.deepEqual(Data.references(save,[{所在文件:path,剧情关键词:'未提供'}]),[]);
    const designer=Agent.executeTool(ctx,'read_file',{path});
    assert.doesNotMatch(designer.result,/^错误:/);
  }
  assert.equal(Core.execute(save,'read_file',{path:'/workspace/missing.md'},'missing').ok,false);
  assert.match(Agent.executeTool(ctx,'read_file',{path:'/workspace/missing.md'}).result,/^错误:/);
  assert.ok(Data.references(save,[{所在文件:'missing.md'}]).length);
});
