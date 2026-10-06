'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const V=require('../../src/vfs'),Core=require('../../src/game-core');
const Agent=require('../../src/world-designer/agent'),Config=require('../../src/world-designer/00-config');

function harness(kind){
  const tree=V.createTree();
  V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"姓名":"林青","年龄":20,"状态":{"Alive":true,"Enabled":true}}');
  V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');
  if(kind==='game'){
    const save=Core.createSave('validation',tree);Core.beginRound(save,'',true);
    let id=0;
    return {get tree(){return save.tree;},call:(name,args)=>{const out=Core.execute(save,name,args,'check-'+(++id));return {ok:out.ok,error:out.error||''};}};
  }
  const ctx={tree,skills:[],config:Config.AGENT_CONFIG,readState:new Map()};
  return {tree,call:(name,args)=>{const out=Agent.executeTool(ctx,name,args);return {ok:!out.result.startsWith('错误:'),error:out.result};}};
}

for(const kind of ['game','designer']){
  for(const [label,path,content,pattern] of [
    ['invalid JSON','/workspace/new/sub/state.JSON','{broken',/JSON/],
    ['duplicate bag IDs','/workspace/Player-pc/背包.json','["key","coin","key","coin"]',/重复.*key/],
    ['duplicate scene IDs','/workspace/scene/场景物品列表.json','["key","key"]',/重复.*key/],
    ['annotated identity','/workspace/Player-pc/基础信息.json','{"姓名":"林青","年龄":"20（原为35）","Occupation":"医生→护卫"}',/注释.*年龄.*Occupation/],
  ])test(kind+': rejects '+label+' before writing',()=>{
    const h=harness(kind);if(V.resolve(h.tree,V.normalize(path)))h.call('read_file',{path});
    const before=structuredClone(h.tree),out=h.call('write_file',{path,content});
    assert.equal(out.ok,false,out.error);assert.match(out.error,pattern);assert.deepEqual(h.tree,before);
    if(label.includes('IDs'))assert.match(out.error,/0.*2|0.*1/);
  });

  test(kind+': checks complete patched candidate and allows repairing old bad JSON',()=>{
    const h=harness(kind),path='/workspace/state.json';V.writeFile(h.tree,path,'{"value":1}');h.call('read_file',{path});
    const before=structuredClone(h.tree),bad=h.call('apply_patch',{path,old_str:'1',new_str:'broken'});
    assert.equal(bad.ok,false,bad.error);assert.deepEqual(h.tree,before);
    assert.equal(h.call('apply_patch',{path,old_str:'1',new_str:'2'}).ok,true);
    V.writeFile(h.tree,path,'{broken');h.call('read_file',{path});
    assert.equal(h.call('apply_patch',{path,old_str:'{broken',new_str:'{"fixed":true}'}).ok,true);
  });

  for(const tool of ['copy','move'])test(kind+': '+tool+' validates destination subtree before changing either path',()=>{
    const h=harness(kind);V.writeFile(h.tree,'/workspace/source/readme.txt','ok');
    V.writeFile(h.tree,'/workspace/source/deep/背包.json','["key","key"]');
    const before=structuredClone(h.tree),out=h.call(tool,{from:'/workspace/source',to:'/workspace/new/target'});
    assert.equal(out.ok,false,out.error);assert.match(out.error,/重复/);assert.deepEqual(h.tree,before);
    V.writeFile(h.tree,'/workspace/draft.txt','{broken');
    const draft=structuredClone(h.tree),rename=h.call(tool,{from:'/workspace/draft.txt',to:'/workspace/ready.json'});
    assert.equal(rename.ok,false,rename.error);assert.deepEqual(h.tree,draft);
  });

  test(kind+': destination identity rules catch renamed text and nested world directories',()=>{
    const h=harness(kind);V.writeFile(h.tree,'/workspace/template.txt','{"Age":{"Value":"20→30"}}');
    const before=structuredClone(h.tree),out=h.call('copy',{from:'/workspace/template.txt',to:'/workspace/world/Player-p1/基础信息.json'});
    assert.equal(out.ok,false,out.error);assert.match(out.error,/Age.Value/);assert.deepEqual(h.tree,before);
  });

  test(kind+': subtree validation follows actual child keys in legacy metadata',()=>{
    const h=harness(kind);V.writeFile(h.tree,'/workspace/source/背包.json','["key","key"]');
    V.resolve(h.tree,['workspace','source','背包.json']).name='display.txt';
    const before=structuredClone(h.tree),out=h.call('copy',{from:'/workspace/source',to:'/workspace/destination'});
    assert.equal(out.ok,false,out.error);assert.match(out.error,/重复/);assert.deepEqual(h.tree,before);
  });

  test(kind+': preserves valid JSON text, duplicate NPC entries, descriptive prose and staged JSON',()=>{
    const h=harness(kind),text='\uFEFF{\n  "姓名": "林青", "描述": "职业：医生（兼任护卫）→休假"\n}\n';
    const path='/workspace/world/Player-p1/基础信息.json';assert.equal(h.call('write_file',{path,content:text}).ok,true);
    assert.equal(V.resolve(h.tree,V.normalize(path)).content,text);
    assert.equal(h.call('write_file',{path:'/workspace/NPC列表.json',content:'["npc","npc"]'}).ok,true);
    assert.equal(h.call('write_file',{path:'/workspace/draft.txt',content:'{broken'}).ok,true);
    assert.equal(h.call('write_file',{path:'/workspace/staged.txt',content:'{"value":1}'}).ok,true);
    assert.equal(h.call('move',{from:'/workspace/staged.txt',to:'/workspace/ready.json'}).ok,true);
  });
}

test('game: append_file validates resulting JSON and rolls back rejection',()=>{
  const h=harness('game'),path='/workspace/state.json';V.writeFile(h.tree,path,'{"value":1}');h.call('read_file',{path});
  const before=structuredClone(h.tree),out=h.call('append_file',{path,content:'broken'});
  assert.equal(out.ok,false,out.error);assert.deepEqual(h.tree,before);
  assert.equal(h.call('append_file',{path,content:'\n'}).ok,true);
});

test('document text output cannot bypass JSON and item-list write validation',async()=>{
  const Documents=require('../../src/world-designer/documents');
  for(const [target,text,pattern]of [['/workspace/output/data.json','{broken',/JSON/],['/workspace/output/背包.json','["key","key"]',/重复/]]){
    const h=harness('designer');V.writeFile(h.tree,'/workspace/source.docx','bytes');
    const before=structuredClone(h.tree);
    await assert.rejects(Documents.parse(h.tree,{path:'/workspace/source.docx',format:'text',output:'file',output_path:target},
      {runtime:{docx:async()=>({text})}}),pattern);
    assert.deepEqual(h.tree,before);
  }
});
