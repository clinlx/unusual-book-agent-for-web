'use strict';
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {SEED_FILES}=require('../../src/world-designer/00-config');
(async()=>{
 fs.mkdirSync('tests/artifacts',{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',()=>errors.push('native dialog'));
  await page.route('https://**/*',route=>route.abort());
  const ready=()=>page.waitForFunction(()=>window.__UI_STATE__?.sessionId&&!document.querySelector('#boot'));
  await page.goto(pathToFileURL(path.resolve('dist/designer.html')).href);await ready();
  assert.equal(await page.locator('#welcomeOverlay').count(),1);
  assert.equal(await page.evaluate(()=>VFS.readFile(__UI_STATE__.tree,'/workspace/README.md').content),SEED_FILES['README.md']);
  assert.equal(await page.evaluate(()=>document.querySelector('.welcome-copy').innerHTML),await page.evaluate(()=>MD.render(SEED_FILES['README.md'])));
  assert.equal(await page.locator('.workspace-heading .world-logo svg').count(),1);
  await page.screenshot({path:'tests/artifacts/designer-welcome-desktop.png',animations:'disabled'});
  await page.setViewportSize({width:320,height:740});
  assert.ok(await page.locator('#welcomeOverlay button').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'tests/artifacts/designer-welcome-mobile.png',animations:'disabled'});
  await page.getByRole('button',{name:'知道了',exact:true}).click();
  await page.locator('#welcomeOverlay').waitFor({state:'detached'});
  await page.reload();await ready();assert.equal(await page.locator('#welcomeOverlay').count(),0);
  for(const width of [320,390,800,1024,1440]){
   await page.setViewportSize({width,height:960});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const bounds=await page.evaluate(()=>{const t=document.querySelector('.workspace-heading strong'),l=document.querySelector('.world-logo'),a=document.querySelector('.page-switch'),h=document.querySelector('#mainHeader');return {textFits:t.scrollWidth<=t.clientWidth,logo:l.getBoundingClientRect().right,title:t.getBoundingClientRect().left,link:a.getBoundingClientRect().left,heading:document.querySelector('.workspace-heading').getBoundingClientRect().right,center:a.getBoundingClientRect().left+a.getBoundingClientRect().width/2,headerCenter:h.getBoundingClientRect().left+h.getBoundingClientRect().width/2};});
   assert.equal(bounds.textFits,true,'full title visible at '+width+': '+JSON.stringify(bounds));assert.ok(bounds.logo<=bounds.title);assert.ok(bounds.heading<=bounds.link);assert.ok(Math.abs(bounds.center-bounds.headerCenter)<2);
  }
  await page.screenshot({path:'tests/artifacts/designer-black-gold.png',animations:'disabled'});
  // Migrate only the old untouched seed; preserve a user's custom README.
  await page.evaluate(async()=>{VFS.writeFile(__UI_STATE__.tree,'/workspace/README.md','# 欢迎\n\n这是你的工作区。左侧管理会话，右侧查看文件。\n');await __UI__.saveTree();});
  await page.reload();await ready();assert.equal(await page.evaluate(()=>VFS.readFile(__UI_STATE__.tree,'/workspace/README.md').content),SEED_FILES['README.md']);
  await page.evaluate(async()=>{VFS.writeFile(__UI_STATE__.tree,'/workspace/README.md','# 我的世界\n自定义内容');await __UI__.saveTree();});
  await page.reload();await ready();assert.equal(await page.evaluate(()=>VFS.readFile(__UI_STATE__.tree,'/workspace/README.md').content),'# 我的世界\n自定义内容');
  await page.getByTitle('设置',{exact:true}).click();
  await page.screenshot({path:'tests/artifacts/designer-black-gold-settings.png',animations:'disabled'});
  assert.deepEqual(errors,[]);
  console.log('PASS: first-visit welcome, shared Markdown, persistent acknowledgement, safe README migration, logo and compact responsive title');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
