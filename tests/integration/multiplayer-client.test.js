'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Sync=require('../../src/multiplayer-sync'),Local=require('../../src/game-local-inputs'),Inputs=require('../../src/game-input-history'),VFS=require('../../src/vfs');
function setup(t){
 const tree=VFS.createTree();for(const id of ['a','b']){VFS.writeFile(tree,'/workspace/Player-'+id+'/基础信息.json',JSON.stringify({姓名:id}));VFS.writeFile(tree,'/workspace/Player-'+id+'/背包.json','[]');}
 const save={id:'game',name:'世界',slots:['a','b'].map(id=>({id,path:'/workspace/Player-'+id,kind:'player'})),tree,round:1,status:'waiting',events:[{type:'story',round:1,content:'start'}]};
 const room={roomId:'room',roundId:'r2',round:2,epoch:0,status:'collecting',members:{guest:{actorId:'a',bindingVersion:1}}},host=Sync.createHost({getSave:()=>save,getRoom:()=>room});
 const entries=new Map(),storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v)};
 const storageListeners=[];
 const ctx=vm.createContext({addEventListener:(name,fn)=>{if(name==='storage')storageListeners.push(fn);},FrontendConfig:require('../../src/frontend-config'),GamePreSubmit:require('../../src/game-pre-submit'),GameData:require('../../src/game-data'),MultiplayerSync:Sync,GameLocalInputs:Local,GameInputs:Inputs,localStorage:storage,crypto:globalThis.crypto,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(require.resolve('../../src/client-app'),'utf8'),ctx);const app=vm.runInContext('GameApp',ctx);t.after(()=>app.closeSave());
 let receiver,action;let syncs=0;const transport={onClient(id,fn){receiver=fn;return ()=>{};},async sendToHost(id,command){if(command.type==='sync.request'){syncs++;return receiver(await host.sync(id,command.payload));}if(command.type==='sync.ack')return;if(action)return action(command);}};
 return {ctx,app,save,room,host,storage,entries,transport,storageEvent:event=>storageListeners.forEach(fn=>fn(event)),get syncs(){return syncs;},setAction:fn=>{action=fn;},receive:packet=>receiver(packet),scope:{gameId:'game',memberId:'guest',actorId:'a'}};
}

test('dice opt-out shares origin storage, synchronizes once in flight, and restores on reconnect',async t=>{
 const f=setup(t);await f.app.init();await f.app.connect(f.transport,'guest');
 assert.equal(f.app.getState().settings.skipMultiplayerManualDice,false);
 let commands=[];f.setAction(c=>{commands.push(c);});
 await f.app.updateSettings({skipMultiplayerManualDice:true});
 assert.equal(commands.length,1);assert.equal(commands[0].type,'dice.preference');assert.equal(commands[0].payload.skip,true);
 await f.receive(await f.host.sync('guest'));await f.app.updateSettings({roundNotifications:true});
 assert.equal(commands.length,1,'does not duplicate an unacknowledged request');
 // Another tab can turn the preference off while its first request is in flight.
 f.storage.setItem('trpg-client-settings',JSON.stringify({skipMultiplayerManualDice:false}));
 f.storageEvent({key:'trpg-client-settings',storageArea:f.storage});
 await f.receive({type:'command.result',requestId:commands[0].requestId,ok:true});
 await new Promise(r=>setImmediate(r));assert.equal(commands.length,2);assert.equal(commands[1].payload.skip,false);
 f.room.members.guest.skipManualDice=false;
 await f.receive({type:'command.result',requestId:commands[1].requestId,ok:true});await new Promise(r=>setImmediate(r));
 await f.app.closeSave();await f.app.updateSettings({skipMultiplayerManualDice:true});
 f.setAction(c=>{commands.push(c);f.room.members.guest.skipManualDice=c.payload.skip;return f.receive({type:'command.result',requestId:c.requestId,ok:true});});
 await f.app.connect(f.transport,'guest');await new Promise(r=>setImmediate(r));
 assert.equal(commands.length,3);assert.equal(f.room.members.guest.skipManualDice,true);
 assert.equal(JSON.parse(f.storage.getItem('trpg-client-settings')).skipMultiplayerManualDice,true);
});

