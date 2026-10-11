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
test('replay archive masks secret dice, excludes model internals and escapes user HTML',()=>{
 const html=P.historyHTML(save('<script>evil</script>',[{type:'story',content:'<img src=x onerror=evil()>',round:1,worldTime:'秋夜',at:1},{type:'dice',secret:true,content:'SECRET_DICE'},{type:'assistant',content:'INTERNAL_MODEL'},{type:'tool',content:'INTERNAL_TOOL'},{type:'player',content:'开门'}]));
 a.doesNotMatch(html,/<script>evil|<img|INTERNAL_MODEL|INTERNAL_TOOL/);
 a.match(html,/&lt;script&gt;evil/);a.match(html,/&lt;img/);a.doesNotMatch(html,/SECRET_DICE/);a.match(html,/主持人进行了一次暗骰/);a.match(html,/class="dice secret-dice"/);a.match(html,/秋夜/);a.match(html,/开门/);
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];a.equal(scripts.length,1);a.doesNotThrow(()=>new vm.Script(scripts[0][1]));
});

test('archive filters raw private audiences and masks private secret dice before serializing HTML',()=>{
 const s=save('权限边界');s.actorId='p';s.events=[
  {type:'dice',round:1,private:true,audience:['p'],targetPlayer:'p',rollerId:'p',roller:'青',content:'VISIBLE_PRIVATE_ROLL'},
  {type:'dice',round:1,private:true,audience:['other'],targetPlayer:'other',content:'OTHER_PRIVATE_ROLL'},
  {type:'dice',round:1,private:true,audience:['p'],targetPlayer:'p',secret:true,content:'HIDDEN_DARK_VALUE',description:'HIDDEN_DARK_REASON',data:{total:43219}},
  {type:'dice',round:1,audience:'host',content:'HOST_ROLL'},
  {type:'dice',round:1,rollerKind:'gm',content:'GM_ROLL'},
  {type:'story',round:1,private:true,audience:['p'],content:'OWN_PRIVATE_STORY'},
  {type:'story',round:1,private:true,audience:['other'],content:'OTHER_PRIVATE_STORY'},
  {type:'story',round:1,secret:true,content:'LEGACY_HOST_STORY'},
  {type:'player',round:1,actorId:'other',content:'',privateContent:'OTHER_ACTION'},
 ];
 const before=structuredClone(s.events),html=P.historyHTML(s);
 a.match(html,/VISIBLE_PRIVATE_ROLL/);a.match(html,/<article class="dice private-dice"/);a.match(html,/<article class="dice secret-dice private-dice"/);
 a.match(html,/<article class="story private-story"/);a.match(html,/OWN_PRIVATE_STORY/);a.match(html,/私密暗骰/);
 a.doesNotMatch(html,/OTHER_PRIVATE|HIDDEN_DARK|43219|HOST_ROLL|GM_ROLL|LEGACY_HOST_STORY|OTHER_ACTION/);
 a.equal((html.match(/<article /g)||[]).length,3);a.deepEqual(s.events,before);
});

test('archive names other actors and distinguishes own, other and private actions',()=>{
 const html=P.historyHTML({name:'联机',actorId:'p',slots:[{id:'p',name:'青'},{id:'q',name:'秋'}],events:[
  {type:'player',actorId:'p',content:'OWN_ACTION',privateContent:'OWN_PRIVATE'},
  {type:'player',actorId:'q',content:'OTHER_ACTION',privateContent:'DO_NOT_EXPORT'},
  {type:'story',private:true,content:'AUTHORIZED_SAFE_PRIVATE'},
 ]});
 a.match(html,/<article class="player player-self"/);a.match(html,/<article class="player player-other"[^>]*><header>秋的行动/);
 a.match(html,/\.player-other\{[^}]*background:#cff4fc/);a.match(html,/\.private-dice[^}]*#f3ecff/);
 a.match(html,/OWN_PRIVATE|AUTHORIZED_SAFE_PRIVATE/);a.doesNotMatch(html,/DO_NOT_EXPORT/);
});

test('raw multiplayer archive selects its own historical state instead of the host snapshot',()=>{
 const s=save('历史归属');s.actorId='p';s.slots=[{id:'p'},{id:'q'}];
 VFS.writeFile(s.tree,'/workspace/过往回合历史记忆/Round_1_Time_夜晚/玩家结束状态.json',JSON.stringify({actorId:'q',info:{姓名:'HOST_HISTORY'},items:[],actors:{p:{info:{姓名:'OWN_HISTORY'},items:[]},q:{info:{姓名:'OTHER_HISTORY'},items:[]}}}));
 VFS.writeFile(s.tree,'/workspace/过往回合历史记忆/Round_2_Time_夜晚/玩家结束状态.json',JSON.stringify({info:{姓名:'UNATTRIBUTED_HISTORY'},items:[]}));
 const html=P.historyHTML(s);a.match(html,/OWN_HISTORY/);a.doesNotMatch(html,/HOST_HISTORY|OTHER_HISTORY|UNATTRIBUTED_HISTORY/);
});
test('offline replay archive includes independent panels, native tabs and strips hidden character fields',()=>{
 const html=P.historyHTML(save('雨夜'),undefined,{info:{姓名:'青',状态:{HP:9,MAXHP:12,MP:4,MAXMP:8,SAN:60},'.秘密':'HIDDEN'},items:[{名称:'钥匙',剧情台本:'SPOILER'}]});
 for(const id of ['archive-items','archive-story','archive-status','archive-tab-items','archive-tab-story','archive-tab-status','archive-vitals','replay-next','replay-prev'])a.ok(html.includes('id="'+id+'"'),id);
 a.match(html,/data-mode="replay"/);a.match(html,/data-mode="overview"/);a.doesNotMatch(html,/HIDDEN|SPOILER/);
});
