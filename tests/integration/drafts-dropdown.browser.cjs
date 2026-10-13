'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),readyDesigner=require('./designer-ready.cjs');
let server,browser,origin;
before(async()=>{
  const dist=path.resolve(__dirname,'../../dist');
  server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+req.url.split('?')[0]);if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(data);});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
async function pageFor(t){const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(5000);return page;}
async function settings(page,name){await page.goto(origin+'/'+name+'.html');if(name==='designer'){await readyDesigner(page);await page.getByRole('button',{name:'设置',exact:true}).click();}else {await page.locator('[data-action="settings"]').click();if(name==='index'&&!await page.locator('[data-settings-section="game"]').evaluate(el=>el.open))await page.locator('[data-settings-section="game"] summary').click();}}

for(const failure of ['missing','throwing'])test('drawn dropdown replaces '+failure+' native picker and preserves select events',async t=>{
  const page=await pageFor(t);
  await page.addInitScript(failure=>Object.defineProperty(HTMLSelectElement.prototype,'showPicker',{configurable:true,value:failure==='missing'?undefined:function(){throw new DOMException('Unavailable','NotSupportedError');}}),failure);
  await settings(page,'index');
  await page.evaluate(()=>{const select=document.querySelector('select');select.id='dropdown-test';select.innerHTML='<optgroup label="分组"><option value="a">甲</option><option value="b">乙</option><option value="c" disabled>禁用</option></optgroup>';window.selectEvents=[];for(const type of ['input','change'])select.addEventListener(type,()=>selectEvents.push(type));});
  await page.locator('#dropdown-test').click();await page.getByRole('listbox').waitFor();
  assert.equal(await page.getByRole('listbox').getByRole('option',{name:'禁用',exact:true}).isDisabled(),true);
  assert.ok(await page.getByRole('listbox').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
  await page.getByRole('listbox').getByRole('option',{name:'乙',exact:true}).click();assert.equal(await page.locator('#dropdown-test').inputValue(),'b');assert.deepEqual(await page.evaluate(()=>selectEvents),['input','change']);
  await page.locator('#dropdown-test').click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('listbox').count(),0);assert.equal(await page.locator('.modal').count(),1);
  await page.locator('#dropdown-test').press('ArrowDown');await page.getByRole('listbox').waitFor();await page.keyboard.press('Home');await page.keyboard.press('Enter');assert.equal(await page.locator('#dropdown-test').inputValue(),'a');
  await page.locator('#dropdown-test').click();await page.goBack();assert.equal(await page.getByRole('listbox').count(),0);assert.equal(await page.locator('.modal').count(),1);
  await page.locator('#dropdown-test').click();await page.locator('.modal h2').click();assert.equal(await page.getByRole('listbox').count(),0);
});

for(const name of ['index','client','designer'])test(name+' settings persist the browser-local dropdown override',async t=>{
  const page=await pageFor(t);await settings(page,name);
  const toggle=page.getByRole('checkbox',{name:'兼容下拉菜单',exact:true});await toggle.check();
  await page.getByRole('button',{name:name==='designer'?'保存':'保存设置',exact:true}).click();
  await settings(page,name);assert.equal(await toggle.isChecked(),true);
  await page.evaluate(()=>{const select=document.createElement('select');select.id='forced-select';select.innerHTML='<option>甲</option><option>乙</option>';Object.assign(select.style,{position:'fixed',left:'20px',top:'20px',zIndex:'99999'});document.body.append(select);});
  await page.locator('#forced-select').click();await page.getByRole('listbox').waitFor();await page.getByRole('listbox').getByRole('option',{name:'乙',exact:true}).click();assert.equal(await page.locator('#forced-select').inputValue(),'乙');
});

test('host keeps next-round public and private drafts after the submitting promise completes',{timeout:20000},async t=>{
  const page=await pageFor(t),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let count=0,release,arrived;const gate=new Promise(r=>release=r),started=new Promise(r=>arrived=r);
  const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
  await page.route('https://drafts.invalid/**',async route=>{
    const n=++count;if(n===2){arrived();await gate;}
    const calls=n===1?[call('append_story',{content:'开场测试',one_line_summary_of_content:'开场'},'story1'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'上午九点'}},'end1')]:[call('trigger_next_round',{phase_plan:{Countdowns:'无',Pending_Triggers:[],Forced_Checks:'无'}},'next2'),call('append_story',{content:'第二回合',one_line_summary_of_content:'第二回合'},'story2'),call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏循环',Game_World_Time:'上午九点十分'}},'end2')];
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'',tool_calls:calls}}]})});
  });
  t.after(()=>release());await page.goto(origin+'/index.html');await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async()=>{
    await GameApp.updateSettings({apiKey:'test',baseUrl:'https://drafts.invalid/v1',stream:false});
    const files=[{name:'Player-a/基础信息.json',text:JSON.stringify({姓名:'甲'})},{name:'Player-a/背包.json',text:'[]'},{name:'模组.md',text:'测试世界'}];
    await GameApp.importSave(new File([ZIP.makeZip(files)],'草稿测试.zip'));if(GameApp.getState().active.slotsConfigured===false)await GameApp.configureSlots('a');await GameApp.start();
  });
  await page.evaluate(()=>{GameApp.saveDraft('这轮的公开说辞',undefined,{privateContent:'这轮的隐秘行动',hiddenSend:true,disguiseSend:true});GameApp.setMode('play');});
  await page.locator('#action-form button[type="submit"]').click();await started;
  await page.locator('#action-input').fill('下一轮的秘密草稿');await page.locator('#action-private-input').fill('下一轮的公开草稿');
  await page.waitForFunction(()=>GameApp.getState().active.privateDraft==='下一轮的秘密草稿');release();
  await page.waitForFunction(()=>!GameApp.getState().running&&GameApp.getState().active.round>=2);await page.locator('[data-action="abort"]').waitFor({state:'hidden'});
  assert.equal(await page.locator('#action-input').inputValue(),'下一轮的秘密草稿',JSON.stringify(await page.evaluate(()=>{const s=GameApp.getState();return {draft:s.active.draft,privateDraft:s.active.privateDraft,draftRound:s.active.draftRound,binding:GameInputs.owner(s.active),round:s.active.round,status:s.active.status,room:s.room?.status,privateCheckbox:document.querySelector('#hidden-send-toggle')?.checked,html:document.querySelector('#action-form')?.innerHTML};})));assert.equal(await page.locator('#action-private-input').inputValue(),'下一轮的公开草稿');
  assert.deepEqual(await page.evaluate(()=>{const s=GameApp.getState().active;return [s.hiddenSend,s.disguiseSend,s.draftRound];}),[true,true,3]);assert.deepEqual(errors,[]);
});