test('dice preference survives hidden settings saves and spectators never send it',async t=>{
 const f=setup(t);await f.app.init();await f.app.updateSettings({skipMultiplayerManualDice:true});
 await f.app.updateSettings({reverseSendNewline:true});assert.equal(f.app.getState().settings.skipMultiplayerManualDice,true);
 f.room.members.guest={actorId:null,role:'spectator',permission:'all',view:'all',bindingVersion:2};
 let requests=0;f.setAction(()=>{requests++;});await f.app.connect(f.transport,'guest');
 assert.equal(requests,0);
});

test('a stale-round dice preference fetches current scope before retrying',async t=>{
 const f=setup(t);await f.app.init();await f.app.connect(f.transport,'guest');let requests=0;
 f.setAction(c=>{
   requests++;if(requests===1){f.room.roundId='new-round';return f.receive({type:'command.result',requestId:c.requestId,ok:false,error:'STALE_ROUND'});}
   assert.equal(c.roundId,'new-round');f.room.members.guest.skipManualDice=true;return f.receive({type:'command.result',requestId:c.requestId,ok:true});
 });
 await f.app.updateSettings({skipMultiplayerManualDice:true});await new Promise(r=>setTimeout(r,20));
 assert.equal(requests,2);assert.equal(f.app.getState().room.skipManualDice,true);
});

test('client uses configured input defaults while preserving an explicitly saved false',async t=>{
 const f=setup(t),config=require('../../src/frontend-config');
 f.ctx.FrontendConfig={...config,defaults:profile=>({...config.defaults(profile),reverseSendNewline:true})};
 await f.app.init();assert.equal(f.app.getState().settings.reverseSendNewline,true);
 f.storage.setItem('trpg-client-settings',JSON.stringify({reverseSendNewline:false,bridgeUrl:'wss://ignored.example/'}));
 await f.app.init();assert.equal(f.app.getState().settings.reverseSendNewline,false);
 assert.equal(f.app.getState().settings.bridgeUrl,undefined);
});

test('a submission immediately exposes scoped feedback and blocks resubmitting or skipping until retracted',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');let command;
 f.setAction(c=>{command=c;});
 const sending=f.app.send('等车','藏起钥匙',{hiddenSend:true,disguiseSend:true});
 assert.equal(Inputs.submission(f.app.getState()).status,'pending');
 assert.equal(f.app.getState().actionFeedback.privateContent,'藏起钥匙');
 await assert.rejects(f.app.send('重复行动'),/提交|确认/);await assert.rejects(f.app.skip(),/提交|确认/);
 await f.receive({type:'command.result',requestId:command.requestId,ok:true});await sending;
 assert.equal(Inputs.submission(f.app.getState()).status,'accepted');
 await assert.rejects(f.app.skip(),/提交|确认/);
 f.setAction(c=>f.receive({type:'command.result',requestId:c.requestId,ok:true,cancelled:{content:'等车',privateContent:'藏起钥匙'}}));
 await f.app.cancelAction();assert.equal(Inputs.submission(f.app.getState()),null);
});

test('a failed submission clears optimistic feedback while retaining retryable input',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');f.setAction(()=>{throw Error('offline');});
 await assert.rejects(f.app.send('查看窗户'),/offline/);
 assert.equal(Inputs.submission(f.app.getState()),null);assert.equal(f.app.getState().actionFeedback,null);
 assert.equal(f.app.getState().active.inputHistory.at(-1).text,'查看窗户');
});

test('drafts written during execution survive round completion, reconnect and an in-flight acknowledgement',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');
 f.room.status='executing';await f.receive(await f.host.sync('guest'));
 const binding=Inputs.owner(f.app.getState().active);assert.equal(binding.round,3);
 await f.app.saveDraft('下一回合的公开说辞',binding,{privateContent:'下一回合的隐秘行动',hiddenSend:true,disguiseSend:true});
 f.save.round=2;f.room.round=3;f.room.roundId='r3';f.room.status='collecting';await f.receive(await f.host.sync('guest'));
 assert.equal(f.app.getState().active.draft,'下一回合的公开说辞');assert.equal(f.app.getState().active.privateDraft,'下一回合的隐秘行动');
 await f.app.connect(f.transport,'guest');assert.equal(f.app.getState().active.draft,'下一回合的公开说辞');assert.equal(f.app.getState().active.hiddenSend,true);assert.equal(f.app.getState().active.disguiseSend,true);
});

