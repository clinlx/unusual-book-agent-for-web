'use strict';
const {test,before,after}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright'),Maps=require('../../src/node-map'),P=require('../../src/game-presentation'),Core=require('../../src/game-core'),V=require('../../src/vfs'),Sync=require('../../src/multiplayer-sync');
const nodes=[{ID:'yard',表面名字:'庭院',表面描述:'雨后的石径',剧情笔记:'PRIVATE_MAP_NOTE',连通性:['hall','hidden'],是否隐藏:false,位置参考坐标:{x:0,y:0}},{ID:'hall',表面名字:'门厅',表面描述:'门廊下亮着壁灯。'.repeat(80),剧情笔记:'PRIVATE_MAP_NOTE',连通性:['yard'],是否隐藏:false},{ID:'hidden',表面名字:'SECRET_CELLAR',表面描述:'SECRET_LOCATION',剧情笔记:'PRIVATE_MAP_NOTE',连通性:[],是否隐藏:true}];
const snapshot=Maps.snapshot(nodes,'yard');let browser,server,origin;
before(async()=>{server=http.createServer((req,res)=>{const name=req.url.split('?')[0].slice(1);if(!['index.html','client.html'].includes(name))return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.resolve(__dirname,'../../dist',name)));});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function pageFor(t,width){const context=await browser.newContext({viewport:{width,height:900}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(5000);await page.route('https://**/*',r=>r.abort());return page;}
async function checkCanvas(page){a.ok(await page.locator('.node-map-preview').first().evaluate(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.some((v,i)=>i%4===3&&v>0);}));}
for(const width of [1280,390])for(const unit of [1,1000000])test('canvas fits reference coordinates in screen pixels at '+width+' / unit '+unit,async t=>{
 const page=await pageFor(t,width),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.evaluate(()=>{const p=CanvasRenderingContext2D.prototype,clear=p.clearRect,arc=p.arc,text=p.fillText;p.clearRect=function(...args){this.canvas.drawnArcs=[];this.canvas.drawnText=[];return clear.apply(this,args);};p.arc=function(...args){(this.canvas.drawnArcs??=[]).push(args);return arc.apply(this,args);};p.fillText=function(...args){(this.canvas.drawnText??=[]).push({args,font:this.font});return text.apply(this,args);};});
 const positions=[[0,0],[-1,1],[1,1],[-2,2],[0,2],[2,2]],names=['金博尔宅','金博尔宅书房','邻里街区','报社','图书馆','车站'];
 const map=Maps.snapshot(positions.map(([x,y],i)=>({ID:String(i),表面名字:names[i],表面描述:'已知地点 '+i,剧情笔记:'PRIVATE_MAP_NOTE',连通性:i<5?[String(i+1)]:[],是否隐藏:false,位置参考坐标:{x:x*unit,y:y*unit}})),'1');
 await page.setContent(P.historyHTML({name:'比例尺回归',events:[{type:'map',map,round:1}]}));await checkCanvas(page);
 const canvas=page.locator('.node-map-preview'),geometry=await canvas.evaluate(c=>({arcs:c.drawnArcs,text:c.drawnText,width:c.clientWidth,height:c.clientHeight}));
 const centers=geometry.arcs.filter(p=>p[2]!==18);a.equal(centers.length,6);a.ok(geometry.arcs.every(p=>p[2]>=8&&p[2]<=18));
 for(let i=0;i<centers.length;i++)for(let j=0;j<i;j++)a.ok(Math.hypot(centers[i][0]-centers[j][0],centers[i][1]-centers[j][1])>32);
 a.ok(geometry.text.every(t=>t.font==='14px serif'));a.ok(geometry.text.length>=6);
 await page.screenshot({path:path.resolve(__dirname,'../artifacts/node-map-scale-'+width+'-'+unit+'.png')});
 if(width<700)await page.locator('label[for="archive-tab-items"]').click();await page.locator('#latest-map').click();
 const detail=page.locator('.node-map-detail');const center=await detail.evaluate(c=>c.drawnArcs.filter(p=>p[2]!==18)[2]);const box=await detail.boundingBox();
 await page.mouse.move(box.x+center[0],box.y+center[1]);a.match(await detail.getAttribute('title'),/邻里街区/);await page.mouse.click(box.x+center[0],box.y+center[1]);a.match(await page.locator('.node-map-description').innerText(),/邻里街区/);
 await page.locator('[data-zoom="1.25"]').click();a.ok(await detail.evaluate(c=>c.drawnArcs.every(p=>p[2]<26)));await page.locator('[data-fit]').click();a.ok(await detail.evaluate(c=>c.drawnArcs.every(p=>p[2]<=18)));
 a.deepEqual(errors,[]);
});
for(const width of [1280,390])test('live map cards and fixed latest-map toolbar at '+width,async t=>{
 const page=await pageFor(t,width),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{await GameApp.updateSettings({apiKey:'test'});await GameApp.importSave(new File([ZIP.makeZip([{name:'Player-pc/基础信息.json',text:'{"姓名":"白墨"}'},{name:'Player-pc/背包.json',text:'[]'}])],'地图测试.zip'));});
 await page.locator('[data-action="slot-choose"]').click();await page.locator('[data-action="slot-confirm"]').click();
 await page.waitForFunction(()=>GameApp.getState().active?.playerPath);
 a.equal(await page.locator('.player-tools').count(),0);
 await page.evaluate(map=>{const s=GameApp.getState().active;VFS.writeFile(s.tree,s.playerPath+'/基础信息.json',JSON.stringify({姓名:'白墨',当前位置:'hall'}));s.events.push({id:'map-1',type:'map',round:1,map,audience:'public'});GameApp.setMode('play');},snapshot);
 await page.locator('.node-map-card').waitFor();await checkCanvas(page);
 await page.locator('.node-map-card').click();await page.locator('.node-map-dialog').waitFor();a.match(await page.locator('.node-map-description').innerText(),/庭院/);
 await page.locator('.node-map-places button').filter({hasText:'门厅'}).click();a.ok(await page.locator('.node-map-description').evaluate(n=>n.scrollHeight>n.clientHeight));await page.locator('[data-zoom="1.25"]').click();
 fs.mkdirSync(path.resolve(__dirname,'../artifacts'),{recursive:true});await page.screenshot({path:path.resolve(__dirname,'../artifacts/node-map-'+width+'.png')});
 await page.locator('[data-close]').click();if(width<700)await page.locator('[data-action="mobile-left"]').click();
 const toolbar=page.locator('.player-tools'),box=await toolbar.boundingBox();a.ok(box.y+box.height<=900);await page.locator('[data-action="latest-map"]').click();await page.locator('.node-map-dialog').waitFor();
 a.match(await page.locator('.node-map-description').innerText(),/门厅/);
 a.doesNotMatch(await page.content(),/PRIVATE_MAP_NOTE|SECRET_CELLAR|SECRET_LOCATION/);a.deepEqual(errors,[]);
 // Export through the obfuscated release, not just the Node version of Presentation.
 const html=await page.evaluate(()=>GamePresentation.historyHTML(GameApp.getState().active));const archive=await page.context().newPage();const archiveErrors=[];archive.on('pageerror',e=>archiveErrors.push(e.message));await archive.setContent(html);await archive.locator('[data-mode="overview"]').click();await checkCanvas(archive);if(width<700)await archive.locator('label[for="archive-tab-items"]').click();await archive.locator('#latest-map').click();await archive.locator('.node-map-dialog').waitFor();a.deepEqual(archiveErrors,[]);
});
test('offline maps respect replay position, long press, scrolling cancellation and overview holds',async t=>{
 const page=await pageFor(t,390),errors=[];page.on('pageerror',e=>errors.push(e.message));const html=P.historyHTML({name:'离线地图',events:[{type:'story',round:1,content:'起点'},{type:'map',round:2,map:snapshot},{type:'map',round:3,map:{...snapshot,currentId:'hall'}}]});
 await page.setContent(html);a.equal(await page.locator('#archive-player-tools').isHidden(),true);
 await page.locator('#replay-next').click();await checkCanvas(page);a.equal(await page.locator('#archive-player-tools').getAttribute('hidden'),null);
 const card=page.locator('.node-map-card').first();await card.scrollIntoViewIfNeeded();const box=await card.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+80);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+110);await page.waitForTimeout(3100);await page.mouse.up();a.equal(await page.locator('.node-map-dialog').count(),0);
 await page.mouse.move(box.x+box.width/2,box.y+80);await page.mouse.down();await page.waitForTimeout(3100);await page.mouse.up();await page.locator('.node-map-dialog').waitFor();a.match(await page.locator('.node-map-description').innerText(),/庭院/);await page.locator('[data-close]').click();
 a.equal(await page.locator('#replay-jump').inputValue(),'2','long press does not advance replay');
 await page.locator('[data-mode="overview"]').click();await card.click();a.equal(await page.locator('.node-map-dialog').count(),0);await card.click({delay:3050});await page.locator('.node-map-dialog').waitFor();await page.locator('[data-close]').click();
 await page.locator('label[for="archive-tab-items"]').click();await page.locator('#latest-map').click();a.match(await page.locator('.node-map-description').innerText(),/门厅/);
 a.doesNotMatch(html,/PRIVATE_MAP_NOTE|SECRET_CELLAR|SECRET_LOCATION/);a.deepEqual(errors,[]);
});
for(const role of ['player','none','all','pc'])test(role+' client receives maps and the latest-map shortcut',async t=>{
 const tree=V.createTree();V.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"当前位置":"hall"}');V.writeFile(tree,'/workspace/Player-pc/背包.json','[]');const save=Core.createSave('联机地图',tree);save.events=[{id:'map',type:'map',round:1,audience:'public',map:snapshot}];save.status='waiting';
 const room={roomId:'map-room',epoch:0,roundId:'r',status:'collecting',members:{guest:{actorId:'pc',bindingVersion:1,connected:true}}},projector=Sync.createHost({getSave:()=>save,getRoom:()=>room});
 if(role!=='player')room.members.guest={actorId:null,role:'spectator',permission:role,perspective:role,bindingVersion:1,connected:true};
 const page=await pageFor(t,1280),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.exposeFunction('mapServer',async(id,p)=>{if(p.type==='sync.request')await page.evaluate(packet=>GameApp.receive(packet),await projector.sync(id,p.payload));});await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();await page.evaluate(()=>GameApp.connect({onClient:()=>()=>{},sendToHost:(id,p)=>window.mapServer(id,p)},'guest'));
 await page.locator('.node-map-card').waitFor();await checkCanvas(page);await page.locator('[data-action="latest-map"]').click();await page.locator('.node-map-dialog').waitFor();
 a.match(await page.locator('.node-map-description').innerText(),role==='player'||role==='pc'?/门厅/:/庭院/);await page.locator('[data-close]').click();
 await page.locator('.node-map-card').click();a.match(await page.locator('.node-map-description').innerText(),/庭院/);await page.locator('[data-close]').click();
 if(role==='player'||role==='pc'){
   V.writeFile(save.tree,'/workspace/Player-pc/基础信息.json','{"当前位置":"yard"}');await page.evaluate(()=>GameApp.sync());
   await page.locator('[data-action="latest-map"]').click();a.match(await page.locator('.node-map-description').innerText(),/庭院/);await page.locator('[data-close]').click();
   V.writeFile(save.tree,'/workspace/Player-pc/基础信息.json','{"当前位置":"hall"}');await page.evaluate(packet=>GameApp.receive(packet),await projector.sync('guest'));
   await page.locator('[data-action="latest-map"]').click();a.match(await page.locator('.node-map-description').innerText(),/门厅/);await page.locator('[data-close]').click();
   V.writeFile(save.tree,'/workspace/Player-pc/基础信息.json','{"当前位置":"SECRET_LOCATION"}');await page.evaluate(()=>GameApp.sync());
   await page.locator('[data-action="latest-map"]').click();a.match(await page.locator('.node-map-description').innerText(),/庭院/);
   a.doesNotMatch(await page.evaluate(()=>JSON.stringify(GameApp.exportView())),/SECRET_LOCATION|当前位置/);
 }
 a.deepEqual(errors,[]);
});
test('touch scrolling cancels map long press; stationary hold opens only after three seconds',async t=>{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});t.after(()=>context.close());const page=await context.newPage();
 await page.setContent(P.historyHTML({name:'触摸地图',events:[{type:'map',round:1,map:snapshot},{type:'story',round:2,content:'下一步'}]}));await page.clock.install();await page.clock.pauseAt(new Date());
 const card=page.locator('.node-map-card'),cdp=await context.newCDPSession(page),box=await card.boundingBox(),point={x:Math.round(box.x+30),y:Math.round(box.y+60)};
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await page.clock.runFor(2999);a.equal(await page.locator('.node-map-dialog').count(),0);await page.clock.runFor(1);a.equal(await page.locator('.node-map-dialog').count(),1);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.keyboard.press('Escape');a.equal(await page.locator('.node-map-dialog[open]').count(),0);await page.clock.runFor(20);
 await card.evaluate(n=>n.style.height='1100px');await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y+100}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y-30}]});await page.clock.runFor(4000);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 a.equal(await page.locator('.node-map-dialog').count(),0);a.ok(await page.locator('#archive-history').evaluate(n=>n.scrollTop)>0);a.equal(await page.locator('#replay-jump').inputValue(),'1');
});
