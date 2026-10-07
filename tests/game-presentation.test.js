'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
let P;try{P=require('../src/game-presentation');}catch(_){P={};}
const VFS=require('../src/vfs');
const Core=require('../src/game-core');
const vm=require('node:vm');
function save(name,events=[]){const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"青"}');VFS.writeFile(tree,'/workspace/Player-p/背包.json','[]');return {...Core.createSave(name,tree),events};}
test('vitals respect invalid current values, aliases, and SAN default',()=>{a.equal(typeof P.vitals,'function');const v=P.vitals({Status:{HP:'',MP:4,MaxMana:10,Sanity:55},Stats:{HP:12,MaxHealth:20}});a.equal(v.hp,null);a.equal(v.mp.ratio,.4);a.equal(v.san.max,99);});
test('secondary resource follows sole changed resource, preserves both changes',()=>{a.equal(typeof P.secondary,'function');const old={mp:{value:5},san:{value:50}};a.equal(P.secondary('mp',old,{mp:{value:5},san:{value:49}}),'san');a.equal(P.secondary('san',old,{mp:{value:4},san:{value:49}}),'san');});
test('diff matches named array entries across reorders and preserves deletions',()=>{a.equal(typeof P.diff,'function');const d=P.diff([{名称:'钥匙',余量:'2个'},{名称:'书'}],[{名称:'书'},{名称:'钥匙',余量:'1个'}]);a.equal(d.children[0].status,'same');a.equal(d.children[1].children.find(x=>x.label==='余量').status,'decreased');const deleted=P.diff([{名称:'书'}],[]);a.equal(deleted.children[0].status,'deleted');});

test('inventory changes use colored tags distinct from ordinary text in panels and exports',()=>{
 const old=[{名称:'钥匙',余量:2}],next=[{名称:'钥匙',余量:1},{名称:'书',信息:'新增只是书上的文字'}];
 const html=P.fields(next,old,'inventory');
 a.match(html,/class="change-tag added">新增<\/span>/);
 a.match(html,/class="change-tag decreased">减少<\/span>/);
 a.match(html,/新增只是书上的文字/);
 a.doesNotMatch(html,/<small> 新增/);
 const archive=P.historyHTML(save('变化标签'),undefined,{info:{姓名:'青'},items:next});
 a.match(archive,/\.change-tag/);
});
test('reader cache is per save, flags stale data, recovers and can invalidate',()=>{a.equal(typeof P.createReader,'function');const read=P.createReader(s=>{if(s.bad)throw Error('坏 JSON');return {info:{姓名:s.name},items:[]};}),s={name:'A'},other={name:'B',bad:true};a.equal(read(s).stale,false);s.bad=true;a.equal(read(s).info.姓名,'A');a.equal(read(s).stale,true);a.equal(read(other).info,undefined);s.bad=false;s.name='C';a.equal(read(s).info.姓名,'C');read.clear(s);s.bad=true;a.equal(read(s).info,undefined);});
test('replay archive includes secret dice, excludes model internals and escapes user HTML',()=>{
 const html=P.historyHTML(save('<script>evil</script>',[{type:'story',content:'<img src=x onerror=evil()>',round:1,worldTime:'秋夜',at:1},{type:'dice',secret:true,content:'SECRET_DICE'},{type:'assistant',content:'INTERNAL_MODEL'},{type:'tool',content:'INTERNAL_TOOL'},{type:'player',content:'开门'}]));
 a.doesNotMatch(html,/<script>evil|<img|INTERNAL_MODEL|INTERNAL_TOOL/);
 a.match(html,/&lt;script&gt;evil/);a.match(html,/&lt;img/);a.match(html,/SECRET_DICE/);a.match(html,/class="dice secret-dice"/);a.match(html,/秋夜/);a.match(html,/开门/);
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];a.equal(scripts.length,1);a.doesNotThrow(()=>new vm.Script(scripts[0][1]));
});
test('offline replay archive includes independent panels, native tabs and strips hidden character fields',()=>{
 const html=P.historyHTML(save('雨夜'),undefined,{info:{姓名:'青',状态:{HP:9,MAXHP:12,MP:4,MAXMP:8,SAN:60},'.秘密':'HIDDEN'},items:[{名称:'钥匙',剧情台本:'SPOILER'}]});
 for(const id of ['archive-items','archive-story','archive-status','archive-tab-items','archive-tab-story','archive-tab-status','archive-vitals','replay-next','replay-prev'])a.ok(html.includes('id="'+id+'"'),id);
 a.match(html,/data-mode="replay"/);a.match(html,/data-mode="overview"/);a.doesNotMatch(html,/HIDDEN|SPOILER/);
});
