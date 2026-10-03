'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ready = require('./designer-ready.cjs');
(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', () => errors.push('native dialog'));
    await page.route('https://**/*', route => route.abort());
    await page.goto(pathToFileURL(path.resolve('dist/designer.html')).href); await ready(page);
    const settings = () => page.getByTitle('设置', { exact: true }).click();
    const row = () => page.locator('.proj-store-item').filter({ hasText: '（当前）' });
    await settings(); await row().waitFor();
    assert.equal(await row().locator('.total').innerText(), '0 B', 'fixed resources and an empty session do not count as user data');
    assert.equal(await row().getByRole('button', { name: '清理撤回', exact: true }).isDisabled(), true);
    await page.locator('.overlay').getByRole('button', { name: '取消', exact: true }).click();
    const original = await page.evaluate(async () => {
      const s = __UI_STATE__, session = s.sessions.find(x => x.id === s.sessionId);
      const other = { id: 'keep-project', name: '保留的项目' };
      s.projects.push(other); await DB.put('projects', other);
      await DB.put('vfs', { id: other.id, tree: { children: { workspace: { type: 'dir', children: { '保留.md': { type: 'file', name: '保留.md', content: '必须保留' } } } } } });
      s.settings.model = 'storage-model'; await DB.put('config', { id: 'settings', value: s.settings });
      VFS.writeFile(s.tree, '/workspace/README.md', '修改后的说明');
      VFS.writeFile(s.tree, '/workspace/世界.md', '用户世界内容');
      VFS.mkdirp(s.tree, ['tmp']); VFS.writeFile(s.tree, '/tmp/图片.txt', '临时资源');
      await __UI__.saveTree();
      session.messages = [{ role: 'user', content: '历史消息' }]; session.draft = [{ t: 'text', v: '草稿' }];
      session.goal = { content: '继续修复世界' }; session.__savedCount = 1;
      const { messages, __savedCount, ...meta } = session;
      await DB.put('sessions', meta); await DB.putMessages(session.id, messages);
      await DB.put('snapshots', { id: 'old-snapshot', projectId: s.projectId, sessionId: session.id, tree: VFS.clone(s.tree) });
      await DB.put('groups', { id: 'old-group', projectId: s.projectId, name: '用户分组' });
      await DB.put('config', { id: 'pending:' + s.projectId, value: { '/workspace/世界.md': { before: '旧内容', after: '用户世界内容' } } });
      await DB.put('config', { id: 'stream:' + s.projectId, value: { sessionId: session.id, content: '未完成回复' } });
      return { projectId: s.projectId, sessionId: session.id, name: s.projects.find(p => p.id === s.projectId).name };
    });
    await settings(); await row().waitFor();
    assert.notEqual(await row().locator('.total').innerText(), '0 B');
    assert.match(await row().innerText(), /其他数据/);
    await row().getByRole('button', { name: '清理项目数据', exact: true }).click();
    await page.locator('.overlay').last().getByRole('button', { name: '取消', exact: true }).click();
    assert.ok(await page.evaluate(async id => (await DB.getMessages(id)).length, original.sessionId), 'cancel keeps messages');
    await row().getByRole('button', { name: '清理项目数据', exact: true }).click();
    await page.locator('.overlay').last().getByRole('button', { name: '确认', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.proj-store-item .total')?.textContent === '0 B');
    const cleaned = await page.evaluate(async before => ({
      sessions: (await DB.all('sessions')).filter(s => s.projectId === before.projectId).length,
      oldMessages: await DB.getMessages(before.sessionId),
      snapshots: await DB.all('snapshots'), groups: await DB.all('groups'),
      tree: (await DB.get('vfs', before.projectId)).tree,
      pending: await DB.get('config', 'pending:' + before.projectId), stream: await DB.get('config', 'stream:' + before.projectId),
      other: (await DB.get('vfs', 'keep-project')).tree.children.workspace.children['保留.md'].content,
      name: (await DB.get('projects', before.projectId)).name,
      model: (await DB.get('config', 'settings')).value.model,
      mountedSkills: Object.keys(__UI_STATE__.tree.children.skills.children).length,
    }), original);
    assert.equal(cleaned.sessions, 1); assert.deepEqual(cleaned.oldMessages, []);
    assert.deepEqual(cleaned.snapshots, []); assert.deepEqual(cleaned.groups, []);
    assert.equal(cleaned.pending, undefined); assert.equal(cleaned.stream, undefined);
    assert.equal(cleaned.tree.children.skills, undefined, 'mounted skills are not duplicated in saved workspaces');
    assert.equal(cleaned.tree.children.tmp, undefined);
    assert.deepEqual(Object.keys(cleaned.tree.children.workspace.children), ['README.md']);
    assert.equal(cleaned.name, original.name); assert.equal(cleaned.model, 'storage-model');
    assert.equal(cleaned.other, '必须保留'); assert.ok(cleaned.mountedSkills > 0);
    await page.reload(); await ready(page); await settings(); await row().waitFor();
    assert.equal(await row().locator('.total').innerText(), '0 B', 'cleanup stays empty after reload');
    await page.locator('.overlay').getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => localStorage.setItem(Lease.PREFIX + 'keep-project', JSON.stringify({ tab: 'other-tab', session: 'other-session', ts: Date.now() })));
    await settings();
    const inactive = page.locator('.proj-store-item').filter({ hasText: '保留的项目' });
    await inactive.waitFor();
    assert.equal(await inactive.getByRole('button', { name: '清理项目数据', exact: true }).isDisabled(), true, 'foreign write protection disables cleanup');
    await page.evaluate(() => localStorage.removeItem(Lease.PREFIX + 'keep-project'));
    await page.locator('.overlay').getByRole('button', { name: '取消', exact: true }).click();
    await settings(); await inactive.waitFor();
    await inactive.getByRole('button', { name: '清理项目数据', exact: true }).click();
    await page.locator('.overlay').last().getByRole('button', { name: '确认', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.proj-store-item')].find(n => n.textContent.includes('保留的项目'))?.querySelector('.total')?.textContent === '0 B');
    assert.equal(await page.evaluate(() => __UI_STATE__.projectId), original.projectId, 'cleaning an inactive project does not switch the active project');
    await page.setViewportSize({ width: 320, height: 844 });
    assert.ok(await row().getByRole('button', { name: '清理项目数据', exact: true }).isVisible());
    assert.ok(await page.locator('.overlay .modal').evaluate(n => n.scrollWidth <= n.clientWidth));
    assert.deepEqual(errors, []);
    console.log('PASS: fixed resource exclusion, growth accounting, cancelled/confirmed project cleanup, persisted deletion, other project/settings retained and mobile layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
