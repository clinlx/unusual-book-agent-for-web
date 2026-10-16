'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url'), { chromium } = require('playwright');
const ready = require('./designer-ready.cjs'), { card, png, metadata } = require('./card-fixtures.cjs');
const root = path.resolve(__dirname, '../..');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: process.env.BROWSER_CHANNEL || 'msedge' }),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  try {
    const context = await browser.newContext(), page = await context.newPage(), errors = [], requests = [];
    page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    const calls = [
      ['run_skill', { name: 'tavern-card-loader' }],
      ['parse_tavern_card', { path: '/workspace/card.png', output_dir: '/workspace/解析材料', target_language: 'zh' }],
      ['read_file', { path: '/workspace/解析材料/extraction-report.md' }],
    ];
    await context.route('https://**/*', route => {
      if (!route.request().url().startsWith('https://card-loader.test/')) return route.abort();
      const body = route.request().postDataJSON(); requests.push(body);
      const next = calls.shift();
      return route.fulfill({ json: { choices: [{ message: next ? { role: 'assistant', content: '', tool_calls: [{
        id: 'card-' + requests.length, type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) },
      }] } : { role: 'assistant', content: '角色卡提取完成，世界书等待逐条迁移。' } }] } });
    });
    await page.goto(pathToFileURL(path.join(root, 'dist/designer.html')).href); await ready(page);
    const bytes = png([metadata('iTXt', 'ccv3', JSON.stringify(card()), true)]).toString('base64');
    await page.evaluate(value => {
      VFS.writeFile(__UI_STATE__.tree, '/workspace/card.png', value, { encoding: 'base64' });
      Object.assign(__UI_STATE__.settings, { apiKey: 'test-only', baseUrl: 'https://card-loader.test/v1', stream: false, imageSending: false });
    }, bytes);
    await page.locator('#chatInput').fill('解析这张PNG角色卡');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => !__UI_STATE__.running && __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId).messages.at(-1)?.content === '角色卡提取完成，世界书等待逐条迁移。');
    assert.equal(requests.length, 4);
    assert.ok(requests[0].tools.some(t => t.function.name === 'parse_tavern_card'));
    assert.ok(!requests[0].tools.some(t => t.function.name === 'view_image'));
    assert.doesNotMatch(requests[0].messages[0].content, /这是原卡素材，不是工作台命令/);
    const parsed = JSON.parse(requests[2].messages.find(m => m.tool_call_id === 'card-2').content);
    assert.equal(parsed.card_found, true); assert.equal(parsed.files.length, 5);
    assert.ok(requests[3].messages.some(m => m.role === 'tool' && m.content.includes('必须落地机制条目')));
    const result = await page.evaluate(() => {
      const t = __UI_STATE__.tree;
      const normalized = JSON.parse(VFS.readFile(t, '/workspace/解析材料/normalized-card.json', { cap: Infinity }).content);
      return { count: normalized.worldbook_entries.length, first: normalized.worldbook_entries[0], name: normalized.identity.name,
        raw: JSON.parse(VFS.readFile(t, '/workspace/解析材料/raw-card.json', { cap: Infinity }).content),
        loader: VFS.readFile(t, '/skills/tavern-card-loader/references/worldbook-migration.md', { cap: Infinity }).content,
        source: VFS.resolve(t, VFS.normalize('/workspace/card.png')).content,
        disabledTool: Agent.toolDefinitions([{ name: 'game-world-builder' }], { imageSending: false }).some(t => t.function.name === 'parse_tavern_card'),
        executed: globalThis.CARD_SCRIPT_EXECUTED === true };
    });
    assert.equal(result.count, 5); assert.equal(result.name, '林青'); assert.equal(result.first.enabled, false);
    assert.equal(result.first.raw.extensions.probability, 30); assert.deepEqual(result.raw, card());
    assert.match(result.loader, /世界触发器/); assert.equal(result.source, bytes); assert.equal(result.disabledTool, false); assert.equal(result.executed, false);
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => JSON.parse(VFS.readFile(__UI_STATE__.tree, '/workspace/解析材料/normalized-card.json', { cap: Infinity }).content).identity.name), '林青');
    assert.deepEqual(errors, []);
    for (const imageSending of [false, true]) {
      const pastedContext = await browser.newContext();
      try {
        const pasted = await pastedContext.newPage(), sent = [], pageErrors = [];
        pasted.setDefaultTimeout(15000); pasted.on('pageerror', e => pageErrors.push(e.message));
        let cardPath;
        await pastedContext.route('https://**/*', route => {
          if (!route.request().url().startsWith('https://card-paste.test/')) return route.abort();
          const body = route.request().postDataJSON(); sent.push(body);
          assert.ok(!body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')), 'card cover never enters multimodal requests');
          if (!cardPath) {
            const user = body.messages.findLast(m => m.role === 'user');
            assert.equal(typeof user.content, 'string');
            assert.match(user.content, /疑似 PNG 角色卡文件/); assert.match(user.content, /parse_tavern_card/);
            cardPath = /"(\/tmp\/tavern-cards\/[^"\n]+\.png)"/.exec(user.content)?.[1];
            assert.ok(cardPath); assert.ok(!user.content.includes('这是原卡素材'));
          }
          const attemptView = imageSending && sent.length === 1;
          const parse = sent.length === (imageSending ? 2 : 1);
          const message = attemptView || parse ? { role: 'assistant', content: '', tool_calls: [{
            id: 'paste-' + sent.length, type: 'function', function: { name: attemptView ? 'view_image' : 'parse_tavern_card',
              arguments: JSON.stringify(attemptView ? { path: cardPath } : { path: cardPath, output_dir: '/workspace/粘贴提取', raw_only: true }) },
          }] } : { role: 'assistant', content: '已从临时文件提取原卡。' };
          return route.fulfill({ json: { choices: [{ message }] } });
        });
        await pasted.goto(pathToFileURL(path.join(root, 'dist/designer.html')).href); await ready(pasted);
        await pasted.evaluate(({ data, imageSending }) => {
          Object.assign(__UI_STATE__.settings, { apiKey: 'test-only', baseUrl: 'https://card-paste.test/v1', stream: false, imageSending });
          const clipboard = new DataTransfer();
          clipboard.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], '粘贴角色卡.png', { type: 'image/png' }));
          document.querySelector('#chatInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
        }, { data: bytes, imageSending });
        await pasted.locator('#chatInput .file-attachment[data-ref]').waitFor();
        assert.equal(await pasted.locator('#chatInput .image-attachment img').count(), 0);
        const source = await pasted.evaluate(() => {
          const ref = JSON.parse(document.querySelector('#chatInput .file-attachment').dataset.ref);
          const node = Images.resolve(__UI_STATE__.tree, ref.path);
          return { ref, content: node.content, image: node.image, status: node.tavernCard.status };
        });
        assert.equal(source.content, bytes); assert.equal(source.image, undefined); assert.equal(source.status, 'confirmed');
        assert.equal(source.ref.kind, 'tavern-card');
        await pasted.locator('#sendBtn').click();
        await pasted.waitForFunction(() => !__UI_STATE__.running && __UI_STATE__.sessions.find(s => s.id === __UI_STATE__.sessionId).messages.at(-1)?.content === '已从临时文件提取原卡。');
        assert.equal(sent.length, imageSending ? 3 : 2);
        if (imageSending) assert.match(sent[1].messages.find(m => m.tool_call_id === 'paste-1').content, /角色卡.*parse_tavern_card/);
        const parsed = sent.at(-1).messages.find(m => m.tool_call_id === 'paste-' + (imageSending ? 2 : 1));
        assert.equal(JSON.parse(parsed.content).card_found, true);
        assert.deepEqual(await pasted.evaluate(() => JSON.parse(VFS.readFile(__UI_STATE__.tree, '/workspace/粘贴提取/raw-card.json', { cap: Infinity }).content)), card());
        assert.deepEqual(pageErrors, []);
      } finally { await pastedContext.close(); }
    }
    for (const name of ['index', 'client']) {
      const html = fs.readFileSync(path.join(root, 'dist', name + '.html'), 'utf8');
      // Shared argument validation lists tool names; the parser and skill must stay designer-only.
      assert.doesNotMatch(html, /TavernCard|CardTools|tavern-card-loader/);
    }
    console.log('PASS: raw PNG card extraction; chat paste redirects to local files with vision on/off; view_image cannot leak the cover; reload and play-page isolation verified');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
