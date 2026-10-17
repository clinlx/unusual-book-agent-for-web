'use strict';
// Self-contained factory: the offline archive embeds this exact renderer.
function createNodeMap(){
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function snapshot(value,currentId){
    if(typeof currentId!=='string')throw Error('current_id 必须显式填写字符串；不高亮时填空串');
    if(!Array.isArray(value))throw Error('节点地图必须是元素列表（JSON 数组）');
    const ids=new Set();
    for(const [i,n] of value.entries()){
      if(!n||typeof n!=='object'||Array.isArray(n))throw Error('节点 '+i+' 必须是对象');
      for(const key of ['ID','表面名字'])if(typeof n[key]!=='string'||!n[key].trim())throw Error('节点 '+i+' 的 '+key+' 不能为空串');
      if(ids.has(n.ID))throw Error('节点 ID 重复：'+n.ID);ids.add(n.ID);
      for(const key of ['表面描述','剧情笔记'])if(typeof n[key]!=='string')throw Error(n.ID+' 的 '+key+' 必须是字符串');
      if(typeof n.是否隐藏!=='boolean')throw Error(n.ID+' 的 是否隐藏 必须是布尔值');
      if(!Array.isArray(n.连通性)||n.连通性.some(id=>typeof id!=='string'||!id.trim()))throw Error(n.ID+' 的 连通性 必须是目标 ID 字符串数组');
      const p=n.位置参考坐标;
      if(p!==undefined&&(p===null||Array.isArray(p)||typeof p!=='object'||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1e9||Math.abs(p.y)>1e9))throw Error(n.ID+' 的位置参考坐标须为有限数值 {x,y}（绝对值不超过 1e9），无坐标时省略');
    }
    for(const n of value)for(const id of n.连通性)if(!ids.has(id))throw Error(n.ID+' 的连通性指向不存在的 ID：'+id);
    if(currentId&&!ids.has(currentId))throw Error('当前位置 ID 不存在：'+currentId);
    if(currentId&&value.find(n=>n.ID===currentId).是否隐藏)throw Error('当前位置仍被隐藏；确认可以公开后将 是否隐藏 改为 false 再展示');
    const visible=value.filter(n=>!n.是否隐藏),shown=new Set(visible.map(n=>n.ID)),links=new Map(visible.map(n=>[n.ID,new Set(n.连通性.filter(id=>shown.has(id)))]));
    const nodes=visible.map(n=>({id:n.ID,name:n.表面名字,description:n.表面描述,...(n.位置参考坐标?{x:n.位置参考坐标.x,y:n.位置参考坐标.y}:{})}));
    const edges=[];for(const n of visible)for(const to of links.get(n.ID)){const mutual=links.get(to).has(n.ID);if(mutual&&n.ID>to)continue;edges.push({from:n.ID,to,directed:!mutual});}
    return {nodes,edges,currentId};
  }
  // Whitelist again at delivery boundaries; imported event extensions never reach players.
  function publicSnapshot(s){
    const source=Array.isArray(s?.nodes)?s.nodes:[],nodes=source.filter(n=>n&&n.hidden!==true&&n.是否隐藏!==true&&typeof n.id==='string'&&typeof n.name==='string').map(n=>({id:n.id,name:n.name,description:typeof n.description==='string'?n.description:'',...(Number.isFinite(n.x)&&Number.isFinite(n.y)?{x:n.x,y:n.y}:{})}));
    const ids=new Set(nodes.map(n=>n.id));return {nodes,edges:(Array.isArray(s?.edges)?s.edges:[]).filter(e=>e&&ids.has(e.from)&&ids.has(e.to)).map(e=>({from:e.from,to:e.to,directed:e.directed===true})),currentId:ids.has(s?.currentId)?s.currentId:''};
  }
  function matchLocation(input,location){
    const nodes=publicSnapshot(input).nodes;
    const exact=value=>{
      if(typeof value!=='string'||!value.trim())return null;
      value=value.trim();const byId=nodes.filter(n=>n.id===value);
      if(byId.length===1)return byId[0].id;
      const byName=nodes.filter(n=>n.name===value);return byName.length===1?byName[0].id:null;
    };
    const match=value=>{
      const direct=exact(value);if(direct||typeof value!=='string')return direct;
      const parts=value.trim().replace(/\\/g,'/').split('/').filter(Boolean);
      if(parts.length<2)return null;
      if(/^(场景台本|场景信息|基础信息)\.json$/.test(parts.at(-1)))parts.pop();
      return exact(parts.at(-1));
    };
    if(typeof location==='string')return match(location);
    if(!location||typeof location!=='object'||Array.isArray(location))return null;
    for(const key of ['ID','id','节点ID','地点ID','场景ID','路径','path','表面名字','名称','name']){
      const id=match(location[key]);if(id)return id;
    }
    return null;
  }
  function focus(input,currentId){
    const s=publicSnapshot(input);if(s.nodes.some(n=>n.id===currentId))s.currentId=currentId;return s;
  }
  function layout(input){
    const s=publicSnapshot(input),anchors=s.nodes.filter(n=>Number.isFinite(n.x));
    // Coordinates describe relative positions, not CSS pixels. Normalize units before
    // placing missing nodes so a 1-unit map behaves like the same map in metres.
    const nearest=anchors.map(n=>Math.min(...anchors.filter(p=>p!==n&&(p.x!==n.x||p.y!==n.y)).map(p=>Math.hypot(p.x-n.x,p.y-n.y)))).filter(Number.isFinite).sort((a,b)=>a-b);
    const unit=nearest.length?220/nearest[Math.floor(nearest.length/2)]:1,origin=anchors.length?{x:anchors[0].x,y:anchors[0].y}:{x:0,y:0},occupied=new Set();
    for(const n of anchors){const key=n.x+','+n.y;if(occupied.has(key)){delete n.x;delete n.y;}else{occupied.add(key);n.x=(n.x-origin.x)*unit;n.y=(n.y-origin.y)*unit;}}
    const placed=s.nodes.filter(n=>Number.isFinite(n.x)),pending=s.nodes.filter(n=>!Number.isFinite(n.x));
    const adjacency=new Map(s.nodes.map(n=>[n.id,new Set()]));for(const e of s.edges){adjacency.get(e.from).add(e.to);adjacency.get(e.to).add(e.from);}
    const neighbors=id=>adjacency.get(id);
    const cross=(a,b,c,d)=>{const side=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);return side(a,b,c)*side(a,b,d)<0&&side(c,d,a)*side(c,d,b)<0;};
    while(pending.length){
      const byId=new Map(placed.map(n=>[n.id,n])),degree=n=>[...neighbors(n.id)].filter(id=>byId.has(id)).length;
      pending.sort((a,b)=>degree(b)-degree(a));
      const n=pending.shift(),near=placed.filter(p=>neighbors(n.id).has(p.id)),anchor=near.length?near:placed;
      const existingEdges=s.edges.filter(e=>byId.has(e.from)&&byId.has(e.to)).map(e=>[byId.get(e.from),byId.get(e.to)]);
      const center=anchor.length?{x:anchor.reduce((v,p)=>v+p.x,0)/anchor.length,y:anchor.reduce((v,p)=>v+p.y,0)/anchor.length}:{x:0,y:0};
      let best=center,score=Infinity;
      for(let ring=0;ring<=Math.ceil(Math.sqrt(placed.length))+3;ring++)for(let k=0;k<(ring?24:1);k++){
        const angle=k*Math.PI/12+(ring%2)*Math.PI/24,p={x:center.x+ring*220*Math.cos(angle),y:center.y+ring*220*Math.sin(angle)};
        if(placed.some(q=>Math.abs(p.x-q.x)<270&&Math.abs(p.y-q.y)<85))continue;
        const distances=near.map(q=>Math.hypot(p.x-q.x,p.y-q.y)),mean=distances.reduce((v,d)=>v+d,0)/(distances.length||1);
        let cost=distances.reduce((v,d)=>v+(d-180)**2,0)+distances.reduce((v,d)=>v+(d-mean)**2,0)+Math.hypot(p.x-center.x,p.y-center.y);
        for(const q of near)for(const [a,b] of existingEdges){if(a===q||b===q)continue;if(cross(p,q,a,b))cost+=150000;}
        if(cost<score){score=cost;best=p;}
      }
      Object.assign(n,best);placed.push(n);
    }
    return s;
  }
  function fitView(graph,width,height){
    const nodes=graph.nodes,px=Math.min(140,width*.22),top=44,bottom=60;
    const xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y),left=nodes.length?Math.min(...xs):0,right=nodes.length?Math.max(...xs):0,up=nodes.length?Math.min(...ys):0,down=nodes.length?Math.max(...ys):0;
    const sx=right>left?Math.max(1,width-2*px)/(right-left):Infinity,sy=down>up?Math.max(1,height-top-bottom)/(down-up):Infinity;
    const scale=Number.isFinite(Math.min(sx,sy))?Math.min(sx,sy):1;
    return {scale,baseScale:scale,tx:width/2-(left+right)/2*scale,ty:(height+top-bottom)/2-(up+down)/2*scale};
  }
  function project(graph,view){
    const size=Math.max(.8,Math.min(1.4,(view.scale/view.baseScale)**.2));
    return {nodes:graph.nodes.map(n=>({...n,x:n.x*view.scale+view.tx,y:n.y*view.scale+view.ty})),radius:8*size,activeRadius:12*size,ringRadius:18*size,fontSize:14*size};
  }
  function card(input,{archive=false}={}){
    const s=publicSnapshot(input),data=esc(JSON.stringify(s));
    return `<article class="node-map-card${archive?' dice-clickable':''}" data-node-map="${data}" role="button" tabindex="0" aria-label="查看地图快照"><header><span>◇ 地图</span><small>${archive?'长按 3 秒查看':'点击查看'} ↗</small></header><canvas class="node-map-preview" aria-label="地点与路径预览"></canvas><p class="node-map-caption">${esc(s.nodes.find(n=>n.id===s.currentId)?.name||'地点概览')}</p></article>`;
  }
  function mount(canvas,input,{interactive=false,onSelect=()=>{}}={}){
    const s=layout(input),ctx=canvas.getContext('2d');if(!ctx)return ()=>{};
    let scale=1,baseScale=1,tx=0,ty=0,width=0,height=0,ready=false,disposed=false,hover=null,screen=null,labels=[];
    const events=new AbortController(),signal=events.signal,pointers=new Map();let gesture=null;
    function fit(){({scale,baseScale,tx,ty}=fitView(s,width,height));draw();}
    const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
    function placeLabels(){
      const font=screen.fontSize,lineHeight=font+3;ctx.font=font+'px serif';labels=[];
      const obstacles=screen.nodes.map(n=>({x:n.x-21,y:n.y-21,w:42,h:42}));
      for(const n of [...screen.nodes].sort((a,b)=>Number(b.id===s.currentId)-Number(a.id===s.currentId))){
        if(n.x<0||n.x>width||n.y<0||n.y>height)continue;
        const text=n.name.length>24?n.name.slice(0,23)+'…':n.name,maxWidth=Math.min(180,width-24),lines=[''];
        for(const char of text){const i=lines.length-1;if(lines[i]&&ctx.measureText(lines[i]+char).width>maxWidth)lines.push(char);else lines[i]+=char;}
        const w=Math.max(...lines.map(line=>ctx.measureText(line).width))+8,h=lines.length*lineHeight+4,gap=screen.ringRadius+7;
        const candidates=[{x:n.x-w/2,y:n.y+gap},{x:n.x-w/2,y:n.y-gap-h},{x:n.x+gap,y:n.y-h/2},{x:n.x-gap-w,y:n.y-h/2}];
        for(let row=1;row<=4;row++)for(const sign of [-1,1])for(const dx of [-w/2,0,w/2])candidates.push({x:n.x-w/2+dx,y:n.y+sign*(gap+row*(h+6))-(sign<0?h:0)});
        let best=null,bestScore=Infinity;
        for(const candidate of candidates){const box={x:Math.max(6,Math.min(width-w-6,candidate.x)),y:Math.max(6,Math.min(height-h-6,candidate.y)),w,h};
          const score=[...obstacles,...labels].reduce((sum,r)=>sum+overlap(box,r)*100,0)+Math.hypot(box.x+w/2-n.x,box.y+h/2-n.y);
          if(score<bestScore){bestScore=score;best=box;}
        }
        labels.push({...best,node:n,lines,lineHeight});
      }
    }
    function draw(){
      if(disposed)return;const dpr=Math.min(globalThis.devicePixelRatio||1,2);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
      // Transform node positions only. Symbols, text, arrows and hit areas use screen pixels.
      screen=project(s,{scale,baseScale,tx,ty});const byId=new Map(screen.nodes.map(n=>[n.id,n]));
      ctx.lineWidth=1.5;ctx.strokeStyle='#968260';ctx.fillStyle='#968260';
      for(const e of s.edges){const a=byId.get(e.from),b=byId.get(e.to);if(!a||!b)continue;
        const angle=Math.atan2(b.y-a.y,b.x-a.x),radius=b.id===s.currentId?screen.ringRadius:screen.radius+3,x=b.x-Math.cos(angle)*radius,y=b.y-Math.sin(angle)*radius;
        ctx.beginPath();if(a===b){ctx.arc(a.x,a.y-19,18,.3,Math.PI*2-.3);}else{ctx.moveTo(a.x,a.y);ctx.lineTo(x,y);}ctx.stroke();
        if(e.directed){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-9*Math.cos(angle-.45),y-9*Math.sin(angle-.45));ctx.lineTo(x-9*Math.cos(angle+.45),y-9*Math.sin(angle+.45));ctx.closePath();ctx.fill();}
      }
      for(const n of screen.nodes){const active=n.id===s.currentId;ctx.beginPath();ctx.arc(n.x,n.y,active?screen.activeRadius:screen.radius,0,Math.PI*2);ctx.fillStyle=active?'#ad7932':'#45665d';ctx.fill();if(active){ctx.beginPath();ctx.arc(n.x,n.y,screen.ringRadius,0,Math.PI*2);ctx.strokeStyle='#ad7932';ctx.stroke();}}
      placeLabels();ctx.textAlign='center';ctx.textBaseline='top';
      for(const label of labels){const {x,y,w,h,node,lines,lineHeight}=label;
        if(Math.hypot(x+w/2-node.x,y+h/2-node.y)>screen.ringRadius+h+18){ctx.lineWidth=1;ctx.strokeStyle='#96826088';ctx.beginPath();ctx.moveTo(node.x,node.y);ctx.lineTo(Math.max(x,Math.min(x+w,node.x)),Math.max(y,Math.min(y+h,node.y)));ctx.stroke();}
        for(const [i,line]of lines.entries()){ctx.lineWidth=4;ctx.strokeStyle='#efe5cf';ctx.strokeText(line,x+w/2,y+2+i*lineHeight);ctx.fillStyle='#3e3c31';ctx.fillText(line,x+w/2,y+2+i*lineHeight);}
      }
      if(!s.nodes.length){ctx.font='14px sans-serif';ctx.textAlign='center';ctx.fillStyle='#87785b';ctx.fillText('暂无公开地点',width/2,height/2);}
    }
    function resize(){const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;const dpr=Math.min(globalThis.devicePixelRatio||1,2);if(ready&&width===r.width&&height===r.height&&canvas.width===Math.round(width*dpr)&&canvas.height===Math.round(height*dpr))return;const oldW=width,oldH=height;width=r.width;height=r.height;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);if(!ready||!interactive){ready=true;fit();}else{tx+=(width-oldW)/2;ty+=(height-oldH)/2;draw();}}
    const point=e=>{const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
    const hit=p=>screen?.nodes.find(n=>Math.hypot(p.x-n.x,p.y-n.y)<Math.max(18,screen.ringRadius))||labels.find(l=>p.x>=l.x&&p.x<=l.x+l.w&&p.y>=l.y&&p.y<=l.y+l.h)?.node;
    const zoom=(factor,p={x:width/2,y:height/2})=>{const next=Math.max(baseScale*.2,Math.min(baseScale*20,scale*factor)),ratio=next/scale;tx=p.x-(p.x-tx)*ratio;ty=p.y-(p.y-ty)*ratio;scale=next;draw();};
    canvas.addEventListener('pointermove',e=>{const p=point(e);hover=hit(p);canvas.title=hover?hover.name+(hover.description?'\n'+hover.description:''):'';
      if(!interactive||!pointers.has(e.pointerId))return;const old=pointers.get(e.pointerId);pointers.set(e.pointerId,p);if(pointers.size===1){tx+=p.x-old.x;ty+=p.y-old.y;draw();}else{const pair=[...pointers.values()],dist=Math.hypot(pair[0].x-pair[1].x,pair[0].y-pair[1].y);if(gesture?.distance)zoom(dist/gesture.distance,{x:(pair[0].x+pair[1].x)/2,y:(pair[0].y+pair[1].y)/2});gesture.distance=dist;}if(gesture&&Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)>8)gesture.moved=true;
    },{signal});
    if(interactive){
      canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;const p=point(e);pointers.set(e.pointerId,p);canvas.setPointerCapture(e.pointerId);if(pointers.size===1)gesture={start:p,moved:false};else{gesture.moved=true;const q=[...pointers.values()];gesture.distance=Math.hypot(q[0].x-q[1].x,q[0].y-q[1].y);}}, {signal});
      canvas.addEventListener('pointerup',e=>{const n=hit(point(e));if(gesture&&!gesture.moved&&n)onSelect(n);pointers.delete(e.pointerId);if(!pointers.size)gesture=null;},{signal});
      canvas.addEventListener('pointercancel',()=>{pointers.clear();gesture=null;},{signal});
      canvas.addEventListener('wheel',e=>{e.preventDefault();zoom(Math.exp(-e.deltaY*.002),point(e));},{signal,passive:false});
    }
    const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
    const dispose=()=>{disposed=true;observer.disconnect();events.abort();};dispose.zoom=zoom;dispose.fit=fit;dispose.redraw=resize;return dispose;
  }
  const mounted=new Map();
  function hydrate(root){
    for(const [canvas,dispose]of mounted)if(!canvas.isConnected){dispose();mounted.delete(canvas);}
    for(const card of root.querySelectorAll('[data-node-map]')){const c=card.querySelector('canvas');if(!c)continue;try{if(mounted.has(c)&&c._mapData!==card.dataset.nodeMap){mounted.get(c)();mounted.delete(c);}if(!mounted.has(c)){mounted.set(c,mount(c,JSON.parse(card.dataset.nodeMap)));c._mapData=card.dataset.nodeMap;}else mounted.get(c).redraw();}catch(_){c.replaceWith(document.createTextNode('地图数据不可用'));}}
  }
  function open(input,trigger){
    const s=publicSnapshot(input),dialog=document.createElement('dialog');dialog.className='node-map-dialog';
    dialog.innerHTML='<header><h2>地图快照</h2><button type="button" data-close aria-label="关闭地图">×</button></header><div class="node-map-controls"><button type="button" data-zoom="1.25" aria-label="放大地图">＋</button><button type="button" data-zoom="0.8" aria-label="缩小地图">−</button><button type="button" data-fit>显示全图</button></div><canvas class="node-map-detail" aria-label="可拖动、双指缩放的地图"></canvas><div class="node-map-description" tabindex="0"><p>选择地点查看描述</p></div><div class="node-map-places" aria-label="地图地点"></div>';
    const text=dialog.querySelector('.node-map-description'),places=dialog.querySelector('.node-map-places');
    const select=n=>{text.replaceChildren();const title=document.createElement('h3'),body=document.createElement('p');title.textContent=n.name;body.textContent=n.description;body.className='plain';text.append(title,body);text.scrollTop=0;for(const b of places.children)b.setAttribute('aria-pressed',String(b.dataset.id===n.id));};
    for(const n of s.nodes){const b=document.createElement('button');b.type='button';b.textContent=n.name;b.dataset.id=n.id;b.onclick=()=>select(n);places.append(b);}
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    document.body.append(dialog);dialog.showModal();const dispose=mount(dialog.querySelector('canvas'),s,{interactive:true,onSelect:select});
    const current=s.nodes.find(n=>n.id===s.currentId);if(current)select(current);
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('[data-fit]').onclick=()=>dispose.fit();dialog.querySelectorAll('[data-zoom]').forEach(b=>b.onclick=()=>dispose.zoom(Number(b.dataset.zoom)));
    dialog.addEventListener('close',()=>{dispose();dialog.remove();if(trigger?.isConnected)trigger.focus({preventScroll:true});},{once:true});return dialog;
  }
  return {snapshot,publicSnapshot,matchLocation,focus,layout,fitView,project,card,hydrate,open,mount,runtime:()=>typeof BUNDLED_NODE_MAP_RUNTIME!=='undefined'?BUNDLED_NODE_MAP_RUNTIME:`const NodeMap=(${createNodeMap.toString()})();`};
}
const NodeMap=createNodeMap();
if(typeof module!=='undefined'&&module.exports)module.exports=NodeMap;
