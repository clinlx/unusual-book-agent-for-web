'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const JSZip=require('jszip'),Builder=require('../../src/world-designer/builder-tools'),Slots=require('../../src/game-slots'),Data=require('../../src/game-data'),Catalog=require('../../src/game-catalog');
const Core=require('../../src/game-core');
const Sync=require('../../src/multiplayer-sync');
const Import=require('../../src/game-import');
const dir=path.resolve(__dirname,'../../dist'),names=['追书人','鬼屋','常暗之厢','大雨倾盆然后','影子','猫咪来了铃声响','猫牌大扫除','古茂密林之中','猩红文档'];
function missingPublishedFiles(...files){
 const missing=files.filter(file=>!fs.existsSync(path.join(dir,file)));
 return missing.length?'本地发布素材未提供：'+missing.join('、'):false;
}
async function load(name){
 const bytes=fs.readFileSync(path.join(dir,'files',name+'.zip'));
 const save=await Import.importSave({name:name+'.zip',arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
 return {tree:save.tree,zip:await JSZip.loadAsync(bytes)};
}
for(const name of names)test('published world '+name+' passes current structure and character validation',{skip:!fs.existsSync(path.join(dir,'files',name+'.zip'))},async()=>{
 const {tree}=await load(name),issues=Builder.validate(tree,'/workspace').errors;assert.deepEqual(issues,[]);
 for(const slot of Slots.scan(tree))assert.deepEqual(Data.validateCharacterInfo({tree},slot.path),[],slot.path);
});

test('追书人 ships two independent blank player slots and matching catalogue metadata',
 {skip:missingPublishedFiles('files/追书人.zip','modules.json','modules-full.json')},async()=>{
 const {tree,zip}=await load('追书人'),slots=Slots.scan(tree).filter(s=>s.kind!=='kpc');assert.equal(slots.length,2);
 for(const slot of slots){const card=Data.read({tree},slot.path+'/基础信息.json');assert.equal(card.姓名,'');assert.deepEqual(Data.read({tree},slot.path+'/背包.json'),[]);}
 for(const id of slots.map(s=>s.id)){const save=Core.createSave('追书人',tree);Slots.select(save,id);assert.deepEqual(Builder.validate(save.tree,'/workspace').errors,[]);}
 assert.ok(zip.file('世界状态和世界规则/多人运行规则.md'));
 assert.match(await zip.file('模组.md').async('string'),/默认双人/);
 for(const file of ['modules.json','modules-full.json']){const item=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')).find(x=>x.Name==='追书人');assert.match(item.Text,/默认双人/);assert.ok(item.Tags.some(t=>t.TagName==='1–2人'));}
});
test('published multiplayer cards remain valid when any slot is selected, disabled, reopened or assigned to AI',{skip:!fs.existsSync(path.join(dir,'files','鬼屋.zip'))},async()=>{
 for(const name of ['鬼屋','常暗之厢','影子','古茂密林之中','猩红文档']){
  const {tree}=await load(name),ids=Slots.scan(tree).filter(s=>s.kind!=='kpc').map(s=>s.id);
  for(const hostId of ids){
   const save=Core.createSave(name,tree);Slots.select(save,hostId);
   assert.equal(save.actorId,hostId);assert.equal(save.slots.filter(s=>s.kind==='player').length,1);
   assert.deepEqual(Builder.validate(save.tree,'/workspace').errors,[],name+': '+hostId);
   for(const id of ids.filter(id=>id!==hostId)){
    Slots.setMode(save,id,'ai');assert.deepEqual(Builder.validate(save.tree,'/workspace').errors,[],name+': AIPC-'+id);
    Slots.setMode(save,id,'player');assert.deepEqual(Builder.validate(save.tree,'/workspace').errors,[],name+': Player-'+id);
    assert.deepEqual(Data.validateCharacterInfo(save,save.slots.find(s=>s.id===id).path),[]);
   }
  }
 }
});
test('multiplayer worlds have independent selectable cards and valid runtime instructions',{skip:!fs.existsSync(path.join(dir,'files','鬼屋.zip'))},async()=>{
 for(const [name,count]of [['鬼屋',4],['常暗之厢',3],['影子',2],['古茂密林之中',4],['猩红文档',5]]){
  const {tree,zip}=await load(name),slots=Slots.scan(tree).filter(s=>s.kind!=='kpc');assert.equal(slots.length,count,name);
  const owned=new Map();for(const slot of slots)for(const id of Data.read({tree},slot.path+'/背包.json')){assert.ok(!owned.has(id),`${name}: ${id} is shared by two player inventories`);owned.set(id,slot.id);}
  const module=await zip.file('模组.md').async('string');assert.ok(module.includes('世界状态和世界规则/多人运行规则.md'),name);
  const runtime=await zip.file('世界状态和世界规则/多人运行规则.md').async('string');for(const word of ['private_append_story','Alive','Enabled','AIPC','DISABLE'])assert.ok(runtime.includes(word),name+': '+word);
  for(const e of Object.values(zip.files).filter(e=>!e.dir&&/\.(md|txt|json)$/.test(e.name))){const text=await e.async('string');assert.ok(!text.includes('../模组'),name+': '+e.name);assert.ok(!text.includes('禁止改回多人版'),name+': '+e.name);}
 }
});
test('published catalogues agree on player counts and split only materially different difficulties',{skip:!fs.existsSync(path.join(dir,'modules-full.json'))},()=>{
 const files=['modules.json','modules-full.json'].map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')));for(const items of files)assert.doesNotThrow(()=>Catalog.parse(items));
 for(const items of files){const ghost=items.find(x=>x.Name==='鬼屋');assert.match(ghost.Text,/单人难度：[1-5]\/5/);assert.match(ghost.Text,/多人难度：[1-5]\/5/);
  for(const item of items.filter(x=>['常暗之厢','影子'].includes(x.Name))){assert.ok(!item.Tags.some(x=>x.TagName.startsWith('单人难度')));assert.equal(item.Tags.filter(x=>x.TagName.includes('难度')).length,1);}
 }
 for(const item of files[0])assert.deepEqual(item,files[1].find(x=>x.Name===item.Name));
});
test('real multiplayer archives preserve individual story and dice privacy',{skip:!fs.existsSync(path.join(dir,'files','鬼屋.zip'))},async()=>{
 for(const name of ['鬼屋','常暗之厢','影子','古茂密林之中','猩红文档']){
  const {tree}=await load(name),save=Core.createSave(name,tree);Core.beginRound(save,'',true);
  assert.equal(Core.execute(save,'private_append_story',{entries:[{id:'p2',story:'PRIVATE_P2_STORY'}]},'private-story').ok,true);
  assert.equal(Core.execute(save,'roll_dice',{description:'PRIVATE_P2_CHECK',roller:'p2',related_attr:'侦查',is_secret:false,is_private:true,target_player:'p2',dice_dict:{检定:'1d100'},calculate_only:false,target_value:50,compare_mode:'le',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{}},'private-dice').ok,true);
  assert.equal(Core.execute(save,'append_story',{content:'',skip_output:true,one_line_summary_of_content:'本轮结束'},'public-skip').ok,true);
  const own=Sync.project(save,'p2'),other=Sync.project(save,'pc');assert.match(JSON.stringify(own),/PRIVATE_P2_STORY/);assert.match(JSON.stringify(own),/PRIVATE_P2_CHECK/);
  assert.doesNotMatch(JSON.stringify(other),/PRIVATE_P2_|当前幻境层级|幻境状态|位置所属|详细放置位置/);
  assert.ok(own.events.find(e=>e.type==='dice').private);assert.equal(other.events.filter(e=>e.type==='dice').length,0);
 }
});

for(const [name,count]of [['古茂密林之中',4],['猩红文档',5]])test(name+' catalogue download imports independent creation slots without revealing the mystery',
 {skip:missingPublishedFiles('files/'+name+'.zip','modules.json')},async()=>{
 const items=JSON.parse(fs.readFileSync(path.join(dir,'modules.json'),'utf8'));
 const item=items.find(x=>x.Name===name);assert.ok(item,'missing catalogue entry: '+name);
 assert.equal(decodeURIComponent(item.Link),'/files/'+name+'.zip');
 const {tree,zip}=await load(name),slots=Slots.scan(tree);assert.equal(slots.length,count);
 for(const slot of slots){
  assert.equal(Data.read({tree},slot.path+'/基础信息.json').姓名,'');
  assert.deepEqual(Data.read({tree},slot.path+'/背包.json'),[]);
 }
 const save=Core.createSave(name,tree);
 const firstCard=Data.read(save,slots[0].path+'/基础信息.json');firstCard.姓名='独立角色';
 Data.node(save,slots[0].path+'/基础信息.json').content=JSON.stringify(firstCard);
 for(const slot of slots.slice(1))assert.equal(Data.read(save,slot.path+'/基础信息.json').姓名,'');
 assert.ok(!zip.file('故事.txt'));assert.ok(!zip.file('.trpg-save.json'));
 const publicText=item.Introduction+'\n'+item.Text;
 assert.doesNotMatch(publicText,/格拉基|不死仆从|墨中恐惧|凯夏|窃贼-维克|封印|献祭|转化/);
 if(name==='古茂密林之中')assert.ok(item.Tags.some(t=>t.TagName.startsWith('单人难度')));
 else {
  assert.equal(item.Tags.filter(t=>t.TagName.includes('难度')).length,1);
  const opening=await zip.file('开场说明.md').async('string');
  assert.doesNotMatch(opening,/SAN\s*=\s*POW×5|默认你一个人跑/);
  for(const branch of ['维克','罗奇','弗林德斯','寇特'])assert.ok(zip.file('世界状态和世界规则/窃贼分支/窃贼-'+branch+'.md'));
 }
});
