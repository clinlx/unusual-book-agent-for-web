const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium}=require('playwright');
let server,browser,origin;
before(async()=>{const dist=path.resolve(__dirname,'../../dist');server=http.createServer((req,res)=>{const f=path.resolve(dist,'.'+req.url.split('?')[0]);if(!f.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(f,(e,b)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type','text/html;charset=utf-8');res.end(b);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
test('home keeps a running room alive; switching warns, cancellation preserves it, and confirmation settles the old run before opening another save',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[],sockets=[];page.on('pageerror',e=>errors.push(e.message));page.on('websocket',s=>sockets.push(s.url()));
 let requests=0;const releases=[];t.after(()=>releases.forEach(r=>r()));
 await page.route('https://**/*',async route=>{if(!route.request().url().startsWith('https://home-lifecycle.invalid/'))return route.abort();requests++;await new Promise(r=>releases.push(r));try{await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'late response'}}]})});}catch(_){} });
 await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();assert.equal(await page.locator('#connection-lamp').count(),0);assert.equal(await page.locator('[role="alertdialog"]').count(),0);assert.deepEqual(sockets,[]);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:960});
  const controls=await page.locator('.home-join-button,.page-switch').evaluateAll(es=>es.map(e=>{const r=document.createRange();r.selectNodeContents(e);const text=r.getBoundingClientRect(),box=e.getBoundingClientRect();return {height:box.height,offset:text.top+text.height/2-box.top-box.height/2};}));
  assert.equal(controls.length,2);assert.equal(controls[0].height,controls[1].height);for(const c of controls)assert.ok(Math.abs(c.offset)<=1,`home toolbar text must be centered at ${width}px; actual offset ${c.offset}`);
 }
 const ids=await page.evaluate(async()=>{
  const zip=ZIP.makeZip([{name:'Player-a/基础信息.json',text:'{"姓名":"甲"}'},{name:'Player-a/背包.json',text:'[]'}]);
  await GameApp.importSave(new File([zip],'第二份.zip'));const other=GameApp.getState().active.id;
  await GameApp.importSave(new File([zip],'当前房间.zip'));const current=GameApp.getState().active.id;
  await GameApp.updateSettings({baseUrl:'https://home-lifecycle.invalid/v1',apiKey:'test',stream:false,maxRetries:0});
  await GameApp.openRoom();window.__closed=[];await GameApp.attachMultiplayerTransport({onHost:()=>()=>{},sendToClient:async(id,p)=>__closed.push(p)});await GameApp.addMember('guest');
  window.__run=GameApp.start().catch(e=>window.__runError=e.message);return {other,current,roomId:GameApp.multiplayerState().roomId};
 });
 await page.waitForFunction(()=>GameApp.getState().running);await page.locator('.home-button').click();await page.locator('.save-grid').waitFor();
 assert.equal(await page.locator('#connection-lamp').count(),0);assert.equal(await page.evaluate(()=>GameApp.getState().running),true);assert.equal(await page.evaluate(()=>GameApp.multiplayerState().online),true);assert.equal(await page.evaluate(()=>__closed.length),0);
 await page.locator(`[data-action="open-save"][data-id="${ids.current}"]`).click();await page.locator('.game-layout').waitFor();assert.equal(await page.locator('[role="alertdialog"]').count(),0);assert.equal(await page.evaluate(()=>GameApp.multiplayerState().roomId),ids.roomId);assert.equal(requests,1);
 await page.locator('.home-button').click();await page.locator(`[data-action="open-save"][data-id="${ids.other}"]`).click();await page.locator('[role="alertdialog"]').waitFor();
 const warning=await page.locator('#app-dialog-message').innerText();assert.match(warning,/切换存档会导致多人房间关闭/);assert.match(warning,/切换存档会导致回合中断/);
 await page.locator('[data-dialog-value="cancel"]').click();assert.equal(await page.evaluate(()=>GameApp.getState().running),true);assert.equal(await page.evaluate(()=>GameApp.multiplayerState().roomId),ids.roomId);assert.equal(await page.evaluate(()=>__closed.length),0);
 await page.locator(`[data-action="open-save"][data-id="${ids.other}"]`).click();await page.locator('[data-dialog-value="confirm"]').click();
 await page.waitForFunction(id=>GameApp.getState().active.id===id&&!GameApp.getState().running,ids.other);
 assert.equal(await page.evaluate(()=>GameApp.multiplayerState().online),false);assert.equal(await page.evaluate(()=>__closed.filter(p=>p.type==='room.closed').length),1);
 const old=await page.evaluate(async id=>{const db=GameStore.create();await db.open();const s=await db.getSave(id);return {status:s.status,online:s.multiplayer.online};},ids.current);assert.equal(old.status,'interrupted');assert.equal(old.online,false);
 releases[0]();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>GameApp.getState().active.events.length),0);
 await page.evaluate(()=>{window.__single=GameApp.start().catch(()=>{});});await page.waitForFunction(()=>GameApp.getState().running);await page.locator('.home-button').click();
 await page.locator(`[data-action="open-save"][data-id="${ids.current}"]`).click();await page.locator('[role="alertdialog"]').waitFor();
 assert.match(await page.locator('#app-dialog-message').innerText(),/切换存档会导致回合中断/);assert.doesNotMatch(await page.locator('#app-dialog-message').innerText(),/多人房间关闭/);
 await page.locator('[data-dialog-value="cancel"]').click();assert.equal(await page.evaluate(()=>GameApp.getState().running),true);
 await page.locator(`[data-action="open-save"][data-id="${ids.current}"]`).click();await page.locator('[data-dialog-value="confirm"]').click();await page.waitForFunction(id=>GameApp.getState().active.id===id&&!GameApp.getState().running,ids.current);
 assert.equal(requests,2);releases.forEach(r=>r());assert.deepEqual(errors,[]);assert.deepEqual(sockets,[]);
});
test('connection lamp follows four states; nearby bubbles expire, preserve typing and never connect an offline page',async t=>{
 const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());const page=await context.newPage(),sockets=[],errors=[];page.on('websocket',s=>sockets.push(s.url()));page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();assert.equal(await page.locator('#connection-lamp').count(),0);assert.deepEqual(sockets,[]);
 await page.evaluate(async()=>{GameApp.getState().active={id:'view',name:'世界',actorId:'a',round:1,status:'waiting',slots:[],info:{姓名:'甲'},items:[],events:[]};await GameApp.updateSettings({});});
 await page.locator('#connection-lamp').waitFor();assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'purple');
 await page.locator('#action-input').fill('正在填写的行动');await page.locator('#action-input').focus();
 const set=async(network,room=null)=>{await page.evaluate(async({network,room})=>{Object.assign(GameApp.getState(),{network,room});await GameApp.updateSettings({reverseSendNewline:false});},{network,room});};
 await set({status:'connecting'});await page.waitForFunction(()=>document.querySelector('#connection-lamp').dataset.status==='yellow');
 await set({status:'connected'},{online:true});await page.waitForFunction(()=>document.querySelector('#connection-lamp').dataset.status==='green');
 await page.clock.install();await set({status:'disconnected',code:'ConnectionFailed',message:'服务器连接失败，请稍后重试'});await page.clock.runFor(70);
 assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'red');assert.match(await page.locator('.connection-bubble').innerText(),/服务器连接失败/);
 assert.equal(await page.locator('#action-input').inputValue(),'正在填写的行动');assert.equal(await page.evaluate(()=>document.activeElement.id),'action-input');fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../artifacts/connection-status-390.png')});
 const boxes=await page.evaluate(()=>{const l=document.querySelector('#connection-lamp').getBoundingClientRect(),b=document.querySelector('.connection-bubble').getBoundingClientRect();return {distance:b.top-l.bottom,right:b.right,left:b.left,width:innerWidth};});assert.ok(boxes.distance>=0&&boxes.distance<20);assert.ok(boxes.left>=0&&boxes.right<=boxes.width);
 await page.clock.runFor(5600);assert.equal(await page.locator('.connection-bubble').count(),0);assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'red');
 await set({status:'disconnected',code:'ConnectionFailed',message:'服务器连接失败，请稍后重试'});await page.clock.runFor(70);assert.equal(await page.locator('.connection-bubble').count(),0,'重复状态不持续骚扰');
 await set({status:'closed',code:'HostDisconnected',message:'房主已关闭房间'});await page.clock.runFor(70);assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'purple');assert.match(await page.locator('.connection-bubble').innerText(),/房主/);
 assert.deepEqual(sockets,[]);assert.deepEqual(errors,[]);
});
test('invalid invitation errors stay nonblocking on home without a lamp or server connection',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage(),sockets=[];page.on('websocket',s=>sockets.push(s.url()));await page.goto(origin+'/client.html');
 await page.locator('[name="invitation"]').fill('<img src=x onerror=alert(1)>');await page.locator('#join-room-form button').click();await page.locator('#toast').waitFor({state:'visible'});
 assert.equal(await page.locator('#connection-lamp').count(),0);assert.equal(await page.locator('[role="alertdialog"]').count(),0);assert.equal(await page.locator('#toast img').count(),0);assert.deepEqual(sockets,[]);
});
test('clients see private pending dice in purple but cannot roll them or submit unconscious actions',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();
 await page.evaluate(async()=>{const s=GameApp.getState();s.room={online:true,status:'collecting',members:[]};s.active={id:'view',name:'测试',actorId:'a',round:1,status:'waiting',slots:[{id:'a',name:'甲'},{id:'b',name:'乙'}],info:{姓名:'甲',Alive:true,Enabled:false},items:[],events:[{id:'pending',type:'dice',private:true,pending:true,roller:'甲 (Player-a)',diceArgs:{dice_dict:{侦查:'1d100'},related_attr:'侦查'}},{id:'other',type:'player',actorId:'b',content:'乙开门'},{id:'private',type:'story',private:true,content:'只给甲的正文'}]};await GameApp.updateSettings({});});
 await page.locator('.dice-pending').waitFor();assert.match(await page.locator('.dice-pending').innerText(),/等待房主检定/);assert.equal(await page.locator('.dice-pending').getAttribute('data-action'),null);
 assert.equal(await page.locator('.dice-pending').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(243, 236, 255)');assert.equal(await page.locator('#action-form button[type="submit"]').isDisabled(),true);
 assert.match(await page.locator('.player-other header').innerText(),/乙/);assert.doesNotMatch(await page.locator('.player-other header').innerText(),/你/);assert.equal(await page.locator('.story.private-story').count(),1);
 await page.locator('.dice-pending').click();assert.equal(await page.locator('[data-action="manual-dice-roll"]').count(),0);assert.deepEqual(errors,[]);
});
