'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
let server,browser,origin;
before(async()=>{
  const dist=path.resolve(__dirname,'../../dist');
  server=http.createServer((req,res)=>{
    const file=path.resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));
    if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();
    fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream');res.end(data);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
test('composer resume remains visible above the history bottom and finishes the same round once',async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  try{
    const page=await context.newPage();page.setDefaultTimeout(5000);let requests=0;
    await page.route('https://**/*',async route=>{
      if(!route.request().url().startsWith('https://continue.invalid/'))return route.abort();
      requests++;
      const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
      await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'',tool_calls:[
        call('append_story',{content:'中断前的正文。\n\n'.repeat(100),one_line_summary_of_content:'中断前输出'},'story'),
        call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end'),
      ]}}]})});
    });
    await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
    await page.evaluate(async()=>{
      await GameApp.updateSettings({baseUrl:'https://continue.invalid/v1',apiKey:'test-only',stream:false});
      const zip=ZIP.makeZip([{name:'Player-pc/基础信息.json',text:'{"姓名":"测试"}'},{name:'Player-pc/背包.json',text:'[]'}]);
      await GameApp.importSave(new File([zip],'继续入口.zip'));
      window.__stop=GameApp.subscribe(s=>{if(s.running&&s.active.events.some(e=>e.type==='story')){window.__stop();GameApp.abort();}});
      await GameApp.start().catch(()=>{});
    });
    await page.waitForFunction(()=>!GameApp.getState().running&&GameApp.getState().active.status==='interrupted');
    await page.locator('#history').evaluate(el=>{el.scrollTop=0;});
    const button=page.locator('#action-form [data-action="resume"]');
    await button.waitFor({state:'visible'});
    assert.equal(await button.innerText(),'继续本轮');
    assert.equal(await page.locator('#action-input').isDisabled(),true);
    await button.click();
    await page.waitForFunction(()=>!GameApp.getState().running&&GameApp.getState().active.activeRound.complete);
    await button.waitFor({state:'detached'});
    assert.equal(await page.locator('#action-form [data-action="resume"]').count(),0);
    assert.equal(await page.evaluate(()=>GameApp.getState().active.events.filter(e=>e.type==='story').length),1);
    assert.equal(requests,1,'resume completes pending tools without requesting or publishing again');
  }finally{await context.close();}
});
