'use strict';
/* bundle-skills.js —— 把 skills/ 目录烘成可内联的 JS 快照。
   浏览器无法列目录，单文件版又没有 HTTP 可用，故在构建期把文件读成
   { 路径 → 文本 } 的字典，运行时用同一套 SkillLoader 逻辑消费。 */
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv',
  '.html', '.htm', '.css', '.xml', '.svg', '.ini', '.toml', '.cfg', '.rst',
  '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.bat', '.rb', '.php', '.pl', '.sql',
]);
const SKIP_NAME = /^(\.|__MACOSX$|__pycache__$|Thumbs\.db$|desktop\.ini$|node_modules$)/i;
const MAX_FILE_BYTES = 512 * 1024;   // 单文件上限，避免误把大文件烘进包

// 二进制嗅探：含 NUL 即判定为非文本
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// 递归收集一个目录下的文本文件，返回 { 相对路径(用 /) → 内容 }
function collectDir(root, opts) {
  const out = {};
  const warn = (opts && opts.warn) || (() => {});
  (function walk(abs, rel) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { warn('无法读取目录 ' + rel + '：' + e.message); return; }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_NAME.test(ent.name)) continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { walk(childAbs, childRel); continue; }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) { warn('跳过非文本文件 ' + childRel); continue; }
      const stat = fs.statSync(childAbs);
      if (stat.size > MAX_FILE_BYTES) { warn('跳过超大文件 ' + childRel + '（' + Math.round(stat.size / 1024) + 'KB）'); continue; }
      const buf = fs.readFileSync(childAbs);
      if (looksBinary(buf)) { warn('跳过疑似二进制文件 ' + childRel); continue; }
      // 统一 LF：Windows 上的 CRLF 会让 frontmatter 解析出带 \r 的值
      out[childRel] = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    }
  })(root, '');
  return out;
}

// 生成快照对象：{ 'skill_enable_list.json': '...', 'skills/x/SKILL.md': '...' }
// 只烘启用清单里列出的 Skill，未启用的不进包，避免白白撑大体积。
function buildSnapshot(distDir, opts) {
  const warn = (opts && opts.warn) || (() => {});
  const listPath = path.join(distDir, 'skill_enable_list.json');
  if (!fs.existsSync(listPath)) { warn('未找到 skill_enable_list.json，跳过 Skill 打包'); return null; }

  const listRaw = fs.readFileSync(listPath, 'utf8').replace(/^﻿/, '');
  let names;
  try {
    const parsed = JSON.parse(listRaw);
    names = Array.isArray(parsed) ? parsed : (parsed && parsed.skills);
    if (!Array.isArray(names)) throw new Error('应为字符串数组或 {"skills":[...]}');
  } catch (e) { warn('skill_enable_list.json 解析失败：' + e.message); return null; }

  const snap = { 'skill_enable_list.json': listRaw };
  const stats = [];
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const dir = opts?.skillDirectories?.[name] || path.join(distDir, 'skills', name);
    if (!fs.existsSync(dir)) { warn('启用清单里的 ' + name + ' 在 skills/ 下不存在，已跳过'); continue; }
    const files = collectDir(dir, { warn: m => warn(name + ': ' + m) });
    if (!files['SKILL.md']) { warn(name + ': 缺少 SKILL.md，已跳过'); continue; }
    let bytes = 0;
    for (const [rel, text] of Object.entries(files)) {
      snap['skills/' + name + '/' + rel] = text;
      bytes += Buffer.byteLength(text, 'utf8');
    }
    stats.push({ name, files: Object.keys(files).length, bytes });
  }
  return { snapshot: snap, stats };
}

module.exports = { collectDir, buildSnapshot, TEXT_EXT };
