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

test('round-one room slots stay configurable and lock from round two with shared host and client UI',async t=>{
 const page=await pageFor(t),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://slot-control.invalid/**',async route=>{requests.push(route.request().postDataJSON());await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'',tool_calls:[...requests.length>1?[call('trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}},'trigger')]:[],call('append_story',{content:'测试开局正文。',one_line_summary_of_content:'开局'},'story'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end')]}}]})});});
 await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{await GameApp.updateSettings({apiKey:'test',baseUrl:'https://slot-control.invalid/v1',stream:false});const files=['Player-a','Player-b','Player-c','KPC-guide'].flatMap(name=>[{name:name+'/基础信息.json',text:JSON.stringify({姓名:name})},{name:name+'/背包.json',text:'[]'}]);await GameApp.importSave(new File([ZIP.makeZip(files)],'槽位控制.zip'));await GameApp.configureSlots('a',{b:'ai'});});
 await page.locator('[data-action="room-panel"]').click();await page.locator('[data-npc-key="slot:b"]').fill('b 是外科医生');
 await page.locator('[data-action="save-room"]').click();await page.waitForFunction(()=>GameApp.getState().active.npcCardInstructions['slot:b']==='b 是外科医生');
 await page.locator('[data-action="close-modal"]').first().click();await page.locator('[data-action="start"]').click();await page.waitForFunction(()=>GameApp.getState().active.round===1);
 assert.equal(requests.length,1);assert.equal(requests[0].messages.filter(m=>m.role==='system').length,1);assert.ok(requests[0].messages.some(m=>m.role==='user'&&m.content.includes('外科医生')));
 assert.ok(!(await page.locator('#history').innerText()).includes('角色控制·内部指令'));
 assert.ok(!await page.evaluate(()=>JSON.stringify(GameApp.currentContext()).includes('外科医生')));
 await page.locator('[data-action="room-panel"]').click();
 assert.equal(await page.locator('[data-npc-key]').count(),0);
 await assert.rejects(page.evaluate(()=>GameApp.configureNPCCards('slot:b','游戏后修改')),/开始故事前/);
 assert.deepEqual(await page.locator('#slot-mode-b option').evaluateAll(nodes=>nodes.map(n=>n.value)),['disabled','ai','player']);
 await page.locator('#slot-mode-c').selectOption('ai');await page.locator('[data-action="save-room"]').click();
 assert.equal(await page.evaluate(()=>GameApp.getState().active.slots.find(s=>s.id==='c').kind),'ai');
 await page.locator('#slot-mode-c').selectOption('disabled');await page.locator('[data-action="save-room"]').click();
 await page.locator('#slot-mode-b').selectOption('player');await page.locator('[data-action="save-room"]').click();assert.equal(await page.evaluate(()=>GameApp.getState().network),null);
 await page.locator('#slot-mode-b').selectOption('ai');await page.locator('[data-action="save-room"]').click();
 await page.locator('[data-action="close-modal"]').first().click();await page.evaluate(()=>GameApp.send('进入第二回合'));
 await page.waitForFunction(()=>GameApp.getState().active.round===2);await page.locator('[data-action="room-panel"]').click();
 const disabled=page.locator('[data-slot="c"]');assert.equal(await disabled.locator('select,button').count(),0);assert.match(await disabled.innerText(),/第二回合开始前/);
 assert.deepEqual(await page.locator('#slot-mode-b option').evaluateAll(nodes=>nodes.map(n=>n.value)),['ai','player']);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'tests/artifacts/locked-slots-390.png'});
 await page.locator('[data-action="close-modal"]').first().click();await page.locator('[data-action="settings"]').click();
 const advanced=page.locator('[data-settings-section="advanced"]');assert.equal(await advanced.locator('input[name="bridgeUrl"]').count(),1);assert.match(await advanced.innerText(),/高级选项/);await advanced.locator('summary').click();assert.match(await advanced.innerText(),/多人游戏中转服务器地址/);
 assert.equal(await page.locator('[data-settings-section="game"] input[name="bridgeUrl"]').count(),0);
 const guest=await pageFor(t);guest.on('pageerror',e=>errors.push(e.message));await guest.goto(origin+'/client.html');await guest.locator('#join-room-form').waitFor();await guest.locator('[data-action="settings"]').click();await guest.locator('.settings-section summary').click();await guest.locator('[name="bridgeUrl"]').fill('wss://relay.example.com:8443/');await guest.locator('#settings-form button[type="submit"]').click();assert.equal(await guest.evaluate(()=>GameApp.getState().settings.bridgeUrl),'wss://relay.example.com:8443/');
 assert.deepEqual(errors,[]);
});
async function pageFor(t){const context=await browser.newContext({viewport:{width:1440,height:960}});t.after(()=>context.close());const page=await context.newPage();await page.route('**/modules.json',route=>route.fulfill({json:[]}));await page.route('**/files/**',route=>route.abort());page.setDefaultTimeout(10000);return page;}

