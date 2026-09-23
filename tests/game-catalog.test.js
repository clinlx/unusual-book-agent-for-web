'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const GameCatalog=require('../src/game-catalog.js');

const valid=[{
  Name:'示例世界',
  Introduction:'简介',
  Text:'详情',
  Link:'./world.zip',
  Cover:'./cover.png',
  CoverFit:'auto',
  Tags:[{TagName:'测试',Color:'#112233'}]
}];

test('custom catalog source loads and resolves relative assets against the catalog URL',async()=>{
  const fetch=async address=>({
    ok:true,
    status:200,
    url:'https://cdn.example/catalog/modules.json',
    json:async()=>valid
  });
  const items=await GameCatalog.load({
    fetch,
    source:'https://cdn.example/catalog/modules.json',
    pageUrl:'https://app.example/index.html'
  });
  assert.equal(items[0].Link,'https://cdn.example/catalog/world.zip');
  assert.equal(items[0].Cover,'https://cdn.example/catalog/cover.png');
});

test('empty source uses the local default',async()=>{
  let requested='';
  const fetch=async address=>{
    requested=address;
    return {ok:true,status:200,url:'https://app.example/modules.json',json:async()=>[]};
  };
  await GameCatalog.load({fetch,source:'',pageUrl:'https://app.example/index.html'});
  assert.equal(requested,GameCatalog.DEFAULT_SOURCE);
});

test('custom catalog source validates JSON schema',async()=>{
  const fetch=async()=>({ok:true,status:200,url:'https://cdn.example/modules.json',json:async()=>[{}]});
  await assert.rejects(
    GameCatalog.load({fetch,source:'https://cdn.example/modules.json'}),
    /世界列表格式错误/
  );
});

test('catalog source rejects unsupported schemes and credentials',()=>{
  assert.throws(()=>GameCatalog.source('file:///tmp/modules.json'),/HTTP \/ HTTPS/);
  assert.throws(()=>GameCatalog.source('https://user:pass@example.com/modules.json'),/账号密码/);
});
