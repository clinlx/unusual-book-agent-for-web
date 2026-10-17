'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
test('preset story starts without API credentials, survives reload and defers initialization to first AI action',async()=>{
 const dist=path.resolve(__dirname,'../../dist'),server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+req.url.split('?')[0]);if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(data);});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});const page=await browser.newPage(),bodies=[],errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(8000);
  await page.route('**/modules.json',r=>r.fulfill({json:[]}));await page.route('**/files/**',r=>r.abort());
  await page.route('https://**/*',async route=>{
   if(!route.request().url().startsWith('https://preset.invalid/'))return route.abort();bodies.push(route.request().postDataJSON());
   const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
   await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'',tool_calls:[call('trigger','trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}}),call('story','append_story',{content:'你们沿着站台向前走。',one_line_summary_of_content:'探索站台',self_accept:true}),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]}}]})});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async()=>{
   const files=[{name:'模组.md',text:'模组秘密背景'},{name:'开局内部说明.md',text:'秘密测试内部开场'},{name:'预设第一回合.md',text:'雨停了，站台上只剩你们。'},{name:'开局预读.json',text:JSON.stringify({version:1,files:['补充规则.md']})},{name:'补充规则.md',text:'测试额外规则'},...['Player-pc','AIPC-p2'].flatMap(role=>[{name:role+'/基础信息.json',text:JSON.stringify({姓名:role})},{name:role+'/背包.json',text:'[]'}])];
   await GameApp.importSave(new File([ZIP.makeZip(files)],'预设开场.zip'));await GameApp.configureSlots('pc',{p2:'ai'});await GameApp.configureNPCCards('slot:p2','擅长医学');
  });
  await page.locator('[data-action="start"]').click();await page.waitForFunction(()=>GameApp.getState().active?.round===1&&!GameApp.getState().running);
  await page.locator('#history').getByText('雨停了，站台上只剩你们。',{exact:true}).waitFor();assert.equal(bodies.length,0);assert.match(await page.locator('#history').innerText(),/雨停了/);assert.doesNotMatch(await page.locator('#history').innerText(),/秘密测试内部开场|模组秘密背景/);
  assert.equal(await page.evaluate(()=>GameApp.getState().active.activeRound.requestCount),0);
  const saveId=await page.evaluate(()=>GameApp.getState().active.id);await page.reload();await page.locator('[data-action="import"]').waitFor();await page.evaluate(id=>GameApp.openSave(id),saveId);await page.waitForFunction(()=>GameApp.getState().active?.round===1);
  await page.evaluate(()=>GameApp.updateSettings({baseUrl:'https://preset.invalid/v1',apiKey:'test',stream:false}));
  await page.evaluate(()=>GameApp.send('调查站台'));await page.waitForFunction(()=>GameApp.getState().active?.round===2&&!GameApp.getState().running);
  await page.locator('#history').getByText('你们沿着站台向前走。',{exact:true}).waitFor();assert.equal(bodies.length,1);const messages=bodies[0].messages;
  assert.equal(messages.filter(m=>m.role==='system').length,1);assert.ok(!messages[0].content.includes('秘密测试内部开场'));assert.ok(messages.some(m=>m.role==='user'&&m.content.includes('秘密测试内部开场')));assert.ok(messages.some(m=>m.content.includes('擅长医学')));assert.ok(messages.some(m=>m.content.includes('不要重复发布')));assert.ok(messages.some(m=>m.role==='user'&&m.content.startsWith('[开局预读资料]\n')&&m.content.includes('测试额外规则')));assert.ok(messages.some(m=>m.role==='user'&&m.content.startsWith('[预设开场执行记录]\n')&&m.content.includes('雨停了')));assert.ok(!messages.some(m=>m.tool_calls||m.role==='tool'));
  assert.equal(await page.locator('#history').getByText('雨停了，站台上只剩你们。',{exact:true}).count(),1);assert.doesNotMatch(await page.locator('#history').innerText(),/秘密测试内部开场|模组秘密背景|测试额外规则/);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
