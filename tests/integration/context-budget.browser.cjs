'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const ready = require('./designer-ready.cjs');
const HINT = '手动点击压缩按钮或者在设置中切换上下文处理方式';
let server, browser, origin;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/designer.html') return res.writeHead(404).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.resolve(__dirname, '../../dist/designer.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function setup(t, handler) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  const requests = [];
  await page.route('https://**/*', async route => {
    if (!route.request().url().startsWith('https://context.invalid/')) return route.abort();
    const body = route.request().postDataJSON(); requests.push(body);
    const message = await handler(body, requests);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(message.choices ? message : { choices: [{ message }] }) });
  });
  await page.goto(origin + '/designer.html'); await ready(page);
  await page.evaluate(() => Object.assign(__UI_STATE__.settings, {
    baseUrl: 'https://context.invalid/v1', apiKey: 'test-only', model: 'test', stream: false, maxContextK: 32, maxOutputTokens: 1024, contextOverflow: 'disabled',
  }));
  return { page, requests };
}
// Sending performs asynchronous preflight work before setting running. Wait for the
// new input (or its validation error), rather than mistaking that idle gap for completion.
async function clickSend(page) {
  const before=await page.evaluate(()=>{
    const messages=__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId).messages;
    return {user:messages.findLast(m=>m.role==='user')?.msgId,errors:messages.filter(m=>m.role==='system-error').length};
  });
  await page.locator('#sendBtn').click();
  await page.waitForFunction(before=>{
    const messages=__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId).messages;
    return messages.findLast(m=>m.role==='user')?.msgId!==before.user || messages.filter(m=>m.role==='system-error').length>before.errors;
  },before);
}
async function manualCompress(page) {
  await page.locator('#compressBtn').click();
  await page.locator('.overlay .foot .primary').click();
  await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing);
}

test('malformed tool arguments recover with a visible service warning and intact local history',async t=>{
  const raw='{"path":"/workspace/bad.txt","content":"unfinished';
  const {page,requests}=await setup(t,(_body,all)=>all.length===1?{tool_calls:[{id:'bad',type:'function',function:{name:'write_file',arguments:raw}}]}:{content:'已恢复'});
  await page.locator('#chatInput').fill('继续工作');await clickSend(page);
  await page.waitForFunction(()=>!__UI_STATE__.running&&!__UI_STATE__.continuing);
  assert.equal(requests.length,2);
  const sent=requests[1].messages.find(m=>m.tool_calls);
  assert.equal(sent.tool_calls[0].function.arguments,'{}');
  assert.match(await page.locator('.sys-error').innerText(),/工具参数格式错误.*未执行/);
  const actual=await page.evaluate(()=>__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId).messages.find(m=>m.tool_calls).tool_calls[0].function.arguments);
  assert.equal(actual,raw);
  assert.equal(await page.evaluate(()=>VFS.resolve(__UI_STATE__.tree,['workspace','bad.txt'])),null);
});
async function state(page) {
  return page.evaluate(() => {
    const sess = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId);
    const messages = __UI__.requestMessages(sess);
    return { cost: ContextBudget.cost(messages, Agent.toolDefinitions(DesignerResources.active(__UI_STATE__.externalSkills, __UI_STATE__.disabledSkills))),
      raw: sess.messages.map(m => ({ role: m.role, content: m.content, summary: m.summary, displayOnly: m.displayOnly, msgId: m.msgId })),
      api: messages, error: __UI_STATE__.lastError && { message: __UI_STATE__.lastError.message, action: __UI_STATE__.lastError.actionLabel } };
  });
}

