'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path');
const {staticSite,startBridge}=require('./bridge-server.cjs');
let site,bridge,browser;
before(async()=>{site=await staticSite();bridge=await startBridge();browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});});
after(async()=>{await browser?.close();await bridge?.close();await site?.close();});
const diceArgs=extra=>({description:'公开检定',roller:'Player-b',related_attr:'侦查',is_secret:false,is_private:false,dice_dict:{检定:'1d100'},calculate_only:false,target_value:50,compare_mode:'le',critical_success_range:null,critical_failure_range:null,dice_combine_mode:'sum',left_modifiers:{},right_modifiers:{},...extra});
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
async function pageFor(t,errors,sockets){const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('websocket',socket=>{const record={url:socket.url(),received:[],sent:[]};sockets.push(record);socket.on('framereceived',frame=>record.received.push(typeof frame.payload==='string'?Buffer.byteLength(frame.payload):frame.payload.byteLength));socket.on('framesent',frame=>record.sent.push(typeof frame.payload==='string'?Buffer.byteLength(frame.payload):frame.payload.byteLength));});return page;}
async function waitHost(page,round){await page.waitForFunction(round=>GameApp.getState().active.round===round&&GameApp.multiplayerState().status==='collecting',round);}
async function closeModal(page){if(await page.locator('[data-action="close-modal"]').count())await page.locator('[data-action="close-modal"]').click();}

