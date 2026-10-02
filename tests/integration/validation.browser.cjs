'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ready = require('./designer-ready.cjs');
const contract = fs.readFileSync('skills/game-world-builder/reference/WorldDataContract.md', 'utf8');
const character = contract.split('```json\n')[1].split('```')[0];

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', () => errors.push('Native dialog opened'));
    await page.goto(pathToFileURL(path.resolve('dist/designer.html')).href); await ready(page);
    const lamp = page.locator('#worldValidationBtn');
    assert.equal(await lamp.getAttribute('data-state'), 'invalid', 'empty project is checked on entry');
    await lamp.hover();
    await page.locator('#worldValidationTooltip').waitFor();
    assert.match(await page.locator('#worldValidationTooltip').innerText(), /文件缺失/);
    await lamp.click();
    await page.locator('#worldValidationDialog [data-path="/workspace/剧情线与进度/主线剧情.md"]').click();
    assert.equal(await page.evaluate(() => __UI_STATE__.fmRoot), '/workspace');
    await page.evaluate(async character => {
      const S = __UI_STATE__, root = '/workspace/测试世界';
      S.tree.children.workspace.children = {};
      for (const dir of ['存档-索引-NPC', '存档-索引-物品', '存档-旧']) VFS.mkdir(S.tree, root + '/' + dir);
      for (const file of ['模组.md', '开场白.md', '样例开场.md', '剧情线与进度/主线剧情.md', '世界状态和世界规则/世界规则.md', '世界状态和世界规则/掷骰规则.md', '世界状态和世界规则/检定与触发器索引.md', '存档-世界/世界日志.txt']) VFS.writeFile(S.tree, root + '/' + file, '世界内容。'.repeat(30));
      VFS.writeFile(S.tree, root + '/世界状态和世界规则/世界共识.json', '{"世界时间":"第一日"}');
      VFS.writeFile(S.tree, root + '/Player-pc/基础信息.json', character);
      for (const file of ['关系记忆.json', '格式化记忆.json', '关系图.json', '待办与目标.json']) VFS.writeFile(S.tree, root + '/Player-pc/' + file, '{}');
      VFS.writeFile(S.tree, root + '/Player-pc/背包.json', '[]'); VFS.writeFile(S.tree, root + '/Player-pc/日志.txt', '');
      await __UI__.saveTree(); __UI__.renderAll();
    }, character);
    assert.equal(await lamp.getAttribute('data-state'), 'valid');
    await page.reload(); await ready(page);
    assert.equal(await lamp.getAttribute('data-state'), 'valid', 'entry reads the saved world');

    await page.evaluate(async () => {
      window.__validationChecks = 0;
      const check = WorldValidation.check;
      WorldValidation.check = (...args) => { window.__validationChecks++; return check(...args); };
      await __UI__.importDroppedFiles([new File(['{'], '上传测试.json')], '/workspace/测试世界');
    });
    assert.equal(await page.evaluate(() => __UI_STATE__.validationDirty), true, 'completed upload marks hover validation dirty');
    const hoverCheck = async () => {
      const before = await page.evaluate(() => window.__validationChecks);
      await page.mouse.move(0, 0); await lamp.hover();
      assert.equal(await page.evaluate(() => window.__validationChecks), before + 1);
      assert.equal(await page.evaluate(() => __UI_STATE__.validationDirty), false);
    };
    await hoverCheck();
    assert.match(await page.locator('#worldValidationTooltip').innerText(), /上传测试.json/);
    const checked = await page.evaluate(() => window.__validationChecks);
    await page.mouse.move(0, 0); await lamp.hover();
    assert.equal(await page.evaluate(() => window.__validationChecks), checked, 'clean hover does not repeat the check');
    await page.evaluate(async () => {
      VFS.deletePath(__UI_STATE__.tree, '/workspace/测试世界/上传测试.json');
      VFS.mkdir(__UI_STATE__.tree, '/workspace/测试世界/临时目录');
      await __UI__.saveTree(); __UI_STATE__.fmRoot = '/workspace/测试世界'; __UI__.renderFileTree();
    });
    await hoverCheck();
    await page.locator('.tree-item[data-path="/workspace/测试世界/临时目录"]').click();
    await page.keyboard.press('F2');
    await page.locator('.overlay input').fill('重命名目录');
    await page.locator('.overlay .foot button').last().click();
    await page.waitForFunction(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', '测试世界', '重命名目录']));
    assert.equal(await page.evaluate(() => __UI_STATE__.validationDirty), true, 'directory rename marks hover validation dirty');
    await hoverCheck();
    assert.equal(await lamp.getAttribute('data-state'), 'valid');

    const consensus = '/workspace/测试世界/世界状态和世界规则/世界共识.json';
    await page.evaluate(async file => { VFS.writeFile(__UI_STATE__.tree, file, '{}'); await __UI__.saveTree(); }, consensus);
    await lamp.click();
    await page.locator('#worldValidationDialog .validation-issue').filter({ hasText: '世界时间' }).click();
    assert.equal(await page.evaluate(() => __UI_STATE__.editorPath), consensus);
    assert.equal(await page.locator('#editorText').inputValue(), '{}');
    assert.equal(await lamp.isVisible(), false, 'right-pane editor hides the validation lamp');
    assert.equal(await page.locator('#worldValidationTooltip').count(), 0);
    // Dirty editors must survive error navigation, even on the mobile file tab.
    await page.locator('#editorText').fill('{"世界时间":"未保存"}');
    await page.evaluate(async () => { VFS.deletePath(__UI_STATE__.tree, '/workspace/测试世界/开场白.md'); await __UI__.saveTree(); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => __UI__.setTab('files'));
    // Exercise dirty error navigation through the existing handler while the lamp stays hidden.
    await lamp.evaluate(button => button.click());
    await page.locator('#worldValidationDialog [data-path="/workspace/测试世界/开场白.md"]').click();
    assert.equal(await page.evaluate(() => __UI_STATE__.fmRoot), '/workspace/测试世界');
    assert.equal(await page.locator('#editorText').inputValue(), '{"世界时间":"未保存"}');
    assert.equal(await page.evaluate(() => __UI_STATE__.editorDirty), true);
    assert.equal(await page.locator('#fileTree').isVisible(), true);
    assert.equal(await page.locator('#editorText').isVisible(), true);
    await page.screenshot({ path: 'tests/artifacts/validation-dirty-mobile.png', animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(async () => { VFS.writeFile(__UI_STATE__.tree, '/workspace/测试世界/开场白.md', '世界内容。'.repeat(30)); await __UI__.saveTree(); });
    const play = () => page.locator('#playWorldBtn').evaluate(b => b.click());
    const confirm = () => page.locator('#worldPlayConfirm').getByRole('button', { name: '确认并前往' });
    const cancel = () => page.locator('#worldPlayConfirm').getByRole('button', { name: '取消', exact: true }).click();
    await play();
    assert.equal(await confirm().isEnabled(), true, 'play checks the valid unsaved draft');
    assert.equal(await page.locator('#forceWorldPlay').isVisible(), false);
    await cancel();
    assert.equal(await page.evaluate(() => __UI_STATE__.editorDirty), true);
    await page.locator('#editorText').fill('{');
    await play();
    assert.equal(await confirm().isDisabled(), true, 'invalid unsaved draft blocks play');
    assert.equal(await page.locator('#forceWorldPlay').isChecked(), false);
    await page.locator('#forceWorldPlay').check(); assert.equal(await confirm().isEnabled(), true);
    await page.locator('#forceWorldPlay').uncheck(); assert.equal(await confirm().isDisabled(), true);
    await page.locator('#forceWorldPlay').check(); await cancel();
    await play();
    assert.equal(await page.locator('#forceWorldPlay').isChecked(), false, 'reopening resets force');
    assert.equal(await confirm().isDisabled(), true);
    await page.screenshot({ path: 'tests/artifacts/validation-play-blocked.png', animations: 'disabled' });
    await cancel();
    // Multiple worlds: changing the selection resets force and checks the selected root only.
    await page.evaluate(async () => { VFS.writeFile(__UI_STATE__.tree, '/workspace/未完成/模组.md', ''); await __UI__.saveTree(); });
    await play(); await page.locator('#forceWorldPlay').check();
    await page.locator('#worldPlayConfirm select').selectOption('/workspace/未完成');
    assert.equal(await page.locator('#forceWorldPlay').isChecked(), false); assert.equal(await confirm().isDisabled(), true);
    await cancel();
    await page.evaluate(async () => { VFS.deletePath(__UI_STATE__.tree, '/workspace/未完成'); await __UI__.saveTree(); });
    await page.locator('#editorText').fill('{"世界时间":"第一日"}');
    await page.locator('#saveFileBtn').click(); await page.evaluate(() => __UI__.closeEditor());
    assert.equal(await lamp.getAttribute('data-state'), 'valid');
    assert.equal(await lamp.isVisible(), true, 'returning to files restores the validation lamp');

    // Real model/tool loop: do not validate between calls, do validate terminal reply and abort.
    let calls = 0, release, waiting = false, phase = 'break';
    await page.route('https://validation.invalid/**', async route => {
      calls++;
      let message;
      if (calls % 2) message = { role: 'assistant', content: '', tool_calls: [{ id: 'write-' + calls, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: consensus, content: phase === 'break' ? '{}' : '{"世界时间":"已修复"}' }) } }] };
      else { waiting = true; await new Promise(resolve => { release = resolve; }); waiting = false; message = { role: 'assistant', content: '完成。' }; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message, finish_reason: calls % 2 ? 'tool_calls' : 'stop' }] }) }).catch(() => {});
    });
    await page.evaluate(() => {
      Object.assign(__UI_STATE__.settings, { baseUrl: 'https://validation.invalid/v1', apiKey: 'test', model: 'test', stream: false });
      Agent.recordRead({ tree: __UI_STATE__.tree, readState: __UI_STATE__.readState }, '/workspace/测试世界/世界状态和世界规则/世界共识.json');
    });
    await page.locator('#chatInput').fill('修改世界'); await page.locator('#sendBtn').click();
    await page.waitForFunction(() => VFS.readFile(__UI_STATE__.tree, '/workspace/测试世界/世界状态和世界规则/世界共识.json').content === '{}');
    assert.equal(await lamp.getAttribute('data-state'), 'valid', 'tool calls are not full turns');
    assert.equal(await page.evaluate(async () => (await DB.get('config', DesignerProjects.key(__UI_STATE__.projectId))).value.current), false, 'pending content is not an importable checkpoint');
    await page.mouse.move(0, 0); await lamp.hover();
    assert.equal(await lamp.getAttribute('data-state'), 'invalid', 'hover rechecks dirty content even before the AI turn ends');
    assert.equal(await page.evaluate(async () => (await DB.get('config', DesignerProjects.key(__UI_STATE__.projectId))).value.current), false, 'hover cannot publish an importable checkpoint during generation');
    while (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    release(); await page.waitForFunction(() => !__UI_STATE__.running);
    assert.equal(await lamp.getAttribute('data-state'), 'invalid', 'terminal reply triggers validation');
    assert.equal(await page.evaluate(async () => (await DB.get('config', DesignerProjects.key(__UI_STATE__.projectId))).value.valid), false);
    phase = 'repair';
    await page.locator('#chatInput').fill('修复世界'); await page.locator('#sendBtn').click();
    // Opening details during a turn must not suppress that turn's eventual abort check.
    await lamp.click(); await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.waitForFunction(() => VFS.readFile(__UI_STATE__.tree, '/workspace/测试世界/世界状态和世界规则/世界共识.json').content.includes('已修复'));
    while (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    await page.locator('#sendBtn').click(); await page.waitForFunction(() => !__UI_STATE__.running);
    release();
    assert.equal(await lamp.getAttribute('data-state'), 'valid', 'user abort checks the final VFS');
    assert.equal(await page.evaluate(async () => (await DB.get('config', DesignerProjects.key(__UI_STATE__.projectId))).value.valid), true, 'abort persists the final check');
    await lamp.click();
    assert.match(await page.locator('#worldValidationDialog').innerText(), /格式校验通过/);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await play();
    assert.equal(await confirm().isEnabled(), true);
    assert.equal(await page.locator('#forceWorldPlay').isVisible(), false);
    await confirm().click();
    await page.waitForURL(/index\.html#handoff=/);
    await page.waitForFunction(() => typeof GameApp !== 'undefined' && GameApp.getState().active && !document.querySelector('.world-transfer-overlay'));
    assert.match(await page.evaluate(() => GameApp.readFile('/workspace/世界状态和世界规则/世界共识.json')), /已修复/);
    assert.deepEqual(errors, []);
    console.log('PASS: entry, upload/rename dirty hover, clean hover deduplication, error paths, missing parents, dirty mobile editor, draft checks, force reset, full AI turn and user abort');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