for(const autoRetry of [false,true])test('failed designer turn continues without clearing progress, including after reload; autoRetry='+autoRetry,async t=>{
  const {page}=await setup(t,()=>({content:'unused'}));
  const requests=[];let fail=true;
  await page.route('https://context.invalid/**',async route=>{
    const body=route.request().postDataJSON();requests.push(body);
    if(requests.length===1)return route.fulfill({json:{choices:[{message:{tool_calls:[{
      id:'saved-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'/workspace/progress.md',content:'中断前已完成的进度'})}
    }]}}]}});
    if(fail)return route.fulfill({status:503,body:'temporary failure'});
    return route.fulfill({json:{choices:[{message:{content:'从已有进度继续完成'}}]}});
  });
  await page.evaluate(async autoRetry=>{
    Object.assign(__UI_STATE__.settings,{maxContextK:128,autoRetry,retryCooldownSeconds:0,maxConsecutiveFailures:3});
    await DB.put('config',{id:'settings',value:__UI_STATE__.settings});
  },autoRetry);
  await page.locator('#chatInput').fill('保留进度并继续');await clickSend(page);
  await page.waitForFunction(()=>!__UI_STATE__.running&&!__UI_STATE__.continuing);
  const before=await page.evaluate(()=>{
    const sess=__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId);
    return {messages:sess.messages,userMsgId:sess.contextInterrupted.userMsgId,turn:sess.writeGuardTurn};
  });
  assert.equal(requests.length,autoRetry?4:2);
  const card=page.locator('#chatScroll .error-card');
  assert.equal(await card.getByRole('button',{name:'重试',exact:true}).count(),0);
  assert.equal(await card.getByRole('button',{name:'压缩上下文',exact:true}).count(),0);
  await page.locator('#chatInput').fill('尚未发送的草稿');
  await card.getByRole('button',{name:'继续',exact:true}).click();
  await page.waitForFunction(()=>!__UI_STATE__.running&&!__UI_STATE__.continuing);
  assert.match(await card.innerText(),/503/);
  assert.equal(await card.getByRole('button',{name:'压缩上下文',exact:true}).count(),0);
  await page.reload();await ready(page);
  assert.equal(await page.locator('#chatInput').innerText(),'尚未发送的草稿');
  const restored=await page.evaluate(()=>{
    const sess=__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId);
    return {messages:sess.messages,userMsgId:sess.contextInterrupted.userMsgId,turn:sess.writeGuardTurn,kind:sess.contextInterrupted.kind};
  });
  assert.deepEqual(restored,{...before,kind:'request'});
  fail=false;
  await card.getByRole('button',{name:'继续',exact:true}).click();
  await page.waitForFunction(()=>!__UI_STATE__.running&&!__UI_STATE__.continuing);
  const after=await page.evaluate(()=>{
    const sess=__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId);
    return {messages:sess.messages,interrupted:!!sess.contextInterrupted,turn:sess.writeGuardTurn,content:VFS.readFile(__UI_STATE__.tree,'/workspace/progress.md').content};
  });
  assert.deepEqual(after.messages.slice(0,before.messages.length),before.messages);
  assert.equal(after.messages.length,before.messages.length+1);
  assert.equal(after.content,'中断前已完成的进度');assert.equal(after.turn,before.turn);assert.equal(after.interrupted,false);
  assert.equal(await page.locator('#chatInput').innerText(),'尚未发送的草稿');
  for(const request of requests.slice(1)){
    assert.equal(request.messages.filter(m=>m.role==='user'&&m.content==='保留进度并继续').length,1);
    assert.equal(request.messages.filter(m=>m.role==='tool'&&m.tool_call_id==='saved-write').length,1);
  }
});

for(const maxOutputTokens of [16384,32768])test('compression and ordinary requests share the '+maxOutputTokens+' output allowance',async t=>{
  const {page,requests}=await setup(t,()=>({content:'世界已经整理，等待后续任务。'}));
  await page.evaluate(maxOutputTokens=>{
    Object.assign(__UI_STATE__.settings,{maxContextK:128,maxOutputTokens});
    const sess=__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId);
    sess.messages=[{role:'user',content:'整理世界',msgId:'u'},{role:'assistant',content:'文'.repeat(150000)}];
    sess.__dirtyAll=true;__UI__.renderAll();
  },maxOutputTokens);
  await manualCompress(page);
  assert.ok(requests.length>0);assert.ok(requests.every(b=>!b.tools));
  for(const body of requests){
    assert.equal(body.max_tokens,maxOutputTokens);
    assert.ok(await page.evaluate(b=>ContextBudget.cost(b.messages)+b.max_tokens<=128000,body));
  }
  assert.equal((await state(page)).raw.filter(m=>m.role==='compressed'&&!m.displayOnly).length,1);
  await page.locator('#chatInput').fill('继续');await clickSend(page);
  await page.waitForFunction(()=>!__UI_STATE__.running&&!__UI_STATE__.continuing);
  assert.ok(requests.at(-1).tools);assert.equal(requests.at(-1).max_tokens,maxOutputTokens);
});

