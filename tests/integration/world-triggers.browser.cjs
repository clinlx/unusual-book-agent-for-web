'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: process.env.BROWSER_CHANNEL || 'msedge' }),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  try {
    const context = await browser.newContext();
    await context.route('https://world-trigger.test/**', route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (!['index.html', 'designer.html', 'client.html'].includes(name)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(root, 'dist', name)) });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://world-trigger.test/index.html');
    await page.waitForFunction(() => typeof GameApp !== 'undefined' && !!document.querySelector('[data-action="import"]'));
    const result = await page.evaluate(async () => {
      const tree = VFS.createTree();
      VFS.writeFile(tree, '/workspace/Player-pc/基础信息.json', '{"姓名":"测试者"}');
      VFS.writeFile(tree, '/workspace/Player-pc/背包.json', '[]');
      VFS.writeFile(tree, '/workspace/世界触发器.json', JSON.stringify({ version: 1, entries: [
        { id: 'church', keywords: ['教堂'], once: true, content: 'TRIGGER_SECRET_REFERENCE' },
        { id: 'no-recursion', keywords: ['TRIGGER_SECRET_REFERENCE'], content: 'SHOULD_NOT_TRIGGER' },
      ] }));
      const s = GameCore.createSave('触发器浏览器回归', tree);
      GameCore.beginRound(s, '进入教堂', false, '当前任务');
      const first = GameCore.context(s, '系统'), last = first.at(-1), record = JSON.parse(last.content.split('\n').slice(1).join('\n'));
      if (last.role !== 'user' || record.entries.length !== 1 || record.entries[0].id !== 'church') throw Error('实际编译请求未正确触发');
      const before = JSON.stringify(s.worldTriggers), count = s.events.length;
      GameCore.context(s, '系统');
      if (before !== JSON.stringify(s.worldTriggers) || count !== s.events.length) throw Error('重复请求改变触发状态');
      const store = GameStore.create(); await store.open(); await store.putSave(s);
      const room = { members: { p: { actorId: 'pc' }, spectator: { role: 'spectator', permission: 'all', view: 'all' } } };
      for (const memberId of ['p', 'spectator']) {
        const projection = MultiplayerSync.project(s, 'pc', { memberId, room });
        if (/TRIGGER_SECRET_REFERENCE|worldTriggers|world_trigger/.test(JSON.stringify(projection))) throw Error('触发资料进入联机投影');
      }
      const html = GameUI.eventHTML(s.events.find(e => e.type === 'world_trigger'), 'debug');
      if (!html.includes('世界资料触发检测')) throw Error('缺少 DEBUG 检测记录');
      sessionStorage.setItem('trigger-test-save', s.id);
      return { id: s.id, ledger: before };
    });
    await page.reload(); await page.waitForFunction(() => typeof GameStore !== 'undefined');
    assert.equal(await page.evaluate(async id => {
      const store = GameStore.create(); await store.open(); const s = await store.getSave(id);
      const before = JSON.stringify(s.worldTriggers); GameCore.context(s, '系统'); return before === JSON.stringify(s.worldTriggers);
    }, result.id), true, 'IndexedDB reload retains once state');
    await page.goto('https://world-trigger.test/designer.html');
    await page.waitForFunction(() => typeof BUNDLED_SKILLS !== 'undefined' && typeof BuilderTools !== 'undefined');
    const designer = await page.evaluate(() => {
      const prefix = 'skills/game-world-builder/';
      const doc = BUNDLED_SKILLS[prefix + 'reference/WorldTriggers.md'];
      const tree = { name: '/', type: 'dir', children: { workspace: { name: 'workspace', type: 'dir', children: {
        '世界触发器.json': { name: '世界触发器.json', type: 'file', content: '{"version":1,"entries":[{"id":"a","constant":true,"content":"x","probability":50}]}' },
      } } } };
      return { doc: doc?.includes('迁移取舍'), linked: BUNDLED_SKILLS[prefix + 'SKILL.md'].includes('reference/WorldTriggers.md'),
        script: !!BUNDLED_SKILLS[prefix + 'scripts/world-trigger-rules.js'], rejected: BuilderTools.validate(tree, '/workspace').errors.some(e => e.includes('probability')) };
    });
    assert.deepEqual(designer, { doc: true, linked: true, script: true, rejected: true });
    await page.goto('https://world-trigger.test/client.html');
    await page.waitForFunction(() => typeof GameUI !== 'undefined');
    assert.deepEqual(errors, []);
    console.log('PASS: compiled game injection/privacy, IndexedDB reload, designer rules/validation, client boot');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
