'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../../src/world-designer/skill-loader.js');

// 构造一个假的 get()：files 为 { path: text|object }，缺失则 reject
function fakeGet(files) {
  const log = [];
  const get = async (path, as) => {
    log.push(path);
    if (!(path in files)) throw new Error('HTTP 404');
    const v = files[path];
    if (as === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  get.log = log;
  return get;
}

const SKILL_MD = '---\nname: demo-skill\ndescription: 演示技能\n---\n# 流程\n先读 references/guide.md 再动手。\n';

test('parseEnableList 支持数组与 {skills:[]}，并过滤非法名', () => {
  assert.deepStrictEqual(L.parseEnableList(['a-b', 'c']).names, ['a-b', 'c']);
  assert.deepStrictEqual(L.parseEnableList({ skills: ['x'] }).names, ['x']);
  // 去重、去空、trim 后仍合法的名字保留；非法名进 bad
  const r = L.parseEnableList(['ok-name', 'Bad_Name', '', 'ok-name', '  spaced  ']);
  assert.deepStrictEqual(r.names, ['ok-name', 'spaced']);
  assert.ok(r.bad.includes('Bad_Name'));
  assert.throws(() => L.parseEnableList({ nope: 1 }), /格式错误/);
});

test('parseIndexHtml 提取条目、区分目录、忽略导航链接', () => {
  const html = `<h1>Index of /skills/demo/</h1>
    <a href="../">上级</a>
    <a href="SKILL.md">SKILL.md</a>
    <a href="references/">references/</a>
    <a href="/other/nav">站点导航</a>
    <a href="https://x.com/a">外链</a>
    <a href="my%20file.md">my file.md</a>`;
  const items = L.parseIndexHtml(html);
  assert.deepStrictEqual(items, ['SKILL.md', 'references/', 'my file.md']);
});

test('parseIndexHtml 归一化 http-server 的 ./ 前缀', () => {
  const html = '<a href="./">.</a><a href="./SKILL.md">s</a><a href="./references/">r</a><a href="./../up">up</a>';
  assert.deepStrictEqual(L.parseIndexHtml(html), ['SKILL.md', 'references/']);
});

test('自动索引发现的附件路径不含 ./ 片段', async () => {
  const get = fakeGet({
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/': '<a href="./">.</a><a href="./SKILL.md">s</a><a href="./references/">r</a>',
    'skills/demo-skill/references/': '<a href="./guide.md">g</a>',
    'skills/demo-skill/references/guide.md': '指南正文',
  });
  const { skill } = await L.loadOne(get, 'demo-skill');
  const keys = Object.keys(skill.files);
  assert.deepStrictEqual(keys, ['/skills/demo-skill/references/guide.md']);
  assert.ok(!keys.some(k => k.includes('/./')), '路径中不应残留 ./');
});

test('referencedPaths 从正文提取相对路径，排除 URL 与越界路径', () => {
  const body = '见 [指南](references/guide.md) 与 `scripts/run.py`\n还有 ![图](assets/a.png)\n' +
    '外链 [x](https://a.com/b.md) 与 ../secret.md 和 /abs/p.md';
  const p = L.referencedPaths(body);
  assert.ok(p.includes('references/guide.md'));
  assert.ok(p.includes('scripts/run.py'));
  assert.ok(p.includes('assets/a.png'));
  assert.ok(!p.some(x => x.includes('..')));
  assert.ok(!p.some(x => x.startsWith('/')));
  assert.ok(!p.some(x => x.includes('a.com')));
});

test('loadOne 优先用 manifest.json，且不请求目录索引', async () => {
  const get = fakeGet({
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/manifest.json': { files: ['references/guide.md', './notes.txt'] },
    'skills/demo-skill/references/guide.md': '指南正文',
    'skills/demo-skill/notes.txt': '备注',
  });
  const { skill, warnings } = await L.loadOne(get, 'demo-skill');
  assert.strictEqual(skill.name, 'demo-skill');
  assert.strictEqual(skill.description, '演示技能');
  assert.strictEqual(skill.source, 'manifest');
  assert.strictEqual(skill.builtin, true);
  assert.strictEqual(skill.files['/skills/demo-skill/references/guide.md'], '指南正文');
  assert.strictEqual(skill.files['/skills/demo-skill/notes.txt'], '备注');
  assert.ok(!skill.files['/skills/demo-skill/SKILL.md'], 'SKILL.md 不作为附件挂载');
  assert.deepStrictEqual(warnings, []);
  assert.ok(!get.log.some(p => p === 'skills/demo-skill/'), '有 manifest 时不应再拉目录索引');
});

test('loadOne 无 manifest 时回退目录自动索引并递归子目录', async () => {
  const get = fakeGet({
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/': '<a href="../">up</a><a href="SKILL.md">s</a><a href="references/">r/</a>',
    'skills/demo-skill/references/': '<a href="guide.md">g</a>',
    'skills/demo-skill/references/guide.md': '指南正文',
  });
  const { skill } = await L.loadOne(get, 'demo-skill');
  assert.strictEqual(skill.source, 'autoindex');
  assert.strictEqual(skill.files['/skills/demo-skill/references/guide.md'], '指南正文');
});

test('loadOne 最终回退扫描正文引用', async () => {
  const get = fakeGet({
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/references/guide.md': '指南正文',
  });
  const { skill, warnings } = await L.loadOne(get, 'demo-skill');
  assert.strictEqual(skill.source, 'reference-scan');
  assert.strictEqual(skill.files['/skills/demo-skill/references/guide.md'], '指南正文');
  assert.deepStrictEqual(warnings, []);
});

test('loadOne 附件缺失只警告，Skill 仍可用', async () => {
  const get = fakeGet({
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/manifest.json': ['references/guide.md', 'gone.md'],
    'skills/demo-skill/references/guide.md': '指南正文',
  });
  const { skill, warnings } = await L.loadOne(get, 'demo-skill');
  assert.ok(skill.files['/skills/demo-skill/references/guide.md']);
  assert.ok(!skill.files['/skills/demo-skill/gone.md']);
  assert.ok(warnings.some(w => w.includes('gone.md')));
});

test('loadOne 缺 SKILL.md 或 frontmatter 不合法时报错', async () => {
  await assert.rejects(() => L.loadOne(fakeGet({}), 'demo-skill'), /HTTP 404/);
  await assert.rejects(
    () => L.loadOne(fakeGet({ 'skills/x-y/SKILL.md': '# 没有 frontmatter' }), 'x-y'),
    /名称不合法/);
  await assert.rejects(
    () => L.loadOne(fakeGet({ 'skills/x-y/SKILL.md': '---\nname: x-y\n---\n正文' }), 'x-y'),
    /缺少 description/);
});

test('loadOne 目录名与 SKILL.md 中 name 不一致时警告并以后者为准', async () => {
  const get = fakeGet({ 'skills/wrong-dir/SKILL.md': SKILL_MD });
  const { skill, warnings } = await L.loadOne(get, 'wrong-dir');
  assert.strictEqual(skill.name, 'demo-skill');
  assert.ok(warnings.some(w => w.includes('不一致')));
});

test('loadOne 含脚本文件时给出不执行脚本的警告', async () => {
  const get = fakeGet({
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/demo-skill/manifest.json': ['scripts/run.py'],
    'skills/demo-skill/scripts/run.py': 'print(1)',
  });
  const { warnings } = await L.loadOne(get, 'demo-skill');
  assert.ok(warnings.some(w => w.includes('不执行脚本')));
});

test('loadAll 取不到清单时静默返回 available=false（单文件模式）', async () => {
  const r = await L.loadAll(fakeGet({}));
  assert.strictEqual(r.available, false);
  assert.deepStrictEqual(r.skills, []);
  assert.deepStrictEqual(r.errors, []);
});

test('loadAll 按清单加载、跳过失败项并汇总错误', async () => {
  const get = fakeGet({
    'skill_enable_list.json': ['demo-skill', 'broken-one'],
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/broken-one/SKILL.md': '# 缺 frontmatter',
  });
  const r = await L.loadAll(get);
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.skills.length, 1);
  assert.strictEqual(r.skills[0].name, 'demo-skill');
  assert.ok(r.errors.some(e => e.includes('broken-one')));
});

test('loadAll 未列入清单的 Skill 不会被加载', async () => {
  const get = fakeGet({
    'skill_enable_list.json': ['demo-skill'],
    'skills/demo-skill/SKILL.md': SKILL_MD,
    'skills/hidden-skill/SKILL.md': '---\nname: hidden-skill\ndescription: 未启用\n---\n正文',
  });
  const r = await L.loadAll(get);
  assert.deepStrictEqual(r.skills.map(s => s.name), ['demo-skill']);
  assert.ok(!get.log.some(p => p.includes('hidden-skill')));
});

test('loadAll 清单格式错误时报错而非崩溃', async () => {
  const r = await L.loadAll(fakeGet({ 'skill_enable_list.json': { nope: true } }));
  assert.strictEqual(r.available, true);
  assert.ok(r.errors[0].includes('格式错误'));
});

test('createFetcher 拼接基址、解析 JSON、非 2xx 抛错', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.endsWith('missing.json')) return { ok: false, status: 404 };
    if (url.endsWith('bad.json')) return { ok: true, text: async () => '{oops' };
    return { ok: true, text: async () => '{"a":1}' };
  };
  const get = L.createFetcher(fetchFn, 'https://host/app/');
  assert.deepStrictEqual(await get('a.json', 'json'), { a: 1 });
  assert.strictEqual(calls[0], 'https://host/app/a.json');
  assert.strictEqual(await get('a.json', 'text'), '{"a":1}');
  await assert.rejects(() => get('missing.json', 'json'), /HTTP 404/);
  await assert.rejects(() => get('bad.json', 'json'), /JSON 解析失败/);
});

test('createFetcher 用 URL 解析基址，容忍带查询串/文件名的 base', async () => {
  const seen = [];
  const fetchFn = async url => {
    seen.push(url);
    return { ok: true, status: 200, text: async () => '["a-b"]' };
  };
  const g1 = L.createFetcher(fetchFn, 'https://host/app/page.html?cb=1');
  assert.deepStrictEqual(await g1('skill_enable_list.json', 'json'), ['a-b']);
  assert.strictEqual(seen[0], 'https://host/app/skill_enable_list.json');

  const g2 = L.createFetcher(fetchFn, 'https://host/app/');
  await g2('skills/a-b/SKILL.md');
  assert.strictEqual(seen[1], 'https://host/app/skills/a-b/SKILL.md');
});
