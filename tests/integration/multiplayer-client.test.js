'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Sync=require('../../src/multiplayer-sync'),Local=require('../../src/game-local-inputs'),Inputs=require('../../src/game-input-history'),VFS=require('../../src/vfs');
function setup(t){
 const tree=VFS.createTree();for(const id of ['a','b']){VFS.writeFile(tree,'/workspace/Player-'+id+'/基础信息.json',JSON.stringify({姓名:id}));VFS.writeFile(tree,'/workspace/Player-'+id+'/背包.json','[]');}
 const save={id:'game',name:'世界',slots:['a','b'].map(id=>({id,path:'/workspace/Player-'+id,kind:'player'})),tree,round:1,status:'waiting',events:[{type:'story',round:1,content:'start'}]};
 const room={roomId:'room',roundId:'r2',round:2,epoch:0,status:'collecting',members:{guest:{actorId:'a',bindingVersion:1}}},host=Sync.createHost({getSave:()=>save,getRoom:()=>room});
 const entries=new Map(),storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v)};
 const ctx=vm.createContext({MultiplayerSync:Sync,GameLocalInputs:Local,GameInputs:Inputs,localStorage:storage,crypto:globalThis.crypto,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(require.resolve('../../src/client-app'),'utf8'),ctx);const app=vm.runInContext('GameApp',ctx);t.after(()=>app.closeSave());
 let receiver,action;let syncs=0;const transport={onClient(id,fn){receiver=fn;return ()=>{};},async sendToHost(id,command){if(command.type==='sync.request'){syncs++;return receiver(await host.sync(id,command.payload));}if(command.type==='sync.ack')return;if(action)return action(command);}};
 return {ctx,app,save,room,host,storage,entries,transport,get syncs(){return syncs;},setAction:fn=>{action=fn;},receive:packet=>receiver(packet),scope:{gameId:'game',memberId:'guest',actorId:'a'}};
}
test('client requests another bound player inventory through the host without local world access',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');assert.equal(typeof f.app.inventory,'function');
 f.setAction(async c=>{assert.equal(c.type,'inventory.request');assert.equal(c.payload.actorId,'b');assert.equal(c.roomId,f.room.roomId);assert.equal(c.epoch,f.room.epoch);assert.equal(c.bindingVersion,1);await f.receive({type:'command.result',requestId:c.requestId,ok:true,inventory:{actorId:'b',name:'乙',items:[{名称:'公用地图'}]}});});
 const result=await f.app.inventory('b');assert.equal(result.items[0].名称,'公用地图');assert.equal(f.app.getState().active.tree,undefined);
});

