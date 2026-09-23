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


test('CoverFit none disables explicit and fallback covers',()=>{
  const [item]=GameCatalog.parse([{
    Name:'无封面世界',
    Link:'./world.png',
    Cover:'not a valid cover url with spaces',
    CoverFit:'none'
  }]);
  assert.equal(item.CoverFit,'none');
  assert.equal(item.Cover,'');
});

test('fallback cover stops at PNG IEND when range requests are supported',async()=>{
  const sig=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
  const ihdr=[0,0,0,13,73,72,68,82,...new Array(13).fill(0),0,0,0,0];
  const iend=[0,0,0,0,73,69,78,68,0,0,0,0];
  const png=new Uint8Array([...sig,...ihdr,...iend]);
  const world=new Uint8Array(png.length+200000);world.set(png);world.fill(7,png.length);
  let requested=0;
  const fetch=async(_address,options)=>{
    requested++;
    const match=/bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const start=Number(match[1]),end=Math.min(Number(match[2]),world.length-1);
    const body=world.slice(start,end+1);
    return {ok:true,status:206,arrayBuffer:async()=>body.buffer};
  };
  const blob=await GameCatalog.fallbackCover('https://example.com/world.png',{fetch});
  assert.ok(blob);
  assert.equal(blob.size,png.length);
  assert.equal(requested,1);
});

test('fallback cover ignores non-PNG resources after the first range',async()=>{
  let requested=0;
  const fetch=async()=>{
    requested++;
    const body=new Uint8Array([80,75,3,4,1,2,3,4]);
    return {ok:true,status:206,arrayBuffer:async()=>body.buffer};
  };
  assert.equal(await GameCatalog.fallbackCover('https://example.com/world.zip',{fetch}),null);
  assert.equal(requested,1);
});
