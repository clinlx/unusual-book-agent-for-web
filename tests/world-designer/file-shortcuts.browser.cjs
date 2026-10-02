'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const failures = [], errors = [];
  try {
    async function scenario(name, run) {
      const page = await browser.newPage();
      page.setDefaultTimeout(2500);
      page.on('pageerror', e => errors.push(e.message));
      try {
        await page.goto(pathToFileURL(path.resolve(__dirname, '../../dist/designer.html')).href);
        await require('../integration/designer-ready.cjs')(page);
        await page.evaluate(async () => {
          const s = __UI_STATE__;
          VFS.writeFile(s.tree, '/workspace/a.txt', 'alpha');
          VFS.writeFile(s.tree, '/workspace/b.txt', 'beta');
          VFS.writeFile(s.tree, '/workspace/folder/child.txt', 'child');
          await __UI__.saveTree(); __UI__.renderFileTree();
        });
        await run(page);
        console.log('PASS:', name);
      } catch (e) { failures.push(name + ': ' + e.message); }
      finally { await page.close(); }
    }
    const row = (page, name) => page.locator('#fileTree .tree-item[data-path="/workspace/' + name + '"]');
    const focusedPath = page => page.evaluate(() => document.activeElement.dataset.path);
    await scenario('F2 rename keeps selection and focus; Delete can follow immediately', async page => {
      await row(page, 'a.txt').click();
      await page.keyboard.press('F2');
      await page.locator('.modal > input').fill('renamed.txt');
      await page.locator('.modal > input').press('Enter');
      await row(page, 'renamed.txt').waitFor();
      assert.equal(await focusedPath(page), '/workspace/renamed.txt');
      await page.keyboard.press('Delete');
      await page.locator('.overlay').getByRole('button', { name: '确认', exact: true }).click();
      await page.waitForFunction(() => !VFS.resolve(__UI_STATE__.tree, ['workspace', 'renamed.txt']));
      await row(page, 'renamed.txt').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'filePanel');
    });
    await scenario('folder expansion, cancellation and keyboard navigation retain focus', async page => {
      await row(page, 'folder').click();
      assert.equal(await focusedPath(page), '/workspace/folder');
      await page.keyboard.press('Delete');
      await page.locator('.overlay').getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await focusedPath(page), '/workspace/folder');
      await page.keyboard.press('F2');
      await page.keyboard.press('Escape');
      assert.equal(await focusedPath(page), '/workspace/folder');
      await page.keyboard.press('ArrowDown');
      assert.equal(await focusedPath(page), '/workspace/folder/child.txt');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await focusedPath(page), '/workspace/folder');
      await page.keyboard.press('ArrowRight');
      assert.equal(await focusedPath(page), '/workspace/folder');
    });
    await scenario('visible file list shortcuts work alongside the editor without intercepting text input', async page => {
      await page.evaluate(() => {
        __UI_STATE__.settings.editorPosition = 'center'; __UI__.applyEditorPosition();
        __UI__.openEditor('/workspace/a.txt');
      });
      await row(page, 'b.txt').click();
      await page.keyboard.press('Delete');
      await page.locator('.overlay').getByRole('button', { name: '取消', exact: true }).click();
      await row(page, 'a.txt').click();
      await page.keyboard.press('F2');
      await page.locator('.modal > input').fill('editor-renamed.txt');
      await page.locator('.modal > input').press('Enter');
      await row(page, 'editor-renamed.txt').waitFor();
      assert.equal(await page.evaluate(() => __UI_STATE__.editorPath), '/workspace/editor-renamed.txt');
      await page.locator('#editorText').focus();
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('Delete');
      assert.equal(await page.locator('#editorText').inputValue(), 'lpha');
      await page.keyboard.press('F2');
      assert.equal(await page.locator('.overlay').count(), 0);
      assert.equal(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/editor-renamed.txt').content), 'alpha');
    });
    await scenario('copy, cut and paste work after rerender; chat typing does not act on the selected file', async page => {
      await row(page, 'a.txt').click();
      await page.keyboard.press('Control+c');
      await page.keyboard.press('Control+v');
      await row(page, 'a - 副本.txt').waitFor();
      assert.equal(await focusedPath(page), '/workspace/a - 副本.txt');
      await page.keyboard.press('Control+x');
      await row(page, 'folder').click();
      await page.keyboard.press('Control+v');
      await row(page, 'folder/a - 副本.txt').waitFor();
      assert.equal(await focusedPath(page), '/workspace/folder/a - 副本.txt');
      assert.equal(await row(page, 'a - 副本.txt').count(), 0);
      await page.locator('#chatInput').fill('hello');
      await page.keyboard.press('Home');
      await page.keyboard.press('Delete');
      await page.keyboard.press('F2');
      assert.equal(await page.locator('#chatInput').innerText(), 'ello');
      assert.equal(await page.locator('.overlay').count(), 0);
      assert.equal(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/folder/a - 副本.txt').content), 'alpha');
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
