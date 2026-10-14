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
 await page.locator('[data-action="host-spectate"]').waitFor();assert.equal(await page.locator('[data-action="slot-confirm"]').isDisabled(),true);
});
test('host selects spectator, manages a collapsed observer list with global save, and has no composer',async t=>{
 const page=await pageFor(t),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{await GameApp.updateSettings({apiKey:'test'});await GameApp.importSave(new File([ZIP.makeZip(['a','b'].flatMap(id=>[{name:'Player-'+id+'/基础信息.json',text:JSON.stringify({姓名:id})},{name:'Player-'+id+'/背包.json',text:'[]'}]))],'观战.zip'));});
 await page.locator('[data-action="host-spectate"]').click();await page.locator('#slot-mode-a').selectOption('player');await page.locator('[data-action="slot-confirm"]').click();
 await page.locator('#action-form').waitFor({state:'detached'});assert.equal(await page.locator('[data-action="start"]').count(),1);assert.equal(await page.locator('.spectator-panel-locked').count(),2);assert.equal(await page.evaluate(()=>GameApp.getState().storageWarning),null);
 await page.locator('[data-action="room-panel"]').click();assert.equal(await page.locator('#spectator-slots').getAttribute('open'),null);await page.locator('#spectator-slots summary').click();
 await page.locator('[data-action="add-spectator"]').click();assert.equal(await page.locator('[data-spectator-permission]').count(),1);await page.locator('[data-spectator-permission]').selectOption('all');
 await page.locator('[data-action="save-room"]').click();await page.waitForFunction(()=>GameApp.getState().spectators?.length===1);assert.equal(await page.evaluate(()=>GameApp.getState().network),null);
 assert.equal(await page.locator('[data-action="delete-spectator"]').count(),1);assert.deepEqual(errors,[]);await page.screenshot({path:'tests/artifacts/spectator-host-390.png'});
});
test('spectator client switches authorized perspectives, locks empty panels and cannot see other secrets',async t=>{
 const page=await pageFor(t,1280),errors=[];page.on('pageerror',e=>errors.push(e.message));const tree=VFS.createTree();for(const id of ['a','b']){VFS.writeFile(tree,`/workspace/Player-${id}/基础信息.json`,JSON.stringify({姓名:id}));VFS.writeFile(tree,`/workspace/Player-${id}/背包.json`,'[]');}
 const save=Core.createSave('观战',tree),host=Host.create({getSave:()=>save,execute:async()=>{},rollback:async()=>{}});t.after(()=>host.dispose());await host.initialize('a');await host.open();await host.addMember('b');await host.assign('b','b');await host.reserveSpectator('watch','all');await host.joinInvitation('watch');
 save.status='waiting';save.events=[{type:'story',audience:'public',content:'公共故事',round:1},{type:'story',audience:['a'],private:true,content:'甲的秘密',round:1},{type:'story',audience:['b'],private:true,content:'乙的秘密',round:1}];const projector=Sync.createHost({getSave:()=>save,getRoom:()=>host.state()});
 await page.exposeFunction('testServer',async(id,p)=>{if(p.type==='sync.request')return page.evaluate(p=>GameApp.receive(p),await projector.sync(id,p.payload));if(p.type==='sync.ack')return;const result=await host.handle(id,p);await page.evaluate(p=>GameApp.receive(p),{type:'command.result',...result});});
 await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();await page.evaluate(()=>GameApp.connect({onClient:()=>()=>{},sendToHost:(id,p)=>window.testServer(id,p)},'watch'));
 await page.locator('#spectator-view').waitFor();assert.equal(await page.locator('#action-form').count(),0);assert.equal(await page.locator('[data-action="rollback"]').count(),0);assert.match(await page.locator('#history').innerText(),/甲的秘密/);assert.match(await page.locator('#history').innerText(),/乙的秘密/);
 await page.locator('#spectator-view').selectOption('a');await page.locator('.spectator-panel-locked').first().waitFor({state:'detached'});assert.equal(await page.locator('.spectator-panel-locked').count(),0);assert.ok(!(await page.locator('#history').innerText()).includes('乙的秘密'));
 await page.locator('#spectator-view').selectOption('all');await page.locator('.spectator-panel-locked').first().waitFor();assert.equal(await page.locator('.spectator-panel-locked').count(),2);
 await page.locator('[data-action="room-panel"]').click();await page.locator('.room-modal').waitFor();assert.equal(await page.locator('[data-action="player-profile"]').count(),0);
 await host.configureSpectator('watch','none');await page.evaluate(p=>GameApp.receive(p),await projector.sync('watch'));await page.locator('#spectator-view').waitFor({state:'detached'});assert.equal(await page.locator('.room-modal').count(),0);assert.ok(!(await page.locator('#history').innerText()).includes('秘密'));assert.deepEqual(errors,[]);await page.screenshot({path:'tests/artifacts/spectator-client-1280.png'});
});