test('real Bridge sockets preserve host authority, private views, fragmented sync, reconnect and rollback', {timeout:120000},async t=>{
  t.diagnostic(bridge.external?'使用 BRIDGE_URL 指定服务，通过完整握手及真实消息验证':'已启动独立 Bridge 进程 PID '+bridge.pid+'：'+bridge.executable);
  const errors=[],hostSockets=[],guestSockets=[],attackerSockets=[];
  const host=await pageFor(t,errors,hostSockets),guest=await pageFor(t,errors,guestSockets),attacker=await pageFor(t,errors,attackerSockets);
  const bigStory='旅人沿着月台向前走去，窗外的雨已经停了。'.repeat(3200)+'长篇同步终点';let modelRequests=0;
  await host.route('https://bridge-model.invalid/**',async route=>{
    modelRequests++;assert.ok(modelRequests<=2,'本轮全部行动只触发一次模型结算');
    const actions=modelRequests===1?[call('append_story',{content:'两名旅人来到车站，等候下一班列车。',one_line_summary_of_content:'抵达车站'},'opening'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'九点'}},'opening-end')]:[
      call('trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}},'trigger'),
      call('roll_dice',diceArgs({description:'乙的公开检定'}),'public-dice'),
      call('roll_dice',diceArgs({roller:'Player-a',description:'甲的私密骰理由',is_private:true}),'a-dice'),
      call('roll_dice',diceArgs({description:'乙的私密骰理由',is_private:true}),'b-dice'),
      call('roll_dice',diceArgs({description:'暗骰原因保密',related_attr:'密骰属性保密',is_secret:true,is_private:true}),'secret-dice'),
      call('private_append_story',{entries:[{id:'a',story:'甲的私密线索：蓝色信封藏在井底。'},{id:'b',story:'乙的私密线索：红色钥匙藏在钟楼。'}]},'private'),
      call('append_story',{content:bigStory,one_line_summary_of_content:'两人在月台等待'},'public'),
      call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'九点十分'}},'end')];
    await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{role:'assistant',content:'内部推理与草稿不会发给玩家',tool_calls:actions},finish_reason:'tool_calls'}]})});
  });
  await host.goto(site.origin+'/index.html');await host.locator('[data-action="import"]').waitFor();
  await host.evaluate(async bridgeUrl=>{
    await GameApp.updateSettings({baseUrl:'https://bridge-model.invalid/v1',apiKey:'fake-model-key',stream:false,bridgeUrl});
    const files=['a','b'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id==='a'?'甲':'乙',职业:'公开职业-'+id,密码:'不公开密码',当前位置:'不公开位置',Alive:true,Enabled:true,'.秘密':'不公开人物-'+id})},{name:`Player-${id}/背包.json`,text:'[]'}]);
    files.push({name:'模组.md',text:'两名旅人在车站会合。'});await GameApp.importSave(new File([ZIP.makeZip(files)],'Bridge真实联机.zip'));await GameApp.configureSlots('a');
  },bridge.url);
  assert.deepEqual(hostSockets,[],'默认多角色存档仍离线');assert.equal(await host.locator('#connection-lamp').getAttribute('data-status'),'purple');
  await host.evaluate(()=>GameApp.start());await waitHost(host,1);
  await closeModal(host);await host.locator('[data-action="rollback"]').click();
  await host.locator('[role="alertdialog"]').waitFor();assert.equal(await host.locator('[data-action="host-rollback"][data-decision="vote"]').count(),0,'单人模式不显示投票');
  await host.locator('[data-dialog-value="cancel"]').click();assert.deepEqual(hostSockets,[],'离线回溯弹窗不连接服务');
  await host.locator('[data-action="room-panel"]').click();
  assert.equal(await host.locator('[data-action="slot-choose"]').count(),0);
  assert.match(await host.locator('body').innerText(),/只有房主产生 token 消耗/);
  await host.locator('#slot-mode-b').selectOption('player');await host.locator('[data-action="slot-mode"][data-actor="b"]').click();
  await host.locator('#room-invitation-b').waitFor();
  assert.equal(await host.locator('[data-action="copy-invitation"][data-actor="b"]').count(),1);
  assert.equal(await host.locator('[data-action="copy-join-key"][data-actor="b"]').count(),1);
  await host.setViewportSize({width:390,height:844});
  assert.ok(await host.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'窄屏邀请面板不能横向溢出');
  fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});
  await host.screenshot({path:path.join(__dirname,'../artifacts/bridge-invitation-390.png'),fullPage:true});
  await host.setViewportSize({width:1280,height:720});
  const invitation=await host.evaluate(()=>GameApp.getState().network.invites.find(invite=>invite.actorId==='b').link);
  assert.equal(typeof invitation,'string');assert.match(invitation,/#join=/);
  const parsed=await host.evaluate(link=>BridgeTransport.parseInvitation(link),invitation);
  assert.ok(!JSON.stringify(parsed).includes('hostToken'),'邀请不带房主凭证');
  await guest.goto(site.origin+'/client.html');
  await guest.evaluate(()=>{window.bridgeTestRequests=[];const original=BridgeTransport.createClient;BridgeTransport.createClient=async options=>{const result=await original(options),send=result.transport.sendToHost;result.transport.sendToHost=function(id,packet){window.bridgeTestRequests.push({type:packet.type,payload:packet.type==='sync.request'?structuredClone(packet.payload):undefined});return send.call(this,id,packet);};return result;};});
  const invitationCode=new URL(invitation).hash.slice('#join='.length);
  assert.equal(await host.locator('#room-invitation-b').inputValue(),invitationCode);
  await guest.setViewportSize({width:390,height:844});await guest.locator('#join-room-form input[name="invitation"]').fill(invitationCode);
  assert.ok(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'窄屏加入页的长密钥不能横向溢出');
  await guest.screenshot({path:path.join(__dirname,'../artifacts/bridge-join-390.png'),fullPage:true});
  await guest.locator('#join-room-form button[type="submit"]').click();
  try{await guest.waitForFunction(()=>GameApp.getState().active?.actorId==='b');}catch(error){
    const diagnostic=await guest.evaluate(()=>({actorId:GameApp.getState().active?.actorId,room:GameApp.getState().room,network:GameApp.getState().network}));
    t.diagnostic(JSON.stringify(diagnostic));throw error;
  }await closeModal(host);await closeModal(guest);
  assert.equal(await host.evaluate(async()=>{try{await GameApp.configureSlots('b');return true;}catch{return false;}}),false,'开局后房主不能改换自己的角色');
  assert.deepEqual(await guest.evaluate(()=>[typeof GameCore,typeof GameTransport,typeof VFS]),['undefined','undefined','undefined']);
  await guest.locator('[data-action="room-panel"]').click();await guest.locator('[data-action="player-profile"][data-actor="a"]').click();
  await guest.waitForFunction(()=>document.querySelector('.player-profile')?.textContent.includes('公开职业-a'));
  for(const hidden of ['不公开人物','不公开密码','不公开位置'])assert.ok(!(await guest.locator('.player-profile').innerText()).includes(hidden));
  await closeModal(guest);
  await guest.locator('#action-input').fill('待取消的公开行动');await guest.locator('#action-private-input').fill('待取消的秘密行动');
  await guest.locator('#action-form button[type="submit"]').click();await guest.locator('[data-action="cancel-action"]').waitFor();
  await guest.locator('[data-action="cancel-action"]').click();
  await host.waitForFunction(()=>!GameApp.multiplayerState().submissions.b);
  await guest.waitForFunction(()=>GameApp.getState().active.inputHistory.at(-1)?.status==='cancelled');
  await guest.waitForFunction(()=>GameApp.getState().room.submitted===false);
  assert.equal(await guest.locator('#action-input').inputValue(),'待取消的公开行动');assert.equal(await guest.locator('#action-private-input').inputValue(),'待取消的秘密行动');
  assert.ok(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'双输入框在窄屏不能横向溢出');
  await guest.screenshot({path:path.join(__dirname,'../artifacts/multiplayer-dual-input-390.png'),fullPage:true});
  assert.ok(!(await host.locator('#history').innerText()).includes('待取消的公开行动'));assert.equal(modelRequests,1);

  await attacker.goto(site.origin+'/client.html');
  const rejected=await attacker.evaluate(async invitation=>{try{await GameApp.joinRoom({...invitation,token:invitation.token[0]==='A'?'B'+invitation.token.slice(1):'A'+invitation.token.slice(1)});return {accepted:true,state:GameApp.getState().active};}catch(error){return {accepted:false,code:error.code,message:error.message};}},parsed);
  assert.equal(rejected.accepted,false,'无效玩家凭证不能进入房间');
  assert.match(rejected.code||rejected.message,/Unauthorized|授权|凭证|权限/);
  const spoofed=await attacker.evaluate(async invitation=>new Promise((resolve,reject)=>{
    const url=new URL(invitation.url);url.pathname='/server/'+invitation.roomId+'-spoof';const socket=new WebSocket(url),secret=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    const timer=setTimeout(()=>{socket.close();reject(Error('伪装房主握手未得到拒绝'));},8000);
    socket.onopen=()=>socket.send(JSON.stringify({protocolVersion:1,token:invitation.token,clientNonce:secret(),epoch:secret(),manifest:{hostFunctions:[],clientFunctions:[]},players:[]}));
    socket.onmessage=event=>{clearTimeout(timer);socket.close();try{resolve(JSON.parse(event.data));}catch{reject(Error('伪装房主得到非拒绝响应'));}};socket.onerror=()=>{clearTimeout(timer);reject(Error('伪装房主测试未完成握手'));};
  }),parsed);
  assert.match(spoofed.code||'',/InvalidHostSecret|Unauthorized/);
  const authority=await guest.evaluate(async()=>{try{await GameApp.roomCommand('room.close',{});return true;}catch{return false;}});assert.equal(authority,false,'合法玩家也不能执行房主管理命令');

  await host.evaluate(()=>GameApp.send('','甲的隐秘行动：悄悄藏好信封'));
  assert.equal(modelRequests,1);assert.equal(await host.evaluate(()=>GameApp.multiplayerState().status),'collecting');
  await guest.waitForFunction(()=>!document.querySelector('#action-input')?.disabled&&document.querySelector('.character')?.textContent.includes('乙'));
  await guest.locator('#action-input').fill('乙检查车站的大门');await guest.locator('#action-private-input').fill('乙悄悄记录门锁');await guest.locator('#action-private-input').press('Control+Enter');
  await waitHost(host,2);await guest.waitForFunction(()=>GameApp.getState().active.round===2&&document.querySelector('#history')?.textContent.includes('长篇同步终点'));
  assert.equal(modelRequests,2);
  assert.ok(!(await guest.locator('#history').innerText()).includes('待取消的公开行动'));assert.ok((await guest.locator('#history').innerText()).includes('乙悄悄记录门锁'));
  const guestView=await guest.evaluate(()=>JSON.stringify({state:GameApp.getState().active,storage:{...localStorage}}));
  for(const hidden of ['甲的私密线索','甲的隐秘行动','不公开人物','内部推理与草稿'])assert.ok(!guestView.includes(hidden),hidden+'未进入客户端或本地缓存');
  assert.ok(guestView.includes('乙的私密线索'));assert.ok(guestView.includes('乙的私密骰理由'));assert.ok(!guestView.includes('甲的私密骰理由'));assert.ok(!guestView.includes('暗骰原因保密'));assert.ok(!guestView.includes('密骰属性保密'));
  assert.ok(await guest.evaluate(()=>GameApp.getState().active.events.some(e=>e.type==='dice'&&e.rollerId==='b'&&!e.private)),'其他玩家的公开骰标有实际角色');
  assert.equal(await guest.locator('.dice.private-dice').count(),1);assert.equal(await guest.locator('.secret-dice-notice.private-dice').count(),1);assert.equal(await guest.locator('.dice.private-dice').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(243, 236, 255)');
  for(const p of [host,guest])assert.equal(await p.locator('#connection-lamp').getAttribute('data-status'),'green');
  assert.ok(Buffer.byteLength(await guest.evaluate(()=>JSON.stringify(GameApp.exportView())))>128*1024,'完整可见视图超过服务单帧上限');
  assert.ok(guestSockets.some(socket=>socket.received.filter(size=>size>20000).length>=3),'长正文确实通过多条原生 WS 帧送达');
  assert.ok(guestSockets.every(socket=>socket.received.every(size=>size<=128*1024)),'分片不超过 Bridge 单帧限制');
  const ids=await guest.evaluate(()=>GameApp.exportView().events.map(event=>event.id)),previousSockets=guestSockets.length;
  await guest.evaluate(()=>GameApp.saveDraft('重连时保留的草稿'));
  await guest.evaluate(()=>GameApp.reconnectRoom());await guest.waitForFunction(()=>GameApp.getState().room?.online&&GameApp.getState().active?.round===2);
  await guest.evaluate(()=>GameApp.sync());await guest.waitForTimeout(250);
  assert.ok(guestSockets.length>previousSockets,'重连建立了新的真实 WebSocket');
  assert.deepEqual(await guest.evaluate(()=>GameApp.exportView().events.map(event=>event.id)),ids,'重连不重复追加已确认回合');
  assert.equal(await guest.evaluate(()=>GameApp.getState().active?.draft),'重连时保留的草稿',JSON.stringify(await guest.evaluate(()=>({network:GameApp.getState().network,room:GameApp.getState().room}))));
  assert.ok(await guest.evaluate(()=>window.bridgeTestRequests.some(request=>request.type==='sync.request'&&request.payload?.hashes?.history&&request.payload?.cursor>0)),'重连/同步携带已确认历史 hash 与增量游标');
  assert.equal(modelRequests,2,'重连不能重新启动模型回合');

  await guest.goto('about:blank');await guest.goto(invitation);await guest.waitForFunction(()=>GameApp.getState().active?.actorId==='b'&&GameApp.getState().active.round===2);
  assert.deepEqual(await guest.evaluate(()=>GameApp.exportView().events.map(event=>event.id)),ids,'完整邀请链接可一键恢复同一槽位且不重复回合');
  assert.equal(await guest.evaluate(()=>GameApp.getState().active?.draft),'重连时保留的草稿',JSON.stringify(await guest.evaluate(()=>({network:GameApp.getState().network,room:GameApp.getState().room}))));

  await host.locator('[data-action="rollback"]').click();
  await host.locator('[data-action="host-rollback"][data-decision="vote"]').waitFor();
  assert.equal(await host.locator('[data-action="host-rollback"][data-decision="approve"]').count(),1);
  assert.equal(await host.evaluate(()=>GameApp.multiplayerState().vote),null,'选择之前不创建自请求');
  await host.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await host.evaluate(()=>GameApp.multiplayerState().vote),null,'取消不改变房间');
  await host.locator('[data-action="rollback"]').click();await host.locator('[data-action="host-rollback"][data-decision="vote"]').click();
  await host.waitForFunction(()=>GameApp.multiplayerState().vote?.status==='voting');
  const voteId=await host.evaluate(()=>GameApp.multiplayerState().vote.id);
  await guest.waitForFunction(()=>GameApp.getState().room?.vote?.status==='voting');
  await guest.evaluate(voteId=>GameApp.roomCommand('rollback.vote',{voteId,approve:true}),voteId);
  await waitHost(host,1);await guest.waitForFunction(()=>GameApp.getState().active.round===1);
  await guest.waitForFunction(()=>!document.querySelector('#history')?.textContent.includes('乙的私密线索'));
  assert.ok(!(await guest.locator('body').innerText()).includes('乙的私密线索'));assert.equal(await guest.evaluate(()=>GameApp.getState().active.draft),'乙检查车站的大门');
  assert.equal(await guest.evaluate(()=>GameApp.getState().active.privateDraft),'乙悄悄记录门锁');
  for(const p of [host,guest])for(const text of ['乙检查车站的大门','乙悄悄记录门锁','甲的隐秘行动'])assert.ok(!(await p.locator('#history').innerText()).includes(text),'rollback removes all actors actions from story history');
  for(const p of [host,guest])await p.waitForFunction(()=>!document.querySelector('[data-action="rollback-vote"]'));
  await guest.locator('#action-input').fill('');await guest.locator('#action-private-input').fill('');await guest.locator('[data-action="input-history"]').click();
  await guest.locator('[data-action="recall-input"][data-round="2"]').click();
  assert.equal(await guest.locator('#action-input').inputValue(),'乙检查车站的大门');assert.equal(await guest.locator('#action-private-input').inputValue(),'乙悄悄记录门锁');
  await guest.evaluate(()=>GameApp.reconnectRoom());await guest.waitForFunction(()=>GameApp.getState().network.status==='connected'&&GameApp.getState().active.round===1);
  assert.ok(!(await guest.evaluate(()=>JSON.stringify(GameApp.exportView().events))).includes('乙检查车站的大门'),'reconnect cannot resurrect rolled-back actions');
  await host.evaluate(()=>GameApp.closeRoom());await guest.waitForFunction(()=>GameApp.getState().room?.online===false);
  await guest.waitForFunction(()=>document.querySelector('#action-form button[type="submit"]')?.disabled);
  assert.equal(await guest.locator('#action-form button[type="submit"]').isDisabled(),true);
  assert.ok(hostSockets.some(socket=>socket.url.includes('/server/')));assert.ok(guestSockets.some(socket=>socket.url.includes('/client/')));assert.equal(modelRequests,2);assert.deepEqual(errors,[]);
});

