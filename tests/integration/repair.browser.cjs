'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { fixture } = require('./world-fixture.cjs');
const ready = require('./designer-ready.cjs');
(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(10000);
    const errors = []; let requests = 0, release;
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', () => errors.push('native dialog'));
    await page.route('https://repair.invalid/**', async route => {
      const body = route.request().postDataJSON(); requests++;
      const report = body.messages.filter(message => message.role === 'user').at(-1);
      assert.match(report.content, /请自动修复当前工作区/);
      assert.match(report.content, /世界时间/); assert.match(report.content, /world\/世界状态和世界规则\/世界共识.json/);
      assert.equal(report.validationReport, undefined, 'presentation metadata never reaches the model');
      assert.ok(body.tools.some(tool => tool.function.name === 'validate_game_structure'));
      let message;
      const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      if (requests === 1) {
        await new Promise(resolve => { release = resolve; });
        message = { role: 'assistant', content: '仍需修复。' };
      } else if (requests === 2) message = { role: 'assistant', content: '', tool_calls: [
        call('read_file', { path: '/workspace/world/世界状态和世界规则/世界共识.json' }, 'read'),
        call('write_file', { path: '/workspace/world/世界状态和世界规则/世界共识.json', content: '{"世界时间":"第一日"}' }, 'write'),
      ] };
      else if (requests === 3) message = { role: 'assistant', content: '', tool_calls: [call('validate_game_structure', { path: '/workspace/world' }, 'validate')] };
      else {
        assert.equal(JSON.parse(body.messages.find(message => message.tool_call_id === 'validate').content).valid, true);
        message = { role: 'assistant', content: '格式已修复并通过校验。' };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) });
    });
    await page.goto(pathToFileURL(path.resolve('dist/designer.html')).href); await ready(page);
    await page.evaluate(async tree => {
      __UI_STATE__.tree.children.workspace = tree.children.workspace;
      VFS.writeFile(__UI_STATE__.tree, '/workspace/world/世界状态和世界规则/世界共识.json', '{}');
      Object.assign(__UI_STATE__.settings, { baseUrl: 'https://repair.invalid/v1', apiKey: 'test', model: 'test', stream: false });
      await DB.put('config', { id: 'settings', value: __UI_STATE__.settings });
      await __UI__.saveTree(); __UI__.renderAll();
    }, fixture().tree);
    await page.locator('#chatInput').fill('保留我的输入草稿');
    await page.locator('#worldValidationBtn').click();
    const repair = page.locator('#sendValidationRepair');
    assert.equal(await repair.isEnabled(), true);
    await repair.click();
    await page.waitForFunction(() => __UI_STATE__.running);
    await page.locator('.validation-report').waitFor();
    assert.equal(await page.locator('.validation-report').getAttribute('open'), null);
    assert.match(await page.locator('.validation-report summary').innerText(), /错误报告/);
    assert.equal(await page.locator('#chatInput').innerText(), '保留我的输入草稿');
    await page.locator('#worldValidationBtn').click();
    assert.equal(await repair.isDisabled(), true, 'cannot send another repair while AI is working');
    await page.waitForFunction(() => __UI_STATE__.running && __UI_STATE__.validationPending);
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    release(); await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.repairSending);
    assert.equal(await repair.isEnabled(), true, 'open dialog enables repair again when AI becomes idle');
    await repair.click();
    await page.waitForFunction(() => !__UI_STATE__.running && !__UI_STATE__.repairSending && __UI_STATE__.validation.valid);
    assert.equal(requests, 4);
    assert.equal(await page.locator('.validation-report').count(), 2);
    assert.equal(await page.locator('.validation-report[open]').count(), 0);
    await page.locator('.validation-report summary').last().click();
    assert.match(await page.locator('.validation-report[open] pre').innerText(), /世界时间/);
    await page.screenshot({ path: 'tests/artifacts/designer-repair-report.png', animations: 'disabled' });
    assert.equal(await page.locator('#chatInput').innerText(), '保留我的输入草稿');
    await page.reload(); await ready(page);
    assert.equal(await page.locator('.validation-report').count(), 2, 'capsule metadata persists with the conversation');
    assert.equal(await page.locator('.validation-report[open]').count(), 0, 'details default to collapsed after reload');
    assert.equal(await page.locator('#chatInput').innerText(), '保留我的输入草稿');
    await page.locator('#worldValidationBtn').click();
    assert.equal(await repair.isVisible(), false, 'a passing world hides the repair action');
    // The action follows validation changes while the same dialog remains open.
    await page.evaluate(async () => {
      VFS.writeFile(__UI_STATE__.tree, '/workspace/world/世界状态和世界规则/世界共识.json', '{}');
      await __UI__.saveTree();
    });
    assert.equal(await repair.isVisible(), true);
    await page.evaluate(async () => {
      VFS.writeFile(__UI_STATE__.tree, '/workspace/world/世界状态和世界规则/世界共识.json', '{"世界时间":"第一日"}');
      await __UI__.saveTree();
    });
    assert.equal(await repair.isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: idle/busy repair action, fixed prompt and diagnostics, real file tools, validation, folded capsules, persistence and preserved draft');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
