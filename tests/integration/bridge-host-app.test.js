const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const VFS=require('../../src/vfs'),Core=require('../../src/game-core');
function setup(t,{count=2,failInvite=false,failConnect=false,control={}}={}){
 const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-a/基础信息.json','{"姓名":"甲"}');VFS.writeFile(tree,'/workspace/Player-a/背包.json','[]');
 for(let i=1;i<count;i++){const id=String.fromCharCode(97+i);VFS.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id}));VFS.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[]');}
 const save=Core.createSave('测试',tree);save.status='waiting';const saved=new Map([[save.id,structuredClone(save)]]);let calls=0,closed=false,options,incoming;const invites=[],revoked=[],sent=[];
 const transport={onHost(fn){incoming=fn;return ()=>{};},async sendToClient(id,packet){sent.push({id,packet});}};
 const localRecords=new Map(),roomConfigs=new Map();
 const ctx=vm.createContext({console,structuredClone,crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,URL,location:{href:'http://127.0.0.1:4173/index.html'},localStorage:{getItem:key=>localRecords.get(key)??null,setItem:(key,value)=>localRecords.set(key,value)},
 VFS,GameCore:Core,GameSlots:require('../../src/game-slots'),GameHistory:require('../../src/game-history'),GameInputs:require('../../src/game-input-history'),GameLocalInputs:require('../../src/game-local-inputs'),GameData:require('../../src/game-data'),GamePresentation:require('../../src/game-presentation'),MultiplayerHost:require('../../src/multiplayer-host'),MultiplayerSync:require('../../src/multiplayer-sync'),
 Lease:{create:()=>({available:false,isHeldByOther:()=>false})},GameStore:{create:()=>({open:async()=>{},getRoomConfig:async id=>structuredClone(roomConfigs.get(id)||null),putRoomConfig:async(id,value)=>{if(control.failRoomConfig)throw Error("room config quota");roomConfigs.set(id,structuredClone(value));},getSettings:async()=>({}),putSettings:async()=>{},getSave:async id=>structuredClone(saved.get(id)),putSave:async s=>{if(control.failPersist)throw Error('quota');saved.set(s.id,structuredClone(s));},list:async()=>[...saved.values()]})},
 BridgeTransport:{prepareHostAuthorization:async o=>({credentials:o.credentials||{token:'HOST-SECRET',epoch:'ROOM-EPOCH'},players:[...o.players,...o.memberIds.map(memberId=>({version:1,url:o.url,roomId:o.roomId,memberId,token:'PRIVATE-TOKEN'}))]}),parseInvitation:x=>JSON.parse(Buffer.from(x,'base64url').toString()),validateServerUrl:x=>x,encodeInvitation:x=>Buffer.from(JSON.stringify(x)).toString('base64url'),async createHost(o){calls++;options=o;if(failConnect)throw Error('connection failed');return {transport,credentials:()=>o.credentials||{token:'HOST-SECRET',epoch:'ROOM-EPOCH'},async invite(id){invites.push(id);if(failInvite)throw Error('authorization failed');return {version:1,url:o.url,roomId:o.roomId,memberId:id,token:'PRIVATE-TOKEN'};},async revoke(id){if(control.failRevoke)throw Error('revoke failed');revoked.push(id);},async reconnect(){await o.onState({status:'connected'});},close(){closed=true;}};}}});
 vm.runInContext(fs.readFileSync(require.resolve('../../src/game-app'),'utf8'),ctx);const app=vm.runInContext('GameApp',ctx);t.after(()=>{try{app.closeSave();}catch{}});return {app,save,invites,revoked,sent,receive:(id,packet)=>incoming(id,packet),get calls(){return calls;},get closed(){return closed;},get options(){return options;}};
}
test('opening saves stays offline; explicit real room creates private invitation without putting credentials in save',async t=>{
 const f=setup(t);await f.app.init();await f.app.openSave(f.save.id);if(f.app.multiplayerState().status==='selecting')await f.app.configureSlots('a');assert.equal(f.calls,0);
 assert.equal(typeof f.app.openOnlineRoom,'undefined');const invitation=await f.app.setInvitationSlot('b','player');assert.equal(f.calls,1);assert.equal(f.app.multiplayerState().online,true);
 const link=await f.app.createInvitation('b');assert.equal(link,invitation.link);assert.match(link,/client.html#join=/);assert.ok(!JSON.stringify(f.app.getState().active).includes('PRIVATE-TOKEN'));
 await f.app.closeRoom();assert.equal(f.closed,true);assert.equal(f.app.multiplayerState().online,false);
});

test('home retains the live room and reopening the same save keeps its identity and connection',async t=>{
 const f=await ready(t);await f.app.setInvitationSlot('b','player');const before=f.app.multiplayerState(),save=f.app.getState().active;
 f.app.returnHome();assert.equal(f.app.getState().home,true);assert.equal(f.closed,false);assert.equal(f.app.getState().active,save);
 assert.equal(f.app.multiplayerState().roomId,before.roomId);assert.equal(f.app.multiplayerState().online,true);
 await f.app.openSave(save.id);assert.equal(f.app.getState().home,false);assert.equal(f.calls,1);assert.equal(f.closed,false);
 assert.equal(f.app.getState().active,save);assert.equal(f.app.multiplayerState().roomId,before.roomId);
});
test('failed network room creation returns to offline without phantom online room',async t=>{
 const f=setup(t);await f.app.init();await f.app.openSave(f.save.id);if(f.app.multiplayerState().status==='selecting')await f.app.configureSlots('a');assert.equal(typeof f.app.openOnlineRoom,'undefined');
 // Configuration rejects before connecting or setting online.
 f.app.getState().settings.bridgeUrl='';await assert.rejects(f.app.setInvitationSlot('b','player'));assert.equal(f.app.multiplayerState().online,false);
});

async function ready(t,options){const f=setup(t,options);await f.app.init();await f.app.openSave(f.save.id);if(f.app.multiplayerState().status==='selecting')await f.app.configureSlots('a');return f;}

test('offline Apply persists open slots, and explicit Connect uploads all authorizations in the first handshake',async t=>{
 const f=await ready(t,{count:3});
 await f.app.configureInvitationSlot('b','player');await f.app.configureInvitationSlot('c','player');
 assert.equal(f.calls,0);assert.equal(f.app.multiplayerState().online,false);
 const id=f.app.getState().active.id;f.app.closeSave();await f.app.openSave(id);
 assert.deepEqual(Array.from(f.app.getState().openPlayerSlots),['b','c']);assert.equal(f.calls,0);
 await f.app.connectRoom();assert.equal(f.calls,1);assert.equal(f.options.players.length,2);
 assert.equal(f.app.getState().network.invites.length,2);
 await f.app.configureInvitationSlot('c','disabled');assert.equal(f.calls,1);assert.equal(f.app.getState().network.invites.length,1);
});

test('Connect rejects a room without configured open player slots and never calls Bridge',async t=>{
 const f=await ready(t);await assert.rejects(f.app.connectRoom(),/开放.*玩家|玩家.*槽位/);assert.equal(f.calls,0);
});

test('host cancellation refills short replacement input and preserves meaningful new drafts',async t=>{
 const f=await ready(t),invite=await f.app.setInvitationSlot('b','player');await f.options.onMember({type:'joined',memberId:invite.memberId});f.app.getState().settings.apiKey='test';
 for(const text of ['查门','查看门锁']){
  await f.app.send('房主上一条行动');await f.app.saveDraft(text,undefined,{hiddenSend:false,disguiseSend:false});await f.app.cancelAction();
  assert.equal(f.app.getState().active.draft,text.length>3?text:'房主上一条行动');
 }
});

test('host skip retains dormant drafts in its round cache for cancellation and rollback',async t=>{
 const f=await ready(t),invite=await f.app.setInvitationSlot('b','player');await f.options.onMember({type:'joined',memberId:invite.memberId});
 f.app.getState().settings.apiKey='test';
 const draftState={draft:'',privateDraft:'暂存的隐秘行动',hiddenSend:false,disguiseSend:true};
 await f.app.saveDraft('',undefined,{privateContent:draftState.privateDraft,hiddenSend:false,disguiseSend:true});
 await f.app.skip({draftState});const s=f.app.getState().active;
 assert.deepEqual(JSON.parse(JSON.stringify(s.inputHistory.at(-1).draftState)),draftState);
 const action=f.app.multiplayerState().submissions.a;assert.equal(action.privateContent,'');
 await f.app.cancelAction();for(const [key,value]of Object.entries(draftState))assert.equal(s[key],value);
});

test('a host network interruption preserves the collecting round and supports manual reconnect',async t=>{
 const f=await ready(t),invite=await f.app.setInvitationSlot('b','player');await f.options.onMember({type:'joined',memberId:invite.memberId});
 const before=f.app.multiplayerState();await f.app.dispatchMember('host',{type:'action.submit',requestId:'waiting',roomId:before.roomId,epoch:before.epoch,roundId:before.roundId,bindingVersion:before.members.host.bindingVersion,payload:{content:'甲等待乙'}});
 await f.options.onState({status:'reconnecting',code:'ConnectionLost',backgroundRetry:true});await new Promise(r=>setTimeout(r,20));
 const lost=f.app.multiplayerState();assert.equal(lost.members[invite.memberId].connected,false);assert.equal(lost.online,true);assert.equal(lost.roundId,before.roundId);assert.equal(lost.submissions.a.content,'甲等待乙');
 await f.app.reconnectRoom();assert.equal(f.app.getState().network.status,'connected');assert.equal(f.calls,1);assert.equal(f.app.multiplayerState().roundId,before.roundId);
});

test('host restores hidden and disguise modes with empty drafts after reopening the save',async t=>{
 const f=await ready(t),id=f.app.getState().active.id;
 await f.app.saveDraft('',undefined,{privateContent:'',hiddenSend:true,disguiseSend:true});
 f.app.closeSave();await f.app.openSave(id);
 assert.equal(f.app.getState().active.hiddenSend,true);assert.equal(f.app.getState().active.disguiseSend,true);
 assert.equal(f.app.getState().active.draft,'');assert.equal(f.app.getState().active.privateDraft,'');
});

test('host converts an occupied guest to AIPC, revokes their invitation, and rejects late commands',async t=>{
 const f=await ready(t),invite=await f.app.setInvitationSlot('b','player');await f.options.onMember({type:'joined',memberId:invite.memberId});
 await assert.rejects(f.app.setInvitationSlot('a','ai'),/房主/);
 await f.app.setInvitationSlot('b','ai');assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'ai');
 assert.equal(f.app.multiplayerState().members[invite.memberId],undefined);assert.deepEqual(f.revoked,[invite.memberId]);assert.equal(f.app.getState().network.invites.length,0);
 await f.receive(invite.memberId,{type:'sync.request'});assert.equal(f.sent.at(-1).packet.ok,false);
 await f.options.onMember({type:'joined',memberId:invite.memberId});assert.equal(f.app.multiplayerState().members[invite.memberId],undefined);
 const fresh=await f.app.setInvitationSlot('b','player');assert.notEqual(fresh.memberId,invite.memberId);
});