test('truncated compression is reported as an output error and preserves the original history',async t=>{
  const {page}=await setup(t,()=>({content:'无关'}));
  await page.route('https://context.invalid/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'尚未完成的摘要'},finish_reason:'length'}]})}));
  await page.evaluate(()=>{
    const sess=__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId);
    sess.messages=[{role:'user',content:'整理世界',msgId:'u'},{role:'assistant',content:'文'.repeat(60000)}];
    sess.__dirtyAll=true;__UI__.renderAll();
  });
  const original=await state(page);await manualCompress(page);
  assert.deepEqual((await state(page)).raw,original.raw);
  assert.match(await page.locator('.toast').last().innerText(),/最大输出/);
});

test('output exhaustion offers settings and resumes without replaying completed tools',async t=>{
  const {page,requests}=await setup(t,(_body,requests)=>{
    if(requests.length===1)return {tool_calls:[{id:'saved',type:'function',function:{name:'write_file',arguments:'{"path":"/workspace/saved.md","content":"已经完成的写入"}'}}]};
    if(requests.length===2)return {choices:[{message:{content:'截断回复不应保存'},finish_reason:'length'}]};
    return {content:'已继续完成。'};
  });
  await page.locator('#chatInput').fill('完成任务');await clickSend(page);
  await page.waitForFunction(()=>!__UI_STATE__.running&&!__UI_STATE__.continuing);
  const action=page.locator('#chatScroll').getByRole('button',{name:'调整最大输出',exact:true});
  assert.equal(await action.count(),1);
  assert.equal((await state(page)).raw.some(m=>m.content==='截断回复不应保存'),false);
  await action.click();await page.getByRole('spinbutton',{name:'最大输出 tokens',exact:true}).fill('2048');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.locator('#chatScroll').getByRole('button',{name:'继续',exact:true}).click();
  await page.waitForFunction(()=>!__UI_STATE__.running&&!__UI_STATE__.continuing);
  assert.equal(requests.length,3);assert.equal(requests[2].max_tokens,2048);
  assert.ok(requests[2].messages.some(m=>m.tool_call_id==='saved'));
  const result=await state(page);
  assert.equal(result.raw.filter(m=>m.role==='user').length,1);
  assert.equal(result.raw.filter(m=>m.role==='tool').length,1);
  assert.equal(result.raw.at(-1).content,'已继续完成。');
  assert.equal(await page.evaluate(()=>VFS.readFile(__UI_STATE__.tree,'/workspace/saved.md').content),'已经完成的写入');
});

test('designer starts at 256k, removes the 240k preset, and preserves a saved context limit', async t => {
  const { page } = await setup(t, () => ({ content: '完成' }));
  await page.reload(); await ready(page);
  assert.equal(await page.evaluate(() => __UI_STATE__.settings.maxContextK), 256);
  assert.match(await page.locator('#ctxBadge').innerText(), /256k$/);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const limit = page.locator('.modal .row').filter({ has: page.locator('label', { hasText: /^最大上下文$/ }) }).locator('select');
  assert.equal(await limit.inputValue(), '256');
  assert.equal(await limit.locator('option[value="240"]').count(),0);
  await page.evaluate(async () => { __UI_STATE__.settings.maxContextK = 128; await DB.put('config', { id: 'settings', value: __UI_STATE__.settings }); });
  await page.reload(); await ready(page);
  assert.equal(await page.evaluate(() => __UI_STATE__.settings.maxContextK), 128);
});

