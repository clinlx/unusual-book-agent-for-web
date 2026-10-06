'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const dist=path.resolve(__dirname,'../../dist');
(async()=>{
  const server=http.createServer((req,res)=>{
    const file=path.resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));
    if(!file.startsWith(dist+path.sep))return res.writeHead(404).end();
    fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'text/plain');res.end(data);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
    const context=await browser.newContext();await context.route('https://**/*',route=>route.abort());
    for(const kind of ['game','designer']){
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto('http://127.0.0.1:'+server.address().port+'/'+(kind==='game'?'index.html':'designer.html'));
      await page.waitForFunction(kind==='game'?'typeof GameCore !== "undefined"':'typeof Agent !== "undefined"');
      const result=await page.evaluate(kind=>{
        const tree=VFS.createTree();VFS.writeFile(tree,'/workspace/Player-pc/基础信息.json','{"姓名":"林青","状态":{"Alive":true,"Enabled":true}}');VFS.writeFile(tree,'/workspace/Player-pc/背包.json','[]');
        let save,ctx,id=0;
        if(kind==='game'){save=GameCore.createSave('browser guard',tree);GameCore.beginRound(save,'',true);}
        else ctx={tree,skills:[],config:AGENT_CONFIG,readState:new Map()};
        const current=()=>save?save.tree:ctx.tree;
        function call(name,args){if(save){const r=GameCore.execute(save,name,args,'call-'+(++id));return {ok:r.ok,error:r.error||''};}const r=Agent.executeTool(ctx,name,args);return {ok:!r.result.startsWith('错误:'),error:r.result};}
        const checks=[];
        for(const [path,content] of [['/workspace/deep/invalid.json','{broken'],['/workspace/Player-pc/背包.json','["key","key"]'],['/workspace/Player-pc/基础信息.json','{"姓名":"林青","年龄":"20（旧值35）"}']]){
          if(VFS.resolve(current(),VFS.normalize(path)))call('read_file',{path});
          const before=JSON.stringify(current()),r=call('write_file',{path,content});checks.push({ok:r.ok,unchanged:JSON.stringify(current())===before,error:r.error});
        }
        VFS.writeFile(current(),'/workspace/source/deep/场景物品列表.json','["key","key"]');
        const before=JSON.stringify(current()),r=call('copy',{from:'/workspace/source',to:'/workspace/copy-target'});checks.push({ok:r.ok,unchanged:JSON.stringify(current())===before,error:r.error});
        const good=call('write_file',{path:'/workspace/good.json',content:'{"value":1}'});
        return {checks,good};
      },kind);
      assert.ok(result.checks.every(x=>!x.ok&&x.unchanged),JSON.stringify(result));assert.equal(result.good.ok,true);assert.deepEqual(errors,[]);
      console.log(kind+': bundled tool guards reject all 4 invalid writes/copies atomically and accept valid JSON');await page.close();
    }
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