test('occupied-slot conversion preserves binding on storage failure and closes transport if revocation fails',async t=>{
 const control={},f=await ready(t,{control}),invite=await f.app.setInvitationSlot('b','player');await f.options.onMember({type:'joined',memberId:invite.memberId});
 control.failPersist=true;await assert.rejects(f.app.setInvitationSlot('b','ai'),/quota/);control.failPersist=false;
 assert.equal(f.app.multiplayerState().members[invite.memberId].actorId,'b');assert.equal(f.revoked.length,0);
 control.failRevoke=true;await assert.rejects(f.app.setInvitationSlot('b','ai'),/权限|连接/);assert.equal(f.closed,true);assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'ai');assert.equal(f.app.multiplayerState().members[invite.memberId],undefined);
});

test('public default remains offline; redundant sync requests coalesce and closing cancels pending sends',async t=>{
 const f=await ready(t);assert.equal(f.app.getState().settings.bridgeUrl,'wss://mc.birdry.cn:8443/');assert.equal(f.calls,0);
 const invitation=await f.app.setInvitationSlot('b','player');await f.options.onMember({type:'joined',memberId:invitation.memberId});
 await new Promise(r=>setTimeout(r,300));f.sent.length=0;
 for(let i=0;i<20;i++)await f.receive(invitation.memberId,{type:'sync.request',payload:{}});
 await new Promise(r=>setTimeout(r,500));
 const views=f.sent.filter(x=>x.packet.protocol===1);assert.ok(views.length>0);assert.ok(views.length<=2,`sent ${views.length} snapshots for one burst`);
 for(let i=0;i<5;i++)await f.receive(invitation.memberId,{type:'sync.request',payload:{}});
 await f.app.closeRoom();const after=f.sent.length;await new Promise(r=>setTimeout(r,300));assert.equal(f.sent.length,after);
});
test('invitation slots switch offline modes, open once, reuse credentials, and auto-bind joined members',async t=>{
 const f=await ready(t);await f.app.setInvitationSlot('b','ai');assert.equal(f.calls,0);assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'ai');
 const [one,two]=await Promise.all([f.app.setInvitationSlot('b','player'),f.app.setInvitationSlot('b','player')]);
 assert.equal(f.calls,1);assert.equal(f.invites.length,1);assert.equal(one.link,two.link);assert.equal(one.actorId,'b');assert.equal(one.key,one.link.split('#join=')[1]);
 assert.equal(f.app.multiplayerState().members[one.memberId].actorId,null);assert.equal(f.app.multiplayerState().participants.length,1);
 assert.equal(f.app.multiplayerState().members[one.memberId].connected,false);assert.equal(f.sent.length,0);
 await f.options.onMember({type:'joined',memberId:one.memberId});assert.equal(f.app.multiplayerState().members[one.memberId].actorId,'b');
 await f.options.onMember({type:'left',memberId:one.memberId});assert.equal(f.app.multiplayerState().members[one.memberId].connected,false);
 await assert.rejects(f.app.setInvitationSlot('b','disabled'),/玩家|占用/);await assert.rejects(f.app.revokeInvitation(one.memberId),/玩家|占用/);
 await assert.rejects(f.app.configureSlots('b'),/首次|初始|切换/);await assert.rejects(f.app.assignMember('host','b'),{code:'HOST_SLOT_LOCKED'});
});
test('pending invitations can be revoked and reopened with new credentials without counting absent players',async t=>{
 const f=await ready(t);const one=await f.app.setInvitationSlot('b','player');await f.app.setInvitationSlot('b','disabled');
 assert.deepEqual(f.revoked,[one.memberId]);assert.equal(f.app.getState().network.invites.length,0);assert.equal(f.app.multiplayerState().members[one.memberId],undefined);
 await f.options.onMember({type:'joined',memberId:one.memberId});assert.equal(f.app.multiplayerState().members[one.memberId],undefined);
 const two=await f.app.setInvitationSlot('b','player');assert.notEqual(one.memberId,two.memberId);assert.equal(f.invites.length,2);
});
test('invitation requires an existing empty slot and actual bridge commands cannot claim unrelated slots',async t=>{
 const solo=await ready(t,{count:1});await assert.rejects(solo.app.createInvitation(),/空白角色槽位/);assert.equal(solo.calls,0);
 const f=await ready(t,{count:3}),invite=await f.app.setInvitationSlot('b','player');await f.options.onMember({type:'joined',memberId:invite.memberId});
 const r=f.app.multiplayerState();await f.receive(invite.memberId,{type:'slot.claim.request',requestId:'cross-slot',epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members[invite.memberId].bindingVersion,payload:{actorId:'c'}});
 assert.equal(f.app.multiplayerState().slotRequests.length,0);assert.equal(f.sent.at(-1).packet.ok,false);
});

