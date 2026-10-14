'use strict';
const GamePresentation=(()=>{
  const D=typeof module!=='undefined'&&module.exports?require('./game-data'):GameData;
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function vitals(info){
    const groups=['状态','衍生属性','属性'].map(k=>D.get(info,k)).concat(info);
    const number=(k,sources=groups)=>{for(const g of sources){const v=D.get(g,k);if(v===undefined)continue;if(typeof v!=='number'&&(typeof v!=='string'||!v.trim()))return null;const n=Number(v);return Number.isFinite(n)?n:null;}return undefined;};
    const read=(key,maxKey,fallback,sources)=>{const value=number(key),specified=number(maxKey,sources),max=specified===undefined?fallback:specified;return value==null||max==null||value<0||max<=0?null:{value,max,ratio:Math.min(1,value/max)};};
    return {hp:read('HP','MAXHP'),mp:read('MP','MAXMP'),san:read('SAN','MAXSAN',99,[groups[0]])};
  }
  function secondary(selected,old,next){const changed=['mp','san'].filter(k=>next[k]&&old[k]&&next[k].value!==old[k].value);if(changed.length===1)selected=changed[0];return next[selected]?selected:next.mp?'mp':'san';}
  const label=x=>D.get(x,['名字','名称','姓名','Name','ID','UUID','Title']);
  function numeric(x){return typeof x==='number'?x:typeof x==='string'&&/^[+-]?\d+(?:\.\d+)?\s*[%a-zA-Z\u4e00-\u9fff]*$/.test(x.trim())?parseFloat(x):null;}
  function diff(before,after,name='',key='root'){
    const deleted=after===undefined,value=deleted?before:after;
    let status=before===undefined?'added':deleted?'deleted':JSON.stringify(before)===JSON.stringify(after)?'same':'modified';
    if(status==='modified'&&numeric(before)!==null&&numeric(after)!==null&&numeric(after)<numeric(before))status='decreased';
    const result={label:name,key,value,status,oldValue:before};
    if(value&&typeof value==='object'){
      if(Array.isArray(value)){
        const old=Array.isArray(before)?before:[],next=Array.isArray(after)?after:[];
        // Match by a shared stable identity, including duplicate names in encounter order.
        const identity=['id','ID','uuid','UUID','名称','name','Name','Title','title'].find(k=>old.length&&next.length&&old.concat(next).every(x=>x&&typeof x==='object'&&x[k]!==undefined));
        if(identity){const remaining=old.map((v,i)=>({v,i})),counts=new Map();result.children=next.map((v,i)=>{const id=String(v[identity]),occ=counts.get(id)||0;counts.set(id,occ+1);const j=remaining.findIndex(x=>String(x.v[identity])===id),prev=j<0?undefined:remaining.splice(j,1)[0].v;return diff(prev,v,String(label(v)??i),key+'/'+id+':'+occ);});for(const {v,i}of remaining)result.children.push(diff(v,undefined,String(label(v)??i),key+'/deleted:'+i));}
        else result.children=Array.from({length:Math.max(old.length,next.length)},(_,i)=>diff(old[i],next[i],String(label(next[i]??old[i])??i),key+'/'+i));
      }else{const old=before&&typeof before==='object'&&!Array.isArray(before)?before:{},next=after&&typeof after==='object'&&!Array.isArray(after)?after:{};result.children=[...new Set([...Object.keys(next),...Object.keys(old)])].map(k=>diff(old[k],next[k],k,key+'/'+k));}
      if(result.children.every(x=>x.status==='same')&&status==='modified')result.status='same';
    }return result;
  }
  function fields(value,before=value,key='info'){
    const tag=status=>{const text={added:'新增',deleted:'移除',modified:'修改',increased:'增加',decreased:'减少'}[status];return text?`<span class="change-tag ${status}">${text}</span>`:'';};
    function render(d){if(d.value===null||d.value===undefined||d.value===''||d.label.startsWith('.'))return '';const cls=d.status==='same'?'':' diff-'+d.status;
      const kind=x=>x===null?'null':Array.isArray(x)?'array':typeof x;
      if(d.oldValue!==undefined&&d.status!=='deleted'&&kind(d.oldValue)!==kind(d.value)&&(kind(d.oldValue)==='object'||kind(d.value)==='object'||kind(d.oldValue)==='array'||kind(d.value)==='array'))return `<div class="info-replaced"><small>原资料</small>${render(diff(d.oldValue,undefined,d.label,d.key+'/old'))}<small>新资料</small>${render(diff(undefined,d.value,d.label,d.key+'/new'))}</div>`;
      if(d.children){const content=d.children.map(render).join('');if(!content)return '';if(d.key===key)return content;return `<details class="info-group${cls}" data-key="${esc(d.key)}" data-change="${esc(d.status==='same'?'':JSON.stringify(d.value))}" open><summary>${esc(d.label)}${Array.isArray(d.value)?' ['+d.value.length+']':''}${tag(d.status)}</summary>${content}</details>`;}
      const old=d.status==='modified'||d.status==='decreased'?`<del>${esc(d.oldValue)}</del> → `:'';
      return `<div class="info-row${cls}" data-key="${esc(d.key)}"><span>${esc(d.label)}</span><strong>${old}${esc(d.value)}${tag(d.status)}</strong></div>`;
    }return render(diff(before,value,'',key));
  }
  function createReader(reader){const cache=new WeakMap();const read=s=>{try{const value=reader(s);cache.set(s,structuredClone(value));return {...value,stale:false};}catch(e){return {...structuredClone(cache.get(s)||{}),stale:true,error:e.message||String(e)};}};read.clear=s=>cache.delete(s);return read;}
  function realTime(at){return at&&Number.isFinite(new Date(at).getTime())?new Date(at).toLocaleString():'';}
  function metadata(e){const parts=[];if(e.round!=null)parts.push('第 '+e.round+' 回合');if(e.worldTime)parts.push(e.worldTime);if(e.at&&Number.isFinite(new Date(e.at).getTime()))parts.push(new Date(e.at).toLocaleString());return parts.join(' · ');}
  function names(save){
    const map=new Map();for(const n of Object.values(D.node(save,'/workspace')?.children||{})){if(n.type!=='dir'||! /^(Player|AIPC|KPC)-/.test(n.name))continue;try{const name=D.get(D.read(save,n.name+'/基础信息.json'),'姓名');if(typeof name==='string'){map.set(n.name,name);map.set(n.name.replace(/^(Player|AIPC|KPC)-/,''),name);}}catch(_){} }
    return id=>map.get(String(id))||id;
  }
  function eventContent(save,e){let text=String(e.content||'');if(!save?.tree)return text;const resolve=names(save),roller=e.data?.roller||e.roller; if(roller&&resolve(roller)!==roller){if(text.startsWith(roller))text=resolve(roller)+text.slice(String(roller).length);}return text.replace(/\b(?:Player|KPC)-[^\s:：·，。;；()[\]<>]+/g,id=>resolve(id));}
  function hasPlayHistory(save){
    return Number(save?.round)>0 || (save?.events||[]).some(event =>
      ['dice','round_end'].includes(event.type) || ['story','player'].includes(event.type) && String(event.content||'').trim());
  }
  function exportName(save,at=Date.now()){return String(save.name||'故事')+'-故事-'+new Date(at).toISOString().replace(/[:.]/g,'-')+'.html';}
  function historyHTML(save,renderStory=text=>'<p class="plain">'+esc(text)+'</p>',projection={}){
    // The standalone archive carries the same skin and SVG as the live pages.
    const local=typeof module!=='undefined'&&module.exports?require('../scripts/build-common'):null;
    const icon=typeof BUNDLED_GAME_ICON!=='undefined'?BUNDLED_GAME_ICON:local.read('assets/icons/game.svg');
    const favicon=typeof BUNDLED_GAME_FAVICON!=='undefined'?BUNDLED_GAME_FAVICON:local.svgDataUri('assets/icons/game.svg',{framed:true});
    const skin=typeof BUNDLED_GAME_STYLES!=='undefined'?BUNDLED_GAME_STYLES:local.read('src/game.css');
    const safeJSON=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
    const resourceHTML=info=>{
      const resources=vitals(info);
      const bars=['hp','mp','san'].map(key=>{
        const v=resources[key];if(!v)return '';
        return `<div class="resource ${key}"><span class="resource-label">${key.toUpperCase()} · ${v.value} / ${v.max}</span><span class="track" role="progressbar" aria-label="${key.toUpperCase()}" aria-valuemin="0" aria-valuemax="${v.max}" aria-valuenow="${Math.max(0,Math.min(v.value,v.max))}"><i style="width:${v.ratio*100}%"></i></span></div>`;
      }).join('');
      return bars?'<div class="resource-strips">'+bars+'</div>':'';
    };
    const isPrivate=e=>e.private===true||Array.isArray(e.audience);
    const isDark=e=>e.type==='dice'&&!!(e.secret||e.diceArgs?.is_secret||e.relatedAttr==='心理学'||e.diceArgs?.related_attr==='心理学');
    const events=(save.events||[]).filter(e=>{
      if(!['player','story','round_end','dice','note'].includes(e.type))return false;
      if(e.audience!==undefined&&e.audience!=='public'&&!(Array.isArray(e.audience)&&save.actorId&&e.audience.includes(save.actorId)))return false;
      if(isPrivate(e)&&e.targetPlayer&&e.targetPlayer!==save.actorId)return false;
      if(isPrivate(e)&&save.tree&&!Array.isArray(e.audience)&&!e.targetPlayer)return false;
      if(e.type==='dice'){
        const roller=e.rollerId||e.diceArgs?.roller||e.data?.roller||e.roller;
        if(e.rollerKind==='gm'||roller==='<|GM|>')return false;
        if(!isPrivate(e)&&(e.playerRelated===false||['ai','kpc','npc'].includes(e.rollerKind)))return false;
      }else if(e.secret&&!isPrivate(e))return false;
      return !(e.type==='player'&&e.actorId!==save.actorId&&!String(e.content||'').trim()&&e.privateContent&&!e.skip);
    });
    const actorName=e=>e.name||(save.slots||[]).find(s=>s.id===e.actorId)?.name||names(save)(e.actorId)||'玩家';
    const eventHTML=e=>{
      if(e.type==='round_end')return `<article class="round_end round-end" data-round="${esc(e.round)}"><header>回合结束 · ${esc(metadata(e))}</header></article>`;
      const own=!e.actorId||e.actorId===save.actorId,privateEvent=isPrivate(e),dark=isDark(e);
      const title=e.type==='player'?(own?'你的行动':actorName(e)+'的行动'):e.type==='dice'?((privateEvent?'私密':'')+(dark?'暗骰':'检定')):e.type==='note'?'注释':privateEvent?'私密故事':'故事';
      const cls=e.type+(dark?' secret-dice':'')+(privateEvent?(e.type==='dice'?' private-dice':' private-story'):'')+(e.type==='player'?(own?' player-self':' player-other')+(e.privateContent?' player-event':' player-action'):'');
      const headerClass=e.type==='story'?' class="story-meta"':'';
      const text=dark?'[AI 进行了一次暗骰]':eventContent(save,e);
      let content=e.type==='story'?renderStory(text):'<p class="plain">'+esc(text)+'</p>';
      if(e.type==='player'&&save.actorId&&e.actorId===save.actorId&&e.privateContent)content+='<section class="private-story"><small>私密行动</small><p class="plain">'+esc(e.privateContent)+'</p></section>';
      return `<article class="${cls}" data-round="${esc(e.round)}"><header${headerClass}>${esc(title)} · ${esc(metadata(e))}</header>${content}</article>`;
    };
    const nodes=events.map((e,i)=>({index:i,round:Number(e.round)||0,type:e.type,secret:!!e.secret,html:eventHTML(e)}));

    const roundStates={};
    const historyRoot=D.node(save,'过往回合历史记忆');
    for(const dir of Object.values(historyRoot?.children||{})){
      if(dir?.type!=='dir')continue;
      const m=String(dir.name||'').match(/^Round_(\d+)_Time_/);if(!m)continue;
      const file=dir.children?.['玩家结束状态.json'];if(!file||file.type!=='file'||file.encoding==='base64')continue;
      try{
        const state=JSON.parse(String(file.content||'').replace(/^\uFEFF/,''));
        if(state&&typeof state==='object'){
          const slots=save.slots||(Object.values(D.node(save,'/workspace')?.children||{}).filter(n=>n.type==='dir'&&/^Player-/.test(n.name)));
          const own=state.actors?.[save.actorId]||(state.actorId===save.actorId&&save.actorId||!state.actorId&&slots.length===1?state:null);
          if(!own)continue;
          const info=D.visible(own.info||{});
          roundStates[Number(m[1])]={info,items:D.visible(own.items||[],true),vitals:resourceHTML(info)};
        }
      }catch(_){}
    }

    for(const event of events){
      if(event.type!=='round_end'||!event.roundState||!Number.isSafeInteger(event.round))continue;
      const info=D.visible(event.roundState.info||{});
      roundStates[event.round]={info,items:D.visible(event.roundState.items||[],true),vitals:resourceHTML(info)};
    }
    const finalState={info:D.visible(projection.info||{}),items:D.visible(projection.items||[],true)};
    finalState.vitals=resourceHTML(finalState.info);
    const stateHTML=(current,previous={info:{},items:[]})=>({
      info:fields(current?.info||{},previous?.info||{},'info')||'<p>暂无资料</p>',
      items:fields(current?.items||[],previous?.items||[],'items')||'<p>暂无物品</p>'
    });
    const replayStates={};
    let prior={info:{},items:[]};
    for(const round of Object.keys(roundStates).map(Number).sort((a,b)=>a-b)){
      const current=roundStates[round],changed=stateHTML(current,prior),clean=stateHTML(current,current);
      replayStates[round]={infoDiff:changed.info,itemsDiff:changed.items,infoClean:clean.info,itemsClean:clean.items,raw:current};
      prior=current;
    }
    const finalHTML=stateHTML(finalState,finalState),finalDiff=stateHTML(finalState,prior);
    const body=nodes.map(n=>n.html).join('');
    const tabs=[['items','行囊'],['story','故事'],['status','人物']];

    const layout=`<main class="archive replay-mode" id="archive"><header class="archive-header"><div class="archive-brand"><span class="brand-seal">${icon}</span><div class="archive-title"><small>异闻手记 · 故事存档</small><h1>${esc(save.name||'故事存档')}</h1></div></div><div class="replay-toolbar" id="replay-toolbar"><button type="button" id="replay-prev" disabled>← 上一步</button><span id="replay-progress"><input id="replay-jump" type="text" inputmode="numeric" pattern="[0-9]*" value="0" aria-label="当前节点" style="width:${Math.max(2,String(nodes.length).length+1)}ch"> / <b>${nodes.length}</b></span><button type="button" id="replay-next">${nodes.length?'下一节点 →':'暂无节点'}</button></div><div class="archive-head-actions"><div class="archive-mode-switch" role="group" aria-label="查看模式"><button type="button" data-mode="replay" aria-pressed="true">演绎模式</button><button type="button" data-mode="overview" aria-pressed="false">总览模式</button></div><span>离线卷宗 · ${esc(new Date().toLocaleString())}</span></div></header>${tabs.map(([id,name])=>`<input class="native-control tab-control" type="radio" name="archive-tab" id="archive-tab-${id}" aria-label="${name}" ${id==='story'?'checked':''}>`).join('')}<aside id="archive-items" class="card panel side-panel"><h2 class="panel-title"><span>I. 随身物品</span></h2><div class="panel-content panel-scroll" id="items-content"><p>暂无物品</p></div></aside><section id="archive-story" class="story-column"><div class="card story-paper" id="replay-surface"><h2 class="panel-title story-heading"><span><small>II.</small> 故事卷宗</span><small>CHRONICLE</small></h2><div class="history" id="archive-history">${body||'<p>暂无故事记录</p>'}<button type="button" id="replay-hint" class="replay-hint" aria-hidden="true">点击以继续演绎</button></div></div><div class="resource-dock" id="archive-vitals"></div></section><aside id="archive-status" class="card panel side-panel"><h2 class="panel-title"><span>III. 人物档案</span></h2><div class="panel-content panel-scroll" id="status-content"><p>暂无资料</p></div></aside><nav class="archive-nav" aria-label="卷宗页面">${tabs.map(([id,name])=>`<label for="archive-tab-${id}">${name}</label>`).join('')}</nav></main>`;

    // Only archive layout and playback controls live here; colors, paper, text,
    // player/private bubbles, fields and change tags come from the gameplay skin.
    const styles=`
.archive{height:100vh;height:100dvh;max-width:1920px;margin:auto;padding:24px 28px 22px;display:grid;grid-template-columns:245px minmax(0,1fr) 245px;grid-template-rows:auto minmax(0,1fr);gap:18px}
.archive-header{grid-column:1/-1;display:grid;grid-template-columns:minmax(180px,1fr) auto minmax(240px,1fr);align-items:center;gap:16px;color:#e4d8be;border-bottom:1px solid #b79b6230;padding-bottom:18px}
.archive-brand{display:flex;gap:12px;align-items:center;min-width:0}.archive-title{min-width:0}.archive-title small{font:11px/1.8 var(--sans);color:#b1a58b;letter-spacing:.08em}.archive-title h1{font:20px/1.4 var(--serif);margin:0;overflow-wrap:anywhere}
.archive-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:14px}.archive-head-actions>span{font-size:11px;color:#aaa38e}.archive-mode-switch{display:flex;gap:4px}
.archive-mode-switch button,.replay-toolbar button{height:34px;padding:0 12px;border-color:#b79b6255;color:#c7b995;font:12px/32px var(--sans);white-space:nowrap}.archive-mode-switch button[aria-pressed=true]{background:var(--gold);color:#25281f}
.card,.story-column{min-width:0;min-height:0}.panel-content,.history{overflow-wrap:anywhere;scrollbar-width:thin;scrollbar-color:#aa9570 transparent}.story-column{display:flex;flex-direction:column;gap:14px}.story-paper .history{padding-top:6px}.history article{overflow-wrap:anywhere}.history .plain{white-space:pre-wrap}.history .player .plain:last-child{margin-bottom:0}.history .round-end header{margin:0;line-height:1.7}.history .private-story>small{color:#70519c}.history .note{font-size:14px}
.replay-toolbar{display:flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}.replay-toolbar span{min-width:60px;text-align:center;font:11px/1 var(--sans);color:#c6b58f}.replay-toolbar input{padding:1px 2px;border:0;border-bottom:1px solid transparent;background:transparent;color:inherit;text-align:right;font:inherit;font-variant-numeric:tabular-nums;outline:none}.replay-toolbar input:hover,.replay-toolbar input:focus{border-bottom-color:var(--gold)}.replay-toolbar b{font:inherit}.replay-toolbar button{height:30px;line-height:28px;padding:0 10px}
.replay-mode #replay-surface{cursor:pointer}.replay-mode #replay-surface :is(button,a,input,select,textarea,summary){cursor:auto}.replay-mode .history article{display:none}.replay-mode .history article.revealed{display:block}.replay-mode .history article.round-end.revealed,.overview-mode .history article.round-end{display:flex}.replay-mode .history article.replay-enter{animation:replayIn .38s ease-out both}.overview-mode .replay-toolbar{visibility:hidden;pointer-events:none}.overview-mode .history article{display:block}.panel-content.state-enter{animation:stateIn .5s ease-out}
.resource-dock{position:relative;flex-shrink:0;color:#c6bea8;min-height:14px}.resource-strips{display:flex;gap:20px}.resource{flex:1;min-width:0;display:flex;align-items:center;gap:6px}.resource-label{font:10px/14px Arial,sans-serif;white-space:nowrap}.track{height:5px;flex:1;min-width:12px;position:relative;border:1px solid #b8837966;background:#392a27;border-radius:3px;overflow:hidden}.track i{display:block;height:100%;background:#bd7770;transition:width .45s ease}.mp .track i{background:#70a4bd}.san .track i{background:#a58abd}
.native-control{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden;white-space:nowrap}.archive-nav{display:none}
@keyframes replayIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}@keyframes stateIn{0%{opacity:.6;transform:translateY(4px)}100%{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.replay-mode .history article.replay-enter,.panel-content.state-enter{animation:none}.track i{transition:none}}
@media(min-width:1280px){.archive{grid-template-columns:306px minmax(0,1fr) 306px}}
@media(min-width:769px) and (max-width:1100px){.archive{padding:18px;gap:12px;grid-template-columns:190px minmax(0,1fr) 190px}.archive-header{grid-template-columns:minmax(150px,1fr) auto auto}.archive-head-actions>span{display:none}.replay-toolbar button{padding:0 7px}}
@media(max-width:768px){.archive{padding:12px 10px 0;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;gap:10px}.archive-header{padding-bottom:8px;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"title actions" "replay replay";gap:7px 10px}.archive-brand{grid-area:title;gap:6px}.archive-title h1{font-size:15px}.archive-title small{font-size:9px}.archive-brand .brand-seal{width:28px;height:28px;flex-basis:28px}.replay-toolbar{grid-area:replay;justify-content:flex-end}.archive-head-actions{grid-area:actions}.archive-head-actions>span{display:none}.archive-mode-switch button{height:30px;line-height:28px;padding:0 6px;font-size:10px}.side-panel,.story-column{display:none;grid-column:1;grid-row:2}#archive-tab-items:checked~#archive-items,#archive-tab-story:checked~#archive-story,#archive-tab-status:checked~#archive-status{display:flex}.archive-nav{grid-column:1;grid-row:3;display:flex;padding-bottom:max(8px,env(safe-area-inset-bottom));color:#a9a590}.archive-nav label{width:33.33%;text-align:center;cursor:pointer;padding:10px;font-size:12px}#archive-tab-items:checked~.archive-nav label[for=archive-tab-items],#archive-tab-story:checked~.archive-nav label[for=archive-tab-story],#archive-tab-status:checked~.archive-nav label[for=archive-tab-status]{color:#e2c58b;background:#b79b6214;box-shadow:inset 0 2px var(--gold)}.resource-strips{flex-wrap:wrap;gap:6px 12px}.resource{min-width:40%}}
.replay-hint{display:block;width:100%;min-height:30px;margin:12px 0 4px;padding:4px;border:0;background:transparent;color:var(--muted);font:11px/1.8 var(--serif);letter-spacing:.08em;visibility:hidden;cursor:pointer}.replay-mode .replay-hint.is-visible{visibility:visible}.overview-mode .replay-hint{display:none}
@media print{html,body{height:auto;overflow:visible}body{background:white}.archive{height:auto;display:block;padding:0}.archive-header{color:var(--ink)}.archive-mode-switch,.replay-toolbar,.replay-hint{display:none!important}.card,.story-column{display:block!important;overflow:visible;margin:12px 0}.panel-content,.history{overflow:visible}.archive-nav,.resource-dock{display:none!important}.history article{display:block!important}article{break-inside:avoid}}
`;

    const script=`(()=>{'use strict';
const archive=document.getElementById('archive'),history=document.getElementById('archive-history'),articles=[...history.querySelectorAll('article')],next=document.getElementById('replay-next'),prev=document.getElementById('replay-prev'),progress=document.getElementById('replay-progress'),jump=document.getElementById('replay-jump'),items=document.getElementById('items-content'),status=document.getElementById('status-content'),vitals=document.getElementById('archive-vitals');
const nodes=${safeJSON(nodes.map(({round,type,secret})=>({round,type,secret})))},states=${safeJSON(replayStates)},finalState=${safeJSON(finalState)},finalHTML=${safeJSON(finalHTML)},finalDiff=${safeJSON(finalDiff)};const firstRound=nodes.find(node=>node.round>0)?.round??nodes[0]?.round;let index=nodes.findIndex(node=>node.round>0&&node.round!==firstRound);if(index<0)index=nodes.length;
const hint=document.getElementById('replay-hint');
function updateHint(){const visible=archive.classList.contains('replay-mode')&&index<nodes.length&&history.clientHeight>0&&history.scrollHeight-history.scrollTop-history.clientHeight<=6;hint.classList.toggle('is-visible',visible);hint.setAttribute('aria-hidden',String(!visible));}
function setPanels(html,raw,animate){items.innerHTML=html.items;status.innerHTML=html.info;vitals.innerHTML=raw.vitals||'';if(animate){for(const el of [items,status]){el.classList.remove('state-enter');void el.offsetWidth;el.classList.add('state-enter');}}}
function stateAt(i){let found=null,changed=false;for(let n=0;n<i;n++){const node=nodes[n],s=node&&states[node.round];if(node?.type==='round_end'&&s){found=s;changed=n===i-1;}}if(i>=nodes.length)return {info:finalDiff.info,items:finalDiff.items,raw:finalState};if(!found)return {info:'<p>暂无资料</p>',items:'<p>暂无物品</p>',raw:{info:{},items:[]}};return {info:changed?found.infoDiff:found.infoClean,items:changed?found.itemsDiff:found.itemsClean,raw:found.raw};}
function render(animate=true){archive.classList.add('replay-mode');archive.classList.remove('overview-mode');articles.forEach((a,i)=>{a.classList.toggle('revealed',i<index);a.classList.remove('replay-enter')});if(animate&&index>0){const a=articles[index-1];if(a){a.classList.add('replay-enter');a.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}const s=stateAt(index);setPanels({info:s.info,items:s.items},s.raw,animate);jump.value=String(index);prev.disabled=index<=0;next.disabled=index>=nodes.length;next.textContent=!nodes.length?'暂无节点':index>=nodes.length?'已到结局':'下一节点 →';requestAnimationFrame(updateHint);}
function overview(){archive.classList.remove('replay-mode');archive.classList.add('overview-mode');articles.forEach(a=>a.classList.remove('replay-enter'));setPanels(finalHTML,finalState,false);updateHint();}
document.querySelectorAll('[data-mode]').forEach(btn=>btn.addEventListener('click',()=>{const replay=btn.dataset.mode==='replay';document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));if(replay)render(false);else overview();}));
const advance=()=>{if(index<nodes.length){index++;render(true);}};
next.addEventListener('click',advance);
hint.addEventListener('click',advance);
history.addEventListener('scroll',updateHint,{passive:true});
window.addEventListener('resize',updateHint);
if(typeof ResizeObserver==='function')new ResizeObserver(updateHint).observe(history);
prev.addEventListener('click',()=>{if(index>0){index--;render(false);}});
const commitJump=()=>{const raw=jump.value.trim();if(!/^\\d+$/.test(raw)){jump.value=String(index);return;}const target=Number(raw);if(!Number.isInteger(target)||target<0||target>nodes.length){jump.value=String(index);return;}if(target!==index){index=target;render(false);const a=articles[Math.max(0,index-1)];a?.scrollIntoView({block:'nearest',behavior:'auto'});}};
jump.addEventListener('focus',()=>jump.select());
jump.addEventListener('blur',commitJump);
jump.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();jump.blur();}else if(e.key==='Escape'){e.preventDefault();jump.value=String(index);jump.blur();}});
const surface=document.getElementById('replay-surface');let press=null;
const interactive=el=>el?.closest?.('button,a,input,select,textarea,summary,label');
surface.addEventListener('pointerdown',e=>{if(e.button!==0||interactive(e.target))return;press={id:e.pointerId,x:e.clientX,y:e.clientY,at:performance.now(),moved:false};});
surface.addEventListener('pointermove',e=>{if(!press||press.id!==e.pointerId)return;if(Math.hypot(e.clientX-press.x,e.clientY-press.y)>8)press.moved=true;});
surface.addEventListener('pointercancel',()=>{press=null;});
surface.addEventListener('pointerup',e=>{if(!press||press.id!==e.pointerId)return;const p=press;press=null;if(p.moved||performance.now()-p.at>450||interactive(e.target)||String(getSelection?.()||'').trim())return;if(archive.classList.contains('replay-mode'))advance();});
render(false);
})();`;

    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'"><title>'+esc(save.name)+' · 故事存档</title><link rel="icon" type="image/svg+xml" href="'+esc(favicon)+'"><style>'+skin+'\n'+styles+'</style></head><body>'+layout+'<script>'+script.replaceAll('</script','<\\/script')+'</script></body></html>';
  }
  return {vitals,secondary,diff,fields,createReader,metadata,realTime,historyHTML,eventContent,hasPlayHistory,exportName};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GamePresentation;
