'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),JSZip=require('jszip');
const {chromium}=require('playwright');const ready=require('./designer-ready.cjs');
let server,browser,origin;
before(async()=>{
  const dist=path.resolve(__dirname,'../../dist');
  server=http.createServer((req,res)=>{
    const file=path.resolve(dist,'.'+req.url.split('?')[0]);
    if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();
    fs.readFile(file,(e,data)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(data);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
test('ten round-labelled inputs can be recalled without rollback, and delayed drafts cannot cross rolled-back rounds',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(6000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',r=>r.abort());
  await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async()=>{
    await GameApp.updateSettings({apiKey:'test-only'});
    await GameApp.importSave(new File([ZIP.makeZip([{name:'Player-p/基础信息.json',text:'{"姓名":"玩家"}'},{name:'Player-p/背包.json',text:'[]'}])],'输入记录.zip'));
    const s=GameApp.getState().active;
    for(let i=1;i<=12;i++){GameCore.beginRound(s,'行动'+i);s.round=s.activeRound.number;s.activeRound.complete=true;s.status='waiting';}
    await GameApp.saveDraft('');
  });
  await page.locator('[data-action="input-history"]').click();
  assert.equal(await page.locator('.input-record').count(),10);
  assert.match(await page.locator('.input-record').first().innerText(),/第 12 回合/);
  await page.locator('[data-action="recall-input"][data-round="5"]').click();
  assert.equal(await page.locator('#action-input').inputValue(),'行动5');
  assert.equal(await page.evaluate(()=>GameApp.getState().active.round),12);
  await page.locator('#action-input').fill('即将过期的草稿');
  await page.evaluate(()=>GameApp.rollback());
  await page.waitForFunction(()=>document.querySelector('#action-input').value==='行动12');
  await page.evaluate(()=>GameApp.rollback());
  await page.waitForFunction(()=>document.querySelector('#action-input').value==='行动11');
  await page.waitForTimeout(350);
  await page.waitForFunction(()=>GameApp.getState().active.draft==='行动11');
  await page.reload();await page.locator('[data-action="open-save"]').click();
  await page.waitForFunction(()=>document.querySelector('#action-input')?.value==='行动11');
  await page.locator('[data-action="input-history"]').click();
  assert.equal(await page.locator('.input-record').count(),10);
  assert.match(await page.locator('.input-record').first().innerText(),/第 12 回合.*已回退/);
  assert.deepEqual(errors,[]);
});
test('designer settings downloads only the complete World Builder skill ZIP',async t=>{
  const context=await browser.newContext({acceptDownloads:true});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(6000);
  await page.route('https://**/*',r=>r.abort());await page.goto(origin+'/designer.html');await ready(page);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const section=page.locator('.modal .collapsible').filter({has:page.locator('h3',{hasText:/^Skill$/})});
  if(!(await section.getAttribute('class')).includes('open'))await section.locator('.coll-head').click();
  const buttons=page.locator('.modal [data-skill]').getByRole('button',{name:'下载',exact:true});assert.equal(await buttons.count(),1);
  const downloadPromise=page.waitForEvent('download');await buttons.click();const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'game-world-builder.zip');
  const zip=await JSZip.loadAsync(fs.readFileSync(await download.path()));
  const names=Object.keys(zip.files).filter(n=>!zip.files[n].dir);
  const expected=await page.evaluate(()=>Object.keys(BUNDLED_SKILLS).filter(n=>n.startsWith('skills/game-world-builder/')).map(n=>n.slice('skills/'.length)));
  assert.deepEqual(names.slice().sort(),expected.sort());
  assert.ok(names.every(n=>n.startsWith('game-world-builder/')));
  assert.equal(await zip.file('game-world-builder/SKILL.md').async('string'),fs.readFileSync('skills/game-world-builder/SKILL.md','utf8').replace(/\r\n/g,'\n'));
  assert.ok(zip.file('game-world-builder/scripts/validate_game_structure.js'));
  assert.ok(zip.file('game-world-builder/scripts/world-schema.json'));
  await download.delete();
});
