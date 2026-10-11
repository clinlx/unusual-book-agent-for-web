'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const VFS=require('../../src/vfs'),Host=require('../../src/multiplayer-host');

async function fixture(t,{count=2,settings={},execute,persist,rollback,status='waiting'}={}){
  const tree=VFS.createTree();for(let i=0;i<count;i++){const id=String.fromCharCode(97+i);VFS.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id,Alive:true,Enabled:true}));VFS.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[]');}
  const save={id:'save',tree,playerPath:'/workspace/Player-a',status,round:2,cache:{},snapshots:[{round:1,inputRoundId:'prior-2'},{round:0,inputRoundId:'prior-1'}]},runs=[],rollbacks=[],events=[];
  let clock=1000,sequence=0;
  const finish=()=>{save.round++;save.status='waiting';if(save.activeRound)save.activeRound.complete=true;};
  const host=Host.create({getSave:()=>save,getSettings:()=>settings,now:()=>clock,uid:()=>`id-${++sequence}`,persist:async()=>persist?.(save),execute:async(actions,options)=>{runs.push({actions,options});if(execute)await execute(actions,options,{save,finish});else finish();},rollback:async target=>{rollbacks.push(target);if(rollback)await rollback(target,save);else{save.round=target.targetRound;save.status='waiting';save.activeRound=null;}}});
  t.after(()=>host.dispose());host.subscribe(e=>events.push(e));await host.initialize('a');
  if(count>1){await host.open();for(let i=1;i<count;i++){const id=String.fromCharCode(97+i);await host.addMember('member-'+id);await host.assign('member-'+id,id);}}
  const packet=(memberId,type,payload={})=>{const r=host.state();return {type,requestId:`request-${++sequence}`,epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members[memberId].bindingVersion,payload};};
  const send=(memberId,type,payload)=>host.handle(memberId,packet(memberId,type,payload));
  function flags(id,props){const slot=save.slots.find(s=>s.id===id),path=slot.path+'/基础信息.json',info=JSON.parse(VFS.readFile(save.tree,path).content);VFS.writeFile(save.tree,path,JSON.stringify({...info,...props}));}
  return {host,save,runs,rollbacks,events,packet,send,flags,settings,advance:ms=>clock+=ms};
}

test('concurrent submissions collect exactly once, repeat receipts, preserve private input and reject spoofed ownership',async t=>{
  let release;const gate=new Promise(r=>release=r);
  const f=await fixture(t,{execute:async(a,o,{finish})=>{await gate;finish();}}),{host,send,packet,runs}=f;
  await assert.rejects(send('member-b','action.submit',{actorId:'a',content:'spoof'}),{code:'FORBIDDEN'});
  const a=packet('host','action.submit',{content:'公开行动',privateContent:'不能广播的暗中行动'}),b=packet('member-b','action.skip');
  const receipts=await Promise.all([host.handle('host',a),host.handle('member-b',b),host.handle('member-b',b)]);
  assert.deepEqual(receipts[1],receipts[2]);assert.equal(runs.length,1);assert.equal(host.state().status,'executing');
  assert.equal(runs[0].actions[0].privateContent,'不能广播的暗中行动');assert.equal(JSON.stringify(f.events).includes('不能广播'),false);
  await assert.rejects(host.handle('host',{...a,payload:{content:'different'}}),{code:'REQUEST_CONFLICT'});
  await host.setConnected('member-b',false);assert.equal(host.state().members['member-b'].connected,false);
  release();await host.waitForIdle();assert.equal(runs.length,1);assert.equal(host.state().status,'collecting');
  assert.deepEqual(await host.handle('member-b',b),receipts[1]);
  await assert.rejects(host.handle('member-b',{...b,requestId:'late'}),{code:'STALE_ROUND'});
});