test('room cards sort by actual IDs, keep order across role changes and show matching host/client role badges',async t=>{
 const host=await pageFor(t),guest=await pageFor(t),errors=[];
 for(const page of [host,guest])page.on('pageerror',e=>errors.push(e.message));
 await host.goto(origin+'/index.html');await host.locator('[data-action="import"]').waitFor();
 await host.evaluate(async()=>{
   await GameApp.updateSettings({apiKey:'test'});
   const files=['Player-pc','DISABLE-p3','Player-p10','AIPC-p2','KPC-p1'].flatMap(name=>[{name:name+'/基础信息.json',text:JSON.stringify({姓名:name})},{name:name+'/背包.json',text:'[]'}]);
   await GameApp.importSave(new File([ZIP.makeZip(files)],'排序测试.zip'));
 });
 const ids=page=>page.locator('.room-modal .slot-card').evaluateAll(cards=>cards.map(card=>card.dataset.slot||card.dataset.kpc));
 await host.locator('.room-modal .slot-card').first().waitFor();
 assert.deepEqual(await ids(host),['pc','p1','p2','p3','p10']);
 assert.doesNotMatch(await host.locator('.slot-card-heading').allTextContents().then(values=>values.join(' ')),/Player-|AIPC-|DISABLE-|KPC-/);
 await host.locator('[data-action="slot-choose"][data-actor="pc"]').click();await host.locator('[data-action="slot-confirm"]').click();
 await host.locator('[data-action="room-panel"]').click();assert.deepEqual(await ids(host),['pc','p1','p2','p3','p10']);
 assert.equal(await host.locator('[data-slot="pc"] .slot-kind').innerText(),'房主');
 assert.equal(await host.locator('[data-slot="p2"] .slot-kind').innerText(),'NPC');
 await host.locator('#slot-mode-p3').selectOption('player');await host.locator('[data-action="save-room"]').click();
 assert.deepEqual(await ids(host),['pc','p1','p2','p3','p10']);assert.equal(await host.locator('[data-slot="p3"] .slot-kind').innerText(),'玩家');
 await host.locator('#slot-mode-p2').selectOption('player');await host.locator('[data-action="save-room"]').click();assert.deepEqual(await ids(host),['pc','p1','p2','p3','p10']);
 await guest.goto(origin+'/client.html');await guest.locator('#join-room-form').waitFor();
 await guest.evaluate(async()=>{
   const s=GameApp.getState();s.room={online:true,status:'collecting',members:[{memberId:'host',actorId:'pc',connected:true},{memberId:'guest',actorId:'p2',connected:true}]};s.network={status:'connected'};
   s.active={id:'sort-client',name:'排序测试',actorId:'p2',round:0,status:'waiting',info:{姓名:'自己'},items:[],events:[],slots:[{id:'pc',name:'Player-pc',kind:'player'},{id:'p10',name:'DISABLE-p10',kind:'disabled'},{id:'p3',name:'林医生',kind:'ai'},{id:'p2',name:'Player-p2',kind:'player'}]};await GameApp.updateSettings({});
 });
 await guest.locator('[data-action="room-panel"]').click();assert.deepEqual(await ids(guest),['pc','p2','p3','p10']);
 assert.equal(await guest.locator('[data-slot="pc"] .slot-kind').innerText(),'房主');assert.equal(await guest.locator('[data-slot="p2"] .slot-kind').innerText(),'玩家');
 assert.equal(await guest.locator('[data-slot="p3"] h3').innerText(),'林医生');
 assert.equal(await guest.locator('[data-slot="p2"] h3').innerText(),'p2');
 const colors=await guest.locator('[data-slot="pc"] .slot-kind,[data-slot="p2"] .slot-kind,[data-slot="p3"] .slot-kind').evaluateAll(tags=>tags.map(tag=>getComputedStyle(tag).backgroundColor));assert.equal(new Set(colors).size,3);
 await guest.screenshot({path:'tests/artifacts/room-role-badges-desktop.png'});
 await guest.setViewportSize({width:390,height:844});assert.ok(await guest.locator('.slot-card-heading').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().right<=innerWidth)));
 await guest.screenshot({path:'tests/artifacts/room-role-badges-390.png'});
 assert.deepEqual(errors,[]);
});

test('connecting and disconnecting the server preserve the open room panel and its scroll position',async t=>{
 const page=await pageFor(t),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{
   const ids=['pc',...Array.from({length:8},(_,i)=>'p'+(i+1))],files=ids.flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id})},{name:`Player-${id}/背包.json`,text:'[]'}]);
   await GameApp.importSave(new File([ZIP.makeZip(files)],'滚动位置.zip'));await GameApp.configureSlots('pc',Object.fromEntries(ids.slice(1).map(id=>[id,'ai'])));
   await GameApp.configureInvitationSlot('p8','player');
   BridgeTransport.createHost=async options=>{
     await new Promise((resolve,reject)=>window.finishConnection=fail=>fail?reject(Error('测试连接失败')):resolve());
     return {transport:{onHost:()=>()=>{},sendToClient:async()=>{}},credentials:()=>options.credentials,close(){}};
   };
 });
 await page.locator('[data-action="room-panel"]').click();
 for(const fail of [false,true]){
   await page.locator('[data-action="connect-room"]').click();await page.waitForFunction(()=>typeof window.finishConnection==='function');
   const top=await page.locator('.room-modal .modal-body').evaluate(body=>{window.roomScrollBody=body;body.scrollTop=350;return body.scrollTop;});assert.ok(top>0);
   await page.evaluate(fail=>{const done=window.finishConnection;delete window.finishConnection;done(fail);},fail);
   await page.waitForFunction(fail=>GameApp.getState().network?.status===(fail?'disconnected':'connected'),fail);
   await page.locator(fail?'[data-action="connect-room"]:not([disabled])':'[data-action="close-room"]').waitFor();
   assert.equal(await page.evaluate(()=>document.querySelector('.room-modal .modal-body')===window.roomScrollBody),true,'updates reuse the scrolling container');
   assert.equal(await page.locator('.room-modal .modal-body').evaluate(body=>body.scrollTop),top);
   if(!fail){
     const before=await page.locator('[data-action="close-room"]').evaluate(button=>{const body=document.querySelector('.room-modal .modal-body');body.scrollTop=350;const top=body.scrollTop;button.click();return top;});
     await page.locator('[data-action="connect-room"]').waitFor();
     assert.equal(await page.evaluate(()=>document.querySelector('.room-modal .modal-body')===window.roomScrollBody),true);
     assert.equal(await page.locator('.room-modal .modal-body').evaluate(body=>body.scrollTop),before);
   }
 }
 await page.locator('[data-action="connect-room"]').click();await page.waitForFunction(()=>typeof window.finishConnection==='function');
 await page.locator('[data-action="close-modal"]').first().click();await page.evaluate(()=>window.finishConnection(false));
 await page.waitForFunction(()=>GameApp.getState().network?.status==='connected');
 assert.equal(await page.locator('.room-modal').count(),0,'finishing a connection does not reopen a dismissed room panel');
 assert.deepEqual(errors,[]);
});

