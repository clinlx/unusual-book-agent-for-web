'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),VFS=require('../../src/vfs'),Core=require('../../src/game-core'),Sync=require('../../src/multiplayer-sync');
let server,browser,origin;
before(async()=>{const dist=path.resolve(__dirname,'../../dist');server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+req.url.split('?')[0]);if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(e,data)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(data);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
async function pageFor(t){const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(5000);await page.route('https://**/*',r=>r.abort());return page;}
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
test('opening guide and host pre-submit lock, cancel, automatic acceptance, and immediate unlock',{timeout:20000},async t=>{
 const page=await pageFor(t),errors=[];page.on('pageerror',e=>errors.push(e.message));let requests=0,finish,continueNext;
 const endGate=new Promise(r=>finish=r),nextGate=new Promise(r=>continueNext=r);t.after(()=>{finish();continueNext();});
 await page.route('https://pre-submit.invalid/**',async route=>{
  const n=++requests;let calls;
  if(n===1)calls=[call('append_story',{content:'已经发出的开场正文。',one_line_summary_of_content:'开场'},'story')];
  else if(n===2){await endGate;calls=[call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end')];}
  else{await nextGate;calls=[call('trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}},'trigger'),call('append_story',{content:'第二回合正文',one_line_summary_of_content:'第二回合'},'story2'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end2')];}
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
 assert.equal(requests,3);assert.equal(await page.evaluate(()=>GameApp.getState().active.activeRound.action),'我预先查看门锁');continueNext();await page.waitForFunction(()=>GameApp.getState().active.round===2&&!GameApp.getState().running);
 await page.locator('[data-action="pre-submit"]').waitFor({state:'hidden'});assert.equal(await page.locator('#action-input').isDisabled(),false);assert.deepEqual(errors,[]);
 await page.screenshot({path:'tests/artifacts/pre-submit-host-390.png'});
});
test('client freezes private and disguise fields and modes until a conscious submission window',{timeout:15000},async t=>{
 const page=await pageFor(t),tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-a/基础信息.json','{"姓名":"甲","Alive":true,"Enabled":true}');VFS.writeFile(tree,'/workspace/Player-a/背包.json','[]');
 const save=Core.createSave('预提交客户端',tree);save.status='new';
 const room={roomId:'room',epoch:0,round:1,roundId:'r1',online:true,status:'collecting',members:{guest:{actorId:'a',bindingVersion:1,connected:true}},participants:[{actorId:'a',memberId:'guest',alive:true,enabled:true}],submissions:{}};save.multiplayer=room;
 const projector=Sync.createHost({getSave:()=>save,getRoom:()=>room}),sent=[];
 await page.exposeFunction('testServer',async(id,packet)=>{
  if(packet.type==='sync.request')return page.evaluate(p=>GameApp.receive(p),await projector.sync(id,packet.payload));
  if(packet.type==='action.submit'){sent.push(packet.payload);room.submissions.a={actorId:'a',memberId:'guest',...packet.payload};await page.evaluate(p=>GameApp.receive(p),{type:'command.result',requestId:packet.requestId,ok:true});}
 });
 await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();await page.evaluate(()=>GameApp.connect({onClient:()=>()=>{},sendToHost:(id,p)=>window.testServer(id,p)},'guest'));
 await page.locator('.composer-start-guide').waitFor();assert.match(await page.locator('.composer-start-guide').innerText(),/等待房主/);
 room.status='executing';save.status='running';save.events.push({type:'story',round:1,content:'公开故事',audience:'public'});await page.evaluate(p=>GameApp.receive(p),await projector.sync('guest'));
 await page.locator('[data-action="pre-submit"]').waitFor();await page.locator('#hidden-send-toggle').check();await page.locator('#disguise-send-toggle').check();await page.locator('#action-input').fill('真实的秘密');await page.locator('#action-private-input').fill('公开的伪装');
 await page.locator('#action-input').press('Control+Enter');await page.locator('.pre-submit-notice').waitFor();for(const id of ['action-input','action-private-input','hidden-send-toggle','disguise-send-toggle'])assert.equal(await page.locator('#'+id).isDisabled(),true);
 await page.screenshot({path:'tests/artifacts/pre-submit-locked-client-390.png'});
 save.round=1;save.status='waiting';room.round=2;room.roundId='r2';room.status='collecting';VFS.writeFile(save.tree,'/workspace/Player-a/基础信息.json','{"姓名":"甲","Alive":true,"Enabled":false}');room.participants[0].enabled=false;
 await page.evaluate(p=>GameApp.receive(p),await projector.sync('guest'));assert.equal(sent.length,0);assert.equal(await page.locator('#action-input').isDisabled(),true);assert.equal(await page.locator('#action-private-input').inputValue(),'公开的伪装');
 VFS.writeFile(save.tree,'/workspace/Player-a/基础信息.json','{"姓名":"甲","Alive":true,"Enabled":true}');room.participants[0].enabled=true;await page.evaluate(p=>GameApp.receive(p),await projector.sync('guest'));
 await page.waitForFunction(()=>!document.querySelector('.pre-submit-notice'));assert.equal(sent.length,1);assert.deepEqual(sent[0],{content:'公开的伪装',privateContent:'真实的秘密',disguise:true});assert.equal(await page.locator('#action-input').isDisabled(),false);assert.equal(await page.locator('#hidden-send-toggle').isChecked(),true);assert.equal(await page.locator('#disguise-send-toggle').isChecked(),true);
});
