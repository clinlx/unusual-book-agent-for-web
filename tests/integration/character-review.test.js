'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),V=require('../../src/vfs'),C=require('../../src/game-core'),H=require('../../src/multiplayer-host'),Sync=require('../../src/multiplayer-sync');
async function setup(t,hostActor='pc'){const tree=V.createTree();for(const id of ['pc','p2']){V.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id,HP:3,MAXHP:10}));V.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[]');}const s=C.createSave('审核',tree);let broken=false,executions=0;const h=H.create({getSave:()=>s,persist:async()=>{if(broken)throw Error('disk');},execute:async()=>{executions++;},rollback:async()=>{}});t.after(()=>h.dispose());await h.initialize(hostActor);await h.open();await h.addMember('guest');await h.assign('guest','p2');const send=(memberId,type,payload={})=>{const r=h.state();return h.handle(memberId,{type,payload,requestId:crypto.randomUUID(),epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members[memberId].bindingVersion});};const snapshot={actorId:'pc',name:'外来者',raw:{info:{姓名:'外来者',HP:10,MAXHP:10,'.秘密':'CARD_SECRET'},items:[{名称:'外来道具'}],inventory:[],files:[],metadata:{modules:['旧世界']}}};return {s,h,send,snapshot,fail:()=>broken=true,executions:()=>executions};}
test('default review stages privately, blocks opening, and requires viewing current card before approval',async t=>{const f=await setup(t);const before=JSON.stringify(f.s.tree);const result=await f.send('guest','character.inject',{snapshot:f.snapshot});a.equal(result.characterReview.status,'pending');a.equal(JSON.stringify(f.s.tree),before);const id=result.characterReview.id,hash=result.characterReview.hash;await a.rejects(f.send('host','round.start'),{code:'PENDING_CHARACTER_REVIEW'});a.equal(f.executions(),0);await a.rejects(f.send('host','character.review',{actorId:'p2',id,hash,decision:'approve'}),{code:'REVIEW_NOT_VIEWED'});await a.rejects(f.send('guest','character.review.preview',{actorId:'p2',id}),{code:'FORBIDDEN'});const view=Sync.project(f.s,'p2',{memberId:'guest',room:f.h.state()});a.equal(view.room.characterReview.status,'pending');a.doesNotMatch(JSON.stringify(view),/CARD_SECRET|外来道具/);await f.send('host','character.review.preview',{actorId:'p2',id});await f.send('host','character.review',{actorId:'p2',id,hash,decision:'approve'});a.equal(C.player({...f.s,playerPath:'/workspace/Player-p2'}).name,'外来者');});
test('rejection preserves default card, replacement invalidates review and policy changes apply to staged and approved cards',async t=>{const f=await setup(t);const original=JSON.stringify(f.s.tree);let q=(await f.send('guest','character.inject',{snapshot:f.snapshot})).characterReview;await f.send('host','character.review.preview',{actorId:'p2',id:q.id});const newer=(await f.send('guest','character.inject',{snapshot:{...f.snapshot,name:'新的'}})).characterReview;await a.rejects(f.send('host','character.review',{actorId:'p2',id:q.id,hash:q.hash,decision:'approve'}),{code:'STALE_CHARACTER_REVIEW'});await f.send('host','character.review',{actorId:'p2',id:newer.id,decision:'reject'});a.equal(JSON.stringify(f.s.tree),original);await f.send('host','character.policy',{policy:'allow'});await f.send('guest','character.inject',{snapshot:f.snapshot});a.equal(C.player({...f.s,playerPath:'/workspace/Player-p2'}).name,'外来者');await f.send('host','character.policy',{policy:'review'});a.equal(C.player({...f.s,playerPath:'/workspace/Player-p2'}).name,'p2');await a.rejects(f.send('host','round.start'),{code:'PENDING_CHARACTER_REVIEW'});await f.send('host','character.policy',{policy:'deny'});await a.rejects(f.send('guest','character.inject',{snapshot:f.snapshot}),{code:'CHARACTER_IMPORT_DISABLED'});a.equal(C.player({...f.s,playerPath:'/workspace/Player-p2'}).name,'p2');});
test('review persistence failure rolls back approval and world changes',async t=>{const f=await setup(t);const q=(await f.send('guest','character.inject',{snapshot:f.snapshot})).characterReview;await f.send('host','character.review.preview',{actorId:'p2',id:q.id});f.fail();await a.rejects(f.send('host','character.review',{actorId:'p2',id:q.id,hash:q.hash,decision:'approve'}),/disk/);a.equal(C.player({...f.s,playerPath:'/workspace/Player-p2'}).name,'p2');a.equal(f.s.characterReviews.p2.status,'pending');});

