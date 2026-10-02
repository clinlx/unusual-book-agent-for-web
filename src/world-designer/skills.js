'use strict';
const Skills = (() => {
  const GARBAGE = /(^|\/)(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\.[^/]+$)/i;
  const SCRIPT_EXT = /\.(js|mjs|cjs|ts|py|sh|bat|cmd|ps1|rb|php|pl|exe)$/i;
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  function stripGarbage(files) {
    return files.filter(f => !f.isDir && !GARBAGE.test(f.name));
  }

  function findRoot(files) {
    // 若所有条目共享同一顶层目录且 SKILL.md 不在最外层，则下探一层
    if (files.some(f => f.name === 'SKILL.md')) return '';
    const tops = new Set(files.map(f => f.name.split('/')[0]));
    if (tops.size === 1) {
      const top = [...tops][0];
      if (files.some(f => f.name === top + '/SKILL.md')) return top + '/';
    }
    return '';
  }

  // 归一化文本源：去掉 UTF-8 BOM，CRLF/CR 统一成 LF。
  // Windows 上编辑的 SKILL.md 是 CRLF，若不归一化，frontmatter 每行尾会残留 \r，
  // name/description 全部解析失败（曾导致合法 Skill 被判「名称不合法」）。
  function normalizeText(s) {
    return String(s == null ? '' : s).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  function parseFrontmatter(md) {
    const src = normalizeText(md);
    const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { body: src };
    const fm = { body: m[2] };
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    return fm;
  }

  function buildSkill(rawFiles, opts) {
    const existing = (opts && opts.existingNames) || [];
    let files = stripGarbage(rawFiles);
    const root = findRoot(files);
    if (root) files = files.map(f => ({ ...f, name: f.name.slice(root.length) })).filter(f => f.name);
    const skillFile = files.find(f => f.name === 'SKILL.md');
    if (!skillFile) throw new Error('无效 Skill 包：缺少 SKILL.md');
    const fm = parseFrontmatter(skillFile.text);
    if (!fm.name || !NAME_RE.test(fm.name)) throw new Error('Skill 名称不合法（需 kebab-case）');
    if (!fm.description) throw new Error('SKILL.md 缺少 description');
    if (existing.includes(fm.name)) throw new Error('同名 Skill 已存在: ' + fm.name);
    const mounted = {};
    const warnings = [];
    let hasScript = false;
    for (const f of files) {
      if (f.name === 'SKILL.md') continue;
      mounted['/skills/' + fm.name + '/' + f.name] = normalizeText(f.text);
      if (SCRIPT_EXT.test(f.name)) hasScript = true;
    }
    if (hasScript) warnings.push('该 Skill 含脚本文件；本环境不执行脚本，依赖脚本的功能可能异常');
    return {
      skill: { name: fm.name, description: fm.description, instructions: fm.body, files: mounted, builtin: false },
      warnings,
    };
  }

  return { stripGarbage, findRoot, normalizeText, parseFrontmatter, buildSkill };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Skills;
