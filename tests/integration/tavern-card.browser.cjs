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
    for (const name of ['index', 'client']) {
      const html = fs.readFileSync(path.join(root, 'dist', name + '.html'), 'utf8');
      assert.doesNotMatch(html, /parse_tavern_card|TavernCard|CardTools|tavern-card-loader/);
    }
    console.log('PASS: offline PNG metadata extraction through real designer tool loop with vision disabled; raw/settings preserved; reload and play-page isolation verified');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