test('approval requires the reviewed SHA-256 and hashes hidden content; stale or modified cards cannot apply',async t=>{
 const f=await setup(t),q=(await f.send('guest','character.inject',{snapshot:f.snapshot})).characterReview;
 a.match(q.hash,/^[a-f0-9]{64}$/);
 const preview=await f.send('host','character.review.preview',{actorId:'p2',id:q.id});
 a.equal(await Sync.hash(preview.character),q.hash);
 for(const hash of [undefined,'0'.repeat(64)])await a.rejects(f.send('host','character.review',{actorId:'p2',id:q.id,hash,decision:'approve'}),{code:'CHARACTER_HASH_MISMATCH'});
 f.s.characterReviews.p2.snapshot.raw.info['.秘密']='ALTERED_SECRET';
 await a.rejects(f.send('host','character.review',{actorId:'p2',id:q.id,hash:q.hash,decision:'approve'}),{code:'CHARACTER_HASH_MISMATCH'});
 a.equal(C.player({...f.s,playerPath:'/workspace/Player-p2'}).name,'p2');
 const next=(await f.send('guest','character.inject',{snapshot:{...f.snapshot,raw:{...f.snapshot.raw,info:{...f.snapshot.raw.info,'.秘密':'NEW_SECRET'}}}})).characterReview;
 a.notEqual(next.hash,q.hash);
 await a.rejects(f.send('host','character.review',{actorId:'p2',id:q.id,hash:q.hash,decision:'approve'}),{code:'STALE_CHARACTER_REVIEW'});
 await f.send('host','character.review.preview',{actorId:'p2',id:next.id});
 await f.send('host','character.review',{actorId:'p2',id:next.id,hash:next.hash,decision:'approve',snapshot:f.snapshot});
 a.equal(f.s.characterImports.p2.hash,next.hash);
 a.match(V.readFile(f.s.tree,'/workspace/Player-p2/基础信息.json').content,/NEW_SECRET/);
});
test('pending request survives disconnect but cannot cross a changed character ownership binding',async t=>{
 const f=await setup(t),q=(await f.send('guest','character.inject',{snapshot:f.snapshot})).characterReview;
 await f.send('host','character.review.preview',{actorId:'p2',id:q.id});
 f.s.multiplayer.members.guest.connected=false;
 a.equal(Sync.project(f.s,'p2',{memberId:'guest',room:f.h.state()}).room.characterReview.hash,q.hash);
 await a.rejects(f.send('host','round.start'),{code:'PENDING_CHARACTER_REVIEW'});
 f.s.multiplayer.members.guest.bindingVersion++;
 await a.rejects(f.send('host','character.review',{actorId:'p2',id:q.id,hash:q.hash,decision:'approve'}),{code:'STALE_CHARACTER_REVIEW'});
 a.equal(Sync.project(f.s,'p2',{memberId:'guest',room:f.h.state()}).room.characterReview,null);
});

test('spectating host can review but spectator clients cannot submit or decide cards',async t=>{
 const f=await setup(t,'$spectator'),q=(await f.send('guest','character.inject',{snapshot:f.snapshot})).characterReview;
 await f.h.reserveSpectator('audience');
 await a.rejects(f.send('audience','character.inject',{snapshot:f.snapshot}),{code:'SPECTATOR_READ_ONLY'});
 await a.rejects(f.send('audience','character.review.preview',{actorId:'p2',id:q.id}),{code:'SPECTATOR_READ_ONLY'});
 await f.send('host','character.review.preview',{actorId:'p2',id:q.id});
 await f.send('host','character.review',{actorId:'p2',id:q.id,hash:q.hash,decision:'approve'});
 a.equal(f.s.characterReviews.p2.status,'approved');
});
test('host reload and restoration of the same room ownership retain pending reviews',async t=>{
 const f=await setup(t),q=(await f.send('guest','character.inject',{snapshot:f.snapshot})).characterReview;
 f.h.dispose();const reopened=H.create({getSave:()=>f.s,execute:async()=>{},rollback:async()=>{}});t.after(()=>reopened.dispose());
 await reopened.initialize();await reopened.open();
 const r=reopened.state(),send=(type,payload={})=>reopened.handle('host',{type,payload,requestId:crypto.randomUUID(),epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members.host.bindingVersion});
 a.equal(Sync.project(f.s,'p2',{memberId:'guest',room:r}).room.characterReview?.id,q.id);
 await a.rejects(send('round.start'),{code:'PENDING_CHARACTER_REVIEW'});
 await send('character.review.preview',{actorId:'p2',id:q.id});await send('character.review',{actorId:'p2',id:q.id,hash:q.hash,decision:'approve'});
 a.equal(f.s.characterReviews.p2.status,'approved');
});
