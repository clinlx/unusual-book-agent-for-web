'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const readyDesigner = require('./designer-ready.cjs');
const dist = path.resolve(__dirname, '../../dist');
const artifacts = path.resolve(__dirname, '../artifacts');
let server, browser, origin;

before(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(dist + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js')?'text/javascript; charset=utf-8':'text/plain; charset=utf-8');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH }
    : { channel: process.env.BROWSER_CHANNEL || 'msedge' }), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openSettings(page, name) {
  await page.route('**/modules.json',route=>route.fulfill({json:[]}));
  await page.route('**/files/**',route=>route.abort());
  await page.goto(origin + '/' + (name === 'game' ? 'index.html' : 'designer.html'));
  if (name === 'game') await page.locator('[data-action="settings"]').click();
  else {
    await readyDesigner(page);
    await page.getByRole('button', { name: '设置', exact: true }).click();
  }
}

test('both frontends persist retry settings and gate child fields behind the opt-in switch',async()=>{
  for(const name of ['game','designer']){
    const context=await browser.newContext();
    try{
      const page=await context.newPage();await page.route('https://**/*',r=>r.abort());
      await openSettings(page,name);
      const toggle=page.locator(name==='game'?'[name="autoRetry"]':'#settingsAutoRetry');
      const failures=page.locator(name==='game'?'[name="maxConsecutiveFailures"]':'[aria-label="最大连续失败次数"]');
      const cooldown=page.locator(name==='game'?'[name="retryCooldownSeconds"]':'[aria-label="重试冷却时间（秒）"]');
      assert.equal(await toggle.isChecked(),false);assert.equal(await failures.inputValue(),'3');assert.equal(await cooldown.inputValue(),'5');
      assert.equal(await failures.isDisabled(),true);assert.equal(await cooldown.isDisabled(),true);
      await toggle.check();await failures.fill('4');await cooldown.fill('0.5');
      await page.getByRole('button',{name:name==='game'?'保存设置':'保存',exact:true}).click();
      await page.locator(name==='game'?'#settings-form':'.overlay').waitFor({state:'detached'});
      await openSettings(page,name);
      assert.equal(await toggle.isChecked(),true);assert.equal(await failures.inputValue(),'4');assert.equal(await cooldown.inputValue(),'0.5');
      await toggle.uncheck();assert.equal(await failures.isDisabled(),true);
      await page.getByRole('button',{name:name==='game'?'保存设置':'保存',exact:true}).click();
      await page.locator(name==='game'?'#settings-form':'.overlay').waitFor({state:'detached'});
      await openSettings(page,name);assert.equal(await toggle.isChecked(),false);assert.equal(await failures.inputValue(),'4');
    }finally{await context.close();}
  }
});

test('designer displays retry cooldown, recovers the same turn and can stop while waiting',async()=>{
  const context=await browser.newContext();
  try{
    const page=await context.newPage();await page.route('https://**/*',r=>r.abort());
    await openSettings(page,'designer');await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.evaluate(()=>Object.assign(__UI_STATE__.settings,{apiKey:'test',baseUrl:'https://retry.invalid/v1',autoRetry:true,maxConsecutiveFailures:3,retryCooldownSeconds:.5,stream:false}));
    let count=0,alwaysFail=false;
    await page.route('https://retry.invalid/**',route=>{
      count++;
      return alwaysFail||count===1?route.fulfill({status:503,body:'busy'}):route.fulfill({json:{choices:[{message:{content:'自动重试恢复成功'},finish_reason:'stop'}]}});
    });
    await page.locator('#chatInput').fill('测试自动重试');await page.locator('#sendBtn').click();
    await page.getByText('请求连续失败 1/3 次，0.5 秒后自动重试，可随时停止。',{exact:true}).waitFor();
    await page.waitForFunction(()=>!__UI_STATE__.running);
    assert.equal(count,2);assert.equal(await page.getByText('自动重试恢复成功',{exact:true}).count(),1);
    alwaysFail=true;
    await page.evaluate(()=>__UI_STATE__.settings.retryCooldownSeconds=5);
    await page.locator('#chatInput').fill('测试等待期间停止');await page.locator('#sendBtn').click();
    await page.getByText('请求连续失败 1/3 次，5 秒后自动重试，可随时停止。',{exact:true}).waitFor();
    await page.locator('#sendBtn').click();await page.waitForFunction(()=>!__UI_STATE__.running);
    assert.equal(count,3);assert.equal(await page.locator('#chatInput').isEditable(),true);
  }finally{await context.close();}
});

test('game shows cooldown, completes after retry, and preserves an interrupted round when stopped',async()=>{
  const context=await browser.newContext();
  try{
    const page=await context.newPage();await page.route('https://**/*',r=>r.abort());await openSettings(page,'game');
    await page.locator('[data-action="close-modal"]').first().click();
    await page.evaluate(async()=>{
      const zip=ZIP.makeZip([{name:'Player-p/基础信息.json',text:'{"姓名":"玩家"}'},{name:'Player-p/背包.json',text:'[]'}]);
      await GameApp.importSave(new File([zip],'重试.zip'));
      await GameApp.updateSettings({baseUrl:'https://retry.invalid/v1',apiKey:'test',stream:false,autoRetry:true,maxConsecutiveFailures:3,retryCooldownSeconds:.5});
    });
    await page.locator('[data-action="slot-choose"][data-actor="p"]').click();await page.locator('[data-action="slot-confirm"]').click();
    let count=0,alwaysFail=false;
    await page.route('https://retry.invalid/**',route=>{
      count++;
      const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
      return alwaysFail||count===1?route.fulfill({status:503,body:'busy'}):route.fulfill({json:{choices:[{message:{tool_calls:[
        call('story','append_story',{content:'自动重试继续旅程',one_line_summary_of_content:'继续',self_accept:true}),
        call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]},finish_reason:'stop'}]}});
    });
    await page.evaluate(()=>{window.retryRun=GameApp.start().catch(()=>{});});
    await page.getByText('请求连续失败 1/3 次，0.5 秒后自动重试，可随时停止。').waitFor();
    await page.evaluate(()=>window.retryRun);
    assert.equal(count,2);
    assert.equal(await page.evaluate(()=>GameApp.getState().active.events.filter(e=>e.type==='story').length),1);
    alwaysFail=true;await page.evaluate(async()=>{await GameApp.updateSettings({retryCooldownSeconds:5});window.retryRun=GameApp.send('继续').catch(()=>{});});
    await page.getByText('请求连续失败 1/3 次，5 秒后自动重试，可随时停止。').waitFor();
    await page.locator('[data-action="abort"]').first().click();await page.evaluate(()=>window.retryRun);
    assert.equal(count,3);assert.equal(await page.evaluate(()=>GameApp.getState().active.status),'interrupted');
    assert.equal(await page.locator('[data-action="resume"]').first().isEnabled(),true);
  }finally{await context.close();}
});

test('game and client notifications request permission only on opt-in and persist independently',async()=>{
 const context=await browser.newContext();
 try{
  const page=await context.newPage();page.setDefaultTimeout(5000);
  await page.route('https://**/*',r=>r.abort());await page.route('**/modules.json',r=>r.fulfill({json:[]}));await page.route('**/files/**',r=>r.abort());
  await page.addInitScript(()=>{window.noticePrompts=0;window.noticeAnswer='granted';Object.defineProperty(window,'Notification',{configurable:true,value:class{static permission='default';static async requestPermission(){window.noticePrompts++;return this.permission=window.noticeAnswer;}}});});
  for(const file of ['index.html','client.html']){
   await page.goto(origin+'/'+file);await page.locator('[data-action="settings"]').click();
   const toggle=page.locator('[name="roundNotifications"]');
   if(file==='index.html')await page.locator('[data-settings-section="game"]').evaluate(el=>el.open=true);
   assert.equal(await toggle.isChecked(),false);assert.equal(await page.evaluate(()=>noticePrompts),0);
   await toggle.check();await page.waitForFunction(()=>!document.querySelector('[name="roundNotifications"]').disabled);
   assert.equal(await page.evaluate(()=>noticePrompts),1);await page.getByRole('button',{name:'保存设置',exact:true}).click();
   await page.locator('#settings-form').waitFor({state:'detached'});
   await page.reload();await page.locator('[data-action="settings"]').click();assert.equal(await toggle.isChecked(),true);assert.equal(await page.evaluate(()=>noticePrompts),0);
   if(file==='index.html')await page.locator('[data-settings-section="game"]').evaluate(el=>el.open=true);
   await toggle.uncheck();await page.evaluate(()=>{Notification.permission='default';noticeAnswer='denied';});await toggle.click();
   await page.waitForFunction(()=>!document.querySelector('[name="roundNotifications"]').disabled);
   assert.equal(await toggle.isChecked(),false);assert.match(await page.locator('[data-notification-status]').innerText(),/阻止/);
   await page.getByRole('button',{name:'保存设置',exact:true}).click();
  }
 }finally{await context.close();}
});

test('client dice preference follows host settings and shares live state across tabs',async()=>{
 const Sync=require('../../src/multiplayer-sync'),VFS=require('../../src/vfs');
 const context=await browser.newContext({viewport:{width:390,height:844}}),errors=[];
 try{
  const pages=[],rooms=[],hosts=[];
  for(let i=0;i<2;i++){
   const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-a/基础信息.json','{"姓名":"测试者"}');VFS.writeFile(tree,'/workspace/Player-a/背包.json','[]');
   const save={id:'dice-game-'+i,name:'掷骰测试',tree,slots:[{id:'a',path:'/workspace/Player-a',kind:'player'}],round:1,status:'waiting',events:[]};
   const room={roomId:'dice-room-'+i,roundId:'r2',epoch:0,round:2,status:'collecting',online:true,manualDice:i===1,members:{guest:{actorId:'a',bindingVersion:1}}};
   const host=Sync.createHost({getSave:()=>save,getRoom:()=>room});rooms.push(room);hosts.push(host);
   const page=await context.newPage();pages.push(page);page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',r=>r.abort());
   await page.exposeFunction('diceHostRequest',async command=>{
    if(command.type==='sync.ack')return null;
    if(command.type==='sync.request')return host.sync('guest',command.payload);
    assert.equal(command.type,'dice.preference');room.members.guest.skipManualDice=command.payload.skip;
    return {type:'command.result',requestId:command.requestId,ok:true};
   });
   await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();
   await page.evaluate(async()=>{
    let receive;await GameApp.connect({onClient(id,fn){receive=fn;return()=>{};},async sendToHost(id,command){const packet=await diceHostRequest(command);if(packet)await receive(packet);}},'guest');
   });
   await page.locator('[data-action="settings"]').click();
  }
  const selector='[name="skipMultiplayerManualDice"]';
  assert.equal(await pages[0].locator(selector).count(),0);assert.equal(await pages[1].locator(selector).isChecked(),false);
  rooms[0].manualDice=true;await pages[0].evaluate(packet=>GameApp.receive(packet),await hosts[0].sync('guest'));
  await pages[0].locator(selector).waitFor();await pages[0].locator(selector).check();await pages[0].locator('#settings-form [type="submit"]').click();
  await pages[1].waitForFunction(()=>GameApp.getState().settings.skipMultiplayerManualDice&&GameApp.getState().room.skipManualDice);
  await pages[1].waitForFunction(()=>document.querySelector('[name="skipMultiplayerManualDice"]').checked);
  assert.equal(rooms[0].members.guest.skipManualDice,true);assert.equal(rooms[1].members.guest.skipManualDice,true);
  await pages[0].locator('[data-action="settings"]').click();rooms[0].manualDice=false;
  await pages[0].evaluate(packet=>GameApp.receive(packet),await hosts[0].sync('guest'));await pages[0].locator(selector).waitFor({state:'detached'});
  await pages[0].locator('#settings-form [type="submit"]').click();assert.equal(await pages[0].evaluate(()=>GameApp.getState().settings.skipMultiplayerManualDice),true);
  for(const width of [320,390,900]){
   await pages[1].setViewportSize({width,height:844});assert.ok(await pages[1].evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const footer=await pages[1].locator('#settings-form [type="submit"]').boundingBox();assert.ok(footer.y+footer.height<=844);
  }
  await pages[1].setViewportSize({width:390,height:844});await pages[1].screenshot({path:path.join(artifacts,'client-dice-preference-390.png')});assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('mobile notification fallback activates the local worker without issuing a real system notification',async()=>{
 const context=await browser.newContext();
 try{
  const page=await context.newPage();await page.route('https://**/*',r=>r.abort());await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();
  const result=await page.evaluate(async()=>{
   const sent=[];Object.defineProperty(window,'Notification',{configurable:true,value:class{static permission='granted';constructor(){throw TypeError('mobile');}}});
   ServiceWorkerRegistration.prototype.showNotification=async function(title,options){sent.push({title,options,active:this.active?.state});};
   const ok=await RoundNotifications.send({round:3,tag:'test-round-3'});return {ok,sent};
  });
  assert.equal(result.ok,true);assert.equal(result.sent.length,1);assert.equal(result.sent[0].active,'activated');assert.match(result.sent[0].options.body,/第 3 回合/);
 }finally{await context.close();}
});

test('designer maximum output defaults to 16k, validates input and persists custom values',async()=>{
  const context=await browser.newContext();
  try{
    const page=await context.newPage();await page.route('https://**/*',route=>route.abort());
    await openSettings(page,'designer');
    const input=page.getByRole('spinbutton',{name:'最大输出 tokens',exact:true});
    assert.equal(await input.count(),1);assert.equal(await input.inputValue(),'16384');
    for(const invalid of ['0','-1','1.5']){
      await input.fill(invalid);await page.getByRole('button',{name:'保存',exact:true}).click();
      assert.equal(await input.isVisible(),true);
      assert.equal(await page.evaluate(()=>__UI_STATE__.settings.maxOutputTokens),16384);
    }
    await input.fill('32768');await page.getByRole('button',{name:'保存',exact:true}).click();
    await page.getByRole('button',{name:'保存',exact:true}).waitFor({state:'hidden'});
    await page.reload();await readyDesigner(page);
    assert.equal(await page.evaluate(()=>__UI_STATE__.settings.maxOutputTokens),32768);
    await page.getByRole('button',{name:'设置',exact:true}).click();
    assert.equal(await input.inputValue(),'32768');
    await page.evaluate(async()=>{const value={...__UI_STATE__.settings};delete value.maxOutputTokens;await DB.put('config',{id:'settings',value});});
    await page.reload();await readyDesigner(page);
    assert.equal(await page.evaluate(()=>__UI_STATE__.settings.maxOutputTokens),16384);
  }finally{await context.close();}
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  for (const name of ['game', 'designer']) {
    test(name + ' request help is visible immediately and toggles with mouse and keyboard at width ' + viewport.width, async () => {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        await page.route('https://**/*', route => route.abort());
        await openSettings(page, name);
        const button = page.locator('.api-settings-heading button');
        const panel = page.locator('#api-options-help');
        assert.equal(await button.count(), 1, 'both settings pages have a request help button');
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
        assert.equal(await panel.isHidden(), true);
        await button.click();
        assert.equal(await button.getAttribute('aria-expanded'), 'true');
        assert.equal(await panel.isVisible(), true);
        const inView = await panel.evaluate(panel => {
          const text = panel.querySelector('p').getBoundingClientRect();
          const clip = panel.closest('.modal-body, .modal').getBoundingClientRect();
          return text.top >= Math.max(0, clip.top) && text.top < Math.min(innerHeight, clip.bottom);
        });
        assert.equal(inView, true, 'clicking i exposes the explanation inside the visible settings area');
        await page.screenshot({ path: path.join(artifacts, 'settings-' + name + '-' + viewport.width + '.png') });
        await button.press('Enter');
        assert.equal(await panel.isHidden(), true);
        await button.press('Space');
        assert.equal(await panel.isVisible(), true);
        await button.click();
        assert.equal(await panel.isHidden(), true);
      } finally { await context.close(); }
    });
  }
}

for (const name of ['game', 'designer']) {
  test(name + ' connection test, model listing and saved requests accept a complete chat endpoint', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    try {
      const page = await context.newPage(), urls = [], errors = [];
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => Object.defineProperty(HTMLSelectElement.prototype, 'showPicker', { configurable: true, value: undefined }));
      await page.route('https://**/*', async route => {
        const url = route.request().url();
        if (!url.startsWith('https://settings.invalid/')) return route.abort();
        urls.push(url);
        const models = url === 'https://settings.invalid/gateway/v1/models';
        const chat = url === 'https://settings.invalid/gateway/v1/chat/completions';
        await route.fulfill({ status: models || chat ? 200 : 404, contentType: 'application/json',
          body: JSON.stringify(models ? { data: [{ id: 'settings-test' }, { id: 'settings-test-plus' }, { id: 'other-provider/model' }, { id: 'not-settings-test' }] }
            : { choices: [{ message: { content: 'OK' } }] }) });
      });
      await openSettings(page, name);
      const field = label => page.locator('.modal .row').filter({ has: page.locator('label', { hasText: new RegExp('^' + label + '$') }) }).locator('input');
      const base = name === 'game' ? page.locator('[name="baseUrl"]') : field('API Base URL');
      const key = name === 'game' ? page.locator('[name="apiKey"]') : field('API Key');
      const model = name === 'game' ? page.locator('[name="model"]') : field('模型');
      await key.fill('test-only');
      await model.fill('settings-test');
      for (const suffix of ['/chat/completions', '/chat/completions///']) {
        await base.fill('https://settings.invalid/gateway/v1' + suffix);
        await page.getByRole('button', { name: '测试连接', exact: true }).click();
        const result = page.locator(name === 'game' ? '#connection-result' : '.api-test-result');
        await result.filter({ hasText: /连接成功/ }).waitFor();
        await (name === 'game' ? page.locator('[data-action="fetch-models"]')
          : page.getByRole('button', { name: '从接口获取模型列表' })).click();
        const picker = page.getByRole('combobox', { name: '选择模型', exact: true });
        await picker.waitFor();
        assert.equal(await model.inputValue(), 'settings-test', 'fetching models preserves the typed model');
        const completionValues = () => model.evaluate(input => Array.from(document.getElementById(input.getAttribute('list')).options, option => option.value));
        assert.deepEqual(await completionValues(), ['settings-test', 'settings-test-plus'], 'automatic completion uses the typed prefix');
        await model.fill('other-');
        assert.deepEqual(await completionValues(), ['other-provider/model']);
        await model.fill('settings-test');
        const joined = await model.evaluate(input => {
          const group = input.closest('.model-picker'), arrow = group.querySelector('select');
          const a = input.getBoundingClientRect(), b = arrow.getBoundingClientRect();
          return { sameField: !!group, gap: Math.abs(a.right - b.left), arrowWidth: b.width,
            inputBorder: getComputedStyle(input).borderLeftWidth, arrowBorder: getComputedStyle(arrow).borderRightWidth };
        });
        assert.equal(joined.sameField, true);
        assert.ok(joined.gap <= 1 && joined.arrowWidth <= 36);
        assert.equal(joined.inputBorder, '0px');
        assert.equal(joined.arrowBorder, '0px');
        await picker.click();
        await page.getByRole('listbox').getByRole('option', { name: 'other-provider/model', exact: true }).click();
        assert.equal(await model.inputValue(), 'other-provider/model', 'a different model family remains selectable with an existing value');
        await picker.click();
        await page.getByRole('listbox').getByRole('option', { name: 'settings-test', exact: true }).click();
        assert.equal(await model.inputValue(), 'settings-test', 'the full list can be reopened after selection');
      }
      await model.fill('custom-unlisted-model');
      await page.getByRole('button', { name: name === 'game' ? '保存设置' : '保存', exact: true }).click();
      await page.getByRole('button', { name: name === 'game' ? '保存设置' : '保存', exact: true }).waitFor({ state: 'hidden' });
      await page.reload();
      if (name === 'game') {
        await page.locator('[data-action="settings"]').waitFor();
        await page.evaluate(() => GameTransport.create({ ...GameApp.getState().settings, stream: false }, [])([{ role: 'user', content: 'hello' }]));
      } else {
        await readyDesigner(page);
        await page.evaluate(() => Agent.createHttpTransport({ ...__UI_STATE__.settings, stream: false }, [])([{ role: 'user', content: 'hello' }]));
      }
      assert.equal(await page.evaluate(name => name === 'game' ? GameApp.getState().settings.model : __UI_STATE__.settings.model, name), 'custom-unlisted-model', 'manual model names still persist');
      assert.equal(urls.length, 5);
      assert.deepEqual(urls, [
        'https://settings.invalid/gateway/v1/chat/completions', 'https://settings.invalid/gateway/v1/models',
        'https://settings.invalid/gateway/v1/chat/completions', 'https://settings.invalid/gateway/v1/models',
        'https://settings.invalid/gateway/v1/chat/completions',
      ]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const name of ['game', 'designer']) {
  test(name + ' shortcut inversion is explained, persisted, and works in the actual composer', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      let requests = 0;
      await page.route('https://**/*', async route => {
        if (!route.request().url().startsWith('https://shortcuts.invalid/')) return route.abort();
        requests++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '已接收' } }] }) });
      });
      await openSettings(page, name);
      if (name === 'game') await page.locator('[data-settings-section="game"] > summary').click();
      const checkbox = name === 'game' ? page.locator('[name="reverseSendNewline"]') : page.getByRole('checkbox', { name: '反转发送与换行' });
      assert.equal(await checkbox.isChecked(), false);
      if (name === 'designer') {
        await checkbox.evaluate(el => Promise.all(el.closest('.modal').getAnimations().map(animation => animation.finished)));
        const appearance = await checkbox.evaluate(el => ({ appearance: getComputedStyle(el).appearance,
          width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
        assert.equal(appearance.appearance, 'auto', 'native checkbox must retain its visible checkmark');
        assert.equal(appearance.width, 18); assert.equal(appearance.height, 18);
        await page.locator('label[for="settingsReverseSendNewline"]').click();
        assert.equal(await checkbox.isChecked(), true, 'clicking the setting label toggles the checkbox');
        await checkbox.press('Space'); assert.equal(await checkbox.isChecked(), false);
      }
      const explanation = await page.locator(name === 'game' ? '#settings-form' : '.modal').innerText();
      assert.match(explanation, /默认.*发送.*换行.*开启后.*发送.*换行/);
      if (name === 'game') assert.equal(await page.locator('[data-action="prompts"]').count(), 0);
      await checkbox.check();
      if (name === 'designer') {
        const field = text => page.locator('.modal .row').filter({ has: page.locator('label', { hasText: new RegExp('^' + text + '$') }) }).locator('input');
        await field('API Base URL').fill('https://shortcuts.invalid/v1');
        await field('API Key').fill('test-only');
        await page.locator('.modal .row').filter({ has: page.locator('label', { hasText: /^流式输出$/ }) }).locator('select').selectOption('0');
      }
      await page.getByRole('button', { name: name === 'game' ? '保存设置' : '保存', exact: true }).click();
      await page.locator(name === 'game' ? '#settings-form' : '.overlay').waitFor({state:'detached'});
      await page.reload();
      if (name === 'designer') await readyDesigner(page);
      else await page.locator('[data-action="settings"]').waitFor();
      assert.equal(await page.evaluate(name => name === 'game' ? GameApp.getState().settings.reverseSendNewline : __UI_STATE__.settings.reverseSendNewline, name), true);
      if (name === 'game') {
        await page.evaluate(async () => {
          const zip = ZIP.makeZip([{ name: 'Player-pc/基础信息.json', text: '{"姓名":"测试"}' }, { name: 'Player-pc/背包.json', text: '[]' }]);
          await GameApp.importSave(new File([zip], '快捷键.zip'));
          GameApp.getState().active.status = 'waiting';
          GameApp.setMode('play');
        });
        const input = page.locator('#action-input');
        await page.waitForFunction(() => document.querySelector('#action-input') && !document.querySelector('#action-input').disabled);
        await page.evaluate(() => {
          window.__shortcutSubmits = 0;
          document.querySelector('#action-form').onsubmit = event => { event.preventDefault(); event.stopPropagation(); window.__shortcutSubmits++; };
        });
        await input.fill('第一行'); await input.press('Control+Enter');
        assert.equal(await input.inputValue(), '第一行\n');
        assert.equal(await page.evaluate(() => __shortcutSubmits), 0);
        await input.press('Enter');
        assert.equal(await page.evaluate(() => __shortcutSubmits), 1);
        const defaults = await page.evaluate(() => {
          GameApp.getState().settings.promptOverrides['reference/游戏前准备.md'] = '旧覆盖';
          GameApp.getState().settings.promptOverrides['system/host.md'] = '忽略此旧系统覆盖';
          return { actual: GameApp.readFile('/.reference/游戏前准备.md'), expected: Prompts.get('reference/游戏前准备.md'), editable: typeof GameApp.savePrompt,
            system: GameApp.currentContext().find(message => message.role === 'system').content, expectedSystem: Prompts.buildSystem() };
        });
        assert.equal(defaults.actual, defaults.expected);
        assert.equal(defaults.editable, 'undefined');
        assert.equal(defaults.system, defaults.expectedSystem);
        const colors = await page.evaluate(() => {
          const box = document.createElement('div');
          box.innerHTML = GamePresentation.fields([{ 名称: '新增测试', 余量: 1 }], [], 'test');
          document.body.append(box);
          const tag = box.querySelector('.change-tag.added'), style = getComputedStyle(tag);
          return { text: tag.textContent, radius: style.borderRadius, background: style.backgroundColor, display: style.display };
        });
        assert.deepEqual(colors, { text: '新增', radius: '999px', background: 'rgb(229, 240, 228)', display: 'inline-flex' });
        await page.evaluate(() => GameApp.updateSettings({ reverseSendNewline: false }));
        await page.waitForFunction(() => document.querySelector('.composer-bottom').textContent.includes('Ctrl / ⌘ + Enter 发送'));
        await page.evaluate(() => {
          window.__shortcutSubmits = 0;
          document.querySelector('#action-form').onsubmit = event => { event.preventDefault(); event.stopPropagation(); window.__shortcutSubmits++; };
        });
        await input.fill('恢复默认'); await input.press('Enter');
        assert.equal(await input.inputValue(), '恢复默认\n');
        assert.equal(await page.evaluate(() => __shortcutSubmits), 0);
        await input.press('Control+Enter');
        assert.equal(await page.evaluate(() => __shortcutSubmits), 1);
      } else {
        const input = page.locator('#chatInput');
        await input.fill('第一行'); await input.press('Control+Enter');
        assert.equal(requests, 0);
        await input.press('Enter');
        await page.waitForFunction(() => !__UI_STATE__.running && __UI_STATE__.tree);
        await page.waitForTimeout(100);
        assert.equal(requests, 1);
        await page.evaluate(() => { __UI_STATE__.settings.reverseSendNewline = false; });
        await input.fill('恢复默认'); await input.press('Enter');
        assert.equal(requests, 1);
        await input.press('Control+Enter');
        await page.waitForFunction(() => !__UI_STATE__.running);
        await page.waitForTimeout(100);
        assert.equal(requests, 2);
      }
    } finally { await context.close(); }
  });
}


test('client settings use invitation routing and a compact shortcut card with a fixed footer',async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  try{
    const page=await context.newPage();page.setDefaultTimeout(5000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://**/*',route=>route.abort());
    await page.route('**/modules.json',route=>route.fulfill({json:[]}));await page.route('**/files/**',route=>route.abort());
    await page.goto(origin+'/client.html');await page.locator('#join-room-form').waitFor();
    await page.evaluate(()=>localStorage.setItem('trpg-client-settings',JSON.stringify({bridgeUrl:'wss://obsolete.invalid/',reverseSendNewline:false})));
    await page.reload();await page.locator('[data-action="settings"]').click();
    assert.equal(await page.locator('[name="bridgeUrl"]').count(),0);assert.equal(await page.locator('.settings-section').count(),0);
    assert.deepEqual(await page.evaluate(()=>GameApp.getState().settings),{reverseSendNewline:false,roundNotifications:false,skipMultiplayerManualDice:false});
    const toggle=page.getByRole('checkbox',{name:'反转发送与换行'});
    assert.deepEqual(await page.locator('.client-shortcut-preview kbd').allTextContents(),['Ctrl / ⌘ + Enter','Enter']);
    await toggle.check();assert.deepEqual(await page.locator('.client-shortcut-preview kbd').allTextContents(),['Enter','Ctrl / ⌘ + Enter']);
    await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.evaluate(()=>GameApp.getState().settings.reverseSendNewline),false);
    await page.locator('[data-action="settings"]').click();await toggle.check();await page.getByRole('button',{name:'保存设置',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('trpg-client-settings'))),{reverseSendNewline:true,roundNotifications:false,skipMultiplayerManualDice:false});
    await page.reload();await page.locator('[data-action="settings"]').click();assert.equal(await toggle.isChecked(),true);
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:700});
      const bounds=await page.locator('.client-settings-modal').boundingBox();assert.ok(bounds.width<=480);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.equal(await page.locator('.modal-actions').evaluate(el=>!el.closest('.modal-body')),true);
      const footer=await page.locator('.modal-actions').boundingBox();assert.ok(footer.y+footer.height<=700);
      const label=await page.locator('.client-shortcut-toggle span').boundingBox(),switchBox=await toggle.boundingBox();assert.ok(Math.abs(label.y+label.height/2-switchBox.y-switchBox.height/2)<2,'toggle stays beside its label');assert.equal(switchBox.height,22);
      await page.screenshot({path:path.join(artifacts,'client-settings-'+width+'.png')});
    }
    await openSettings(page,'game');assert.equal(await page.locator('[name="bridgeUrl"]').count(),1,'hosts still configure the server for their invitations');assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