test('preset occupancy includes reserve after half while custom 256k stays exact after save and reload', async t => {
  const {page}=await setup(t,()=>({content:'完成'}));
  await page.evaluate(()=>{
    Object.assign(__UI_STATE__.settings,{maxContextK:256,contextLimitMode:'preset'});
    const sess=__UI_STATE__.sessions.find(s=>s.id===__UI_STATE__.sessionId);
    sess.messages=[{role:'user',content:'任务',msgId:'u'},{role:'assistant',content:'文'.repeat(130000)}];
    sess.__dirtyAll=true;__UI__.renderAll();
  });
  const raw=(await state(page)).cost;
  assert.match(await page.locator('#ctxBadge').innerText(),new RegExp('^'+((raw+16000)/1000).toFixed(1).replace('.','\\.')+'k / 256k$'));
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const selector=page.locator('.modal .row').filter({has:page.locator('label',{hasText:/^最大上下文$/})}).locator('select');
  await selector.selectOption('custom');
  await page.locator('input[placeholder="单位 k，1–10000"]').fill('256');
  await page.locator('.modal .foot .primary').click();
  await page.locator('.overlay').waitFor({state:'detached'});
  await page.waitForFunction(()=>__UI_STATE__.settings.contextLimitMode==='custom');
  assert.match(await page.locator('#ctxBadge').innerText(),new RegExp('^'+(raw/1000).toFixed(1).replace('.','\\.')+'k / 256k$'));
  await page.reload();await ready(page);
  assert.equal(await page.evaluate(()=>__UI_STATE__.settings.contextLimitMode),'custom');
  assert.equal(await page.evaluate(()=>ContextBudget.occupied(__UI_STATE__.settings,140000)),140000);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  assert.equal(await selector.inputValue(),'custom');
  assert.equal(await page.locator('input[placeholder="单位 k，1–10000"]').inputValue(),'256');
});

test('saved 240k values without a preset source and explicit custom values keep their exact limit',async t=>{
  const {page}=await setup(t,()=>({content:'完成'}));
  await page.evaluate(async()=>{
    const value={...__UI_STATE__.settings,maxContextK:240};delete value.contextLimitMode;
    await DB.put('config',{id:'settings',value});
  });
  await page.reload();await ready(page);
  assert.equal(await page.evaluate(()=>__UI_STATE__.settings.maxContextK),240);
  assert.equal(await page.evaluate(()=>ContextBudget.mode(__UI_STATE__.settings)),'custom');
  await page.evaluate(async()=>DB.put('config',{id:'settings',value:{...__UI_STATE__.settings,maxContextK:240,contextLimitMode:'custom'}}));
  await page.reload();await ready(page);
  assert.equal(await page.evaluate(()=>__UI_STATE__.settings.maxContextK),240);
  assert.equal(await page.evaluate(()=>ContextBudget.occupied(__UI_STATE__.settings,200000)),200000);
});

test('manual compression handles one huge turn, retains originals, and remains compact after reload', async t => {
  const { page, requests } = await setup(t, () => ({ content: '模组已整理，等待制作另一个世界。' }));
  await page.evaluate(() => {
    const sess = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId);
    sess.messages = [{ role: 'user', content: '构建世界', msgId: 'u' }, { role: 'assistant', content: '文'.repeat(60000) }];
    sess.__dirtyAll = true; __UI__.renderAll();
  });
  const before = await state(page); assert.ok(before.cost > 32000);
  await manualCompress(page);
  assert.equal(await page.locator('.toast').filter({hasText:/^压缩完成/}).last().innerText(),'压缩完成');
  const compressed = await state(page);
  assert.ok(compressed.cost < 32000); assert.ok(compressed.cost < before.cost);
  assert.equal(compressed.raw[1].content.length, 60000); assert.equal(compressed.raw[1].displayOnly, true);
  assert.equal(compressed.raw.filter(m => m.role === 'compressed' && !m.displayOnly).length, 1);
  assert.ok(requests.length > 1, 'the oversized single turn is split into bounded compression requests');
  for (const request of requests) assert.ok(await page.evaluate(body => ContextBudget.cost(body.messages, body.tools || []), request) <= 32000);
  await page.reload(); await ready(page);
  const reloaded = await state(page); assert.equal(reloaded.cost, compressed.cost);
  await page.evaluate(() => Object.assign(__UI_STATE__.settings, { baseUrl: 'https://context.invalid/v1', apiKey: 'test-only', model: 'test', stream: false, maxContextK: 32, maxOutputTokens: 1024 }));
  await page.locator('#chatInput').fill('制作下一个世界'); await clickSend(page);
  await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing);
  assert.ok(requests.at(-1).tools); assert.ok(!(await state(page)).error);
});

