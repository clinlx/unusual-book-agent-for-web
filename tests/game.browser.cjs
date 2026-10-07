'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');const {chromium}=require('playwright');const ZIP=require('../src/zip.js');
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const errors=[];const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',e=>errors.push(e.message));
  fs.mkdirSync(path.join(__dirname,'artifacts'),{recursive:true});
  const world=ZIP.makeZip([
    {name:'Player-p1/基础信息.json',text:'{"姓名":"林青","属性":{"生命":10,"理智":65},".秘密":"内部秘密不显示","buff栏":[{"名称":"未知诅咒",".是否对玩家隐藏":true}]}'},
    {name:'Player-p1/背包.json',text:'["key"]'},
    {name:'存档-索引-物品/key/物品基础信息.json',text:'{"名称":"铜钥匙","描述":"边角磨得光滑。",".触发器":"秘密机关"}'},
    {name:'模组.md',text:'# 雨夜车站\n主角站在站台上，行李里有钥匙。'},
    {name:'世界状态和世界规则/世界规则.md',text:'使用 d20 检定。'}]);
  let reqs=0;
  await page.route('https://test.invalid/**',async route=>{
    const body=route.request().postDataJSON();reqs++;
    assert.equal(typeof body.messages[0].content,'string');
    assert.ok(!body.tools.some(t=>['view_image','run_skill','goal'].includes(t.function.name)));
    let calls;
    if(reqs===1)calls=[call('read_file',{path:'/workspace/Player-p1/基础信息.json'},'read1'),call('append_story',{content:'雨水从站台檐角坠下。穿灰衣的站务员朝你抬了抬帽檐：“末班车还没到。”',one_line_summary_of_content:'雨夜抵达车站'},'story1'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'夜晚',Active_Scene:'车站'}},'end1')];
    else if(reqs===2)calls=[call('trigger_next_round',{phase_plan:{Countdowns:'安全性20→19',Pending_Triggers:[],Forced_Checks:'无'}},'trigger2'),call('roll_dice',{roller:'林青',description:'观察站台',dice_dict:{观察:'1d20'},target_value:10,compare_mode:'ge'},'dice2'),call('read_file',{path:'/workspace/Player-p1/基础信息.json'},'read2'),call('write_file',{path:'/workspace/Player-p1/基础信息.json',content:'{"姓名":"林青","属性":{"生命":9,"理智":65},".秘密":"内部秘密不显示"}'},'write2'),call('append_story',{content:'站务员把灯提近了一点，照出木箱边缘的一道划痕。',one_line_summary_of_content:'发现木箱划痕'},'story2'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'夜晚',Active_Scene:'车站'}},'end2')];
    else if(reqs===3)calls=[call('trigger_next_round',{phase_plan:{Countdowns:'19→18',Pending_Triggers:[],Forced_Checks:'无'}},'t3'),call('append_story',{content:'远处传来一声汽笛。',one_line_summary_of_content:'列车将至'},'a3'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'夜晚'}},'e3')];
    else throw Error('Unexpected model request '+reqs);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{role:'assistant',content:'内部主持分析，不应该在游玩展示',reasoning_content:'模型返回的分析',tool_calls:calls},finish_reason:'tool_calls'}]})});
  });
  try{
    await page.goto(pathToFileURL(path.resolve(__dirname,'../dist/index.html')).href);
    await page.locator('[data-action="import"]').waitFor();
    assert.equal(await page.evaluate(()=>GameApp.getState().settings.maxOutputTokens),16384);
    assert.equal(await page.locator('.brand-seal svg.brand-die').count(),1);
    await page.route('https://probe.invalid/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'OK'},finish_reason:'stop'}]})}));
    await page.locator('[data-action="settings"]').click();
    assert.ok(!(await page.locator('[role="dialog"]').innerText()).includes('上下文达到上限时'));
    await page.locator('[name="baseUrl"]').fill('https://probe.invalid/v1');await page.locator('[name="apiKey"]').fill('probe-only');
    await page.locator('[data-action="test-connection"]').click();
    await page.waitForFunction(()=>document.querySelector('#connection-result').textContent.includes('连接成功'));
    assert.equal(await page.evaluate(()=>GameApp.getState().settings.apiKey),'');
    await page.locator('[data-action="close-modal"]').click();
    assert.equal(await page.evaluate(()=>GameApp.getState().active),null);
    await page.screenshot({path:path.join(__dirname,'artifacts/game-home.png')});
    await page.locator('#zip-input').setInputFiles({name:'雨夜车站.zip',mimeType:'application/zip',buffer:Buffer.from(await world.arrayBuffer())});
    await page.locator('[data-action="start"]').waitFor();
    await page.evaluate(()=>GameApp.updateSettings({baseUrl:'https://test.invalid/v1',apiKey:'test-only',stream:false}));
    if(await page.locator('[data-action="close-modal"]').first().isVisible())await page.locator('[data-action="close-modal"]').first().click();
    await page.locator('[data-action="start"]').click();
    await page.waitForFunction(()=>GameApp.getState().active?.round===1&&!GameApp.getState().running);
    await page.waitForFunction(()=>document.querySelectorAll('.round-end').length===1);
    assert.equal(await page.locator('.round-end').count(),1);
    assert.ok(!(await page.locator('#history').innerText()).includes('内部主持分析'));
    assert.ok(!(await page.locator('.right-panel').innerText()).includes('内部秘密'));
    await page.locator('#action-input').fill('查看木箱');await page.locator('#action-form button[type="submit"]').click();
    await page.waitForFunction(()=>GameApp.getState().active.round===2&&!GameApp.getState().running);
    await page.waitForFunction(()=>document.querySelectorAll('.round-end').length===2);
    assert.equal(await page.locator('.round-end').count(),2);assert.equal(await page.locator('.player-action').count(),1);
    assert.ok(await page.locator('.left-panel').innerText().then(t=>t.includes('铜钥匙')));
    await page.screenshot({path:path.join(__dirname,'artifacts/game-play.png')});
    assert.equal(await page.locator('[data-action="changes"]').count(),0);assert.equal(await page.locator('.info-footer [data-action="rollback"]').count(),1);
    assert.ok(await page.evaluate(async()=>{
      const history=document.querySelector('#history'),input=document.querySelector('#action-input'),info=document.querySelector('.info-group');
      info.open=false;input.focus();input.value='稳定输入';input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(1,3);history.scrollTop=0;
      for(let i=0;i<5;i++){GameApp.setMode('play');await new Promise(r=>setTimeout(r,70));}
      return history===document.querySelector('#history')&&input===document.activeElement&&input.selectionStart===1&&input.selectionEnd===3&&info===document.querySelector('.info-group')&&!info.open&&history.scrollTop===0;
    }));
    await page.locator('[data-action="debug"]').click();
    await page.locator('.tool-event').first().waitFor();
    assert.equal(await page.locator('[data-action="changes"]').count(),1);assert.equal(await page.locator('[data-action="rollback"]').count(),0);
    assert.equal(await page.locator('[data-action="context"],[data-action="export"]').count(),2);
    assert.ok((await page.locator('#history').innerText()).includes('内部主持分析'));
    await page.locator('[data-action="open-file"][data-path="/workspace/模组.md"]').click();
    await page.locator('#file-editor').fill('# 雨夜车站\n手动编辑保存');await page.locator('[data-action="save-file"]').click();
    assert.ok(await page.evaluate(()=>GameApp.readFile('/workspace/模组.md').includes('手动编辑')));
    await page.screenshot({path:path.join(__dirname,'artifacts/game-debug.png')});
    await page.locator('[data-action="changes"]').click();assert.ok((await page.locator('[role="dialog"]').innerText()).includes('基础信息.json'));
    assert.ok(!(await page.locator('[role="dialog"]').innerText()).includes('接受'));await page.locator('[data-action="close-modal"]').click();
    await page.locator('[data-action="settings"]').click();
    assert.equal(await page.locator('[data-action="prompts"]').count(),0);
    assert.equal(await page.evaluate(()=>typeof GameApp.savePrompt),'undefined');
    assert.ok(await page.evaluate(()=>Prompts.referencePaths().every(p=>p.startsWith('/.reference/'))));
    await page.keyboard.press('Escape');
    await page.reload();await page.locator('[data-action="open-save"]').waitFor();
    assert.equal(await page.evaluate(()=>GameApp.getState().active),null);
    assert.ok(await page.evaluate(()=>{
      const cards=[...document.querySelectorAll('.save-grid>*')].map(e=>e.getBoundingClientRect());
      return getComputedStyle(document.querySelector('.save-home')).textAlign==='center'&&Math.abs((cards[0].left+cards.at(-1).right)/2-innerWidth/2)<2;
    }));
    await page.setViewportSize({width:550,height:850});
    assert.ok(await page.evaluate(()=>{const cards=[...document.querySelectorAll('.save-grid>*')].map(e=>e.getBoundingClientRect());return cards[1].top>cards[0].bottom&&Math.abs(cards[0].left-cards[1].left)<2;}));
    await page.screenshot({path:path.join(__dirname,'artifacts/game-home-wrap.png')});
    await page.setViewportSize({width:1440,height:960});
    await page.locator('[data-action="open-save"]').click();
    await page.waitForFunction(()=>GameApp.getState().active?.round===2);
    const exported=await page.evaluate(async()=>Array.from(new Uint8Array(await GameApp.exportSave().arrayBuffer())));
    await page.evaluate(()=>GameApp.closeSave());
    await page.locator('#zip-input').setInputFiles({name:'进度.zip',mimeType:'application/zip',buffer:Buffer.from(exported)});
    await page.waitForFunction(()=>GameApp.getState().active?.round===2);
    assert.equal(await page.evaluate(()=>GameApp.getState().saves.length),2);
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(__dirname,'artifacts/game-mobile.png')});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    // Stop after a successful story transition, reload, then continue the durable tool batch.
    await page.evaluate(()=>{
      window.stopAfterStory=GameApp.subscribe(s=>{if(s.running&&s.active?.events.some(e=>e.type==='story'&&e.content==='远处传来一声汽笛。')){window.stopAfterStory();GameApp.abort();}});
    });
    await page.locator('#action-input').fill('等待列车');await page.locator('#action-form button[type="submit"]').click();
    await page.waitForFunction(()=>!GameApp.getState().running&&GameApp.getState().active.status==='interrupted');
    await page.locator('#history [data-action="resume"]').waitFor();
    assert.equal(await page.locator('#action-input').isDisabled(),true);
    await page.locator('[data-action="debug"]').click();
    await page.locator('.debug-mode').waitFor();
    assert.equal(await page.locator('#history [data-action="resume"]').count(),1);
    assert.equal(await page.locator('#action-input').isDisabled(),true);
    await page.locator('[data-action="play"]').click();
    const resumeSaveId=await page.evaluate(()=>GameApp.getState().active.id);
    await page.evaluate(()=>{window.onbeforeunload=null;});await page.reload();
    await page.locator(`[data-action="open-save"][data-id="${resumeSaveId}"]`).click();await page.locator('[data-action="resume"]').waitFor();
    await page.locator('[data-action="resume"]').click();await page.waitForFunction(()=>!GameApp.getState().running&&GameApp.getState().active.round===3);
    await page.locator('[data-action="resume"]').waitFor({state:'detached'});
    assert.equal(reqs,3);assert.equal(await page.evaluate(()=>GameApp.getState().active.events.filter(e=>e.type==='story'&&e.content==='远处传来一声汽笛。').length),1);
    await page.evaluate(()=>GameApp.rollback());assert.equal(await page.evaluate(()=>GameApp.getState().active.round),2);
    // An incomplete manual JSON edit must leave DEBUG available for repair.
    await page.setViewportSize({width:1440,height:960});
    await page.evaluate(async()=>{GameApp.setMode('debug');await GameApp.writeFile('/workspace/Player-p1/基础信息.json','{');});
    await page.locator('[data-action="open-file"][data-path="/workspace/Player-p1/基础信息.json"]').waitFor();
    await page.evaluate(()=>GameApp.writeFile('/workspace/Player-p1/基础信息.json','{"姓名":"林青"}'));
    await page.locator('#action-input').fill('尚未提交的行动');
    await page.waitForFunction(()=>GameApp.getState().active.draft==='尚未提交的行动');
    await page.evaluate(()=>GameApp.saveDraft('尚未提交的行动'));
    await page.reload();await page.locator(`[data-action="open-save"][data-id="${resumeSaveId}"]`).click();
    await page.waitForFunction(()=>document.querySelector('#action-input')?.value==='尚未提交的行动');
    // Legacy overrides do not alter the fixed read-only prompt resources.
    const referenceId='reference/安全性-A.md',referencePath='/.reference/安全性-A.md';
    const referenceDefault=await page.evaluate(id=>Prompts.get(id),referenceId);
    await page.evaluate(id=>(GameApp.getState().settings.promptOverrides[id]='旧版参考'),referenceId);
    let liveCalls=0;
    await page.route('https://test.invalid/**',async route=>{
      liveCalls++;let calls;
      if(liveCalls===1){await page.waitForFunction(()=>document.querySelector('.live-status')?.textContent.includes('正在请求'));calls=[call('trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}},'live-trigger'),call('read_file',{path:referencePath},'live-old')];}
      else if(liveCalls===2){await page.waitForFunction(()=>document.querySelector('.live-status')?.textContent.includes('正在思考'));await page.evaluate(id=>(GameApp.getState().settings.promptOverrides[id]='实时更新参考'),referenceId);calls=[call('read_file',{path:referencePath},'live-new')];}
      else if(liveCalls===3){await page.evaluate(id=>delete GameApp.getState().settings.promptOverrides[id],referenceId);calls=[call('read_file',{path:referencePath},'live-default'),call('append_story',{content:'夜色渐深。',one_line_summary_of_content:'夜色渐深'},'live-story')];}
      else if(liveCalls===4){await page.waitForFunction(()=>document.querySelector('.live-status')?.textContent.includes('主持人正在收尾和处理变更'));await page.screenshot({path:path.join(__dirname,'artifacts/game-finishing.png')});calls=[call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'live-end')];}
      else throw Error('Unexpected live reference request');
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'',tool_calls:calls},finish_reason:'tool_calls'}]})});
    });
    await page.evaluate(()=>GameApp.send('继续等候'));
    const referenceReads=await page.evaluate(()=>Object.fromEntries(GameApp.getState().active.events.filter(e=>e.type==='tool'&&e.callId?.startsWith('live-')&&e.name==='read_file').map(e=>[e.callId,e.result.content])));
    assert.equal(referenceReads['live-old'],referenceDefault);assert.equal(referenceReads['live-new'],referenceDefault);assert.equal(referenceReads['live-default'],referenceDefault);
    assert.equal(await page.evaluate(()=>GameApp.getState().active.tree.children['.reference']),undefined);
    // Upgrade an old browser save: prune metadata snapshots without touching context rows.
    const contextCount=await page.evaluate(()=>GameApp.getState().active.messages.length);
    const legacyId=await page.evaluate(()=>GameApp.getState().active.id);
    await page.evaluate(id=>new Promise((resolve,reject)=>{
      const open=indexedDB.open('trpg-single-player',1);open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{const db=open.result,tx=db.transaction('saves','readwrite'),store=tx.objectStore('saves'),get=store.get(id);
        get.onsuccess=()=>{const s=get.result;s.snapshots=[...Array.from({length:15},()=>structuredClone(s.snapshots[0])),...s.snapshots];store.put(s);};
        tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
      };
    }),legacyId);
    await page.reload();await page.locator('[data-action="open-save"][data-id="'+legacyId+'"]').click();
    await page.waitForFunction(()=>GameApp.getState().active?.snapshots.length===10);
    assert.equal(await page.evaluate(()=>GameApp.getState().active.messages.length),contextCount);
    await page.locator('[data-action="play"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-action="rollback"]')?.textContent==='回溯 (10)');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Browser integration passed: import, start, actions, privacy, DEBUG, edit, changes, prompts, refresh, export/import, mobile. Model calls mocked: '+reqs);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});