test('failed authorization restores the empty slot without leaving pending membership or credentials',async t=>{
 const f=await ready(t,{failInvite:true});await f.app.setInvitationSlot('b','ai');await assert.rejects(f.app.setInvitationSlot('b','player'),/authorization failed/);
 assert.equal(f.app.getState().network.invites.length,0);assert.deepEqual(Object.keys(f.app.multiplayerState().members),['host']);assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'ai');assert.equal(f.revoked.length,1);
});
test('failed room connection leaves the requested slot unchanged and the domain offline',async t=>{
 const f=await ready(t,{failConnect:true});await assert.rejects(f.app.setInvitationSlot('b','player'),/connection failed/);
 assert.equal(f.app.multiplayerState().online,false);assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'disabled');assert.equal(f.invites.length,0);
});
test('closing and reopening a saved pending invitation clears its live reservation and restores its saved key on demand',async t=>{
 const f=await ready(t),invite=await f.app.setInvitationSlot('b','player');const id=f.app.getState().active.id;
 f.app.closeSave();await f.app.openSave(id);assert.equal(f.app.multiplayerState().members[invite.memberId],undefined);assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'disabled');
 const reopened=await f.app.setInvitationSlot('b','player');assert.equal(reopened.memberId,invite.memberId);assert.equal(reopened.key,invite.key);await f.app.closeRoom();assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'disabled');
});

