'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const ready = require('./designer-ready.cjs');
(async () => {
  let flow = 'ask', stream;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      req.resume();
      if (flow === 'stream') {
        stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '正在书写。\n'.repeat(100) } }] }) + '\n\n');
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '/workspace/stop-save.md', content: '中止前已完成的修改' }) } },
          { id: 'ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: '请选择故事主题', options: ['冒险', '悬疑'] }] }) } },
        ] }, finish_reason: 'tool_calls' }] }));
      }
      return;
    }
    if (req.url !== '/designer.html') return res.writeHead(404).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.resolve('dist/designer.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  let failed = false;
  try {
    for (const scenario of ['abort-question', 'delete-project', 'delete-session', 'scroll-stream']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', () => errors.push('Native dialog opened'));
      try {
        flow = scenario === 'scroll-stream' ? 'stream' : 'ask'; stream = null;
        await page.goto(base + '/designer.html'); await ready(page);
        const original = await page.evaluate(() => __UI_STATE__.projectId);
        let backup;
        if (scenario === 'abort-question' || scenario === 'delete-project') {
          await page.locator('#projectBtn').click();
          await page.locator('.ctx-menu button').filter({ hasText: '新建项目' }).click();
          await page.locator('.overlay input').fill('备用项目');
          await page.locator('.overlay .foot .primary').click();
          await page.waitForFunction(id => __UI_STATE__.projectId !== id, original);
          backup = await page.evaluate(() => __UI_STATE__.projectId);
          await page.locator('#projectBtn').click();
          await page.locator('.ctx-menu button').filter({ hasText: '默认项目' }).click();
          await page.waitForFunction(id => __UI_STATE__.projectId === id, original);
        }
        await page.evaluate(({ base, streaming }) => {
          Object.assign(__UI_STATE__.settings, { baseUrl: base + '/v1', apiKey: 'test', model: 'test', stream: streaming });
          if (streaming) {
            const sess = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId);
            sess.messages = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `历史消息 ${i}\n` + '这是一段需要保留阅读位置的历史内容。'.repeat(30), msgId: 'history-' + i }));
            sess.__dirtyAll = true; __UI__.renderAll();
          }
        }, { base, streaming: scenario === 'scroll-stream' });
        const session = await page.evaluate(() => __UI_STATE__.sessionId);
        await page.locator('#chatInput').fill('继续构建世界'); await page.locator('#sendBtn').click();
        if (flow === 'ask') {
          await page.locator('#askOverlay').getByRole('button', { name: '稍后回答', exact: true }).click();
          if (scenario === 'abort-question') {
            await page.locator('#sendBtn').click();
            await page.waitForFunction(() => !__UI_STATE__.running, null, { timeout: 1500 });
            assert.equal(await page.evaluate(() => __UI_STATE__.pendingAsk), null);
            assert.equal(await page.evaluate(id => localStorage.getItem('awl:lease:' + id), original), null);
            assert.equal(await page.evaluate(async id => VFS.readFile((await DB.get('vfs', id)).tree, '/workspace/stop-save.md').content, original), '中止前已完成的修改');
            await page.locator('#projectBtn').click(); await page.locator('.ctx-menu button').filter({ hasText: '备用项目' }).click();
            await page.waitForFunction(id => __UI_STATE__.projectId === id, backup);
          } else {
            if (scenario === 'delete-project') {
              await page.locator('#projectBtn').click();
              await page.locator('.ctx-menu button').filter({ hasText: '删除当前项目' }).click();
            } else {
              await page.locator('.session-item.active').hover();
              await page.locator('.session-item.active button[title="更多"]').click();
              await page.locator('.ctx-menu').getByRole('button', { name: '删除', exact: true }).click();
            }
            await page.locator('.overlay .danger').click();
            await page.waitForFunction(({ scenario, backup, session }) => !__UI_STATE__.running && (scenario === 'delete-project' ? __UI_STATE__.projectId === backup : __UI_STATE__.sessionId && __UI_STATE__.sessionId !== session), { scenario, backup, session }, { timeout: 1500 });
            assert.equal(await page.evaluate(id => localStorage.getItem('awl:lease:' + id), original), null);
            if (scenario === 'delete-project') {
              assert.equal(await page.evaluate(async id => await DB.get('projects', id), original), undefined);
              assert.equal(await page.evaluate(async id => await DB.get('vfs', id), original), undefined);
            }
            assert.equal(await page.evaluate(async id => await DB.get('sessions', id), session), undefined);
          }
        } else {
          await page.waitForFunction(() => __UI_STATE__.streamBuf.length > 500);
          const box = page.locator('#chatScroll'); await box.hover();
          await page.mouse.wheel(0, -120);
          await page.waitForFunction(() => { const b = document.querySelector('#chatScroll'); return b.scrollHeight - b.scrollTop - b.clientHeight > 70; });
          const before = await box.evaluate(b => b.scrollTop);
          stream.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '\n新的流式片段。'.repeat(100) } }] }) + '\n\n');
          await page.waitForFunction(() => __UI_STATE__.streamBuf.includes('新的流式片段'));
          await page.waitForFunction(() => document.querySelector('#streamMsg').textContent.includes('新的流式片段'));
          assert.ok(Math.abs(await box.evaluate(b => b.scrollTop) - before) < 3, 'short upward scroll must pause auto-follow');
          await box.evaluate(b => { b.scrollTop = 400; });
          await page.waitForFunction(() => __UI_STATE__.stickToBottom === false);
          const historyTop = await box.evaluate(b => b.scrollTop);
          stream.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '\n仍在输出。'.repeat(70) } }] }) + '\n\n');
          await page.waitForFunction(() => document.querySelector('#streamMsg').textContent.includes('仍在输出'));
          assert.ok(Math.abs(await box.evaluate(b => b.scrollTop) - historyTop) < 3);
          await page.evaluate(() => __UI__.renderChat());
          assert.ok(Math.abs(await box.evaluate(b => b.scrollTop) - historyTop) < 3, 'full redraw preserves history viewport');
          await box.evaluate(b => { b.scrollTop = b.scrollHeight; });
          await page.waitForFunction(() => __UI_STATE__.stickToBottom === true);
          stream.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '\n继续跟随。'.repeat(70) } }] }) + '\n\n');
          await page.waitForFunction(() => { const b = document.querySelector('#chatScroll'); return __UI_STATE__.streamBuf.includes('继续跟随') && b.scrollHeight - b.scrollTop - b.clientHeight < 3; });
          await page.locator('#sendBtn').click(); await page.waitForFunction(() => !__UI_STATE__.running);
        }
        assert.deepEqual(errors, []); console.log('PASS ' + scenario);
      } catch (error) { failed = true; console.error('FAIL ' + scenario + ': ' + error.message); }
      finally { await context.close(); }
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
