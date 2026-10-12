'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const VFS=require('../../src/vfs');
const Sync=require('../../src/multiplayer-sync');
function fixture(){
  const tree=VFS.createTree();
  for(const id of ['a','b']){
    VFS.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id,职业:'private-career-'+id,'.秘密':'secret-card-'+id,状态:{Alive:true,Enabled:true}}));
    VFS.writeFile(tree,`/workspace/Player-${id}/背包.json`,id==='a'?'["key"]':'[]');
  }
  VFS.writeFile(tree,'/workspace/存档-索引-物品/key/物品基础信息.json',JSON.stringify({名称:'钥匙',余量:1,位置所属:'private-location',Action字典:{秘密:'private-script'}}));
  const save={id:'world',name:'多人',tree,round:1,status:'waiting',playerPath:'/workspace/Player-a',slots:['a','b'].map(id=>({id,path:'/workspace/Player-'+id,kind:'human'})),events:[{type:'story',round:1,content:'公开故事',audience:'public',args:{secret:'raw-args'},id:'source-event-uuid'}],summaries:['secret-summary'],cache:{secret:'secret-cache'}};
  const room={roomId:'room',epoch:0,roundId:'round-2',status:'collecting',members:{one:{actorId:'a',bindingVersion:1,connected:true},two:{actorId:'b',bindingVersion:1,connected:true}},submissions:{a:{content:'public-action',privateContent:'private-submission'}}};
  return {save,room,host:Sync.createHost({getSave:()=>save,getRoom:()=>room})};
}

test('disguised actions expose only their public cover to other players and private edits preserve their hashes',async()=>{
  const {save,host}=fixture(),a=Sync.createClient(),b=Sync.createClient();
  save.events.push({type:'player',round:1,actorId:'a',content:'我在等车',privateContent:'暗中藏好钥匙',disguise:true});
  await a.apply(await host.sync('one'));await b.apply(await host.sync('two'));
  const own=a.getState().view.events.at(-1),other=b.getState().view.events.at(-1);
  assert.equal(own.privateContent,'暗中藏好钥匙');assert.equal(own.disguise,true);
  assert.equal(other.content,'我在等车');assert.equal(other.privateContent,undefined);assert.equal(other.disguise,undefined);
  const before=b.request();save.events.at(-1).privateContent='改为取出钥匙';save.events.at(-1).disguise=false;
  const packet=await host.sync('two',before);assert.deepEqual(packet.hashes,before.hashes);assert.equal(packet.events.length,0);
  assert.ok(!JSON.stringify(packet).includes('disguise'));assert.ok(!JSON.stringify(packet).includes('钥匙'));
});

test('on-demand player profiles share sanitized character fields only with bound players',()=>{
 const {save,room}=fixture();
 VFS.writeFile(save.tree,'/workspace/Player-a/基础信息.json',JSON.stringify({姓名:'甲',职业:'侦探',密码:'password-secret',当前位置:'secret-location','.秘密':'private-truth',技能:{侦查:60,'.隐藏数值':99},经历:[{描述:'公开经历'},{'.是否对玩家隐藏':true,描述:'hidden-history'}]}));
 const profile=Sync.profile(save,'a',{room,memberId:'two'});assert.equal(profile.info.职业,'侦探');assert.equal(profile.info.技能.侦查,60);
 for(const hidden of ['password-secret','secret-location','private-truth','隐藏数值','hidden-history','items','tree','messages'])assert.ok(!JSON.stringify(profile).includes(hidden),hidden);
 assert.throws(()=>Sync.profile(save,'../Player-a',{room,memberId:'two'}));
 room.members.lobby={actorId:null};assert.throws(()=>Sync.profile(save,'a',{room,memberId:'lobby'}));
 delete room.members.one;assert.throws(()=>Sync.profile(save,'a',{room,memberId:'two'}));
});