test('failed cancellation persistence keeps the original invitation and does not revoke its authorization',async t=>{
 const control={},f=await ready(t,{control}),invite=await f.app.setInvitationSlot('b','player');control.failPersist=true;
 await assert.rejects(f.app.setInvitationSlot('b','disabled'),/quota/);control.failPersist=false;
 assert.equal(f.revoked.length,0);assert.equal(f.app.getState().network.invites[0].key,invite.key);assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'player');assert.equal(f.app.multiplayerState().members[invite.memberId].invitationActorId,'b');
 await f.options.onMember({type:'joined',memberId:invite.memberId});assert.equal(f.app.multiplayerState().members[invite.memberId].actorId,'b');
});
test('failed authorization revocation restores the pending reservation and original invite',async t=>{
 const control={},f=await ready(t,{control}),invite=await f.app.setInvitationSlot('b','player');control.failRevoke=true;
 await assert.rejects(f.app.setInvitationSlot('b','ai'),/revoke failed/);assert.equal(f.app.getState().network.invites[0].key,invite.key);assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'player');assert.equal(f.app.multiplayerState().members[invite.memberId].actorId,null);
 control.failRevoke=false;await f.options.onMember({type:'joined',memberId:invite.memberId});assert.equal(f.app.multiplayerState().members[invite.memberId].actorId,'b');
});