test('cancel only removes the requesting waiting action, restores both drafts, and refuses frozen rounds',async t=>{
 let finishRun;const gate=new Promise(r=>finishRun=r),f=await fixture(t,{execute:async(a,o,{finish})=>{await gate;finish();}});
  await f.send('member-b','action.submit',{content:'旧公开行动',privateContent:'旧秘密'});
  await assert.rejects(f.send('member-b','action.cancel',{submissionRequestId:'stale-submission'}),{code:'STALE_ACTION'});
 const cancel=f.packet('member-b','action.cancel');const result=await f.host.handle('member-b',cancel);
 assert.deepEqual(result.cancelled,{content:'旧公开行动',privateContent:'旧秘密'});assert.equal(f.host.state().submissions.b,undefined);assert.equal(f.runs.length,0);
 assert.deepEqual(await f.host.handle('member-b',cancel),result);
 assert.ok(!JSON.stringify(f.events).includes('旧秘密'));
 await assert.rejects(f.send('member-b','action.cancel'),{code:'NOT_SUBMITTED'});
 await f.send('host','action.submit',{content:'甲行动'});
 await f.send('member-b','action.submit',{content:'新公开行动',privateContent:'新秘密'});
 await assert.rejects(f.send('member-b','action.cancel'),{code:'BUSY'});
 assert.equal(f.runs[0].actions.find(a=>a.actorId==='b').content,'新公开行动');
 finishRun();await f.host.waitForIdle();
});

test('rollback preserves host-selected AIPC mode and cannot revive a removed player binding',async t=>{
 let oldTree,oldSlots;const f=await fixture(t,{rollback:async(target,save)=>{save.tree=structuredClone(oldTree);save.slots=structuredClone(oldSlots);save.round=target.targetRound;save.status='waiting';save.activeRound=null;}});
 oldTree=structuredClone(f.save.tree);oldSlots=structuredClone(f.save.slots);
 await f.host.release('member-b','ai',{forget:true});await f.send('host','rollback.host',{targetRound:1,targetRoundId:'prior-2',decision:'approve'});
 assert.equal(f.host.state().members['member-b'],undefined);assert.equal(f.save.slots.find(s=>s.id==='b').kind,'ai');assert.equal(f.save.slots.find(s=>s.id==='b').memberId,undefined);
});

test('interruption resumes the frozen action once without accepting a new round or rerunning automatically',async t=>{
  const f=await fixture(t,{count:1,execute:async(a,o,{finish})=>{if(!o.resume)throw Error('network');finish();}});
  await f.send('host','action.submit',{content:'调查'});await f.host.waitForIdle();assert.equal(f.host.state().status,'interrupted');
  await f.host.checkAutomatic();assert.equal(f.runs.length,1);
  await f.send('host','round.resume');await f.host.waitForIdle();assert.equal(f.runs.length,2);assert.deepEqual(f.runs[0].actions,f.runs[1].actions);assert.equal(f.runs[1].options.resume,true);
});

test('unconscious players wait automatically; dead and disabled actors do not become actions',async t=>{
  const f=await fixture(t,{count:3});f.flags('b',{Enabled:false});f.flags('c',{Alive:false});
  await assert.rejects(f.send('member-b','action.submit',{content:'睡梦中主动行动'}),{code:'INACTIVE_ACTOR'});
  await f.send('host','action.submit',{content:'守夜'});await f.host.waitForIdle();
  assert.equal(f.runs.length,1);assert.deepEqual(f.runs[0].actions.map(x=>x.actorId),['a','b']);assert.equal(f.runs[0].actions[1].automatic,true);assert.equal(f.runs[0].actions[1].skip,true);
  f.flags('a',{Alive:false});f.flags('b',{Alive:false});await f.host.checkAutomatic();assert.equal(f.runs.length,1);
});

test('all unconscious defaults to automatic progression but no progress interrupts instead of looping',async t=>{
  const f=await fixture(t,{count:1});f.flags('a',{Enabled:false});await f.host.checkAutomatic();await f.host.waitForIdle();
  assert.equal(f.runs.length,1);assert.equal(f.runs[0].options.automatic,true);assert.equal(f.host.state().status,'interrupted');assert.equal(f.host.state().automaticStalled,true);
  await f.host.checkAutomatic();assert.equal(f.runs.length,1);
});

