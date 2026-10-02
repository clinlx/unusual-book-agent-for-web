'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ready = require('./designer-ready.cjs');

(async () => {
  const dist = path.resolve('dist');
  fs.mkdirSync('tests/artifacts', { recursive: true });
  const prior = path.resolve('tests/artifacts/back-prior.html');
  fs.writeFileSync(prior, '<!doctype html><title>Previous page</title><p>Previous page</p>');
  const server = http.createServer((req, res) => {
    if (req.url === '/prior.html') return res.end(fs.readFileSync(prior));
    const name = path.basename(req.url.split('?')[0]);
    if (!['index.html', 'designer.html'].includes(name)) return res.writeHead(404).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(dist, name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    for (const mode of ['http', 'file']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      await context.route('https://**/*', route => {
        if (!route.request().url().startsWith('https://back.invalid/')) return route.abort();
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'opening', type: 'function', function: { name: 'append_story', arguments: JSON.stringify({ content: '雨落在车站。', one_line_summary_of_content: '到达车站' }) } },
          { id: 'end', type: 'function', function: { name: 'end_the_round', arguments: JSON.stringify({ NEXT_TURN_CACHE: { Story_Phase: '游戏循环', Game_World_Time: '夜晚' } }) } },
        ] }, finish_reason: 'tool_calls' }] }) });
      });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', () => errors.push('Native dialog opened'));
      const url = name => mode === 'http' ? `http://127.0.0.1:${server.address().port}/${name}` : pathToFileURL(path.join(dist, name)).href;
      const priorURL = mode === 'http' ? url('prior.html') : pathToFileURL(prior).href;
      const back = () => page.evaluate(() => new Promise(resolve => {
        window.addEventListener('popstate', () => setTimeout(resolve, 0), { once: true });
        history.back();
      }));
      const noOverlay = () => page.locator('.overlay').waitFor({ state: 'detached' });
      await page.goto(priorURL); await page.goto(url('designer.html'));
      await page.waitForFunction(() => window.__UI_STATE__?.sessionId && !document.querySelector('#boot'));
      await back(); await noOverlay();
      assert.equal(await page.evaluate(async () => (await DB.get('config', 'welcomeAcknowledged')).value), true);
      const length = await page.evaluate(() => history.length);
      await page.reload(); await ready(page); await page.reload(); await ready(page);
      assert.equal(await page.evaluate(() => history.length), length, 'reload does not accumulate guard entries');

      await page.locator('#tabbar button').filter({ hasText: '文件' }).click();
      const lamp = page.locator('#worldValidationBtn');
      await lamp.click();
      await page.locator('#worldValidationDialog h3').click();
      assert.equal(await page.locator('#worldValidationDialog').count(), 1, 'inside click keeps the dialog');
      await page.getByRole('button', { name: '关闭格式校验', exact: true }).click(); await noOverlay();
      await lamp.click(); await page.mouse.click(3, 3); await noOverlay();
      await lamp.click(); await back(); await noOverlay();
      assert.equal(page.url(), url('designer.html'));
      await page.evaluate(() => __UI__.setTab('chat'));
      await page.locator('button[title="设置"]').click(); await back(); await noOverlay();
      await page.evaluate(() => {
        window.__askResult = null;
        __UI__.askUserDialog([{ header: '主题', question: '故事主题？', options: [{ label: '冒险' }] }]).then(value => { window.__askResult = value; });
      });
      await back(); await noOverlay();
      assert.equal(await page.evaluate(() => __UI_STATE__.pendingAsk.minimized), true);
      assert.equal(await page.evaluate(() => window.__askResult), null, 'Back preserves unanswered AI questions');
      await page.evaluate(() => __UI_STATE__.pendingAsk.done('测试完成'));
      await page.evaluate(() => __UI__.setTab('sessions'));
      await page.locator('#projectBtn').click(); await back();
      assert.equal(await page.locator('.ctx-menu').count(), 0);
      assert.equal(await page.locator('#projectBtn').getAttribute('aria-expanded'), 'false');

      await page.evaluate(() => __UI__.openEditor('/workspace/README.md'));
      await page.locator('#editorText').fill('未保存的世界设定');
      await back(); await page.locator('.overlay').waitFor();
      await back(); await noOverlay();
      assert.equal(await page.locator('#editorText').inputValue(), '未保存的世界设定');
      await back(); await page.locator('.overlay .danger').click(); await noOverlay();
      await page.waitForFunction(() => __UI_STATE__.view === 'chat');
      await page.evaluate(() => { VFS.mkdir(__UI_STATE__.tree, '/workspace/子目录'); __UI_STATE__.fmRoot = '/workspace/子目录'; __UI__.renderAll(); });
      await back(); assert.equal(await page.evaluate(() => __UI_STATE__.fmRoot), '/workspace');
      await back(); assert.equal(await page.evaluate(() => __UI_STATE__.tab), 'chat');

      await page.evaluate(() => { window.__transfer = TransferDialog.open('世界交接'); __transfer.update('处理中'); });
      await back(); assert.equal(await page.locator('.world-transfer-overlay').count(), 1, 'Back cannot interrupt packaging');
      await page.evaluate(() => __transfer.choices('失败后可关闭', [['返回编辑', () => __transfer.close()]]));
      await back(); assert.equal(await page.locator('.world-transfer-overlay').count(), 0);
      await page.evaluate(() => history.back()); await page.waitForURL(priorURL);

      await page.goto(url('index.html')); await page.locator('[data-action="import"]').waitFor();
      await page.locator('[data-action="settings"]').click(); await back();
      assert.equal(await page.locator('#modal-root .modal').count(), 0);
      await page.locator('[data-action="import"]').click(); await page.locator('[data-action="import-url"]').click(); await back();
      assert.equal(await page.locator('#modal-root .modal').count(), 0);
      const gameLength = await page.evaluate(() => history.length);
      await page.reload(); await page.locator('[data-action="import"]').waitFor();
      assert.equal(await page.evaluate(() => history.length), gameLength);
      await page.evaluate(async () => {
        await GameApp.updateSettings({ apiKey: 'test', model: 'test', baseUrl: 'https://back.invalid/v1', stream: false });
        const zip = ZIP.makeZip([{ name: 'Player-p1/基础信息.json', text: '{"姓名":"林青","属性":{"生命":10}}' }, { name: 'Player-p1/背包.json', text: '[]' }, { name: '模组.md', text: '# 雨夜车站' }]);
        await GameApp.importSave(new File([zip], '返回键测试.zip'));
      });
      const saveName = await page.evaluate(() => GameApp.getState().active.name);
      await page.locator('[data-action="start"]').click();
      await page.waitForFunction(() => GameApp.getState().active?.round === 1 && !GameApp.getState().running);
      await page.locator('[data-action="debug"]').click();
      await page.locator('[data-action="mobile-right"]').click();
      const file = page.locator('.file-tree [data-action="open-file"]').filter({ hasText: '模组.md' });
      await file.click(); await page.locator('#file-editor').fill('未保存的故事');
      await back(); await page.locator('#dialog-root .app-dialog').waitFor();
      await back(); await page.locator('#dialog-root .app-dialog').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#file-editor').inputValue(), '未保存的故事');
      await back(); await page.locator('[data-dialog-value="confirm"]').click();
      await page.locator('#file-editor').waitFor({ state: 'detached' });
      await back(); await page.locator('.game-layout.mobile-center').waitFor();
      await back(); await page.waitForFunction(() => GameApp.getState().mode === 'play');
      await page.locator('#action-input').fill('返回前保留草稿');
      await back(); await page.waitForFunction(() => !GameApp.getState().active);
      await page.locator('[data-action="rename-save"]').click();
      await page.locator('#app-prompt-input').fill('不应提交的名称'); await back();
      await page.locator('#dialog-root .app-dialog').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.save-card h2').innerText(), saveName);
      await page.locator('[data-action="open-save"]').click();
      await page.waitForFunction(() => !!GameApp.getState().active);
      assert.equal(await page.locator('#action-input').inputValue(), '返回前保留草稿');
      await back(); await page.waitForFunction(() => !GameApp.getState().active);
      await page.evaluate(() => { window.__transfer = TransferDialog.open('导入世界'); __transfer.update('处理中'); });
      await back(); assert.equal(await page.locator('.world-transfer-overlay').count(), 1);
      await page.evaluate(() => __transfer.choices('可关闭', [['关闭', () => __transfer.close()]]));
      await back(); assert.equal(await page.locator('.world-transfer-overlay').count(), 0);
      await page.evaluate(() => history.back()); await page.waitForURL(priorURL);
      assert.deepEqual(errors, []);
      console.log(`PASS ${mode}: mobile Back, dialogs, menus, dirty editors, questions, draft, progress, repeated reload and normal page exit`);
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
