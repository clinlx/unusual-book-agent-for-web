const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium}=require('playwright');
let server,browser,origin;
before(async()=>{const dist=path.resolve(__dirname,'../../dist');server=http.createServer((req,res)=>{const f=path.resolve(dist,'.'+req.url.split('?')[0]);if(!f.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(f,(e,b)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type','text/html;charset=utf-8');res.end(b);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
test('connection lamp follows four states; nearby bubbles expire, preserve typing and never connect an offline page',async t=>{
 const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());const page=await context.newPage(),sockets=[],errors=[];page.on('websocket',s=>sockets.push(s.url()));page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/client.html');await page.locator('#connection-lamp').waitFor();assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'purple');
 await page.locator('#connection-lamp').click();assert.match(await page.locator('.connection-bubble').innerText(),/邀请/);assert.deepEqual(sockets,[]);
 await page.locator('[name="invitation"]').fill('正在填写的邀请');await page.locator('[name="invitation"]').focus();
 const set=async(network,room=null)=>{await page.evaluate(async({network,room})=>{Object.assign(GameApp.getState(),{network,room});await GameApp.updateSettings({reverseSendNewline:false});},{network,room});};
 await set({status:'connecting'});await page.waitForFunction(()=>document.querySelector('#connection-lamp').dataset.status==='yellow');
 await set({status:'connected'},{online:true});await page.waitForFunction(()=>document.querySelector('#connection-lamp').dataset.status==='green');
 await page.clock.install();await set({status:'disconnected',code:'ConnectionFailed',message:'服务器连接失败，请稍后重试'});await page.clock.runFor(70);
 assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'red');assert.match(await page.locator('.connection-bubble').innerText(),/服务器连接失败/);
 assert.equal(await page.locator('[name="invitation"]').inputValue(),'正在填写的邀请');assert.equal(await page.evaluate(()=>document.activeElement.name),'invitation');fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../artifacts/connection-status-390.png')});
 const boxes=await page.evaluate(()=>{const l=document.querySelector('#connection-lamp').getBoundingClientRect(),b=document.querySelector('.connection-bubble').getBoundingClientRect();return {distance:b.top-l.bottom,right:b.right,left:b.left,width:innerWidth};});assert.ok(boxes.distance>=0&&boxes.distance<20);assert.ok(boxes.left>=0&&boxes.right<=boxes.width);
 await page.clock.runFor(5600);assert.equal(await page.locator('.connection-bubble').count(),0);assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'red');
 await set({status:'disconnected',code:'ConnectionFailed',message:'服务器连接失败，请稍后重试'});await page.clock.runFor(70);assert.equal(await page.locator('.connection-bubble').count(),0,'重复状态不持续骚扰');
 await set({status:'closed',code:'HostDisconnected',message:'房主已关闭房间'});await page.clock.runFor(70);assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'purple');assert.match(await page.locator('.connection-bubble').innerText(),/房主/);
 assert.deepEqual(sockets,[]);assert.deepEqual(errors,[]);
});
test('invalid invitation errors use a nonblocking lamp bubble without connecting or exposing markup',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage(),sockets=[];page.on('websocket',s=>sockets.push(s.url()));await page.goto(origin+'/client.html');
 await page.locator('[name="invitation"]').fill('<img src=x onerror=alert(1)>');await page.locator('#join-room-form button').click();await page.locator('.connection-bubble').waitFor();
 assert.equal(await page.locator('#connection-lamp').getAttribute('data-status'),'purple');assert.equal(await page.locator('[role="alertdialog"]').count(),0);assert.equal(await page.locator('.connection-bubble img').count(),0);assert.deepEqual(sockets,[]);
});
test('clients see private pending dice in purple but cannot roll them or submit unconscious actions',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/client.html');await page.locator('#connection-lamp').waitFor();
 await page.evaluate(async()=>{const s=GameApp.getState();s.room={online:true,status:'collecting',members:[]};s.active={id:'view',name:'测试',actorId:'a',round:1,status:'waiting',slots:[{id:'a',name:'甲'},{id:'b',name:'乙'}],info:{姓名:'甲',Alive:true,Enabled:false},items:[],events:[{id:'pending',type:'dice',private:true,pending:true,roller:'甲 (Player-a)',diceArgs:{dice_dict:{侦查:'1d100'},related_attr:'侦查'}},{id:'other',type:'player',actorId:'b',content:'乙开门'},{id:'private',type:'story',private:true,content:'只给甲的正文'}]};await GameApp.updateSettings({});});
 await page.locator('.dice-pending').waitFor();assert.match(await page.locator('.dice-pending').innerText(),/等待房主检定/);assert.equal(await page.locator('.dice-pending').getAttribute('data-action'),null);
 assert.equal(await page.locator('.dice-pending').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(243, 236, 255)');assert.equal(await page.locator('#action-form button[type="submit"]').isDisabled(),true);
 assert.match(await page.locator('.player-other header').innerText(),/乙/);assert.doesNotMatch(await page.locator('.player-other header').innerText(),/你/);assert.equal(await page.locator('.story.private-story').count(),1);
 await page.locator('.dice-pending').click();assert.equal(await page.locator('[data-action="manual-dice-roll"]').count(),0);assert.deepEqual(errors,[]);
});
