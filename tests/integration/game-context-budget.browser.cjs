'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
let server, browser, origin;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/index.html') return res.writeHead(404).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.resolve(__dirname, '../../dist/index.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
test('game blocks an oversized tool result before the next HTTP request and resumes the saved round after reload', async t => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } }); t.after(() => context.close());
  const page = await context.newPage(), errors = []; let requests = 0;
  page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.route('https://**/*', async route => {
    if (!route.request().url().startsWith('https://game-context.invalid/')) return route.abort();
    requests++;
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const message = requests === 1 ? { content: '', tool_calls: [
      call('write', 'write_file', { path: '/workspace/proof.txt', content: '已完成写入' }),
      call('read', 'read_file', { path: '/workspace/large.txt', limit: 120000 }),
    ] } : { content: '', tool_calls: [
      call('story', 'append_story', { content: '雨停了，旅程继续。', one_line_summary_of_content: '继续旅程' }),
      call('end', 'end_the_round', { NEXT_TURN_CACHE: { Story_Phase: '游戏循环' } }),
    ] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message }] }) });
  });
  await page.goto(origin + '/index.html'); await page.locator('[data-action="import"]').waitFor();
  await page.evaluate(async () => {
    const blob = ZIP.makeZip([{ name: 'Player-p/基础信息.json', text: '{"姓名":"玩家"}' }, { name: 'Player-p/背包.json', text: '[]' },
      { name: 'large.txt', text: '文'.repeat(120000) }]);
    await GameApp.importSave(new File([blob], '上下文回归.zip'));
    const input = GameCore.estimate(GameApp.currentContext()), tools = GameCore.estimate(GameTools.build(Prompts, {}));
    const maxContextK = Math.ceil((input + tools + 1024 + 6000) / 1000);
    await GameApp.updateSettings({ baseUrl: 'https://game-context.invalid/v1', apiKey: 'test-only', model: 'test', stream: false, maxOutputTokens: 1024, maxContextK });
    await GameApp.start().catch(() => {});
  });
  await page.waitForFunction(() => !GameApp.getState().running);
  assert.equal(requests, 1);
  assert.equal(await page.evaluate(() => GameApp.getState().active.status), 'interrupted');
  assert.match(await page.evaluate(() => GameApp.getState().error), /上下文上限/);
  assert.equal(await page.evaluate(() => GameApp.readFile('/workspace/proof.txt')), '已完成写入');
  const userCount = await page.evaluate(() => GameApp.getState().active.events.filter(e => e.type === 'player').length);
  await page.reload(); await page.locator('[data-action="open-save"]').first().click();
  await page.waitForFunction(() => !!GameApp.getState().active);
  await page.evaluate(async () => {
    await GameApp.writeFile('/workspace/proof.txt', '中断后的手动编辑');
    await GameApp.updateSettings({ maxContextK: 400 });
  });
  await page.locator('#action-form [data-action="resume"]').click();
  await page.waitForFunction(() => !GameApp.getState().running && GameApp.getState().active.activeRound.complete);
  assert.equal(requests, 2);
  assert.equal(await page.evaluate(() => GameApp.readFile('/workspace/proof.txt')), '中断后的手动编辑');
  assert.equal(await page.evaluate(() => GameApp.getState().active.events.filter(e => e.callId === 'write').length), 1);
  assert.equal(await page.evaluate(() => GameApp.getState().active.events.filter(e => e.type === 'player').length), userCount);
  assert.deepEqual(errors, []);
});