test('unapplied room slot changes are visible and apply/discard/cancel guard closing and connecting',async t=>{
 const page=await pageFor(t),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{
   const files=['pc','p1','p2','p3'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id})},{name:`Player-${id}/背包.json`,text:'[]'}]);
   await GameApp.importSave(new File([ZIP.makeZip(files)],'未应用变更.zip'));await GameApp.configureSlots('pc',{p1:'ai',p2:'ai',p3:'ai'});
   window.connectionPlayers=[];BridgeTransport.createHost=async options=>{connectionPlayers.push(options.players.length);return {transport:{onHost:()=>()=>{},sendToClient:async()=>{}},credentials:()=>options.credentials,close(){}};};
 });
 await page.locator('[data-action="room-panel"]').click();
 await page.locator('#slot-mode-p1').selectOption('player');
 assert.match(await page.locator('[data-slot="p1"]').innerText(),/p1/);
 assert.equal(await page.evaluate(()=>GameApp.getState().openPlayerSlots.length),0);
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.locator('.has-pending-mode').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().right<=innerWidth)));
 await page.screenshot({path:'tests/artifacts/room-unapplied-390.png'});
 await page.locator('[data-action="connect-room"]').click();await page.locator('[role="alertdialog"]').waitFor();
 await page.screenshot({path:'tests/artifacts/room-unapplied-confirm-390.png'});
 assert.deepEqual(await page.locator('.app-dialog button').allTextContents(),['保存变更','丢弃变更','取消']);
 await page.locator('[data-dialog-value="cancel"]').click();assert.equal(await page.evaluate(()=>connectionPlayers.length),0);
 assert.equal(await page.locator('#slot-mode-p1').inputValue(),'player');
 await page.locator('#slot-mode-p2').selectOption('player');
 assert.equal(await page.locator('#slot-mode-p1').inputValue(),'player','applying another slot preserves outstanding edits');
 await page.locator('[data-action="close-modal"]').first().click();await page.locator('[data-dialog-value="cancel"]').click();assert.equal(await page.locator('.room-modal').count(),1);
 await page.keyboard.press('Escape');await page.locator('[data-dialog-value="apply"]').click();await page.waitForFunction(()=>!document.querySelector('.room-modal'));
 assert.deepEqual(await page.evaluate(()=>GameApp.getState().openPlayerSlots),['p1','p2']);
 await page.locator('[data-action="room-panel"]').click();assert.equal(await page.locator('.has-pending-mode').count(),0);
 await page.locator('#slot-mode-p3').selectOption('disabled');await page.locator('[data-action="close-modal"]').last().click();await page.locator('[data-dialog-value="discard"]').click();await page.waitForFunction(()=>!document.querySelector('.room-modal'));
 assert.equal(await page.evaluate(()=>GameApp.getState().active.slots.find(s=>s.id==='p3').kind),'ai');
 await page.locator('[data-action="room-panel"]').click();await page.locator('#slot-mode-p1').selectOption('ai');
 await page.locator('[data-action="connect-room"]').click();await page.locator('[data-dialog-value="apply"]').click();await page.locator('[data-action="close-room"]').waitFor();
 assert.deepEqual(await page.evaluate(()=>connectionPlayers),[1]);assert.equal(await page.locator('.has-pending-mode').count(),0);
 await page.locator('[data-action="close-room"]').click();await page.locator('#slot-mode-p3').selectOption('player');
 await page.locator('[data-action="connect-room"]').click();await page.locator('[data-dialog-value="discard"]').click();await page.locator('[data-action="close-room"]').waitFor();
 assert.deepEqual(await page.evaluate(()=>connectionPlayers),[1,1]);assert.equal(await page.locator('#slot-mode-p3').inputValue(),'ai');
 await page.locator('[data-action="close-room"]').click();
 await page.evaluate(()=>{const original=GameApp.configureInvitationSlot;GameApp.configureInvitationSlot=(id,kind)=>id==='p3'?Promise.reject(Error('测试应用失败')):original(id,kind);});
 await page.locator('#slot-mode-p1').selectOption('player');await page.locator('#slot-mode-p3').selectOption('player');
 await page.locator('[data-action="close-modal"]').first().click();await page.locator('[data-dialog-value="apply"]').click();
 await page.waitForFunction(()=>document.getElementById('toast')?.textContent.includes('测试应用失败'));
 assert.equal(await page.locator('.room-modal').count(),1,'an apply failure keeps the room window open');
 assert.equal(await page.locator('[data-slot="p1"] .has-pending-mode').count(),0);
 assert.equal(await page.locator('[data-slot="p3"] .has-pending-mode').count(),1,'failed and unapplied changes remain available for retry');
 assert.equal(await page.locator('#slot-mode-p3').inputValue(),'player');
 assert.deepEqual(errors,[]);
});

