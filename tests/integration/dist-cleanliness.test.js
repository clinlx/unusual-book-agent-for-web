'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');

test('publication directory contains only release outputs, with no test artifacts',()=>{
  const dist=path.resolve(__dirname,'../../dist');
  if(!fs.existsSync(dist))return;
  const files=new Set(['index.html','designer.html','modules.json','modules-full.json','robots.txt']);
  const unexpected=fs.readdirSync(dist,{withFileTypes:true})
    .filter(entry=>!(entry.isFile()&&files.has(entry.name))&&!(entry.isDirectory()&&entry.name==='files'))
    .map(entry=>entry.name).sort();
  assert.deepEqual(unexpected,[],
    'dist 中有非发布产物。请将测试输出移到 tests/artifacts，并用测试清理钩子删除临时文件：'+unexpected.join('、'));
});
