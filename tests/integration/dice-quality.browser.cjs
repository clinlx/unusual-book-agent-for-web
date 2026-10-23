'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
let browser,server,origin;
before(async()=>{
 const root=path.resolve(__dirname,'../../dist');
 server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!file.startsWith(root+path.sep))return res.writeHead(404).end();fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'text/plain');res.end(data);});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
test('host and client quality selectors persist locally across reloads',async()=>{
 for(const file of ['index.html','client.html']){
  const context=await browser.newContext();try{
   const page=await context.newPage();await page.route('https://**/*',route=>route.abort());await page.route('**/modules.json',route=>route.fulfill({json:[]}));
   await page.goto(origin+'/'+file);await page.locator('[data-action="settings"]').click();
   if(file==='index.html')await page.locator('[data-settings-section="game"]').evaluate(el=>el.open=true);
   const select=page.locator('[name="diceQuality"]');assert.equal(await select.inputValue(),'standard');assert.equal(await select.locator('option').count(),4);
   await select.selectOption('high');await page.locator('#settings-form [type="submit"]').click();
   await page.waitForFunction(()=>GameApp.getState().settings.diceQuality==='high');
   await page.reload();await page.locator('[data-action="settings"]').click();assert.equal(await select.inputValue(),'high');
  }finally{await context.close();}
 }
});
test('real 3D trays honor every quality tier, preserve stored results and release on close',async()=>{
 const context=await browser.newContext({deviceScaleFactor:3,viewport:{width:1100,height:900}});try{
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://**/*',route=>route.abort());await page.route('**/modules.json',route=>route.fulfill({json:[]}));
  await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async()=>{
   await GameApp.updateSettings({apiKey:'test',baseUrl:'https://dice-test.invalid/v1'});
   const Original=globalThis['dice-box-threejs'];globalThis.DiceBox3D=class extends Original{constructor(...args){super(...args);globalThis.testDiceBox=this;}};
   await GameApp.importSave(new File([ZIP.makeZip([{name:'Player-pc/基础信息.json',text:'{"姓名":"林砚","状态":{"Alive":true,"Enabled":true}}'},{name:'Player-pc/背包.json',text:'[]'}])],'quality.zip'));
  });
  await page.locator('[data-action="slot-choose"][data-actor="pc"]').click();await page.locator('[data-action="slot-confirm"]').click();
  await page.evaluate(async()=>{
   const save=GameApp.getState().active;save.status='waiting';save.round=1;
   save.events.push({id:'quality-roll',type:'dice',playerRelated:true,round:1,diceArgs:{dice_dict:{检定:'1d20'},calculate_only:true},data:{mode:'sum',raw:12,total:12,rows:[{label:'检定',formula:'1d20',rolls:[12],total:12}]}});
   await GameApp.updateSettings({diceQuality:'standard'});
  });
  for(const [quality,ratio,shadow]of [['low',1,false],['standard',1.5,true],['high',2,true],['ultra',3,true]]){
   await page.evaluate(value=>GameApp.updateSettings({diceQuality:value}),quality);
   await page.locator('article[data-event-id="quality-roll"]').click();
   await page.waitForFunction(()=>globalThis.testDiceBox?.diceList?.length===1&&!globalThis.testDiceBox?.renderDisposed).catch(async error=>{
    const state=await page.evaluate(()=>({modal:document.querySelector('#modal-root')?.innerText,box:!!globalThis.testDiceBox,initialized:globalThis.testDiceBox?.initialized,disposed:globalThis.testDiceBox?.renderDisposed}));
    throw Error(error.message+' '+JSON.stringify(state));
   });
   const actual=await page.evaluate(()=>{const b=testDiceBox;return {ratio:b.renderer.getPixelRatio(),width:b.renderer.domElement.width,cssWidth:b.container.clientWidth,shadow:b.renderer.shadowMap.enabled,result:b.diceList[0].getFaceValue().value,texture:b.diceList[0].material[1].map.image.width,glError:b.renderer.getContext().getError()};});
   assert.equal(actual.ratio,ratio);assert.ok(Math.abs(actual.width-actual.cssWidth*ratio)<1);assert.equal(actual.shadow,shadow);assert.equal(actual.result,12);assert.equal(actual.glError,0);assert.ok(actual.texture<=2048);
   if(quality==='high'){
    fs.mkdirSync(path.resolve(__dirname,'../artifacts'),{recursive:true});
    await page.locator('.manual-dice-shell').screenshot({path:path.resolve(__dirname,'../artifacts/dice-quality-high.png')});
    await page.setViewportSize({width:850,height:800});await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>testDiceBox.light.shadow.mapSize.x),2048);
   }
   await page.locator('.manual-dice-shell [data-action="close-modal"]').first().click();
   assert.equal(await page.evaluate(()=>testDiceBox.renderDisposed),true);
  }
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