test('unconscious switch disables automatic rounds; explicit host advance uses the same waiting actions',async t=>{
  const f=await fixture(t,{settings:{autoAdvanceUnconscious:false},execute:async(a,o,{save,finish})=>{const path=save.slots.find(s=>s.id==='a').path+'/基础信息.json';VFS.writeFile(save.tree,path,'{"Alive":true,"Enabled":true}');finish();}});
  f.flags('a',{Enabled:false});f.flags('b',{Alive:false});assert.equal(await f.host.checkAutomatic(),false);assert.equal(f.runs.length,0);
  await assert.rejects(f.send('member-b','round.advance'),{code:'FORBIDDEN'});
  await f.send('host','round.advance');await f.host.waitForIdle();assert.equal(f.runs.length,1);assert.deepEqual(f.runs[0].actions.map(x=>x.actorId),['a']);assert.equal(f.host.state().status,'collecting');
});

test('rollback vote freezes all occupied members including dead, unconscious and disconnected; half votes rollback once',async t=>{
  const f=await fixture(t,{count:4});f.flags('b',{Alive:false});f.flags('c',{Enabled:false});await f.host.setConnected('member-d',false);
  await f.send('member-b','rollback.request',{targetRoundId:'prior-2'});const voteId=f.host.state().vote.id;
  await assert.rejects(f.send('member-b','rollback.decide',{voteId,decision:'approve'}),{code:'FORBIDDEN'});
  await f.send('host','rollback.decide',{voteId,decision:'vote'});let vote=f.host.state().vote;assert.equal(vote.eligible.length,4);assert.deepEqual(vote.votes,{});
  await assert.rejects(f.send('host','action.submit',{content:'暂停时提交'}),{code:'BUSY'});
  await f.send('member-b','rollback.vote',{voteId,approve:true});assert.equal(f.rollbacks.length,0);
  await assert.rejects(f.send('member-b','rollback.vote',{voteId,approve:true}),{code:'ALREADY_VOTED'});
  const last=f.packet('member-c','rollback.vote',{voteId,approve:true}),epoch=f.host.state().epoch;
  await Promise.all([f.host.handle('member-c',last),f.host.handle('member-c',last)]);
  assert.equal(f.rollbacks.length,1);assert.equal(f.save.round,1);assert.equal(f.host.state().epoch,epoch+1);assert.equal(f.host.state().vote,null);
  assert.equal(f.events.filter(x=>x.type==='timeline.reset').length,1);
});

test('rollback request rejection and vote timeout release pause without implicit approval',async t=>{
  const f=await fixture(t);await f.send('member-b','rollback.request',{targetRound:1});let voteId=f.host.state().vote.id;
  await f.send('host','rollback.decide',{voteId,decision:'reject'});assert.equal(f.host.state().vote,null);
  await f.send('member-b','rollback.request',{targetRound:1});voteId=f.host.state().vote.id;await f.send('host','rollback.decide',{voteId,decision:'vote'});
  f.advance(120001);await f.host.checkAutomatic();assert.equal(f.host.state().vote,null);assert.equal(f.rollbacks.length,0);
  await assert.rejects(f.send('member-b','rollback.vote',{voteId,approve:true}),{code:'STALE_VOTE'});
});

test('closing releases remote occupancy while keeping the host actor fixed and expiring old commands',async t=>{
  const f=await fixture(t);await assert.rejects(f.host.assign('host','b'),{code:'HOST_SLOT_LOCKED'});
  const stale=f.packet('host','action.submit',{content:'旧房间内容'});
  await f.host.close();assert.equal(f.host.state().online,false);assert.equal(f.save.slots.find(x=>x.id==='b').kind,'disabled');
  await assert.rejects(f.host.assign('host','b'),{code:'HOST_SLOT_LOCKED'});
  assert.equal(f.save.slots.find(x=>x.id==='a').memberId,'host');assert.equal(f.save.actorId,'a');
  await assert.rejects(f.host.handle('host',stale),{code:'STALE_ROUND'});assert.equal(f.runs.length,0);
});

test('persistence failure neither accepts a command nor starts computation, and retry remains possible',async t=>{
  let fail=false;const f=await fixture(t,{count:1,persist:async()=>{if(fail)throw Error('quota');}});
  const command=f.packet('host','action.submit',{content:'请求'}),before=f.host.state();fail=true;
  await assert.rejects(f.host.handle('host',command),/quota/);assert.deepEqual(f.host.state(),before);assert.equal(f.runs.length,0);
  fail=false;await f.host.handle('host',command);await f.host.waitForIdle();assert.equal(f.runs.length,1);
});

