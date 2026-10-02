'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const VFS = require('../../src/world-designer/vfs.js');
const ZIP = require('../../src/world-designer/zip.js');
const Tokens = require('../../src/world-designer/tokens.js');
const Compress = require('../../src/world-designer/compress.js');
const Agent = require('../../src/world-designer/agent.js');
const { AGENT_CONFIG } = require('../../src/world-designer/00-config.js');

test('binary workspace files cannot be read, patched or searched as text', () => {
  const tree = VFS.createTree();
  VFS.writeFile(tree, '/workspace/photo.png', 'AAEC/w==', { encoding: 'base64' });
  assert.throws(() => VFS.readFile(tree, '/workspace/photo.png'), /非文本/);
  assert.throws(() => VFS.applyPatch(tree, '/workspace/photo.png', 'AA', 'BB'), /非文本/);
  assert.equal(VFS.search(tree, { pattern: 'AA', target: 'content' }).hits.length, 0);
  assert.equal(VFS.listDir(tree, '/workspace')[0].size, 4);
  assert.equal(VFS.stat(tree, '/workspace/photo.png').bytes, 4);
});

test('ZIP round trip preserves original binary bytes and nested directories', async () => {
  const data = Uint8Array.from([0, 1, 255, 128, 13, 10]);
  const blob = ZIP.makeZip([{ name: 'folder/' }, { name: 'folder/file.bin', bytes: data }]);
  const entries = await ZIP.parseZip(await blob.arrayBuffer());
  assert.deepEqual(entries[1].bytes, data);
});

test('image messages retain text in compression and do not count base64 as text tokens', () => {
  const message = { role: 'user', content: [
    { type: 'text', text: '查看这张图片' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100000) } },
  ] };
  const transcript = Compress.renderTranscript([message]);
  assert.match(transcript, /查看这张图片/);
  assert.match(transcript, /图片/);
  assert.ok(!transcript.includes('[object Object]'));
  assert.ok(!transcript.includes('AAAA'));
  assert.ok(Tokens.estimateMessage(message) >= 1000);
  assert.ok(Tokens.estimateMessage(message) < 10000);
});

test('binary copies remain unreadable and deletion never exposes base64 as a text diff', () => {
  const tree = VFS.createTree();
  VFS.writeFile(tree, '/workspace/photo.png', 'AAEC/w==', { encoding: 'base64' });
  const ctx = { tree, config: AGENT_CONFIG, readState: new Map() };
  Agent.executeTool(ctx, 'copy', { from: '/workspace/photo.png', to: '/workspace/copy.png' });
  assert.equal(VFS.resolve(tree, ['workspace', 'copy.png']).encoding, 'base64');
  const write = Agent.executeTool(ctx, 'write_file', { path: '/workspace/copy.png', content: 'text' });
  assert.equal(write.isWrite, false);
  assert.match(write.result, /非文本/);
  const deletion = Agent.executeTool(ctx, 'delete', { path: '/workspace/photo.png' });
  assert.ok(!JSON.stringify(deletion).includes('AAEC/w=='));
});