test('cancellation refills up to three non-whitespace characters but preserves longer replacement input',async t=>{
 for(const replacement of ['',' \n  ','看','查看','查看门','查看门锁']){
  const f=setup(t);await f.app.connect(f.transport,'guest');
  f.setAction(c=>f.receive({type:'command.result',requestId:c.requestId,ok:true,...c.type==='action.cancel'?{cancelled:{content:'原来的行动',privateContent:''}}:{}}));
  await f.app.send('原来的行动');await f.app.saveDraft(replacement,undefined,{hiddenSend:false,disguiseSend:false});await f.app.cancelAction();
  assert.equal(f.app.getState().active.draft,replacement.replace(/\s/g,'').length>3?replacement:'原来的行动');
 }
});
test('private-only submission caches its unsent cover and modes for retraction and rollback',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');
 const draftState={draft:'没有公开的说辞',privateDraft:'真实行动',hiddenSend:true,disguiseSend:false};
 f.setAction(c=>{assert.ok(!JSON.stringify(c).includes('没有公开的说辞'));return f.receive({type:'command.result',requestId:c.requestId,ok:true,...c.type==='action.cancel'?{cancelled:{content:'',privateContent:'真实行动'}}:{}});});
 await f.app.send('','真实行动',{...draftState,draftState});await f.app.cancelAction();
 for(const [key,value]of Object.entries(draftState))assert.equal(f.app.getState().active[key],value);
 f.room.epoch++;await f.receive(await f.host.sync('guest'));
 for(const [key,value]of Object.entries(draftState))assert.equal(f.app.getState().active[key],value);
});

test('host-prepared acceptance records local-only cover once and retraction restores its modes',async t=>{
 const f=setup(t);f.room.status='executing';f.save.status='running';f.save.events.push({type:'story',round:2,content:'本轮故事'});await f.app.connect(f.transport,'guest');
 const draft={draft:'保留但未发送的伪装',privateDraft:'下一轮秘密行动',hiddenSend:true,disguiseSend:false};
 await f.app.saveDraft(draft.draft,undefined,{privateContent:draft.privateDraft,hiddenSend:true,disguiseSend:false});
 f.setAction(async c=>{
  assert.equal(c.type,'action.prepare');assert.equal(c.payload.content,'');
  f.room.preparedActions={a:{id:c.requestId,version:1,status:'queued',memberId:'guest',bindingVersion:1,epoch:0,fromRound:2,...c.payload}};
  await f.receive({type:'command.result',requestId:c.requestId,ok:true,preparedAction:f.room.preparedActions.a});
 });
 await f.app.preSubmit.prepare(draft);assert.equal(f.app.preSubmit.current().snapshot.draft,draft.draft);
 f.save.round=2;f.save.status='waiting';f.room.status='collecting';f.room.round=3;f.room.roundId='r3';
 Object.assign(f.room.preparedActions.a,{status:'submitted',version:2,round:3,roundId:'r3'});f.room.submissions={a:{actorId:'a',memberId:'guest',requestId:f.room.preparedActions.a.id,content:'',privateContent:draft.privateDraft}};
 await f.receive(await f.host.sync('guest'));assert.equal(f.app.preSubmit.current(),null);assert.equal(f.app.getState().active.draft,'');assert.equal(f.app.getState().active.inputHistory.length,1);
 await f.app.connect(f.transport,'guest');assert.equal(f.app.getState().active.inputHistory.length,1);
 f.setAction(async c=>{assert.equal(c.type,'action.cancel');delete f.room.submissions.a;await f.receive({type:'command.result',requestId:c.requestId,ok:true,cancelled:{content:'',privateContent:draft.privateDraft},cancelledRequestId:f.room.preparedActions.a.id});});
 await f.app.cancelAction();for(const [key,value]of Object.entries(draft))assert.equal(f.app.getState().active[key],value);
 await f.app.connect(f.transport,'guest');assert.equal(f.app.getState().active.inputHistory[0].status,'cancelled');assert.equal(f.app.getState().active.draft,draft.draft);
});

