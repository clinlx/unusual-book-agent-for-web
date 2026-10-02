'use strict';
// Build first: node build.js. Requires Playwright with Microsoft Edge installed.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '../../dist');
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!target.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
    fs.readFile(target, (err, data) => {
      if (err) res.writeHead(404).end();
      else { res.setHeader('Content-Type', target.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json'); res.end(data); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-agent-attachments-'));
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/designer.html`);
    await require('../integration/designer-ready.cjs')(page);
    assert.deepEqual(await page.evaluate(() => [__UI_STATE__.settings.model, __UI_STATE__.settings.imageSending]), ['deepseek-flash', true]);
    assert.deepEqual(await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 9000; c.height = 1000;
      const blob = await new Promise(resolve => c.toBlob(resolve, 'image/webp'));
      const output = await Images.prepare(new Uint8Array(await blob.arrayBuffer()));
      const decoded = await createImageBitmap(new Blob([Images.fromDataUrl(output.dataUrl)]));
      const result = [decoded.width, decoded.height, output.mime, Images.fromDataUrl(output.dataUrl).length <= 2 * 1024 * 1024];
      decoded.close(); return result;
    }), [2048, 228, 'image/png', true]);
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 4000; c.height = 2000;
      const ctx = c.getContext('2d'); ctx.fillStyle = 'orange'; ctx.fillRect(0, 0, c.width, c.height);
      return c.toDataURL('image/png').split(',')[1];
    });
    async function paste() {
      await page.locator('#chatInput').focus();
      await page.evaluate(data => {
        const dt = new DataTransfer();
        dt.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
        document.querySelector('#chatInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, png);
    }
    await paste();
    await page.waitForFunction(() => document.querySelector('.image-attachment img'));
    await page.waitForFunction(() => __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId).draft?.some(p => p.t === 'image'));
    assert.deepEqual(await page.evaluate(() => {
      const ref = __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId).draft.find(p => p.t === 'image').v;
      const img = Images.resolve(__UI_STATE__.tree, ref.path).image;
      return [ref.path.startsWith('/tmp/images/'), img.width, img.height, img.sourceWidth, img.sourceHeight];
    }), [true, 2048, 1024, 4000, 2000]);
    await page.reload();
    await page.waitForSelector('.image-attachment img');
    const requests = [];
    let failNext = false;
    let nextTool = null;
    await page.route('https://attachments.test/**', route => {
      requests.push(route.request().postDataJSON());
      if (failNext) { failNext = false; return route.fulfill({ status: 400, json: { error: { message: 'test failure' } } }); }
      if (nextTool) {
        const args = nextTool; nextTool = null;
        return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'image_call', type: 'function', function: { name: 'view_image', arguments: JSON.stringify(args) } },
        ] } }] } });
      }
      return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '看到了图片' } }] } });
    });
    await page.evaluate(() => Object.assign(__UI_STATE__.settings, { apiKey: 'test-only', baseUrl: 'https://attachments.test/v1', stream: false }));
    async function sendText(text) {
      await page.locator('#chatInput').fill(text);
      await page.locator('#sendBtn').click();
      await page.waitForFunction(expected => {
        const s = __UI_STATE__, messages = s.sessions.find(x => x.id === s.sessionId).messages;
        return !s.running && messages.filter(m => m.role === 'user').at(-1)?.content === expected && messages.at(-1)?.role === 'assistant';
      }, text);
    }
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => !__UI_STATE__.running && __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId).messages.some(m => m.role === 'assistant'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].messages.find(m => m.role === 'user').content.find(p => p.type === 'image_url').type, 'image_url');
    assert.ok(requests[0].tools.some(t => t.function.name === 'view_image'));
    assert.equal(await page.locator('.message-image').count(), 1);
    assert.equal(await page.locator('.image-attachment').count(), 0);

    assert.equal(await page.evaluate(async () => JSON.stringify(await DB.getMessages(__UI_STATE__.sessionId)).includes('base64')), false);
    await sendText('下一轮只发文字');
    assert.equal(requests[1].messages.some(m => Array.isArray(m.content)), false, 'old attachments are paths, not resent images');

    await page.evaluate(data => {
      VFS.writeFile(__UI_STATE__.tree, '/workspace/real.png', data, { encoding: 'base64' });
      return __UI__.saveTree();
    }, png);
    nextTool = { path: '/workspace/real.png', crop: { x: 500, y: 100, width: 800, height: 600 } };
    await sendText('请查看工作区图片的一部分');
    assert.equal(requests[2].messages.some(m => Array.isArray(m.content)), false);
    assert.equal(requests[3].messages.at(-1).content[1].type, 'image_url');
    assert.deepEqual(await page.evaluate(async url => {
      const img = await createImageBitmap(new Blob([Images.fromDataUrl(url)], { type: 'image/png' }));
      const dims = [img.width, img.height]; img.close(); return dims;
    }, requests[3].messages.at(-1).content[1].image_url.url), [800, 600]);
    assert.equal(await page.evaluate(async () => JSON.stringify(await DB.getMessages(__UI_STATE__.sessionId)).includes('base64')), false);

    failNext = true;
    await paste();
    await page.waitForSelector('.image-attachment img');
    await page.locator('#sendBtn').click();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    assert.equal(await page.locator('.image-attachment img').count(), 1, 'retry restores the image');
    await page.getByRole('button', { name: '移除图片', exact: true }).click();
    assert.equal(await page.locator('.image-attachment').count(), 0);

    // Real settings UI: saving the off switch must persist and omit history images.
    await page.getByTitle('设置', { exact: true }).click();
    assert.deepEqual(await page.getByLabel('视觉模型', { exact: true }).locator('option').allTextContents(), ['是', '否']);
    assert.equal(await page.getByText('开启后可粘贴图片', { exact: false }).count(), 0);
    await page.getByLabel('视觉模型', { exact: true }).selectOption('0');
    await page.locator('.overlay').getByRole('button', { name: '保存', exact: true }).click();
    await paste();
    assert.equal(await page.locator('.image-attachment').count(), 0);
    assert.equal(await page.evaluate(() => __UI__.requestMessages(__UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId)).some(m => Array.isArray(m.content))), false);
    await sendText('关闭后继续');
    assert.ok(!requests.at(-1).tools.some(t => t.function.name === 'view_image'));
    await page.reload();
    await require('../integration/designer-ready.cjs')(page);
    assert.equal(await page.evaluate(() => __UI_STATE__.settings.imageSending), false);

    async function importMixed() {
      await page.evaluate(() => {
        window.importDone = false;
        __UI__.importDroppedFiles([new File([new Uint8Array([0, 255, 128])], 'photo.png'), new File(['hello'], 'note.custom')], '/workspace')
          .then(() => { window.importDone = true; });
      });
      await page.getByRole('button', { name: '我已知晓', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'photo.png'])), false);
    }
    await importMixed();
    await page.locator('.overlay').getByRole('button', { name: '取消', exact: true }).click();
    await page.waitForFunction(() => window.importDone);
    assert.equal(await page.evaluate(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'note.custom'])), false);
    await importMixed();
    await page.getByRole('button', { name: '我已知晓', exact: true }).click();
    await page.waitForFunction(() => window.importDone);
    assert.deepEqual(await page.evaluate(() => [...VFS.fileBytes(VFS.resolve(__UI_STATE__.tree, ['workspace', 'photo.png']))]), [0, 255, 128]);
    // Wall-clock expiry runs on reload; the original and preview are both removed.
    await page.evaluate(async () => {
      const images = VFS.resolve(__UI_STATE__.tree, ['tmp', 'images']);
      for (const n of Object.values(images.children)) n.tmp.lastUsedAt = Date.now() - 8 * 86400000;
      await __UI__.saveTree();
    });
    await page.reload();
    await require('../integration/designer-ready.cjs')(page);
    assert.ok(await page.locator('.expired-image').count() > 0);
    assert.equal(await page.locator('.message-image').count(), 0);
    assert.equal(await page.evaluate(() => Object.keys(VFS.resolve(__UI_STATE__.tree, ['tmp', 'images']).children).length), 0);
    assert.ok(await page.evaluate(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'real.png'])));
    // Upgrade an old inline image and an old data-URL draft without keeping bytes in messages.
    await page.evaluate(async data => {
      const id = __UI_STATE__.sessionId, meta = await DB.get('sessions', id);
      delete meta.attachmentVersion;
      meta.draft = [{ t: 'image', v: 'data:image/png;base64,' + data }];
      await DB.put('sessions', meta);
      await DB.putMessages(id, [{ role: 'user', msgId: 'legacy', content: [
        { type: 'text', text: '旧图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + data } },
      ] }]);
    }, png);
    await page.reload();
    await require('../integration/designer-ready.cjs')(page);
    assert.equal(await page.locator('.message-image').count(), 1);
    assert.equal(await page.locator('.image-attachment img').count(), 1);
    assert.equal(await page.evaluate(async () => JSON.stringify(await DB.getMessages(__UI_STATE__.sessionId)).includes('base64')), false);
    assert.equal(await page.evaluate(async () => JSON.stringify((await DB.get('sessions', __UI_STATE__.sessionId)).draft).includes('base64')), false);
    await page.evaluate(() => __UI__.openEditor('/workspace/photo.png'));
    await page.getByRole('button', { name: '我已知晓', exact: true }).click();
    assert.equal(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/note.custom').content), 'hello');

    // ZIP and ordinary file uploads have independent semantics.
    assert.equal(await page.locator('#filePanelHeader [title="上传"]').count(), 1);
    await page.getByTitle('上传', { exact: true }).click();
    assert.equal(await page.getByRole('menuitem').count(), 3);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '上传文件夹');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu', { name: '上传' }).count(), 0);
    assert.equal(await page.locator('#uploadMenuBtn').getAttribute('aria-expanded'), 'false');
    async function uploadOption(name) {
      await page.getByTitle('上传', { exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    }
    const ZIP = require('../../src/world-designer/zip.js');
    const archive = path.join(temp, 'test.zip');
    fs.writeFileSync(archive, Buffer.from(await ZIP.makeZip([{ name: 'nested/readme.txt', text: 'from zip' }]).arrayBuffer()));
    const chooser = page.waitForEvent('filechooser');
    await uploadOption('上传 ZIP 并解压');
    await (await chooser).setFiles(archive);
    await page.waitForFunction(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'nested', 'readme.txt']));
    const ordinaryChooser = page.waitForEvent('filechooser');
    await uploadOption('上传文件');
    await (await ordinaryChooser).setFiles(archive);
    await page.getByRole('button', { name: '我已知晓', exact: true }).click();
    await page.waitForFunction(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'test.zip']));
    assert.equal(await page.evaluate(() => VFS.resolve(__UI_STATE__.tree, ['workspace', 'test.zip']).encoding), 'base64');
    const folder = path.join(temp, 'project');
    fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'sub', 'data.unknown'), 'folder text');
    const directoryChooser = page.waitForEvent('filechooser');
    await uploadOption('上传文件夹');
    await (await directoryChooser).setFiles(folder);
    await page.waitForFunction(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'project', 'sub', 'data.unknown']));

    // Real OS-file drag payloads: direct File reads work on both file:// and HTTP.
    const dragged = path.join(temp, 'dragged.txt'); fs.writeFileSync(dragged, 'drag works');
    async function dragFiles(target, files) {
      const client = await target.context().newCDPSession(target);
      const rect = await target.locator('#filePanel').boundingBox();
      const data = { items: [], files, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await client.send('Input.dispatchDragEvent', {
        type, x: rect.x + rect.width / 2, y: rect.y + rect.height - 90, data,
      });
      await client.detach();
    }
    await dragFiles(page, [dragged]);
    await page.waitForFunction(() => VFS.resolve(__UI_STATE__.tree, ['workspace', 'dragged.txt'])?.content === 'drag works');
    const local = await browser.newPage();
    local.on('pageerror', error => errors.push(error.message));
    await local.goto(pathToFileURL(path.join(root, 'designer.html')).href);
    await require('../integration/designer-ready.cjs')(local);
    await dragFiles(local, [dragged]);
    await local.waitForFunction(() => VFS.resolve(__UI_STATE__.tree, ['workspace', 'dragged.txt'])?.content === 'drag works');
    await dragFiles(local, [folder]);
    await local.getByText('浏览器无法读取拖入的文件夹', { exact: false }).waitFor();
    assert.equal(await local.evaluate(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'project'])), false);
    const localDirectoryChooser = local.waitForEvent('filechooser');
    await local.getByTitle('上传', { exact: true }).click();
    await local.getByRole('menuitem', { name: '上传文件夹', exact: true }).click();
    await (await localDirectoryChooser).setFiles(folder);
    await local.waitForFunction(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'project', 'sub', 'data.unknown']));
    await local.close();

    // A whole batch stays unchanged until the conflict review is confirmed.
    await page.evaluate(async () => {
      for (const name of ['a', 'b', 'c']) VFS.writeFile(__UI_STATE__.tree, '/workspace/' + name + '.txt', 'original', { now: 1700000000000 });
      await __UI__.saveTree();
    });
    async function importConflicts() {
      await page.evaluate(() => {
        window.importDone = false;
        __UI__.importDroppedFiles(['a', 'b', 'c', 'new'].map(name => new File(['new-' + name], name + '.txt', { lastModified: 1750000000000 })), '/workspace')
          .then(() => { window.importDone = true; });
      });
      await page.getByRole('dialog', { name: '上传文件冲突' }).waitFor();
    }
    await importConflicts();
    assert.equal(await page.locator('.import-conflict').count(), 3);
    assert.ok((await page.locator('.import-conflict').first().innerText()).includes('8 字节'));
    assert.ok((await page.locator('.import-conflict').first().innerText()).includes('修改时间'));
    if (process.env.IMPORT_SCREENSHOT) {
      await page.screenshot({ path: process.env.IMPORT_SCREENSHOT, fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      const dialog = page.getByRole('dialog', { name: '上传文件冲突' });
      assert.ok(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth), 'conflict list fits a narrow viewport');
      await page.screenshot({ path: process.env.IMPORT_SCREENSHOT.replace(/\.png$/, '-mobile.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    assert.equal(await page.evaluate(() => !!VFS.resolve(__UI_STATE__.tree, ['workspace', 'new.txt'])), false);
    await page.getByRole('dialog', { name: '上传文件冲突' }).getByRole('button', { name: '取消', exact: true }).click();
    await page.waitForFunction(() => window.importDone);
    assert.equal(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/a.txt').content), 'original');
    await importConflicts();
    await page.getByLabel('处理 /workspace/a.txt', { exact: true }).selectOption('replace');
    await page.getByLabel('处理 /workspace/b.txt', { exact: true }).selectOption('skip');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.waitForFunction(() => window.importDone);
    assert.deepEqual(await page.evaluate(() => ['a.txt', 'b.txt', 'c.txt', 'c-2.txt', 'new.txt'].map(name => VFS.readFile(__UI_STATE__.tree, '/workspace/' + name).content)),
      ['new-a', 'original', 'original', 'new-c', 'new-new']);
    await importConflicts();
    await page.getByRole('button', { name: '全部跳过', exact: true }).click();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.waitForFunction(() => window.importDone);
    assert.equal(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/b.txt').content), 'original');
    await importConflicts();
    await page.getByRole('button', { name: '全部覆盖（仅文件）', exact: true }).click();
    // A concurrent update invalidates the review; the user must see the new sizes/times.
    await page.evaluate(() => VFS.writeFile(__UI_STATE__.tree, '/workspace/a.txt', 'changed-during-review'));
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.import-conflict')?.textContent.includes('21 字节'));
    assert.equal(await page.getByLabel('处理 /workspace/a.txt', { exact: true }).inputValue(), 'keep');
    await page.getByRole('button', { name: '全部覆盖（仅文件）', exact: true }).click();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.waitForFunction(() => window.importDone);
    assert.equal(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/b.txt').content), 'new-b');
    await page.reload();
    await require('../integration/designer-ready.cjs')(page);
    assert.deepEqual(await page.evaluate(() => [...VFS.fileBytes(VFS.resolve(__UI_STATE__.tree, ['workspace', 'photo.png']))]), [0, 255, 128]);
    assert.deepEqual(errors, []);
    console.log('PASS: image lifecycle, vision settings, upload menu, ZIP/file/folder choices, actual file:// and HTTP drops, local directory fallback, conflict review; no page errors.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    // Only the uniquely created test fixture directory is removed.
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'web-agent-attachments-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
