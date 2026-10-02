'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { fixture } = require('./world-fixture.cjs');
const ready = require('./designer-ready.cjs');
(async () => {
  const dist = path.resolve('dist');
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + req.url.split('?')[0]);
    if (!file.startsWith(dist + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (error, data) => { if (error) return res.writeHead(404).end(); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(data); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    for (const mode of ['file', 'http']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } }), page = await context.newPage(), errors = [];
      page.setDefaultTimeout(10000);
      await context.route('https://**/*', route => route.abort());
      page.on('pageerror', error => errors.push(error.message)); page.on('dialog', () => errors.push('native dialog'));
      const base = mode === 'file' ? pathToFileURL(dist + path.sep).href : `http://127.0.0.1:${server.address().port}/`;
      const game = new URL('index.html', base).href, designer = new URL('designer.html', base).href;
      const openList = async () => {
        await page.locator('[data-action="import"]').first().click();
        await page.locator('[data-action="import-designer"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-designer-projects]')?.textContent.includes('正在读取'));
      };
      await page.goto(game); await page.locator('[data-action="import"]').first().waitFor(); await openList();
      assert.match(await page.locator('[data-designer-projects]').innerText(), /还没有/);
      assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'agent-workbench')), false, 'game must not create the designer database');
      await page.getByRole('button', { name: '打开世界设计者', exact: true }).click(); await ready(page);
      const mainId = await page.evaluate(() => __UI_STATE__.projectId);
      await page.evaluate(async tree => {
        __UI_STATE__.tree.children.workspace = tree.children.workspace;
        VFS.writeFile(__UI_STATE__.tree, '/workspace/world/cover.png', 'AQIDBA==', { encoding: 'base64' });
        VFS.writeFile(__UI_STATE__.tree, '/workspace/world/.trpg-save.json', '{}');
        __UI_STATE__.tree.children.workspace.children['world-two'] = structuredClone(__UI_STATE__.tree.children.workspace.children.world);
        __UI_STATE__.tree.children.workspace.children['world-two'].name = 'world-two';
        VFS.writeFile(__UI_STATE__.tree, '/workspace/world-two/选择标记.md', '选择了第二个世界');
        await __UI__.saveTree();
        // A failed summary write must roll back the matching workspace write as well.
        const before = await DB.get('vfs', __UI_STATE__.projectId), status = await DB.get('config', DesignerProjects.key(__UI_STATE__.projectId));
        const put = IDBObjectStore.prototype.put;
        let failed = false;
        try {
          IDBObjectStore.prototype.put = function (...args) { if (this.name === 'config') throw Error('test checkpoint write failure'); return put.apply(this, args); };
          try { await DB.putWorkspace(__UI_STATE__.projectId, { type: 'dir', children: {} }, { valid: false }); } catch (_) { failed = true; }
        } finally { IDBObjectStore.prototype.put = put; }
        if (!failed || JSON.stringify(before) !== JSON.stringify(await DB.get('vfs', __UI_STATE__.projectId)) || JSON.stringify(status) !== JSON.stringify(await DB.get('config', DesignerProjects.key(__UI_STATE__.projectId)))) throw Error('checkpoint transaction did not roll back atomically');
        await DB.put('projects', { id: 'legacy', name: '未校验项目', createdAt: Date.now() });
        await DB.put('projects', { id: 'failed', name: '<失败项目>', createdAt: Date.now() });
        await DB.put('config', { id: DesignerProjects.key('failed'), value: { valid: false, current: true, checkedAt: Date.now(), roots: [{ path: '/workspace', valid: false }] } });
      }, fixture().tree);
      await page.reload(); await ready(page);
      assert.equal(await page.locator('#worldValidationBtn').getAttribute('data-state'), 'valid');
      await page.goto(game); await page.locator('[data-action="import"]').first().waitFor(); await openList();
      const main = page.locator(`.designer-project-row[data-project-id="${mainId}"]`);
      assert.equal(await main.locator('.designer-project-light').getAttribute('data-state'), 'valid');
      assert.match(await main.locator('.designer-project-light').getAttribute('title'), /校验通过/);
      assert.equal(await main.locator('.designer-project-pick').isEnabled(), true);
      assert.equal(await page.locator('[data-project-id="legacy"] .designer-project-pick').isDisabled(), true);
      assert.equal(await page.locator('[data-project-id="failed"] .designer-project-pick').isDisabled(), true);
      assert.equal(await page.locator('[data-project-id="failed"] img').count(), 0);
      assert.equal(await page.locator('.designer-project-edit').count(), 3);
      assert.doesNotMatch(await page.locator('[data-designer-projects]').innerText(), /\[文件缺失\]|\[字段缺失\]/);
      if (mode === 'http') {
        await page.screenshot({ path: 'tests/artifacts/designer-project-selector.png', animations: 'disabled' });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: 'tests/artifacts/designer-project-selector-mobile.png', animations: 'disabled' });
        await page.setViewportSize({ width: 1440, height: 960 });
      }
      await page.locator('[data-project-id="failed"] .designer-project-edit').click();
      await page.waitForFunction(() => window.__UI_STATE__?.projectId === 'failed' && !document.querySelector('#boot'));
      assert.equal(await page.evaluate(() => __UI_STATE__.projectId), 'failed', 'edit opens the chosen project rather than the previous one');
      await page.goto(game); await page.locator('[data-action="import"]').first().waitFor(); await openList();
      await main.locator('select').selectOption('/workspace/world-two');
      await main.locator('.designer-project-pick').click();
      await page.waitForFunction(() => GameApp.getState().active && !document.querySelector('.world-transfer-overlay'));
      assert.equal(await page.evaluate(() => GameApp.getState().saves.length), 1);
      assert.equal(await page.evaluate(() => GameApp.getState().active.tree.children.workspace.children['cover.png'].content), 'AQIDBA==');
      assert.equal(await page.evaluate(() => GameApp.readFile('/workspace/选择标记.md')), '选择了第二个世界');
      assert.equal(await page.evaluate(() => !!GameApp.getState().active.tree.children.workspace.children['.trpg-save.json']), false);
      assert.equal(await page.evaluate(() => GameApp.getState().active.messages.length), 0, 'import never starts a model request');
      // Repeated deliberate imports create independent saves.
      await page.goto(game); await page.locator('[data-action="import"]').first().waitFor(); await openList();
      await main.locator('.designer-project-pick').click();
      await page.waitForFunction(() => GameApp.getState().saves.length === 2 && !document.querySelector('.world-transfer-overlay'));
      // A status change after listing must be caught before packaging.
      await page.goto(game); await page.locator('[data-action="import"]').first().waitFor(); await openList();
      await page.evaluate(async id => {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('agent-workbench'); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
        const tx = db.transaction('config', 'readwrite');
        tx.objectStore('config').put({ id: DesignerProjects.key(id), value: { valid: false, current: true, checkedAt: Date.now(), roots: [] } });
        await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
      }, mainId);
      await main.locator('.designer-project-pick').click();
      await page.getByRole('button', { name: '重新选择项目', exact: true }).waitFor();
      assert.match(await page.locator('.world-transfer-overlay').innerText(), /尚未通过最新校验/);
      assert.equal(await page.evaluate(() => GameApp.getState().saves.length), 2);
      await page.getByRole('button', { name: '重新选择项目', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.designer-project-row') !== null);
      assert.equal(await main.locator('.designer-project-pick').isDisabled(), true);
      assert.deepEqual(errors, []);
      console.log('PASS ' + mode + ': persisted lamps, unknown/failed projects, read-only database, targeted edit, local import, independent saves and stale status guard');
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
