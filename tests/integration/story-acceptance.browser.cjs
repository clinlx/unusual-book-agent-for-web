'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
test('streamed draft remains a preview, retracts on rejection, then publishes only the accepted revision',async t=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.resolve(__dirname,'../../dist/index.html')));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(5000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',r=>r.abort());await page.route('**/modules.json',r=>r.fulfill({json:[]}));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-action="import"]').waitFor();
 await page.evaluate(async()=>{
   await GameApp.updateSettings({apiKey:'test',stream:true});await GameApp.importSave(new File([ZIP.makeZip([{name:'Player-p/基础信息.json',text:'{}'},{name:'Player-p/背包.json',text:'[]'}])],'审稿.zip'));await GameApp.configureSlots('p');
   const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});let requests=0;
   GameTransport.create=(_settings,_defs,hooks)=>async()=>{
     if(++requests===1){
       hooks.onToolDelta([{id:'draft',type:'function',function:{name:'append_story',arguments:'{"content":"临时草稿正在流式输出'}}]);
       return await new Promise(resolve=>{window.rejectPreview=()=>{
         const tc=call('draft','append_story',{content:'临时草稿正在流式输出',one_line_summary_of_content:'否定摘要',self_accept:false});hooks.onToolDelta([tc]);window.finishDraftResponse=()=>resolve({tool_calls:[tc]});
       };});
     }
     window.awaitingRevision=true;
     return await new Promise(resolve=>{window.publishRevision=()=>resolve({tool_calls:[call('accepted','append_story',{content:'修订后的正式正文。',one_line_summary_of_content:'正式摘要',self_accept:true}),call('end','end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环'}})]});});
   };
 });
 await page.locator('#action-form [data-action="start"]').click();await page.locator('.live-story').waitFor();a.match(await page.locator('.live-story').innerText(),/临时草稿/);
 a.equal(await page.evaluate(()=>GameApp.getState().active.events.some(e=>e.type==='story')),false);
 await page.evaluate(()=>window.rejectPreview());await page.locator('.live-story').waitFor({state:'hidden'});
 await page.evaluate(()=>window.finishDraftResponse());await page.waitForFunction(()=>window.awaitingRevision);
 const state=await page.evaluate(()=>{const s=GameApp.getState().active;return {receipt:s.activeRound.receipts.draft,published:s.activeRound.published,view:GameApp.exportView()};});
 a.equal(state.receipt.ok,false);a.match(state.receipt.error,/草稿已被否定/);a.equal(state.published,0);a.doesNotMatch(JSON.stringify(state.view),/临时草稿|否定摘要/);
 await page.evaluate(()=>window.publishRevision());await page.waitForFunction(()=>!GameApp.getState().running&&GameApp.getState().active.round===1);
 const result=await page.evaluate(()=>{const s=GameApp.getState().active;return {stories:s.events.filter(e=>e.type==='story'),html:GamePresentation.historyHTML(GameApp.exportView())};});
 a.deepEqual(result.stories.map(e=>e.content),['修订后的正式正文。']);a.doesNotMatch(result.html,/临时草稿|否定摘要/);a.deepEqual(errors,[]);
});