test('skipping after retracting an action uses the new skip identity for a later retraction',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');let skipId;
 f.setAction(c=>{
   if(c.type==='action.skip')skipId=c.requestId;
   if(c.type==='action.cancel'&&skipId)assert.equal(c.payload.submissionRequestId,skipId);
   return f.receive({type:'command.result',requestId:c.requestId,ok:true,...c.type==='action.cancel'?{cancelledRequestId:c.payload.submissionRequestId,cancelled:{content:'',privateContent:''}}:{}});
 });
 await f.app.send('查看窗户');await f.app.cancelAction();await f.app.skip();
 assert.equal(f.app.getState().actionFeedback.skip,true);await f.app.cancelAction();
 assert.equal(Inputs.submission(f.app.getState()),null);
});

test('skip keeps dormant private input and checkbox modes locally without sending them',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');
 const draftState={draft:'',privateDraft:'尚未发送的私密想法',hiddenSend:false,disguiseSend:true};
 await f.app.saveDraft('',undefined,{privateContent:draftState.privateDraft,hiddenSend:false,disguiseSend:true});
 f.setAction(c=>{assert.ok(!JSON.stringify(c).includes(draftState.privateDraft));return f.receive({type:'command.result',requestId:c.requestId,ok:true,...c.type==='action.cancel'?{cancelled:{content:'',privateContent:''}}:{}});});
 await f.app.skip({draftState});await f.app.cancelAction();
 for(const [key,value]of Object.entries(draftState))assert.equal(f.app.getState().active[key],value);
 f.room.epoch++;await f.receive(await f.host.sync('guest'));
 for(const [key,value]of Object.entries(draftState))assert.equal(f.app.getState().active[key],value);
});
test('client requests another bound player inventory through the host without local world access',async t=>{
 const f=setup(t);await f.app.connect(f.transport,'guest');assert.equal(typeof f.app.inventory,'function');
 f.setAction(async c=>{assert.equal(c.type,'inventory.request');assert.equal(c.payload.actorId,'b');assert.equal(c.roomId,f.room.roomId);assert.equal(c.epoch,f.room.epoch);assert.equal(c.bindingVersion,1);await f.receive({type:'command.result',requestId:c.requestId,ok:true,inventory:{actorId:'b',name:'乙',items:[{名称:'公用地图'}]}});});
 const result=await f.app.inventory('b');assert.equal(result.items[0].名称,'公用地图');assert.equal(f.app.getState().active.tree,undefined);
});

test('client requests the actual available rollback target for an interrupted unfinished round',async t=>{
 const f=setup(t);f.save.status='interrupted';f.room.status='interrupted';f.save.snapshots=[{round:f.save.round,inputRoundId:'unfinished'}];
 await f.app.connect(f.transport,'guest');assert.equal(f.app.getState().active.rollbackCount,1);
 f.setAction(async command=>{assert.equal(command.type,'rollback.request');assert.equal(command.payload.targetRound,f.save.round);await f.receive({type:'command.result',requestId:command.requestId,ok:true});});
 await f.app.requestRollback();
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
 assert.notEqual(f.app.getState().actionFeedback?.status,'cancelled');
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


test('failed join exposes a retry state, clears it during retry, and enters the room after recovery',async t=>{
 const f=setup(t);let attempts=0;const invitation={roomId:'room'};
 f.ctx.BridgeTransport={parseInvitation:x=>x,async createClient(){if(++attempts===1)throw Object.assign(Error('房间暂时不可用'),{code:'RoomNotFound'});assert.equal(f.app.getState().joinFailure,null);return {transport:f.transport,memberId:'guest',close(){}};}};
 await assert.rejects(f.app.joinRoom(invitation),/房间暂时不可用/);assert.equal(f.app.getState().joinFailure.code,'RoomNotFound');assert.equal(f.app.getState().active,null);
 await f.app.joinRoom(invitation);assert.equal(attempts,2);assert.equal(f.app.getState().joinFailure,null);assert.equal(f.app.getState().joining,null);assert.equal(f.app.getState().active.actorId,'a');
});
