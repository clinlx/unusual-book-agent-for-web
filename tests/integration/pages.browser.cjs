'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const readyDesigner = require('./designer-ready.cjs');
const { parseFrontmatter } = require('../../src/world-designer/skills');
const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'dist');
const expected = ['game-world-builder', 'write-novel', 'desire-analysis', 'grilling'];
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(dist + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], resources = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/skills|skill_enable/.test(request.url())) resources.push(request.url()); });
    const base = 'http://127.0.0.1:' + server.address().port;
    let modelRequests = 0;
    await context.route('https://**/*', async route => {
      if (!route.request().url().startsWith('https://integration.invalid/')) return route.abort();
      const body = route.request().postDataJSON();
      if (body.model === 'game-only-model') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: {
          role: 'assistant', content: '', tool_calls: [
            call('append_story', { content: '雨水落在车站的屋檐上。', one_line_summary_of_content: '抵达车站' }, 'opening'),
            call('end_the_round', { NEXT_TURN_CACHE: { Story_Phase: '游戏循环', Game_World_Time: '夜晚' } }, 'end-opening'),
          ],
        }, finish_reason: 'tool_calls' }] }) });
      }
      modelRequests++;
      assert.ok(body.messages[0].content.trimEnd().endsWith(parseFrontmatter(fs.readFileSync(path.join(root, 'skills/game-world-builder/SKILL.md'), 'utf8')).body.trimEnd()));
      assert.ok(body.tools.some(tool => tool.function.name === 'validate_game_structure'));
      if (modelRequests === 3) {
        const result = JSON.parse(body.messages.find(message => message.tool_call_id === 'check-world').content);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(error => error.includes('缺失')));
        assert.equal(result.path, '/workspace');
      }
      const message = modelRequests === 1
        ? { role: 'assistant', content: '', tool_calls: [call('write_file', { path: '/workspace/世界设定.md', content: '# 雨夜车站\n旅人抵达月台。' }, 'write-world')] }
        : modelRequests === 2 ? { role: 'assistant', content: '', tool_calls: [call('validate_game_structure', { path: '/workspace' }, 'check-world')] }
        : { role: 'assistant', content: '世界设定已写入。' };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: modelRequests < 3 ? 'tool_calls' : 'stop' }] }) });
    });
    const waitDesigner = () => readyDesigner(page);
    const waitGame = () => page.locator('[data-action="import"]').waitFor();

    await page.goto(base + '/index.html');
    await waitGame();
    await page.evaluate(async () => {
      await GameApp.updateSettings({ model: 'game-only-model', baseUrl: 'https://integration.invalid/v1', apiKey: 'test-only', stream: false });
      const zip = ZIP.makeZip([
        { name: 'Player-p1/基础信息.json', text: '{"姓名":"林青","属性":{"生命":10}}' },
        { name: 'Player-p1/背包.json', text: '[]' },
        { name: '模组.md', text: '# 雨夜车站' },
      ]);
      await GameApp.importSave(new File([zip], '页面切换存档.zip'));
    });
    assert.equal(await page.locator('[data-action="history-export"]').isDisabled(), true, 'an unplayed world has no gameplay record to export');
    await page.locator('[data-action="start"]').click();
    await page.waitForFunction(() => GameApp.getState().active?.round === 1 && !GameApp.getState().running);
    await page.waitForFunction(() => !document.querySelector('[data-action="history-export"]')?.disabled);
    assert.equal(await page.locator('[data-action="history-export"]').isEnabled(), true, 'the first played round enables gameplay export');
    await page.locator('#action-input').fill('保留跑团输入');
    assert.equal(await page.locator('a[data-page-switch]').count(), 0, 'the play page has no designer entry');
    await page.locator('[data-action="debug"]').click();
    assert.equal(await page.locator('a[data-page-switch]').count(), 0, 'debugging an active save also has no designer entry');
    await page.locator('[data-action="home"]').click();
    await page.locator('a[data-page-switch]').click();
    await waitDesigner();
    assert.equal(await page.title(), '世界设计者');
    const projectButton = page.locator('#projectBtn');
    await projectButton.click();
    assert.equal(await page.locator('.ctx-menu').count(), 1);
    await projectButton.click();
    assert.equal(await page.locator('.ctx-menu').count(), 0, 'second project click closes the list');
    assert.equal(await projectButton.getAttribute('aria-expanded'), 'false');
    await projectButton.click();
    await page.keyboard.press('Escape');
    assert.equal(await projectButton.getAttribute('aria-expanded'), 'false');
    await projectButton.click();
    await page.locator('.ctx-menu').getByRole('button', { name: '默认项目', exact: true }).click();
    assert.equal(await page.locator('.ctx-menu').count(), 0);
    await projectButton.click();
    await page.locator('.workspace-heading').click();
    assert.equal(await projectButton.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await page.evaluate(() => __UI_STATE__.externalSkills.map(s => s.name)), expected);
    assert.equal(await page.evaluate(() => __UI_STATE__.skillLoad.origin), 'bundled');
    assert.deepEqual(resources, [], 'standalone designer must not fetch external skills');
    assert.ok(await page.evaluate(() => VFS.resolve(__UI_STATE__.tree, ['skills', 'game-world-builder', 'scripts', 'validate_game_structure.js'])));
    assert.notEqual(await page.evaluate(() => __UI_STATE__.settings.model), 'game-only-model');

    await page.evaluate(async () => {
      Object.assign(__UI_STATE__.settings, { baseUrl: 'https://integration.invalid/v1', apiKey: 'test-only', model: 'designer-test', stream: false });
      await DB.put('config', { id: 'settings', value: __UI_STATE__.settings });
    });
    await page.locator('#chatInput').fill('创建一个雨夜车站的世界设定');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => !__UI_STATE__.running && !!VFS.resolve(__UI_STATE__.tree, ['workspace', '世界设定.md']));
    assert.equal(modelRequests, 3);
    assert.ok(await page.locator('.abyss-eye svg').count());
    assert.equal(await page.locator('.abyss-eye img').count(), 0);
    await page.evaluate(() => __UI__.openEditor('/workspace/世界设定.md'));
    await page.locator('#editorText').fill('# 未保存的修改');
    await page.locator('a.page-switch').click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.ok(page.url().endsWith('/designer.html'));
    assert.equal(await page.locator('#editorText').inputValue(), '# 未保存的修改');
    await page.locator('a.page-switch').click();
    await page.locator('.overlay button.danger').click();
    await waitGame();
    assert.equal(await page.evaluate(() => GameApp.getState().settings.model), 'game-only-model');
    assert.equal(await page.locator('.save-card').count(), 1);
    await page.locator('[data-action="open-save"]').click();
    await page.waitForFunction(() => !!GameApp.getState().active);
    assert.equal(await page.evaluate(() => GameApp.getState().active.draft), '保留跑团输入');
    await page.locator('[data-action="home"]').click();
    await page.locator('a[data-page-switch]').click();
    await waitDesigner();
    assert.equal(await page.evaluate(() => __UI_STATE__.settings.model), 'designer-test');
    assert.match(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/世界设定.md').content), /雨夜车站/);

    // Immediate navigation must flush the 300ms-debounced draft to IndexedDB.
    await page.locator('#chatInput').fill('跨页面保留草稿');
    await page.locator('a.page-switch').click();
    await waitGame();
    await page.locator('a[data-page-switch]').click();
    await waitDesigner();
    assert.match(await page.locator('#chatInput').innerText(), /跨页面保留草稿/);
    await page.evaluate(() => { __UI_STATE__.running = true; });
    await page.locator('a.page-switch').click();
    assert.ok(page.url().endsWith('/designer.html'));
    await page.evaluate(() => { __UI_STATE__.running = false; });

    // Previously imported skills and persisted mounts cannot leak into the allowed set.
    await page.evaluate(async () => {
      await DB.put('userSkills', { id: 'unwanted-skill', name: 'unwanted-skill', description: 'old import', files: {} });
      VFS.mkdirp(__UI_STATE__.tree, ['skills', 'unwanted-skill']);
      await DB.put('config', { id: 'disabledSkills', value: ['game-world-builder', 'grilling'] });
      await DB.put('config', { id: 'settings', value: { ...__UI_STATE__.settings, agentName: '旧助手名字', agentAvatar: '旧头像' } });
      await __UI__.saveTree();
    });
    await page.reload();
    await waitDesigner();
    assert.deepEqual(await page.evaluate(() => __UI_STATE__.externalSkills.map(s => s.name)), expected);
    assert.equal(await page.evaluate(() => __UI_STATE__.disabledSkills.has('game-world-builder')), false);
    assert.deepEqual(await page.evaluate(async () => (await DB.get('config', 'disabledSkills')).value), ['grilling']);
    assert.equal(await page.evaluate(() => 'agentName' in __UI_STATE__.settings || 'agentAvatar' in __UI_STATE__.settings), false);
    assert.equal(await page.evaluate(async () => 'agentAvatar' in (await DB.get('config', 'settings')).value), false);
    assert.equal(await page.locator('#themeBtn').count(), 0);
    assert.equal(await page.evaluate(() => VFS.resolve(__UI_STATE__.tree, ['skills', 'unwanted-skill'])), null);
    assert.ok((await page.evaluate(() => Object.keys(VFS.resolve(__UI_STATE__.tree, ['skills']).children))).every(name => expected.includes(name)));
    await page.getByTitle('设置', { exact: true }).click();
    assert.equal(await page.locator('.skill-item').count(), 4);
    assert.equal(await page.locator('.skill-item').first().getAttribute('data-skill'), 'game-world-builder');
    const requiredToggle = page.locator('.skill-item.required .sk-toggle');
    assert.equal(await requiredToggle.isDisabled(), true);
    assert.equal(await requiredToggle.getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('.github-link').getAttribute('href'), 'https://github.com/clinlx/unusual-book-agent-for-web');
    assert.ok(!(await page.locator('.overlay').innerText()).match(/助手名字|头像|反馈与联系/));
    assert.equal(await page.getByRole('button', { name: '⇧ 上传 Skill (zip)' }).count(), 0);
    await page.locator('.overlay').getByRole('button', { name: '取消', exact: true }).click();
    const artifacts = path.join(root, 'tests/artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'world-designer-desktop.png') });

    for (const width of [1440, 1024, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.locator('a.page-switch').isVisible());
      const box = await page.locator('a.page-switch').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      const header = await page.locator('#mainHeader').boundingBox();
      assert.ok(header.height <= 64, 'compact title bar at viewport ' + width);
      assert.ok(Math.abs(box.x + box.width / 2 - header.x - header.width / 2) < 2, 'return link centered in title bar');
      const title = await page.locator('.workspace-heading strong').boundingBox();
      assert.ok(title.y + title.height <= box.y || box.x >= title.x + title.width, 'title does not overlap return link');
      for (const selector of ['#compressBtn', '#mainHeader button[title="设置"]']) {
        const control = await page.locator(selector).boundingBox();
        assert.ok(control.x >= 0 && control.x + control.width <= width, selector + ' must remain on screen');
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.screenshot({ path: path.join(artifacts, 'world-designer-mobile.png') });
    await page.locator('a.page-switch').click();
    await waitGame();
    assert.ok(await page.locator('a[data-page-switch]').isVisible());
    await page.screenshot({ path: path.join(artifacts, 'game-mobile.png') });
    for (const entry of ['designer.html']) {
      await page.goto(pathToFileURL(path.join(dist, entry)).href);
      await waitDesigner();
      assert.equal(await page.evaluate(() => __UI_STATE__.skillLoad.origin), 'bundled');
      assert.deepEqual(await page.evaluate(() => __UI_STATE__.externalSkills.map(s => s.name)), expected);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: navigation, isolated resources/storage, model tools, file editor, draft persistence, legacy skill cleanup, mobile and offline pages');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