test('host rollback app choice validates snapshots and opens a vote without a self-request',async t=>{
 const f=await ready(t);f.app.getState().active.snapshots=[];await assert.rejects(f.app.decideHostRollback('approve'),/没有可回退/);assert.equal(f.app.multiplayerState().vote,null);
 f.app.getState().active.snapshots=[{round:0,inputRoundId:'previous'}];await assert.rejects(f.app.decideHostRollback('vote'),{code:'NO_MULTIPLAYER_VOTE'});const invite=await f.app.setInvitationSlot('b','player');await f.options.onMember({type:'joined',memberId:invite.memberId});await f.app.decideHostRollback('vote');
 assert.equal(f.app.multiplayerState().vote.status,'voting');assert.equal(Object.keys(f.app.multiplayerState().vote.votes).length,0);assert.equal(f.app.multiplayerState().vote.targetRoundId,'previous');
});

test('room invitations survive host save reopen without an automatic connection and revoked slots get fresh keys',async t=>{
 const f=await ready(t),first=await f.app.setInvitationSlot('b','player'),id=f.app.getState().active.id,roomId=f.app.multiplayerState().roomId;
 assert.ok(!JSON.stringify(f.app.getState().active).includes('HOST-SECRET'));
 f.app.closeSave();await f.app.openSave(id);assert.equal(f.calls,1);assert.equal(f.app.multiplayerState().online,false);
 assert.equal(f.app.getState().savedInvites[0].key,first.key);
 const resumed=await f.app.setInvitationSlot('b','player');assert.equal(resumed.key,first.key);assert.equal(resumed.memberId,first.memberId);assert.equal(f.app.multiplayerState().roomId,roomId);assert.equal(f.options.credentials.token,'HOST-SECRET');
 await f.app.setInvitationSlot('b','disabled');f.app.closeSave();await f.app.openSave(id);
 assert.equal(f.app.getState().savedInvites.length,0);const fresh=await f.app.setInvitationSlot('b','player');assert.notEqual(fresh.memberId,first.memberId);assert.notEqual(fresh.key,first.key);
});

test('failed credential storage cannot revoke a pending invitation or silently change its slot',async t=>{
 const control={},f=await ready(t,{control}),invite=await f.app.setInvitationSlot('b','player');control.failRoomConfig=true;
 await assert.rejects(f.app.setInvitationSlot('b','disabled'),/room config quota/);
 assert.equal(f.revoked.length,0);assert.equal(f.app.getState().active.slots.find(s=>s.id==='b').kind,'player');
 assert.equal(f.app.getState().network.invites[0].key,invite.key);
 control.failRoomConfig=false;
});
