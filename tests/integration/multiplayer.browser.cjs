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

test('initial slot selection previews choices and commits only after confirmation',async t=>{
  const page=await pageFor(t),sockets=[];page.on('websocket',socket=>sockets.push(socket.url()));
  await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async()=>{
    const files=['a','b','c'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id})},{name:`Player-${id}/背包.json`,text:'[]'}]);
    await GameApp.importSave(new File([ZIP.makeZip(files)],'选角确认.zip'));
  });
  const modal=page.getByRole('dialog',{name:'选择角色槽位'});
  await modal.waitFor();assert.equal(await modal.locator('select').count(),0);
  assert.equal(await modal.locator('[data-action="slot-confirm"]').isDisabled(),true);
  await modal.locator('[data-action="slot-choose"][data-actor="a"]').click();
  assert.equal(await modal.locator('select').count(),2);assert.equal(await modal.locator('#slot-mode-a').count(),0);
  assert.equal(await page.evaluate(()=>GameApp.getState().active.slotsConfigured),false);
  assert.equal(await modal.locator('#slot-mode-c option[value="ai"]').innerText(),'设为NPC');
  await modal.locator('#slot-mode-c').selectOption('ai');
  await modal.locator('[data-action="slot-choose"][data-actor="b"]').click();
  assert.equal(await modal.locator('#slot-mode-b').count(),0);assert.equal(await modal.locator('#slot-mode-a').count(),1);
  assert.equal(await modal.locator('#slot-mode-c').inputValue(),'ai');
  assert.equal(await page.evaluate(()=>GameApp.getState().active.actorId),'a');
  const rightAligned=()=>modal.locator('[data-slot="c"]').evaluate(card=>{const row=card.querySelector('.slot-controls').getBoundingClientRect(),select=card.querySelector('.slot-mode-control').getBoundingClientRect();return Math.abs(row.right-select.right)<2;});
  assert.ok(await rightAligned());
  await page.setViewportSize({width:390,height:844});assert.ok(await rightAligned());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.keyboard.press('Escape');assert.equal(await modal.count(),1);
  fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});await page.screenshot({path:'tests/artifacts/slot-selection-390.png'});
  await modal.locator('[data-action="slot-confirm"]').click();await modal.waitFor({state:'hidden'});
  const configured=await page.evaluate(()=>({save:GameApp.getState().active,room:GameApp.multiplayerState()}));
  assert.equal(configured.save.slotsConfigured,true);assert.equal(configured.save.actorId,'b');
  assert.deepEqual(configured.save.slots.map(s=>[s.id,s.kind]).sort((a,b)=>a[0].localeCompare(b[0])),[['a','disabled'],['b','player'],['c','ai']]);
  assert.equal(configured.room.online,false);assert.deepEqual(sockets,[]);
});