test('disguised action options survive cancellation and rollback locally',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');const local=Local.create(f.storage);
 f.setAction(async c=>{assert.equal(c.payload.disguise,true);await f.receive({type:'command.result',requestId:c.requestId,ok:true});});
 await f.app.send('假装等车','真实藏起钥匙',{hiddenSend:true,disguiseSend:true});
 assert.equal(local.load(f.scope).inputHistory.at(-1).disguiseSend,true);
 f.setAction(async c=>{await f.receive({type:'command.result',requestId:c.requestId,ok:true,cancelled:{content:'假装等车',privateContent:'真实藏起钥匙',disguise:true}});});
 await f.app.cancelAction();assert.equal(f.app.getState().active.hiddenSend,true);assert.equal(f.app.getState().active.disguiseSend,true);
 f.room.epoch++;await f.receive(await f.host.sync('guest'));
 assert.equal(f.app.getState().active.disguiseSend,true);assert.equal(f.app.getState().active.privateDraft,'真实藏起钥匙');
});
test('newer push with stale base cursor actively resynchronizes once and duplicate packets do not loop',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');const oldRequest={scope:(await f.host.sync('guest')).scope,cursor:1,hashes:(await f.host.sync('guest')).hashes,revision:1};
 f.save.events.push({type:'story',round:1,content:'middle'});await f.receive(await f.host.sync('guest',oldRequest));
 f.save.events.push({type:'story',round:2,content:'final'});const late=await f.host.sync('guest',oldRequest);await f.receive(late);
 assert.equal(f.app.getState().active.events.at(-1).content,'final');const count=f.syncs;await f.receive(late);assert.equal(f.syncs,count);
});
test('submission persists pending before transport and acknowledgement updates fresh active object after a pushed round',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');const local=Local.create(f.storage);
 f.setAction(async command=>{const pending=local.load(f.scope).inputHistory.at(-1);assert.equal(pending.status,'pending');assert.equal(pending.requestId,command.requestId);
   f.save.round=2;f.room.roundId='r3';f.room.round=3;f.save.events.push({type:'story',round:2,content:'finished'});await f.receive(await f.host.sync('guest'));
   await f.receive({type:'command.result',requestId:command.requestId,ok:true});
 });
 await f.app.send('开门','藏钥匙');const active=f.app.getState().active;
 assert.equal(active.round,2);assert.equal(active.inputHistory.at(-1).text,'开门');assert.equal(active.inputHistory.at(-1).privateContent,'藏钥匙');assert.equal(active.inputHistory.at(-1).status,'accepted');assert.equal(local.load(f.scope).inputHistory.at(-1).status,'accepted');
});
test('rollback restores exact public/private draft and late acknowledgements cannot revive retracted input',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');
 f.setAction(async command=>{f.room.epoch=1;f.room.roundId='redo-r2';await f.receive(await f.host.sync('guest'));await f.receive({type:'command.result',requestId:command.requestId,ok:true});});
 await f.app.send('查看门','偷偷查看锁');const active=f.app.getState().active;
 assert.equal(active.draft,'查看门');assert.equal(active.privateDraft,'偷偷查看锁');assert.equal(active.inputHistory[0].status,'retracted');
});
test('switching actor during acknowledgement never writes previous actor input into the new actor',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');
 f.setAction(async command=>{f.room.members.guest.actorId='b';f.room.members.guest.bindingVersion++;await f.receive(await f.host.sync('guest'));await f.receive({type:'command.result',requestId:command.requestId,ok:true});});
 await f.app.send('角色甲的输入','甲的秘密');assert.equal(f.app.getState().active.actorId,'b');assert.equal(f.app.getState().active.inputHistory.length,0);
 assert.equal(Local.create(f.storage).load(f.scope).inputHistory[0].text,'角色甲的输入');
});
test('private drafts survive reconnect and stale input bindings cannot overwrite the new actor',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');const binding=Inputs.owner(f.app.getState().active);
 await f.app.saveDraft('仅本人草稿',binding,{private:true});await f.app.connect(f.transport,'guest');
 assert.equal(f.app.getState().active.privateDraft,'仅本人草稿');assert.equal(f.app.getState().active.draft,'');
 f.room.members.guest.actorId='b';f.room.members.guest.bindingVersion++;await f.receive(await f.host.sync('guest'));
 await f.app.saveDraft('过期异角色文本',binding,{private:true});assert.equal(f.app.getState().active.privateDraft,'');
});
test('failed transport preserves pending private input and an explicit retry reuses its request ID',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');let first;
 f.setAction(async command=>{first=command.requestId;throw Error('offline');});
 await assert.rejects(f.app.send('','秘密行动'),/offline/);
 const local=Local.create(f.storage);assert.equal(local.load(f.scope).privateDraft,'秘密行动');assert.equal(local.load(f.scope).inputHistory[0].status,'pending');
 f.setAction(async command=>{assert.equal(command.requestId,first);await f.receive({type:'command.result',requestId:command.requestId,ok:true});});
 await f.app.send('','秘密行动');assert.equal(local.load(f.scope).inputHistory.length,1);assert.equal(local.load(f.scope).inputHistory[0].status,'accepted');assert.equal(f.app.getState().active.privateDraft,'');
});
test('unassigned lobby can request a slot without creating local player input records',async t=>{
 const f=setup(t);f.room.members.guest.actorId=null;await f.app.connect(f.transport,'guest');assert.equal(f.app.getState().active.actorId,null);assert.equal(f.entries.size,0);
 await assert.rejects(f.app.send('行动'),/角色槽位/);
 f.setAction(command=>f.receive({type:'command.result',requestId:command.requestId,ok:true}));await f.app.roomCommand('slot.claim.request',{actorId:'a'});
 f.room.members.guest.actorId='a';f.room.members.guest.bindingVersion++;await f.receive(await f.host.sync('guest'));assert.equal(f.app.getState().active.actorId,'a');
});
test('room closure preserves view and editable drafts but rejects sends and late old room packets',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');await f.receive({type:'room.closed',roomId:'room'});
 assert.equal(f.app.getState().error,'房间已关闭');await f.app.saveDraft('离线草稿',Inputs.owner(f.app.getState().active));assert.equal(Local.create(f.storage).load(f.scope).draft,'离线草稿');await assert.rejects(f.app.send('不能发送'),/房间已关闭/);
 f.save.events.push({type:'story',round:2,content:'late-old-room'});await f.receive(await f.host.sync('guest'));assert.equal(f.app.getState().room.online,false);assert.ok(!f.app.getState().active.events.some(e=>e.content==='late-old-room'));
});