test('oversized compression output is rejected without changing live history', async t => {
  const { page } = await setup(t, () => ({ content: '大'.repeat(65000) }));
  await page.evaluate(() => {
    const sess = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId);
    sess.messages = [{ role: 'user', content: '构建世界', msgId: 'u' }, { role: 'assistant', content: '文'.repeat(60000) }];
    sess.__dirtyAll = true; __UI__.renderAll();
  });
  const original = await state(page); await manualCompress(page);
  assert.deepEqual((await state(page)).raw, original.raw);
  assert.ok((await state(page)).cost > 32000);
  assert.match(await page.locator('#ctxBadge').getAttribute('title'), new RegExp(HINT));
});

test('an oversized active summary can be compressed again despite having no recent turns', async t => {
  const { page } = await setup(t, () => ({ content: '已有世界摘要，等待新任务。' }));
  await page.evaluate(() => {
    const sess = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId);
    sess.messages = [{ role: 'compressed', summary: '摘'.repeat(50000), count: 2 }];
    sess.__dirtyAll = true; __UI__.renderAll();
  });
  await manualCompress(page);
  const result = await state(page); assert.ok(result.cost < 32000);
  assert.equal(result.raw.filter(m => m.role === 'compressed' && !m.displayOnly).length, 1);
});

for (const mode of ['disabled', 'compress']) {
  test(mode + ' checks again after tool execution and preserves writes and tool history', async t => {
    let calls = 0;
    const { page, requests } = await setup(t, body => {
      if (!body.tools) return { content: '已写入 /workspace/saved.md，并读取 /workspace/large.md；继续整理世界。' };
      calls++;
      if (calls > 1) return { content: '世界已整理完成。' };
      const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      return { content: '', tool_calls: [call('write', 'write_file', { path: '/workspace/saved.md', content: '已经执行的写入' }),
        call('read', 'read_file', { path: '/workspace/large.md', limit: 40000 })] };
    });
    await page.evaluate(mode => {
      __UI_STATE__.settings.contextOverflow = mode;
      VFS.writeFile(__UI_STATE__.tree, '/workspace/large.md', '文'.repeat(40000));
      __UI__.renderAll();
    }, mode);
    await page.locator('#chatInput').fill('读取大文件，继续整理世界'); await clickSend(page);
    await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing);
    assert.equal(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/saved.md').content), '已经执行的写入');
    const result = await state(page);
    assert.equal(result.raw.filter(m => m.role === 'tool').length, 2);
    if (mode === 'disabled') {
      assert.equal(calls, 1); assert.match(result.error.message, new RegExp(HINT));
      assert.equal(result.error.action, '压缩上下文');
      assert.match(await page.locator('#chatScroll').innerText(), new RegExp(HINT));
      assert.match(await page.locator('#ctxBadge').getAttribute('title'), new RegExp(HINT));
      await page.locator('#chatScroll').getByRole('button', { name: '压缩上下文', exact: true }).click();
      await page.locator('.overlay .foot .primary').click();
      await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing);
      assert.equal((await state(page)).raw.filter(m => m.role === 'tool').length, 2, 'compression action never reverts executed calls');
      assert.ok((await state(page)).cost < 32000);
    } else {
      assert.equal(calls, 2); assert.ok(!result.error);
      assert.ok(requests.some(r => !r.tools), 'compression runs within the tool loop');
      assert.ok(requests.at(-1).messages.some(m => m.role === 'user' && m.content.includes('读取大文件')));
      assert.ok(result.cost < 32000);
      for (const request of requests) assert.ok(await page.evaluate(body => ContextBudget.cost(body.messages, body.tools || []), request) <= 32000);
    }
  });
}

