'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ready = require('./designer-ready.cjs');
const { pdfDocument, docxDocument } = require('./document-fixtures.cjs');
const root = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(root, 'tests/artifacts'), { recursive: true });
(async () => {
  const fixtures = { 'a.pdf': pdfDocument().toString('base64'), 'scan.pdf': pdfDocument(true).toString('base64'), 'a.docx': (await docxDocument()).toString('base64'), 'long.docx': (await docxDocument(true)).toString('base64') };
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [], network = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route('https://**/*', route => { network.push(route.request().url()); return route.abort(); });
    await page.goto(pathToFileURL(path.join(root, 'dist/designer.html')).href); await ready(page);
    await page.evaluate(data => { for (const [name, content] of Object.entries(data)) VFS.writeFile(__UI_STATE__.tree, '/workspace/' + name, content, { encoding: 'base64' }); }, fixtures);
    const parsed = await page.evaluate(async () => {
      const tree = __UI_STATE__.tree, results = {};
      for (const name of ['a.pdf', 'a.docx', 'scan.pdf']) {
        const out = await Documents.parse(tree, { path: '/workspace/' + name, format: 'text', output: 'return' });
        results[name] = JSON.parse(out.result);
      }
      return results;
    });
    assert.match(parsed['a.pdf'].text, /HELLO PDF PAGE ONE/); assert.match(parsed['a.pdf'].text, /PDF PAGE TWO END/);
    assert.match(parsed['a.docx'].text, /文档解析测试/); assert.match(parsed['a.docx'].text, /林青/); assert.match(parsed['a.docx'].text, /DOCX PAGE TWO END/);
    assert.equal(parsed['scan.pdf'].text.trim(), ''); assert.match(parsed['scan.pdf'].note, /images/);
    const boundaries = await page.evaluate(async () => {
      const tree = __UI_STATE__.tree;
      const page2 = JSON.parse((await Documents.parse(tree, { path: '/workspace/a.pdf', format: 'text', output: 'return', start_page: 2, end_page: 2 })).result);
      VFS.writeFile(tree, '/workspace/broken.pdf', '%PDF-1.7\nbroken');
      VFS.writeFile(tree, '/workspace/broken.docx', 'UEsAAA==', { encoding: 'base64' });
      const errors = [];
      for (const name of ['broken.pdf', 'broken.docx']) {
        try { await Documents.parse(tree, { path: '/workspace/' + name, format: 'text', output: 'file', output_path: '/workspace/bad-output.txt' }); }
        catch (error) { errors.push(error.message); }
      }
      return { page2, errors, output: VFS.resolve(tree, VFS.normalize('/workspace/bad-output.txt')) };
    });
    assert.match(boundaries.page2.text, /PDF PAGE TWO END/); assert.doesNotMatch(boundaries.page2.text, /PAGE ONE/);
    assert.equal(boundaries.errors.length, 2); assert.equal(boundaries.output, null);
    const visuals = await page.evaluate(async () => {
      const tree = __UI_STATE__.tree, results = {};
      for (const name of ['a.pdf', 'a.docx', 'scan.pdf']) {
        const out = await Documents.parse(tree, { path: '/workspace/' + name, format: 'images', output: 'return' });
        results[name] = { info: JSON.parse(out.result), images: out.images.map(i => ({ page: i.page, width: i.width, height: i.height, dataUrl: i.dataUrl })) };
      }
      return results;
    });
    for (const [name, out] of Object.entries(visuals)) {
      assert.equal(out.images.length, 2, name); assert.equal(out.info.total_pages, 2, name);
      for (const i of out.images) { assert.ok(i.width > 100 && i.height > 100); assert.match(i.dataUrl, /^data:image\/png;base64,/); assert.ok(i.dataUrl.length > 2000); }
      fs.writeFileSync(path.join(root, 'tests/artifacts/document-' + name + '.png'), Buffer.from(out.images[0].dataUrl.split(',')[1], 'base64'));
    }
    const files = await page.evaluate(async () => {
      const tree = __UI_STATE__.tree;
      const text = JSON.parse((await Documents.parse(tree, { path: '/workspace/a.docx', format: 'text', output: 'file', output_path: '/workspace/export/docx.txt' })).result);
      const images = JSON.parse((await Documents.parse(tree, { path: '/workspace/a.pdf', format: 'images', output: 'file', output_dir: '/workspace/export/pages' })).result);
      const contents = VFS.readFile(tree, text.path, { cap: 120000 }).content;
      const image = VFS.resolve(tree, VFS.normalize(images.pages[0].path));
      await __UI__.saveTree();
      return { text, images, contents, encoding: image.encoding, preview: image.image.dataUrl };
    });
    assert.match(files.contents, /文档解析测试/); assert.equal(files.encoding, 'base64'); assert.match(files.preview, /^data:image\//);
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => VFS.readFile(__UI_STATE__.tree, '/workspace/export/docx.txt', { cap: 120000 }).content), files.contents);
    assert.equal(await page.evaluate(() => VFS.resolve(__UI_STATE__.tree, VFS.normalize('/workspace/export/pages/page-0001.png')).image.dataUrl), files.preview);
    const long = await page.evaluate(async () => {
      const args = { path: '/workspace/long.docx', format: 'images', output: 'return' };
      const first = await Documents.parse(__UI_STATE__.tree, args), info = JSON.parse(first.result);
      const last = info.next_page ? await Documents.parse(__UI_STATE__.tree, { ...args, start_page: info.total_pages }) : first;
      const image = last.images.at(-1), bitmap = await createImageBitmap(new Blob([Images.fromDataUrl(image.dataUrl)]));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let red = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 220 && pixels[i + 1] < 40 && pixels[i + 2] < 40) red++;
      return { info, red, dataUrl: image.dataUrl };
    });
    assert.ok(long.info.total_pages > 1, 'continuous DOCX content is paginated');
    assert.ok(long.red > 1000, 'tail beyond the first page is present in the last page image');
    fs.writeFileSync(path.join(root, 'tests/artifacts/document-long-tail.png'), Buffer.from(long.dataUrl.split(',')[1], 'base64'));
    const requests = []; let nextTool;
    await page.route('https://documents.test/**', route => {
      requests.push(route.request().postDataJSON());
      if (nextTool) {
        const tool = nextTool; nextTool = null;
        return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'document-' + requests.length, type: 'function', function: { name: tool.name || 'parse_document', arguments: JSON.stringify(tool.args) } },
        ] } }] } });
      }
      return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '解析完成' } }] } });
    });
    await page.evaluate(() => Object.assign(__UI_STATE__.settings, { apiKey: 'test-only', baseUrl: 'https://documents.test/v1', stream: false, imageSending: true }));
    async function send(text, tool) {
      const start = requests.length; nextTool = tool;
      await page.locator('#chatInput').fill(text); await page.locator('#sendBtn').click();
      await page.waitForFunction(expected => {
        const s = __UI_STATE__, messages = s.sessions.find(x => x.id === s.sessionId).messages;
        return !s.running && messages.filter(m => m.role === 'user').at(-1)?.content === expected && messages.at(-1)?.content === '解析完成';
      }, text);
      return requests.slice(start);
    }
    for (const name of ['a.pdf', 'a.docx']) {
      const calls = await send('查看文档页图 ' + name, { args: { path: '/workspace/' + name, format: 'images', output: 'return' } });
      assert.equal(calls.length, 2);
      const parts = calls[1].messages.at(-1).content.filter(p => p.type === 'image_url');
      assert.equal(parts.length, 2, 'real model request contains both document page images');
      assert.deepEqual(await page.evaluate(async urls => Promise.all(urls.map(async url => {
        const img = await createImageBitmap(new Blob([Images.fromDataUrl(url)]));
        const ok = img.width > 100 && img.height > 100; img.close(); return ok;
      })), parts.map(p => p.image_url.url)), [true, true]);
      assert.equal(await page.evaluate(async () => JSON.stringify(await DB.getMessages(__UI_STATE__.sessionId)).includes('base64')), false);
    }
    const follow = await send('继续普通文字对话');
    assert.equal(follow[0].messages.some(m => Array.isArray(m.content)), false, 'document images are not resent in later turns');
    const saved = await send('保存文档图片', { args: { path: '/workspace/a.docx', format: 'images', output: 'file', output_dir: '/workspace/chat-pages' } });
    const savedResult = JSON.parse(saved[1].messages.findLast(m => m.role === 'tool').content);
    assert.equal(savedResult.pages[0].path, '/workspace/chat-pages/page-0001.png');
    assert.equal(saved[1].messages.some(m => Array.isArray(m.content)), false, 'save mode sends metadata');
    await page.reload(); await ready(page);
    assert.ok(await page.evaluate(() => Images.resolve(__UI_STATE__.tree, '/workspace/chat-pages/page-0001.png').image));
    await page.evaluate(() => Object.assign(__UI_STATE__.settings, { apiKey: 'test-only', baseUrl: 'https://documents.test/v1', stream: false, imageSending: true }));
    const viewed = await send('查看已保存的文档图片', { name: 'view_image', args: { path: '/workspace/chat-pages/page-0001.png' } });
    assert.ok(viewed[1].messages.at(-1).content.some(p => p.type === 'image_url'));
    await page.evaluate(() => { __UI_STATE__.settings.imageSending = false; });
    const blocked = await send('非视觉模型直接返回页图', { args: { path: '/workspace/a.pdf', format: 'images', output: 'return' } });
    assert.match(blocked[1].messages.at(-1).content, /错误.*图片发送已关闭/);
    assert.equal(blocked[1].messages.some(m => Array.isArray(m.content)), false);
    assert.match(blocked[0].tools.find(t => t.function.name === 'parse_document').function.description, /format=images 只允许 output=file/);
    const textOnly = await send('非视觉模型提取文字', { args: { path: '/workspace/a.pdf', format: 'text', output: 'return' } });
    assert.match(JSON.parse(textOnly[1].messages.at(-1).content).text, /HELLO PDF PAGE ONE/);
    const imagesOnly = await send('非视觉模型保存页图', { args: { path: '/workspace/a.pdf', format: 'images', output: 'file', output_dir: '/workspace/nonvisual-pages' } });
    assert.equal(JSON.parse(imagesOnly[1].messages.at(-1).content).pages.length, 2);
    assert.equal(imagesOnly[1].messages.some(m => Array.isArray(m.content)), false);
    await page.evaluate(async data => {
      const files = Object.entries(data).filter(([name]) => name !== 'long.docx').map(([name, content]) => new File([Uint8Array.from(atob(content), c => c.charCodeAt(0))], 'upload-' + name));
      await __UI__.importDroppedFiles(files, '/workspace');
    }, fixtures);
    assert.equal(await page.getByRole('button', { name: '我已知晓', exact: true }).count(), 0, 'PDF and DOCX upload without incompatibility prompts');
    await page.evaluate(() => {
      window.importDone = false;
      __UI__.importDroppedFiles([new File([new Uint8Array([0, 255, 128])], 'unsupported.xlsx')], '/workspace').then(() => { window.importDone = true; });
    });
    await page.getByRole('button', { name: '我已知晓', exact: true }).waitFor();
    assert.match(await page.locator('.overlay').innerText(), /unsupported.xlsx/);
    await page.getByRole('button', { name: '我已知晓', exact: true }).click();
    await page.waitForFunction(() => window.importDone);
    assert.deepEqual(errors, []); assert.deepEqual(network, [], 'document parsers must work offline');
    console.log('PASS: offline PDF/DOCX text and images, scan, long DOCX tail, real chat image payloads, persistence, view_image and upload prompts');
  } finally { await browser?.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
