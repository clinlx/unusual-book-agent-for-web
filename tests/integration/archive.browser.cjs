'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const VFS = require('../../src/vfs');
const Core = require('../../src/game-core');
const Presentation = require('../../src/game-presentation');
let browser;
before(async () => { browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

for (const [name, status] of [
  ['canonical', { 状态: { HP: 9, MAXHP: 12, MP: 4, MAXMP: 8, SAN: 60 } }],
  ['aliases', { Status: { Health: 9, MaxHealth: 12, Mana: 4, MaxMana: 8, Sanity: 60 } }],
]) {
  test('offline replay displays ' + name + ' resources, safe data and mobile tabs without network access', async t => {
    const tree = VFS.createTree();
    VFS.writeFile(tree, '/workspace/Player-p/基础信息.json', JSON.stringify({ 姓名: '青', ...status, '.秘密': 'HIDDEN_CHARACTER' }));
    VFS.writeFile(tree, '/workspace/Player-p/背包.json', JSON.stringify([{ 名称: '钥匙', 剧情台本: 'HIDDEN_ITEM' }]));
    const save = Core.createSave('<script>window.injected=true</script>', tree);
    save.events = [
      { type: 'story', round: 1, content: '<img src=x onerror="window.injected=true">' },
      { type: 'dice', round: 1, secret: true, content: 'SECRET_DICE' },
      { type: 'round_end', round: 1 },
      { type: 'story', round: 2, content: '第二回合正文' },
      { type: 'round_end', round: 2 },
      { type: 'assistant', content: 'INTERNAL_MODEL' },
    ];
    VFS.writeFile(save.tree, '/workspace/过往回合历史记忆/Round_1_Time_测试/玩家结束状态.json',
      JSON.stringify(Core.player(save)));
    VFS.writeFile(tree, '/workspace/过往回合历史记忆/Round_1_Time_夜晚/玩家结束状态.json', JSON.stringify(Core.player(save)));
    const file = path.resolve(__dirname, '../artifacts/archive-' + name + '-' + randomUUID() + '.html');
    t.after(() => fs.rmSync(file, { force: true }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Presentation.historyHTML(save, undefined, Core.player(save)));
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    try {
      const page = await context.newPage(), errors = [], network = [];
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
      await page.route('https://**/*', route => route.abort());
      await page.goto(pathToFileURL(file).href);
      assert.equal(await page.locator('.history article.revealed').count(), 3, 'first round is revealed on entry');
      assert.doesNotMatch(await page.locator('.history').innerText(), /SECRET_DICE/);
      assert.match(await page.locator('.history').innerText(), /AI 进行了一次暗骰/);
      assert.doesNotMatch(await page.locator('.history').innerText(), /第二回合正文/);
      await page.locator('#archive-vitals .resource').first().waitFor();
      assert.equal(await page.locator('#archive-vitals .resource').count(), 3);
      assert.match(await page.locator('#archive-vitals').innerText(), /9 \/ 12/);
      assert.match(await page.locator('#archive-vitals').innerText(), /4 \/ 8/);
      assert.match(await page.locator('#archive-vitals').innerText(), /60 \/ 99/);
      await page.locator('#replay-next').click();
      assert.equal(await page.locator('.history article.revealed').count(), 4);
      await page.locator('#replay-next').click();
      await page.locator('[data-mode="overview"]').click();
      assert.match(await page.locator('#archive-vitals').innerText(), /9 \/ 12/);
      assert.match(await page.locator('#status-content').innerText(), /青/);
      assert.doesNotMatch(await page.locator('body').innerText(), /HIDDEN_CHARACTER|HIDDEN_ITEM|INTERNAL_MODEL/);
      assert.equal(await page.locator('img').count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      await page.setViewportSize({ width: 390, height: 844 });
      for (const tab of ['items', 'status', 'story']) {
        await page.locator('label[for="archive-tab-' + tab + '"]').click();
        assert.equal(await page.locator('#archive-' + tab).isVisible(), true);
      }
      await page.locator('[data-mode="replay"]').click();
      await page.locator('#replay-prev').click();
      assert.equal(await page.locator('.history article.revealed').count(), 4);
      assert.deepEqual(network, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('offline archive distinguishes private dice and actor actions without disclosing dark results',async t=>{
  const view={name:'私密骰子',actorId:'a',slots:[{id:'a',name:'青'},{id:'b',name:'秋'}],events:[
    {type:'player',round:1,actorId:'a',content:'自己的行动'},
    {type:'player',round:1,actorId:'b',content:'他人的行动'},
    {type:'dice',round:1,private:true,targetPlayer:'a',audience:['a'],content:'可见骰点：42'},
    {type:'dice',round:1,private:true,targetPlayer:'a',audience:['a'],secret:true,content:'SECRET_PRIVATE_DICE',data:{total:91}},
    {type:'dice',round:1,private:true,targetPlayer:'b',audience:['b'],content:'OTHER_PRIVATE_DICE'},
  ]};
  const html=Presentation.historyHTML(view),file=path.resolve(__dirname,'../artifacts/archive-private-'+randomUUID()+'.html');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,html);t.after(()=>fs.rmSync(file,{force:true}));
  assert.doesNotMatch(html,/SECRET_PRIVATE_DICE|OTHER_PRIVATE_DICE/);
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  try{
    await page.goto(pathToFileURL(file).href);
    assert.equal(await page.locator('.history article').count(),4);
    assert.match(await page.locator('.private-dice').first().innerText(),/私密检定.*可见骰点：42/s);
    assert.match(await page.locator('.secret-dice').innerText(),/私密暗骰.*AI 进行了一次暗骰/s);
    assert.match(await page.locator('.player-other header').innerText(),/秋的行动/);
    assert.equal(await page.locator('.private-dice').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(229, 220, 234)');
    assert.equal(await page.locator('.player-self').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(209, 231, 221)');
    assert.equal(await page.locator('.player-other').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(203, 217, 221)');
    await page.screenshot({path:path.resolve(__dirname,'../artifacts/archive-player-colors.png')});
  }finally{await page.close();}
});

test('replay continuation hint appears at the bottom, advances once and hides at the end', async t => {
  const tree=VFS.createTree();
  VFS.writeFile(tree,'/workspace/Player-p/基础信息.json','{"姓名":"青"}');
  VFS.writeFile(tree,'/workspace/Player-p/背包.json','[]');
  const save=Core.createSave('滚动提示',tree);
  save.events=[
    {type:'note',round:0,content:'入场记录'},
    {type:'story',round:1,content:'第一回合正文。\n\n'.repeat(100)},
    {type:'round_end',round:1},
    {type:'story',round:2,content:'第二回合正文。\n\n'.repeat(50)},
    {type:'round_end',round:2},
  ];
  const file=path.resolve(__dirname,'../artifacts/archive-hint-'+randomUUID()+'.html');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  t.after(()=>fs.rmSync(file,{force:true}));
  fs.writeFileSync(file,Presentation.historyHTML(save,undefined,Core.player(save)));
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  try{
    const page=await context.newPage();page.setDefaultTimeout(5000);
    await page.goto(pathToFileURL(file).href);
    const history=page.locator('#archive-history'),hint=page.locator('#replay-hint');
    assert.equal(await page.locator('article.revealed').count(),3,'entry includes notes and the entire first round');
    assert.equal(await hint.isHidden(),true,'hint stays hidden while reading above the bottom');
    await history.evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await hint.waitFor({state:'visible'});
    assert.equal(await hint.innerText(),'点击以继续演绎');
    await hint.click();
    assert.equal(await page.locator('article.revealed').count(),4,'one click advances one node');
    await page.locator('[data-mode="overview"]').click();
    assert.equal(await hint.isHidden(),true);
    await page.locator('[data-mode="replay"]').click();
    await page.locator('#replay-next').click();
    assert.equal(await page.locator('article.revealed').count(),5);
    assert.equal(await hint.isHidden(),true,'no continuation prompt after the final node');
  }finally{await context.close();}
});


test('export skin matches built gameplay and client, with offline branded icons and responsive panels',async t=>{
  const root=path.resolve(__dirname,'../..');
  const view={name:'雨夜车站',actorId:'p',slots:[{id:'p',name:'青'},{id:'q',name:'秋'}],events:[
    {type:'story',round:1,worldTime:'五月的夜晚',content:'雨水敲着车站的窗。站务员抬起灯，示意你们进屋。'},
    {type:'player',round:1,actorId:'p',content:'我去问问下一班车的时间。'},
    {type:'player',round:1,actorId:'q',content:'我留在门边等你。'},
    {type:'story',round:1,private:true,targetPlayer:'p',content:'你在站牌背面看到一行铅笔字。'},
    {type:'round_end',round:1},
    {type:'story',round:2,content:'灯光在雨里晃了一下。'},
  ]};
  const html=Presentation.historyHTML(view,undefined,{info:{姓名:'青',状态:{HP:9,MAXHP:12}},items:[{名称:'钥匙',数量:1}]});
  const file=path.join(root,'tests/artifacts/archive-style-'+randomUUID()+'.html');
  fs.writeFileSync(file,html);t.after(()=>fs.rmSync(file,{force:true}));
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  await context.route('**/modules.json',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await context.route('**/files/**',route=>route.abort());
  await context.route(/^https?:/,route=>route.abort());
  t.after(()=>context.close());
  context.setDefaultTimeout(5000);
  const archive=await context.newPage();await archive.goto(pathToFileURL(file).href);
  await archive.locator('[data-mode=overview]').click();
  const errors=[];archive.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
  const pick=(el,props)=>Object.fromEntries(props.map(prop=>[prop,getComputedStyle(el)[prop]]));
  const props=['backgroundColor','backgroundImage','color','fontFamily','fontSize','lineHeight','letterSpacing','borderLeftColor','borderLeftWidth','borderRadius'];
  const selectors=['body','.story-paper','.panel','.story:not(.private-story)','.player-self','.player-other','.story.private-story','.info-row','.change-tag.added'];
  // Inspect the compiled stylesheet, so build-time omissions cannot silently pass.
  const live=await context.newPage();
  for(const name of ['index','client']){
    const built=fs.readFileSync(path.join(root,'dist',name+'.html'),'utf8');
    const css=built.match(/<style>([\s\S]*?)<\/style>/)[1];
    await live.setContent('<style>'+css+'</style><div class="story-paper"></div><div class="panel"></div><article class="story"></article><article class="player-action player-self"></article><article class="player-action player-other"></article><article class="story private-story"></article><div class="info-row"></div><span class="change-tag added"></span>');
    await archive.evaluate(()=>{document.querySelector('#status-content').insertAdjacentHTML('beforeend','<span class="change-tag added">新增</span>')});
    for(const selector of selectors){
      const expected=await live.locator(selector).first().evaluate(pick,props);
      const actual=await archive.locator(selector).first().evaluate(pick,props);
      assert.deepEqual(actual,expected,name+' '+selector);
    }
    await live.goto(pathToFileURL(path.join(root,'dist',name+'.html')).href);
    const exported=await live.evaluate(v=>GamePresentation.historyHTML(v),view);
    assert.ok(exported.includes(fs.readFileSync(path.join(root,'assets/icons/game.svg'),'utf8')));
    assert.ok(exported.includes(css));
    const favicon=await live.locator('link[rel="icon"]').getAttribute('href');
    assert.equal(await archive.locator('link[rel="icon"]').getAttribute('href'),favicon);
  }
  assert.equal(await archive.locator('.archive-brand svg rect').count(),0,'no page-logo background');
  await archive.locator('#status-content>.change-tag').evaluateAll(nodes=>nodes.forEach(node=>node.remove()));
  await archive.screenshot({path:path.join(root,'tests/artifacts/archive-style-desktop.png')});
  for(const width of [1100,960,769,768,390,320]){
    await archive.setViewportSize({width,height:900});
    assert.equal(await archive.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow at '+width);
    const box=await archive.locator('#replay-next').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
    for(const selector of ['#archive-story','#archive-items','#archive-status'])assert.equal(await archive.locator(selector).isVisible(),width>768||selector==='#archive-story');
  }
  await archive.setViewportSize({width:390,height:844});
  await archive.screenshot({path:path.join(root,'tests/artifacts/archive-style-mobile.png')});
  assert.deepEqual(errors,[]);
});


test('built game, client and designer load local UI dependencies without CDN requests',async t=>{
  const context=await browser.newContext();context.setDefaultTimeout(5000);t.after(()=>context.close());
  await context.route('**/modules.json',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await context.route('**/files/**',route=>route.abort());
  await context.route(/^https?:/,route=>route.abort());
  for(const name of ['index','client','designer']){
    const page=await context.newPage(),network=[];
    page.on('request',request=>{if(/^https?:/.test(request.url()))network.push(request.url())});
    await page.goto(pathToFileURL(path.resolve(__dirname,'../../dist',name+'.html')).href);
    const external=await page.evaluate(()=>[...document.querySelectorAll('script[src],link[rel=stylesheet],link[rel=icon]')].map(el=>el.src||el.href).filter(url=>/^https?:/.test(url)));
    assert.deepEqual(external,[],name+' has no remote scripts, styles or icons');
    assert.deepEqual(network,[],name+' does not fetch remote startup dependencies');
    const styles=await page.locator('style').allTextContents();
    assert.ok(styles.every(css=>!/@import|url\(\s*["']?https?:/i.test(css)),name+' has no remote CSS assets or fonts');
    await page.close();
  }
});


test('archive centers mobile replay controls, collapses empty vitals and opens safe dice details',async t=>{
  const args={description:'推开木门',roller:'p',related_attr:'力量',is_secret:false,dice_dict:{力量:'2d6'},calculate_only:false,target_value:9,compare_mode:'le',critical_success_range:[2,2],critical_failure_range:[12,12],dice_combine_mode:'sum',left_modifiers:{伤势:1},right_modifiers:{环境:2}};
  const view={name:'雨夜车站',actorId:'p',events:[
    {type:'dice',round:1,...Core.dice(args,()=>.4),diceArgs:args},
    {type:'dice',round:1,private:true,targetPlayer:'p',...Core.dice({...args,dice_combine_mode:'independent',dice_dict:{甲:'2d6',乙:'2d6'}},()=>.5)},
    {type:'dice',round:1,secret:true,content:'SECRET_DETAIL_TEXT',diceArgs:{...args,description:'SECRET_DETAIL_ARGS'},data:{total:456789}},
    {type:'round_end',round:1},
    {type:'story',round:2,content:'门开了。'},
    {type:'round_end',round:2,roundState:{info:{状态:{HP:8,MAXHP:12}},items:[]}},
    {type:'story',round:3,content:'屋里传来脚步声。'},
  ]};
  const html=Presentation.historyHTML(view,undefined,{info:{状态:{HP:8,MAXHP:12}},items:[]});
  assert.doesNotMatch(html,/SECRET_DETAIL_TEXT|SECRET_DETAIL_ARGS|456789/);
  const file=path.resolve(__dirname,'../artifacts/archive-controls-'+randomUUID()+'.html');fs.writeFileSync(file,html);t.after(()=>fs.rmSync(file,{force:true}));
  const context=await browser.newContext({viewport:{width:390,height:844}});context.setDefaultTimeout(5000);t.after(()=>context.close());
  const page=await context.newPage(),requests=[],errors=[];page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url())});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(file).href);
  assert.equal(await page.locator('.archive-brand svg').isVisible(),true);
  assert.equal(await page.locator('#archive-vitals').isVisible(),false);
  const paper=await page.locator('#replay-surface').boundingBox(),column=await page.locator('#archive-story').boundingBox();assert.ok(Math.abs(paper.height-column.height)<1,'empty dock leaves no bottom gap');
  for(const width of [320,390,600,768]){
    await page.setViewportSize({width,height:844});
    const boxes=await Promise.all(['#replay-prev','#replay-progress','#replay-next'].map(sel=>page.locator(sel).boundingBox()));
    const [prev,progress,next]=boxes;
    assert.ok(Math.abs(prev.width-next.width)<1,'equal button widths at '+width);
    assert.ok(Math.abs(progress.x+progress.width/2-width/2)<1,'centered progress at '+width);
    assert.ok(Math.abs((progress.x-prev.x-prev.width)-(next.x-progress.x-progress.width))<1,'symmetric spacing at '+width);
    assert.equal(await page.locator('.archive-github').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  assert.equal(await page.locator('.archive-github').getAttribute('href'),'https://github.com/clinlx/unusual-book-agent-for-web');
  await page.setViewportSize({width:390,height:844});
  const card=page.locator('[data-dice-detail]').first(),count=await page.locator('article.revealed').count();
  assert.equal(await card.locator('.dice-roll-chip').count(),1);assert.equal(await card.locator('.dice-target').count(),1);assert.equal(await card.locator('.dice-face').count(),2);
  assert.match(await card.innerText(),/推开木门/);assert.match(await card.innerText(),/通过/);
  assert.equal(await page.locator('[data-dice-detail]').nth(1).locator('.dice-outcome').count(),2,'independent checks show individual outcomes');
  assert.equal(await page.locator('.secret-dice[data-dice-detail]').count(),0);
  await card.click({delay:3050});await page.locator('#dice-details').waitFor({state:'visible'});
  assert.match(await page.locator('#dice-details-content').innerText(),/伤势/);assert.match(await page.locator('#dice-details-content').innerText(),/critical_success_range/);
  assert.equal(await page.locator('article.revealed').count(),count,'opening dice does not advance replay');
  await page.screenshot({path:path.resolve(__dirname,'../artifacts/archive-dice-details-mobile.png')});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#dice-details').isVisible(),false);assert.equal(await card.evaluate(el=>el===document.activeElement),true);
  await card.press('Enter',{delay:3050});assert.equal(await page.locator('#dice-details').isVisible(),true);await page.locator('#dice-details footer button').click();
  await page.screenshot({path:path.resolve(__dirname,'../artifacts/archive-dice-cards-mobile.png')});
  await page.locator('#replay-next').click();await page.locator('#replay-next').click();assert.equal(await page.locator('#archive-vitals').isVisible(),true,'state change restores vitals');
  await page.locator('#replay-prev').click();assert.equal(await page.locator('#archive-vitals').isVisible(),false,'rewind collapses unavailable vitals');
  await page.locator('[data-mode=overview]').click();assert.equal(await page.locator('#archive-vitals').isVisible(),true);
  assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
});


test('replay dice require a three-second stationary hold; taps advance and scrolling cancels on touch screens',async t=>{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});t.after(()=>context.close());const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=Presentation.historyHTML({name:'手势测试',events:[{type:'dice',round:1,content:'检定记录'},{type:'story',round:2,content:'下一节点'},{type:'story',round:3,content:'末尾节点'}]});
 await page.setContent(html);await page.clock.install();const card=page.locator('[data-dice-detail]'),dialog=page.locator('#dice-details');
 await page.clock.pauseAt(new Date());
 await card.tap();assert.equal(await dialog.isVisible(),false);assert.equal(await page.locator('#replay-jump').inputValue(),'2');
 const cdp=await context.newCDPSession(page),box=await card.boundingBox(),point={x:Math.round(box.x+30),y:Math.round(box.y+30)};
 const touch=type=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[point]});
 await touch('touchStart');await page.clock.runFor(2999);assert.equal(await dialog.isVisible(),false);await page.clock.runFor(1);assert.equal(await dialog.isVisible(),true);await touch('touchEnd');
 assert.equal(await page.locator('#replay-jump').inputValue(),'2');await page.keyboard.press('Escape');
 const down=()=>card.dispatchEvent('pointerdown',{pointerId:9,pointerType:'touch',isPrimary:true,button:0,clientX:point.x,clientY:point.y});
 for(const cancel of [()=>card.dispatchEvent('pointermove',{pointerId:9,clientX:point.x,clientY:point.y+18}),()=>page.locator('#archive-history').dispatchEvent('scroll'),()=>card.dispatchEvent('pointercancel',{pointerId:9}),()=>page.evaluate(()=>window.dispatchEvent(new Event('blur'))),()=>card.dispatchEvent('pointerdown',{pointerId:10,pointerType:'touch',isPrimary:false,button:0})]){
  await down();await page.clock.runFor(2000);await cancel();await page.clock.runFor(4000);assert.equal(await dialog.isVisible(),false);await card.dispatchEvent('pointerup',{pointerId:9,button:0,clientX:point.x,clientY:point.y});assert.equal(await page.locator('#replay-jump').inputValue(),'2');
 }
 await page.locator('[data-mode="overview"]').click();await card.tap();assert.equal(await dialog.isVisible(),true,'overview tap');
 await page.keyboard.press('Escape');await card.press('Enter');assert.equal(await dialog.isVisible(),true,'overview keyboard');await page.keyboard.press('Escape');await page.locator('[data-mode="replay"]').click();
 // Verify actual touch scrolling remains native and never opens details.
 await page.evaluate(()=>{document.querySelector('[data-dice-detail]').style.height='1100px';});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y+100}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y-30}]});await page.clock.runFor(4000);await touch('touchEnd');
 assert.equal(await dialog.isVisible(),false);assert.ok(await page.locator('#archive-history').evaluate(el=>el.scrollTop)>0);assert.deepEqual(errors,[]);

});
