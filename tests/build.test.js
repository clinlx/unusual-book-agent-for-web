'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('default build emits index.html and leaves the manually managed catalog untouched',()=>{
  const catalogPath=path.join(root,'dist/modules.json');
  const catalogBefore=fs.existsSync(catalogPath)?fs.readFileSync(catalogPath):null;
  execFileSync(process.execPath,['build.js'],{cwd:root,stdio:'pipe'});
  const html=fs.readFileSync(path.join(root,'dist/index.html'),'utf8');
  assert.doesNotMatch(html,/BUNDLED_MODULES/);
  assert.deepEqual(fs.existsSync(catalogPath)?fs.readFileSync(catalogPath):null,catalogBefore);
  assert.ok(fs.existsSync(path.join(root,'dist/designer.html')),'generate standalone designer page');
  assert.doesNotMatch(html,/<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html,/function executeRound\(kind,text\)/);
  assert.match(html,/_0x[0-9a-f]+/i,'obfuscator output is embedded');
  assert.ok(!fs.existsSync(path.join(root,'dist/index.html.map')));
  const books=JSON.parse(html.match(/const BUNDLED_RULE_BOOKS = (.*);/)[1]);
  const expected=[];
  function walk(relative=''){
    if(!fs.existsSync(path.join(root,'assets/trpg_rule_books',relative)))return;
    for(const entry of fs.readdirSync(path.join(root,'assets/trpg_rule_books',relative),{withFileTypes:true})){
      const key=relative+entry.name;
      if(entry.isDirectory())walk(key+'/');
      else if(entry.isFile()&&/\.(md|txt|json)$/i.test(entry.name)){
        expected.push(key);
        assert.equal(books[key],fs.readFileSync(path.join(root,'assets/trpg_rule_books',key),'utf8'));
      }
    }
  }
  walk();assert.deepEqual(Object.keys(books).sort(),expected.sort());
  const prompts=JSON.parse(html.match(/const BUNDLED_PROMPTS = (.*);/)[1]);
  const registry=require('../src/game-prompts').create(prompts,books);
  if(expected.includes('index.md')){
    assert.match(registry.buildSystem(),/\/\.reference\/trpg_rule_books\/index.md/);
    assert.ok(registry.file('/.reference/trpg_rule_books/index.md'));
  }
  assert.equal(registry.file('/.reference/回合细则.md'),undefined);
});
