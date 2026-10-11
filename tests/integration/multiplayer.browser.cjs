'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
let server,browser,origin;
before(async()=>{
  const dist=path.resolve(__dirname,'../../dist');
  server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+req.url.split('?')[0]);if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(error,bytes)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(bytes);});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});

const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
async function pageFor(t){const context=await browser.newContext({viewport:{width:1440,height:960}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(10000);return page;}
async function connectBridge(host,clients){
  await host.exposeFunction('deliverMultiplayerClient',async(memberId,packet)=>{const page=clients[memberId];if(page)await page.evaluate(packet=>window.testClientReceiver?.(packet),packet);});
  await host.evaluate(()=>GameApp.attachMultiplayerTransport({onHost(fn){window.testHostReceiver=fn;return ()=>{window.testHostReceiver=null;};},sendToClient:(id,packet)=>window.deliverMultiplayerClient(id,packet)}));
  for(const [memberId,page]of Object.entries(clients)){
    await page.exposeFunction('deliverMultiplayerHost',(id,packet)=>host.evaluate(({id,packet})=>window.testHostReceiver(id,packet),{id,packet}));
    await page.evaluate(memberId=>GameApp.connect({onClient(id,fn){window.testClientReceiver=fn;return ()=>{window.testClientReceiver=null;};},sendToHost:(id,packet)=>window.deliverMultiplayerHost(id,packet)},memberId),memberId);
    await page.waitForFunction(()=>GameApp.getState().active!==null);
  }
}
async function panelSnapshot(page,selector){return page.locator(selector).evaluateAll(elements=>elements.map(element=>{
  const box=element.getBoundingClientRect(),style=getComputedStyle(element);
  return {text:element.textContent.trim(),width:Math.round(box.width),font:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,color:style.color,padding:style.padding,children:[...element.children].map(child=>{const b=child.getBoundingClientRect(),s=getComputedStyle(child);return {tag:child.tagName,class:child.className,width:Math.round(b.width),fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color};})};
}));}

test('host and isolated clients use authoritative rounds, private projections, rollback voting and matching shared panels',async t=>{
  const host=await pageFor(t),own=await pageFor(t),guest=await pageFor(t),errors=[],sockets=[];let modelRequests=0;
  for(const page of [host,own,guest]){page.on('pageerror',error=>errors.push(error.message));page.on('websocket',socket=>sockets.push(socket.url()));}
  await host.route('https://**/*',async route=>{
    if(!route.request().url().startsWith('https://multiplayer.invalid/'))return route.abort();modelRequests++;
    const opening=modelRequests===1;
    assert.ok(modelRequests<=2,'a collected multiplayer round calls the model once');
    const calls=opening?[call('append_story',{content:'雨停以后，两位旅人来到同一座车站。',one_line_summary_of_content:'二人抵达车站'},'opening'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'上午九点'}},'opening-end')]:[
      call('trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}},'trigger'),
      call('private_append_story',{entries:[{id:'a',story:'只给甲的密语：月亮藏在井底。'},{id:'b',story:'只给乙的密语：钥匙藏在钟楼。'}]},'private'),
      call('append_story',{content:'站长打开候车室的大门，请两人进去避雨。',one_line_summary_of_content:'站长打开候车室'},'public'),
      call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'上午九点十分'}},'end')];
    await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{role:'assistant',content:'房主内部草稿不可同步',tool_calls:calls},finish_reason:'tool_calls'}]})});
  });
  for(const page of [own,guest])await page.route('https://**/*',route=>route.abort());
  await host.goto(origin+'/index.html');await host.locator('[data-action="import"]').waitFor();
  await host.evaluate(async()=>{
    await GameApp.updateSettings({baseUrl:'https://multiplayer.invalid/v1',apiKey:'test-only',stream:false});
    const files=['a','b'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id==='a'?'甲':'乙',职业:'旅人',Alive:true,Enabled:true,'.秘密':'隐藏卡片-'+id})},{name:`Player-${id}/背包.json`,text:id==='a'?'["key"]':'[]'}]);
    files.push({name:'KPC-guide/基础信息.json',text:'{"姓名":"站长"}'},{name:'KPC-guide/背包.json',text:'[]'},
      {name:'存档-索引-物品/key/物品基础信息.json',text:'{"名称":"铜钥匙","余量":1,"位置所属":"Player-a",".秘密":"隐藏物品"}'},
      {name:'模组.md',text:'两名玩家在车站相遇。'});
    await GameApp.importSave(new File([ZIP.makeZip(files)],'多人回归.zip'));await GameApp.configureSlots('a');
  });
  const initial=await host.evaluate(()=>({room:GameApp.multiplayerState(),slots:GameApp.getState().active.slots}));
  assert.equal(initial.room.online,false);assert.equal(initial.room.roomId,null);assert.equal(initial.slots.find(x=>x.id==='b').kind,'disabled');assert.ok(!initial.slots.some(x=>x.id==='guide'));assert.deepEqual(sockets,[]);
  await host.evaluate(async()=>{await GameApp.openRoom();await GameApp.addMember('guest');await GameApp.start();});
  await host.waitForFunction(()=>GameApp.getState().active.round===1&&GameApp.multiplayerState().status==='collecting').catch(async error=>{error.message+='\n'+JSON.stringify(await host.evaluate(()=>({room:GameApp.multiplayerState(),status:GameApp.getState().active.status,error:GameApp.getState().error,events:GameApp.getState().active.events.slice(-4)})));throw new Error(error.message);});
  await own.goto(origin+'/client.html');await guest.goto(origin+'/client.html');
  for(const page of [own,guest])assert.deepEqual(await page.evaluate(()=>[typeof GameCore,typeof GameTransport,typeof VFS]),['undefined','undefined','undefined']);
  await connectBridge(host,{host:own,guest});
  const lobby=await guest.evaluate(()=>GameApp.getState().active);assert.equal(lobby.actorId,null);assert.deepEqual(lobby.events,[]);assert.deepEqual(lobby.info,{});assert.deepEqual(lobby.items,[]);
  await guest.evaluate(()=>GameApp.roomCommand('slot.claim.request',{actorId:'b'}));
  await host.waitForFunction(()=>GameApp.multiplayerState().slotRequests.length===1);
  if(await host.locator('[data-action="close-modal"]').count())await host.locator('[data-action="close-modal"]').click();
  await host.locator('[data-action="room-panel"]').click();await host.locator('[data-action="slot-decide"][data-decision="approve"]').click();
  await guest.waitForFunction(()=>GameApp.getState().active.actorId==='b');
  for(const page of [host,guest])if(await page.locator('[data-action="close-modal"]').count())await page.locator('[data-action="close-modal"]').click();
  await guest.waitForFunction(()=>document.querySelector('#action-input')?.disabled===false&&document.querySelector('.character')?.textContent.includes('乙'));
  await host.evaluate(()=>GameApp.send('','甲只向主持人提交的秘密行动'));
  assert.equal(modelRequests,1);assert.equal(await host.evaluate(()=>GameApp.multiplayerState().status),'collecting');
  await guest.locator('#action-input').fill('乙检查门锁');await guest.locator('#action-form button[type="submit"]').click();
  await host.waitForFunction(()=>GameApp.getState().active.round===2&&GameApp.multiplayerState().status==='collecting').catch(async error=>{throw Error(error.message+' '+JSON.stringify({host:await host.evaluate(()=>({room:GameApp.multiplayerState(),error:GameApp.getState().error})),guest:await guest.evaluate(()=>({room:GameApp.getState().room,draft:GameApp.getState().active.draft,error:GameApp.getState().error,dialogs:document.getElementById('dialog-root').innerText,toast:document.getElementById('toast').innerText,input:document.getElementById('action-input').value})),errors}));});
  await own.evaluate(()=>GameApp.sync());
  await guest.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('只给乙的密语')).catch(async error=>{throw new Error(error.message+'\n'+JSON.stringify({host:await host.evaluate(()=>({room:GameApp.multiplayerState().status,round:GameApp.getState().active.round})),client:await guest.evaluate(()=>({room:GameApp.getState().room,round:GameApp.getState().active?.round,events:GameApp.getState().active?.events.map(e=>({type:e.type,content:e.content}))})),errors}));});
  await own.waitForFunction(()=>document.querySelector('#history')?.textContent.includes('只给甲的密语'));
  assert.equal(modelRequests,2);
  const guestText=await guest.locator('body').innerText(),ownText=await own.locator('body').innerText();
  assert.ok(!guestText.includes('只给甲的密语'));assert.ok(!ownText.includes('只给乙的密语'));
  const guestState=await guest.evaluate(()=>JSON.stringify({state:GameApp.getState(),storage:{...localStorage}}));assert.ok(!guestState.includes('只给甲的密语'));assert.ok(!guestState.includes('甲只向主持人提交的秘密行动'));
  assert.deepEqual(await guest.evaluate(()=>GameApp.getState().active.events.filter(e=>e.type==='player').map(e=>e.actorId)),['b'],'a private-only action leaves no empty bubble or existence marker for another player');
  for(const text of [guestText,ownText])for(const secret of ['房主内部草稿','隐藏卡片','隐藏物品','位置所属'])assert.ok(!text.includes(secret),secret);
  for(const width of [1440,390]){
    await host.setViewportSize({width,height:960});await own.setViewportSize({width,height:960});
    for(const selector of ['.inventory','.character','#history .story','#action-input']){
      const h=await panelSnapshot(host,selector),c=await panelSnapshot(own,selector);assert.deepEqual(c,h,`${selector} matches at ${width}px`);
    }
  }
  const baseline=await panelSnapshot(own,'.inventory');await own.addStyleTag({content:'.inventory{font-size:31px!important}'});assert.notDeepEqual(await panelSnapshot(own,'.inventory'),baseline,'the comparison detects one-sided CSS drift');
  const target=await host.evaluate(()=>{const s=GameApp.getState().active.snapshots.at(-1);return {targetRound:s.round,targetRoundId:s.inputRoundId};});
  await guest.evaluate(payload=>GameApp.roomCommand('rollback.request',payload),target);
  const voteId=await host.evaluate(()=>GameApp.multiplayerState().vote.id);await host.evaluate(voteId=>GameApp.roomCommand('rollback.decide',{voteId,decision:'vote'}),voteId);
  assert.equal(await host.evaluate(()=>Object.keys(GameApp.multiplayerState().vote.votes).length),0);
  await guest.evaluate(voteId=>GameApp.roomCommand('rollback.vote',{voteId,approve:true}),voteId);
  await host.waitForFunction(()=>GameApp.getState().active.round===1&&GameApp.multiplayerState().vote===null);
  await guest.waitForFunction(()=>!document.querySelector('#history')?.textContent.includes('只给乙的密语'));
  assert.deepEqual(await host.evaluate(()=>({draft:GameApp.getState().active.draft,privateDraft:GameApp.getState().active.privateDraft})),{draft:'',privateDraft:'甲只向主持人提交的秘密行动'});
  assert.deepEqual(await guest.evaluate(()=>({draft:GameApp.getState().active.draft,privateDraft:GameApp.getState().active.privateDraft})),{draft:'乙检查门锁',privateDraft:''});
  await host.evaluate(()=>GameApp.closeRoom());await guest.waitForFunction(()=>GameApp.getState().room?.online===false);
  await guest.waitForFunction(()=>/关闭|离线/.test(document.body.innerText));
  assert.match(await guest.locator('body').innerText(),/关闭|离线/);
  assert.equal(await guest.locator('#action-form button[type="submit"]').isDisabled(),true);
  const originalInputs=await host.evaluate(()=>{const s=GameApp.getState().active;return {draft:s.draft,privateDraft:s.privateDraft,inputHistory:s.inputHistory};});
  assert.equal(originalInputs.privateDraft,'甲只向主持人提交的秘密行动');assert.ok(originalInputs.inputHistory.length>0);
  await assert.rejects(host.evaluate(()=>GameApp.configureSlots('b')),/房主|槽位|角色/);
  assert.equal(await host.evaluate(()=>GameApp.getState().active.actorId),'a');
  assert.deepEqual(await host.evaluate(()=>{const s=GameApp.getState().active;return {draft:s.draft,privateDraft:s.privateDraft,inputHistory:s.inputHistory};}),originalInputs);
  assert.equal(modelRequests,2);assert.deepEqual(sockets,[]);assert.deepEqual(errors,[]);
});
