'use strict';
const {chromium}=require('playwright');
const readyDesigner=require('./designer-ready.cjs');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs'),http=require('node:http');
(async()=>{
 fs.mkdirSync('tests/artifacts',{recursive:true});
 const dist=path.resolve('dist');
 const server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();fs.readFile(file,(e,data)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'text/plain; charset=utf-8');res.end(data);});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  for(const mode of ['file','http']){
   const context=await browser.newContext(),page=await context.newPage(),errors=[],progress=[];
   await context.route('https://**/*',route=>route.abort());
   await context.addInitScript(()=>{for(const name of ['alert','confirm','prompt'])window[name]=()=>{throw Error('Native dialog '+name+' forbidden');};});
   await page.exposeFunction('recordTransfer',text=>progress.push(text));
   await page.addInitScript(()=>{new MutationObserver(()=>{const text=document.querySelector('.world-transfer-overlay [role=status]')?.textContent;if(text)window.recordTransfer(text);}).observe(document,{childList:true,subtree:true,characterData:true});});
   page.on('pageerror',e=>errors.push(e.message));page.on('dialog',()=>errors.push('Native dialog opened'));
   const designer=mode==='file'?pathToFileURL(path.resolve(dist,'designer.html')).href:`http://127.0.0.1:${server.address().port}/designer.html`;
   const ready=()=>readyDesigner(page);
   await page.goto(designer);await ready();
   assert.equal(await page.locator('#playWorldBtn').count(),1,'world play button must exist');
   assert.equal(await page.locator('#filePanelHeader button[title="新建文件夹"]').count(),0);
   await page.evaluate(async()=>{
    VFS.writeFile(__UI_STATE__.tree,'/workspace/试验世界/Player-pc/基础信息.json','{"姓名":"林青","属性":{"生命":10}}');
    VFS.writeFile(__UI_STATE__.tree,'/workspace/试验世界/Player-pc/背包.json','[]');
    VFS.writeFile(__UI_STATE__.tree,'/workspace/试验世界/模组.md','# 初稿');
    VFS.writeFile(__UI_STATE__.tree,'/workspace/试验世界/.trpg-save.json','old game history is not part of a fresh preview');
    VFS.writeFile(__UI_STATE__.tree,'/workspace/试验世界/cover.png','iVBORw0KGgo=',{encoding:'base64'});
    for(let i=0;i<40;i++)VFS.writeFile(__UI_STATE__.tree,'/workspace/试验世界/资料/'+i+'.md','参考资料');
    VFS.mkdir(__UI_STATE__.tree,'/workspace/试验世界/空目录');
    await __UI__.saveTree();await __UI__.openEditor('/workspace/试验世界/模组.md');
   });
   await page.locator('#editorText').fill('# 未保存的世界设定');
   // Exercise the dirty-editor guard through its real handler even when that editor covers the toolbar.
   await page.locator('#playWorldBtn').evaluate(button=>button.click());
   assert.match(await page.locator('#worldPlayConfirm').innerText(),/未保存修改/);
   assert.equal(await page.locator('#worldPlayConfirm select').inputValue(),'/workspace/试验世界');
   if(mode==='http')await page.screenshot({path:'tests/artifacts/world-play-confirm.png',animations:'disabled'});
   await page.locator('#worldPlayConfirm').getByRole('button',{name:'取消',exact:true}).click();
   assert.equal(page.url(),designer);assert.equal(await page.evaluate(()=>__UI_STATE__.editorDirty),true);
   await page.locator('#playWorldBtn').evaluate(button=>button.click());
   await page.locator('#forceWorldPlay').check();await page.locator('#worldPlayConfirm').getByRole('button',{name:'确认并前往'}).click();
   await page.waitForURL(/index\.html#handoff=/);
   await page.waitForFunction(()=>typeof GameApp!=='undefined'&&GameApp.getState().active&&!GameApp.getState().importing&&!document.querySelector('.world-transfer-overlay'));
   const targetURL=page.url(),id=new URL(targetURL).hash.slice('#handoff='.length);
   const result=await page.evaluate(()=>{const s=GameApp.getState();return {id:s.active.id,count:s.saves.length,round:s.active.round,content:VFS.readFile(s.active.tree,'/workspace/模组.md').content,image:VFS.resolve(s.active.tree,['workspace','cover.png']).content,roots:Object.keys(s.active.tree.children.workspace.children),settings:s.settings.apiKey};});
   assert.equal(result.id,'world-handoff-'+id);assert.equal(result.count,1);assert.equal(result.round,0);
   assert.equal(result.content,'# 未保存的世界设定');assert.equal(result.image,'iVBORw0KGgo=');assert.ok(result.roots.includes('空目录'));assert.ok(!result.roots.includes('README.md'));
   assert.ok(!result.roots.includes('.trpg-save.json'));
   const record=await page.evaluate(id=>WorldHandoff.create().get(id),id);assert.equal(record.status,'complete');assert.equal(record.blob,undefined);
   assert.ok(progress.some(p=>p.includes('打包 ZIP')));assert.ok(progress.some(p=>p.includes('接收')||p.includes('读取')));
   await page.evaluate(()=>GameApp.writeFile('/workspace/游玩进度.md','保留已经游玩的更改'));
   await page.reload();await page.waitForFunction(()=>typeof GameApp!=='undefined'&&GameApp.getState().active&&!document.querySelector('.world-transfer-overlay'));
   assert.equal(await page.evaluate(()=>GameApp.getState().saves.length),1);
   assert.equal(await page.evaluate(()=>GameApp.readFile('/workspace/游玩进度.md')),'保留已经游玩的更改');
   // A second explicit play creates a new independent save.
   await page.goto(designer);await ready();
   await page.locator('#playWorldBtn').evaluate(button=>button.click());await page.locator('#forceWorldPlay').check();await page.locator('#worldPlayConfirm').getByRole('button',{name:'确认并前往'}).click();
   await page.waitForURL(/index\.html#handoff=/);await page.waitForFunction(()=>typeof GameApp!=='undefined'&&GameApp.getState().active&&!document.querySelector('.world-transfer-overlay'));
   assert.equal(await page.evaluate(()=>GameApp.getState().saves.length),2);assert.notEqual(page.url(),targetURL);
   // Failed imports retain the archive and offer custom retry/download controls.
   const bad=await page.evaluate(()=>WorldHandoff.create().put(ZIP.makeZip([{name:'模组.md',text:'缺少玩家目录'}]),'错误世界'));
   await page.goto(new URL('index.html#handoff='+bad,designer).href);
   await page.getByRole('button',{name:'重试',exact:true}).waitFor();
   assert.match(await page.locator('.world-transfer-overlay').innerText(),/Player-/);
   if(mode==='http')await page.screenshot({path:'tests/artifacts/world-play-import-error.png',animations:'disabled'});
   assert.ok(await page.evaluate(async id=>(await WorldHandoff.create().get(id)).blob.size,bad));
   assert.equal(await page.evaluate(()=>GameApp.getState().saves.length),2);
   const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'下载 ZIP',exact:true}).click();assert.equal((await downloadPromise).suggestedFilename(),'错误世界.zip');
   // Repair a temporary test archive, then retry the same handoff ID.
   await page.evaluate(async id=>{const r=indexedDB.open('world-play-handoff');await new Promise((resolve,reject)=>{r.onsuccess=resolve;r.onerror=reject;});const db=r.result,tx=db.transaction('transfers','readwrite'),get=tx.objectStore('transfers').get(id);get.onsuccess=()=>{const rec=get.result;rec.blob=ZIP.makeZip([{name:'Player-pc/基础信息.json',text:'{"姓名":"重试成功"}'}]);tx.objectStore('transfers').put(rec);};await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=reject;});db.close();},bad);
   await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>!!GameApp.getState().active&&!document.querySelector('.world-transfer-overlay'));
   assert.equal(await page.evaluate(()=>GameApp.getState().saves.length),3);
   // Concurrent consumers must create only one save for a new ID.
   const concurrent=await page.evaluate(()=>WorldHandoff.create().put(ZIP.makeZip([{name:'Player-pc/基础信息.json',text:'{"姓名":"并发导入"}'}]),'并发世界'));
   const peers=await Promise.all([context.newPage(),context.newPage()]);
   for(const peer of peers)peer.on('pageerror',error=>errors.push(error.message));
   await Promise.all(peers.map(async peer=>{await peer.goto(new URL('index.html#handoff='+concurrent,designer).href);await peer.waitForFunction(()=>typeof GameApp!=='undefined'&&GameApp.getState().active&&!document.querySelector('.world-transfer-overlay'));}));
   assert.equal(await peers[0].evaluate(()=>GameApp.getState().saves.length),4);
   assert.equal(await peers[1].evaluate(()=>GameApp.getState().saves.length),4);
   await Promise.all(peers.map(peer=>peer.close()));
   // Crash boundary: the save committed, but the archive has not been cleaned up.
   const interrupted=await page.evaluate(async()=>{
    const id=await WorldHandoff.create().put(ZIP.makeZip([{name:'bad.txt',text:'must not be reimported'}]),'已提交世界');
    const store=GameStore.create();await store.open();const s=structuredClone(GameApp.getState().active);s.id=WorldHandoff.saveId(id);s.name='已提交世界';
    VFS.writeFile(s.tree,'/workspace/恢复标记.txt','已保存的进度');await store.putSave(s,{ifAbsent:true});return id;
   });
   await page.goto(new URL('index.html#handoff='+interrupted,designer).href);
   await page.waitForFunction(id=>GameApp.getState().active?.id==='world-handoff-'+id&&!document.querySelector('.world-transfer-overlay'),interrupted);
   assert.equal(await page.evaluate(()=>GameApp.readFile('/workspace/恢复标记.txt')),'已保存的进度');
   assert.equal(await page.evaluate(async id=>(await WorldHandoff.create().get(id)).status,interrupted),'complete');
   // Source quota failure preserves a downloadable archive, retry reuses that archive.
   await page.goto(designer);await ready();
   await page.evaluate(()=>{const original=WorldHandoff.create;let fails=true;WorldHandoff.create=(...args)=>{const bridge=original(...args),put=bridge.put;bridge.put=(...values)=>{if(fails){fails=false;throw new DOMException('测试：存储空间不足','QuotaExceededError');}return put(...values);};return bridge;};});
   await page.locator('#playWorldBtn').evaluate(button=>button.click());await page.locator('#forceWorldPlay').check();await page.locator('#worldPlayConfirm').getByRole('button',{name:'确认并前往'}).click();
   await page.getByRole('button',{name:'重试',exact:true}).waitFor();assert.match(await page.locator('.world-transfer-overlay').innerText(),/存储空间不足/);
   const sourceDownload=page.waitForEvent('download');await page.getByRole('button',{name:'下载 ZIP',exact:true}).click();assert.equal((await sourceDownload).suggestedFilename(),'试验世界.zip');
   await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForURL(/index\.html#handoff=/);
   await page.waitForFunction(()=>typeof GameApp!=='undefined'&&GameApp.getState().active&&!document.querySelector('.world-transfer-overlay'));
   assert.equal(await page.evaluate(()=>GameApp.getState().saves.length),6);
   // A receiver-side storage failure must not leave a half-created save.
   const targetFailure=await page.evaluate(async()=>{
    const id=await WorldHandoff.create().put(ZIP.makeZip([{name:'Player-pc/基础信息.json',text:'{"姓名":"写入重试"}'}]),'写入失败世界');
    const original=IDBObjectStore.prototype.put;let fail=true;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='saves'&&fail){fail=false;throw new DOMException('存档写入失败','QuotaExceededError');}return original.apply(this,args);};return id;
   });
   await page.goto(new URL('index.html#handoff='+targetFailure,designer).href);
   await page.getByRole('button',{name:'重试',exact:true}).waitFor();assert.match(await page.locator('.world-transfer-overlay').innerText(),/存档写入失败/);
   assert.equal(await page.evaluate(()=>GameApp.getState().saves.length),6);
   assert.equal(await page.evaluate(async id=>{const store=GameStore.create();await store.open();return !!await store.getSave(WorldHandoff.saveId(id));},targetFailure),false);
   assert.ok(await page.evaluate(async id=>(await WorldHandoff.create().get(id)).blob.size,targetFailure));
   await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(id=>GameApp.getState().active?.id==='world-handoff-'+id&&!document.querySelector('.world-transfer-overlay'),targetFailure);
   assert.equal(await page.evaluate(()=>GameApp.getState().saves.length),7);
   assert.deepEqual(errors,[]);console.log('PASS '+mode+': cancel, dirty editor, nested world, binary ZIP, progress, new save, refresh deduplication and retry');
   await context.close();
  }
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