test('real connection lifecycle joins through adapter and keeps its sync baseline across reconnect',async t=>{
 const f=setup(t);let onState,closed=false;
 f.ctx.BridgeTransport={parseInvitation:x=>x,async createClient(options){onState=options.onState;return {transport:f.transport,memberId:'guest',close(){closed=true;},reconnect:async()=>{}};}};
 assert.equal(typeof f.app.joinRoom,'function');
 await f.app.joinRoom({version:1,roomId:'room',memberId:'guest',url:'ws://127.0.0.1:8080',token:'test-token'});
 assert.equal(f.app.getState().active.actorId,'a');await f.app.saveDraft('断线保留');
 await onState({status:'reconnecting',message:'连接中断'});
 await assert.rejects(f.app.send('不能离线提交'),/连接|重连/);
 const before=f.syncs;f.save.events.push({type:'story',round:2,content:'重连补齐'});
 await onState({status:'connected'});
 assert.ok(f.syncs>before);assert.equal(f.app.getState().active.events.at(-1).content,'重连补齐');assert.equal(f.app.getState().active.draft,'断线保留');
 f.app.closeSave();assert.equal(closed,true);
});

test('public and private drafts persist together and cancellation restores both without reviving old confirmations',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');const binding=Inputs.owner(f.app.getState().active);
 await f.app.saveDraft('公开草稿',binding,{privateContent:'私密草稿'});await f.app.connect(f.transport,'guest');
 assert.equal(f.app.getState().active.draft,'公开草稿');assert.equal(f.app.getState().active.privateDraft,'私密草稿');
 f.setAction(async c=>f.receive({type:'command.result',requestId:c.requestId,ok:true,...c.type==='action.cancel'?{cancelled:{content:'公开草稿',privateContent:'私密草稿'}}:{}}));
 await f.app.send('公开草稿','私密草稿');await f.app.cancelAction();
 assert.equal(f.app.getState().active.draft,'公开草稿');assert.equal(f.app.getState().active.privateDraft,'私密草稿');assert.equal(f.app.getState().active.inputHistory.at(-1).status,'cancelled');
 const local=Local.create(f.storage),old=local.load(f.scope).inputHistory.at(-1);assert.throws(()=>local.record(f.scope,{...old,status:'accepted'}),{code:'LOCAL_INPUT_STALE'});
});

test('late cancellation confirmation cannot replace a newer submission or its draft',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');let submitted;
 f.setAction(async c=>{submitted=c;await f.receive({type:'command.result',requestId:c.requestId,ok:true});});await f.app.send('旧行动','旧秘密');
 const local=Local.create(f.storage);f.setAction(async c=>{
   const old=local.load(f.scope).inputHistory.at(-1);local.record(f.scope,{...old,requestId:'newer-submit',text:'新行动',privateContent:'新秘密',status:'pending'});
   local.save(f.scope,{draft:'新的草稿',privateDraft:'新的私密草稿'});
   await f.receive({type:'command.result',requestId:c.requestId,ok:true,cancelledRequestId:submitted.requestId,cancelled:{content:'旧行动',privateContent:'旧秘密'}});
 });await f.app.cancelAction();
 assert.equal(local.load(f.scope).inputHistory.at(-1).requestId,'newer-submit');assert.equal(local.load(f.scope).inputHistory.at(-1).status,'pending');assert.equal(local.load(f.scope).draft,'新的草稿');
});
test('a receive awaiting hash verification cannot write into a newly attached member session',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');f.save.events.push({type:'story',audience:['a'],round:2,content:'old-session-secret'});const oldPacket=await f.host.sync('guest');
 f.room.members.other={actorId:'b',bindingVersion:1};const late=f.app.receive(oldPacket);const connecting=f.app.connect(f.transport,'other');
 await Promise.all([late,connecting]);assert.equal(f.app.getState().active.actorId,'b');assert.ok(!JSON.stringify(f.app.getState()).includes('old-session-secret'));
});
test('failure sending the initial sync closes the created Bridge session and detaches its listener',async t=>{
 const f=setup(t);let closed=false,detached=false;f.ctx.BridgeTransport={parseInvitation:value=>value,async createClient({onState}){onState({status:'connected'});return {memberId:'guest',close(){closed=true;},transport:{onClient(){return()=>{detached=true;};},async sendToHost(){throw Error('initial sync failed');}}};}};
 await assert.rejects(f.app.joinRoom({}),/initial sync failed/);assert.equal(closed,true);assert.equal(detached,true);assert.equal(f.app.getState().network.status,'disconnected');
});
