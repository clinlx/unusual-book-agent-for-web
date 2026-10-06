'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const dist=path.resolve(__dirname,'../../dist');
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const dice=extra=>({description:'SAN检定',roller:'林砚',related_attr:'SAN',is_secret:false,calculate_only:false,
  dice_dict:{甲:'set-force:20',乙:'set-force:30'},target_value:60,compare_mode:'le',critical_success_range:[50,50],
  critical_failure_range:[100,100],dice_combine_mode:'independent',left_modifiers:{},right_modifiers:{},...extra});
(async()=>{
  const server=http.createServer((req,res)=>{
    const file=path.resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));
    if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();
    fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream');res.end(data);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
    const context=await browser.newContext();
    await context.route('https://**/*',route=>route.request().url().startsWith('https://dice-test.invalid/')?
      route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[
        call('roll_dice',dice({}),'checks'),
        call('roll_dice',dice({description:'SAN损失',dice_dict:{损失量:'set-force:1'},dice_combine_mode:'sum',calculate_only:true,target_value:null,compare_mode:null,critical_success_range:[1,1]}),'loss'),
        call('append_story',{content:'分别结算两次检定与损失。',one_line_summary_of_content:'完成结算'},'story'),
        call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}},'end'),
      ]},finish_reason:'tool_calls'}]})}):route.abort());
    const page=await context.newPage();page.setDefaultTimeout(10000);
    await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
    await page.locator('[data-action="import"]').waitFor();
    await page.evaluate(async()=>{
      await GameApp.updateSettings({baseUrl:'https://dice-test.invalid/v1',apiKey:'test',model:'test',stream:false,manualDice:false});
      const zip=ZIP.makeZip([{name:'Player-pc/基础信息.json',text:'{"姓名":"林砚","状态":{"Alive":true,"Enabled":true}}'},{name:'Player-pc/背包.json',text:'[]'}]);
      await GameApp.importSave(new File([zip],'dice-test.zip'));
    });
    await page.locator('[data-action="start"]').click();
    await page.waitForFunction(()=>GameApp.getState().active?.activeRound?.complete);
    await page.locator('article.dice').first().waitFor();
    const cards=page.locator('article.dice');assert.equal(await cards.count(),2,JSON.stringify(await page.evaluate(()=>({events:GameApp.getState().active.events.map(e=>({type:e.type,content:e.content,success:e.success,playerRelated:e.playerRelated})),settings:GameApp.getState().settings}))));
    assert.doesNotMatch(await cards.nth(0).innerText(),/大成功|大失败/);
    assert.match(await cards.nth(1).innerText(),/仅计算/);assert.doesNotMatch(await cards.nth(1).innerText(),/大成功|大失败|通过/);
    await cards.nth(0).click();assert.match(await page.locator('.manual-dice-summary').innerText(),/各项分别判定/);
    assert.doesNotMatch(await page.locator('.manual-dice-summary').innerText(),/大成功|仅计算/);
    await page.locator('[data-action="close-modal"]').first().click();
    await cards.nth(1).click();assert.match(await page.locator('.manual-dice-summary').innerText(),/仅计算/);
    console.log('PASS: independent checks have no aggregate critical verdict; loss is calculation-only in history and detail modal');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