test('mid-game invitations warn for invalid cards before connecting and allow acknowledgement or cancellation',async t=>{
  const page=await pageFor(t),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async()=>{
    const files=['a','b','c'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id})},{name:`Player-${id}/背包.json`,text:'[]'}]);
    await GameApp.importSave(new File([ZIP.makeZip(files)],'中途邀请.zip'));await GameApp.configureSlots('a');
    window.__connections=0;
    BridgeTransport.createHost=async options=>{__connections++;return {transport:{onHost:()=>()=>{},sendToClient:async()=>{}},invite:async memberId=>({version:1,url:options.url,roomId:options.roomId,memberId,token:'A'.repeat(43)+'.'+'A'.repeat(43)}),revoke:async()=>{},close(){}};};
  });
  const setRound=async round=>page.evaluate(async round=>{GameApp.getState().active.round=round;await GameApp.updateSettings({});},round);
  const openPanel=async()=>{await page.locator('[data-action="room-panel"]').click();};
  const apply=async(id,kind)=>{await page.locator('#slot-mode-'+id).selectOption(kind);await page.locator(`[data-action="slot-mode"][data-actor="${id}"]`).click();};
  await setRound(2);await openPanel();await apply('b','player');
  await page.waitForFunction(()=>GameApp.getState().network?.invites?.length===1);assert.equal(await page.locator('[role="alertdialog"]').count(),0);
  await apply('b','disabled');await page.locator('[data-action="close-room"]').click();
  await setRound(3);await apply('b','player');await page.locator('[role="alertdialog"]').waitFor();
  const message=await page.locator('#app-dialog-message').innerText();
  for(const text of ['该角色卡存在格式错误','新开游戏','车卡流程','调试模式','/workspace/DISABLE-b/基础信息.json','无法预料的错误'])assert.ok(message.includes(text),text);
  assert.equal(await page.locator('[data-dialog-value="confirm"]').innerText(),'我知道了');assert.equal(await page.evaluate(()=>__connections),1);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../artifacts/invitation-character-warning-390.png')});
  assert.equal(await page.evaluate(()=>GameApp.getState().active.slots.find(x=>x.id==='b').kind),'disabled');
  await page.locator('[data-dialog-value="cancel"]').click();assert.equal(await page.evaluate(()=>__connections),1);
  await apply('b','player');await page.locator('[data-dialog-value="confirm"]').click();
  await page.waitForFunction(()=>GameApp.getState().network?.invites?.length===1);assert.equal(await page.evaluate(()=>__connections),2);
  await apply('b','player');assert.equal(await page.locator('[role="alertdialog"]').count(),0);
  await page.locator('[data-action="close-modal"]').first().click();
  await page.evaluate(async()=>{VFS.writeFile(GameApp.getState().active.tree,'/workspace/DISABLE-c/基础信息.json','{broken');await GameApp.updateSettings({});});
  await openPanel();await apply('c','player');await page.locator('[role="alertdialog"]').waitFor();await page.locator('[data-dialog-value="cancel"]').click();
  const card={姓名:'丙',性别:'女',外貌:'短发',穿戴:{},性格:'谨慎',职业:'医生',身份:'调查员',说话习惯:'温和',原则:'救人','喜好/厌恶':'喜欢阅读',技能:{},属性:{},主动技能:[],状态:{HP:10,MAXHP:10,MP:5,MAXMP:5,Enabled:true,Alive:true},buff栏:[],当前位置:'车站'};
  await page.evaluate(async card=>{VFS.writeFile(GameApp.getState().active.tree,'/workspace/DISABLE-c/基础信息.json',JSON.stringify(card));await GameApp.updateSettings({});},card);
  await apply('c','player');await page.waitForFunction(()=>GameApp.getState().network?.invites?.length===2);assert.equal(await page.locator('[role="alertdialog"]').count(),0);
  assert.deepEqual(errors,[]);
});

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
    const files=['a','b'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id==='a'?'甲':'乙',职业:'旅人',Alive:true,Enabled:true,'.秘密':'隐藏卡片-'+id})},{name:`Player-${id}/背包.json`,text:id==='a'?'["key","concealed"]':'[]'}]);
    files.push({name:'KPC-guide/基础信息.json',text:'{"姓名":"站长"}'},{name:'KPC-guide/背包.json',text:'[]'},
      {name:'存档-索引-物品/key/物品基础信息.json',text:'{"名称":"铜钥匙","可见性":"可见","余量":1,"位置所属":"Player-a",".秘密":"隐藏物品"}'},
      {name:'存档-索引-物品/concealed/物品基础信息.json',text:'{"名称":"BACKPACK_PRIVATE_MARKER","可见性":"Hide","信息":"INVENTORY_SECRET_DETAIL"}'},
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
  if(await host.locator('[data-action="close-modal"]').count())await host.locator('[data-action="close-modal"]').first().click();
  await host.locator('[data-action="room-panel"]').click();await host.locator('[data-action="slot-decide"][data-decision="approve"]').click();
  await guest.waitForFunction(()=>GameApp.getState().active.actorId==='b');
  for(const page of [host,guest])if(await page.locator('[data-action="close-modal"]').count())await page.locator('[data-action="close-modal"]').first().click();
  await guest.waitForFunction(()=>document.querySelector('#action-input')?.disabled===false&&document.querySelector('.character')?.textContent.includes('乙'));
  await host.locator('[data-action="room-panel"]').click();
  await host.locator('[data-slot="b"] [data-presence="online"]').waitFor();
  await host.evaluate(()=>GameApp.setMemberConnected('guest',false));
  await host.locator('[data-slot="b"] [data-presence="offline"]').waitFor();
  await host.evaluate(()=>GameApp.setMemberConnected('guest',true));
  await host.locator('[data-slot="b"] [data-presence="online"]').waitFor();
  await host.locator('[data-action="close-modal"]').first().click();
  assert.equal(await guest.locator('#action-private-input').count(),0);
  await guest.locator('#hidden-send-toggle').check();
  assert.equal(await guest.locator('#action-private-input').count(),0);
  await guest.locator('#action-input').fill('乙暗中藏起钥匙');
  await guest.locator('#disguise-send-toggle').check();
  await guest.locator('#action-private-input').fill('乙说自己在等车');
  await guest.locator('#action-form button[type="submit"]').click();
  await host.waitForFunction(()=>GameApp.multiplayerState().submissions.b?.privateContent==='乙暗中藏起钥匙');
  assert.equal(await host.evaluate(()=>GameApp.multiplayerState().submissions.b.content),'乙说自己在等车');
  assert.equal(await host.evaluate(()=>GameApp.multiplayerState().submissions.b.disguise),true);
  await guest.locator('[data-action="cancel-action"]').click();
  await guest.waitForFunction(()=>document.querySelector('#action-input')?.value==='乙暗中藏起钥匙');
  assert.equal(await guest.locator('#hidden-send-toggle').isChecked(),true);
  assert.equal(await guest.locator('#disguise-send-toggle').isChecked(),true);
  assert.equal(await guest.locator('#action-private-input').inputValue(),'乙说自己在等车');
  await guest.locator('#hidden-send-toggle').uncheck();
  assert.equal(await guest.locator('#action-private-input').count(),0);
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
    for(const selector of ['.inventory','.character','#history .story','#action-input','.home-navigation']){
      const h=await panelSnapshot(host,selector),c=await panelSnapshot(own,selector);assert.deepEqual(c,h,`${selector} matches at ${width}px`);
    }
  }
  for(const page of [host,own]){
    assert.equal(await page.locator('[data-action="input-history"]').count(),0);
    await page.locator('[data-action="room-panel"]').click();
    assert.equal(await page.locator('.slot-card').count(),await page.evaluate(()=>GameApp.getState().active.slots.length));
    assert.equal(await page.locator('.slot-card [data-action="player-profile"]').count(),2);
    assert.equal(await page.locator('.slot-card [data-action="player-inventory"]').count(),2);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'tests/artifacts/slot-cards-'+(page===host?'host':'client')+'-390.png'});
    await page.locator('[data-action="player-inventory"][data-actor="a"]').click();
    await page.locator('.player-inventory').waitFor();
    const text=await page.locator('.player-inventory').innerText();
    assert.ok(text.includes('铜钥匙'));
    for(const secret of ['BACKPACK_PRIVATE_MARKER','INVENTORY_SECRET_DETAIL','隐藏物品','位置所属'])assert.ok(!text.includes(secret),secret);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'tests/artifacts/shared-inventory-'+(page===host?'host':'client')+'-390.png'});
    await page.locator('[data-action="close-modal"]').first().click();
  }
  await guest.locator('[data-action="room-panel"]').click();
  await guest.locator('[data-action="player-profile"][data-actor="a"]').click();await guest.locator('.player-profile').waitFor();
  await guest.getByRole('button',{name:'返回房间',exact:true}).click();
  await guest.locator('[data-action="player-inventory"][data-actor="a"]').click();await guest.locator('.player-inventory').waitFor();
  assert.ok((await guest.locator('.player-inventory').innerText()).includes('铜钥匙'));
  const sharedState=await guest.evaluate(()=>JSON.stringify({state:GameApp.getState(),storage:{...localStorage},body:document.body.innerText}));
  for(const secret of ['BACKPACK_PRIVATE_MARKER','INVENTORY_SECRET_DETAIL','隐藏物品','位置所属'])assert.ok(!sharedState.includes(secret),secret);
  await guest.getByRole('button',{name:'返回房间',exact:true}).click();
  await guest.waitForTimeout(300);
  await guest.locator('[data-action="player-inventory"][data-actor="b"]').click();await guest.locator('.player-inventory').waitFor();
  assert.match(await guest.locator('.player-inventory').innerText(),/暂无可公开的物品/);
  await guest.locator('[data-action="close-modal"]').first().click();
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
  await own.locator('.home-button').click();await own.locator('#join-room-form').waitFor();
  await guest.locator('.brand-home').click();await guest.locator('#join-room-form').waitFor();
  assert.equal(modelRequests,2);assert.deepEqual(sockets,[]);assert.deepEqual(errors,[]);
});
