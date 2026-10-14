'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
test('built game sends actual opening reads in its first API request without publishing them',async()=>{
 const dist=path.resolve(__dirname,'../../dist'),server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+req.url.split('?')[0]);if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(data);});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage(),bodies=[],errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(5000);
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
  await page.locator('#history').getByText('故事已经开始。',{exact:true}).waitFor();assert.equal(bodies.length,1);const calls=bodies[0].messages.flatMap(m=>m.tool_calls||[]),preload=calls.find(c=>c.function.name==='read_multiple_files');assert.ok(preload);
  const paths=JSON.parse(preload.function.arguments).paths;assert.equal(paths.length,5);assert.ok(paths.some(p=>p.includes('AIPC-p2')));assert.ok(!paths.some(p=>p.includes('p3')));
  const result=JSON.parse(bodies[0].messages.find(m=>m.tool_call_id===preload.id).content);assert.equal(result.ok,true);assert.equal(result.result[0].content,'内部模组资料');
  assert.equal(await page.evaluate(()=>GameApp.getState().active.activeRound.requestCount),1);assert.doesNotMatch(await page.locator('#history').innerText(),/内部模组资料|内部角色秘密|read_multiple_files/);assert.match(await page.locator('#history').innerText(),/故事已经开始/);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
