'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Agent = require('../../src/world-designer/agent');
const C = require('../../src/world-designer/00-config');
const call = (args, id = 'doc') => ({ id, type: 'function', function: { name: 'parse_document', arguments: JSON.stringify(args) } });

test('document tool exposes supported formats and both delivery modes without a skill dependency', () => {
  const tool = Agent.toolDefinitions([]).find(t => t.function.name === 'parse_document');
  assert.ok(tool, 'parse_document must be registered');
  assert.match(tool.function.description, /PDF.*DOCX|DOCX.*PDF/);
  assert.deepEqual(tool.function.parameters.properties.format.enum, ['text', 'images']);
  assert.deepEqual(tool.function.parameters.properties.output.enum, ['return', 'file']);
  assert.match(tool.function.description,/16000.*临时文件/);
});

test('non-visual models retain document parsing with an explicit restriction on returning images', () => {
  const tools = Agent.toolDefinitions([], { imageSending: false });
  const tool = tools.find(t => t.function.name === 'parse_document');
  assert.ok(tool);
  assert.match(tool.function.description, /当前模型不支持图片输入/);
  assert.match(tool.function.description, /format=images 只允许 output=file/);
  assert.match(tool.function.description, /format=text 可直接返回或保存/);
  assert.equal(tools.some(t => t.function.name === 'view_image'), false);
  assert.doesNotMatch(Agent.toolDefinitions([]).find(t => t.function.name === 'parse_document').function.description, /当前模型不支持/);
});

test('direct page images reach the next model request after all tool results, without persisting pixels', async () => {
  const image = page => ({ page, dataUrl: 'data:image/png;base64,AAAA', width: 20, height: 30 });
  const ctx = { config: C.AGENT_CONFIG, viewImage: () => {}, parseDocument: async () => ({ result: '{"pages":2}', images: [image(1), image(2)] }) };
  let requests = 0;
  const out = await Agent.runTurn(ctx, [{ role: 'user', content: '看文档' }], async msgs => {
    if (++requests === 1) return { tool_calls: [call({ path: '/workspace/a.pdf', format: 'images', output: 'return' })] };
    assert.deepEqual(msgs.slice(-2).map(m => m.role), ['tool', 'user']);
    assert.equal(msgs.at(-1).content.filter(p => p.type === 'image_url').length, 2);
    assert.match(msgs.at(-1).content[0].text, /第 1 页/);
    return { content: '已看到两页' };
  });
  assert.equal(requests, 2);
  assert.ok(!JSON.stringify(out.newMessages).includes('base64'));
  assert.equal(out.hadWrite, false);
});

test('direct image mode reports disabled multimodal before parsing, while file output remains available', async () => {
  let parses = 0;
  const ctx = { config: C.AGENT_CONFIG, parseDocument: async () => { parses++; return { result: '{"files":["/workspace/pages/1.png"]}' }; } };
  const unavailable = Agent.executeTool(ctx, 'parse_document', { path: '/workspace/a.pdf', format: 'images', output: 'return' });
  assert.match(unavailable.result, /图片发送已关闭/);
  assert.equal(parses, 0);
  const saved = Agent.executeTool(ctx, 'parse_document', { path: '/workspace/a.pdf', format: 'images', output: 'file', output_dir: '/workspace/pages' });
  assert.equal(saved.isWrite, true);
  assert.match((await saved.pending).result, /1.png/);
  assert.equal(parses, 1);
});

test('document parse failures are tool errors and do not count as successful writes', async () => {
  const ctx = { config: C.AGENT_CONFIG, parseDocument: async () => { throw Error('损坏的文档'); } };
  let requests = 0;
  const out = await Agent.runTurn(ctx, [], async msgs => {
    if (++requests === 1) return { tool_calls: [call({ path: '/workspace/a.docx', format: 'text', output: 'file', output_path: '/workspace/a.txt' })] };
    assert.match(msgs.at(-1).content, /错误.*损坏的文档/);
    return { content: '解析失败' };
  });
  assert.equal(out.hadWrite, false);
});

test('automatic text fallback counts as a write and keeps the next AI request limited to a preview and file metadata',async()=>{
  const VFS=require('../../src/world-designer/vfs'),Documents=require('../../src/world-designer/documents');
  const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/large.docx','UEs=',{encoding:'base64'});
  const ctx={tree,config:C.AGENT_CONFIG,parseDocument:args=>Documents.parse(tree,args,{runtime:{docx:async()=>({text:'文'.repeat(25000),info:{}})}})};
  let requests=0;
  const out=await Agent.runTurn(ctx,[{role:'user',content:'解析长文档'}],async msgs=>{
    if(++requests===1)return {tool_calls:[call({path:'/workspace/large.docx',format:'text',output:'return'})]};
    const result=JSON.parse(msgs.at(-1).content);assert.equal(result.output,'file');assert.equal(result.text.length,8000);assert.equal(result.next_offset,8000);
    assert.match(result.note,/read_file/);assert.equal(VFS.readFile(tree,result.path,{cap:Infinity}).content.length,25000);
    assert.ok(JSON.stringify(msgs).length<10000);return {content:'将按需分段读取'};
  });
  assert.equal(out.hadWrite,true);assert.equal(requests,2);
});