test('initial selection and room setup keep separate NPC drafts and start uses only final NPC roles',async t=>{
 const page=await pageFor(t),requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://npc-cards.invalid/**',async route=>{requests.push(route.request().postDataJSON());await route.fulfill({json:{choices:[{message:{content:'',tool_calls:[call('append_story',{content:'开场正文。',one_line_summary_of_content:'开场'},'npc-story'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'npc-end')]}}]}});});
 await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{await GameApp.updateSettings({apiKey:'test',baseUrl:'https://npc-cards.invalid/v1',stream:false});const files=['Player-a','Player-b','Player-c','KPC-guide'].flatMap(name=>[{name:name+'/基础信息.json',text:JSON.stringify({姓名:name})},{name:name+'/背包.json',text:'[]'}]);await GameApp.importSave(new File([ZIP.makeZip(files)],'独立NPC.zip'));});
 await page.locator('[data-action="slot-choose"][data-actor="a"]').click();
 await page.locator('#slot-mode-b').selectOption('ai');await page.locator('#slot-mode-c').selectOption('ai');
 await page.locator('[data-npc-key="slot:b"]').fill('B_PRIVATE_REQUIREMENT');
 await page.locator('[data-npc-key="slot:c"]').fill('C_PRIVATE_REQUIREMENT');
 await page.locator('[data-npc-key="kpc:guide"]').fill('GUIDE_PRIVATE_REQUIREMENT');
 await page.locator('#slot-mode-c').selectOption('disabled');assert.equal(await page.locator('[data-npc-key="slot:c"]').count(),0);
 await page.locator('#slot-mode-c').selectOption('ai');assert.equal(await page.locator('[data-npc-key="slot:c"]').inputValue(),'C_PRIVATE_REQUIREMENT');
 await page.locator('[data-action="slot-choose"][data-actor="b"]').click();assert.equal(await page.locator('[data-npc-key="slot:b"]').count(),0);
 await page.locator('[data-action="slot-confirm"]').click();await page.locator('[data-action="room-panel"]').click();
 assert.equal(await page.locator('[data-npc-key]').count(),2);assert.equal(await page.locator('[data-npc-key="slot:c"]').inputValue(),'C_PRIVATE_REQUIREMENT');
 await page.locator('#slot-mode-c').selectOption('disabled');await page.locator('[data-action="save-room"]').click();assert.equal(await page.locator('[data-npc-key="slot:c"]').count(),0);
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.locator('[data-npc-key]').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().right<=innerWidth)));
 await page.evaluate(()=>GameApp.start());await page.waitForFunction(()=>GameApp.getState().active.round===1);
 assert.equal(await page.locator('[data-npc-key]').count(),0,'starting while setup is open hides NPC inputs immediately');
 const instruction=requests[0].messages.find(m=>m.content?.includes('角色控制·内部指令'));
 assert.equal(instruction.role,'user');assert.match(instruction.content,/KPC-guide.*GUIDE_PRIVATE_REQUIREMENT/);assert.doesNotMatch(instruction.content,/B_PRIVATE_REQUIREMENT|C_PRIVATE_REQUIREMENT/);
 assert.equal(requests[0].messages.filter(m=>m.role==='system').length,1);assert.doesNotMatch(await page.locator('#history').innerText(),/PRIVATE_REQUIREMENT/);
 await page.locator('[data-action="close-modal"]').first().click();
 await page.locator('[data-action="room-panel"]').click();assert.equal(await page.locator('[data-npc-key]').count(),0);
 assert.deepEqual(errors,[]);
});
async function connectBridge(host,clients){
  await host.exposeFunction('deliverMultiplayerClient',async(memberId,packet)=>{const page=clients[memberId];if(page)await page.evaluate(packet=>window.testClientReceiver?.(packet),packet);});
  await host.evaluate(()=>GameApp.attachMultiplayerTransport({onHost(fn){window.testHostReceiver=fn;return ()=>{window.testHostReceiver=null;};},sendToClient:(id,packet)=>window.deliverMultiplayerClient(id,packet)}));
  await host.evaluate(()=>{GameApp.getState().network={status:'connected'};GameApp.setMode('play');});
  for(const [memberId,page]of Object.entries(clients)){
    await page.exposeFunction('deliverMultiplayerHost',(id,packet)=>host.evaluate(({id,packet})=>window.testHostReceiver(id,packet),{id,packet}));
    await page.evaluate(memberId=>GameApp.connect({onClient(id,fn){window.testClientReceiver=fn;return ()=>{window.testClientReceiver=null;};},sendToHost:(id,packet)=>window.deliverMultiplayerHost(id,packet)},memberId),memberId);
    await page.evaluate(()=>{GameApp.getState().network={status:'connected'};return GameApp.sync();});
    await page.waitForFunction(()=>GameApp.getState().active!==null);
  }
}
async function panelSnapshot(page,selector){return page.locator(selector).evaluateAll(elements=>elements.map(element=>{
  const box=element.getBoundingClientRect(),style=getComputedStyle(element);
  return {text:element.textContent.trim(),width:Math.round(box.width),font:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,color:style.color,padding:style.padding,children:[...element.children].map(child=>{const b=child.getBoundingClientRect(),s=getComputedStyle(child);return {tag:child.tagName,class:child.className,width:Math.round(b.width),fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color};})};
}));}