test('optional unchanged suppression skips private-only updates but preserves repair and rollback packets',async()=>{
 const {save,room,host}=fixture(),client=Sync.createClient();await client.apply(await host.sync('two'));
 const request={...client.request(),onlyIfChanged:true};
 assert.equal(await host.sync('two',request),null);
 save.events.push({type:'story',round:1,audience:['a'],content:'only a'});
 assert.equal(await host.sync('two',request),null);
 assert.ok(await host.sync('two',client.request()),'explicit repair still receives a response');
 assert.ok(await host.sync('two',{...request,cursor:0}),'mismatched cursor must not suppress repair');
 room.epoch++;assert.ok(await host.sync('two',request),'new timeline must reach client');
});
test('private mutations do not appear in another player projection, hashes, counts or serialized packets',async()=>{
  const {save,host}=fixture();const a=Sync.createClient(),b=Sync.createClient();
  await a.apply(await host.sync('one'));await b.apply(await host.sync('two'));
  const before=b.request();
  save.events.push({type:'story',round:1,audience:['a'],content:'a-only-secret',privateContent:'a-private'});
  save.events.push({type:'tool',content:'raw-tool-secret',audience:'public'});
  const pa=await host.sync('one',a.request()),pb=await host.sync('two',b.request());
  assert.equal(pa.events.length,1);assert.equal(pb.events.length,0);assert.deepEqual(pb.hashes,before.hashes);
  assert.equal(pb.revision,b.getState().revision);
  for(const word of ['a-only-secret','a-private','private-career-a','secret-card','raw-tool-secret','source-event-uuid','raw-args','secret-cache','private-submission'])assert.ok(!JSON.stringify(pb).includes(word),word);
  const snapshot=await host.sync('two');assert.ok(!JSON.stringify(snapshot).includes('private-career-a'));
  assert.deepEqual(snapshot.view.events.map(e=>e.id),['event-1']);
});
test('index-only inventory changes replace that partition and report visible local differences',async()=>{
  const {save,host}=fixture(),client=Sync.createClient();await client.apply(await host.sync('one'));
  VFS.writeFile(save.tree,'/workspace/存档-索引-物品/key/物品基础信息.json','{"名称":"钥匙","余量":2,"位置所属":"secret"}');
  const packet=await host.sync('one',client.request());
  assert.equal(packet.infoChanged,false);assert.equal(packet.itemsChanged,true);assert.equal(packet.info,undefined);
  assert.equal(packet.items[0].余量,2);assert.ok(!JSON.stringify(packet).includes('位置所属'));
  assert.equal(await client.apply(packet),true);assert.ok(client.getState().changes.items.length);
});
test('incremental synchronization is atomic and rejects duplicate, reordered and corrupted packets',async()=>{
  const {save,host}=fixture(),client=Sync.createClient();await client.apply(await host.sync('two'));
  const baseline=client.request();save.events.push({type:'story',content:'second',round:2});
  const second=await host.sync('two',baseline);save.events.push({type:'story',content:'third',round:3});
  const third=await host.sync('two',baseline);
  assert.equal(await client.apply(third),true);assert.equal(await client.apply(second),false);assert.equal(await client.apply(third),false);
  const previous=client.getState();save.events.push({type:'story',content:'fourth',round:4});const corrupt=await host.sync('two',client.request());corrupt.events[0].content='tampered';
  assert.equal(await client.apply(corrupt),false);assert.deepEqual(client.getState(),previous);
  const reset=await host.sync('two',{...client.request(),hashes:{...client.request().hashes,history:'bad'}});assert.equal(reset.type,'snapshot');
});
test('rollback epoch resets history and rejects old timeline and old bindings',async()=>{
  const {save,room,host}=fixture(),client=Sync.createClient();await client.apply(await host.sync('two'));
  save.events.push({type:'story',content:'future',round:2});const old=await host.sync('two',client.request());
  save.events.length=0;save.round=0;room.epoch++;room.roundId='replacement';
  const reset=await host.sync('two',client.request());assert.equal(reset.type,'snapshot');assert.equal(reset.rollbackTo,0);
  assert.equal(await client.apply(reset),true);assert.equal(await client.apply(old),false);assert.equal(client.getState().view.events.length,0);
  const oldBinding=await host.sync('two');room.members.two.actorId='a';room.members.two.bindingVersion++;
  assert.equal(await client.apply(await host.sync('two',client.request())),true);assert.equal(await client.apply(oldBinding),false);
});
test('secret dice expose no result, private action text is restricted, unknown audience fails closed',()=>{
  const {save}=fixture();save.events=[
    {type:'dice',secret:true,audience:'public',content:'secret-roll-42',data:{total:42},diceArgs:{target_value:42},description:'侦查'},
    {type:'story',secret:true,content:'legacy-hidden'},
    {type:'story',audience:{oops:'public'},content:'unknown-audience'},
    {type:'story',private:true,content:'unknown-private-recipient'},
    {type:'player',actorId:'a',content:'行动',privateContent:'private-move'},
    {type:'player',actorId:'b',content:'自己的行动',privateContent:'own-secret'}
  ];
  const view=Sync.project(save,'b');const text=JSON.stringify(view);
  for(const word of ['secret-roll-42','target_value','legacy-hidden','unknown-audience','unknown-private-recipient','private-move'])assert.ok(!text.includes(word),word);
  assert.ok(text.includes('own-secret'));assert.equal(view.events[0].secret,true);assert.equal(view.events[0].data,undefined);
});
test('memory transport supports queued delivery, reordering and unsubscribing without any network',async()=>{
  const transport=Sync.createMemoryTransport({autoFlush:false}),seen=[];
  transport.onHost((memberId,message)=>seen.push([memberId,message]));const stop=transport.onClient('one',message=>seen.push(message));
  transport.sendToHost('one',{action:'submit'});transport.sendToClient('one',{type:'snapshot'});
  assert.equal(seen.length,0);await transport.flush(1);await transport.flush(0);
  assert.deepEqual(seen,[{type:'snapshot'},['one',{action:'submit'}]]);
  stop();transport.sendToClient('one',{type:'dropped'});await transport.flush();assert.equal(seen.length,2);
});
test('paged snapshots freeze a single revision and apply only once complete',async()=>{
  const {save,room}=fixture(),host=Sync.createHost({getSave:()=>save,getRoom:()=>room,pageSize:2}),client=Sync.createClient();
  for(let i=0;i<4;i++)save.events.push({type:'story',content:'page-'+i,round:1});
  const first=await host.sync('two');assert.equal(first.type,'snapshot_page');assert.equal(await client.apply(first),false);assert.equal(client.getState(),null);
  save.events.push({type:'story',content:'later',round:2});
  const second=await host.sync('two',client.request());assert.equal(await client.apply(second),false);
  assert.equal(await client.apply(second),false);
  assert.equal(await client.apply(await host.sync('two',client.request())),true);
  assert.equal(client.getState().view.events.length,5);assert.equal(client.request().snapshotId,undefined);
  assert.equal(await client.apply(await host.sync('two',client.request())),true);assert.equal(client.getState().view.events.length,6);
});
test('rollback abandons incomplete snapshot pages and host recreation can resume a verified baseline',async()=>{
  const {save,room}=fixture();let host=Sync.createHost({getSave:()=>save,getRoom:()=>room,pageSize:1});const client=Sync.createClient();
  save.events.push({type:'story',content:'old',round:2});await client.apply(await host.sync('two'));
  const oldPage=await host.sync('two',client.request());room.epoch++;save.events.length=1;save.round=0;
  assert.equal(await client.apply(await host.sync('two',client.request())),true);assert.equal(await client.apply(oldPage),false);
  for(let i=0;i<3;i++){save.events.push({type:'story',content:'new-'+i,round:1});await client.apply(await host.sync('two',client.request()));}
  const rev=client.getState().revision;host=Sync.createHost({getSave:()=>save,getRoom:()=>room});save.events.push({type:'story',content:'after-restart',round:2});
  assert.equal(await client.apply(await host.sync('two',client.request())),true);assert.ok(client.getState().revision>rev);
});
test('same-named indexed items have opaque stable identities and reordering is not an inventory gain',async()=>{
  const {save,host}=fixture(),client=Sync.createClient();
  VFS.writeFile(save.tree,'/workspace/存档-索引-物品/secret-source-id/物品基础信息.json','{"名称":"钥匙","余量":3}');
  VFS.writeFile(save.tree,'/workspace/Player-a/背包.json','["key","secret-source-id"]');
  await client.apply(await host.sync('one'));const before=client.getState().view;
  assert.equal(new Set(before.itemKeys).size,2);assert.ok(!JSON.stringify(before).includes('secret-source-id'));
  VFS.writeFile(save.tree,'/workspace/Player-a/背包.json','["secret-source-id","key"]');
  await client.apply(await host.sync('one',client.request()));const state=client.getState();
  assert.deepEqual(state.view.itemKeys,[before.itemKeys[1],before.itemKeys[0]]);assert.deepEqual(state.changes.items,[]);
});
test('client module loads without any game executor or VFS and unauthorized synchronization is rejected',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');const context=vm.createContext({crypto:globalThis.crypto,TextEncoder});
  vm.runInContext(fs.readFileSync(require.resolve('../../src/multiplayer-sync'),'utf8'),context);
  const client=vm.runInContext('MultiplayerSync.createClient()',context),{host}=fixture();
  await assert.rejects(host.sync('outsider'),{code:'SCOPE_INVALID'});
  assert.equal(await client.apply(await host.sync('two')),true);assert.equal(client.getState().view.actorId,'b');
});
test('fresh save wrappers keep anonymous item identities and unchanged partition hashes',async()=>{
  const {save,room}=fixture(),host=Sync.createHost({getSave:()=>({...save}),getRoom:()=>room}),client=Sync.createClient();
  await client.apply(await host.sync('one'));const before=client.getState();
  const packet=await host.sync('one',client.request());
  assert.equal(packet.itemsChanged,false);assert.equal(packet.revision,before.revision);assert.deepEqual(packet.hashes,before.hashes);
  const keys=(await host.sync('one')).view.itemKeys;assert.deepEqual(keys,before.view.itemKeys);
});
test('real private-story tools and safe HTML exports cannot disclose other actors or historical snapshots',()=>{
  const Core=require('../../src/game-core'),Presentation=require('../../src/game-presentation');
  const {save:base}=fixture(),save=Core.createSave('多人',base.tree);
  Core.beginRound(save,'',true);
  assert.equal(Core.execute(save,'private_append_story',{entries:[{id:'a',story:'only-a-private-story'},{id:'b',story:'only-b-private-story'}]},'private').ok,true);
  save.events.push({type:'story',secret:true,content:'legacy-host-secret'},{type:'dice',secret:true,audience:['b'],content:'secret-dice-78',data:{total:78},description:'侦查'});
  VFS.writeFile(save.tree,'/workspace/过往回合历史记忆/Round_1_Time_0/玩家结束状态.json','{"info":{"姓名":"unfiltered-history-secret"}}');
  const view=Sync.project(save,'b'),html=Presentation.historyHTML(view,undefined,view);
  assert.ok(html.includes('only-b-private-story'));
  for(const word of ['only-a-private-story','legacy-host-secret','secret-dice-78','unfiltered-history-secret','secret-card-a'])assert.ok(!html.includes(word),word);
});
test('safe export shows own private actions and only own identified round-state snapshots',()=>{
  const {save}=fixture(),Presentation=require('../../src/game-presentation');
  save.events=[{type:'player',round:1,actorId:'b',content:'',privateContent:'own-hidden-action'},{type:'player',round:1,actorId:'a',content:'public-a',privateContent:'other-hidden-action'},{type:'round_end',round:1}];
  VFS.writeFile(save.tree,'/workspace/过往回合历史记忆/Round_1_Time_0/玩家结束状态.json',JSON.stringify({actors:{a:{info:{姓名:'a','旧线索':'only-a-old-secret'},items:[]},b:{info:{姓名:'b','旧线索':'visible-own-history','.秘密':'hidden-own-history'},items:[{名称:'旧钥匙',位置所属:'hidden-owner',Action字典:{秘密:'script-hidden-payload'}}]}}}));
  const view=Sync.project(save,'b'),html=Presentation.historyHTML(view,undefined,view);
  for(const word of ['own-hidden-action','visible-own-history','旧钥匙'])assert.ok(html.includes(word),word);
  for(const word of ['other-hidden-action','only-a-old-secret','hidden-own-history','hidden-owner','script-hidden-payload'])assert.ok(!html.includes(word),word);
});
test('authorized unassigned members receive only a public lobby until a slot is granted',async()=>{
 const {save,room,host}=fixture();room.members.lobby={actorId:null,bindingVersion:0,connected:true};room.slotRequests=[{id:'claim',memberId:'lobby',actorId:'b',at:1,privateContent:'never-publish'}];
 const client=Sync.createClient(),packet=await host.sync('lobby');assert.equal(await client.apply(packet),true);const view=client.getState().view;
 assert.equal(view.actorId,null);assert.deepEqual(view.events,[]);assert.deepEqual(view.info,{});assert.deepEqual(view.items,[]);assert.equal(view.slots.length,2);assert.equal(view.room.slotRequests[0].id,'claim');
 for(const word of ['公开故事','private-career','secret-card','never-publish'])assert.ok(!JSON.stringify(packet).includes(word),word);
 room.members.lobby.actorId='b';room.members.lobby.bindingVersion++;assert.equal(await client.apply(await host.sync('lobby',client.request())),true);assert.equal(client.getState().view.actorId,'b');
});
test('other players receive no blank private-action events or history hash and cursor changes',async()=>{
 const {save,room,host}=fixture(),client=Sync.createClient();await client.apply(await host.sync('two'));const before=client.getState();
 save.events.push({type:'player',round:2,actorId:'a',audience:'public',content:'   ',privateContent:'private-action-only',skip:false});
 const packet=await host.sync('two',client.request());assert.equal(packet.cursor,before.cursor);assert.equal(packet.hashes.history,before.hashes.history);assert.deepEqual(packet.events,[]);
 const own=Sync.project(save,'a');assert.equal(own.events.at(-1).privateContent,'private-action-only');
 room.submissions.a={privateContent:'private-action-only'};assert.ok(Sync.project(save,'b',{memberId:'two',room}).slots.find(s=>s.id==='a').submitted);
 save.events.push({type:'player',round:2,actorId:'a',audience:'public',content:'',skip:true});assert.equal(Sync.project(save,'b').events.at(-1).skip,true);
});
