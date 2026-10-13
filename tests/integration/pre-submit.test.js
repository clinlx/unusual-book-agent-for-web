'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Pre=require('../../src/game-pre-submit');
function fixture(client=false){
 const state={client,running:true,active:{id:'save',actorId:'a',round:2,status:'running',events:[{type:'story',round:3,content:'正文'}],activeRound:client?undefined:{number:3,published:1,complete:false}},room:{epoch:0,round:3,roundId:'r3',status:'executing',online:client}};
 const flags={alive:true,enabled:true},sent=[],errors=[];let resolve,reject;
 const queue=Pre.create({getState:()=>state,getFlags:()=>flags,send:async(...args)=>{sent.push(args);return new Promise((a,b)=>{resolve=a;reject=b;});},onError:e=>errors.push(e.message)});
 return {state,flags,sent,queue,errors,accept:()=>resolve(),reject:()=>reject(Error('offline')),finish(){state.running=false;state.active.round=3;state.active.status='waiting';if(state.active.activeRound)state.active.activeRound.complete=true;state.room.status='collecting';state.room.round=4;state.room.roundId='r4';}};
}
const draft={draft:'公开说辞',privateDraft:'真实隐秘行动',hiddenSend:true,disguiseSend:true};
for(const client of [false,true])test((client?'client':'host')+' prepares only after a current visible story and sends the frozen action once at completion',async()=>{
 const f=fixture(client);f.state.active.events=[];if(!client)f.state.active.activeRound.published=0;
 assert.equal(Pre.canPrepare(f.state,f.flags),false);assert.throws(()=>f.queue.prepare(draft));
 f.state.active.events.push({type:'story',round:2,content:'旧故事'});assert.equal(Pre.canPrepare(f.state,f.flags),false);
 f.state.active.events.push({type:'story',round:3,content:'本轮故事'});assert.equal(Pre.canPrepare(f.state,f.flags),true);
 const edited={...draft};f.queue.prepare(edited);edited.draft='后来改动';await f.queue.tick();assert.equal(f.sent.length,0);assert.equal(f.queue.current().snapshot.draft,'公开说辞');
 f.finish();const work=f.queue.tick();await f.queue.tick();assert.equal(f.sent.length,1);assert.ok(f.queue.current().sending);
 assert.deepEqual(f.sent[0].slice(0,2),['公开说辞','真实隐秘行动']);assert.equal(f.sent[0][2].acceptOnly,true);
 f.accept();await work;assert.equal(f.queue.current(),null);await f.queue.tick();assert.equal(f.sent.length,1);assert.equal(Pre.canPrepare(f.state,f.flags),false);
});
test('queued action stays locked through unconscious and interrupted rounds, then sends when awake',async()=>{
 const f=fixture();f.queue.prepare(draft);f.finish();f.flags.enabled=false;await f.queue.tick();assert.ok(f.queue.current());assert.equal(f.sent.length,0);
 f.flags.enabled=true;f.state.room.status='interrupted';f.state.active.status='interrupted';await f.queue.tick();assert.equal(f.sent.length,0);
 f.state.active.round=5;f.state.active.status='waiting';f.state.room.status='collecting';f.state.room.roundId='r6';const work=f.queue.tick();assert.equal(f.sent.length,1);f.accept();await work;assert.equal(f.queue.current(),null);
});
test('disconnection, rollback voting, and an existing submission prevent queued sends',async()=>{
 const f=fixture(true);f.queue.prepare(draft);f.finish();f.state.network={status:'disconnected'};await f.queue.tick();
 f.state.network.status='connected';f.state.room.vote={};await f.queue.tick();f.state.room.vote=null;f.state.room.submitted=true;await f.queue.tick();assert.equal(f.sent.length,0);
 f.state.room.submitted=false;const work=f.queue.tick();f.accept();await work;assert.equal(f.sent.length,1);
});
test('failed automatic send retains its lock without repeatedly retrying the same window',async()=>{
 const f=fixture(true);f.state.network={status:'connected'};f.queue.prepare(draft);f.finish();const work=f.queue.tick();f.reject();await work;assert.equal(f.errors.length,1);assert.ok(f.queue.current());
 await f.queue.tick();assert.equal(f.sent.length,1);f.state.network.status='disconnected';await f.queue.tick();f.state.network.status='connected';const retry=f.queue.tick();assert.equal(f.sent.length,2);f.accept();await retry;assert.equal(f.queue.current(),null);
});
test('a rejected action can retry when consciousness returns within the same collecting round',async()=>{
 const f=fixture();f.queue.prepare(draft);f.finish();const first=f.queue.tick();f.reject();await first;
 f.flags.enabled=false;await f.queue.tick();f.flags.enabled=true;const retry=f.queue.tick();assert.equal(f.sent.length,2);f.accept();await retry;
});
test('queued hidden-only action does not send dormant disguise text and cancellation unlocks without sending',async()=>{
 const f=fixture();f.queue.prepare({...draft,disguiseSend:false});f.finish();const work=f.queue.tick();assert.equal(f.sent[0][0],'');assert.equal(f.sent[0][1],draft.privateDraft);f.accept();await work;
 f.state.running=true;f.state.room.status='executing';f.state.room.round=4;f.state.active.events.push({type:'story',round:4});f.queue.prepare(draft);assert.equal(f.queue.cancel(),true);assert.equal(f.queue.current(),null);
});
test('switching save or actor and rolling back invalidates a queued action',async()=>{
 for(const mutate of [s=>s.active.id='other',s=>s.active.actorId='b',s=>s.room.epoch++]){
  const f=fixture();f.queue.prepare(draft);mutate(f.state);f.finish();await f.queue.tick();assert.equal(f.queue.current(),null);assert.equal(f.sent.length,0);
 }
});
test('pre-submit does not reveal another player private-only story',()=>{
 const f=fixture();f.state.active.activeRound.published=0;f.state.active.events=[{type:'story',round:3,audience:['b'],private:true}];assert.equal(Pre.canPrepare(f.state,f.flags),false);
 f.state.active.events[0].audience=['a'];assert.equal(Pre.canPrepare(f.state,f.flags),true);
});
