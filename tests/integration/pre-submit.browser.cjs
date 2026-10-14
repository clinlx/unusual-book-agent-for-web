'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),VFS=require('../../src/vfs'),Core=require('../../src/game-core'),Sync=require('../../src/multiplayer-sync'),Host=require('../../src/multiplayer-host');
let server,browser,origin;
before(async()=>{const dist=path.resolve(__dirname,'../../dist');server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+req.url.split('?')[0]);if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(e,data)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(data);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
async function pageFor(t){const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(5000);await page.route('https://**/*',r=>r.abort());await page.route('**/modules.json',r=>r.fulfill({json:[]}));await page.route('**/files/**',r=>r.abort());return page;}
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
test('opening guide and host pre-submit lock, cancel, automatic acceptance, and immediate unlock',{timeout:20000},async t=>{
 const page=await pageFor(t),errors=[];page.on('pageerror',e=>errors.push(e.message));let requests=0,finish,continueNext,startedNext;
 const endGate=new Promise(r=>finish=r),nextGate=new Promise(r=>continueNext=r),nextRequest=new Promise(r=>startedNext=r);t.after(()=>{finish();continueNext();});
 await page.route('https://pre-submit.invalid/**',async route=>{
  const n=++requests;let calls;
  if(n===1)calls=[call('append_story',{content:'已经发出的开场正文。',one_line_summary_of_content:'开场'},'story')];
  else if(n===2){await endGate;calls=[call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end')];}
  else{startedNext();await nextGate;calls=[call('trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}},'trigger'),call('append_story',{content:'第二回合正文',one_line_summary_of_content:'第二回合'},'story2'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end2')];}
  await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'',tool_calls:calls}}]})});
 });
 await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{await GameApp.updateSettings({apiKey:'test',baseUrl:'https://pre-submit.invalid/v1',stream:false});await GameApp.importSave(new File([ZIP.makeZip([{name:'Player-a/基础信息.json',text:'{"姓名":"甲"}'},{name:'Player-a/背包.json',text:'[]'}])],'开场引导.zip'));});
 await page.locator('.composer-start-guide').waitFor();assert.equal(await page.locator('#action-input').isDisabled(),true);assert.match(await page.locator('.composer-start-guide').innerText(),/开始故事/);
 await page.screenshot({path:'tests/artifacts/opening-guide-host-390.png'});
 await page.locator('#action-form [data-action="start"]').click();await page.locator('[data-action="pre-submit"]').waitFor();await page.locator('#action-input').fill('我预先查看门锁');
 await page.locator('[data-action="pre-submit"]').click();assert.equal(await page.locator('#action-input').isDisabled(),true);assert.match(await page.locator('.pre-submit-notice').innerText(),/已准备好自动发送/);
 await page.screenshot({path:'tests/artifacts/pre-submit-locked-host-390.png'});
 await page.locator('[data-action="cancel-pre-submit"]').click();assert.equal(await page.locator('#action-input').isDisabled(),false);assert.equal(await page.locator('#action-input').inputValue(),'我预先查看门锁');
 await page.locator('#action-input').press('Control+Enter');await page.locator('.pre-submit-notice').waitFor();assert.equal(await page.locator('#action-input').isDisabled(),true);finish();
 await page.waitForFunction(()=>GameApp.getState().active.activeRound?.number===2).catch(async error=>{throw Error(error.message+' '+JSON.stringify(await page.evaluate(()=>{const s=GameApp.getState();return {status:s.active.status,round:s.active.round,room:s.room,err:s.error,draft:s.active.draft,notice:document.querySelector('.pre-submit-notice')?.textContent,toast:document.querySelector('#toast')?.textContent,events:s.active.events.slice(-3)};})));});await page.waitForFunction(()=>!document.querySelector('.pre-submit-notice'));assert.equal(await page.locator('#action-input').isDisabled(),false);assert.equal(await page.locator('#action-input').inputValue(),'');
 await nextRequest;assert.equal(requests,3);assert.equal(await page.evaluate(()=>GameApp.getState().active.activeRound.action),'我预先查看门锁');continueNext();await page.waitForFunction(()=>GameApp.getState().active.round===2&&!GameApp.getState().running);
 await page.locator('[data-action="pre-submit"]').waitFor({state:'hidden'});assert.equal(await page.locator('#action-input').isDisabled(),false);assert.deepEqual(errors,[]);
 await page.screenshot({path:'tests/artifacts/pre-submit-host-390.png'});
});
test('client confirms with host, restores frozen drafts after reload, and accepts one offline prepared action',{timeout:20000},async t=>{
 const page=await pageFor(t),tree=VFS.createTree(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const id of ['a','b']){VFS.writeFile(tree,'/workspace/Player-'+id+'/基础信息.json','{"姓名":"'+id+'","Alive":true,"Enabled":true}');VFS.writeFile(tree,'/workspace/Player-'+id+'/背包.json','[]');}
 const save=Core.createSave('预提交客户端',tree);save.status='new';let finish,acknowledge;
 const gate=new Promise(r=>finish=r);let registrationGate=new Promise(r=>acknowledge=r);t.after(()=>{finish();acknowledge();});
 const host=Host.create({getSave:()=>save,rollback:async()=>{},execute:async()=>{save.status='running';save.events.push({type:'story',round:1,content:'公开故事',audience:'public'});await gate;save.round=1;save.status='waiting';}});t.after(()=>host.dispose());
 await host.initialize('b');await host.open();await host.addMember('guest');await host.assign('guest','a');
 const projector=Sync.createHost({getSave:()=>save,getRoom:()=>host.state()}),sent=[];
 await page.exposeFunction('testServer',async(id,packet)=>{
  if(packet.type==='sync.request')return page.evaluate(p=>GameApp.receive(p),await projector.sync(id,packet.payload));
  if(packet.type==='sync.ack')return;
  sent.push(packet);if(packet.type==='action.prepare')await registrationGate;
  const result=await host.handle(id,packet);await page.evaluate(p=>GameApp.receive(p),{type:'command.result',...result});
 });
 await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();await page.evaluate(()=>GameApp.connect({onClient:()=>()=>{},sendToHost:(id,p)=>window.testServer(id,p)},'guest'));
 await page.locator('.composer-start-guide').waitFor();assert.match(await page.locator('.composer-start-guide').innerText(),/等待房主/);
 const r=host.state();await host.handle('host',{type:'round.start',requestId:'start',epoch:r.epoch,roundId:r.roundId,bindingVersion:r.members.host.bindingVersion});await new Promise(r=>setImmediate(r));await page.evaluate(p=>GameApp.receive(p),await projector.sync('guest'));
 await page.locator('[data-action="pre-submit"]').waitFor();await page.locator('#hidden-send-toggle').check();await page.locator('#disguise-send-toggle').check();await page.locator('#action-input').fill('真实的秘密');await page.locator('#action-private-input').fill('公开的伪装');
 await page.locator('#action-input').press('Control+Enter');await page.locator('.pre-submit-notice').waitFor();for(const id of ['action-input','action-private-input','hidden-send-toggle','disguise-send-toggle'])assert.equal(await page.locator('#'+id).isDisabled(),true);
 assert.match(await page.locator('.pre-submit-notice').innerText(),/确认/);assert.equal(await page.locator('[data-action="cancel-pre-submit"]').count(),0);acknowledge();
 await page.waitForFunction(()=>document.querySelector('.pre-submit-notice')?.textContent.includes('已准备好'));
 await page.locator('[data-action="cancel-pre-submit"]').click();await page.waitForFunction(()=>!document.querySelector('.pre-submit-notice'));assert.equal(host.state().preparedActions.a.status,'cancelled');assert.equal(await page.locator('#action-input').inputValue(),'真实的秘密');
 await page.locator('#action-input').press('Control+Enter');await page.waitForFunction(()=>document.querySelector('.pre-submit-notice')?.textContent.includes('已准备好'));
 await page.screenshot({path:'tests/artifacts/pre-submit-locked-client-390.png'});
 await page.reload();await page.locator('#join-room-form').waitFor();await page.evaluate(()=>GameApp.connect({onClient:()=>()=>{},sendToHost:(id,p)=>window.testServer(id,p)},'guest'));await page.locator('.pre-submit-notice').waitFor();assert.equal(await page.locator('#action-input').isDisabled(),true);
 VFS.writeFile(save.tree,'/workspace/Player-a/基础信息.json','{"姓名":"甲","Alive":true,"Enabled":false}');await host.setConnected('guest',false);finish();await host.waitForIdle();
 await page.evaluate(p=>GameApp.receive(p),await projector.sync('guest'));assert.equal(host.state().preparedActions.a.status,'queued');assert.equal(await page.locator('#action-input').isDisabled(),true);assert.equal(await page.locator('#action-private-input').inputValue(),'公开的伪装');
 VFS.writeFile(save.tree,'/workspace/Player-a/基础信息.json','{"姓名":"甲","Alive":true,"Enabled":true}');await host.checkAutomatic();assert.equal(host.state().preparedActions.a.status,'submitted');assert.equal(host.state().submissions.a.privateContent,'真实的秘密');
 await page.reload();await page.locator('#join-room-form').waitFor();await page.evaluate(()=>GameApp.connect({onClient:()=>()=>{},sendToHost:(id,p)=>window.testServer(id,p)},'guest'));
 await page.waitForFunction(()=>GameApp.getState().active?.inputHistory.some(x=>x.status==='accepted'));
 assert.equal(await page.locator('.pre-submit-notice').count(),0);assert.equal(sent.filter(x=>x.type==='action.submit').length,0);assert.equal(sent.filter(x=>x.type==='action.prepare').length,2);
 assert.equal(await page.locator('#action-input').isDisabled(),false);assert.equal(await page.locator('#action-input').inputValue(),'');assert.equal(await page.locator('#hidden-send-toggle').isChecked(),true);assert.equal(await page.locator('#disguise-send-toggle').isChecked(),true);assert.deepEqual(errors,[]);
});
