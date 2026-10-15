'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
let server,browser,origin;
before(async()=>{
  server=http.createServer((req,res)=>{
    if(req.url!=='/index.html')return res.writeHead(404).end();
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.resolve(__dirname,'../../dist/index.html')));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function open(t){
  const context=await browser.newContext({viewport:{width:1440,height:960}});t.after(()=>context.close());
  const page=await context.newPage();page.setDefaultTimeout(10000);
  await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();return page;
}
async function prepare(page){
  await page.evaluate(async()=>{
    const blob=ZIP.makeZip([{name:'Player-p/基础信息.json',text:'{"姓名":"玩家"}'},{name:'Player-p/背包.json',text:'[]'},
      {name:'large.txt',text:'文'.repeat(120000)}]);
    await GameApp.importSave(new File([blob],'上下文回归.zip'));
  });
  await page.locator('[data-action="slot-choose"][data-actor="p"]').click();
  await page.locator('[data-action="slot-confirm"]').click();
  await page.locator('#modal-root .modal-backdrop').waitFor({state:'hidden'});
  return page.evaluate(async()=>{
    const input=GameCore.estimate(GameApp.currentContext()),tools=GameCore.estimate(GameTools.build(Prompts,{}));
    const maxContextK=Math.ceil((input+tools+1024+6000)/1000);
    await GameApp.updateSettings({baseUrl:'https://game-context.invalid/v1',apiKey:'test-only',model:'test',stream:false,maxOutputTokens:1024,maxContextK});
    return maxContextK;
  });
}
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const readCalls=()=>[call('write','write_file',{path:'/workspace/proof.txt',content:'已完成写入'}),call('read','read_file',{path:'/workspace/large.txt',limit:120000})];
const finishCalls=()=>[call('story','append_story',{content:'雨停了，旅程继续。',one_line_summary_of_content:'继续旅程'}),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})];

for(const restored of [false,true])test(restored?'saved oversized rounds resume after reload without changing settings or repeating writes':'oversized tool results automatically recover before the next HTTP request',async t=>{
  const page=await open(t),errors=[],bodies=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**/*',async route=>{
    if(!route.request().url().startsWith('https://game-context.invalid/'))return route.abort();
    bodies.push(route.request().postDataJSON());
    const message={content:'',tool_calls:!restored&&bodies.length===1?readCalls():finishCalls()};
    await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message}],usage:{prompt_tokens:31000,completion_tokens:500}})});
  });
  const cap=await prepare(page);
  if(restored){
    await page.evaluate(async calls=>{
      const s=GameApp.getState().active;GameCore.beginRound(s,'',true,Prompts.roundPrompt(true),{roundId:s.multiplayer.roundId});
      s.messages.push({role:'assistant',round:1,tool_calls:calls});
      for(const c of calls)s.messages.push({role:'tool',round:1,tool_call_id:c.id,content:JSON.stringify(GameCore.execute(s,c.function.name,JSON.parse(c.function.arguments),c.id))});
      s.status='interrupted';s.error='系统提示词与当前回合已超过上下文上限';
      s.multiplayer.status='interrupted';s.multiplayer.frozenActions=[];
      s.requestHistory=[{round:1,status:'completed',body:{messages:[{role:'user',content:'开局'}]},usage:{prompt_tokens:93972,completion_tokens:2337}}];
      const db=GameStore.create();await db.open();await db.putSave(s);
    },readCalls());
    await page.reload();await page.locator('[data-action="open-save"]').first().click();
    await page.waitForFunction(()=>!!GameApp.getState().active);
    await page.evaluate(()=>GameApp.setMode('debug'));
    assert.match(await page.locator('.token-usage').innerText(),/上次请求.*93972.*2337/);
    await page.evaluate(()=>GameApp.writeFile('/workspace/proof.txt','中断后的手动编辑'));
    await page.locator('#action-form [data-action="resume"]').click();
  }else await page.evaluate(()=>GameApp.start());
  await page.waitForFunction(()=>!GameApp.getState().running&&GameApp.getState().active.activeRound.complete).catch(async error=>{
    const details=await page.evaluate(()=>{const s=GameApp.getState();return {running:s.running,error:s.error,status:s.active.status,events:s.active.events.slice(-3).map(e=>({type:e.type,name:e.name,content:e.content})),room:s.room?.status,toast:document.querySelector('.toast')?.textContent};});
    throw Error(error.message+' '+JSON.stringify({requests:bodies.length,...details}),{cause:error});
  });
  assert.equal(bodies.length,restored?1:2);
  const sent=bodies.at(-1),read=JSON.parse(sent.messages.find(m=>m.tool_call_id==='read').content);
  assert.equal(read.archived,true);assert.ok(read.preview.length<=1000);assert.ok(read.archive_path);
  assert.equal(await page.evaluate(()=>GameApp.getState().settings.maxContextK),cap);
  assert.equal(await page.evaluate(()=>GameApp.readFile('/workspace/proof.txt')),restored?'中断后的手动编辑':'已完成写入');
  assert.equal(await page.evaluate(()=>GameApp.getState().active.events.filter(e=>e.callId==='write').length),1);
  assert.equal(await page.evaluate(()=>GameApp.getState().active.events.filter(e=>e.type==='player').length),0);
  assert.equal(await page.evaluate(()=>GameApp.getState().active.events.filter(e=>e.type==='error').length),0);
  await page.reload();await page.locator('[data-action="open-save"]').first().click();
  await page.waitForFunction(()=>!!GameApp.getState().active);
  assert.equal(await page.evaluate(p=>JSON.parse(GameApp.readFile(p)).result.content.length,read.archive_path),120000);
  await page.evaluate(()=>GameApp.setMode('debug'));
  assert.match(await page.locator('.token-usage').innerText(),/上次请求.*31000.*500/);
  const fits=await page.evaluate(body=>GameCore.estimate(body.messages)+GameCore.estimate(body.tools||[])+body.max_tokens<=GameApp.getState().settings.maxContextK*1000,sent);
  assert.equal(fits,true);assert.deepEqual(errors,[]);
});

test('unrecoverable fixed prompt budgets show the current breakdown and never send or accumulate errors',async t=>{
  const page=await open(t);let requests=0;
  await page.route('https://**/*',async route=>{requests++;return route.abort();});
  await prepare(page);
  await page.evaluate(async()=>{
    await GameApp.updateSettings({maxContextK:4,maxOutputTokens:1024});
    await GameApp.start().catch(()=>{});GameApp.setMode('debug');
  });
  await page.locator('.game-layout.debug-mode').waitFor();
  const text=await page.locator('.notice.error').first().innerText();
  assert.match(text,/估算消息 \d+ \+ 工具 \d+ \+ 预留输出 1024/);assert.match(text,/上限 4000/);
  await page.locator('#action-form [data-action="resume"]').click();
  await page.waitForFunction(()=>!GameApp.getState().running);
  const first=await page.evaluate(()=>GameApp.getState().active.messages.length);
  await page.locator('#action-form [data-action="resume"]').click();
  await page.waitForFunction(()=>!GameApp.getState().running);
  assert.equal(await page.evaluate(()=>GameApp.getState().active.messages.length),first);
  assert.equal(requests,0);
});