test('mobile game headers keep controls on one row and mode choices remain accessible in a compact menu',async t=>{
  const host=await pageFor(t),guest=await pageFor(t),errors=[];
  for(const page of [host,guest])page.on('pageerror',error=>errors.push(error.message));
  await host.goto(origin+'/index.html');await host.locator('[data-action="import"]').waitFor();
  await host.evaluate(async()=>{
    await GameApp.updateSettings({apiKey:'test'});
    const files=['a','b'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id})},{name:`Player-${id}/背包.json`,text:'[]'}]);
    await GameApp.importSave(new File([ZIP.makeZip(files)],'顶部布局测试存档名称很长.zip'));await GameApp.configureSlots('a');
  });
  await guest.goto(origin+'/client.html');await guest.locator('#join-room-form').waitFor();
  await guest.evaluate(async()=>{
    const s=GameApp.getState();s.room={online:true,status:'collecting',members:[]};s.network={status:'connected'};
    s.active={id:'header-client',name:'顶部布局测试存档名称很长',actorId:'a',round:0,status:'waiting',slots:[{id:'a',name:'甲'}],info:{姓名:'甲'},items:[],events:[]};await GameApp.updateSettings({});
  });
  for(const page of [host,guest])for(const width of [320,360,390,414,760]){
    await page.setViewportSize({width,height:844});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const boxes=await page.locator('.topbar .brand,.topbar .home-button,.topbar nav>[data-action="room-panel"],.topbar nav>.connection-indicator,.topbar nav>.connection-placeholder,.topbar nav>[data-action="settings"]').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {center:r.top+r.height/2,left:r.left,right:r.right};}));
    assert.ok(Math.max(...boxes.map(b=>b.center))-Math.min(...boxes.map(b=>b.center))<3,'all controls share one row at '+width);
    assert.ok(boxes.every((box,i)=>!i||box.left>=boxes[i-1].right),'controls do not overlap at '+width);
  }
  await host.setViewportSize({width:390,height:844});
  assert.equal(await host.locator('[data-action="play"]').isVisible(),false);
  const toggle=host.getByRole('button',{name:'切换显示模式',exact:true});await toggle.click();
  await host.getByRole('button',{name:'调试模式',exact:true}).click();
  await host.waitForFunction(()=>GameApp.getState().mode==='debug');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  await toggle.click();assert.equal(await host.locator('[data-action="debug"]').getAttribute('aria-pressed'),'true');
  await host.keyboard.press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert.equal(await toggle.evaluate(node=>node===document.activeElement),true);
  await toggle.click();await host.screenshot({path:'tests/artifacts/topbar-mode-menu-390.png'});
  await host.setViewportSize({width:1440,height:960});
  await host.waitForFunction(()=>document.querySelector('[data-action="toggle-mode-menu"]')?.getAttribute('aria-expanded')==='false');
  await host.setViewportSize({width:390,height:844});
  await toggle.click();await host.locator('.brand').click();assert.equal(await host.locator('[data-action="toggle-mode-menu"]').count(),0);
  await host.evaluate(()=>GameApp.returnToGame());await host.locator('.home-button').waitFor();
  await toggle.click();await host.getByRole('button',{name:'游戏模式',exact:true}).click();
  await host.locator('[data-action="room-panel"]').click();await host.getByRole('dialog',{name:'多人游戏',exact:true}).waitFor();
  await host.locator('[data-action="close-modal"]').first().click();
  await host.setViewportSize({width:1440,height:960});
  assert.equal(await toggle.isVisible(),false);assert.equal(await host.locator('[data-action="play"]').isVisible(),true);assert.equal(await host.locator('[data-action="debug"]').isVisible(),true);
  assert.equal(await host.locator('.topbar [data-action="room-panel"]').innerText(),'多人游戏');
  assert.equal(await guest.locator('[data-action="toggle-mode-menu"]').count(),0);
  await host.setViewportSize({width:390,height:844});await host.screenshot({path:'tests/artifacts/topbar-host-390.png'});await guest.setViewportSize({width:390,height:844});await guest.screenshot({path:'tests/artifacts/topbar-client-390.png'});
  assert.deepEqual(errors,[]);
});

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
    await GameApp.importSave(new File([ZIP.makeZip(files)],'中途邀请.zip'));await GameApp.configureSlots('a',{b:'ai',c:'ai'});
    window.__connections=0;
    BridgeTransport.createHost=async options=>{__connections++;return {transport:{onHost:()=>()=>{},sendToClient:async()=>{}},invite:async memberId=>({version:1,url:options.url,roomId:options.roomId,memberId,token:'A'.repeat(43)+'.'+'A'.repeat(43)}),revoke:async()=>{},credentials:()=>options.credentials,close(){}};};
  });
  const setRound=async round=>page.evaluate(async round=>{GameApp.getState().active.round=round;GameApp.getState().active.status='waiting';await GameApp.updateSettings({});},round);
  const openPanel=async()=>{await page.locator('[data-action="room-panel"]').click();};
  const apply=async(id,kind)=>{await page.locator('#slot-mode-'+id).selectOption(kind);if(await page.locator('[data-action="save-room"]').isEnabled())await page.locator('[data-action="save-room"]').click();};
  await setRound(2);await openPanel();await apply('b','player');
  assert.equal(await page.evaluate(()=>__connections),0);await page.locator('[data-action="connect-room"]').click();
  await page.waitForFunction(()=>GameApp.getState().network?.invites?.length===1);assert.equal(await page.locator('[role="alertdialog"]').count(),0);
  await apply('b','ai');await page.locator('[data-action="close-room"]').click();
  await setRound(3);await apply('b','player');await page.locator('[role="alertdialog"]').waitFor();
  const message=await page.locator('#app-dialog-message').innerText();
  for(const text of ['该角色卡存在格式错误','新开游戏','车卡流程','调试模式','/workspace/AIPC-b/基础信息.json','无法预料的错误'])assert.ok(message.includes(text),text);
  assert.equal(await page.locator('[data-dialog-value="confirm"]').innerText(),'我知道了');assert.equal(await page.evaluate(()=>__connections),1);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../artifacts/invitation-character-warning-390.png')});
  assert.equal(await page.evaluate(()=>GameApp.getState().active.slots.find(x=>x.id==='b').kind),'ai');
  await page.locator('[data-dialog-value="cancel"]').click();assert.equal(await page.evaluate(()=>__connections),1);
  await apply('b','player');await page.locator('[data-dialog-value="confirm"]').click();
  assert.equal(await page.evaluate(()=>__connections),1);await page.locator('[data-action="connect-room"]').click();
  await page.waitForFunction(()=>GameApp.getState().network?.invites?.length===1);assert.equal(await page.evaluate(()=>__connections),2);
  await apply('b','player');assert.equal(await page.locator('[role="alertdialog"]').count(),0);
  await page.locator('[data-action="close-modal"]').first().click();
  await page.evaluate(async()=>{VFS.writeFile(GameApp.getState().active.tree,'/workspace/AIPC-c/基础信息.json','{broken');await GameApp.updateSettings({});});
  await openPanel();await apply('c','player');await page.locator('[role="alertdialog"]').waitFor();await page.locator('[data-dialog-value="cancel"]').click();
  const card={姓名:'丙',性别:'女',外貌:'短发',穿戴:{},性格:'谨慎',职业:'医生',身份:'调查员',说话习惯:'温和',原则:'救人','喜好/厌恶':'喜欢阅读',技能:{},属性:{},主动技能:[],状态:{HP:10,MAXHP:10,MP:5,MAXMP:5,Enabled:true,Alive:true},buff栏:[],当前位置:'车站'};
  await page.evaluate(async card=>{VFS.writeFile(GameApp.getState().active.tree,'/workspace/AIPC-c/基础信息.json',JSON.stringify(card));await GameApp.updateSettings({});},card);
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
    if(!opening){
      await guest.waitForFunction(()=>document.querySelector('.live-status')?.textContent.includes('等待 AI 返回结果'));
      assert.equal(await guest.locator('.request-progress').count(),0,'client does not display host-only percentages');
      assert.equal(await guest.locator('#connection-lamp').getAttribute('data-turn-state'),'thinking');
      await guest.locator('#hidden-send-toggle').check();await guest.locator('#disguise-send-toggle').check();
      await guest.locator('#action-input').fill('乙下一轮的秘密草稿');await guest.locator('#action-private-input').fill('乙下一轮的公开草稿');
    }
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
    await GameApp.importSave(new File([ZIP.makeZip(files)],'多人回归.zip'));await GameApp.configureSlots('a',{b:'ai'});
  });
  const initial=await host.evaluate(()=>({room:GameApp.multiplayerState(),slots:GameApp.getState().active.slots}));
  assert.equal(initial.room.online,false);assert.equal(initial.room.roomId,null);assert.equal(initial.slots.find(x=>x.id==='b').kind,'ai');assert.ok(!initial.slots.some(x=>x.id==='guide'));assert.deepEqual(sockets,[]);
  await host.evaluate(async()=>{await GameApp.openRoom();await GameApp.addMember('guest');await GameApp.start();});
  await host.waitForFunction(()=>GameApp.getState().active.round===1&&GameApp.multiplayerState().status==='collecting').catch(async error=>{error.message+='\n'+JSON.stringify(await host.evaluate(()=>({room:GameApp.multiplayerState(),status:GameApp.getState().active.status,error:GameApp.getState().error,events:GameApp.getState().active.events.slice(-4)})));throw new Error(error.message);});
  await own.goto(origin+'/client.html');await guest.goto(origin+'/client.html');
  for(const page of [own,guest])assert.deepEqual(await page.evaluate(()=>[typeof GameCore,typeof GameTransport,typeof VFS]),['undefined','undefined','undefined']);
  await connectBridge(host,{host:own,guest});
  const lobby=await guest.evaluate(()=>GameApp.getState().active);assert.equal(lobby.actorId,null);assert.deepEqual(lobby.events,[]);assert.deepEqual(lobby.info,{});assert.deepEqual(lobby.items,[]);
  await guest.evaluate(()=>GameApp.roomCommand('slot.claim.request',{actorId:'b'}));
  await host.waitForFunction(()=>GameApp.multiplayerState().slotRequests.length===1);
  await host.locator('[data-action="slot-decide"][data-decision="approve"]').click();
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
  assert.equal(await guest.locator('[data-action="rollback"]').innerText(),'请求回退 (1)');
  await host.evaluate(()=>GameApp.send('甲先等待列车'));
  await guest.waitForFunction(()=>document.querySelector('.pending-actions')?.textContent.includes('甲先等待列车'));
  assert.match(await guest.locator('.submission-status').innerText(),/还差 1 人/);
  await host.evaluate(()=>GameApp.cancelAction());
  await guest.waitForFunction(()=>!document.querySelector('.pending-actions')?.textContent.includes('甲先等待列车'));
  await guest.evaluate(()=>GameApp.send('乙先查看站台'));
  await host.waitForFunction(()=>document.querySelector('.pending-actions')?.textContent.includes('乙先查看站台'));
  assert.match(await host.locator('.submission-status').innerText(),/还差 1 人/);
  await guest.waitForFunction(()=>document.querySelector('#connection-lamp')?.dataset.turnState==='submitted');
  assert.equal(await host.locator('#connection-lamp').getAttribute('data-turn-state'),'waiting');
  await guest.evaluate(()=>GameApp.cancelAction());
  await host.waitForFunction(()=>!document.querySelector('.pending-actions')?.textContent.includes('乙先查看站台'));
  assert.match(await host.locator('.submission-status').innerText(),/还差 2 人/);
  await guest.waitForFunction(()=>document.querySelector('#connection-lamp')?.dataset.turnState==='waiting');
  await guest.locator('#hidden-send-toggle').check();
  assert.equal(await guest.locator('#action-private-input').count(),0);
  assert.match(await guest.locator('#action-input').getAttribute('placeholder'),/隐秘.*不向其他玩家公开/);
  assert.ok(!(await guest.locator('#action-form').innerText()).includes('仅你可见'));
  await guest.locator('#action-input').fill('乙暗中藏起钥匙');
  await guest.locator('#disguise-send-toggle').check();
  await guest.locator('#action-private-input').fill('乙说自己在等车');
  await guest.locator('#disguise-send-toggle').uncheck();await guest.locator('#hidden-send-toggle').uncheck();
  assert.equal(await guest.locator('#action-input').inputValue(),'乙说自己在等车');
  await guest.locator('#hidden-send-toggle').check();await guest.locator('#disguise-send-toggle').check();
  assert.equal(await guest.locator('#action-input').inputValue(),'乙暗中藏起钥匙');assert.equal(await guest.locator('#action-private-input').inputValue(),'乙说自己在等车');
  await guest.locator('#hidden-send-toggle').uncheck();await guest.locator('#hidden-send-toggle').check();
  assert.equal(await guest.locator('#disguise-send-toggle').isChecked(),true);assert.equal(await guest.locator('#action-private-input').inputValue(),'乙说自己在等车');
  await guest.locator('#disguise-send-toggle').uncheck();await guest.locator('#action-form button[type="submit"]').click();
  await host.waitForFunction(()=>GameApp.multiplayerState().submissions.b?.privateContent==='乙暗中藏起钥匙');
  assert.equal(await host.evaluate(()=>GameApp.multiplayerState().submissions.b.content),'');
  await guest.locator('[data-action="cancel-action"]').click();
  await guest.waitForFunction(()=>document.querySelector('#action-input')?.value==='乙暗中藏起钥匙');
  assert.equal(await guest.locator('#disguise-send-toggle').isChecked(),false);
  await guest.locator('#disguise-send-toggle').check();assert.equal(await guest.locator('#action-private-input').inputValue(),'乙说自己在等车');
  const colors=await guest.evaluate(()=>({private:getComputedStyle(document.querySelector('#action-input')).color,public:getComputedStyle(document.querySelector('#action-private-input')).color,label:getComputedStyle(document.querySelector('.disguise-composer')).color}));
  assert.equal(colors.private,'rgb(128, 98, 159)');assert.notEqual(colors.public,colors.private);assert.notEqual(colors.label,colors.private);
  await host.evaluate(()=>{const receive=window.testHostReceiver;window.testHostReceiver=async(id,packet)=>{if(packet.type==='action.submit'){window.testHostReceiver=receive;await new Promise(resolve=>window.releaseSubmission=resolve);}return receive(id,packet);};});
  await guest.locator('#action-form button[type="submit"]').click();
  await host.waitForFunction(()=>typeof window.releaseSubmission==='function');
  await guest.locator('.pending-actions').filter({hasText:'乙暗中藏起钥匙'}).waitFor();
  await guest.locator('.submission-confirmation').waitFor();assert.match(await guest.locator('.pending-actions').innerText(),/等待房主确认/);
  assert.equal(await guest.locator('#action-form button[type="submit"]').isDisabled(),true);
  assert.equal(await guest.locator('#action-form button[type="submit"]').innerText(),'等待确认');
  await host.evaluate(()=>window.releaseSubmission());
  await host.waitForFunction(()=>GameApp.multiplayerState().submissions.b?.privateContent==='乙暗中藏起钥匙');
  await guest.waitForFunction(()=>document.querySelector('#action-form button[type="submit"]')?.textContent==='已提交');
  assert.equal(await guest.locator('#action-form button[type="submit"]').isDisabled(),true);
  assert.equal(await guest.locator('[data-action="cancel-action"]').innerText(),'撤回提交');
  assert.equal(await guest.locator('.pending-actions [data-key="pending-b"]').count(),1);
  for(const width of [1440,390]){
    await guest.setViewportSize({width,height:960});
    assert.ok(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const bounds=await guest.locator('.composer-bottom').evaluate(el=>{const hint=el.querySelector('.composer-hint').getBoundingClientRect(),actions=el.querySelector('.composer-actions').getBoundingClientRect(),meta=el.querySelector('.composer-meta').getBoundingClientRect();return {hint:{left:hint.left,right:hint.right,top:hint.top,bottom:hint.bottom},actions:{left:actions.left,right:actions.right,top:actions.top,bottom:actions.bottom},meta:{left:meta.left,right:meta.right}};});
    assert.ok(bounds.hint.right<=bounds.actions.left||bounds.hint.top>=bounds.actions.bottom||bounds.hint.bottom<=bounds.actions.top,'hint and buttons do not overlap');
    await guest.screenshot({path:'tests/artifacts/private-composer-'+width+'.png'});
  }
  await guest.setViewportSize({width:1440,height:960});
  assert.equal(await host.evaluate(()=>GameApp.multiplayerState().submissions.b.content),'乙说自己在等车');
  assert.equal(await host.evaluate(()=>GameApp.multiplayerState().submissions.b.disguise),true);
  await host.waitForFunction(()=>document.querySelector('.pending-actions')?.textContent.includes('乙说自己在等车'));
  assert.ok(!(await host.locator('#history').innerText()).includes('乙暗中藏起钥匙'));
  await guest.locator('[data-action="cancel-action"]').click();
  await host.waitForFunction(()=>!document.querySelector('.pending-actions')?.textContent.includes('乙说自己在等车'));
  await guest.waitForFunction(()=>document.querySelector('#action-input')?.value==='乙暗中藏起钥匙');
  assert.equal(await guest.locator('#hidden-send-toggle').isChecked(),true);
  assert.equal(await guest.locator('#disguise-send-toggle').isChecked(),true);
  assert.equal(await guest.locator('#action-private-input').inputValue(),'乙说自己在等车');
  await host.evaluate(()=>{const receive=window.testHostReceiver;window.testHostReceiver=(id,packet)=>{if(packet.type==='action.submit'){window.testHostReceiver=receive;throw Error('测试提交失败');}return receive(id,packet);};});
  await guest.locator('#action-form button[type="submit"]').click();
  await guest.waitForFunction(()=>!GameApp.getState().actionFeedback&&document.querySelector('#action-input')?.value==='乙暗中藏起钥匙');
  await guest.locator('.pending-actions [data-key="pending-b"]').waitFor({state:'detached'});
  assert.equal(await guest.locator('.pending-actions [data-key="pending-b"]').count(),0);
  assert.equal(await guest.locator('#action-form button[type="submit"]').isDisabled(),false);
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
  assert.equal(await guest.locator('#action-input').inputValue(),'乙下一轮的秘密草稿');assert.equal(await guest.locator('#action-private-input').inputValue(),'乙下一轮的公开草稿');
  assert.equal(await guest.locator('#hidden-send-toggle').isChecked(),true);assert.equal(await guest.locator('#disguise-send-toggle').isChecked(),true);
  await own.locator('#hidden-send-toggle').check();
  const guestText=await guest.locator('body').innerText(),ownText=await own.locator('body').innerText();
  assert.ok(!guestText.includes('只给甲的密语'));assert.ok(!ownText.includes('只给乙的密语'));
  const guestState=await guest.evaluate(()=>JSON.stringify({state:GameApp.getState(),storage:{...localStorage}}));assert.ok(!guestState.includes('只给甲的密语'));assert.ok(!guestState.includes('甲只向主持人提交的秘密行动'));
  assert.deepEqual(await guest.evaluate(()=>GameApp.getState().active.events.filter(e=>e.type==='player').map(e=>e.actorId)),['b'],'a private-only action leaves no empty bubble or existence marker for another player');
  for(const text of [guestText,ownText])for(const secret of ['房主内部草稿','隐藏卡片','隐藏物品','位置所属'])assert.ok(!text.includes(secret),secret);
  for(const width of [1440,390]){
    await host.setViewportSize({width,height:960});await own.setViewportSize({width,height:960});
    for(const selector of ['.inventory','.character','#history .story','#action-input','.home-navigation']){
      const h=await panelSnapshot(host,selector),c=await panelSnapshot(own,selector);
      if(selector==='.home-navigation'&&width<769)for(const rows of [h,c])for(const row of rows){delete row.width;for(const child of row.children)delete child.width;}
      assert.deepEqual(c,h,`${selector} matches at ${width}px`);
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
  assert.deepEqual(await guest.evaluate(()=>({draft:GameApp.getState().active.draft,privateDraft:GameApp.getState().active.privateDraft})),{draft:'乙检查门锁',privateDraft:'乙暗中藏起钥匙'});
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

test('global room save stages NPC notes and keeps its footer outside scrolling content',async t=>{
 const page=await pageFor(t);await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{const files=['pc',...Array.from({length:8},(_,i)=>'p'+(i+1))].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id})},{name:`Player-${id}/背包.json`,text:'[]'}]);await GameApp.importSave(new File([ZIP.makeZip(files)],'全局保存.zip'));await GameApp.configureSlots('pc',{p1:'ai'});});
 await page.setViewportSize({width:390,height:844});await page.locator('[data-action="room-panel"]').click();
 assert.equal(await page.locator('[data-action="slot-mode"]').count(),0);
 await page.locator('[data-npc-key="slot:p1"]').fill('医生设定');assert.equal(await page.evaluate(()=>GameApp.getState().active.npcCardInstructions?.['slot:p1']||''),'');
 await page.locator('#slot-mode-p2').selectOption('player');
 const save=page.locator('.room-modal>.modal-actions [data-action="save-room"]');
 const before=await save.boundingBox();await page.locator('.room-modal .modal-body').evaluate(body=>body.scrollTop=body.scrollHeight);assert.deepEqual(await save.boundingBox(),before);
 await save.click();await page.waitForFunction(()=>GameApp.getState().active.npcCardInstructions?.['slot:p1']==='医生设定'&&GameApp.getState().openPlayerSlots.includes('p2'));
 assert.equal(await save.isDisabled(),true);assert.equal(await page.evaluate(()=>GameApp.getState().network),null);
});

