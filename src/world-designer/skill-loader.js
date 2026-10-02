'use strict';
/* skill-loader.js —— 从同级 skills/ 目录拉取内置 Skill。
   浏览器无法列目录，因此按三级机制依次发现文件：
   1. skills/<name>/manifest.json —— 显式文件清单（最可靠，推荐）
   2. 目录自动索引（http-server / nginx autoindex / python http.server）—— 解析 <a href>
   3. 扫描 SKILL.md 正文里引用的相对路径 —— 最后兜底
   纯逻辑模块：fetch 由调用方注入，Node 下可测。 */
const SkillLoader = (() => {
  const _Skills = (typeof module !== 'undefined') ? require('./skills.js') : Skills;

  const ENABLE_LIST = 'skill_enable_list.json';
  const SKILLS_DIR = 'skills';
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const MAX_DEPTH = 4;          // 自动索引递归深度上限，防止意外的无限层级
  const MAX_FILES = 60;         // 单个 Skill 最多拉取的附件数

  // 从自动索引 HTML 中提取条目。目录以 / 结尾；忽略上级链接与查询串。
  function parseIndexHtml(html) {
    const out = [];
    const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      let href = m[1];
      if (/^(https?:)?\/\//i.test(href)) continue;    // 跨站链接
      if (href.startsWith('?') || href.startsWith('#')) continue;
      href = href.split('?')[0].split('#')[0];
      // http-server 等会输出 "./name" 形式，统一去掉前导 ./
      href = href.replace(/^\.\//, '');
      if (!href || href === '/' || href === './' || href === '../' || href === '..') continue;
      if (href.startsWith('/')) continue;             // 绝对路径通常是站点导航，不是子项
      if (href.includes('..')) continue;
      out.push(decodeURIComponent(href));
    }
    return out;
  }

  // 从 SKILL.md 正文里找引用的相对路径（如 references/foo.md、./scripts/a.py）
  function referencedPaths(body) {
    const found = new Set();
    // markdown 链接/图片
    const link = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
    // 行内代码或裸文本中的相对路径
    const bare = /(?:^|[\s`"'(])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)+\.[a-z0-9]{1,6})(?=[\s`"')]|$)/gim;
    for (const re of [link, bare]) {
      let m;
      while ((m = re.exec(body))) {
        let p = m[1].replace(/^\.\//, '');
        if (/^(https?:|mailto:|#|\/)/i.test(p)) continue;
        if (p.includes('..')) continue;
        found.add(p);
      }
    }
    return [...found];
  }

  // 递归展开一个目录（依赖自动索引）
  async function walkIndex(get, base, prefix, depth, acc) {
    if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return acc;
    const html = await get(base + prefix, 'text').catch(() => null);
    if (!html || !/<a\s/i.test(html)) return acc;
    for (const entry of parseIndexHtml(html)) {
      if (acc.length >= MAX_FILES) break;
      if (entry.endsWith('/')) await walkIndex(get, base, prefix + entry, depth + 1, acc);
      else acc.push(prefix + entry);
    }
    return acc;
  }

  // 解析启用清单：支持 ["a","b"] 或 { skills: ["a","b"] }
  function parseEnableList(json) {
    const arr = Array.isArray(json) ? json : (json && Array.isArray(json.skills) ? json.skills : null);
    if (!arr) throw new Error(ENABLE_LIST + ' 格式错误：应为字符串数组或 {"skills": [...]}');
    const names = [], bad = [];
    for (const item of arr) {
      const n = String(item || '').trim().replace(/^\/+|\/+$/g, '');
      if (!n) continue;
      if (!NAME_RE.test(n)) { bad.push(String(item)); continue; }
      if (!names.includes(n)) names.push(n);
    }
    return { names, bad };
  }

  // 载入单个 Skill。get(url, as) → Promise<text|json>，失败应 reject。
  async function loadOne(get, name) {
    const dir = SKILLS_DIR + '/' + name + '/';
    const md = await get(dir + 'SKILL.md', 'text');
    if (!md || !md.trim()) throw new Error('SKILL.md 为空');

    // ① 显式清单
    let paths = null, source = '';
    const manifest = await get(dir + 'manifest.json', 'json').catch(() => null);
    if (manifest) {
      const list = Array.isArray(manifest) ? manifest
        : (Array.isArray(manifest.files) ? manifest.files : null);
      if (list) { paths = list.map(String); source = 'manifest'; }
    }
    // ② 目录自动索引
    if (!paths) {
      const walked = await walkIndex(get, dir, '', 0, []);
      if (walked.length) { paths = walked; source = 'autoindex'; }
    }
    // ③ 扫描正文引用
    if (!paths) {
      const fm = _Skills.parseFrontmatter(md);
      paths = referencedPaths(fm.body || md);
      source = paths.length ? 'reference-scan' : 'none';
    }

    // 归一化：去掉前导/内部的 ./、重复的 SKILL.md、越界路径
    const clean = [];
    for (const p0 of paths) {
      const p = String(p0).replace(/^\.?\//, '').replace(/\/\.\//g, '/').replace(/\/{2,}/g, '/');
      if (!p || p === 'SKILL.md' || p === 'manifest.json') continue;
      if (p.includes('..') || p.endsWith('/')) continue;
      if (!clean.includes(p)) clean.push(p);
    }

    // 拉取附件；单个失败只警告，不让整个 Skill 失败
    const rawFiles = [{ name: 'SKILL.md', text: md }];
    const missing = [];
    for (const p of clean.slice(0, MAX_FILES)) {
      const text = await get(dir + p, 'text').catch(() => null);
      if (text === null) { missing.push(p); continue; }
      rawFiles.push({ name: p, text });
    }

    // 交给已有的校验/挂载逻辑（frontmatter 校验、脚本警告、垃圾清理）
    const built = _Skills.buildSkill(rawFiles, { existingNames: [] });
    built.skill.builtin = true;
    built.skill.source = source;
    if (built.skill.name !== name)
      built.warnings.push('目录名「' + name + '」与 SKILL.md 中的 name「' + built.skill.name + '」不一致，以后者为准');
    if (missing.length)
      built.warnings.push('以下附件未能取到，已跳过: ' + missing.join(', '));
    if (source === 'none')
      built.warnings.push('未发现附件清单（无 manifest.json、目录索引不可用、正文也无引用）；如需附件请添加 manifest.json');
    return built;
  }

  // 载入全部启用的 Skill。返回 { skills, warnings, errors, available }
  // available=false 表示连清单都取不到（未通过 HTTP 打开，或没放 skills 目录）
  async function loadAll(get) {
    const result = { skills: [], warnings: [], errors: [], available: false };
    let listJson;
    try { listJson = await get(ENABLE_LIST, 'json'); }
    catch (_) { return result; }                       // 静默：单文件模式的正常情况
    if (listJson === null || listJson === undefined) return result;
    result.available = true;

    let parsed;
    try { parsed = parseEnableList(listJson); }
    catch (e) { result.errors.push(e.message); return result; }
    for (const b of parsed.bad)
      result.errors.push('跳过非法 Skill 名（需 kebab-case）: ' + b);

    for (const name of parsed.names) {
      try {
        const built = await loadOne(get, name);
        if (result.skills.some(s => s.name === built.skill.name)) {
          result.errors.push('重名 Skill 已跳过: ' + built.skill.name);
          continue;
        }
        built.skill.warnings = built.warnings;
        result.skills.push(built.skill);
        for (const w of built.warnings) result.warnings.push(name + ': ' + w);
      } catch (e) {
        result.errors.push(name + ': ' + e.message);
      }
    }
    return result;
  }

  // 浏览器端 fetch 适配器：相对于页面所在目录取文件
  function createFetcher(fetchFn, baseHref) {
    const base = baseHref || '';
    // 用 URL 解析而非字符串拼接：base 若带查询串/未以 / 结尾（如 page.html?x=1），
    // 拼接会产出 page.html?x=1skill_enable_list.json 这类垃圾地址并静默拿到错内容。
    const resolve = path => {
      if (!base) return path;
      try { return new URL(path, base).href; } catch (_) { return base + path; }
    };
    return async function get(path, as) {
      const resp = await fetchFn(resolve(path), { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      if (as === 'json') {
        const text = await resp.text();
        try { return JSON.parse(text); }
        catch (e) { throw new Error('JSON 解析失败: ' + e.message); }
      }
      return resp.text();
    };
  }

  // 内嵌快照 fetcher：构建期把 skills/ 烘成 { 路径 → 文本 } 后由此消费，
  // 与 HTTP fetcher 接口一致，故 loadOne/loadAll 无需区分数据来源。
  // 快照里没有目录索引，manifest.json 缺失时会自动落到「扫描正文引用」那一级。
  function createBundleFetcher(snapshot) {
    const snap = snapshot || {};
    return async function get(path, as) {
      const key = String(path).replace(/^\.?\//, '');
      if (!(key in snap)) throw new Error('打包内不存在: ' + key);
      const text = snap[key];
      if (as === 'json') {
        try { return JSON.parse(text); }
        catch (e) { throw new Error('JSON 解析失败: ' + e.message); }
      }
      return text;
    };
  }

  return { ENABLE_LIST, SKILLS_DIR, parseIndexHtml, referencedPaths, parseEnableList, loadOne, loadAll, createFetcher, createBundleFetcher };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SkillLoader;
