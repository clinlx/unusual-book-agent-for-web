'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

// 仅在用户明确同意修改根目录 README.md 后，才可更新此基准。
// 不提供环境变量或自动更新开关；授权规则见根目录 AGENTS.md。
const approvedSha256 = '9abe36b9bd57a9cbdb34815217a098216dd63a1e98beca0df50beda427a5fef2';
// 仅统一 Git 在 Windows 检出时转换的 CRLF；不忽略正文、空格、BOM 或末尾换行。
const contentHash = content => createHash('sha256')
  .update(Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')).digest('hex');

test('根目录 README.md 必须保持用户确认的内容', () => {
  const readme = readFileSync(path.join(__dirname, '..', 'README.md'));
  const actual = contentHash(readme);
  assert.equal(actual, approvedSha256,
    '根目录 README.md 已变更。必须先获得用户明确同意；获准后才能修改 README 并更新本测试基准。不得跳过或移除检查。');
});

test('README 保护允许 Git 检出的 CRLF，但仍检查全部正文', () => {
  const lf = Buffer.from('# 标题\n正文  \n');
  const crlf = Buffer.from('# 标题\r\n正文  \r\n');
  assert.equal(contentHash(crlf), contentHash(lf));
  for (const changed of ['# 标题\n正文修改  \n', '# 标题\n正文\n', '# 标题\n正文  ', '\uFEFF# 标题\n正文  \n'])
    assert.notEqual(contentHash(Buffer.from(changed)), contentHash(lf));
});
