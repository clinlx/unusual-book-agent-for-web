'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const readyDesigner = require('./designer-ready.cjs');
const dist = path.resolve(__dirname, '../../dist');
const artifacts = path.resolve(__dirname, '../artifacts');
let server, browser, origin;

before(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(dist + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openSettings(page, name) {
  await page.goto(origin + '/' + (name === 'game' ? 'index.html' : 'designer.html'));
  if (name === 'game') await page.locator('[data-action="settings"]').click();
  else {
    await readyDesigner(page);
    await page.getByRole('button', { name: '设置', exact: true }).click();
  }
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  for (const name of ['game', 'designer']) {
    test(name + ' request help is visible immediately and toggles with mouse and keyboard at width ' + viewport.width, async () => {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        await page.route('https://**/*', route => route.abort());
        await openSettings(page, name);
        const button = page.locator('.api-settings-heading button');
        const panel = page.locator('#api-options-help');
        assert.equal(await button.count(), 1, 'both settings pages have a request help button');
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
        assert.equal(await panel.isHidden(), true);
        await button.click();
        assert.equal(await button.getAttribute('aria-expanded'), 'true');
        assert.equal(await panel.isVisible(), true);
        const inView = await panel.evaluate(panel => {
          const text = panel.querySelector('p').getBoundingClientRect();
          const clip = panel.closest('.modal-body, .modal').getBoundingClientRect();
          return text.top >= Math.max(0, clip.top) && text.top < Math.min(innerHeight, clip.bottom);
        });
        assert.equal(inView, true, 'clicking i exposes the explanation inside the visible settings area');
        await page.screenshot({ path: path.join(artifacts, 'settings-' + name + '-' + viewport.width + '.png') });
        await button.press('Enter');
        assert.equal(await panel.isHidden(), true);
        await button.press('Space');
        assert.equal(await panel.isVisible(), true);
        await button.click();
        assert.equal(await panel.isHidden(), true);
      } finally { await context.close(); }
    });
  }
}

for (const name of ['game', 'designer']) {
  test(name + ' connection test, model listing and saved requests accept a complete chat endpoint', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    try {
      const page = await context.newPage(), urls = [], errors = [];
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://**/*', async route => {
        const url = route.request().url();
        if (!url.startsWith('https://settings.invalid/')) return route.abort();
        urls.push(url);
        const models = url === 'https://settings.invalid/gateway/v1/models';
        const chat = url === 'https://settings.invalid/gateway/v1/chat/completions';
        await route.fulfill({ status: models || chat ? 200 : 404, contentType: 'application/json',
          body: JSON.stringify(models ? { data: [{ id: 'settings-test' }] }
            : { choices: [{ message: { content: 'OK' } }] }) });
      });
      await openSettings(page, name);
      const field = label => page.locator('.modal .row').filter({ has: page.locator('label', { hasText: new RegExp('^' + label + '$') }) }).locator('input');
      const base = name === 'game' ? page.locator('[name="baseUrl"]') : field('API Base URL');
      const key = name === 'game' ? page.locator('[name="apiKey"]') : field('API Key');
      const model = name === 'game' ? page.locator('[name="model"]') : field('模型');
      await key.fill('test-only');
      await model.fill('settings-test');
      for (const suffix of ['/chat/completions', '/chat/completions///']) {
        await base.fill('https://settings.invalid/gateway/v1' + suffix);
        await page.getByRole('button', { name: '测试连接', exact: true }).click();
        const result = page.locator(name === 'game' ? '#connection-result' : '.api-test-result');
        await result.filter({ hasText: /连接成功/ }).waitFor();
        await (name === 'game' ? page.locator('[data-action="fetch-models"]')
          : page.getByRole('button', { name: '从接口获取模型列表' })).click();
        await page.locator(name === 'game' ? '#model-list-result' : '#modelListOpts option').filter(
          name === 'game' ? { hasText: /获取成功/ } : { hasText: '' }).waitFor({ state: 'attached' });
      }
      await page.getByRole('button', { name: name === 'game' ? '保存设置' : '保存', exact: true }).click();
      await page.reload();
      if (name === 'game') {
        await page.locator('[data-action="settings"]').waitFor();
        await page.evaluate(() => GameTransport.create({ ...GameApp.getState().settings, stream: false }, [])([{ role: 'user', content: 'hello' }]));
      } else {
        await readyDesigner(page);
        await page.evaluate(() => Agent.createHttpTransport({ ...__UI_STATE__.settings, stream: false }, [])([{ role: 'user', content: 'hello' }]));
      }
      assert.equal(urls.length, 5);
      assert.deepEqual(urls, [
        'https://settings.invalid/gateway/v1/chat/completions', 'https://settings.invalid/gateway/v1/models',
        'https://settings.invalid/gateway/v1/chat/completions', 'https://settings.invalid/gateway/v1/models',
        'https://settings.invalid/gateway/v1/chat/completions',
      ]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const name of ['game', 'designer']) {
  test(name + ' shortcut inversion is explained, persisted, and works in the actual composer', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      let requests = 0;
      await page.route('https://**/*', async route => {
        if (!route.request().url().startsWith('https://shortcuts.invalid/')) return route.abort();
        requests++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '已接收' } }] }) });
      });
      await openSettings(page, name);
      if (name === 'game') await page.locator('[data-settings-section="game"] > summary').click();
      const checkbox = name === 'game' ? page.locator('[name="reverseSendNewline"]') : page.getByRole('checkbox', { name: '反转发送与换行' });
      assert.equal(await checkbox.isChecked(), false);
      const explanation = await page.locator(name === 'game' ? '#settings-form' : '.modal').innerText();
      assert.match(explanation, /默认.*发送.*换行.*开启后.*发送.*换行/);
      if (name === 'game') assert.equal(await page.locator('[data-action="prompts"]').count(), 0);
      await checkbox.check();
      if (name === 'designer') {
        const field = text => page.locator('.modal .row').filter({ has: page.locator('label', { hasText: new RegExp('^' + text + '$') }) }).locator('input');
        await field('API Base URL').fill('https://shortcuts.invalid/v1');
        await field('API Key').fill('test-only');
        await page.locator('.modal .row').filter({ has: page.locator('label', { hasText: /^流式输出$/ }) }).locator('select').selectOption('0');
      }
      await page.getByRole('button', { name: name === 'game' ? '保存设置' : '保存', exact: true }).click();
      await page.reload();
      if (name === 'designer') await readyDesigner(page);
      assert.equal(await page.evaluate(name => name === 'game' ? GameApp.getState().settings.reverseSendNewline : __UI_STATE__.settings.reverseSendNewline, name), true);
      if (name === 'game') {
        await page.evaluate(async () => {
          const zip = ZIP.makeZip([{ name: 'Player-pc/基础信息.json', content: '{"姓名":"测试"}' }, { name: 'Player-pc/背包.json', content: '[]' }]);
          await GameApp.importSave(new File([zip], '快捷键.zip'));
          GameApp.getState().active.status = 'waiting';
          GameApp.setMode('play');
        });
        const input = page.locator('#action-input');
        await page.waitForFunction(() => document.querySelector('#action-input') && !document.querySelector('#action-input').disabled);
        await page.evaluate(() => {
          window.__shortcutSubmits = 0;
          document.querySelector('#action-form').onsubmit = event => { event.preventDefault(); event.stopPropagation(); window.__shortcutSubmits++; };
        });
        await input.fill('第一行'); await input.press('Control+Enter');
        assert.equal(await input.inputValue(), '第一行\n');
        assert.equal(await page.evaluate(() => __shortcutSubmits), 0);
        await input.press('Enter');
        assert.equal(await page.evaluate(() => __shortcutSubmits), 1);
        const defaults = await page.evaluate(() => {
          GameApp.getState().settings.promptOverrides['reference/游戏前准备.md'] = '旧覆盖';
          GameApp.getState().settings.promptOverrides['system/host.md'] = '忽略此旧系统覆盖';
          return { actual: GameApp.readFile('/.reference/游戏前准备.md'), expected: Prompts.get('reference/游戏前准备.md'), editable: typeof GameApp.savePrompt,
            system: GameApp.currentContext().find(message => message.role === 'system').content, expectedSystem: Prompts.buildSystem() };
        });
        assert.equal(defaults.actual, defaults.expected);
        assert.equal(defaults.editable, 'undefined');
        assert.equal(defaults.system, defaults.expectedSystem);
        const colors = await page.evaluate(() => {
          const box = document.createElement('div');
          box.innerHTML = GamePresentation.fields([{ 名称: '新增测试', 余量: 1 }], [], 'test');
          document.body.append(box);
          const tag = box.querySelector('.change-tag.added'), style = getComputedStyle(tag);
          return { text: tag.textContent, radius: style.borderRadius, background: style.backgroundColor, display: style.display };
        });
        assert.deepEqual(colors, { text: '新增', radius: '999px', background: 'rgb(229, 240, 228)', display: 'inline-flex' });
        await page.evaluate(() => GameApp.updateSettings({ reverseSendNewline: false }));
        await page.waitForFunction(() => document.querySelector('.composer-bottom').textContent.includes('Ctrl / ⌘ + Enter 发送'));
        await page.evaluate(() => {
          window.__shortcutSubmits = 0;
          document.querySelector('#action-form').onsubmit = event => { event.preventDefault(); event.stopPropagation(); window.__shortcutSubmits++; };
        });
        await input.fill('恢复默认'); await input.press('Enter');
        assert.equal(await input.inputValue(), '恢复默认\n');
        assert.equal(await page.evaluate(() => __shortcutSubmits), 0);
        await input.press('Control+Enter');
        assert.equal(await page.evaluate(() => __shortcutSubmits), 1);
      } else {
        const input = page.locator('#chatInput');
        await input.fill('第一行'); await input.press('Control+Enter');
        assert.equal(requests, 0);
        await input.press('Enter');
        await page.waitForFunction(() => !__UI_STATE__.running && __UI_STATE__.tree);
        await page.waitForTimeout(100);
        assert.equal(requests, 1);
        await page.evaluate(() => { __UI_STATE__.settings.reverseSendNewline = false; });
        await input.fill('恢复默认'); await input.press('Enter');
        assert.equal(requests, 1);
        await input.press('Control+Enter');
        await page.waitForFunction(() => !__UI_STATE__.running);
        await page.waitForTimeout(100);
        assert.equal(requests, 2);
      }
    } finally { await context.close(); }
  });
}
