'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const dist = path.resolve(__dirname, '../../dist');
let server, browser, origin;

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.resolve(dist, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(dist + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (error, bytes) => {
      if (error) return res.writeHead(404).end();
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
      res.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

for (const count of [1, 3, 4, 6, 12, 20]) {
  test(count + ' physical dice remain inside the camera clipping range in the result modal', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://**/*', async route => {
        if (!route.request().url().startsWith('https://dice-visibility.invalid/')) return route.abort();
        const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: {
          content: '', tool_calls: [
            call('roll_dice', { description: '属性生成', roller: '测试', related_attr: '属性生成', is_secret: false,
              dice_dict: count === 6 ? { SIZ: '2d6', INT: '2d6', EDU: '2d6' } : { 骰组: count + 'd6' },
              calculate_only: true, target_value: null, compare_mode: null, critical_success_range: null,
              critical_failure_range: null, dice_combine_mode: 'independent', left_modifiers: {}, right_modifiers: {} }, 'dice'),
            call('append_story', { content: '属性生成完成。', one_line_summary_of_content: '生成属性' }, 'story'),
            call('end_the_round', { NEXT_TURN_CACHE: { Story_Phase: '游戏循环' } }, 'end'),
          ] } }] }) });
      });
      await page.goto(origin + '/index.html');
      await page.locator('[data-action="import"]').waitFor();
      await page.evaluate(async () => {
        const module = globalThis['dice-box-threejs'];
        const Original = typeof module === 'function' ? module : module.default || module.DiceBox;
        globalThis.DiceBox3D = class extends Original {
          constructor(...args) { super(...args); window.__testDiceBox = this; }
        };
        await GameApp.updateSettings({ baseUrl: 'https://dice-visibility.invalid/v1', apiKey: 'test-only', stream: false });
        const zip = ZIP.makeZip([{ name: 'Player-pc/基础信息.json', text: '{"姓名":"测试"}' }, { name: 'Player-pc/背包.json', text: '[]' }]);
        await GameApp.importSave(new File([zip], '多骰子.zip'));
      });
      await page.locator('[data-action="start"]').click();
      await page.waitForFunction(() => GameApp.getState().active?.activeRound?.complete);
      await page.locator('article.dice').first().click();
      await page.waitForFunction(count => window.__testDiceBox?.diceList?.length === count && !__testDiceBox.running, count);
      const result = await page.evaluate(() => {
        const box = __testDiceBox;
        return { far: box.camera.far, distance: box.camera.position.length(),
          points: box.diceList.map(mesh => { const point = mesh.position.clone().project(box.camera); return { x: point.x, y: point.y, z: point.z }; }) };
      });
      assert.ok(result.points.every(point => point.z >= -1 && point.z <= 1), JSON.stringify(result));
      assert.ok(result.points.every(point => Math.abs(point.x) < 1 && Math.abs(point.y) < 1), JSON.stringify(result));
      assert.deepEqual(errors, []);
      if (count === 6) {
        const artifacts = path.resolve(__dirname, '../artifacts');
        fs.mkdirSync(artifacts, { recursive: true });
        await page.locator('.manual-dice-shell').screenshot({ path: path.join(artifacts, 'six-dice-visible.png') });
      }
    } finally { await context.close(); }
  });
}
