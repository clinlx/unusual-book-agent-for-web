'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Core=require('../../src/game-core'),V=require('../../src/vfs');
const Agent=require('../../src/world-designer/agent'),Config=require('../../src/world-designer/00-config');
function setup(){const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"姓名":"测试"}');V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');V.writeFile(tree,'/workspace/a.txt','keep remove');const save=Core.createSave('参数',tree);Core.beginRound(save,'',true);return save;}
const cases=[
 ...['read_file','list_dir','tree','write_file','append_file','apply_patch','mkdir','delete'].flatMap(name=>[undefined,null,'',' \t ',false,0,{}].map(path=>({name,args:{...(path===undefined?{}:{path}),content:'x',old_str:'remove',new_str:''},field:'path'}))),
 ...['move','copy'].flatMap(name=>['from','to'].flatMap(field=>[undefined,null,'','  ',false].map(value=>({name,args:{from:'/workspace/a.txt',to:'/workspace/b.txt',[field]:value},field})))),
 ...['write_file','append_file'].map(name=>({name,args:{path:'/workspace/a.txt'},field:'content'})),
 {name:'apply_patch',args:{path:'/workspace/a.txt',old_str:'remove'},field:'new_str'},
 ...[null,'','  ',false].map(path=>({name:'search',args:{pattern:'keep',path},field:'path'})),
 ...[null,'',0,false].map(limit=>({name:'read_file',args:{path:'/workspace/a.txt',limit},field:'limit'})),
];
for(const engine of ['game','designer'])test(engine+' rejects missing or invalid file arguments before accessing the tree',()=>{
 for(const {name,args,field} of cases){if(engine==='designer'&&['tree','append_file','mkdir'].includes(name))continue;
  const s=setup(),before=JSON.stringify(s.tree);const r=engine==='game'?Core.execute(s,name,args):Agent.executeTool({tree:s.tree,skills:[],config:Config.AGENT_CONFIG},name,args);
  const error=engine==='game'?r.error:r.result;
  assert.match(error||'',new RegExp('参数 '+field),JSON.stringify({name,args,r}));
  if(engine==='game'){assert.equal(r.ok,false);assert.ok(!r.suggestion?.includes('list_dir/tree/search'));}else assert.equal(r.isWrite,false);
  assert.equal(JSON.stringify(s.tree),before);
 }
});
test('batched reads reject invalid path entries as one invalid request',()=>{
 for(const paths of [[],['/workspace/a.txt',null],['/workspace/a.txt',' ']]){const s=setup();const r=Core.execute(s,'read_multiple_files',{paths});assert.equal(r.ok,false);assert.match(r.error,/参数 paths/);assert.deepEqual(s.activeRound.readState,{});}
});
for(const engine of ['game','designer'])test(engine+' preserves explicit empty content, deletion replacements, whitespace matches and optional search scope',()=>{
 const s=setup(),ctx={tree:s.tree,skills:[],config:Config.AGENT_CONFIG};const run=(name,args)=>{const r=engine==='game'?Core.execute(s,name,args):Agent.executeTool(ctx,name,args);if(engine==='game')assert.equal(r.ok,true,JSON.stringify(r));else assert.ok(!r.result.startsWith('错误'),r.result);return r;};
 run('read_file',{path:'/workspace/a.txt',offset:0});run('apply_patch',{path:'/workspace/a.txt',old_str:'remove',new_str:''});run('read_file',{path:'/workspace/a.txt'});run('apply_patch',{path:'/workspace/a.txt',old_str:' ',new_str:''});
 assert.equal(V.readFile(s.tree,'/workspace/a.txt').content,'keep');run('write_file',{path:'/workspace/empty.txt',content:''});run('search',{pattern:'keep'});
});

test('both tool schemas describe nonempty paths while replacement text may be empty',()=>{
 const game=require('../../src/game-tools').build({toolDescription:()=>''});
 for(const tools of [game,Config.TOOL_DEFS]){
  const schema=tools.find(t=>t.function.name==='apply_patch').function.parameters;
  assert.ok(schema.required.includes('path'));assert.equal(schema.properties.path.minLength,1);
  const pattern=new RegExp(schema.properties.path.pattern);assert.ok(pattern.test('/workspace/a.txt'));assert.ok(!pattern.test('  '));
  assert.equal(schema.properties.new_str.minLength,undefined);
 }
});
