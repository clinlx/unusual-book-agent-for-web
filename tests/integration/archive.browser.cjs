'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const VFS = require('../../src/vfs');
const Core = require('../../src/game-core');
const Presentation = require('../../src/game-presentation');
let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

for (const [name, status] of [
  ['canonical', { 状态: { HP: 9, MAXHP: 12, MP: 4, MAXMP: 8, SAN: 60 } }],
  ['aliases', { Status: { Health: 9, MaxHealth: 12, Mana: 4, MaxMana: 8, Sanity: 60 } }],
]) {
  test('offline replay displays ' + name + ' resources, safe data and mobile tabs without network access', async t => {
    const tree = VFS.createTree();
    VFS.writeFile(tree, '/workspace/Player-p/基础信息.json', JSON.stringify({ 姓名: '青', ...status, '.秘密': 'HIDDEN_CHARACTER' }));
    VFS.writeFile(tree, '/workspace/Player-p/背包.json', JSON.stringify([{ 名称: '钥匙', 剧情台本: 'HIDDEN_ITEM' }]));
    const save = Core.createSave('<script>window.injected=true</script>', tree);
    save.events = [
      { type: 'story', round: 1, content: '<img src=x onerror="window.injected=true">' },
      { type: 'dice', round: 1, secret: true, content: 'SECRET_DICE' },
      { type: 'round_end', round: 1 },
      { type: 'assistant', content: 'INTERNAL_MODEL' },
    ];
    VFS.writeFile(tree, '/workspace/过往回合历史记忆/Round_1_Time_夜晚/玩家结束状态.json', JSON.stringify(Core.player(save)));
    const file = path.resolve(__dirname, '../artifacts/archive-' + name + '-' + randomUUID() + '.html');
    t.after(() => fs.rmSync(file, { force: true }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Presentation.historyHTML(save, undefined, Core.player(save)));
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    try {
      const page = await context.newPage(), errors = [], network = [];
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
      await page.route('https://**/*', route => route.abort());
      await page.goto(pathToFileURL(file).href);
      await page.locator('#replay-next').click();
      assert.equal(await page.locator('.history article.revealed').count(), 1);
      await page.locator('#replay-next').click();
      assert.match(await page.locator('.history').innerText(), /SECRET_DICE/);
      await page.locator('#replay-next').click();
      await page.locator('#archive-vitals .resource').first().waitFor();
      assert.equal(await page.locator('#archive-vitals .resource').count(), 3);
      assert.match(await page.locator('#archive-vitals').innerText(), /9 \/ 12/);
      assert.match(await page.locator('#archive-vitals').innerText(), /4 \/ 8/);
      assert.match(await page.locator('#archive-vitals').innerText(), /60 \/ 99/);
      await page.locator('[data-mode="overview"]').click();
      assert.match(await page.locator('#archive-vitals').innerText(), /9 \/ 12/);
      assert.match(await page.locator('#status-content').innerText(), /青/);
      assert.doesNotMatch(await page.locator('body').innerText(), /HIDDEN_CHARACTER|HIDDEN_ITEM|INTERNAL_MODEL/);
      assert.equal(await page.locator('img').count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      await page.setViewportSize({ width: 390, height: 844 });
      for (const tab of ['items', 'status', 'story']) {
        await page.locator('label[for="archive-tab-' + tab + '"]').click();
        assert.equal(await page.locator('#archive-' + tab).isVisible(), true);
      }
      await page.locator('[data-mode="replay"]').click();
      await page.locator('#replay-prev').click();
      assert.equal(await page.locator('.history article.revealed').count(), 2);
      assert.deepEqual(network, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