test('world confirmation keeps footer visible above the scrolling description on mobile',async t=>{
 const page=await pageFor(t);await page.route('**/modules.json',route=>route.fulfill({json:[{Name:'长描述世界',Introduction:'世界介绍',Text:'这是世界描述。\n'.repeat(200),Link:'/files/no-download.zip',CoverFit:'none'}]}));
 await page.setViewportSize({width:390,height:600});await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').click();await page.locator('[data-action="catalog"]').click();await page.locator('[data-action="module-detail"]').click();
 const footer=page.locator('.modal>.modal-actions'),before=await footer.boundingBox();assert.ok(before.y+before.height<=600);await page.locator('.modal-body').evaluate(body=>body.scrollTop=body.scrollHeight);assert.deepEqual(await footer.boundingBox(),before);
 await page.screenshot({path:'tests/artifacts/world-confirm-fixed-footer-390.png'});await page.locator('[data-action="catalog"]').click();
});

test('host and client switch all panels and header controls together at the responsive boundary',async t=>{
 const host=await pageFor(t),guest=await pageFor(t),errors=[];for(const page of [host,guest])page.on('pageerror',e=>errors.push(e.message));
 await host.goto(origin+'/index.html');await host.locator('[data-action="import"]').waitFor();
 await host.evaluate(async()=>{await GameApp.updateSettings({apiKey:'test'});const files=['pc','p1'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id})},{name:`Player-${id}/背包.json`,text:'[]'}]);await GameApp.importSave(new File([ZIP.makeZip(files)],'响应式断点.zip'));await GameApp.configureSlots('pc');});
 await guest.goto(origin+'/client.html');await guest.locator('#join-room-form').waitFor();await guest.evaluate(async()=>{const s=GameApp.getState();s.room={online:true,status:'collecting',members:[]};s.network={status:'connected'};s.active={id:'responsive-client',name:'响应式断点',actorId:'pc',round:0,status:'waiting',slots:[{id:'pc',name:'pc'}],info:{姓名:'pc'},items:[],events:[]};await GameApp.updateSettings({});});
 for(const page of [host,guest]){
  for(const width of [1440,1100,900,780,769,768,767,764,761,760,750,390,750,760,761,764,767,768,769,780,900,1100,1440]){
   await page.setViewportSize({width,height:900});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const layout=await page.evaluate(()=>({panels:[...document.querySelector('.game-layout').children].filter(n=>getComputedStyle(n).display!=='none').length,mobileNav:getComputedStyle(document.querySelector('.mobile-nav')).display!=='none',pageWidth:document.documentElement.scrollWidth,width:innerWidth}));
   assert.equal(layout.panels,width<=768?1:3,'panel count at '+width);assert.equal(layout.mobileNav,width<=768,'navigation at '+width);assert.ok(layout.pageWidth<=layout.width,'no overflow at '+width);
  }
  await page.setViewportSize({width:764,height:900});await page.screenshot({path:'tests/artifacts/responsive-boundary-'+(page===host?'host':'client')+'-764.png'});
  await page.locator('[data-action="mobile-left"]').click();assert.equal(await page.locator('.left-panel').isVisible(),true);assert.equal(await page.locator('.center-panel').isVisible(),false);
  await page.locator('[data-action="mobile-right"]').click();assert.equal(await page.locator('.right-panel').isVisible(),true);
  await page.locator('[data-action="mobile-center"]').click();assert.equal(await page.locator('.center-panel').isVisible(),true);
 }
 assert.deepEqual(errors,[]);
});
