'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
test('built game sends actual opening reads in its first API request without publishing them',async()=>{
 const dist=path.resolve(__dirname,'../../dist'),server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+req.url.split('?')[0]);if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(data);});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});const page=await browser.newPage(),bodies=[],errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(5000);
  await page.route('**/modules.json',r=>r.fulfill({json:[]}));await page.route('**/files/**',r=>r.abort());
  await page.route('https://**/*',async route=>{
   if(!route.request().url().startsWith('https://preload.invalid/'))return route.abort();bodies.push(route.request().postDataJSON());
   const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
   await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'',tool_calls:[call('story','append_story',{content:'故事已经开始。',one_line_summary_of_content:'开场'}),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]}}]})});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async()=>{
   await GameApp.updateSettings({baseUrl:'https://preload.invalid/v1',apiKey:'test',stream:false});
   const files=[{name:'模组.md',text:'内部模组资料'},...['Player-pc','AIPC-p2','DISABLE-p3'].flatMap(role=>[{name:role+'/基础信息.json',text:JSON.stringify({姓名:role,'.秘密':'内部角色秘密'})},{name:role+'/背包.json',text:'[]'}])];
   await GameApp.importSave(new File([ZIP.makeZip(files)],'自动预读.zip'));await GameApp.configureSlots('pc',{p2:'ai',p3:'disabled'});
  });
  await page.locator('[data-action="start"]').click();await page.waitForFunction(()=>GameApp.getState().active?.activeRound?.complete&&!GameApp.getState().running);
  await page.locator('#history').getByText('故事已经开始。',{exact:true}).waitFor();assert.equal(bodies.length,1);const messages=bodies[0].messages,preload=messages.find(m=>m.content.startsWith('[开局预读资料]\n'));assert.equal(preload.role,'user');assert.ok(!messages.some(m=>m.tool_calls||m.role==='tool'));
  const operation=JSON.parse(preload.content.split('\n').slice(1).join('\n')).operations[0],paths=operation.arguments.paths;assert.equal(paths.length,5);assert.ok(paths.some(p=>p.includes('AIPC-p2')));assert.ok(!paths.some(p=>p.includes('p3')));
  const result=operation.result;assert.equal(result.ok,true);assert.equal(result.result[0].content,'内部模组资料');
  assert.equal(await page.evaluate(()=>GameApp.getState().active.activeRound.requestCount),1);assert.doesNotMatch(await page.locator('#history').innerText(),/内部模组资料|内部角色秘密|read_multiple_files/);assert.match(await page.locator('#history').innerText(),/故事已经开始/);assert.deepEqual(errors,[]);
  await page.locator('[data-action="settings"]').click();
  const gameSection=page.locator('[data-settings-section="game"]');if(!await gameSection.evaluate(el=>el.open))await gameSection.locator('summary').click();
  const toggle=page.locator('[name="openingPreload"]');assert.equal(await toggle.isChecked(),true);await toggle.uncheck();await page.locator('#settings-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>GameApp.getState().settings.openingPreload===false);await page.reload();await page.locator('[data-action="import"]').waitFor();
  assert.equal(await page.evaluate(()=>GameApp.getState().settings.openingPreload),false);
  await page.evaluate(async()=>{
   const files=[{name:'模组.md',text:'关闭后不应预读的模组内容'},{name:'开局内部说明.md',text:'关闭预读仍生效的说明'},{name:'开局预读.json',text:'{"version":1,"files":["额外规则.md"]}'},{name:'额外规则.md',text:'关闭后不应预读的额外内容'},{name:'Player-pc/基础信息.json',text:'{"姓名":"玩家"}'},{name:'Player-pc/背包.json',text:'[]'}];
   await GameApp.importSave(new File([ZIP.makeZip(files)],'关闭预读.zip'));await GameApp.configureSlots('pc');
  });
  await page.locator('[data-action="start"]').click();await page.waitForFunction(()=>GameApp.getState().active?.activeRound?.complete&&!GameApp.getState().running);
  assert.equal(bodies.length,2);const disabled=bodies[1].messages;
  assert.ok(disabled.some(m=>m.role==='user'&&m.content==='[开局内部说明]\n关闭预读仍生效的说明'));
  assert.ok(!disabled.some(m=>m.tool_calls||m.role==='tool'||m.content.startsWith('[开局预读资料]')));
  assert.doesNotMatch(JSON.stringify(disabled),/关闭后不应预读的/);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
