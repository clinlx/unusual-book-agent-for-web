'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const V=require('../../src/vfs'),Core=require('../../src/game-core'),D=require('../../src/game-debrief'),Host=require('../../src/multiplayer-host'),Sync=require('../../src/multiplayer-sync'),Import=require('../../src/game-import');
function save(){
  const tree=V.createTree();for(const id of ['a','b']){V.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id,Alive:true,Enabled:true}));V.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[]');}
  const s=Core.createSave('复盘测试',tree);s.status='ended';s.round=2;s.events=[{id:'story',type:'story',round:2,content:'打开城门，故事落幕。',audience:'public'}];s.snapshots=[{round:1}];return s;
}
async function fixture(t,executeDebrief){
  const s=save();s.status='waiting';let clock=1000,seq=0;const requests=[];
  const host=Host.create({getSave:()=>s,now:()=>clock,uid:()=>`id-${++seq}`,execute:async()=>{throw Error('不应进入游戏流程');},rollback:async()=>{throw Error('不应回溯');},executeDebrief:async()=>{requests.push(s.debrief.active.ids.slice());if(executeDebrief)await executeDebrief(s);else s.debrief.active.reply='主持人回答';}});
  t.after(()=>host.dispose());await host.initialize('a');await host.open();await host.addMember('guest');await host.assign('guest','b');s.status='ended';s.multiplayer.status='ended';
  const packet=(memberId,type,payload={})=>{const r=host.state();return {type,payload,requestId:`request-${++seq}`,roomId:r.roomId,roundId:r.roundId,epoch:r.epoch,bindingVersion:r.members[memberId].bindingVersion};};
  return {s,host,requests,packet,send:(id,type,p)=>host.handle(id,packet(id,type,p)),advance:ms=>clock+=ms};
}
test('transition is irreversible at core and host entry points, preserves story/world, retains imprint',async t=>{
  const f=await fixture(t),before=JSON.stringify(f.s.tree),events=JSON.stringify(f.s.events);
  await assert.rejects(f.send('guest','debrief.start'),{code:'FORBIDDEN'});
  await f.send('host','debrief.start');await f.host.waitForIdle();
  assert.equal(f.s.status,'ended');assert.equal(f.s.round,2);assert.equal(JSON.stringify(f.s.tree),before);assert.equal(JSON.stringify(f.s.events),events);assert.equal(f.s.snapshots.length,1);
  assert.throws(()=>Core.rollback(f.s),/复盘/);assert.throws(()=>Core.beginRound(f.s,'行动'),/复盘/);assert.throws(()=>Core.rebuildContext(f.s),/复盘/);
  assert.equal(Core.execute(f.s,'write_file',{path:'/workspace/oops',content:'bad'}).ok,false);
  for(const type of ['action.submit','action.prepare','round.resume','rollback.request','rollback.host','slot.mode'])await assert.rejects(f.send('host',type,{content:'旧协议'}),{code:'DEBRIEF_ONLY'});
  assert.ok((await f.send('host','character.preview')).character);
});
test('trailing debounce merges multiple players and repeated speech once, idempotent delivery does not extend it',async t=>{
  const f=await fixture(t);await f.send('host','debrief.start');await f.host.waitForIdle();
  await f.send('host','debrief.submit',{content:'甲的问题'});f.advance(4000);
  const p=f.packet('guest','debrief.submit',{content:'乙补充'});await f.host.handle('guest',p);const due=f.s.debrief.dueAt;
  f.advance(2000);await f.host.handle('guest',p);assert.equal(f.s.debrief.dueAt,due);
  await f.send('host','debrief.submit',{content:'甲再次补充'});f.advance(4999);await f.host.checkAutomatic();assert.equal(f.requests.length,1);
  f.advance(1);await f.host.checkAutomatic();await f.host.waitForIdle();assert.equal(f.requests.length,2);assert.equal(f.requests[1].length,3);
  assert.equal(f.s.debrief.events.filter(e=>e.role==='user').length,3);
});
test('speech during a response is private to its sender until promoted, can be cancelled, then waits five seconds',async t=>{
  let release,started;const gate=new Promise(r=>release=r),start=new Promise(r=>started=r);
  const f=await fixture(t,async s=>{started();await gate;s.debrief.active.reply='回答完成';});
  await f.send('host','debrief.start');await start;
  const a=f.packet('host','debrief.submit',{content:'预定甲'}),b=f.packet('guest','debrief.submit',{content:'预定乙'});
  await f.host.handle('host',a);await f.host.handle('guest',b);
  assert.equal(D.view(f.s,'host').queued.length,1);assert.equal(D.view(f.s,'guest').queued.length,1);assert.equal(f.s.debrief.events.length,0);
  await assert.rejects(f.send('host','debrief.cancel',{id:b.requestId}),/不存在/);
  await f.send('guest','debrief.cancel',{id:b.requestId});
  release();await f.host.waitForIdle();assert.equal(f.s.debrief.queued.length,0);assert.equal(f.s.debrief.pending.length,1);assert.equal(f.s.debrief.dueAt,6000);
  assert.equal(f.s.debrief.events[0].role,'assistant');assert.equal(f.s.debrief.events[1].content,'预定甲');
  const guest=Sync.project(f.s,'b',{memberId:'guest',room:f.host.state()});assert.equal(guest.rollbackCount,0);assert.equal(guest.debrief.events[1].content,'预定甲');
});
test('failure retains current batch and later speech, manual continuation cannot duplicate user messages',async t=>{
  let fail=true;const f=await fixture(t,async s=>{if(fail)throw Error('暂时断网');s.debrief.active.reply='恢复回答';});
  await f.send('host','debrief.start');await f.host.waitForIdle();assert.equal(f.s.debrief.status,'interrupted');
  await f.send('guest','debrief.submit',{content:'稍后回答我'});await f.host.checkAutomatic();assert.equal(f.requests.length,1);
  fail=false;await f.send('host','debrief.resume');await f.host.waitForIdle();assert.equal(f.s.debrief.status,'waiting');assert.equal(f.s.debrief.events.filter(e=>e.role==='user').length,1);
});
test('reopen converts an abandoned request to interrupted and never auto-resumes it',async t=>{
  const s=save();D.enable(s,1);D.begin(s,1);let count=0;
  const host=Host.create({getSave:()=>s,execute:async()=>{},rollback:async()=>{},executeDebrief:async()=>count++});t.after(()=>host.dispose());
  assert.equal(s.debrief.status,'interrupted');await host.checkAutomatic();assert.equal(count,0);
});
test('model receives a speaker list and only read tools; forged writes never alter files',async()=>{
  const s=save();D.enable(s,1);s.debrief.intro=false;D.submit(s,'host',{actorId:'a'},'为什么打开城门？','q',1);D.begin(s,5001);
  const before=JSON.stringify(s.tree),seen=[];let n=0;
  await D.run(s,async messages=>{seen.push(messages);return n++===0?{content:'',reasoning:'需要检查资料',tool_calls:[{id:'x',type:'function',function:{name:'write_file',arguments:'{"path":"/workspace/模组.md","content":"篡改"}'}}]}:{content:'城门是结局的一部分。'};});
  const input=JSON.parse(seen[0].find(m=>m.role==='user'&&m.content.startsWith('{')).content);
  assert.deepEqual(input.messages,[{speaker_id:'a',speaker_name:'a',content:'为什么打开城门？'}]);
  assert.match(seen[0][0].content,/你是这次故事的主持人/);assert.deepEqual(D.tools().map(t=>t.function.name),['read_file','list_dir','search']);
  assert.equal(JSON.stringify(s.tree),before);assert.equal(JSON.parse(seen[1].at(-1).content).ok,false);assert.equal(seen[1].at(-2).reasoning_content,'需要检查资料');
});
test('shared queries cannot disclose private inputs, raw caches, hidden files or tool records',()=>{
  const s=save();D.enable(s);s.debrief.shared=true;
  s.events.push({type:'player',round:2,actorId:'a',content:'公开的话',privateContent:'SECRET',audience:'public'},{type:'story',round:2,content:'SECRET',audience:['a']});
  V.writeFile(s.tree,'/workspace/模组.md','SECRET');V.writeFile(s.tree,'/workspace/ROUND_CACHE.xml','SECRET');
  const files=D.files(s),all=[...files.values()].map(get=>get()).join('');assert.ok(!all.includes('SECRET'));assert.ok(all.includes('公开的话'));
  assert.equal(D.execute(s,'read_file',{path:'/workspace/ROUND_CACHE.xml'},files).ok,false);
  assert.equal(D.execute(s,'read_file',{path:'/workspace/../.reference/foo'},files).ok,false);
  assert.equal(D.execute(s,'read_file',{path:'/workspace/过往回合历史记忆/Round_2_Time_public/回合情节.json',limit:20},files).result.content.length,20);
});
test('long conversations use bounded context with original discussion readable by file',()=>{
  const s=save();D.enable(s,1);s.debrief.intro=false;
  for(let i=0;i<60;i++)s.debrief.events.push({id:'old'+i,role:'assistant',content:'较早讨论'.repeat(1000)});
  D.submit(s,'host',{actorId:'a'},'很长的问题'.repeat(2000),'long',1);D.begin(s,5001);
  const messages=D.context(s,6000);assert.ok(JSON.stringify(messages).length<6500);assert.ok(messages.some(m=>m.content.includes('first_message_id')));
  assert.ok([...D.files(s).values()].some(get=>get().includes('很长的问题')));assert.equal(s.debrief.events.length,61);
});
test('full export/import preserves irreversible mode and pending discussion',async()=>{
  const s=save();D.enable(s,1);D.begin(s,1);D.submit(s,'host',{actorId:'a'},'刷新后也不要丢失','queued',1);
  const zip=Import.exportSave(s),restored=await Import.importSave({name:'复盘.zip',arrayBuffer:()=>zip.arrayBuffer()});
  assert.equal(restored.debrief.queued[0].content,'刷新后也不要丢失');assert.throws(()=>Core.rollback(restored),/复盘/);assert.equal(restored.snapshots.length,1);
});

test('story export includes a separate foldable discussion, excludes scheduled speech and keeps replay node count',()=>{
  const s=save();D.enable(s,1);D.begin(s,1);D.submit(s,'host',{actorId:'a'},'NOT_YET_SUBMITTED','queued',1);s.debrief.active.reply='主持人复盘结论';D.complete(s,2);
  D.begin(s,5002);D.submit(s,'host',{actorId:'a'},'STILL_PRIVATE','private',5002);
  const html=require('../../src/game-presentation').historyHTML(s);
  assert.match(html,/archive-debrief debrief-history/);assert.match(html,/主持人复盘结论/);assert.match(html,/NOT_YET_SUBMITTED/);assert.ok(!html.includes('STILL_PRIVATE'));
  assert.match(html,/打开城门，故事落幕/);assert.match(html,/id="replay-progress"[\s\S]*? \/ <b>1<\/b>/);
});
