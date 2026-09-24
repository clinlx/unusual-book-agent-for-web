'use strict';
const GameUI = (() => {
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const json = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '';
  const markdown = text => typeof MD !== 'undefined' ? MD.render(String(text || '')).replace(/<img\b[^>]*>/gi, '') : '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  function visibleEvents(events, mode) {
    if(typeof GameCore!=='undefined'&&state?.active&&events===state.active.events)return GameCore.visibleEvents(state.active,mode);
    return (events||[]).filter(e=>mode==='debug'||e.type==='dice'?e.playerRelated!==false:!e.secret&&['player','story','round_end','note'].includes(e.type));
  }
  function requestProgress(s){
    const r=s.active?.activeRound||{},n=Math.max(0,Number(r.requestCount)||0),m=Number(r.requestLimit??s.settings?.maxToolLoops)||60;
    const base=n<=20?n*3:m>20?60+Math.min(1,(n-20)/(m-20))*10:60;
    return String(Math.floor(Math.min(100,base+(r.published>0?30:0)))).padStart(3,' ')+'%';
  }
  function runPhase(s){
    if(!s.running||!s.active?.activeRound)return '';
    const round=s.active.activeRound;
    if(round.complete)return '本轮已完成';
    if(round.published>0)return '主持人正在收尾和处理变更';
    const called=s.stream?.tools?.length||s.active.messages?.some(m=>m.round===round.number&&m.tool_calls?.length)||s.active.events?.some(e=>e.round===round.number&&e.type==='tool');
    return called?'正在思考':'正在请求';
  }
  
  
  function patchDOM(parent,desired){
    const key=n=>n.nodeType===1?(n.getAttribute('data-key')||n.id||''):'';
    const compatible=(a,b)=>a&&a.nodeType===b.nodeType&&(a.nodeType!==1||a.tagName===b.tagName)&&key(a)===key(b);
    let cursor=parent.firstChild;
    for(const fresh of [...desired.childNodes]){
      let node=cursor;
      if(key(fresh)&&!compatible(node,fresh))node=[...parent.childNodes].find(n=>compatible(n,fresh));
      if(!compatible(node,fresh)){node=fresh.cloneNode(true);parent.insertBefore(node,cursor);}
      else{
        if(node!==cursor)parent.insertBefore(node,cursor);
        if(node.nodeType===3){if(node.nodeValue!==fresh.nodeValue)node.nodeValue=fresh.nodeValue;}
        else if(node.nodeType===1){
          const retainOpen=node.tagName==='DETAILS';
          const changed=retainOpen&&fresh.getAttribute('data-change')&&node.getAttribute('data-change')!==fresh.getAttribute('data-change');
          for(const attr of [...node.attributes])if(!(retainOpen&&attr.name==='open')&&!fresh.hasAttribute(attr.name))node.removeAttribute(attr.name);
          for(const attr of [...fresh.attributes])if(!(retainOpen&&attr.name==='open')&&node.getAttribute(attr.name)!==attr.value)node.setAttribute(attr.name,attr.value);
          if(node.tagName==='TEXTAREA'){
            if((node.id==='action-input'||node!==document.activeElement)&&node.value!==fresh.value)node.value=fresh.value;
          }else if(!node.hasAttribute('data-live-vitals'))patchDOM(node,fresh);
          if(changed)node.open=true;
        }
      }
      cursor=node.nextSibling;
    }
    while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
  }
  function continuationHTML(s) {
    return !s.running && s.active?.status==='interrupted' && s.active.activeRound && !s.active.activeRound.complete
      ? '<div class="round-continuation"><p>本轮尚未结束</p><button type="button" data-action="resume" class="primary">继续本轮</button></div>' : '';
  }
  const DICE_COMPARE={gt:'>',ge:'≥',lt:'<',le:'≤',eq:'=',ne:'≠'};
  const diceFormulaShort=formula=>{
    const text=String(formula||'').trim(),m=text.match(/^(-?)1d(\d+)$/i);
    return m?(m[1]?'−':'')+'d'+m[2]:text;
  };
  const signedModifier=value=>value?(value>0?'+':'−')+Math.abs(value):'';
  const safeDiceLabel=value=>{
    const text=String(value||'').trim();
    if(!text||text.length>16||/[\r\n。！？!?：:；;]/.test(text))return '';
    return text;
  };
  function diceRollChip(row,result,{aggregate=false,showModifier=true}={}){
    const label=safeDiceLabel(row?.label);
    const formula=aggregate?'合计':diceFormulaShort(row?.formula||'掷骰');
    const raw=Number.isFinite(result?.raw)?result.raw:Number.isFinite(row?.total)?row.total:result?.total;
    const total=Number.isFinite(result?.total)?result.total:raw;
    const left=showModifier?(Number(result?.left)||0):0;
    return `<span class="dice-roll-chip">${label?`<span class="dice-roll-label">${esc(label)}</span>`:''}<small>${esc(formula)}</small><span class="dice-equals">=</span><strong>${esc(raw)}</strong>${left?`<em class="dice-modifier">${esc(signedModifier(left))} → ${esc(total)}</em>`:''}</span>`;
  }
  function diceTarget(result){
    const target=Number(result?.target),right=Number(result?.right)||0;
    if(!Number.isFinite(target))return '';
    const base=target-right;
    return `<span class="dice-target" title="目标值"><strong>${esc(base)}</strong>${right?`<em class="dice-modifier">${esc(signedModifier(right))} → ${esc(target)}</em>`:''}</span>`;
  }
  function diceOutcome(result){
    if(result?.special&&result.critical){
      const failure=String(result.critical).includes('失败');
      return `<span class="dice-outcome ${failure?'critical-fail':'critical-success'}">${esc(String(result.critical).replace(/^可能是/,''))} <b aria-hidden="true">${failure?'☠':'✦'}</b></span>`;
    }
    if(result?.success==null)return '<span class="dice-outcome calculated">仅计算 <b aria-hidden="true">∑</b></span>';
    return `<span class="dice-outcome ${result.success?'success':'fail'}">${result.success?'通过':'不通过'} <b aria-hidden="true">${result.success?'✓':'×'}</b></span>`;
  }
  function diceCompareTail(result){
    const special=result?.special&&result.critical;
    const compare=DICE_COMPARE[result?.compare_mode],hasTarget=!special&&result?.success!=null&&Number.isFinite(result?.target)&&compare;
    return `${hasTarget?`<span class="dice-compare" title="比较方式">${esc(compare)}</span>${diceTarget(result)}`:''}${diceOutcome(result)}`;
  }
  function diceModeBadge(mode){
    return mode==='max'?'<span class="dice-mode max">取大 MAX</span>':
      mode==='min'?'<span class="dice-mode min">取小 MIN</span>':
      mode==='independent'?'<span class="dice-mode independent">并行 EACH</span>':
      mode==='sum'?'<span class="dice-mode sum">合计 SUM</span>':'';
  }
  function diceFaces(rows){
    const faces=[];
    for(const row of rows||[]){
      const m=String(row.formula||'').match(/^(-?)(\d+)d(\d+)$/i);
      if(!m||!Array.isArray(row.rolls)||row.rolls.length<2)continue;
      const badge=(m[1]?'−':'')+'d'+m[3],label=safeDiceLabel(row.label);
      for(const value of row.rolls)faces.push(`<span class="dice-face">${label?`<i>${esc(label)}</i>`:''}<strong>${esc(value)}</strong><small>[${esc(badge)}]</small></span>`);
    }
    return faces.length?`<div class="dice-face-line" aria-label="原始骰面">${faces.join('')}</div>`:'';
  }
  function pendingDiceRows(args={}){
    return Object.entries(args.dice_dict||{}).map(([label,formula])=>({label,formula:String(formula),rolls:[],total:null}));
  }
  function pendingRollChip(row,args,{aggregate=false}={}){
    const label=safeDiceLabel(row?.label),formula=aggregate?'结算':diceFormulaShort(row?.formula||'掷骰');
    const left=Number(Object.values(args.left_modifiers||{}).reduce((n,v)=>n+(Number(v)||0),0))||0;
    return `<span class="dice-roll-chip pending">${label?`<span class="dice-roll-label">${esc(label)}</span>`:''}<small>${esc(formula)}</small><span class="dice-equals">=</span><strong>?</strong>${left?`<em class="dice-modifier">${esc(signedModifier(left))} → ?</em>`:''}</span>`;
  }
  function pendingTarget(args){
    if(args.calculate_only||!Number.isFinite(Number(args.target_value)))return '';
    const base=Number(args.target_value),right=Number(Object.values(args.right_modifiers||{}).reduce((n,v)=>n+(Number(v)||0),0))||0;
    return `<span class="dice-target"><strong>${esc(base)}</strong>${right?`<em class="dice-modifier">${esc(signedModifier(right))} → ${esc(base+right)}</em>`:''}</span>`;
  }
  function pendingDiceHTML(e){
    const a=e.diceArgs||{},rows=pendingDiceRows(a),name=String(a.related_attr||e.relatedAttr||'检定').trim()||'检定',mode=a.dice_combine_mode||'sum';
    let checks='';
    if(mode==='independent'&&rows.length){
      checks=`<div class="dice-check-head"><span class="dice-check-name">(${esc(name)})</span>${diceModeBadge('independent')}</div>`+
        rows.map(r=>`<div class="dice-check-line dice-independent-row">${pendingRollChip(r,a)}${a.calculate_only?'':`<span class="dice-compare">${esc(DICE_COMPARE[a.compare_mode]||'?')}</span>${pendingTarget(a)}`}<span class="dice-outcome pending">待定 <b>…</b></span></div>`).join('');
    }else{
      checks=`<div class="dice-check-line"><span class="dice-check-name">(${esc(name)})</span>${rows.length>1?diceModeBadge(mode):''}${rows.length>1?pendingRollChip(null,a,{aggregate:true}):pendingRollChip(rows[0],a)}${a.calculate_only?'':`<span class="dice-compare">${esc(DICE_COMPARE[a.compare_mode]||'?')}</span>${pendingTarget(a)}`}<span class="dice-outcome pending">待定 <b>…</b></span></div>`;
      if(rows.length>1)checks+=`<div class="dice-components">${rows.map(r=>pendingRollChip(r,{},{})).join('')}</div>`;
    }
    return `<article class="dice dice-clickable dice-pending" data-action="dice-detail" data-event-id="${esc(e.id)}" role="button" tabindex="0"><header><span>⚄ 检定</span><small>等待玩家掷骰</small></header><div class="dice-checks">${checks}</div></article>`;
  }
  function diceHTML(e,mode,details,meta){
    if(e.pending)return pendingDiceHTML(e);
    const d=e.data||{},rows=Array.isArray(d.rows)?d.rows:[],name=String(e.relatedAttr||e.data?.related_attr||'检定').trim()||'检定';
    let checks='';
    if(d.mode==='independent'&&rows.length){
      checks=`<div class="dice-check-head"><span class="dice-check-name">(${esc(name)})</span>${diceModeBadge('independent')}</div>`+
        rows.map(r=>`<div class="dice-check-line dice-independent-row">${diceRollChip(r,r,{showModifier:true})}${diceCompareTail(r)}</div>`).join('');
    }else if(rows.length>1){
      const components=`<div class="dice-components">${rows.map(r=>diceRollChip(r,r,{showModifier:false})).join('')}</div>`;
      checks=`<div class="dice-check-line"><span class="dice-check-name">(${esc(name)})</span>${diceModeBadge(d.mode)}${diceRollChip(null,d,{aggregate:true,showModifier:true})}${diceCompareTail(d)}</div>${components}`;
    }else{
      checks=`<div class="dice-check-line"><span class="dice-check-name">(${esc(name)})</span>${diceRollChip(rows[0],d,{showModifier:true})}${diceCompareTail(d)}</div>`;
    }
    const roller=e.roller||d.roller||'',debug=mode==='debug'?`${e.content?details('原始检定文本',e.content):''}${details('骰子数据',d||e)}`:'';
    return `<article class="dice dice-clickable" data-action="dice-detail" data-event-id="${esc(e.id)}" role="button" tabindex="0"><header title="${esc(meta)}"><span>⚄ ${e.secret?'暗骰':'检定'}</span>${roller?`<small>${esc(roller)}</small>`:''}${mode==='debug'&&meta?`<small class="event-meta">${esc(meta)}</small>`:''}</header><div class="dice-checks">${checks}</div>${diceFaces(rows)}${debug}</article>`;
  }
  function eventHTML(e, mode) {
    const meta=typeof GamePresentation!=='undefined'?GamePresentation.metadata(e):'',content=typeof GamePresentation!=='undefined'&&typeof state!=='undefined'&&state?.active?GamePresentation.eventContent(state.active,e):e.content;
    if(e.type==='assistant'&&!String(e.content||'').trim()&&!String(e.reasoning||'').trim())return '';
    const details = (title, value) => `<details data-key="${esc('event:'+e.id+':'+title)}"><summary>${esc(title)}</summary><pre>${esc(json(value))}</pre></details>`;
    if (e.type === 'round_end') return `<div class="round-end"><span>回合结束：${esc(typeof GamePresentation!=='undefined'?GamePresentation.realTime(e.at):'')}</span></div>`;
    if (e.type === 'story') return `<article class="story"><header class="story-meta">${esc(typeof GamePresentation!=='undefined'?GamePresentation.metadata(e):'第 '+e.round+' 回合')}</header>${markdown(e.content)}</article>`;
    if (e.type === 'player') return `<article class="player-action"><header>${e.skip?'空过':'你'}${mode === 'debug' ? ' · player_action' : ''}<small class="event-meta">${esc(meta)}</small></header><div>${esc(content).replace(/\n/g,'<br>')}</div></article>`;
    if (e.type === 'note')return `<article class="story note"><header>注释 <small class="event-meta">${esc(meta)}</small></header>${markdown(content)}</article>`;
    if (e.type === 'dice'&&e.secret&&mode!=='debug') return '<div class="secret-dice-notice" role="status"><span aria-hidden="true">⚄</span> [主持人进行了一次暗骰]</div>';
    if (e.type === 'dice') return diceHTML(e,mode,details,meta);
    if (e.type === 'tool') return `<article class="tool-event"><header><span class="tool-mark">ƒ</span> ${esc(e.name)} <small>${e.success === false ? '失败' : '工具调用'}</small></header>${details('参数',e.args)}${details('结果',e.result)}${e.fileChanges?.length?details('文件修改记录',e.fileChanges):''}</article>`;
    if (e.type === 'assistant') return `<article class="assistant-event"><header>模型回复</header>${e.reasoning ? details('模型返回的思考',e.reasoning) : ''}${markdown(e.content)}</article>`;
    return `<article class="error-event"><header>${esc(e.type)}</header><pre>${esc(json(e.content || e))}</pre></article>`;
  }
  let state, root, modalRoot, draft = '', filePath = '', fileDraft = '', fileOriginal = '', mobile = 'center', toastTimer, renderTimer, draftTimer, pointerHeld=false;
  let viewSave=null,previousVitals={},secondaryVital='mp',renderedSecondary=null,vitalsCollapsed=false,scrollAmount=0,lastScroll=0,lastScrollAt=0,navTimer,forceHistoryBottom=false;
  function refreshInput(){const input=document.getElementById('action-input');if(!input)return;input.style.height='auto';const full=input.scrollHeight,fold=full>innerHeight*.25&&document.activeElement!==input;input.classList.toggle('is-folded',fold);input.style.height=(fold?72:Math.min(full,innerHeight*.6))+'px';input.style.overflowY=fold||full>innerHeight*.6?'auto':'hidden';const count=document.getElementById('action-count');if(count)count.textContent=input.value.length+' 字';}
  function updateVitals(info){
    const dock=document.getElementById('vital-dock');if(!dock)return;
    const next=GamePresentation.vitals(info),oldSelection=renderedSecondary;secondaryVital=GamePresentation.secondary(secondaryVital,previousVitals,next);
    dock.hidden=!next.hp&&!next.mp&&!next.san;
    if(!dock.firstChild)dock.innerHTML='<button type="button" data-action="toggle-vitals" class="vital-toggle"></button><div class="vital-bars"><div id="vital-hp" class="vital-resource"><span class="vital-name">HP 生命</span><div class="vital-track" role="progressbar"><i class="vital-trail"></i><i class="vital-fill"></i></div><span class="vital-label"></span></div><button type="button" data-action="toggle-secondary" id="vital-secondary" class="vital-resource"><span class="vital-name"></span><div class="vital-track" role="progressbar"><i class="vital-trail"></i><i class="vital-fill"></i></div><span class="vital-label"></span></button></div>';
    dock.classList.toggle('is-collapsed',vitalsCollapsed);const toggle=dock.querySelector('.vital-toggle');toggle.innerHTML='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 4 3 3 3-3"/></svg>';toggle.setAttribute('aria-label',vitalsCollapsed?'显示资源条':'隐藏资源条');toggle.title=vitalsCollapsed?'显示资源条':'隐藏资源条';toggle.setAttribute('aria-expanded',String(!vitalsCollapsed));
    for(const [id,key]of [['vital-hp','hp'],['vital-secondary',secondaryVital]]){
      const el=document.getElementById(id),v=next[key],old=previousVitals[key];el.hidden=!v;if(!v)continue;
      const title={hp:'HP 生命',mp:'MP 魔法',san:'SAN 理智'}[key];el.querySelector('.vital-name').textContent=title;el.classList.toggle('san',key==='san');
      if(id==='vital-secondary'){el.title='点击切换 MP / SAN';el.setAttribute('aria-label',title+'，点击切换资源条');el.disabled=!(next.mp&&next.san);}
      const track=el.querySelector('.vital-track');for(const [k,value]of Object.entries({'aria-label':title,'aria-valuemin':0,'aria-valuemax':v.max,'aria-valuenow':Math.min(v.value,v.max),'aria-valuetext':v.value+' / '+v.max}))track.setAttribute(k,value);
      const fills=el.querySelectorAll('.vital-fill,.vital-trail');if(!old||id==='vital-secondary'&&oldSelection!==secondaryVital){el.classList.add('is-new');fills.forEach(n=>n.style.width=((old||v).ratio*100)+'%');void el.offsetWidth;el.classList.remove('is-new');el.querySelectorAll('.vital-delta').forEach(n=>n.remove());}
      fills.forEach(n=>n.style.width=v.ratio*100+'%');el.querySelector('.vital-label').textContent=v.value+' / '+v.max;
      if(!vitalsCollapsed&&old&&old.value!==v.value){const delta=Number((v.value-old.value).toPrecision(12)),n=document.createElement('span');n.className='vital-delta '+(delta<0?'loss':'gain');n.textContent=(delta>0?'+':'')+delta;n.setAttribute('aria-hidden','true');el.append(n);setTimeout(()=>n.remove(),1200);}
    }previousVitals=next;renderedSecondary=secondaryVital;
  }
  function revealNavigation(){const nav=document.getElementById('history-navigation');if(!nav)return;nav.classList.remove('dismissed');nav.classList.add('active');clearTimeout(navTimer);navTimer=setTimeout(()=>{if(!nav.matches(':hover,:focus-within'))nav.classList.remove('active');},3000);}
  function navigateHistory(direction){const h=document.getElementById('history');if(!h)return;let top=direction==='top'?0:h.scrollHeight;if(['prev','next'].includes(direction)){const offsets=[...h.querySelectorAll('.story')].map(n=>n.getBoundingClientRect().top-h.getBoundingClientRect().top+h.scrollTop-10);top=direction==='prev'?offsets.filter(n=>n<h.scrollTop-10).at(-1)??0:offsets.find(n=>n>h.scrollTop+10)??h.scrollHeight;}h.scrollTo({top,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});revealNavigation();}
  function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  const button = (action,label,extra='') => `<button type="button" data-action="${action}" ${extra}>${label}</button>`;
  const brandDiceIcon=()=>`<svg class="brand-die" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path class="brand-die-body" d="M24 3.5 43 14.2v19.6L24 44.5 5 33.8V14.2Z"/><path class="brand-die-edge" d="M24 3.5v20.2M5 14.2l19 9.5 19-9.5M24 23.7v20.8"/><circle cx="15.4" cy="17.2" r="2.15"/><circle cx="32.8" cy="15.8" r="2.15"/><circle cx="35.1" cy="29.4" r="2.15"/><circle cx="28.5" cy="35.8" r="2.15"/><circle cx="14.1" cy="29.7" r="2.15"/></svg>`;
  const gearIcon=()=>`<svg class="settings-gear" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><polygon class="gear-teeth" points="32,4 38,10 46,7 49,15 58,16 56,25 62,31 56,38 58,47 49,49 46,57 38,54 32,61 26,54 18,57 15,49 6,47 8,38 2,31 8,25 6,16 15,15 18,7 26,10"/><circle class="gear-ring" cx="32" cy="32" r="12"/><circle class="gear-hub" cx="32" cy="32" r="4.5"/></svg>`;
  let fileSelection='',fileClipboard=null,fileMenuNode=null,preview=false;
  const fileNode=p=>VFS.resolve(state.active.tree,VFS.normalize(p));
  const parentPath=p=>p.slice(0,p.lastIndexOf('/'))||'/workspace';
  function selectFile(p){fileSelection=p;root.querySelectorAll('.file-tree [data-path]').forEach(n=>n.classList.toggle('selected',n.dataset.path===p));}
  function closeFileMenu(){fileMenuNode?.remove();fileMenuNode=null;}
  async function fileCommand(cmd,p=fileSelection||'/workspace'){
    closeFileMenu();if(state.mode!=='debug')return;
    const n=fileNode(p),dir=n?.type==='dir'?p:parentPath(p);
    if(cmd==='open'){if(n?.type==='file')return action('open-file',{dataset:{path:p}});const row=[...root.querySelectorAll('.file-tree summary')].find(x=>x.dataset.path===p);if(row)row.parentElement.open=!row.parentElement.open;return;}
    if(cmd==='copy'||cmd==='cut'){fileClipboard={path:p,cut:cmd==='cut',saveId:state.active.id};return toast(cmd==='cut'?'已剪切':'已复制');}
    if(cmd==='path'||cmd==='name'){const text=cmd==='path'?p:n?.name||p;try{await navigator.clipboard.writeText(text);}catch(_){const ta=document.createElement('textarea');ta.value=text;document.body.append(ta);ta.select();document.execCommand('copy');ta.remove();}return;}
    if(cmd==='help')return showModal('调试模式快捷键','<p>文件列表：↑↓ 选择，←→ 展开/收起，Enter 打开，Backspace 选择上级，F2 重命名，Delete 删除，Ctrl/⌘+C/X/V 复制/剪切/粘贴，Ctrl/⌘+A 全部展开，Shift+F10 菜单。</p><p>编辑器：Ctrl/⌘+S 保存，Ctrl/⌘+P 预览，Tab/Shift+Tab 缩进，Ctrl/⌘+D 复制行，Alt+↑↓ 移动行，Esc 关闭。文本复制、剪切、撤销使用浏览器原生行为。</p>');
    if(cmd==='properties')return showModal('属性',`<dl><dt>路径</dt><dd>${esc(p)}</dd><dt>类型</dt><dd>${n?.type==='dir'?'目录':'文件'}</dd><dt>大小</dt><dd>${n?.type==='file'?VFS.fileBytes(n).length+' 字节':Object.keys(n?.children||{}).length+' 项'}</dd></dl>`);
    if(cmd==='expand'||cmd==='collapse'){root.querySelectorAll('.file-tree details').forEach(d=>{if(d.querySelector('summary')?.dataset.path.startsWith(p))d.open=cmd==='expand';});return;}
    if(cmd==='download'){if(n?.type==='file')return download(new Blob([VFS.fileBytes(n)]),n.name);const entries=[];const walk=(node,path)=>{if(node.type==='file')entries.push({name:path,bytes:VFS.fileBytes(node)});else{entries.push({name:path+'/',bytes:new Uint8Array()});Object.values(node.children).forEach(c=>walk(c,path+'/'+c.name));}};walk(n,n.name);return download(ZIP.makeZip(entries),n.name+'.zip');}
    if(state.running)throw Error('请先停止当前回合');
    if(fileDraft!==fileOriginal&&['rename','delete','paste'].includes(cmd))throw Error('请先保存或关闭当前文件的未保存改动');
    if(cmd==='new'||cmd==='folder'){const name=await appPrompt(cmd==='new'?'新文件名称':'新目录名称',cmd==='new'?'新文件.md':'新目录',{label:'名称'});if(!name)return;if(/[\\/]/.test(name)||['.','..'].includes(name))throw Error('请输入名称，不包含路径');const target=dir+'/'+name;await GameApp.fileOperation(cmd==='new'?'create':'mkdir',{path:target,content:''});selectFile(target);if(cmd==='new')await action('open-file',{dataset:{path:target}});return;}
    if(cmd==='rename'){const name=await appPrompt('重命名',n.name,{label:'新名称'});if(!name||name===n.name)return;if(/[\\/]/.test(name)||['.','..'].includes(name))throw Error('名称不能包含路径');const to=parentPath(p)+'/'+name;await GameApp.fileOperation('move',{from:p,to});if(filePath===p||filePath.startsWith(p+'/'))filePath=to+filePath.slice(p.length);selectFile(to);render();return;}
    if(cmd==='delete'){if(!await appConfirm('删除 '+p+' 及其内容？',{title:'删除文件',confirmLabel:'删除',danger:true}))return;await GameApp.fileOperation('delete',{path:p});if(filePath===p||filePath.startsWith(p+'/')){filePath='';fileDraft=fileOriginal='';}selectFile(parentPath(p));render();return;}
    if(cmd==='paste'){const cb=fileClipboard;if(!cb||cb.saveId!==state.active.id)return;const source=fileNode(cb.path);if(!source)throw Error('来源已不存在');if(source.type==='dir'&&(dir===cb.path||dir.startsWith(cb.path+'/')))throw Error('不能粘贴到自身目录中');let to=dir+'/'+source.name;if(cb.cut&&to===cb.path)return;let i=1;while(fileNode(to)){const m=source.name.match(/^(.*?)(\.[^.]*)?$/);to=dir+'/'+m[1]+' - 副本 '+i++ +(m[2]||'');}await GameApp.fileOperation(cb.cut?'move':'copy',{from:cb.path,to});if(cb.cut){if(filePath===cb.path||filePath.startsWith(cb.path+'/'))filePath=to+filePath.slice(cb.path.length);fileClipboard=null;}selectFile(to);render();}
  }
  function fileMenu(p,x,y){closeFileMenu();selectFile(p);const n=fileNode(p);const items=[['open',n?.type==='dir'?'展开 / 收起':'打开','Enter'],['new','新建文件',''],['folder','新建目录',''],['expand','全部展开','Ctrl+A'],['collapse','全部收起',''],['rename','重命名','F2'],['copy','复制','Ctrl+C'],['cut','剪切','Ctrl+X'],['paste','粘贴','Ctrl+V'],['path','复制路径',''],['name','复制名称',''],['download','下载',''],['properties','属性',''],['help','快捷键',''],['delete','删除','Delete']];
    fileMenuNode=document.createElement('div');fileMenuNode.className='file-context-menu';fileMenuNode.setAttribute('role','menu');
    for(const [cmd,label,key]of items){const b=document.createElement('button');b.type='button';b.setAttribute('role','menuitem');b.dataset.command=cmd;b.innerHTML=esc(label)+'<small>'+key+'</small>';b.disabled=(state.running&&['new','folder','rename','cut','paste','delete'].includes(cmd))||(['rename','cut','delete'].includes(cmd)&&[state.active.playerPath,'/workspace'].includes(p))||(cmd==='paste'&&(!fileClipboard||fileClipboard.saveId!==state.active.id));b.onclick=()=>attempt(()=>fileCommand(cmd,p));fileMenuNode.append(b);}
    document.body.append(fileMenuNode);fileMenuNode.style.left=Math.max(4,Math.min(x,innerWidth-fileMenuNode.offsetWidth-4))+'px';fileMenuNode.style.top=Math.max(4,Math.min(y,innerHeight-fileMenuNode.offsetHeight-4))+'px';fileMenuNode.querySelector('button:not(:disabled)')?.focus();
  }
  function editorInsert(ta,text){ta.focus();if(!document.execCommand('insertText',false,text)){ta.setRangeText(text,ta.selectionStart,ta.selectionEnd,'end');ta.dispatchEvent(new Event('input',{bubbles:true}));}fileDraft=ta.value;document.getElementById('file-dirty').textContent='有未保存改动';}
  function debugKey(e){if(state?.mode!=='debug'||e.isComposing)return;const mod=e.ctrlKey||e.metaKey,k=e.key.toLowerCase(),ta=e.target;
    if(fileMenuNode){if(e.key==='Escape'){e.preventDefault();closeFileMenu();return;}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const xs=[...fileMenuNode.querySelectorAll('button:not(:disabled)')],i=xs.indexOf(document.activeElement);xs[(i+(e.key==='ArrowDown'?1:xs.length-1))%xs.length].focus();return;}}
    if(mod&&k==='s'&&(ta.id==='file-editor'||ta.closest('#file-preview'))){e.preventDefault();attempt(()=>action('save-file'));return;}
    if(mod&&k==='p'&&(ta.id==='file-editor'||ta.closest('#file-preview'))){e.preventDefault();preview=!preview;render();return;}
    if(ta.id==='file-editor'&&!state.running){const v=ta.value,start=v.lastIndexOf('\n',ta.selectionStart-1)+1,endIndex=v.indexOf('\n',ta.selectionEnd),end=endIndex<0?v.length:endIndex;
      if(e.key==='Escape'){e.preventDefault();attempt(()=>action('close-file'));return;}
      if(e.key==='Tab'){e.preventDefault();if(!e.shiftKey&&!v.slice(ta.selectionStart,ta.selectionEnd).includes('\n'))editorInsert(ta,'  ');else{const text=v.slice(start,end).split('\n').map(l=>e.shiftKey?l.replace(/^ {1,2}/,''):'  '+l).join('\n');ta.setSelectionRange(start,end);editorInsert(ta,text);ta.setSelectionRange(start,start+text.length);}return;}
      if(mod&&k==='d'){e.preventDefault();ta.setSelectionRange(end,end);editorInsert(ta,'\n'+v.slice(start,end));return;}
      if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();if(e.key==='ArrowUp'&&start>0){const prev=v.lastIndexOf('\n',start-2)+1;ta.setSelectionRange(prev,end);editorInsert(ta,v.slice(start,end)+'\n'+v.slice(prev,start-1));ta.setSelectionRange(prev,prev+end-start);}else if(e.key==='ArrowDown'&&end<v.length){let next=v.indexOf('\n',end+1);if(next<0)next=v.length;ta.setSelectionRange(start,next);editorInsert(ta,v.slice(end+1,next)+'\n'+v.slice(start,end));ta.setSelectionRange(next-end+start,next);}return;}}
    if(!ta.closest('.file-tree')||ta.closest('input,textarea,select'))return;
    const rows=[...root.querySelectorAll('.file-tree [data-path]')].filter(n=>n.getClientRects().length),i=rows.findIndex(n=>n.dataset.path===fileSelection);
    if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const row=rows[Math.max(0,Math.min(rows.length-1,i+(e.key==='ArrowDown'?1:-1)))];if(row){selectFile(row.dataset.path);row.focus();}return;}
    const commands={F2:'rename',Delete:'delete',Enter:'open'};let cmd=commands[e.key];if(mod)cmd={c:'copy',x:'cut',v:'paste',a:'expand'}[k];if(cmd){e.preventDefault();attempt(()=>fileCommand(cmd));return;}
    if(e.key==='F10'&&e.shiftKey){e.preventDefault();const r=ta.getBoundingClientRect();fileMenu(fileSelection||'/workspace',r.left,r.bottom);return;}
    if(['ArrowLeft','ArrowRight','Backspace'].includes(e.key)){e.preventDefault();const row=rows.find(n=>n.dataset.path===fileSelection);if(row?.tagName==='SUMMARY'&&e.key!=='Backspace')row.parentElement.open=e.key==='ArrowRight';else{selectFile(parentPath(fileSelection));rows.find(n=>n.dataset.path===fileSelection)?.focus();}}
  }
  function toast(message) { let el=document.getElementById('toast'); el.textContent=message; el.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.hidden=true,4500); }
  let dialogRoot=null,dialogResolve=null,dialogPreviousFocus=null;
  function finishAppDialog(value){
    const done=dialogResolve;dialogResolve=null;
    if(dialogRoot)dialogRoot.innerHTML='';
    const previous=dialogPreviousFocus;dialogPreviousFocus=null;
    if(previous?.isConnected)previous.focus();
    done?.(value);
  }
  function appConfirm(message,{title='请确认',confirmLabel='确认',cancelLabel='取消',danger=false}={}){
    return new Promise(resolve=>{
      if(dialogResolve)finishAppDialog(false);
      dialogResolve=resolve;dialogPreviousFocus=document.activeElement;
      dialogRoot.innerHTML=`<div class="modal-backdrop app-dialog-backdrop"><section class="modal app-dialog" role="alertdialog" aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message"><header><h2 id="app-dialog-title">${esc(title)}</h2></header><div class="modal-body"><p id="app-dialog-message" class="app-dialog-message">${esc(message)}</p><div class="modal-actions app-dialog-actions"><button type="button" data-dialog-value="cancel">${esc(cancelLabel)}</button><button type="button" class="${danger?'danger':'primary'}" data-dialog-value="confirm">${esc(confirmLabel)}</button></div></div></section></div>`;
      dialogRoot.querySelector('[data-dialog-value="cancel"]')?.focus();
      dialogRoot.querySelectorAll('[data-dialog-value]').forEach(button=>button.addEventListener('click',()=>finishAppDialog(button.dataset.dialogValue==='confirm')));
    });
  }
  function appPrompt(title,value='',{message='',label='输入内容',confirmLabel='确认',cancelLabel='取消',placeholder=''}={}){
    return new Promise(resolve=>{
      if(dialogResolve)finishAppDialog(null);
      dialogResolve=resolve;dialogPreviousFocus=document.activeElement;
      dialogRoot.innerHTML=`<div class="modal-backdrop app-dialog-backdrop"><section class="modal app-dialog app-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title"><header><h2 id="app-dialog-title">${esc(title)}</h2></header><div class="modal-body">${message?`<p class="app-dialog-message">${esc(message)}</p>`:''}<form id="app-prompt-form"><label>${esc(label)}<input id="app-prompt-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"></label><div class="modal-actions app-dialog-actions"><button type="button" data-dialog-cancel>${esc(cancelLabel)}</button><button type="submit" class="primary">${esc(confirmLabel)}</button></div></form></div></section></div>`;
      const input=dialogRoot.querySelector('#app-prompt-input');input?.focus();input?.select();
      dialogRoot.querySelector('[data-dialog-cancel]')?.addEventListener('click',()=>finishAppDialog(null));
      dialogRoot.querySelector('#app-prompt-form')?.addEventListener('submit',event=>{event.preventDefault();finishAppDialog(input?.value??'');});
    });
  }
  async function attempt(fn) { try { return await fn(); } catch (error) { toast(error.message || String(error)); } }
  function fields(value) {
    return GamePresentation.fields(value);
  }
  function files(node, prefix='') {
    if (!node) return '';
    return Object.entries(node.children || {}).sort((a,b)=>(a[1].type==='dir'?0:1)-(b[1].type==='dir'?0:1)||a[0].localeCompare(b[0])).map(([name,n]) => {
      const path=prefix+'/'+name;
      return n.type==='dir' ? `<details class="folder" data-key="${esc('folder:'+path)}" open><summary data-path="${esc(path)}" tabindex="0">${esc(name)}</summary>${files(n,path)}</details>` : `<button class="file-link ${filePath===path?'selected':''}" data-action="open-file" data-path="${esc(path)}" title="${esc(path)}">▤ ${esc(name)}</button>`;
    }).join('');
  }
  function render() {
    if (!root) return;
    const scroll=root.querySelector('#history'),oldHeight=scroll?.scrollHeight||0,oldScroll=scroll?.scrollTop||0,nearBottom=!scroll||scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<90;
    const s=state, a=s.active;
    if(viewSave!==a?.id){fileSelection='';fileClipboard=null;preview=false;closeFileMenu();viewSave=a?.id;previousVitals={};secondaryVital='mp';renderedSecondary=null;scrollAmount=lastScroll=0;clearTimeout(navTimer);}
    const desired=document.createElement('template');desired.innerHTML=`<header class="topbar"><div class="brand"><span class="brand-seal" aria-label="骰子">${brandDiceIcon()}</span><div>异闻手记<small>${a?esc(a.name):'一人，一卷，尚未写下的故事'}</small></div></div><nav>${a ? button('home','切换存档')+`<div class="mode-switch" aria-label="展示方式">${button('play','游戏模式',`aria-pressed="${s.mode!=='debug'}"`)}${button('debug','调试模式',`aria-pressed="${s.mode==='debug'}"`)}</div>` : ''}${button('settings',gearIcon(),'class="settings-icon" aria-label="设置" title="设置"')}</nav></header>${s.storageWarning?`<div class="notice">${esc(s.storageWarning)}</div>`:''}${a ? gameHTML() : chooserHTML()}<input id="zip-input" type="file" hidden>`;
    patchDOM(root,desired.content);
    root.querySelector('#zip-input').onchange=e=>{ const f=e.target.files[0]; if(f)attempt(async()=>{await GameApp.importSave(f);filePath='';fileDraft=fileOriginal='';draft=state.active?.draft||'';render();apiKeyWarning();}); };
    const next=root.querySelector('#history');if(next){if(forceHistoryBottom){next.scrollTop=next.scrollHeight;forceHistoryBottom=false;lastScroll=next.scrollTop;scrollAmount=0;}else if(next.scrollHeight!==oldHeight)next.scrollTop=nearBottom&&!pointerHeld?next.scrollHeight:oldScroll;}
    if(a&&s.mode!=='debug')updateVitals(GameApp.player().info);
    refreshInput();
    if(preview&&filePath){const ta=document.getElementById('file-editor');if(ta){const pane=document.createElement('div');pane.id='file-preview';pane.tabIndex=0;pane.className='panel-scroll';pane.innerHTML=markdown(fileDraft);ta.replaceWith(pane);pane.focus();}}
    if(a?.pendingManualDice&&!modalRoot.firstChild){const e=a.events?.find(x=>x.id===a.pendingManualDice.eventId);if(e)setTimeout(()=>{if(!modalRoot.firstChild&&state.active?.pendingManualDice?.eventId===e.id)diceDetailModal(e);},0);}
  }
  let catalog=[],catalogError='';
  async function reloadCatalog(source=state?.settings?.worldListSource||''){
    clearFallbackCovers();
    try{
      catalog=await GameCatalog.load({source});catalogError='';
      return catalog;
    }catch(error){
      catalog=[];catalogError='模组列表暂时无法加载：'+(error.message||String(error))+' 仍可从链接或文件导入。';
      return [];
    }finally{
      if(modalRoot?.querySelector('.import-modal'))importMenu();
    }
  }
  const tags=item=>`<div class="module-tags">${item.Tags.map(t=>`<span style="--tag-color:${esc(t.Color)}">${esc(t.TagName)}</span>`).join('')}</div>`;
  const fallbackCoverCache=new Map(),fallbackCoverPromises=new Map(),fallbackCoverQueue=[];let fallbackCoverActive=0,coverObserver=null;
  function runFallbackCoverQueue(){
    while(fallbackCoverActive<3&&fallbackCoverQueue.length){
      const job=fallbackCoverQueue.shift();fallbackCoverActive++;
      Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{fallbackCoverActive--;runFallbackCoverQueue();});
    }
  }
  const queuedCover=run=>new Promise((resolve,reject)=>{fallbackCoverQueue.push({run,resolve,reject});runFallbackCoverQueue();});
  function clearFallbackCovers(){
    coverObserver?.disconnect();coverObserver=null;
    for(const value of fallbackCoverCache.values())if(value)URL.revokeObjectURL(value);
    fallbackCoverCache.clear();fallbackCoverPromises.clear();fallbackCoverQueue.length=0;
  }
  function fallbackCoverUrl(item){
    if(!item||item.Cover||item.CoverFit==='none')return Promise.resolve('');
    const key=item.Link;if(fallbackCoverCache.has(key))return Promise.resolve(fallbackCoverCache.get(key));
    if(fallbackCoverPromises.has(key))return fallbackCoverPromises.get(key);
    const task=queuedCover(async()=>{
      const blob=await GameCatalog.fallbackCover(item.Link);
      const objectUrl=blob?URL.createObjectURL(blob):'';
      fallbackCoverCache.set(key,objectUrl);return objectUrl;
    }).catch(()=>{fallbackCoverCache.set(key,'');return '';}).finally(()=>fallbackCoverPromises.delete(key));
    fallbackCoverPromises.set(key,task);return task;
  }
  function applyFallbackCover(el){
    if(!el||el.dataset.coverLoading)return;const item=catalog[Number(el.dataset.coverIndex)];if(!item||item.Cover||item.CoverFit==='none')return;
    el.dataset.coverLoading='1';
    fallbackCoverUrl(item).then(src=>{
      if(!el.isConnected)return;
      if(!src){el.remove();return;}
      const img=document.createElement('img');img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.src=src;
      el.replaceChildren(img);el.hidden=false;el.closest('.module-card')?.classList.add('has-cover');
    });
  }
  function hydrateFallbackCovers(scope=modalRoot){
    const nodes=[...scope.querySelectorAll('.module-cover[data-cover-index]')];if(!nodes.length)return;
    if('IntersectionObserver'in globalThis){
      coverObserver?.disconnect();coverObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){coverObserver.unobserve(entry.target);const node=entry.target.__fallbackCoverNode;if(node)applyFallbackCover(node);}},{root:null,rootMargin:'320px'});
      for(const node of nodes){const target=node.closest('.module-card')||node.parentElement||node;target.__fallbackCoverNode=node;coverObserver.observe(target);}
    }else for(const node of nodes)applyFallbackCover(node);
  }
  const moduleCover=(item,index)=>item.CoverFit==='none'?'':item.Cover?`<div class="module-cover fit-${esc(item.CoverFit||'auto')}"><img src="${esc(item.Cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`:`<div class="module-cover fit-${esc(item.CoverFit||'auto')}" data-cover-index="${index}" hidden></div>`;
  function importMenu(){
    const choice=(action,icon,title,description)=>`<button class="import-choice" data-action="${action}"><span class="choice-icon">${icon}</span><span><strong>${title}</strong><small>${description}</small></span><span class="choice-arrow">→</span></button>`;
    showModal('开启新的故事',`<div class="import-choices">${catalog.length?choice('catalog','▤','从列表选择','浏览收录的世界，寻找下一段旅程'):''}${choice('import-url','↗','从链接导入','粘贴 ZIP 链接，载入远方的故事')}${choice('import-file','◇','从文件导入','打开设备中的 ZIP，或带存档数据的 PNG')}</div>`);
    modalRoot.querySelector('.modal').classList.add('import-modal');
    if(catalogError){const notice=document.createElement('p');notice.className='notice error';notice.textContent=catalogError;modalRoot.querySelector('.modal').append(notice);}
  }
  function catalogPage(){
    showModal('选择一个世界',`<p class="catalog-lead">每一卷，都有尚未写下的故事。</p><div class="module-grid">${catalog.map((m,i)=>`<button class="module-card ${m.Cover?'has-cover':''}" data-action="module-detail" data-index="${i}">${moduleCover(m,i)}<span class="module-number">卷 ${String(i+1).padStart(2,'0')}</span><h2>${esc(m.Name)}</h2><p>${esc(m.Introduction)}</p>${tags(m)}<span class="module-enter">阅读卷首 →</span></button>`).join('')}</div>`);
    modalRoot.querySelector('.modal').classList.add('catalog-page');hydrateFallbackCovers();
  }
  function moduleDetail(index){const m=catalog[index];if(!m)return;
    showModal(m.Name,`${moduleCover(m,index)}<p class="module-intro">${esc(m.Introduction)}</p>${tags(m)}<div class="module-text">${esc(m.Text)}</div><div class="modal-actions">${button('catalog','取消')}${button('module-confirm','确认选择',`class="primary" data-index="${index}"`)}</div>`);hydrateFallbackCovers();
  }
  async function startDownload(link,name){GameCatalog.url(link);modalRoot.innerHTML='';await GameApp.importLink(link,name);filePath='';fileDraft=fileOriginal='';draft=state.active?.draft||'';mobile='center';render();apiKeyWarning();}
  function downloadHTML(){const d=state.importing;if(!d)return '';const mb=n=>(n/1024/1024).toFixed(1)+' MB',percent=d.total?Math.min(100,d.received/d.total*100):null;
    return `<section class="import-progress" aria-label="存档导入进度"><div><strong>${d.phase==='extract'?'正在解压并载入存档':d.phase==='prepare'?'正在准备导入':'正在下载世界'}</strong><span>${d.phase==='download'?mb(d.received)+(d.total?' / '+mb(d.total)+' · '+Math.floor(percent)+'%':' · 大小未知'):''}</span></div><progress aria-label="下载进度" max="100" ${d.phase==='download'&&percent!==null?`value="${percent}"`:''}></progress><p role="status">请不要离开此页面，完成后将自动打开存档。</p></section>`;
  }
  function chooserHTML() {
    return `<main class="save-home"><div class="eyebrow">THE UNWRITTEN CHRONICLE</div><h1>翻开你的故事</h1><p class="home-lead">选择一卷存档，或带来一个新的世界。</p>${downloadHTML()}<div class="save-grid" ${state.importing?'inert aria-busy="true"':''}>${(state.saves||[]).map(s=>`<article class="save-card"><button class="save-open" data-action="open-save" data-id="${esc(s.id)}">${s.cover?.mime==='image/png'&&s.cover.data?`<img class="save-cover" src="${esc('data:image/png;base64,'+s.cover.data)}" alt="" loading="lazy">`:'<span class="save-icon">◇</span>'}<h2>${esc(s.name)}</h2><p>${esc(GamePresentation.metadata({round:s.round,worldTime:s.worldTime}))}</p><time class="save-real-time">${esc(GamePresentation.realTime(s.lastRoundEndedAt))}</time><span class="enter-save">进入故事 →</span></button><footer>${button('rename-save','重命名',`data-id="${esc(s.id)}" data-name="${esc(s.name)}"`)}${button('delete-save','删除',`data-id="${esc(s.id)}"`)}</footer></article>`).join('')}<button class="import-card" data-action="import"><span>＋</span><strong>新增存档</strong><small>选择一个世界，翻开新的一页</small></button></div>${!state.saves?.length?'<p class="empty-library">书架还空着。点击加号，载入你的第一个世界。</p>':''}${state.error?`<div class="notice error">${esc(state.error)}</div>`:''}</main>`;
  }
  function gameHTML() {
    let p={},playerError='';try{p=GameApp.player()||{};}catch(error){playerError=error.message||String(error);}
    const a=state.active,debug=state.mode==='debug',busy=state.running;let baseline=p;try{const tree=a.snapshots?.at(-1)?.tree;if(tree)baseline=GameCore.player({...a,tree});}catch(_){}
    const flags=GameData.actorState(p.info),blocked=!flags.alive||!flags.enabled,roundNumber=a.activeRound&&!a.activeRound.complete?a.activeRound.number:a.round;
    const status={new:'等待开局',waiting:'等待你的行动',running:'主持人正在推演',interrupted:'本轮已中断',ended:'故事已结束'}[a.status]||a.status;
    return `<main class="game-layout ${debug?'debug-mode':''} mobile-${mobile}"><aside class="panel left-panel"><div class="panel-title"><span>${debug?'文件阅览':'I. 随身物品'}</span><small>${debug?(filePath?'编辑器':'EDITOR'):(p.items?.length||0)+' 件物品'}</small></div>${debug ? filePath ? `<div class="editor-path">${esc(filePath)}</div><textarea id="file-editor" spellcheck="false" ${busy?'disabled':''} aria-label="文件内容">${esc(fileDraft)}</textarea><div class="editor-footer"><span id="file-dirty">${fileDraft===fileOriginal?'已保存':'有未保存改动'}</span>${button('save-file','保存',busy?'disabled':'')}${button('close-file','关闭')}</div>` : '<div class="empty-pane"><span>▤</span><p>从右侧选择一个文件</p><small>在这里查看或编辑世界</small></div>' : `<div class="panel-scroll inventory">${p.itemsStale?'<div class="notice error" role="status">背包未更新，暂时保留上次有效资料，请在调试模式检查文件。</div>':''}${GamePresentation.fields(p.items,baseline.items,'inventory')||'<div class="empty-pane"><span>◇</span><p>行囊里暂时没有物品</p></div>'}</div>`}</aside><section class="center-panel"><section class="story-paper"><div class="panel-title story-heading"><span><small>II.</small> 故事卷宗</span><small>CHRONICLE</small></div><div class="story-toolbar"><span><i class="status-dot ${busy?'pulsing':''}"></i>${esc(!busy&&a.status==='waiting'&&blocked?(!flags.alive?'角色已死亡':'失去意识，等待局势发展'):status)}<small>${esc(GamePresentation.metadata({round:roundNumber||0,worldTime:GameData.worldTime(a)}))}</small></span><div>${debug?`<small class="token-usage">${state.usage?'输入 '+esc(state.usage.prompt_tokens??state.usage.input_tokens??'—')+' / 输出 '+esc(state.usage.completion_tokens??state.usage.output_tokens??'—')+' tokens':''}</small>`:''}${debug?button('context','实际上下文')+button('changes','本轮改动'):''}</div></div>${a.importNotice?`<div class="notice">${esc(a.importNotice)}</div>`:''}${state.error?`<div class="notice error">${debug?esc(state.error):'本轮未能完成。可以继续执行，或在 DEBUG 中查看原因。'}</div>`:''}<div class="history" id="history">${visibleEvents(a.events,state.mode).map(e=>`<div data-key="history:${esc(e.id)}">${eventHTML(e,state.mode)}</div>`).join('')||`<div class="opening"><div>✧</div><h2>故事在此展开</h2><p>${a.status==='new'?'世界已经准备好，点击「开始故事」。':'你的行动将成为下一页。'}</p></div>`}${busy?`${state.stream?.story?`<article class="story live-story" aria-live="polite"><header class="story-meta">故事正在书写…</header>${markdown(state.stream.story)}</article>`:''}<div class="live-status">${debug?`${state.stream?.reasoning?`<details><summary>实时思考</summary><pre>${esc(state.stream.reasoning)}</pre></details>`:''}${state.stream?.content?`<div class="assistant-event">${markdown(state.stream.content)}</div>`:''}${state.stream?.tools?.length?`<details><summary>正在接收工具调用 · ${state.stream.tools.length}</summary><pre>${esc(json(state.stream.tools))}</pre></details>`:''}${state.stream?.story?'':'<span class="quill">✦</span> '+esc(runPhase(state))+'…'}`:`${state.stream?.story?'':`<span class="quill">✦</span> ${esc(runPhase(state))}…`}`}</div>`:''}${continuationHTML(state)}</div><nav id="history-navigation" aria-label="故事导航">${button('history-dismiss','×','aria-label="关闭滚动工具栏" title="关闭工具栏"')}${button('history-top','⤒','aria-label="到顶部" title="到顶部"')}${button('history-prev','↑','aria-label="上一段" title="上一段"')}${button('history-next','↓','aria-label="下一段" title="下一段"')}${button('history-bottom','⤓','aria-label="到底部" title="到底部"')}</nav></section>${!debug?'<div id="vital-dock" data-live-vitals></div>':''}<form id="action-form" class="composer"><textarea id="action-input" placeholder="${busy?'可以先写下一轮的行动草稿…':blocked?(!flags.alive?'角色已死亡，可查看历史或回溯':'失去意识，无法主动行动'):'写下你的行动与言语…'}" aria-label="玩家行动" ${blocked||a.status==='new'||a.status==='ended'||a.status==='interrupted'?'disabled':''}>${esc(draft)}</textarea><div class="composer-bottom"><span><small>Ctrl / ⌘ + Enter 发送 · <span id="action-count">${draft.length} 字</span></small></span>${busy?`<div class="run-controls"><span class="run-phase" role="status" title="按本回合请求次数估算，非实际完成比例"><span class="request-progress">${esc(requestProgress(state))}</span></span>${button('abort','中断', 'class="primary"')}</div>`:a.status==='new'?button('start','开始故事','class="primary"'):a.status==='interrupted'?'<span class="muted">继续本轮后才能提交新行动</span>':`<button type="submit" class="primary" ${a.status==='ended'||!flags.alive?'disabled':''}>${!flags.alive?'已死亡':!flags.enabled?'等待局势发展':draft.trim()?'提交行动 ↗':'空过'}</button>`}</div></form></section><aside class="panel right-panel"><div class="panel-title"><span>${debug?'世界文件':'III. 人物档案'}</span><small>${debug?'FILES':'CHARACTER'}</small></div>${debug?`<div class="file-actions">${button('create-file','＋ 文件',busy?'disabled':'')}${button('mkdir','＋ 目录',busy?'disabled':'')}${button('file-more','管理',busy?'disabled':'')}${button('export','导出 ZIP',busy?'disabled':'')}</div><div class="panel-scroll file-tree" tabindex="0" aria-label="世界文件管理器">${files(a.tree)||'<p class="muted">暂无文件</p>'}</div>`:`<div class="panel-scroll character">${playerError||p.infoStale?`<div class="notice error" role="status">资料未更新${p.info?'，暂时显示上次有效资料':''}，请在 DEBUG 检查文件。</div>`:''}${GamePresentation.fields(p.info,baseline.info,'character')||'<div class="empty-pane"><span>♙</span><p>角色资料将在故事中完善</p></div>'}</div><footer class="info-footer">${button('rollback','回溯 ('+Math.min(10,a.snapshots?.length||0)+')',busy||!a.snapshots?.length?'disabled':'')}${button('history-export','导出故事')}</footer>`}</aside></main><nav class="mobile-nav">${button('mobile-left',debug?'阅览':'行囊',`aria-pressed="${mobile==='left'}"`)}${button('mobile-center','故事',`aria-pressed="${mobile==='center'}"`)}${button('mobile-right',debug?'文件':'人物',`aria-pressed="${mobile==='right'}"`)}</nav>`;
  }
  function showModal(title,content) { modalRoot.innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2>${button('close-modal','×','aria-label="关闭"')}</header><div class="modal-body">${content}</div></section></div>`; modalRoot.querySelector('button,input,select,textarea')?.focus(); }
  const hasApiKey=()=>!!String(state?.settings?.apiKey||'').trim();
  function apiKeyWarning(){
    if(hasApiKey())return true;
    showModal('需要设置 API Key',`<div class="api-key-warning"><strong>尚未设置 API Key</strong><p>你仍然可以查看存档内容，但开始故事、继续回合或提交行动都需要先配置可用的 API Key。</p></div><div class="modal-actions">${button('close-modal','关闭')}${button('api-key-settings','去设置','class="primary"')}</div>`);
    return false;
  }
  const SETTINGS_SECTIONS_KEY='awl:settings-sections';
  function settingsSectionState(){
    const defaults={api:true,game:false,advanced:false};
    try{
      const saved=JSON.parse(localStorage.getItem(SETTINGS_SECTIONS_KEY)||'{}');
      for(const key of Object.keys(defaults))if(typeof saved?.[key]==='boolean')defaults[key]=saved[key];
    }catch(_){}
    return defaults;
  }
  function settingsModal() {
    const s=state.settings||{},opened=settingsSectionState();
    const field=(name,label,type='text',fallback='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(s[name]??fallback)}" ${type==='number'?'step="any"':''}></label>`;
    const section=(id,title,content)=>`<details class="settings-section" data-settings-section="${id}" ${opened[id]?'open':''}><summary><span>${esc(title)}</span><span class="settings-section-arrow" aria-hidden="true">⌄</span></summary><div class="settings-section-body">${content}</div></details>`;
    const model=`<label class="model-setting"><span>模型</span><div class="model-control"><input id="model-input" name="model" type="text" value="${esc(s.model??'')}" autocomplete="off" spellcheck="false">${button('fetch-models','获取')}</div><small id="model-list-result" class="settings-field-result" role="status"></small></label>`;
    const apiKey=`<label class="api-key-setting"><span>API Key</span><div class="api-key-control"><input name="apiKey" type="password" value="${esc(s.apiKey??'')}" autocomplete="off">${button('test-connection','测试连接')}</div><small id="connection-result" class="settings-field-result" role="status"></small></label>`;
    const api=`<div class="settings-grid">${field('baseUrl','API 地址','url')}${model}${apiKey}${field('temperature','Temperature','number',0.8)}${field('maxContextK','上下文上限（K tokens）','number',240)}${field('maxOutputTokens','最大输出 tokens','number',16384)}${field('maxToolLoops','每轮最大模型调用次数','number',60)}${field('httpTimeoutSeconds','请求超时（秒）','number',180)}${field('maxRetries','重试次数','number',2)}<label>思考强度<select name="reasoningEffort">${['none','low','high','xhigh','max'].map(v=>`<option ${s.reasoningEffort===v?'selected':''}>${v}</option>`).join('')}</select></label><label class="check-label stream-setting"><input name="stream" type="checkbox" ${s.stream!==false?'checked':''}><span>流式输出<small>用于缓解长时间输出文本的超时问题；不一定能使故事输出本身变为流式。</small></span></label></div>`;
    const game=`<label class="check-label manual-dice-setting"><input name="manualDice" type="checkbox" ${s.manualDice===true?'checked':''}><span>手动掷骰<small>开启后，玩家可见的公开检定会暂停流程，等待你亲自掷骰。暗骰和非玩家检定仍自动结算。</small></span></label>`;
    const advanced=`<label class="world-list-setting"><span>世界列表源</span><div class="settings-inline-control"><input id="world-list-source" name="worldListSource" type="text" value="${esc(s.worldListSource||'')}" placeholder="${esc(GameCatalog.DEFAULT_SOURCE)}" autocomplete="off" spellcheck="false">${button('test-world-list','测试')}${button('reset-world-list','恢复默认')}</div><small>留空时使用 ${esc(GameCatalog.DEFAULT_SOURCE)}；可填写公开的 HTTP / HTTPS JSON 地址或站内路径。外部地址需要允许浏览器跨域读取。</small></label><p id="world-list-result" class="settings-field-result" role="status"></p><div class="settings-section-actions settings-section-actions-start">${button('prompts','编辑提示词')}</div>`;
    showModal('设置',`<aside class="settings-github" aria-label="GitHub"><div><strong>GitHub</strong><p>查看源代码，或联系作者反馈问题。</p></div><a class="github-link" href="https://github.com/clinlx/unusual-book-agent-for-web" target="_blank" rel="noopener noreferrer" aria-label="打开 GitHub 项目页面">GitHub ↗</a></aside><form id="settings-form"><div class="settings-sections">${section('api','API 设置',api)}${section('game','游戏设置',game)}${section('advanced','高级选项',advanced)}</div><div class="modal-actions"><button class="primary" type="submit">保存设置</button></div></form>`);
    for(const details of modalRoot.querySelectorAll('.settings-section'))details.addEventListener('toggle',()=>{
      const next={};
      for(const item of modalRoot.querySelectorAll('.settings-section'))next[item.dataset.settingsSection]=item.open;
      try{localStorage.setItem(SETTINGS_SECTIONS_KEY,JSON.stringify(next));}catch(_){}
    });
  }
  function promptModal(id) {
    const list=GameApp.promptList()||[], target=id || list[0]?.id;if(!target)return toast('没有提示词文件');
    const value=GameApp.getPrompt(target);
    showModal('提示词文件',`<p class="muted">按加载方式分组。覆盖保存于此浏览器，对所有存档生效；参考文件挂载于隐藏的 /.reference，与 /workspace 同级。</p><select id="prompt-select" aria-label="提示词文件">${['system','flow','reference'].map(group=>`<optgroup label="${esc(list.find(p=>p.group===group)?.groupTitle||group)}">${list.filter(p=>p.group===group).map(p=>`<option value="${esc(p.id)}" ${p.id===target?'selected':''}>${esc(p.title)}</option>`).join('')}</optgroup>`).join('')}</select><textarea id="prompt-editor" class="code-editor" spellcheck="false">${esc(typeof value==='string'?value:value.content)}</textarea><div class="modal-actions">${button('reset-prompts','全部恢复默认')}${button('reset-prompt','恢复此文件默认')}${button('save-prompt','保存覆盖','class="primary"')}</div>`);
  }
  function diceSpecRows(args={}){
    const out=[];for(const [label,value] of Object.entries(args.dice_dict||{})){
      const formula=String(value).trim(),m=formula.match(/^(-?)(\d+)d(\d+)$/i);
      if(m){const n=Number(m[2]),faces=Number(m[3]);for(let i=0;i<n;i++)out.push({label,faces,sign:m[1]?-1:1,formula,index:i});}
      else if(/^-?\d+$/.test(formula))out.push({label,constant:Number(formula),formula,index:0});
    }return out;
  }
  function dieKind(faces){
    if(faces===1||faces===2)return 'coin';
    return [4,6,8,10,12,20,100].includes(faces)?'d'+faces:'slot';
  }
  function dieVisual(spec,value,pending=false){
    const kind=spec.constant!==undefined?'constant':dieKind(spec.faces),shown=spec.constant!==undefined?spec.constant:value;
    return `<div class="manual-die ${kind}" data-die-kind="${esc(kind)}" data-faces="${esc(spec.faces??'')}" data-sign="${esc(spec.sign??1)}" data-final="${shown==null?'':esc(Math.abs(shown))}"><canvas class="manual-die-canvas" width="170" height="150" aria-label="${esc((kind==='slot'?'数字轮盘 ':kind==='coin'?'硬币 ':'骰子 ')+(safeDiceLabel(spec.label)||''))}"></canvas><small>${esc(safeDiceLabel(spec.label)||spec.constant!==undefined?'常数':'骰子')}</small></div>`;
  }
  function modifierLines(obj,title){
    const entries=Object.entries(obj||{});
    return `<div class="manual-modifier-group"><strong>${esc(title)}</strong>${entries.length?entries.map(([reason,value])=>`<span><b>${esc(signedModifier(Number(value)||0))}</b><small>${esc(reason)}</small></span>`).join(''):'<small class="manual-no-modifier">无修正</small>'}</div>`;
  }
  function diceDetailArgs(e){
    if(e?.diceArgs&&Object.keys(e.diceArgs).length)return e.diceArgs;
    const d=e?.data||{},rows=Array.isArray(d.rows)?d.rows:[];
    const dice_dict={};
    for(const row of rows){
      if(!row?.formula)continue;
      let label=String(row.label||'骰子').trim()||'骰子',key=label,n=2;
      while(Object.hasOwn(dice_dict,key))key=label+' '+n++;
      dice_dict[key]=String(row.formula);
    }
    const left=Number(d.left)||0,right=Number(d.right)||0,target=Number(d.target);
    return {description:e?.description||'',roller:e?.roller||'',related_attr:e?.relatedAttr||'',is_secret:!!e?.secret,dice_dict,
      calculate_only:d.success==null,target_value:Number.isFinite(target)?target-right:undefined,compare_mode:d.compare_mode,dice_combine_mode:d.mode||'sum',
      left_modifiers:left?{'旧存档合计':left}:{},right_modifiers:right?{'旧存档合计':right}:{}};
  }
  const V3={
    add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
    cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
    norm:a=>{const m=Math.hypot(...a)||1;return[a[0]/m,a[1]/m,a[2]/m];},
    rot:(v,rx,ry,rz)=>{let[x,y,z]=v,c=Math.cos(rx),s=Math.sin(rx),y1=y*c-z*s,z1=y*s+z*c;y=y1;z=z1;c=Math.cos(ry);s=Math.sin(ry);let x1=x*c+z*s;z1=-x*s+z*c;x=x1;z=z1;c=Math.cos(rz);s=Math.sin(rz);return[x*c-y*s,x*s+y*c,z];}
  };
  function polyhedron(kind){
    const phi=(1+Math.sqrt(5))/2,norm=verts=>{const m=Math.max(...verts.map(v=>Math.hypot(...v)));return verts.map(v=>v.map(x=>x/m));};
    if(kind==='d4')return {v:norm([[1,1,1],[-1,-1,1],[-1,1,-1],[1,-1,-1]]),f:[[0,1,2],[0,3,1],[0,2,3],[1,3,2]]};
    if(kind==='d6')return {v:[[ -1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],f:[[0,1,2,3],[4,7,6,5],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]]};
    if(kind==='d8')return {v:[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],f:[[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]]};
    if(kind==='d20'){
      const v=norm([[-1,phi,0],[1,phi,0],[-1,-phi,0],[1,-phi,0],[0,-1,phi],[0,1,phi],[0,-1,-phi],[0,1,-phi],[phi,0,-1],[phi,0,1],[-phi,0,-1],[-phi,0,1]]);
      const f=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];return{v,f};
    }
    if(kind==='d12'){
      const ico=polyhedron('d20'),centers=ico.f.map(face=>V3.norm(face.map(i=>ico.v[i]).reduce((a,b)=>V3.add(a,b),[0,0,0])));
      const faces=[];for(let vi=0;vi<ico.v.length;vi++){const adjacent=ico.f.map((f,i)=>f.includes(vi)?i:-1).filter(i=>i>=0);faces.push(adjacent);}return{v:centers,f:faces};
    }
    if(kind==='d10'){
      const v=[],f=[],n=5;for(let i=0;i<n;i++){const a=i*Math.PI*2/n;v.push([Math.cos(a),Math.sin(a),.25]);}for(let i=0;i<n;i++){const a=(i+.5)*Math.PI*2/n;v.push([Math.cos(a),Math.sin(a),-.25]);}v.push([0,0,1.18],[0,0,-1.18]);
      for(let i=0;i<n;i++){const j=(i+1)%n;f.push([10,i,j]);f.push([11,n+j,n+i]);f.push([i,n+i,n+j,j]);}return{v:norm(v),f};
    }
    return null;
  }
  function d100Mesh(){
    const v=[],f=[],rings=8,segs=14;v.push([0,0,1]);
    for(let r=1;r<rings;r++){const t=Math.PI*r/rings,z=Math.cos(t),q=Math.sin(t);for(let s=0;s<segs;s++){const a=Math.PI*2*s/segs;v.push([q*Math.cos(a),q*Math.sin(a),z]);}}
    const bottom=v.push([0,0,-1])-1;
    for(let s=0;s<segs;s++){const n=(s+1)%segs;f.push([0,1+s,1+n]);}
    for(let r=1;r<rings-1;r++){const a0=1+(r-1)*segs,b0=1+r*segs;for(let s=0;s<segs;s++){const n=(s+1)%segs;f.push([a0+s,b0+s,b0+n],[a0+s,b0+n,a0+n]);}}
    const last=1+(rings-2)*segs;for(let s=0;s<segs;s++){const n=(s+1)%segs;f.push([last+s,bottom,last+n]);}
    return{v,f};
  }
  function metalGradient(ctx,x0,y0,x1,y1,light=.5){
    const g=ctx.createLinearGradient(x0,y0,x1,y1),lift=Math.round(18+light*24);
    g.addColorStop(0,`rgb(${lift+12},${lift+13},${lift+10})`);
    g.addColorStop(.38,`rgb(${lift+2},${lift+3},${lift+1})`);
    g.addColorStop(.72,`rgb(${Math.max(10,lift-8)},${Math.max(11,lift-6)},${Math.max(9,lift-8)})`);
    g.addColorStop(1,`rgb(${lift+7},${lift+6},${lift+3})`);return g;
  }
  function drawGoldText(ctx,text,x,y,size){
    ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='700 '+size+'px Georgia';
    ctx.lineJoin='round';ctx.lineWidth=Math.max(2,size*.11);ctx.strokeStyle='#0b0d0c';ctx.shadowColor='rgba(0,0,0,.85)';ctx.shadowBlur=5;ctx.shadowOffsetY=2;ctx.strokeText(text,x,y);
    const g=ctx.createLinearGradient(x,y-size*.6,x,y+size*.65);g.addColorStop(0,'#fff0a8');g.addColorStop(.28,'#d6ad4f');g.addColorStop(.62,'#9a6b22');g.addColorStop(1,'#f1cf72');
    ctx.fillStyle=g;ctx.shadowColor='rgba(238,191,86,.4)';ctx.shadowBlur=4;ctx.shadowOffsetY=0;ctx.fillText(text,x,y);
    ctx.globalAlpha=.55;ctx.fillStyle='#fff7c8';ctx.font='600 '+Math.max(8,size*.34)+'px Georgia';ctx.fillText('✦',x-size*.42,y-size*.32);ctx.restore();
  }
  const resultVectorCache=new Map();
  function resultVectors(faces){
    if(resultVectorCache.has(faces))return resultVectorCache.get(faces);
    const out=[],gold=Math.PI*(3-Math.sqrt(5));
    for(let i=0;i<faces;i++){const y=1-(i+.5)*2/faces,r=Math.sqrt(Math.max(0,1-y*y)),a=i*gold;out.push([Math.cos(a)*r,Math.sin(a)*r,y]);}
    resultVectorCache.set(faces,out);return out;
  }
  function physicalFaceValue(faces,rx,ry,rz){
    if(faces<=1)return 1;
    const vectors=resultVectors(faces);let best=0,bestZ=-Infinity;
    for(let i=0;i<vectors.length;i++){const z=V3.rot(vectors[i],rx,ry,rz)[2];if(z>bestZ){bestZ=z;best=i;}}
    return best+1;
  }
  function settledMotion(s){
    if(s.kind==='slot')return s.slotV<.16;
    if(s.kind==='coin')return Math.abs(s.vx)+Math.abs(s.vy)+Math.abs(s.wy)<.025;
    return Math.abs(s.vx)+Math.abs(s.vy)+Math.abs(s.wx)+Math.abs(s.wy)+Math.abs(s.wz)<.045&&Math.abs(s.y-24)<.8;
  }
  function drawPoly(canvas,kind,value,state={}){
    const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);
    const cx=w/2+(state.x||0),cy=h/2+(state.y||0);
    ctx.save();ctx.filter='blur(5px)';ctx.fillStyle='rgba(0,0,0,.32)';ctx.beginPath();ctx.ellipse(cx,cy+48,44,11,0,0,Math.PI*2);ctx.fill();ctx.restore();
    if(kind==='constant'){
      const g=metalGradient(ctx,cx-38,cy-38,cx+38,cy+38,.45);ctx.fillStyle=g;ctx.strokeStyle='#b8903d';ctx.lineWidth=2.4;ctx.beginPath();ctx.roundRect(cx-37,cy-37,74,74,8);ctx.fill();ctx.stroke();
      ctx.strokeStyle='rgba(244,205,108,.35)';ctx.lineWidth=1;ctx.strokeRect(cx-29,cy-29,58,58);drawGoldText(ctx,String(value??''),cx,cy,28);return;
    }
    if(kind==='slot')return drawSlot(canvas,value,state.slotOffset??0);
    if(kind==='coin')return drawCoin(canvas,value,state);
    const mesh=kind==='d100'?d100Mesh():polyhedron(kind),scale=kind==='d100'?55:51,rx=state.rx??-.55,ry=state.ry??.7,rz=state.rz??.18;
    if(!mesh)return drawSlot(canvas,value,state.slotOffset??0);
    const pts=mesh.v.map(p=>V3.rot(p,rx,ry,rz).map((n,i)=>i<2?n*scale:n));
    const faces=mesh.f.map(face=>{const p=face.map(i=>pts[i]),a=V3.sub(p[1],p[0]),b=V3.sub(p[2],p[0]),normal=V3.norm(V3.cross(a,b)),z=p.reduce((n,q)=>n+q[2],0)/p.length;return{p,normal,z};}).sort((a,b)=>a.z-b.z);
    ctx.lineJoin='round';
    for(const face of faces){
      if(face.normal[2]>0.65)continue;
      const light=Math.max(.08,Math.min(.95,.48-face.normal[0]*.22-face.normal[1]*.28+face.normal[2]*.35));
      ctx.beginPath();face.p.forEach((p,i)=>i?ctx.lineTo(cx+p[0],cy+p[1]):ctx.moveTo(cx+p[0],cy+p[1]));ctx.closePath();
      ctx.fillStyle=metalGradient(ctx,cx-60,cy-55,cx+55,cy+60,light);
      ctx.strokeStyle=light>.55?'rgba(231,191,92,.78)':'rgba(149,109,43,.72)';ctx.lineWidth=light>.55?1.7:1.15;ctx.fill();ctx.stroke();
      if(light>.66){ctx.save();ctx.clip();const shine=ctx.createLinearGradient(cx-55,cy-45,cx+25,cy+35);shine.addColorStop(0,'rgba(255,239,174,.18)');shine.addColorStop(.45,'rgba(255,255,255,.04)');shine.addColorStop(1,'rgba(255,215,111,0)');ctx.fillStyle=shine;ctx.fillRect(cx-70,cy-70,140,140);ctx.restore();}
    }
    drawGoldText(ctx,value==null?'?':String(value),cx,cy,kind==='d100'?24:27);
  }
  function drawCoin(canvas,value,state={}){
    const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,spin=Math.abs(Math.cos(state.ry??.4)),rx=45*Math.max(.18,spin),cx=w/2+(state.x||0),cy=h/2+(state.y||0);ctx.clearRect(0,0,w,h);
    ctx.save();ctx.filter='blur(5px)';ctx.fillStyle='rgba(0,0,0,.32)';ctx.beginPath();ctx.ellipse(cx,cy+45,39,9,0,0,Math.PI*2);ctx.fill();ctx.restore();
    ctx.save();ctx.translate(cx,cy);ctx.scale(rx/45,1);
    const g=ctx.createRadialGradient(-13,-17,6,0,0,47);g.addColorStop(0,'#4b4e45');g.addColorStop(.48,'#252821');g.addColorStop(.8,'#151713');g.addColorStop(1,'#090b09');
    ctx.beginPath();ctx.arc(0,0,43,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();ctx.strokeStyle='#c49a42';ctx.lineWidth=4;ctx.stroke();
    ctx.beginPath();ctx.arc(0,0,33,0,Math.PI*2);ctx.strokeStyle='rgba(238,193,91,.72)';ctx.lineWidth=1.5;ctx.stroke();
    ctx.beginPath();ctx.arc(0,0,27,0,Math.PI*2);ctx.strokeStyle='rgba(112,83,32,.8)';ctx.lineWidth=1;ctx.stroke();drawGoldText(ctx,value==null?'?':String(value),0,0,28);ctx.restore();
  }
  function drawSlot(canvas,value,offset=0,faces=0){
    const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,cx=w/2,cy=h/2;ctx.clearRect(0,0,w,h);
    ctx.save();ctx.filter='blur(5px)';ctx.fillStyle='rgba(0,0,0,.32)';ctx.beginPath();ctx.ellipse(cx,cy+49,45,9,0,0,Math.PI*2);ctx.fill();ctx.restore();
    ctx.save();ctx.translate(cx,cy);
    const shell=ctx.createLinearGradient(-50,-50,50,50);shell.addColorStop(0,'#41443c');shell.addColorStop(.42,'#1d201c');shell.addColorStop(1,'#0b0d0b');ctx.fillStyle=shell;ctx.strokeStyle='#bd9139';ctx.lineWidth=3;ctx.beginPath();ctx.roundRect(-50,-48,100,96,10);ctx.fill();ctx.stroke();
    ctx.beginPath();ctx.roundRect(-41,-32,82,64,5);ctx.clip();const screen=ctx.createLinearGradient(0,-32,0,32);screen.addColorStop(0,'#151814');screen.addColorStop(.5,'#090b09');screen.addColorStop(1,'#1b1d18');ctx.fillStyle=screen;ctx.fillRect(-41,-32,82,64);
    const final=Number(value)||1,step=42,base=-offset%step,wrap=n=>faces>0?((n-1)%faces+faces)%faces+1:Math.max(1,n);ctx.font='700 27px Georgia';ctx.textAlign='center';ctx.textBaseline='middle';
    for(let k=-3;k<=3;k++){const n=wrap(final+k),y=base+k*step;const alpha=Math.max(.18,1-Math.abs(y)/80);ctx.globalAlpha=alpha;const gold=ctx.createLinearGradient(0,y-14,0,y+14);gold.addColorStop(0,'#ffe59a');gold.addColorStop(.55,'#c69237');gold.addColorStop(1,'#6f4719');ctx.fillStyle=gold;ctx.shadowColor='rgba(230,176,64,.32)';ctx.shadowBlur=4;ctx.fillText(String(n),0,y);}
    ctx.restore();ctx.globalAlpha=1;ctx.strokeStyle='rgba(245,204,104,.7)';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(cx-39,cy-33);ctx.lineTo(cx+39,cy-33);ctx.moveTo(cx-39,cy+33);ctx.lineTo(cx+39,cy+33);ctx.stroke();
    ctx.fillStyle='#d4a950';ctx.fillRect(cx+45,cy-18,4,36);ctx.fillStyle='#7b5722';ctx.fillRect(cx+47,cy-9,3,18);
  }
  function hydrateDiceCanvases(scope=modalRoot){
    for(const el of scope.querySelectorAll('.manual-die')){const canvas=el.querySelector('canvas'),kind=el.dataset.dieKind,value=el.dataset.final===''?null:Number(el.dataset.final);if(canvas)drawPoly(canvas,kind,value,{rx:-.55,ry:.7,rz:.18});}
  }
  const PHYSICAL_DICE_FACES=new Set([2,4,6,8,10,12,20,100]);
  const isPhysicalDiceSpec=spec=>spec?.constant===undefined&&PHYSICAL_DICE_FACES.has(Number(spec.faces));
  function storedDiceRolls(rows){
    const out=[];for(const row of rows||[]){if(!/^(-?)(\d+)d(\d+)$/i.test(String(row?.formula||'').trim()))continue;for(const value of row.rolls||[])out.push(Math.abs(Number(value)));}
    return out;
  }
  function fallbackDiceHTML(specs,values){
    let vi=0,out='';
    for(let i=0;i<specs.length;i++){
      const spec=specs[i];if(spec.constant!==undefined)continue;
      const provided=Array.isArray(values)?values[vi]:null;vi++;
      if(isPhysicalDiceSpec(spec))continue;
      const faces=Math.max(1,Number(spec.faces)||1),kind=faces===1?'coin':'slot',shown=Number.isFinite(provided)?provided:faces;
      out+=`<div class="manual-die manual-fallback-die ${kind}" data-spec-index="${i}" data-die-kind="${kind}" data-faces="${faces}" data-final="${esc(shown)}"><canvas class="manual-die-canvas" width="170" height="150"></canvas><small>${esc(safeDiceLabel(spec.label)||'骰子')}</small></div>`;
    }return out;
  }
  function hydrateFallbackDice(scope=modalRoot){
    for(const el of scope.querySelectorAll('.manual-fallback-die')){
      const canvas=el.querySelector('canvas'),faces=Number(el.dataset.faces),value=Number(el.dataset.final),kind=el.dataset.dieKind;if(!canvas)continue;
      if(kind==='coin')drawCoin(canvas,1,{ry:.25});else drawSlot(canvas,value,0,faces);
    }
  }
  function animateFallbackDice(specs){
    const nodes=[...modalRoot.querySelectorAll('.manual-fallback-die')];if(!nodes.length)return Promise.resolve(new Map());
    const entries=nodes.map(el=>{const faces=Number(el.dataset.faces),kind=el.dataset.dieKind,index=Number(el.dataset.specIndex),final=faces===1?1:secureDie(faces);
      return {el,canvas:el.querySelector('canvas'),faces,kind,index,final,duration:kind==='slot'?3600+Math.random()*900:2200+Math.random()*600,turns:kind==='slot'?9+Math.floor(Math.random()*6):9+Math.random()*4};});
    const started=performance.now();
    return new Promise(resolve=>{
      const frame=now=>{let done=true;
        for(const item of entries){
          const t=Math.min(1,(now-started)/item.duration),ease=1-Math.pow(1-t,4);
          if(t<1)done=false;
          if(item.kind==='coin')drawCoin(item.canvas,1,{ry:item.turns*Math.PI*2*ease});
          else drawSlot(item.canvas,item.final,item.turns*42*ease,item.faces);
        }
        if(done){
          const result=new Map();for(const item of entries){item.el.dataset.final=String(item.final);if(item.kind==='coin')drawCoin(item.canvas,1,{ry:0});else drawSlot(item.canvas,item.final,0,item.faces);result.set(item.index,item.final);}
          resolve(result);
        }else requestAnimationFrame(frame);
      };requestAnimationFrame(frame);
    });
  }
  function diceBoxCtor(){
    const candidates=[globalThis.DiceBox3D,globalThis.DiceBoxThreejs,globalThis.diceBoxThreejs,globalThis['dice-box-threejs'],globalThis.DiceBox];
    for(const c of candidates){const ctor=typeof c==='function'?c:c?.default||c?.DiceBox;if(typeof ctor==='function')return ctor;}
    return null;
  }
  function dice3dPlan(specs,forced=null){
    const parts=[],forcedPhysical=[],entries=[];let fi=0;
    for(const spec of specs){
      if(spec.constant!==undefined)continue;
      const raw=forced?Math.max(1,Math.min(spec.faces,Math.abs(Number(forced[fi])||1))):null;fi++;
      if(spec.faces===100){
        parts.push('1d100','1d10');entries.push({faces:100,types:['d100','d10']});
        if(forced){const n=raw===100?100:raw%100,tens=Math.floor((n%100)/10)*10,ones=n%10;forcedPhysical.push(tens||100,ones||10);}
      }else if([2,4,6,8,10,12,20].includes(spec.faces)){
        parts.push('1d'+spec.faces);entries.push({faces:spec.faces,types:['d'+spec.faces]});if(forced)forcedPhysical.push(raw);
      }else entries.push({faces:spec.faces,unsupported:true});
    }
    const notation=parts.length?parts.join('+')+(forced?'@'+forcedPhysical.join(','):''):'';
    const decode=result=>{
      const queues={};for(const set of result?.sets||[]){const q=queues[set.type]||(queues[set.type]=[]);for(const r of set.rolls||[])q.push(Number(r.value));}
      const values=[];for(const entry of entries){
        if(entry.unsupported)continue;
        if(entry.faces===100){const tens=(queues.d100||[]).shift(),ones=(queues.d10||[]).shift();if(!Number.isFinite(tens)||!Number.isFinite(ones)){values.push(NaN);continue;}const v=(tens%100)+(ones%10);values.push(v===0?100:v);}
        else values.push((queues[entry.types[0]]||[]).shift());
      }return values;
    };
    return {notation,forcedPhysical,entries,physicalCount:parts.length,decode};
  }
  function dice3dTheme(){
    return {name:'Noir Brass',description:'Dark metal with gold inlay',category:'Custom',
      foreground:'#e6bd62',background:'#171a18',outline:'#8b682e',texture:'none',material:'metal'};
  }
  let activeDiceBox=null,diceBoxToken=0;
  function diceViewProfile(count){
    if(count<=1)return {scale:78,strength:1.5,camera:1.06,cameraLift:.02,tray:215,world:1.08};
    if(count<=3)return {scale:70,strength:1.34,camera:1.2,cameraLift:.06,tray:230,world:1.2};
    if(count<=6)return {scale:62,strength:1.16,camera:1.38,cameraLift:.11,tray:255,world:1.38};
    if(count<=10)return {scale:55,strength:1.02,camera:1.54,cameraLift:.16,tray:280,world:1.56};
    return {scale:Math.max(44,55-(count-10)*1.1),strength:.92,camera:Math.min(1.9,1.54+(count-10)*.03),cameraLift:.2,tray:305,world:Math.min(1.9,1.56+(count-10)*.028)};
  }
  function tweenDiceCamera(box,fromZ,toZ,fromY,toY,duration=620){
    return new Promise(resolve=>{
      const start=performance.now(),tick=now=>{const t=Math.min(1,(now-start)/duration),ease=1-Math.pow(1-t,3);
        box.camera.position.z=fromZ+(toZ-fromZ)*ease;box.camera.position.y=fromY+(toY-fromY)*ease;box.camera.lookAt(0,0,0);box.renderer.render(box.scene,box.camera);
        if(t<1)requestAnimationFrame(tick);else resolve();
      };requestAnimationFrame(tick);
    });
  }
  function secureFloat(){
    const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]/0x100000000;
  }
  function syncDiceMeshes(box){
    for(const mesh of box.diceList||[]){if(mesh.body){mesh.position.copy(mesh.body.position);mesh.quaternion.copy(mesh.body.quaternion);}}
    box.renderer.render(box.scene,box.camera);
  }
  function forceDiceSettlement(box,reason='timeout'){
    const dice=box.diceList||[];box.running=false;box.rolling=false;
    for(const mesh of dice){
      if(mesh.body){mesh.position.copy(mesh.body.position);mesh.quaternion.copy(mesh.body.quaternion);mesh.body.type=4;}
      if(!mesh.result?.length)mesh.storeRolledValue?.(reason);
    }
    box.renderer.render(box.scene,box.camera);
    return dice.length?box.getDiceResults():null;
  }
  function watchDiceSettled(box,token,{stableMs=620,timeoutMs=5000}={}){
    return new Promise((resolve,reject)=>{
      const start=performance.now();let stableSince=0,raf=0;
      const stop=()=>{if(raf)cancelAnimationFrame(raf);};
      const tick=now=>{
        if(token!==diceBoxToken){stop();return reject(Object.assign(Error('3D 骰盘已关闭'),{name:'AbortError'}));}
        const dice=box.diceList||[];let moving=!dice.length;
        if(dice.length)moving=dice.some(mesh=>{const b=mesh.body;if(!b)return false;const sleeping=b.sleepState===2,lin=b.velocity?.length?.()??Infinity,ang=b.angularVelocity?.length?.()??Infinity;return !sleeping&&(lin>10||ang>.1);});
        if(!moving){if(!stableSince)stableSince=now;}else stableSince=0;
        const simulatedReady=dice.length&&dice.every(mesh=>mesh.result?.length);
        if(simulatedReady&&stableSince&&now-stableSince>=stableMs){
          const result=forceDiceSettlement(box,'stable');stop();return resolve(result);
        }
        if(now-start>=timeoutMs){
          const result=forceDiceSettlement(box,'timeout');stop();return resolve(result);
        }
        raf=requestAnimationFrame(tick);
      };raf=requestAnimationFrame(tick);
    });
  }
  function displayGrid(box,count){
    const cols=Math.max(1,Math.ceil(Math.sqrt(count))),rows=Math.ceil(count/cols),gap=Math.max(72,box.baseScale*1.65),out=[];
    for(let i=0;i<count;i++){const row=Math.floor(i/cols),col=i%cols,items=Math.min(cols,count-row*cols),x=(col-(items-1)/2)*gap,y=(row-(rows-1)/2)*gap*.72;out.push({x,y});}
    return out;
  }
  async function snapDiceDisplay(box,duration=460){
    const dice=box.diceList||[];if(!dice.length)return;
    syncDiceMeshes(box);const grid=displayGrid(box,dice.length),moves=dice.map((mesh,i)=>{
      const fromP=mesh.position.clone(),targetP=mesh.position.clone();targetP.x=grid[i].x;targetP.y=grid[i].y;
      if(mesh.body)mesh.body.type=4;return {mesh,fromP,targetP};
    });
    const start=performance.now();
    await new Promise(resolve=>{const tick=now=>{const t=Math.min(1,(now-start)/duration),ease=1-Math.pow(1-t,3);
      for(const m of moves)m.mesh.position.lerpVectors(m.fromP,m.targetP,ease);
      box.renderer.render(box.scene,box.camera);if(t<1)requestAnimationFrame(tick);else resolve();
    };requestAnimationFrame(tick);});
  }
  function placeStaticDice(box,plan){
    box.notationVectors=box.startClickThrow(plan.notation);if(!box.notationVectors||box.notationVectors.error)throw Error('无法建立静态骰子模型');
    box.clearDice();for(const vector of box.notationVectors.vectors||[])box.spawnDice(vector);box.simulateThrow();
    const desired=plan.forcedPhysical;
    for(let i=0;i<desired.length;i++){const mesh=box.diceList[i];if(!mesh)continue;if(Number(mesh.getLastValue?.().value)!==Number(desired[i]))box.swapDiceFace(mesh,desired[i]);}
    const dice=box.diceList||[],grid=displayGrid(box,dice.length);
    dice.forEach((mesh,i)=>{if(mesh.body){mesh.position.copy(mesh.body.position);mesh.quaternion.copy(mesh.body.quaternion);mesh.body.type=4;}mesh.position.x=grid[i].x;mesh.position.y=grid[i].y;});
    box.running=false;box.rolling=false;box.renderer.render(box.scene,box.camera);
  }
  async function rollDiceVisible(box,notation,readyMs=420){
    box.notationVectors=box.startClickThrow(notation);if(!box.notationVectors||box.notationVectors.error)throw Error('无法建立掷骰向量');
    box.clearDice();
    for(const vector of box.notationVectors.vectors||[])box.spawnDice(vector);
    // Show the actual starting dice before any physics steps are consumed.
    syncDiceMeshes(box);await new Promise(resolve=>setTimeout(resolve,readyMs));
    box.simulateThrow();box.steps=0;box.iteration=0;
    for(let i=0;i<box.diceList.length;i++)if(box.diceList[i])box.spawnDice(box.notationVectors.vectors[i],box.diceList[i]);
    box.rolling=true;box.running=Date.now();box.last_time=0;
    const thread=box.running;
    return new Promise(resolve=>box.animateThrow(thread,()=>resolve(box.getDiceResults())));
  }
  async function mountDice3D(specs,forced=null,{quiet=false,staticOnly=false}={}){
    const host=document.getElementById('manual-dice-3d'),Ctor=diceBoxCtor(),plan=dice3dPlan(specs,forced);
    if(!host||!Ctor||!plan.notation)return null;
    const physicalCount=plan.physicalCount,profile=diceViewProfile(Math.max(1,physicalCount));
    host.parentElement?.style.setProperty('--dice-tray-height',profile.tray+'px');
    const token=++diceBoxToken;host.innerHTML='';
    const box=new Ctor('#manual-dice-3d',{sounds:false,shadows:true,theme_surface:'green-felt',
      theme_customColorset:dice3dTheme(),theme_material:'metal',theme_texture:'',color_spotlight:0xd7ad58,
      light_intensity:.72,gravity_multiplier:420,baseScale:profile.scale,strength:quiet?Math.max(.45,profile.strength*.45):profile.strength,iterationLimit:1200});
    activeDiceBox=box;await box.initialize();if(token!==diceBoxToken)return null;host.classList.add('ready');

    // DiceBox's stock launcher has a relatively narrow random cone. Rebuild the launch vectors
    // with crypto-backed jitter so successive throws do not keep sharing similar trajectories.
    box.startClickThrow=function(notation){
      if(this.rolling){this.clearDice();this.rolling=false;}
      const w=this.display.currentWidth||this.display.containerWidth||300,h=this.display.currentHeight||this.display.containerHeight||200;
      let vx=(secureFloat()*2-1)*w,vy=(secureFloat()*2-1)*h;if(Math.abs(vx)<w*.12)vx+=(secureFloat()<.5?-1:1)*w*.18;if(Math.abs(vy)<h*.12)vy+=(secureFloat()<.5?-1:1)*h*.18;
      const dist=Math.hypot(vx,vy)+80,boost=(2.5+secureFloat()*2.15)*dist*this.strength,nv=this.getNotationVectors(notation,{x:vx,y:vy},boost,dist);
      const cw=this.display.containerWidth||w,ch=this.display.containerHeight||h;
      for(const v of nv.vectors||[]){
        // Start well inside the camera frustum so the player sees the ready state before the throw.
        v.pos.x=(secureFloat()-.5)*cw*.46;v.pos.y=(secureFloat()-.5)*ch*.42;v.pos.z=150+secureFloat()*180;
        const speed=.78+secureFloat()*.8;
        v.velocity.x=(secureFloat()*2-1)*Math.max(180,Math.abs(v.velocity.x))*speed;
        v.velocity.y=(secureFloat()*2-1)*Math.max(180,Math.abs(v.velocity.y))*speed;
        v.velocity.z=-8-secureFloat()*28;
        v.angle.x=(secureFloat()*2-1)*(18+secureFloat()*24);v.angle.y=(secureFloat()*2-1)*(18+secureFloat()*24);v.angle.z=(secureFloat()*2-1)*(8+secureFloat()*18);
        v.axis={x:secureFloat(),y:secureFloat(),z:secureFloat(),a:secureFloat()};
      }return nv;
    };

    const dims=box.display;if(dims&&profile.world>1){dims.containerWidth*=profile.world;dims.containerHeight*=profile.world;box.makeWorldBox();}
    const baseFar=box.cameraHeight?.far||box.camera.position.z,throwZ=baseFar*profile.camera,throwY=(box.display?.containerHeight||0)*profile.cameraLift;
    box.camera.position.z=throwZ;box.camera.position.y=throwY;box.camera.lookAt(0,0,0);box.renderer.render(box.scene,box.camera);

    if(staticOnly){
      if(!forced)throw Error('静态骰子缺少既定结果');
      placeStaticDice(box,plan);return {box,result:null,values:forced.slice(),static:true};
    }

    if(physicalCount>=4&&typeof box.vectorRand==='function'){
      const original=box.vectorRand.bind(box),spread=Math.min(.72,.12+physicalCount*.055);
      box.vectorRand=vector=>{const v=original(vector);v.x*=1+spread*(Math.random()-.5);v.y*=1+spread*(Math.random()-.5);return v;};
    }
    if(specs.some(s=>s.faces===100)&&box.world?.contactmaterials?.length){
      for(const cm of box.world.contactmaterials){cm.friction=Math.max(cm.friction||0,.7);cm.restitution=Math.min(cm.restitution??.5,.38);}
    }

    const rollPromise=rollDiceVisible(box,plan.notation,420),settledPromise=watchDiceSettled(box,token,{stableMs:620,timeoutMs:5000});
    let result;
    try{result=await Promise.race([rollPromise,settledPromise]);}
    catch(error){if(token!==diceBoxToken)return null;throw error;}
    if(token!==diceBoxToken)return null;

    const resultFactor=physicalCount<=1?1:physicalCount<=3?1.05:physicalCount<=6?1.12:physicalCount<=10?1.22:1.3;
    const resultZ=baseFar*resultFactor,resultY=throwY*.38;
    if(!quiet){await snapDiceDisplay(box,physicalCount>=7?520:430);await tweenDiceCamera(box,box.camera.position.z,resultZ,box.camera.position.y,resultY,physicalCount>=7?620:500);}
    return {box,result,values:plan.decode(result)};
  }
  function fallbackSlotValues(specs){
    return specs.filter(s=>s.constant===undefined).map(s=>secureDie(Number(s.faces)||1));
  }
  function diceDetailModal(e){
    if(!e||e.secret&&state.mode!=='debug')return;
    const args=diceDetailArgs(e),specs=diceSpecRows(args),d=e.data||{},storedRows=Array.isArray(d.rows)?d.rows:[],hasStoredRolls=storedRows.some(row=>Array.isArray(row.rolls)&&row.rolls.length>0),resolved=hasStoredRolls||e.pending!==true;
    const left=Object.values(args.left_modifiers||{}).reduce((n,v)=>n+(Number(v)||0),0),right=Object.values(args.right_modifiers||{}).reduce((n,v)=>n+(Number(v)||0),0);
    const baseTarget=Number.isFinite(Number(args.target_value))?Number(args.target_value):null,finalTarget=baseTarget===null?null:baseTarget+right;
    const compare=DICE_COMPARE[args.compare_mode]||'',special=resolved&&d.special&&d.critical;
    const resultText=resolved?(d.success==null?'仅计算':special?String(d.critical).replace(/^可能是/,''):(d.success?'通过':'不通过')):'等待检定';
    const resultClass=!resolved?'pending':d.success==null?'calculated':special?(String(d.critical).includes('失败')?'critical-fail':'critical-success'):(d.success?'success':'fail');
    const leftValue=!resolved?'?':d.mode==='independent'?'EACH':Number.isFinite(Number(d.total))?String(d.total):Number.isFinite(Number(d.raw))?String(d.raw):'?';
    const rawValue=resolved&&Number.isFinite(Number(d.raw))?String(d.raw):'?';
    const operator=args.calculate_only?'∑':special?'✦':compare||'?';
    const operatorCaption=args.calculate_only?'仅计算':special?'特殊判定':'比较';
    const targetMain=args.calculate_only?'—':finalTarget===null?'?':String(finalTarget);
    const targetSub=args.calculate_only?'不使用目标值':baseTarget===null?'目标值未知':right?`基础 ${baseTarget}　${signedModifier(right)}`:`基础 ${baseTarget}`;
    const leftSub=!resolved?'等待骰子落定':d.mode==='independent'?'各骰组独立结算':left?`原始 ${rawValue}　${signedModifier(left)}`:`原始 ${rawValue}`;
    const storedRolls=resolved?storedDiceRolls(storedRows):[],displayRolls=resolved?storedRolls:specs.filter(s=>s.constant===undefined).map(s=>Math.max(1,Number(s.faces)||1));
    const hasPhysical=specs.some(isPhysicalDiceSpec),fallback=fallbackDiceHTML(specs,displayRolls),stageClasses=[resolved?'is-resolved':'',fallback?'has-fallback':'',!hasPhysical?'fallback-only':''].filter(Boolean).join(' ');
    const physicalHost=hasPhysical?'<div id="manual-dice-3d" class="manual-dice-3d"><div class="dice3d-loading">正在准备 3D 骰盘…</div></div>':'';
    const fallbackHost=fallback?`<div id="manual-fallback-dice" class="manual-fallback-dice-layer">${fallback}</div>`:'';
    showModal(resolved?'检定结果':'进行检定',`<div class="manual-dice-modal" data-event-id="${esc(e.id)}"><div class="manual-dice-summary"><div><small>CHECK</small><strong>${esc(args.related_attr||e.relatedAttr||'检定')}</strong></div><span>${esc(args.dice_combine_mode||'sum').toUpperCase()}</span><em class="${esc(resultClass)}">${esc(resultText)}</em></div><div class="manual-compare-board"><section class="manual-value-panel source"><header><span>检定值</span><small>ROLL VALUE</small></header><div class="manual-value-art">${esc(leftValue)}</div><p>${esc(leftSub)}</p><div class="manual-dice-stage ${stageClasses}" id="manual-dice-stage">${physicalHost}${fallbackHost}<div class="manual-dice-labels">${specs.filter(s=>s.constant===undefined).map(s=>`<span><b>d${esc(s.faces)}</b><small>${esc((safeDiceLabel(s.label)||'骰子')+(s.faces===100?' · 百分骰双骰':s.faces===1?' · 双面均为 1':''))}</small></span>`).join('')}</div></div>${modifierLines(args.left_modifiers,'检定修正')}</section><div class="manual-operator" aria-label="${esc(operatorCaption)}"><small>${esc(operatorCaption)}</small><strong>${esc(operator)}</strong><i aria-hidden="true"></i></div><section class="manual-value-panel target"><header><span>目标值</span><small>TARGET</small></header><div class="manual-value-art">${esc(targetMain)}</div><p>${esc(targetSub)}</p>${modifierLines(args.right_modifiers,'目标修正')}<div class="manual-target-note">${baseTarget!==null&&!args.calculate_only?`<span>基础目标</span><strong>${esc(baseTarget)}</strong>${right?`<span>修正后</span><strong>${esc(finalTarget)}</strong>`:''}`:'<span>本次不进行目标比较</span>'}</div></section></div>${resolved?'<div class="modal-actions"><button type="button" data-action="close-modal">关闭</button></div>':`<div class="modal-actions"><button type="button" data-action="manual-dice-later">稍后决定</button><button type="button" class="primary" data-action="manual-dice-roll">进行检定</button></div>`}</div>`);
    const shell=modalRoot.querySelector('.modal'),body=shell?.querySelector('.modal-body'),summary=body?.querySelector('.manual-dice-summary'),actions=body?.querySelector('.manual-dice-modal>.modal-actions'),head=shell?.querySelector(':scope>header'),close=head?.querySelector('[data-action="close-modal"]');
    shell?.classList.add('manual-dice-shell');if(summary&&head)head.insertBefore(summary,close||null);if(actions&&shell){actions.classList.add('manual-dice-footer');actions.dataset.eventId=e.id;shell.appendChild(actions);}
    hydrateFallbackDice();
    if(hasPhysical)mountDice3D(specs,displayRolls,{quiet:true,staticOnly:true}).catch(error=>{
      const host=document.getElementById('manual-dice-3d');if(host)host.innerHTML='<div class="dice3d-fallback">'+esc(error.message||'3D 骰盘不可用')+'</div>';
    });
  }
  function secureDie(faces){
    if(!Number.isSafeInteger(faces)||faces<1||faces>1000000000)throw Error('骰面范围无效');
    if(faces===1)return 1;const range=0x100000000,limit=Math.floor(range/faces)*faces,buf=new Uint32Array(1);
    let value;do{crypto.getRandomValues(buf);value=buf[0];}while(value>=limit);return value%faces+1;
  }
  async function animateManualDice(event){
    const stage=document.getElementById('manual-dice-stage'),button=modalRoot.querySelector('[data-action="manual-dice-roll"]');if(!stage||!button)return;
    button.disabled=true;modalRoot.querySelector('[data-action="manual-dice-later"]')?.setAttribute('disabled','');modalRoot.querySelector('.manual-dice-shell')?.setAttribute('data-dice-rolling','true');stage.classList.add('rolling');
    const args=diceDetailArgs(event),specs=diceSpecRows(args),supported=specs.filter(isPhysicalDiceSpec);
    const fallbackPromise=animateFallbackDice(specs);
    const physicalPromise=(async()=>{
      if(!supported.length)return [];
      try{
        const rolled=await mountDice3D(specs,null,{quiet:false});
        if(!rolled)throw Error('3D 骰盘未能初始化');
        const values=rolled.values;if(values.some(v=>!Number.isFinite(v)))throw Error('3D 骰盘返回了无效结果');
        await new Promise(resolve=>setTimeout(resolve,650));return values;
      }catch(error){
        const values=supported.map(s=>secureDie(s.faces));
        const host=document.getElementById('manual-dice-3d');if(host)host.insertAdjacentHTML('beforeend','<div class="dice3d-warning">物理骰盘异常，已使用安全随机兜底</div>');
        await new Promise(resolve=>setTimeout(resolve,450));return values;
      }
    })();
    const [physicalValues,fallbackValues]=await Promise.all([physicalPromise,fallbackPromise]);
    let pi=0;const final=[];
    for(let i=0;i<specs.length;i++){
      const spec=specs[i];if(spec.constant!==undefined)continue;
      final.push(isPhysicalDiceSpec(spec)?physicalValues[pi++]:fallbackValues.get(i));
    }
    if(final.some(v=>!Number.isFinite(v)))throw Error('手动掷骰未能取得完整结果');
    await GameApp.resolveManualDice(final);
    modalRoot.querySelector('.manual-dice-shell')?.removeAttribute('data-dice-rolling');
    modalRoot.innerHTML='';activeDiceBox=null;diceBoxToken++;
    await GameApp.resume();
  }
  function changesModal() {
    const changes=state.active.lastChanges||[];
    showModal('最近一回合的文件改动',`<p class="muted">${state.running?'本轮进行中，以下为已发生的改动。':'文件改动已生效。这里保留最近一轮的记录。'}</p>${changes.map(c=>`<details class="change" open><summary><span class="change-kind ${esc(c.type)}">${{add:'新增',delete:'删除',modify:'修改'}[c.type]||esc(c.type)}</span> ${esc(c.path)}</summary>${c.binary?'<p>二进制内容已变更</p>':`<div class="diff-columns"><div><header>修改前</header><pre>${esc(c.before??'（不存在）')}</pre></div><div><header>修改后</header><pre>${esc(c.after??'（不存在）')}</pre></div></div>`}</details>`).join('')||'<div class="empty-pane"><span>≡</span><p>本轮没有文件改动</p></div>'}`);
  }
  async function action(name,el) {
    if(name==='close-modal'){if(modalRoot.querySelector('.manual-dice-shell[data-dice-rolling="true"]'))return toast('骰子正在结算，请等待结果');diceBoxToken++;activeDiceBox=null;modalRoot.innerHTML='';return;}
    if(name==='dice-detail'){const e=state.active?.events?.find(x=>x.id===el.dataset.eventId);if(e)return diceDetailModal(e);}
    if(name==='manual-dice-later'){modalRoot.innerHTML='';return;}
    if(name==='manual-dice-roll'){const eventId=el.closest('.manual-dice-footer')?.dataset.eventId||el.closest('.manual-dice-modal')?.dataset.eventId,e=state.active?.events?.find(x=>x.id===eventId);if(!e?.pending)return;return animateManualDice(e);}
    if(name==='api-key-settings'){settingsModal();const input=modalRoot.querySelector('input[name="apiKey"]');input?.focus();return;}
    if(name==='settings')return settingsModal();
    if(name==='fetch-models'){
      const form=document.getElementById('settings-form'),input=document.getElementById('model-input'),result=document.getElementById('model-list-result');
      const values=Object.fromEntries(new FormData(form));el.disabled=true;result.textContent='正在获取模型列表…';
      const clearList=()=>{input?.removeAttribute('list');document.getElementById('model-options')?.remove();};
      try{
        const response=await GameApp.listModels(values);clearList();
        if(response.models.length){
          const list=document.createElement('datalist');list.id='model-options';
          for(const id of response.models){const option=document.createElement('option');option.value=id;list.appendChild(option);}
          input.after(list);input.setAttribute('list',list.id);
        }
        result.textContent='获取成功 · '+response.count+' 个模型';
      }catch(error){clearList();result.textContent='获取失败：'+(error.message||String(error));}
      finally{el.disabled=false;}return;
    }
    if(name==='test-connection'){
      const form=document.getElementById('settings-form'),result=document.getElementById('connection-result');
      const values=Object.fromEntries(new FormData(form));el.disabled=true;result.textContent='正在测试连接…';
      try{const response=await GameApp.testConnection(values);result.textContent='连接成功 · '+response.elapsedMs+' ms';}
      catch(error){result.textContent='连接失败：'+(error.message||String(error));}
      finally{el.disabled=false;}return;
    }
    if(name==='test-world-list'){
      const input=document.getElementById('world-list-source'),result=document.getElementById('world-list-result');
      const source=input?.value.trim()||'';el.disabled=true;result.textContent='正在测试世界列表源…';
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),10000);
      try{
        const items=await GameCatalog.load({source,signal:ctrl.signal});
        result.textContent='测试成功 · 格式有效 · '+items.length+' 个世界';
      }catch(error){result.textContent='测试失败：'+(error.message||String(error));}
      finally{clearTimeout(timer);el.disabled=false;}return;
    }
    if(name==='reset-world-list'){
      const input=document.getElementById('world-list-source'),result=document.getElementById('world-list-result');
      if(input)input.value='';if(result)result.textContent='已恢复默认：'+GameCatalog.DEFAULT_SOURCE+'（保存后生效）';return;
    }
    if(name==='prompts')return promptModal();
    if(name==='changes')return changesModal();
    if(name==='context'){const context=await GameApp.currentContext(),sent=state.lastRequest&&state.lastRequestSaveId===state.active.id;return showModal(sent?'最近一次实际发送的上下文':'模型上下文预览',`${typeof GameCore!=='undefined'?`<p class="muted">估算上下文：${esc(GameCore.estimate(context))} tokens</p>`:''}<p class="muted">${sent?'这是最近一次模型请求实际发送的消息。':'本次打开尚无请求，以下为当前数据生成的预览。'}仅 DEBUG 可见。</p><pre class="context-content">${esc(json(context))}</pre>`);}
    if(name==='import')return importMenu();
    if(name==='import-file'){modalRoot.innerHTML='';const input=document.getElementById('zip-input');input.value='';return input.click();}
    if(name==='import-url')return showModal('从链接导入',`<form id="link-import-form"><label>ZIP 文件链接<input name="link" type="url" placeholder="https://…/world.zip" required></label><p class="muted">文件不超过 100 MB。链接需允许浏览器跨域下载。</p><div class="modal-actions">${button('import','返回')}<button type="submit" class="primary">开始导入</button></div></form>`);
    if(name==='catalog')return catalogPage();
    if(name==='module-detail')return moduleDetail(Number(el.dataset.index));
    if(name==='module-confirm')return startDownload(catalog[Number(el.dataset.index)].Link,catalog[Number(el.dataset.index)].Name);
    if(name.startsWith('mobile-')){mobile=name.slice(7);return render();}
    if(name==='play'||name==='debug'){closeFileMenu();return GameApp.setMode(name);}
    if(name==='open-save'){await GameApp.openSave(el.dataset.id);filePath='';fileDraft=fileOriginal='';draft=state.active?.draft||'';mobile='center';render();apiKeyWarning();return;}
    if(name==='home'){if(fileDraft!==fileOriginal&&!await appConfirm('文件有未保存改动，仍返回存档选择？',{title:'放弃未保存改动'}))return;clearTimeout(draftTimer);await GameApp.saveDraft(draft);await GameApp.closeSave();filePath='';fileDraft=fileOriginal='';draft='';return render();}
    if(name==='rename-save'){const text=await appPrompt('存档名称',el.dataset.name,{label:'名称'});if(text?.trim())await GameApp.renameSave(el.dataset.id,text.trim());return;}
    if(name==='delete-save'){if(await appConfirm('永久删除这份浏览器存档？',{title:'删除存档',confirmLabel:'永久删除',danger:true}))await GameApp.deleteSave(el.dataset.id);return;}
    if(name==='start'){if(!apiKeyWarning())return;return GameApp.start();}
    if(name==='resume'){if(state.active?.pendingManualDice){const e=state.active.events?.find(x=>x.id===state.active.pendingManualDice.eventId);if(e)return diceDetailModal(e);}if(!apiKeyWarning())return;return GameApp.resume();}
    if(name==='abort')return GameApp.abort();
    if(name==='rollback'){if(await appConfirm('回退至 '+GamePresentation.metadata(state.active.snapshots.at(-1))+'？文件、剧情和上下文将一起恢复。',{title:'确认回溯',confirmLabel:'回溯',danger:true})){clearTimeout(draftTimer);await GameApp.rollback();draft=state.active.draft||'';previousVitals={};render();const input=document.getElementById('action-input');if(input)input.value=draft;refreshInput();}return;}
    if(name==='export'){clearTimeout(draftTimer);await GameApp.saveDraft(draft);return download(await GameApp.exportSave(),state.active.name+'.zip');}
    if(name==='history-export')return download(new Blob(['\uFEFF',GamePresentation.historyHTML(state.active,markdown,GameApp.player())],{type:'text/html;charset=utf-8'}),GamePresentation.exportName(state.active));
    if(name==='history-dismiss'){clearTimeout(navTimer);scrollAmount=0;const nav=document.getElementById('history-navigation');nav?.classList.remove('active');nav?.classList.add('dismissed');if(nav?.contains(document.activeElement))document.activeElement.blur();return;}
    if(name.startsWith('history-'))return navigateHistory(name.slice(8));
    if(name==='toggle-vitals'){vitalsCollapsed=!vitalsCollapsed;try{localStorage.setItem('trpg-vitals-collapsed',String(vitalsCollapsed));}catch(_){}return updateVitals(GameApp.player().info);}
    if(name==='toggle-secondary'){secondaryVital=secondaryVital==='mp'?'san':'mp';return updateVitals(GameApp.player().info);}
    if(name==='open-file'){preview=false;fileSelection=el.dataset.path;if(fileDraft!==fileOriginal&&!await appConfirm('放弃当前文件的未保存改动？',{title:'放弃未保存改动'}))return;const value=await GameApp.readFile(el.dataset.path);filePath=el.dataset.path;fileDraft=fileOriginal=typeof value==='string'?value:value.content;mobile='left';return render();}
    if(name==='close-file'){preview=false;if(fileDraft!==fileOriginal&&!await appConfirm('放弃未保存改动？',{title:'放弃未保存改动'}))return;filePath='';fileDraft=fileOriginal='';return render();}
    if(name==='save-file'){await GameApp.writeFile(filePath,fileDraft);fileOriginal=fileDraft;render();return toast('文件已保存');}
    if(name==='create-file'||name==='mkdir'){const path=await appPrompt(name==='mkdir'?'新目录路径':'新文件路径','/workspace/',{label:'路径'});if(path)await GameApp.fileOperation(name==='mkdir'?'mkdir':'create',{path,content:''});return;}
    if(name==='file-more'){const r=el.getBoundingClientRect();return fileMenu(fileSelection||filePath||'/workspace',r.left,r.bottom);}
    if(name==='file-operation-dialog')return showModal('管理文件',`<form id="file-operation"><label>操作<select name="op"><option value="move">移动 / 重命名</option><option value="copy">复制</option><option value="delete">删除</option></select></label><label>原路径<input name="from" required value="${esc(filePath||'/workspace/')}" /></label><label>目标路径（删除时忽略）<input name="to" value="/workspace/" /></label><div class="modal-actions"><button class="primary" type="submit">执行</button></div></form>`);
    if(name==='save-prompt'){await GameApp.savePrompt(document.getElementById('prompt-select').value,document.getElementById('prompt-editor').value);return toast('提示词覆盖已保存');}
    if(name==='reset-prompt'){const id=document.getElementById('prompt-select').value;if(await appConfirm('恢复此提示词的打包默认内容？',{title:'恢复提示词',confirmLabel:'恢复'})){await GameApp.resetPrompt(id);promptModal(id);}return;}
    if(name==='reset-prompts'){if(await appConfirm('清除所有提示词覆盖并恢复默认？',{title:'恢复全部提示词',confirmLabel:'全部恢复',danger:true})){for(const p of GameApp.promptList())await GameApp.resetPrompt(p.id);promptModal();}return;}
  }
  async function boot() {
    try{vitalsCollapsed=localStorage.getItem('trpg-vitals-collapsed')==='true';}catch(_){}
    document.addEventListener('focusin',e=>{if(e.target.id==='action-input')refreshInput();});document.addEventListener('focusout',e=>{if(e.target.id==='action-input')setTimeout(refreshInput,0);});window.addEventListener('resize',refreshInput);
    document.addEventListener('scroll',e=>{if(e.target.id!=='history')return;const now=Date.now();scrollAmount=Math.max(0,scrollAmount-(now-lastScrollAt)*.5)+Math.abs(e.target.scrollTop-lastScroll);lastScroll=e.target.scrollTop;lastScrollAt=now;if(scrollAmount>=3000)revealNavigation();},true);
    root=document.getElementById('app');modalRoot=document.createElement('div');modalRoot.id='modal-root';document.body.append(modalRoot);dialogRoot=document.createElement('div');dialogRoot.id='dialog-root';document.body.append(dialogRoot);const notice=document.createElement('div');notice.id='toast';notice.setAttribute('role','status');notice.hidden=true;document.body.append(notice);
    document.addEventListener('pointerdown',e=>{pointerHeld=true;if(!e.target.closest('.file-context-menu'))closeFileMenu();});
    document.addEventListener('keydown',debugKey);
    document.addEventListener('contextmenu',e=>{if(state?.mode!=='debug'||!e.target.closest('.file-tree'))return;e.preventDefault();const row=e.target.closest('[data-path]');fileMenu(row?.dataset.path||'/workspace',e.clientX,e.clientY);});
    document.addEventListener('click',e=>{const row=e.target.closest('.file-tree [data-path]');if(row)selectFile(row.dataset.path);});
    let pressTimer,pressPoint;document.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'||state?.mode!=='debug'||!e.target.closest('.file-tree'))return;pressPoint={x:e.clientX,y:e.clientY};const p=e.target.closest('[data-path]')?.dataset.path||'/workspace';pressTimer=setTimeout(()=>fileMenu(p,pressPoint.x,pressPoint.y),550);});document.addEventListener('pointermove',e=>{if(pressPoint&&Math.hypot(e.clientX-pressPoint.x,e.clientY-pressPoint.y)>10)clearTimeout(pressTimer);});for(const type of ['pointerup','pointercancel'])document.addEventListener(type,()=>clearTimeout(pressTimer));document.addEventListener('pointerup',()=>{pointerHeld=false;});document.addEventListener('pointercancel',()=>{pointerHeld=false;});
    document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el&&!el.disabled)attempt(()=>action(el.dataset.action,el));});
    document.addEventListener('input',e=>{if(e.target.id==='action-input'){draft=e.target.value;refreshInput();const send=e.target.form.querySelector('button[type="submit"]');if(send&&!send.disabled)send.textContent=draft.trim()?'提交行动 ↗':'空过';clearTimeout(draftTimer);const id=state.active?.id;draftTimer=setTimeout(()=>{if(state.active?.id===id)attempt(()=>GameApp.saveDraft(draft));},250);}if(e.target.id==='file-editor'){fileDraft=e.target.value;document.getElementById('file-dirty').textContent=fileDraft===fileOriginal?'已保存':'有未保存改动';}});
    document.addEventListener('change',e=>{if(e.target.id==='prompt-select')promptModal(e.target.value);});
    document.addEventListener('mouseout',e=>{if(e.target.closest?.('#history-navigation.active')&&!e.relatedTarget?.closest?.('#history-navigation'))revealNavigation();});
    document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches?.('.dice-clickable')){e.preventDefault();e.target.click();return;}if(e.key==='Escape'&&dialogRoot?.firstChild){e.preventDefault();finishAppDialog(null);return;}if(e.key==='Escape'&&!modalRoot.querySelector('.manual-dice-stage.rolling'))modalRoot.innerHTML='';if(e.target.id==='action-input'&&e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();e.target.form.requestSubmit();}if(e.key==='Tab'&&(dialogRoot?.firstChild||modalRoot.firstChild)){const scope=dialogRoot?.firstChild?dialogRoot:modalRoot,nodes=[...scope.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(x=>!x.disabled);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    document.addEventListener('submit',e=>{e.preventDefault();attempt(async()=>{
      if(e.target.id==='link-import-form')return startDownload(new FormData(e.target).get('link'));
      if(e.target.id==='action-form'){if(state.running)return;if(!apiKeyWarning())return;const flags=GameData.actorState(GameApp.player().info);if(!flags.alive)return;if(!draft.trim()||!flags.enabled){if(await appConfirm(flags.enabled?'本回合不采取主动行动，确定空过？':'失去意识，等待局势发展并推进一轮？',{title:'推进回合',confirmLabel:'继续'})){forceHistoryBottom=true;await GameApp.skip();}return;}clearTimeout(draftTimer);const text=draft,count=(state.active.events||[]).filter(x=>x.type==='player').length,input=e.target.querySelector('#action-input');draft='';if(input){input.value='';refreshInput();}forceHistoryBottom=true;try{await GameApp.send(text);}catch(error){if((state.active.events||[]).filter(x=>x.type==='player').length===count){forceHistoryBottom=false;draft=text;await GameApp.saveDraft(text);}render();const restored=document.getElementById('action-input');if(restored&&restored.value!==draft){restored.value=draft;refreshInput();}throw error;}}
      if(e.target.id==='settings-form'){const data=new FormData(e.target),values={};for(const [k,v] of data)values[k]=['temperature','maxContextK','maxOutputTokens','maxToolLoops','httpTimeoutSeconds','maxRetries'].includes(k)?Number(v):v;values.stream=data.has('stream');values.manualDice=data.has('manualDice');const previousSource=state.settings?.worldListSource||'';await GameApp.updateSettings(values);const sourceChanged=previousSource!==(state.settings?.worldListSource||'');modalRoot.innerHTML='';if(sourceChanged)reloadCatalog();toast('设置已保存');}
      if(e.target.id==='file-operation'){const data=new FormData(e.target),op=data.get('op'),from=data.get('from'),to=data.get('to');if(op==='delete'&&!await appConfirm('删除 '+from+' 及其内容？',{title:'删除文件',confirmLabel:'删除',danger:true}))return;await GameApp.fileOperation(op,{path:from,from,to});if(filePath===from){filePath='';fileDraft=fileOriginal='';}modalRoot.innerHTML='';render();}
    });});
    try {await GameApp.init();state=GameApp.getState();GameApp.subscribe(next=>{state=next||GameApp.getState();if(!renderTimer)renderTimer=setTimeout(()=>{renderTimer=null;render();},50);});render();reloadCatalog();} catch(error){root.innerHTML=`<main class="save-home"><h1>启动未完成</h1><p>${esc(error.message)}</p><button onclick="location.reload()">重新载入</button></main>`;return;} finally {document.getElementById('boot')?.remove();}
    await attempt(async()=>{const link=GameCatalog.fromQuery(location.search);if(link!==null)await startDownload(link);});
  }
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();}
  return {visibleEvents,eventHTML,continuationHTML,runPhase,requestProgress};
})();
