'use strict';
const GameUI = (() => {
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const json = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '';
  const markdown = text => typeof MD !== 'undefined' ? MD.render(String(text || '')).replace(/<img\b[^>]*>/gi, '') : '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  function visibleEvents(events, mode) { return (events || []).filter(e => mode === 'debug' || !e.secret&&['player','story','round_end','dice','note'].includes(e.type)); }
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
            if(node!==document.activeElement&&node.value!==fresh.value)node.value=fresh.value;
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
  function eventHTML(e, mode) {
    const meta=typeof GamePresentation!=='undefined'?GamePresentation.metadata(e):'',content=typeof GamePresentation!=='undefined'&&typeof state!=='undefined'&&state?.active?GamePresentation.eventContent(state.active,e):e.content;
    if(e.type==='assistant'&&!String(e.content||'').trim()&&!String(e.reasoning||'').trim())return '';
    const details = (title, value) => `<details data-key="${esc('event:'+e.id+':'+title)}"><summary>${esc(title)}</summary><pre>${esc(json(value))}</pre></details>`;
    if (e.type === 'round_end') return `<div class="round-end"><span>回合结束：${esc(typeof GamePresentation!=='undefined'?GamePresentation.realTime(e.at):'')}</span></div>`;
    if (e.type === 'story') return `<article class="story"><header class="story-meta">${esc(typeof GamePresentation!=='undefined'?GamePresentation.metadata(e):'第 '+e.round+' 回合')}</header>${markdown(e.content)}</article>`;
    if (e.type === 'player') return `<article class="player-action"><header>${e.skip?'空过':'你'}${mode === 'debug' ? ' · player_action' : ''}<small class="event-meta">${esc(meta)}</small></header><div>${esc(content).replace(/\n/g,'<br>')}</div></article>`;
    if (e.type === 'note')return `<article class="story note"><header>注释 <small class="event-meta">${esc(meta)}</small></header>${markdown(content)}</article>`;
    if (e.type === 'dice') return `<article class="dice"><header>⚄ ${e.secret ? '暗骰' : '检定'}</header><small class="event-meta">${esc(meta)}</small>${content ? `<div>${esc(content)}</div>` : ''}${(e.data?.rows || []).map(r => `<div class="dice-row"><span>${esc(r.label || r.formula)}</span><strong>${esc(r.special?r.raw:r.total)}</strong><small>${esc(r.formula || '')}${r.special || r.success == null ? '' : r.success ? ' · 成功' : ' · 失败'}${r.critical ? ' · '+esc(r.critical) : ''}</small></div>`).join('')}${mode === 'debug' ? details('骰子数据',e.data || e) : ''}</article>`;
    if (e.type === 'tool') return `<article class="tool-event"><header><span class="tool-mark">ƒ</span> ${esc(e.name)} <small>${e.success === false ? '失败' : '工具调用'}</small></header>${details('参数',e.args)}${details('结果',e.result)}${e.fileChanges?.length?details('文件修改记录',e.fileChanges):''}</article>`;
    if (e.type === 'assistant') return `<article class="assistant-event"><header>模型回复</header>${e.reasoning ? details('模型返回的思考',e.reasoning) : ''}${markdown(e.content)}</article>`;
    return `<article class="error-event"><header>${esc(e.type)}</header><pre>${esc(json(e.content || e))}</pre></article>`;
  }
  let state, root, modalRoot, draft = '', filePath = '', fileDraft = '', fileOriginal = '', mobile = 'center', toastTimer, renderTimer, draftTimer, pointerHeld=false;
  let viewSave=null,previousVitals={},secondaryVital='mp',renderedSecondary=null,vitalsCollapsed=false,scrollAmount=0,lastScroll=0,lastScrollAt=0,navTimer;
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
    if(cmd==='new'||cmd==='folder'){const name=prompt(cmd==='new'?'新文件名称':'新目录名称',cmd==='new'?'新文件.md':'新目录');if(!name)return;if(/[\\/]/.test(name)||['.','..'].includes(name))throw Error('请输入名称，不包含路径');const target=dir+'/'+name;await GameApp.fileOperation(cmd==='new'?'create':'mkdir',{path:target,content:''});selectFile(target);if(cmd==='new')await action('open-file',{dataset:{path:target}});return;}
    if(cmd==='rename'){const name=prompt('重命名',n.name);if(!name||name===n.name)return;if(/[\\/]/.test(name)||['.','..'].includes(name))throw Error('名称不能包含路径');const to=parentPath(p)+'/'+name;await GameApp.fileOperation('move',{from:p,to});if(filePath===p||filePath.startsWith(p+'/'))filePath=to+filePath.slice(p.length);selectFile(to);render();return;}
    if(cmd==='delete'){if(!confirm('删除 '+p+' 及其内容？'))return;await GameApp.fileOperation('delete',{path:p});if(filePath===p||filePath.startsWith(p+'/')){filePath='';fileDraft=fileOriginal='';}selectFile(parentPath(p));render();return;}
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
    const desired=document.createElement('template');desired.innerHTML=`<header class="topbar"><div class="brand"><span class="brand-seal" aria-label="骰子">⚄</span><div>异闻手记<small>${a?esc(a.name):'一人，一卷，尚未写下的故事'}</small></div></div><nav>${a ? button('home','切换存档')+`<div class="mode-switch" aria-label="展示方式">${button('play','游戏模式',`aria-pressed="${s.mode!=='debug'}"`)}${button('debug','调试模式',`aria-pressed="${s.mode==='debug'}"`)}</div>` : ''}${button('settings','⚙','class="settings-icon" aria-label="设置" title="设置"')}</nav></header>${s.storageWarning?`<div class="notice">${esc(s.storageWarning)}</div>`:''}${a ? gameHTML() : chooserHTML()}<input id="zip-input" type="file" accept=".zip,.png,application/zip,image/png" hidden>`;
    patchDOM(root,desired.content);
    root.querySelector('#zip-input').onchange=e=>{ const f=e.target.files[0]; if(f)attempt(async()=>{await GameApp.importSave(f);filePath='';fileDraft=fileOriginal='';draft=state.active?.draft||'';render();}); };
    const next=root.querySelector('#history');if(next&&next.scrollHeight!==oldHeight)next.scrollTop=nearBottom&&!pointerHeld?next.scrollHeight:oldScroll;
    if(a&&s.mode!=='debug')updateVitals(GameApp.player().info);
    refreshInput();
    if(preview&&filePath){const ta=document.getElementById('file-editor');if(ta){const pane=document.createElement('div');pane.id='file-preview';pane.tabIndex=0;pane.className='panel-scroll';pane.innerHTML=markdown(fileDraft);ta.replaceWith(pane);pane.focus();}}
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
      if(!src||!el.isConnected)return;
      const img=document.createElement('img');img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.src=src;
      el.replaceChildren(img);el.hidden=false;el.closest('.module-card')?.classList.add('has-cover');
    });
  }
  function hydrateFallbackCovers(scope=modalRoot){
    const nodes=[...scope.querySelectorAll('.module-cover[data-cover-index]')];if(!nodes.length)return;
    if('IntersectionObserver'in globalThis){
      coverObserver?.disconnect();coverObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){coverObserver.unobserve(entry.target);applyFallbackCover(entry.target);}},{root:null,rootMargin:'320px'});
      for(const node of nodes)coverObserver.observe(node);
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
  async function startDownload(link,name){GameCatalog.url(link);modalRoot.innerHTML='';await GameApp.importLink(link,name);filePath='';fileDraft=fileOriginal='';draft=state.active?.draft||'';mobile='center';render();}
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
    const apiKey=`<label class="api-key-setting"><span>API Key</span><div class="api-key-control"><input name="apiKey" type="password" value="${esc(s.apiKey??'')}" autocomplete="off">${button('test-connection','测试连接')}</div><small id="connection-result" class="settings-field-result" role="status"></small></label>`;
    const api=`<div class="settings-grid">${field('baseUrl','API 地址','url')}${field('model','模型')}${apiKey}${field('temperature','Temperature','number',0.8)}${field('maxContextK','上下文上限（K tokens）','number',128)}${field('maxOutputTokens','最大输出 tokens','number',16384)}${field('maxToolLoops','每轮最大模型调用次数','number',60)}${field('httpTimeoutSeconds','请求超时（秒）','number',180)}${field('maxRetries','重试次数','number',2)}<label>思考强度<select name="reasoningEffort">${['none','low','high','xhigh','max'].map(v=>`<option ${s.reasoningEffort===v?'selected':''}>${v}</option>`).join('')}</select></label><label class="check-label stream-setting"><input name="stream" type="checkbox" ${s.stream!==false?'checked':''}><span>流式输出<small>用于缓解长时间输出文本的超时问题；不一定能使故事输出本身变为流式。</small></span></label></div>`;
    const game='<div class="settings-section-empty" aria-hidden="true"></div>';
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
  function changesModal() {
    const changes=state.active.lastChanges||[];
    showModal('最近一回合的文件改动',`<p class="muted">${state.running?'本轮进行中，以下为已发生的改动。':'文件改动已生效。这里保留最近一轮的记录。'}</p>${changes.map(c=>`<details class="change" open><summary><span class="change-kind ${esc(c.type)}">${{add:'新增',delete:'删除',modify:'修改'}[c.type]||esc(c.type)}</span> ${esc(c.path)}</summary>${c.binary?'<p>二进制内容已变更</p>':`<div class="diff-columns"><div><header>修改前</header><pre>${esc(c.before??'（不存在）')}</pre></div><div><header>修改后</header><pre>${esc(c.after??'（不存在）')}</pre></div></div>`}</details>`).join('')||'<div class="empty-pane"><span>≡</span><p>本轮没有文件改动</p></div>'}`);
  }
  async function action(name,el) {
    if(name==='close-modal'){modalRoot.innerHTML='';return;}
    if(name==='settings')return settingsModal();
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
    if(name==='open-save'){await GameApp.openSave(el.dataset.id);filePath='';fileDraft=fileOriginal='';draft=state.active?.draft||'';mobile='center';return render();}
    if(name==='home'){if(fileDraft!==fileOriginal&&!confirm('文件有未保存改动，仍返回存档选择？'))return;clearTimeout(draftTimer);await GameApp.saveDraft(draft);await GameApp.closeSave();filePath='';fileDraft=fileOriginal='';draft='';return render();}
    if(name==='rename-save'){const text=prompt('存档名称',el.dataset.name);if(text?.trim())await GameApp.renameSave(el.dataset.id,text.trim());return;}
    if(name==='delete-save'){if(confirm('永久删除这份浏览器存档？'))await GameApp.deleteSave(el.dataset.id);return;}
    if(name==='start')return GameApp.start();
    if(name==='resume')return GameApp.resume();
    if(name==='abort')return GameApp.abort();
    if(name==='rollback'){if(confirm('回退至 '+GamePresentation.metadata(state.active.snapshots.at(-1))+'？文件、剧情和上下文将一起恢复。')){clearTimeout(draftTimer);await GameApp.rollback();draft=state.active.draft||'';previousVitals={};render();const input=document.getElementById('action-input');if(input)input.value=draft;refreshInput();}return;}
    if(name==='export'){clearTimeout(draftTimer);await GameApp.saveDraft(draft);return download(await GameApp.exportSave(),state.active.name+'.zip');}
    if(name==='history-export')return download(new Blob(['\uFEFF',GamePresentation.historyHTML(state.active,markdown,GameApp.player())],{type:'text/html;charset=utf-8'}),GamePresentation.exportName(state.active));
    if(name==='history-dismiss'){clearTimeout(navTimer);scrollAmount=0;const nav=document.getElementById('history-navigation');nav?.classList.remove('active');nav?.classList.add('dismissed');if(nav?.contains(document.activeElement))document.activeElement.blur();return;}
    if(name.startsWith('history-'))return navigateHistory(name.slice(8));
    if(name==='toggle-vitals'){vitalsCollapsed=!vitalsCollapsed;try{localStorage.setItem('trpg-vitals-collapsed',String(vitalsCollapsed));}catch(_){}return updateVitals(GameApp.player().info);}
    if(name==='toggle-secondary'){secondaryVital=secondaryVital==='mp'?'san':'mp';return updateVitals(GameApp.player().info);}
    if(name==='open-file'){preview=false;fileSelection=el.dataset.path;if(fileDraft!==fileOriginal&&!confirm('放弃当前文件的未保存改动？'))return;const value=await GameApp.readFile(el.dataset.path);filePath=el.dataset.path;fileDraft=fileOriginal=typeof value==='string'?value:value.content;mobile='left';return render();}
    if(name==='close-file'){preview=false;if(fileDraft!==fileOriginal&&!confirm('放弃未保存改动？'))return;filePath='';fileDraft=fileOriginal='';return render();}
    if(name==='save-file'){await GameApp.writeFile(filePath,fileDraft);fileOriginal=fileDraft;render();return toast('文件已保存');}
    if(name==='create-file'||name==='mkdir'){const path=prompt(name==='mkdir'?'新目录路径':'新文件路径','/workspace/');if(path)await GameApp.fileOperation(name==='mkdir'?'mkdir':'create',{path,content:''});return;}
    if(name==='file-more'){const r=el.getBoundingClientRect();return fileMenu(fileSelection||filePath||'/workspace',r.left,r.bottom);}
    if(name==='file-operation-dialog')return showModal('管理文件',`<form id="file-operation"><label>操作<select name="op"><option value="move">移动 / 重命名</option><option value="copy">复制</option><option value="delete">删除</option></select></label><label>原路径<input name="from" required value="${esc(filePath||'/workspace/')}" /></label><label>目标路径（删除时忽略）<input name="to" value="/workspace/" /></label><div class="modal-actions"><button class="primary" type="submit">执行</button></div></form>`);
    if(name==='save-prompt'){await GameApp.savePrompt(document.getElementById('prompt-select').value,document.getElementById('prompt-editor').value);return toast('提示词覆盖已保存');}
    if(name==='reset-prompt'){const id=document.getElementById('prompt-select').value;if(confirm('恢复此提示词的打包默认内容？')){await GameApp.resetPrompt(id);promptModal(id);}return;}
    if(name==='reset-prompts'){if(confirm('清除所有提示词覆盖并恢复默认？')){for(const p of GameApp.promptList())await GameApp.resetPrompt(p.id);promptModal();}return;}
  }
  async function boot() {
    try{vitalsCollapsed=localStorage.getItem('trpg-vitals-collapsed')==='true';}catch(_){}
    document.addEventListener('focusin',e=>{if(e.target.id==='action-input')refreshInput();});document.addEventListener('focusout',e=>{if(e.target.id==='action-input')setTimeout(refreshInput,0);});window.addEventListener('resize',refreshInput);
    document.addEventListener('scroll',e=>{if(e.target.id!=='history')return;const now=Date.now();scrollAmount=Math.max(0,scrollAmount-(now-lastScrollAt)*.5)+Math.abs(e.target.scrollTop-lastScroll);lastScroll=e.target.scrollTop;lastScrollAt=now;if(scrollAmount>=3000)revealNavigation();},true);
    root=document.getElementById('app');modalRoot=document.createElement('div');modalRoot.id='modal-root';document.body.append(modalRoot);const notice=document.createElement('div');notice.id='toast';notice.setAttribute('role','status');notice.hidden=true;document.body.append(notice);
    document.addEventListener('pointerdown',e=>{pointerHeld=true;if(!e.target.closest('.file-context-menu'))closeFileMenu();});
    document.addEventListener('keydown',debugKey);
    document.addEventListener('contextmenu',e=>{if(state?.mode!=='debug'||!e.target.closest('.file-tree'))return;e.preventDefault();const row=e.target.closest('[data-path]');fileMenu(row?.dataset.path||'/workspace',e.clientX,e.clientY);});
    document.addEventListener('click',e=>{const row=e.target.closest('.file-tree [data-path]');if(row)selectFile(row.dataset.path);});
    let pressTimer,pressPoint;document.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'||state?.mode!=='debug'||!e.target.closest('.file-tree'))return;pressPoint={x:e.clientX,y:e.clientY};const p=e.target.closest('[data-path]')?.dataset.path||'/workspace';pressTimer=setTimeout(()=>fileMenu(p,pressPoint.x,pressPoint.y),550);});document.addEventListener('pointermove',e=>{if(pressPoint&&Math.hypot(e.clientX-pressPoint.x,e.clientY-pressPoint.y)>10)clearTimeout(pressTimer);});for(const type of ['pointerup','pointercancel'])document.addEventListener(type,()=>clearTimeout(pressTimer));document.addEventListener('pointerup',()=>{pointerHeld=false;});document.addEventListener('pointercancel',()=>{pointerHeld=false;});
    document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el&&!el.disabled)attempt(()=>action(el.dataset.action,el));});
    document.addEventListener('input',e=>{if(e.target.id==='action-input'){draft=e.target.value;refreshInput();const send=e.target.form.querySelector('button[type="submit"]');if(send&&!send.disabled)send.textContent=draft.trim()?'提交行动 ↗':'空过';clearTimeout(draftTimer);const id=state.active?.id;draftTimer=setTimeout(()=>{if(state.active?.id===id)attempt(()=>GameApp.saveDraft(draft));},250);}if(e.target.id==='file-editor'){fileDraft=e.target.value;document.getElementById('file-dirty').textContent=fileDraft===fileOriginal?'已保存':'有未保存改动';}});
    document.addEventListener('change',e=>{if(e.target.id==='prompt-select')promptModal(e.target.value);});
    document.addEventListener('mouseout',e=>{if(e.target.closest?.('#history-navigation.active')&&!e.relatedTarget?.closest?.('#history-navigation'))revealNavigation();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')modalRoot.innerHTML='';if(e.target.id==='action-input'&&e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();e.target.form.requestSubmit();}if(e.key==='Tab'&&modalRoot.firstChild){const nodes=[...modalRoot.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(x=>!x.disabled);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    document.addEventListener('submit',e=>{e.preventDefault();attempt(async()=>{
      if(e.target.id==='link-import-form')return startDownload(new FormData(e.target).get('link'));
      if(e.target.id==='action-form'){if(state.running)return;const flags=GameData.actorState(GameApp.player().info);if(!flags.alive)return;if(!draft.trim()||!flags.enabled){if(confirm(flags.enabled?'本回合不采取主动行动，确定空过？':'失去意识，等待局势发展并推进一轮？'))await GameApp.skip();return;}clearTimeout(draftTimer);const text=draft,count=(state.active.events||[]).filter(x=>x.type==='player').length;draft='';try{await GameApp.send(text);}catch(error){if((state.active.events||[]).filter(x=>x.type==='player').length===count){draft=text;await GameApp.saveDraft(text);}render();throw error;}}
      if(e.target.id==='settings-form'){const data=new FormData(e.target),values={};for(const [k,v] of data)values[k]=['temperature','maxContextK','maxOutputTokens','maxToolLoops','httpTimeoutSeconds','maxRetries'].includes(k)?Number(v):v;values.stream=data.has('stream');const previousSource=state.settings?.worldListSource||'';await GameApp.updateSettings(values);const sourceChanged=previousSource!==(state.settings?.worldListSource||'');modalRoot.innerHTML='';if(sourceChanged)reloadCatalog();toast('设置已保存');}
      if(e.target.id==='file-operation'){const data=new FormData(e.target),op=data.get('op'),from=data.get('from'),to=data.get('to');if(op==='delete'&&!confirm('删除 '+from+' 及其内容？'))return;await GameApp.fileOperation(op,{path:from,from,to});if(filePath===from){filePath='';fileDraft=fileOriginal='';}modalRoot.innerHTML='';render();}
    });});
    try {await GameApp.init();state=GameApp.getState();GameApp.subscribe(next=>{state=next||GameApp.getState();if(!renderTimer)renderTimer=setTimeout(()=>{renderTimer=null;render();},50);});render();reloadCatalog();} catch(error){root.innerHTML=`<main class="save-home"><h1>启动未完成</h1><p>${esc(error.message)}</p><button onclick="location.reload()">重新载入</button></main>`;return;} finally {document.getElementById('boot')?.remove();}
    await attempt(async()=>{const link=GameCatalog.fromQuery(location.search);if(link!==null)await startDownload(link);});
  }
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();}
  return {visibleEvents,eventHTML,continuationHTML,runPhase,requestProgress};
})();