test('closing and reopening a player slot invalidates its previous invitation', {timeout:60000},async t=>{
  const errors=[],sockets=[],host=await pageFor(t,errors,sockets),guest=await pageFor(t,errors,sockets);
  await host.goto(site.origin+'/index.html');await host.locator('[data-action="import"]').waitFor();
  await host.evaluate(async bridgeUrl=>{
    await GameApp.updateSettings({bridgeUrl});
    const files=['a','b'].flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id,Alive:true,Enabled:true})},{name:`Player-${id}/背包.json`,text:'[]'}]);
    files.push({name:'模组.md',text:'邀请撤销回归世界。'});await GameApp.importSave(new File([ZIP.makeZip(files)],'邀请撤销.zip'));await GameApp.configureSlots('a');
  },bridge.url);
  await closeModal(host);await host.locator('[data-action="room-panel"]').click();
  const mode=async kind=>{await host.locator('#slot-mode-b').selectOption(kind);await host.locator('[data-action="slot-mode"][data-actor="b"]').click();};
  await mode('player');await host.locator('#room-invitation-b').waitFor();
  const oldKey=await host.locator('#room-invitation-b').inputValue();
  await mode('disabled');await host.waitForFunction(()=>!GameApp.getState().network?.invites.some(invite=>invite.actorId==='b'));
  await mode('player');await host.locator('#room-invitation-b').waitFor();
  const newKey=await host.locator('#room-invitation-b').inputValue();assert.notEqual(newKey,oldKey);
  await guest.goto(site.origin+'/client.html');
  const accepted=await guest.evaluate(async key=>{try{await GameApp.joinRoom(key);return true;}catch{return false;}},oldKey);assert.equal(accepted,false,'已撤销密钥不能占用重新开放的角色');
  await guest.locator('#join-room-form input[name="invitation"]').fill(newKey);await guest.locator('#join-room-form button[type="submit"]').click();
  await guest.waitForFunction(()=>GameApp.getState().active?.actorId==='b');
  await host.locator('#slot-mode-b').selectOption('ai');await host.locator('[data-action="slot-mode"][data-actor="b"]').click();
  await host.locator('[role="alertdialog"] [data-dialog-value="confirm"]').click();
  await host.waitForFunction(()=>GameApp.getState().active.slots.find(s=>s.id==='b').kind==='ai');
  await guest.waitForFunction(()=>GameApp.getState().network?.status==='closed');
  assert.equal(await guest.evaluate(async key=>{try{await GameApp.joinRoom(key);return true;}catch{return false;}},newKey),false,'occupied slot conversion revokes its invitation');
  await host.evaluate(()=>GameApp.closeRoom());
  assert.ok(sockets.some(socket=>socket.url.includes('/server/'))&&sockets.some(socket=>socket.url.includes('/client/')));assert.deepEqual(errors,[]);
});