test('a new game requires explicit opening; model call starts after durable receipt and stays offline',async t=>{
  const f=await fixture(t,{count:1,status:'new'});assert.equal(f.host.state().roomId,null);assert.equal(f.host.state().online,false);
  await assert.rejects(f.send('host','action.submit',{content:'抢先行动'}),{code:'BUSY'});
  await f.send('host','round.start');await f.host.waitForIdle();assert.equal(f.runs.length,1);assert.equal(f.runs[0].options.starting,true);
  await assert.rejects(f.send('host','round.start'),{code:'BUSY'});
});

test('two members need one explicit vote and three need two, without a requester pre-vote',async t=>{
  for(const count of [2,3]){const f=await fixture(t,{count});await f.send('member-b','rollback.request',{targetRound:1});const voteId=f.host.state().vote.id;
    await f.send('host','rollback.decide',{voteId,decision:'vote'});assert.equal(f.rollbacks.length,0);await f.send('host','rollback.vote',{voteId,approve:true});
    assert.equal(f.rollbacks.length,count===2?1:0);if(count===3){await f.send('member-b','rollback.vote',{voteId,approve:true});assert.equal(f.rollbacks.length,1);}
  }
});

test('failed slot persistence restores ownership and directory; host may explicitly release an absent player as AIPC',async t=>{
  let fail=false;const f=await fixture(t,{persist:async()=>{if(fail)throw Error('disk');}}),before=structuredClone(f.save);
  fail=true;await assert.rejects(f.host.release('member-b','ai'),/disk/);assert.deepEqual(f.save,before);
  fail=false;await f.host.release('member-b','ai');assert.equal(f.save.slots.find(x=>x.id==='b').kind,'ai');assert.equal(f.host.state().members['member-b'].actorId,null);
  await f.send('host','action.submit',{content:'仅房主行动'});await f.host.waitForIdle();assert.deepEqual(f.runs[0].actions.map(x=>x.actorId),['a']);
});

test('reopening a persisted executing room stays offline and interrupted until host resumes',async t=>{
  const f=await fixture(t);const original=f.host.state();f.host.dispose();f.save.multiplayer.status='executing';let runs=0;
  const reopened=Host.create({getSave:()=>f.save,execute:async()=>{runs++;},rollback:async()=>{}});t.after(()=>reopened.dispose());await reopened.initialize();
  assert.equal(reopened.state().online,false);assert.equal(reopened.state().roomId,null);assert.equal(reopened.state().status,'interrupted');assert.equal(reopened.state().members['member-b'].connected,false);
  assert.equal(await reopened.checkAutomatic(),false);assert.equal(runs,0);assert.equal(reopened.state().roundId,original.roundId);
});

test('generated round archives and file timestamps do not disguise an automatic no-progress loop',async t=>{
  const f=await fixture(t,{count:1,execute:async(a,o,{save,finish})=>{
    VFS.writeFile(save.tree,'/workspace/过往回合历史记忆/Round_3/回合情节.json','[{"content":"只换了说法"}]');
    VFS.writeFile(save.tree,'/workspace/SummaryHistory.json','["新摘要"]');VFS.writeFile(save.tree,'/workspace/OutputCopy.log','新的叙述');
    VFS.writeFile(save.tree,'/workspace/ROUND_CACHE.xml','{"Story_Phase":"游戏循环"}');
    const path=save.slots[0].path+'/基础信息.json';VFS.writeFile(save.tree,path,VFS.readFile(save.tree,path).content);finish();
  }});f.flags('a',{Enabled:false});await f.host.checkAutomatic();await f.host.waitForIdle();assert.equal(f.runs.length,1);assert.equal(f.host.state().automaticStalled,true);
});

test('all dead is never mistaken for unconscious; host may explicitly run the rescue or ending round once',async t=>{
  const f=await fixture(t,{count:1});f.flags('a',{Alive:false,Enabled:false});await f.host.checkAutomatic();assert.equal(f.runs.length,0);
  await f.send('host','round.advance');await f.host.waitForIdle();assert.equal(f.runs.length,1);assert.deepEqual(f.runs[0].actions,[]);assert.equal(f.host.state().status,'interrupted');
});