test('a saved oversized input resumes through a file and delivers the requested chunk to the model',async t=>{
  const page=await open(t),bodies=[],errors=[];let archivePath;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**/*',async route=>{
    if(!route.request().url().startsWith('https://game-context.invalid/'))return route.abort();
    const body=route.request().postDataJSON();bodies.push(body);
    let tool_calls=finishCalls();
    if(bodies.length===1){
      const index=body.messages.find(m=>m.content.startsWith('[上下文资料索引]'));
      archivePath=JSON.parse(index.content.split('\n').slice(1).join('\n')).archive_path;
      tool_calls=[call('input-chunk','read_file',{path:archivePath,offset:0,limit:300})];
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'',tool_calls}}]})});
  });
  const cap=await prepare(page);
  await page.evaluate(async()=>{
    const s=GameApp.getState().active;GameCore.beginRound(s,'',true,'输入开头'+ '长篇行动'.repeat(30000)+'输入结尾',{roundId:s.multiplayer.roundId});
    s.status='interrupted';s.multiplayer.status='interrupted';s.multiplayer.frozenActions=[];
    const db=GameStore.create();await db.open();await db.putSave(s);
  });
  await page.reload();await page.locator('[data-action="open-save"]').first().click();
  await page.locator('#action-form [data-action="resume"]').click();
  await page.waitForFunction(()=>!GameApp.getState().running&&GameApp.getState().active.activeRound.complete);
  assert.equal(bodies.length,2);assert.ok(archivePath);
  const snapshot=await page.evaluate(p=>GameApp.readFile(p),archivePath);
  assert.match(JSON.parse(snapshot)[0].content,/^输入开头.*输入结尾$/s);
  const chunk=JSON.parse(bodies[1].messages.find(m=>m.tool_call_id==='input-chunk').content);
  assert.equal(chunk.result.content,snapshot.slice(0,300));
  assert.equal(await page.evaluate(()=>GameApp.getState().settings.maxContextK),cap);
  assert.equal(await page.evaluate(()=>GameApp.getState().active.events.filter(e=>e.type==='error').length),0);
  for(const body of bodies)assert.equal(await page.evaluate(body=>GameCore.estimate(body.messages)+GameCore.estimate(body.tools||[])+body.max_tokens<=GameApp.getState().settings.maxContextK*1000,body),true);
  assert.deepEqual(errors,[]);
});
