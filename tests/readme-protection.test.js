'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

// 仅在用户明确同意修改根目录 README.md 后，才可更新此基准。
// 不提供环境变量或自动更新开关；授权规则见根目录 AGENTS.md。
const approvedSha256 = '661b43336ef8568945cf483aed51411b92781c8cac63fc1ac8d905c7ea7564d0';

test('根目录 README.md 必须保持用户确认的内容', () => {
  const readme = readFileSync(path.join(__dirname, '..', 'README.md'));
  const actual = createHash('sha256').update(readme).digest('hex');
  assert.equal(actual, approvedSha256,
    '根目录 README.md 已变更。必须先获得用户明确同意；获准后才能修改 README 并更新本测试基准。不得跳过或移除检查。');
});