test('full-context send preserves draft and presents the same guidance in bubble and toast', async t => {
  const { page, requests } = await setup(t, () => ({ content: '不应发送' }));
  await page.evaluate(() => {
    const sess = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId);
    sess.messages = [{ role: 'user', content: '文'.repeat(40000), msgId: 'u' }]; sess.__dirtyAll = true; __UI__.renderAll();
  });
  await page.locator('#chatInput').fill('下一步'); await clickSend(page);
  await page.waitForFunction(hint => document.querySelector('#chatScroll').textContent.includes(hint), HINT);
  assert.equal(await page.locator('#chatInput').innerText(), '下一步'); assert.equal(requests.length, 0);
  assert.match(await page.locator('.toast').innerText(), new RegExp(HINT));
});

test('automatic compression at send entry completes before sending and is not cancelled by a duplicate click handler', async t => {
  const { page, requests } = await setup(t, () => ({ content: '整理后的世界摘要。' }));
  await page.evaluate(() => {
    __UI_STATE__.settings.contextOverflow = 'compress';
    const sess = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId);
    sess.messages = [{ role: 'user', content: '初始任务', msgId: 'u' }, { role: 'assistant', content: '文'.repeat(40000) }];
    sess.__dirtyAll = true; __UI__.renderAll();
  });
  await page.locator('#chatInput').fill('继续任务'); await clickSend(page);
  await page.waitForFunction(() => __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId).messages.some(m => m.role === 'user' && m.content === '继续任务'));
  await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing);
  assert.ok(requests.at(-1).tools);
  assert.equal((await state(page)).error, null);
  assert.ok((await state(page)).cost < 32000);
});

test('partial history is labelled as a lower bound and compression loads all records before folding', async t => {
  const { page } = await setup(t, () => ({ content: '全部早期任务均已整理，继续世界构建。' }));
  await page.evaluate(async () => {
    const sess = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId);
    const messages = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '文'.repeat(1500), msgId: 'history-' + i }));
    await DB.putMessages(sess.id, messages);
    const meta = await DB.get('sessions', sess.id); await DB.put('sessions', { ...meta, msgCount: messages.length });
    await DB.put('config', { id: 'settings', value: __UI_STATE__.settings });
  });
  await page.reload(); await ready(page);
  assert.match(await page.locator('#ctxBadge').innerText(), /^≥ /);
  await manualCompress(page);
  const result = await state(page);
  assert.equal(result.raw.filter(m => m.msgId && m.msgId.startsWith('history-')).length, 100);
  assert.ok(result.cost < 32000);
  assert.ok(!(await page.locator('#ctxBadge').innerText()).startsWith('≥'));
  assert.equal(await page.evaluate(async () => (await DB.getMessages(__UI_STATE__.sessionId)).length), 101);
});

test('failed automatic compression stops safely without offering a replay that deletes tool history', async t => {
  let calls = 0;
  const { page } = await setup(t, body => {
    if (!body.tools) return { content: '膨胀'.repeat(30000) };
    calls++; return { tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"/workspace/large.md","limit":40000}' } }] };
  });
  await page.evaluate(() => {
    __UI_STATE__.settings.contextOverflow = 'compress'; VFS.writeFile(__UI_STATE__.tree, '/workspace/large.md', '文'.repeat(40000)); __UI__.renderAll();
  });
  await page.locator('#chatInput').fill('整理世界'); await clickSend(page);
  await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing);
  const result = await state(page);
  assert.equal(calls, 1); assert.equal(result.raw.filter(m => m.role === 'tool' && !m.displayOnly).length, 1);
  assert.equal(result.error.action, '压缩上下文'); assert.match(result.error.message, new RegExp(HINT));
});