test('slot claims require host approval, cannot claim occupied actors, and rejected requests leave the binding intact',async t=>{
  const f=await fixture(t,{count:3});await f.host.release('member-c');
  await assert.rejects(f.send('member-b','slot.claim.request',{actorId:'a'}),{code:'OCCUPIED'});
  await f.send('member-b','slot.claim.request',{actorId:'c'});let claim=f.host.state().slotRequests[0];assert.equal(f.host.state().members['member-b'].actorId,'b');
  await assert.rejects(f.send('member-c','slot.claim.decide',{claimId:claim.id,decision:'approve'}),{code:'FORBIDDEN'});
  await f.send('host','slot.claim.decide',{claimId:claim.id,decision:'reject'});assert.equal(f.host.state().members['member-b'].actorId,'b');assert.equal(f.host.state().slotRequests.length,0);
  await f.send('member-b','slot.claim.request',{actorId:'c'});claim=f.host.state().slotRequests[0];const stale=f.packet('member-b','action.submit',{content:'之前角色的草稿'});
  await f.send('host','slot.claim.decide',{claimId:claim.id,decision:'approve'});assert.equal(f.host.state().members['member-b'].actorId,'c');assert.equal(f.save.slots.find(x=>x.id==='b').kind,'disabled');
  await assert.rejects(f.host.handle('member-b',stale),{code:'STALE_BINDING'});assert.equal(f.host.state().slotRequests.length,0);
});

test('closing while waiting for a disconnected submission returns own draft and permits offline continuation',async t=>{
  const f=await fixture(t);await f.send('host','action.submit',{content:'房主尚未结算的行动',privateContent:'房主私密草稿'});await f.host.setConnected('member-b',false);
  const previous=f.host.state();await f.host.close();assert.equal(f.host.state().epoch,previous.epoch);assert.notEqual(f.host.state().roundId,previous.roundId);
  assert.equal(f.save.draft,'房主尚未结算的行动');assert.deepEqual(f.host.state().submissions,{});assert.equal(f.save.slots.find(x=>x.id==='b').kind,'disabled');
  assert.equal(f.save.privateDraft,'房主私密草稿');assert.equal(f.save.draftVersion,1);
  await f.send('host','action.submit',{content:f.save.draft});await f.host.waitForIdle();assert.equal(f.runs.length,1);assert.deepEqual(f.runs[0].actions.map(x=>x.actorId),['a']);
});

test('reopening a waiting save suspends remote slots offline and restores them only before offline progression',async t=>{
  for(const progress of [false,true]){
    const f=await fixture(t);await f.send('member-b','action.submit',{content:'断线前已提交'});const before=f.host.state();f.host.dispose();let runs=[];
    const h=Host.create({getSave:()=>f.save,execute:async actions=>{runs.push(actions);f.save.round++;f.save.status='waiting';},rollback:async()=>{}});t.after(()=>h.dispose());await h.initialize();
    assert.equal(h.state().online,false);assert.equal(h.state().members['member-b'].actorId,null);assert.equal(f.save.slots.find(x=>x.id==='b').kind,'disabled');assert.equal(h.state().epoch,before.epoch);
    if(progress){const r=h.state();await h.handle('host',{type:'action.submit',requestId:'offline',epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members.host.bindingVersion,payload:{content:'继续单人'}});await h.waitForIdle();assert.deepEqual(runs[0].map(x=>x.actorId),['a']);}
    await h.open();assert.equal(h.state().members['member-b'].actorId,progress?null:'b');assert.equal(f.save.slots.find(x=>x.id==='b').kind,progress?'disabled':'player');
    if(!progress)assert.equal(h.state().submissions.b.content,'断线前已提交');
  }
});

test('all-dead manual progression may end the story without being relabelled as a stalled round',async t=>{
  const f=await fixture(t,{count:1,execute:async(a,o,{save,finish})=>{finish();save.status='ended';}});f.flags('a',{Alive:false});await f.send('host','round.advance');await f.host.waitForIdle();assert.equal(f.host.state().status,'ended');
});

