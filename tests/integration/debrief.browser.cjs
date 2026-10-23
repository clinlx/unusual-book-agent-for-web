'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');let server,browser,origin;
before(async()=>{
  const root=path.resolve(__dirname,'../../dist');server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+req.url.split('?')[0]);if(!file.startsWith(root+path.sep))return res.writeHead(404).end();fs.readFile(file,(e,b)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'application/javascript');res.end(b);});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:process.env.BROWSER_CHANNEL||'msedge'}});
});
after(async()=>{await browser?.close();await new Promise(r=>server?.close(r));});
async function pageFor(t){const c=await browser.newContext({viewport:{width:1280,height:900}});t.after(()=>c.close());const p=await c.newPage();p.setDefaultTimeout(15000);await p.route('**/modules.json',r=>r.fulfill({json:[]}));await p.route('**/files/**',r=>r.abort());return p;}
async function seed(page,multi=false){
  await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async multi=>{
    await GameApp.updateSettings({apiKey:'test',baseUrl:'https://debrief.invalid/v1',stream:false,autoRetry:false});
    const files=(multi?['a','b']:['a']).flatMap(id=>[{name:`Player-${id}/基础信息.json`,text:JSON.stringify({姓名:id})},{name:`Player-${id}/背包.json`,text:'[]'}]);
    await GameApp.importSave(new File([ZIP.makeZip(files)],'复盘.zip'));await GameApp.configureSlots('a');
    if(multi){await GameApp.openRoom();await GameApp.addMember('guest');await GameApp.assignMember('guest','b');}
    const s=GameApp.getState().active;s.status='ended';s.round=2;s.multiplayer.status='ended';s.events=[{id:'end',type:'story',round:2,content:'城门开启，故事落幕。',audience:'public'}];s.snapshots=[{round:1}];await GameApp.saveDraft('');GameApp.setMode('play');
  },multi);
  // Slot-selection UI can have been rendered before the fixture selected its identity.
  await page.evaluate(()=>document.getElementById('modal-root').replaceChildren());
  await page.locator('[data-action="start-debrief"]').waitFor();
}
test('confirmation, irreversible mode, usable composer, bounded tool set and persisted continuation',async t=>{
  const p=await pageFor(t),errors=[],requests=[];p.on('pageerror',e=>errors.push(e.message));let fail=false;
  await p.route('https://debrief.invalid/**',r=>{requests.push(r.request().postDataJSON());return fail?r.fulfill({status:503,body:'暂时断网'}):r.fulfill({json:{choices:[{message:{role:'assistant',content:requests.length===1?'我是这次故事的主持人，欢迎一起复盘。':'主持人回答：城门是最后的线索。'},finish_reason:'stop'}]}});});
  await seed(p);await p.locator('[data-action="start-debrief"]').click();
  const dialog=p.locator('#dialog-root');assert.match(await dialog.innerText(),/token 消耗/);assert.match(await dialog.innerText(),/不能再回溯/);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(requests.length,0);assert.equal(await p.evaluate(()=>!!GameApp.getState().active.debrief),false);
  await p.locator('[data-action="start-debrief"]').click();await dialog.getByRole('button',{name:'开启复盘',exact:true}).click();
  await p.waitForFunction(()=>GameApp.getState().active.debrief?.status==='waiting');
  assert.deepEqual(requests[0].tools.map(t=>t.function.name),['read_file','list_dir','search']);assert.match(requests[0].messages[0].content,/主持人/);
  assert.equal(await p.locator('#debrief-input').isEnabled(),true);assert.equal(await p.locator('#hidden-send-toggle,#disguise-send-toggle').count(),0);assert.equal(await p.locator('[data-action="imprint-character"]').count(),2);assert.equal(await p.locator('[data-action="rollback"]').count(),0);
  await p.locator('#debrief-input').fill('第一句');await p.locator('#debrief-form button[type="submit"]').click();
  await p.locator('#debrief-input').fill('补充第二句');await p.locator('#debrief-input').press('Control+Enter');
  await p.waitForFunction(()=>GameApp.getState().active.debrief.events.filter(e=>e.role==='user').length===2);assert.equal(requests.length,1);
  await p.waitForFunction(()=>GameApp.getState().active.debrief.events.filter(e=>e.role==='assistant').length===2);
  const input=requests[1].messages.find(m=>m.role==='user'&&m.content.startsWith('{'));assert.deepEqual(JSON.parse(input.content).messages.map(m=>m.content),['第一句','补充第二句']);
  fail=true;await p.locator('#debrief-input').fill('这次会断网');await p.locator('#debrief-form button[type="submit"]').click();await p.locator('[data-action="resume"]').waitFor();
  const id=await p.evaluate(()=>GameApp.getState().active.id);await p.reload();await p.locator('[data-action="open-save"]').first().click();await p.locator('[data-action="resume"]').waitFor();
  assert.equal(await p.evaluate(()=>GameApp.getState().active.id),id);assert.equal(await p.locator('#debrief-input').isEnabled(),true);assert.equal(await p.locator('[data-action="start-debrief"]').count(),0);
  fail=false;await p.locator('[data-action="resume"]').click();await p.waitForFunction(()=>GameApp.getState().active.debrief.status==='waiting');assert.equal(await p.evaluate(()=>GameApp.getState().active.debrief.events.filter(e=>e.content==='这次会断网').length),1);
  assert.match(await p.locator('#history').innerText(),/城门开启，故事落幕/);
  const fold=p.locator('[data-debrief-fold]');await fold.locator('summary').click();assert.equal(await fold.getAttribute('open'),null);
  await p.evaluate(()=>GameApp.setMode('play'));assert.equal(await fold.getAttribute('open'),null);
  await p.locator('[data-action="imprint-character"]').first().click();await p.locator('#app-prompt-input').waitFor();await p.locator('[data-dialog-cancel]').click();
  await p.locator('.info-footer [data-action="imprint-character"]').click();await p.locator('#app-prompt-input').fill('复盘后的角色');await p.locator('#app-prompt-form button[type="submit"]').click();
  await p.waitForFunction(()=>document.querySelector('.info-footer [data-action="rollback"]')?.disabled);
  assert.equal(await p.locator('[data-action="imprint-character"]').count(),1);assert.equal(await p.locator('[data-action="imprint-character"]').isDisabled(),true);
  assert.equal(await fold.getAttribute('open'),null,'imprint updates do not unfold discussion');
  const html=await p.evaluate(()=>GamePresentation.historyHTML(GameApp.exportView(),t=>MD.render(t),GameApp.player()));
  const archive=await p.context().newPage();await archive.setContent(html);await archive.locator('[data-mode="overview"]').click();
  const archived=archive.locator('.archive-debrief');await archived.locator('summary').click();assert.match(await archived.innerText(),/第一句/);assert.match(await archived.innerText(),/主持人回答/);
  assert.match(await archive.locator('#archive-history').innerText(),/城门开启，故事落幕/);
  assert.deepEqual(errors,[]);
});
test('a guest can speak repeatedly during processing, private scheduled messages promote only after the answer',async t=>{
  const host=await pageFor(t),guest=await pageFor(t),errors=[],requests=[];for(const p of [host,guest])p.on('pageerror',e=>errors.push(e.message));let held;
  await host.route('https://debrief.invalid/**',r=>{requests.push(r.request().postDataJSON());if(requests.length===2){held=r;return;}return r.fulfill({json:{choices:[{message:{content:'我是主持人，欢迎复盘。'},finish_reason:'stop'}]}});});
  await seed(host,true);await guest.goto(origin+'/client.html');await guest.locator('#join-room-form').waitFor();
  await host.exposeFunction('deliverDebrief',(id,packet)=>guest.evaluate(p=>GameApp.receive(p),packet));
  await guest.exposeFunction('sendDebrief',(id,command)=>host.evaluate(({id,command})=>window.onDebriefCommand(id,command),{id,command}));
  await host.evaluate(()=>GameApp.attachMultiplayerTransport({onHost(fn){window.onDebriefCommand=fn;return()=>{};},sendToClient:(id,p)=>window.deliverDebrief(id,p)}));
  await guest.evaluate(()=>GameApp.connect({onClient(){return()=>{};},sendToHost:(id,p)=>window.sendDebrief(id,p)},'guest'));
  await host.locator('[data-action="start-debrief"]').click();await host.locator('#dialog-root').getByRole('button',{name:'开启复盘',exact:true}).click();
  await guest.locator('#debrief-input').waitFor();await guest.waitForFunction(()=>GameApp.getState().active.debrief.status==='waiting');
  await guest.locator('#debrief-input').fill('客人的问题');await guest.locator('#debrief-form button[type="submit"]').click();
  await host.waitForFunction(()=>GameApp.getState().active.debrief.status==='running');await guest.waitForFunction(()=>GameApp.getState().running);
  for(const text of ['下一批甲','下一批乙']){await guest.locator('#debrief-input').fill(text);await guest.locator('#debrief-form button[type="submit"]').click();}
  await guest.waitForFunction(()=>GameApp.getState().active.debrief.queued.length===2);
  assert.equal(await guest.locator('#debrief-input').isEnabled(),true);assert.equal(await host.locator('.debrief-queued').count(),0);await guest.locator('.debrief-queued').nth(1).waitFor();assert.equal(await guest.locator('.debrief-queued').count(),2);
  await guest.locator('.debrief-queued [data-action="cancel-debrief"]').first().click();await guest.waitForFunction(()=>GameApp.getState().active.debrief.queued.length===1);
  await held.fulfill({json:{choices:[{message:{content:'上一批回答完成。'},finish_reason:'stop'}]}});
  await guest.waitForFunction(()=>GameApp.getState().active.debrief.events.some(e=>e.content==='下一批乙'));
  assert.equal(requests.length,2);await guest.waitForFunction(()=>GameApp.getState().active.debrief.events.filter(e=>e.role==='assistant').length===3);
  assert.deepEqual(JSON.parse(requests[2].messages.findLast(m=>m.role==='user'&&m.content.startsWith('{')).content).messages.map(m=>m.content),['下一批乙']);
  assert.equal(await host.evaluate(()=>GameApp.getState().active.round),2);assert.deepEqual(errors,[]);
});