test('context interruption resumes from the bubble after compression and reload without adding a user prompt', async t => {
  let calls = 0;
  const { page, requests } = await setup(t, body => {
    if (!body.tools) return { content: '任务：整理世界。已读取 /workspace/large.md，下一步完成整理，不必重复读取。' };
    calls++;
    return calls === 1 ? { tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"/workspace/large.md","limit":40000}' } }] }
      : { content: '整理已完成。' };
  });
  await page.evaluate(async () => {
    VFS.writeFile(__UI_STATE__.tree, '/workspace/large.md', '文'.repeat(40000)); __UI__.renderAll();
    await DB.put('config', { id: 'settings', value: __UI_STATE__.settings });
  });
  await page.locator('#chatInput').fill('整理世界'); await clickSend(page);
  await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing);
  const continueButton = page.locator('#chatScroll').getByRole('button', { name: '继续', exact: true });
  await continueButton.waitFor({ state: 'visible' });
  await manualCompress(page);
  assert.equal(await page.locator('#chatScroll').getByRole('button',{name:'压缩上下文',exact:true}).isDisabled(),true);
  assert.match(await page.locator('#chatScroll').getByRole('button',{name:'压缩上下文',exact:true}).evaluate(button=>getComputedStyle(button).filter),/grayscale/);
  await page.reload(); await ready(page);
  await continueButton.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#chatScroll').getByRole('button',{name:'压缩上下文',exact:true}).isDisabled(),true);
  assert.equal(await continueButton.isDisabled(),false);
  await page.locator('#chatInput').fill('留给下一轮的草稿');
  const userCount = await page.evaluate(async () => (await DB.getMessages(__UI_STATE__.sessionId)).filter(m => m.role === 'user').length);
  await continueButton.click();
  await page.waitForFunction(() => !__UI_STATE__.running && __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId).messages.some(m => m.content === '整理已完成。'));
  assert.equal(calls, 2);
  assert.equal((await state(page)).raw.filter(m => m.role === 'user').length, userCount);
  assert.equal((await state(page)).raw.filter(m => m.role === 'tool').length, 1);
  assert.equal(await page.locator('#chatInput').innerText(), '留给下一轮的草稿');
  assert.equal(await continueButton.count(), 0);
  assert.ok(requests.at(-1).messages.every(m => !String(m.content).includes('留给下一轮的草稿')));
});

test('continue keeps its checkpoint while still full, then honors automatic compression without a new prompt', async t => {
  let calls = 0;
  const { page } = await setup(t, body => {
    if (!body.tools) return { content: '已读取大文件，下一步完成世界整理。' };
    calls++;
    return calls === 1 ? { tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"/workspace/large.md","limit":40000}' } }] }
      : { content: '续接完成。' };
  });
  await page.evaluate(() => { VFS.writeFile(__UI_STATE__.tree, '/workspace/large.md', '文'.repeat(40000)); __UI__.renderAll(); });
  await page.locator('#chatInput').fill('完成世界整理'); await clickSend(page);
  await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing);
  const button = page.locator('#chatScroll').getByRole('button', { name: '继续', exact: true });
  await page.locator('#chatInput').fill('草稿内容');
  await button.click();
  await page.waitForFunction(() => !__UI_STATE__.continuing);
  assert.equal(calls, 1); assert.equal(await button.count(), 1);
  assert.equal((await state(page)).raw.filter(m => m.role === 'user').length, 1);
  await page.evaluate(() => { __UI_STATE__.settings.contextOverflow = 'compress'; });
  await button.evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.continuing && __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId).messages.some(m => m.content === '续接完成。'));
  assert.equal(calls, 2, 'rapid repeated clicks submit only one continuation');
  assert.equal((await state(page)).raw.filter(m => m.role === 'user').length, 1);
  assert.equal(await page.locator('#chatInput').innerText(), '草稿内容');
});