test('a failed connection update cannot undo world writes made by the in-flight model',async t=>{
  let release,fail=false;const gate=new Promise(r=>release=r),f=await fixture(t,{execute:async(a,o,{finish})=>{await gate;finish();},persist:async save=>{if(fail){VFS.writeFile(save.tree,'/workspace/并发写入.txt','模型已经写入');throw Error('quota');}}});
  await f.send('host','action.submit',{content:'甲行动'});await f.send('member-b','action.submit',{content:'乙行动'});fail=true;
  await assert.rejects(f.host.setConnected('member-b',false),/quota/);assert.equal(VFS.readFile(f.save.tree,'/workspace/并发写入.txt').content,'模型已经写入');assert.equal(f.host.state().members['member-b'].connected,true);
  fail=false;release();await f.host.waitForIdle();
});

test('invalid actor information remains openable for repair but blocks manual and automatic execution',async t=>{
  for(const content of ['{','[]','null']){
    const f=await fixture(t,{count:1,status:'new'}),info='/workspace/Player-a/基础信息.json';VFS.writeFile(f.save.tree,info,content);
    f.host.dispose();let runs=0;const h=Host.create({getSave:()=>f.save,execute:async()=>{runs++;},rollback:async()=>{}});t.after(()=>h.dispose());
    await h.initialize();assert.equal(h.state().participants[0].invalid,true);assert.equal(await h.checkAutomatic(),false);
    function command(type,id){const r=h.state();return {type,requestId:id,epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members.host.bindingVersion,payload:{content:'行动'}};}
    await assert.rejects(h.handle('host',command('round.start','start')),{code:'INVALID_ACTOR_DATA'});
    f.save.status='waiting';await assert.rejects(h.handle('host',command('action.submit','submit')),{code:'INVALID_ACTOR_DATA'});await assert.rejects(h.handle('host',command('round.advance','advance')),{code:'INVALID_ACTOR_DATA'});assert.equal(runs,0);
    VFS.writeFile(f.save.tree,info,'{"Alive":true,"Enabled":true}');await h.initialize();assert.equal(h.state().participants[0].invalid,undefined);
    await h.handle('host',command('action.submit','repaired'));await h.waitForIdle();assert.equal(runs,1);
  }
});

test('a corrupted remote actor does not prevent reopening the host to repair its files',async t=>{
  const f=await fixture(t);VFS.writeFile(f.save.tree,'/workspace/Player-b/基础信息.json','{');f.host.dispose();
  const h=Host.create({getSave:()=>f.save,execute:async()=>assert.fail('must not execute invalid characters'),rollback:async()=>{}});t.after(()=>h.dispose());
  await h.initialize();assert.equal(h.state().online,false);assert.equal(h.state().participants.find(p=>p.actorId==='b').invalid,true);assert.equal(await h.checkAutomatic(),false);
});

test('host actor remains fixed after first selection, including initialize and claim commands',async t=>{
 const f=await fixture(t);await f.host.release('member-b');
 await assert.rejects(f.host.assign('host','b'),{code:'HOST_SLOT_LOCKED'});
 await assert.rejects(f.host.initialize('b'),{code:'HOST_SLOT_LOCKED'});
 await assert.rejects(f.send('host','slot.claim.request',{actorId:'b'}),{code:'HOST_SLOT_LOCKED'});
 assert.equal(f.host.state().members.host.actorId,'a');
});
test('reserved invitation actors stay outside actions until join and cannot be claimed by another member',async t=>{
 const f=await fixture(t,{count:1});VFS.writeFile(f.save.tree,'/workspace/Player-b/基础信息.json','{}');VFS.writeFile(f.save.tree,'/workspace/Player-b/背包.json','[]');require('../../src/game-slots').ensure(f.save);
 await f.host.open();await f.host.reserveInvitation('guest','b');assert.equal(f.host.state().participants.length,1);assert.equal(f.host.state().members.guest.connected,false);
 await f.host.addMember('other');await assert.rejects(f.send('other','slot.claim.request',{actorId:'b'}),{code:'OCCUPIED'});
 await f.send('host','action.submit',{content:'等待'});await f.host.waitForIdle();assert.equal(f.runs.length,1);assert.equal(f.runs[0].actions.length,1);
 await f.host.joinInvitation('guest');assert.equal(f.host.state().participants.length,2);assert.equal(f.host.state().members.guest.actorId,'b');
 await f.host.setConnected('guest',false);await assert.rejects(f.host.cancelInvitation('guest','disabled'),{code:'OCCUPIED'});
});

