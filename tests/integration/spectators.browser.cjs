'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),Host=require('../../src/multiplayer-host'),Sync=require('../../src/multiplayer-sync'),VFS=require('../../src/vfs'),Core=require('../../src/game-core');
let server,browser,origin;
before(async()=>{const dist=path.resolve(__dirname,'../../dist');server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+req.url.split('?')[0]);if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(e,data)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(data);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
async function pageFor(t,width=390){const context=await browser.newContext({viewport:{width,height:844}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(4000);await page.route('https://**/*',r=>r.abort());await page.route('**/modules.json',r=>r.fulfill({json:[]}));await page.route('**/files/**',r=>r.abort());return page;}
test('a new world with one actor still offers the initial spectator-host choice',async t=>{
 const page=await pageFor(t);await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{await GameApp.updateSettings({apiKey:'test'});await GameApp.importSave(new File([ZIP.makeZip([{name:'Player-a/基础信息.json',text:'{"姓名":"甲"}'},{name:'Player-a/背包.json',text:'[]'}])],'一人世界.zip'));});
 await page.locator('.host-spectator-choice>summary').waitFor();assert.equal(await page.locator('[data-action="host-spectate"]').isHidden(),true);assert.equal(await page.locator('[data-action="slot-confirm"]').isDisabled(),true);
});
test('host selects spectator, manages a collapsed observer list with global save, and has no composer',async t=>{
 const page=await pageFor(t),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{await GameApp.updateSettings({apiKey:'test'});await GameApp.importSave(new File([ZIP.makeZip(['a','b'].flatMap(id=>[{name:'Player-'+id+'/基础信息.json',text:JSON.stringify({姓名:id})},{name:'Player-'+id+'/背包.json',text:'[]'}]))],'观战.zip'));});
 await page.locator('.host-spectator-choice>summary').click();await page.locator('[data-action="host-spectate"]').click();await page.locator('#slot-mode-a').selectOption('player');await page.locator('[data-action="slot-confirm"]').click();
 await page.locator('#action-form').waitFor({state:'detached'});assert.equal(await page.locator('[data-action="start"]').count(),1);assert.equal(await page.locator('.spectator-roster').count(),2);assert.equal(await page.evaluate(()=>GameApp.getState().storageWarning),null);
 await checkSpectatorHeader(page);
 await page.locator('[data-action="room-panel"]').click();assert.equal(await page.locator('#spectator-slots').getAttribute('open'),null);await page.locator('#spectator-slots summary').click();
 await page.locator('[data-action="add-spectator"]').click();assert.equal(await page.locator('[data-spectator-permission]').count(),1);await page.locator('[data-spectator-permission]').selectOption('all');
 await page.locator('[data-action="save-room"]').click();await page.waitForFunction(()=>GameApp.getState().spectators?.length===1);assert.equal(await page.evaluate(()=>GameApp.getState().network),null);
 assert.equal(await page.locator('[data-action="delete-spectator"]').count(),1);
 await page.evaluate(()=>{const state=GameApp.getState();state.savedInvites=[{spectatorId:state.spectators[0].id,key:'test-spectator-join-key'}];});
 await page.locator('.modal-actions [data-action="close-modal"]').click();await page.locator('[data-action="room-panel"]').click();await page.locator('#spectator-slots>summary').click();
 const keyDetails=page.locator('[data-spectator-card] .slot-invite-details');assert.equal(await keyDetails.getAttribute('open'),null);await keyDetails.locator('summary').click();assert.equal(await keyDetails.locator('textarea').inputValue(),'test-spectator-join-key');await keyDetails.locator('summary').click();
 for(const width of [320,390,820]){await page.setViewportSize({width,height:844});const row=page.locator('.spectator-slot-controls').first(),label=await row.locator('label>span').boundingBox(),select=await row.locator('select').boundingBox(),presence=await row.locator('.slot-presence').boundingBox(),remove=await page.locator('[data-action="delete-spectator"]').boundingBox();assert.ok(Math.abs(label.y+label.height/2-select.y-select.height/2)<2,'label and select share a row');assert.ok(Math.abs(presence.y+presence.height/2-select.y-select.height/2)<2,'presence and perspective share a row');assert.ok(remove.y>select.y+select.height,'delete moves to invitation footer');assert.ok(select.x>label.x+label.width);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.setViewportSize({width:390,height:844});assert.deepEqual(errors,[]);await page.screenshot({path:'tests/artifacts/spectator-host-390.png'});
});
test('spectator client switches authorized perspectives, shows player rosters and cannot see other secrets',async t=>{
 const page=await pageFor(t,1280),errors=[];page.on('pageerror',e=>errors.push(e.message));const tree=VFS.createTree();for(const id of ['a','b']){VFS.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id==='a'?'白墨':'凛',性别:id==='a'?'男':'女',状态:id==='a'?{HP:8,MAXHP:12,MP:10,MAXMP:10,SAN:65,MAXSAN:99}:{HP:10,MAXHP:10,MP:4,MAXMP:8},'.秘密':'不可公开档案'}));VFS.writeFile(tree,`/workspace/Player-${id}/背包.json`,JSON.stringify([{名称:'手电筒'},{名称:'隐秘信件',可见性:'Hide','.备注':'私密备注'}]));}
 const save=Core.createSave('观战',tree),host=Host.create({getSave:()=>save,execute:async()=>{},rollback:async()=>{}});t.after(()=>host.dispose());await host.initialize('a');await host.open();await host.addMember('b');await host.assign('b','b');await host.reserveSpectator('watch','all');await host.joinInvitation('watch');
 save.status='waiting';save.events=[{type:'story',audience:'public',content:'公共故事',round:1},{type:'story',audience:['a'],private:true,content:'甲的秘密',round:1},{type:'story',audience:['b'],private:true,content:'乙的秘密',round:1}];const projector=Sync.createHost({getSave:()=>save,getRoom:()=>host.state()});
 let detailGate=null,releaseDetail,detailFailure=false; t.after(()=>releaseDetail?.());
 await page.exposeFunction('testServer',async(id,p)=>{if(p.type==='sync.request')return page.evaluate(p=>GameApp.receive(p),await projector.sync(id,p.payload));if(p.type==='sync.ack')return;if(['profile.request','inventory.request'].includes(p.type)){if(detailGate)await detailGate;if(detailFailure)return page.evaluate(p=>GameApp.receive(p),{type:'command.result',requestId:p.requestId,ok:false,message:'test detail unavailable'});const kind=p.type.split('.')[0];return page.evaluate(p=>GameApp.receive(p),{type:'command.result',requestId:p.requestId,ok:true,[kind]:Sync[kind](save,p.payload.actorId,{memberId:id,room:host.state()})});}const result=await host.handle(id,p);await page.evaluate(p=>GameApp.receive(p),{type:'command.result',...result});});
 await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();await page.evaluate(()=>GameApp.connect({onClient:()=>()=>{},sendToHost:(id,p)=>window.testServer(id,p)},'watch'));
 await page.locator('.character-roster').waitFor();await page.locator('[data-action="room-panel"]').click();await page.locator('#spectator-view').waitFor();await checkSpectatorHeader(page);assert.equal(await page.locator('#action-form').count(),0);assert.equal(await page.locator('[data-action="rollback"]').count(),0);assert.match(await page.locator('#history').innerText(),/甲的秘密/);assert.match(await page.locator('#history').innerText(),/乙的秘密/);
 await page.locator('#spectator-view').selectOption('a');await page.locator('.spectator-roster').first().waitFor({state:'detached'});assert.equal(await page.locator('.spectator-roster').count(),0);assert.ok(!(await page.locator('#history').innerText()).includes('乙的秘密'));
 await page.locator('#spectator-view').selectOption('all');await page.locator('.spectator-roster').first().waitFor();assert.equal(await page.locator('.spectator-roster').count(),2);
 await page.locator('.room-modal').waitFor();assert.equal(await page.locator('.room-modal [data-action="player-profile"]').count(),2);await checkRoomBars(page);
 const compact=await page.locator('.room-modal [data-slot="a"]').evaluate(card=>{const a=card.querySelector('.slot-presence').getBoundingClientRect(),b=card.querySelector('.slot-controls').getBoundingClientRect();return {aligned:Math.abs(a.y+a.height/2-b.y-b.height/2)<2,right:b.x>a.right};});assert.deepEqual(compact,{aligned:true,right:true});
 save.round=1;save.snapshots=[{round:0,tree:structuredClone(save.tree),slots:structuredClone(save.slots)}];const updated=JSON.parse(VFS.resolve(save.tree,['workspace','Player-a','基础信息.json']).content);updated.状态.HP=5;VFS.writeFile(save.tree,'/workspace/Player-a/基础信息.json',JSON.stringify(updated));await page.evaluate(p=>GameApp.receive(p),await projector.sync('watch'));await page.waitForFunction(()=>document.querySelector('.room-modal [data-slot="a"] .slot-vital.hp')?.getAttribute('aria-label')==='HP 5 / 12');
 await page.locator('.modal-actions [data-action="close-modal"]').click();
 await page.locator('.character-roster [data-actor="a"] .roster-change').waitFor();assert.equal(await page.locator('.inventory-roster .roster-change').count(),0);
 const colors=await page.locator('.character-roster [data-actor="a"] .slot-vital-track i').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).backgroundColor));assert.deepEqual(colors,['rgb(189, 119, 112)','rgb(112, 164, 189)','rgb(165, 138, 189)']);
 save.status='running';await page.evaluate(p=>GameApp.receive(p),await projector.sync('watch'));await page.locator('.roster-change').waitFor({state:'detached'});
 save.status='waiting';await page.evaluate(p=>GameApp.receive(p),await projector.sync('watch'));await page.locator('.character-roster [data-actor="a"] .roster-change').waitFor();
 VFS.writeFile(save.tree,'/workspace/Player-a/背包.json',JSON.stringify([{名称:'手电筒',数量:2},{名称:'隐秘信件',可见性:'Hide','.备注':'私密备注'}]));await page.evaluate(p=>GameApp.receive(p),await projector.sync('watch'));
 await page.locator('.inventory-roster [data-actor="a"] .roster-change').waitFor();
 await page.locator('.character-roster [data-actor="a"]').click();await page.locator('.player-profile').waitFor();assert.match(await page.locator('.player-profile').innerText(),/不可公开档案/);
 assert.equal(await page.locator('.player-profile .diff-decreased del').innerText(),'8');
 assert.equal(await page.locator('.character-roster [data-actor="a"] .roster-change').count(),0);
 assert.equal(await page.locator('.inventory-roster [data-actor="a"] .roster-change').count(),1);
 await page.locator('.modal-actions [data-action="close-modal"]').click();
 await page.evaluate(p=>GameApp.receive(p),await projector.sync('watch'));
 assert.equal(await page.locator('.character-roster [data-actor="a"] .roster-change').count(),0,'sync does not restore a read badge');
 detailGate=new Promise(resolve=>releaseDetail=resolve);
 await page.locator('.character-roster [data-actor="a"]').click();
 assert.equal(await page.locator('.player-profile').count(),1,'cached profile is visible before the response');
 assert.match(await page.locator('.player-detail-status').innerText(),/正在更新/);
 updated.状态.HP=4;VFS.writeFile(save.tree,'/workspace/Player-a/基础信息.json',JSON.stringify(updated));
 detailGate=null;releaseDetail();await page.waitForFunction(()=>!document.querySelector('.player-detail-status')?.textContent.includes('正在更新'));
 assert.match(await page.locator('.player-profile .diff-decreased').innerText(),/4/);
 await page.locator('.modal-actions [data-action="close-modal"]').click();
 detailFailure=true;await page.locator('.character-roster [data-actor="a"]').click();
 await page.waitForFunction(()=>document.querySelector('.player-detail-status')?.textContent.includes('更新失败'));
 assert.equal(await page.locator('.player-profile').count(),1,'failed refresh keeps the cached content');
 assert.match(await page.locator('.player-profile').innerText(),/不可公开档案/);
 await page.locator('.modal-actions [data-action="close-modal"]').click();detailFailure=false;
 await page.locator('.inventory-roster [data-actor="a"]').click();await page.locator('.player-inventory .diff-added').first().waitFor();
 assert.equal(await page.locator('.inventory-roster [data-actor="a"] .roster-change').count(),0);
 await page.locator('.modal-actions [data-action="close-modal"]').click();
 // Unchanged cached details must not move when a refresh starts, finishes or fails.
 const detailKinds=[{roster:'inventory',body:'inventory'},{roster:'character',body:'profile'}];
 for(const kind of detailKinds){
  await page.locator(`.${kind.roster}-roster [data-actor="b"]`).click();await page.locator(`.player-${kind.body}`).waitFor();
  await page.locator('.modal-actions [data-action="close-modal"]').click();
 }
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:844});
  for(const kind of detailKinds)for(const fails of [false,true]){
   if(width===390)await page.locator(`[data-action="mobile-${kind.roster==='inventory'?'left':'right'}"]`).click();
   detailFailure=fails;detailGate=new Promise(resolve=>releaseDetail=resolve);
   await page.locator(`.${kind.roster}-roster [data-actor="b"]`).click();await page.locator(`.player-${kind.body}`).waitFor();
   const before={modal:await page.locator('.modal').boundingBox(),content:await page.locator(`.player-${kind.body}`).boundingBox()};
   if(width===390&&!fails)await page.screenshot({path:`tests/artifacts/cached-${kind.body}-refresh-390.png`});
   detailGate=null;releaseDetail();await page.waitForFunction(()=>!document.querySelector('.modal')?.textContent.includes('正在更新'));
   const after={modal:await page.locator('.modal').boundingBox(),content:await page.locator(`.player-${kind.body}`).boundingBox()};
   assert.deepEqual(after,before,`cached ${kind.body} layout stays fixed at ${width}px (${fails?'failure':'success'})`);
   await page.locator('.modal-actions [data-action="close-modal"]').click();
  }
 }
 detailFailure=false;await page.setViewportSize({width:1280,height:844});
 save.round=2;save.snapshots[0].round=1;await page.evaluate(p=>GameApp.receive(p),await projector.sync('watch'));
 await page.locator('.character-roster [data-actor="a"] .roster-change').waitFor();
 await page.locator('[data-action="room-panel"]').click();await page.locator('#spectator-view').selectOption('a');await page.locator('.right-panel .diff-decreased del').waitFor();
 assert.equal(await page.locator('.right-panel .diff-decreased del').innerText(),'8');
 await page.locator('#spectator-view').selectOption('all');await page.locator('.spectator-roster').first().waitFor();await page.locator('.modal-actions [data-action="close-modal"]').click();
 await page.locator('.inventory-roster [data-actor="b"]').click();await page.locator('.player-inventory').waitFor();assert.match(await page.locator('.player-inventory').innerText(),/隐秘信件/);assert.match(await page.locator('.player-inventory').innerText(),/私密备注/);
 await host.configureSpectator('watch','none');await page.evaluate(p=>GameApp.receive(p),await projector.sync('watch'));await page.locator('.player-inventory').waitFor({state:'detached'});assert.equal(await page.locator('#spectator-view').count(),0);assert.ok(!(await page.locator('#history').innerText()).includes('秘密'));assert.equal(await page.locator('.inventory-roster .roster-count').first().innerText(),'1 件物品');
 detailGate=new Promise(resolve=>releaseDetail=resolve);
 await page.locator('.character-roster [data-actor="a"]').click();
 assert.equal(await page.locator('.player-profile').count(),0,'revoked perspective must not reuse the omniscient cache');
 assert.ok(!(await page.locator('.modal-body').innerText()).includes('不可公开档案'));
 detailGate=null;releaseDetail();await page.locator('.player-profile').waitFor();assert.ok(!(await page.locator('.player-profile').innerText()).includes('不可公开档案'));await page.locator('.modal-actions [data-action="close-modal"]').click();
 await page.locator('.inventory-roster [data-actor="a"]').click();await page.locator('.player-inventory').waitFor();assert.ok(!(await page.locator('.player-inventory').innerText()).includes('隐秘信件'));await page.locator('.modal-actions [data-action="close-modal"]').click();
 assert.deepEqual(errors,[]);await page.screenshot({path:'tests/artifacts/spectator-client-1280.png'});
 await page.setViewportSize({width:390,height:844});await page.locator('[data-action="mobile-right"]').click();await page.screenshot({path:'tests/artifacts/spectator-roster-390.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});

async function checkSpectatorHeader(page){
 const originalViewport=page.viewportSize();
 assert.equal(await page.locator('.topbar #spectator-view,.topbar .spectator-header').count(),0);
 assert.equal(await page.locator('.center-panel>.spectator-toolbar').count(),0);
 for(const width of [320,390,768,1024,1280]){
  await page.setViewportSize({width,height:844});
  const [home,nav]=await Promise.all(['.home-navigation','.topbar nav'].map(s=>page.locator(s).boundingBox()));
  assert.ok(home.x+home.width<=nav.x+1||nav.y>=home.y+home.height-1,'navigation groups do not overlap');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow at '+width);
 }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'tests/artifacts/spectator-header-'+(await page.evaluate(()=>GameApp.getState().client)?'client':'host')+'-390.png'});await page.setViewportSize(originalViewport);
}

async function checkRoomBars(page){
 for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:844});
  for(const [id,count]of [['a',3],['b',2]]){const bars=page.locator('.room-modal [data-slot="'+id+'"] .slot-vital');assert.equal(await bars.count(),count);const boxes=await bars.evaluateAll(els=>els.map(el=>({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width})));assert.ok(boxes.every(b=>Math.abs(b.width-boxes[0].width)<1&&Math.abs(b.y-boxes[0].y)<1));}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 await page.screenshot({path:'tests/artifacts/spectator-room-bars.png'});
}