test('host directly rolls back atomically without requesting permission from itself',async t=>{
 const f=await fixture(t),epoch=f.host.state().epoch,command=f.packet('host','rollback.host',{targetRoundId:'prior-2',decision:'approve'}),before=f.events.length;
 const receipts=await Promise.all([f.host.handle('host',command),f.host.handle('host',command)]);
 assert.deepEqual(receipts[0],receipts[1]);assert.equal(f.rollbacks.length,1);assert.equal(f.save.round,1);assert.equal(f.host.state().epoch,epoch+1);assert.equal(f.host.state().vote,null);
 assert.deepEqual(f.events.slice(before).map(e=>e.type),['timeline.reset']);
});
test('host opens voting directly with no implicit vote and the same frozen half-player threshold',async t=>{
 const f=await fixture(t,{count:3});f.flags('b',{Alive:false});await f.host.setConnected('member-c',false);
 await f.send('host','rollback.host',{targetRound:1,decision:'vote'});const vote=f.host.state().vote;
 assert.equal(vote.status,'voting');assert.deepEqual(vote.votes,{});assert.equal(vote.eligible.length,3);assert.equal(vote.expiresAt,121000);
 await f.send('member-b','rollback.vote',{voteId:vote.id,approve:true});assert.equal(f.rollbacks.length,0);
 await f.send('member-c','rollback.vote',{voteId:vote.id,approve:true});assert.equal(f.rollbacks.length,1);assert.equal(f.host.state().vote,null);
});
test('host rollback rejects guests, missing targets, invalid decisions and any existing rollback decision',async t=>{
 const f=await fixture(t);await assert.rejects(f.send('member-b','rollback.host',{targetRound:1,decision:'approve'}),{code:'FORBIDDEN'});
 await assert.rejects(f.send('host','rollback.host',{targetRound:999,decision:'approve'}),{code:'INVALID_TARGET'});
 await assert.rejects(f.send('host','rollback.host',{targetRound:1,decision:'cancel'}),{code:'INVALID_DECISION'});assert.equal(f.host.state().vote,null);
 await f.send('member-b','rollback.request',{targetRound:1});const original=f.host.state().vote;
 await assert.rejects(f.send('host','rollback.host',{targetRound:0,decision:'approve'}),{code:'BUSY'});assert.deepEqual(f.host.state().vote,original);
 await f.send('host','rollback.decide',{voteId:original.id,decision:'vote'});const voting=f.host.state().vote;
 await assert.rejects(f.send('host','rollback.host',{targetRound:0,decision:'vote'}),{code:'BUSY'});assert.deepEqual(f.host.state().vote,voting);assert.equal(f.rollbacks.length,0);
});

test('offline and pending-only rooms cannot vote through either rollback entry point',async t=>{
 const f=await fixture(t,{count:1});await assert.rejects(f.send('host','rollback.host',{targetRound:1,decision:'vote'}),{code:'NO_MULTIPLAYER_VOTE'});assert.equal(f.host.state().vote,null);
 await f.send('host','rollback.request',{targetRound:1});const original=f.host.state().vote;await assert.rejects(f.send('host','rollback.decide',{voteId:original.id,decision:'vote'}),{code:'NO_MULTIPLAYER_VOTE'});assert.deepEqual(f.host.state().vote,original);
 await f.send('host','rollback.decide',{voteId:original.id,decision:'reject'});await f.host.open();VFS.writeFile(f.save.tree,'/workspace/Player-b/基础信息.json','{}');VFS.writeFile(f.save.tree,'/workspace/Player-b/背包.json','[]');require('../../src/game-slots').ensure(f.save);await f.host.reserveInvitation('guest','b');
 await assert.rejects(f.send('host','rollback.host',{targetRound:1,decision:'vote'}),{code:'NO_MULTIPLAYER_VOTE'});assert.equal(f.host.state().vote,null);
 await f.host.close();await f.send('host','rollback.host',{targetRound:1,decision:'approve'});assert.equal(f.rollbacks.length,1);
});
