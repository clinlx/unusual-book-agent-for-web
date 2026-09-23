'use strict';

const GameCore = (() => {
  const vfs = typeof module !== 'undefined' && module.exports ? require('./vfs.js') : VFS;
  const data = typeof module !== 'undefined' && module.exports ? require('./game-data.js') : GameData;
  const history = typeof module !== 'undefined' && module.exports ? require('./game-history.js') : GameHistory;
  const copy = x => structuredClone(x);
  const ROLLBACK_LIMIT=10;
  function reverseTreeDelta(before,after){
    const patches=[];
    function walk(a,b,path){
      if(a?.type==='dir'&&b?.type==='dir'){
        const {children:ac,...am}=a,{children:bc,...bm}=b;
        if(JSON.stringify(am)!==JSON.stringify(bm))patches.push({path,meta:copy(am)});
        for(const key of new Set([...Object.keys(ac),...Object.keys(bc)]))walk(ac[key],bc[key],[...path,key]);
      }else if(JSON.stringify(a)!==JSON.stringify(b))patches.push({path,node:a?copy(a):null});
    }
    walk(before,after,[]);return patches;
  }
  function restoreTreeDelta(base,patches){
    let tree=copy(base);
    for(const patch of patches){
      if(!Array.isArray(patch.path)||patch.path.some(x=>typeof x!=='string'||['__proto__','prototype','constructor','..'].includes(x)))throw Error('回退变更路径无效');
      if(patch.meta){const node=vfs.resolve(tree,patch.path);if(!node||node.type!=='dir')throw Error('回退目录基线缺失');const children=node.children;for(const key of Object.keys(node))delete node[key];Object.assign(node,copy(patch.meta),{children});}
      else if(!patch.path.length)tree=copy(patch.node);
      else {const parent=vfs.resolve(tree,patch.path.slice(0,-1));if(!parent?.children)throw Error('回退目录基线缺失');const key=patch.path.at(-1);if(patch.node===null)delete parent.children[key];else parent.children[key]=copy(patch.node);}
    }
    return tree;
  }
  function pruneRollback(s){
    if(!Array.isArray(s.snapshots))return 0;
    const excess=Math.max(0,s.snapshots.length-ROLLBACK_LIMIT);
    if(excess)s.snapshots.splice(0,excess);
    let changed=excess;
    
    
    for(let i=0;i<s.snapshots.length-1;i++){
      const current=s.snapshots[i],next=s.snapshots[i+1];
      if(current.tree&&next.tree){current.reverseDelta=reverseTreeDelta(current.tree,next.tree);delete current.tree;changed++;}
    }
    return changed;
  }
  const uid = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36)+Math.random().toString(36).slice(2);
  const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const jsonObject = x => { const o=typeof x==='string'?JSON.parse(x):x; if(!object(o))throw Error('必须是 JSON 对象'); return o; };
  function path(p='') {
    if(typeof p!=='string')throw Error('路径必须是字符串');
    let raw=p.replace(/\\/g,'/').replace(/^\.\//,'');
    if(raw.split('/').some(s=>['..','__proto__','prototype','constructor'].includes(s)) || /[\u0000-\u001f]/.test(raw))throw Error('非法文件路径');
    raw='/'+vfs.normalize(raw).join('/');
    if(raw==='/workspace'||raw==='workspace'||raw==='/'||raw==='')return '/workspace';
    if(raw==='/.reference'||raw.startsWith('/.reference/')||raw==='/prompts'||raw.startsWith('/prompts/'))return raw;
    return raw.startsWith('/workspace/')?raw:'/workspace/'+raw.replace(/^\//,'');
  }
  function validateTree(t) {
    const root=vfs.resolve(t,['workspace']);
    if(!root||root.type!=='dir')throw Error('ZIP 中没有有效的工作目录');
    const players=Object.values(root.children).filter(n=>n.type==='dir'&&/^Player-.+/.test(n.name));
    if(players.length!==1)throw Error('存档必须包含且只包含一个 Player-* 玩家目录，请整理压缩包后重新导入。');
    return '/workspace/'+players[0].name;
  }
  function createSave(name,tree) {
    const playerPath=validateTree(tree);
    return {id:uid(),name:String(name||'未命名存档'),createdAt:Date.now(),updatedAt:Date.now(),playerPath,
      tree:copy(tree),requestHistory:[],messages:[],events:[],round:0,cache:{},summaries:[],status:'new',
      snapshots:[],lastChanges:[],activeRound:null,contextFromRound:1,draft:''};
  }
  function emit(s,type,payload={}) {
    const e={id:uid(),type,round:s.activeRound?.number||s.round,at:Date.now(),worldTime:data.worldTime(s),...payload};s.events.push(e);return e;
  }
  function beginRound(s,text,isStart=false,prompt='',options={}) {
    if(s.activeRound&&!s.activeRound.complete)throw Error('当前回合尚未结束，请继续或回退本回合');
    if(s.status==='ended')throw Error('游戏已结束，可回退至上一回合');
    const flags=data.actorState(readJson(s,s.playerPath+'/基础信息.json',{}));
    if(!isStart&&!flags.alive)throw Error('角色已死亡，无法提交行动；可以回溯或查看历史');
    if(!isStart&&!flags.enabled&&!options.skip)throw Error('角色失去意识，无法主动行动；可以等待局势发展');
    const actionText=options.skip?(flags.enabled?'本回合不采取主动行动，等待局势发展。':'失去意识，无法主动行动，等待局势发展。'):String(text||'');
    s.snapshots.push({tree:copy(s.tree),messageCount:s.messages.length,eventCount:s.events.length,round:s.round,
      worldTime:data.worldTime(s),at:Date.now(),
      cache:copy(s.cache),summaryCount:s.summaries.length,status:s.status,contextFromRound:s.contextFromRound,lastChanges:copy(s.lastChanges),draft:isStart?s.draft:String(text||s.draft||'')});
    pruneRollback(s);
    s.activeRound={id:uid(),number:s.round+1,action:actionText,starting:isStart,triggered:isStart,published:0,initialWorldTime:data.consensusTime(s),
      requestCount:0,readState:{},receipts:{},complete:false,summary:[]};
    s.status='running';s.error=null;s.lastChanges=[];s.draft='';
    if(!isStart)emit(s,'player',{content:actionText,name:'player_action',args:{action:actionText},skip:!!options.skip});
    s.messages.push({role:'user',content:String(prompt),round:s.activeRound.number});
    return s.activeRound;
  }
  function flatten(t) {
    const out={};
    function walk(n,p){if(!n)return;if(n.type==='file')out[p]=n;else for(const child of Object.values(n.children||{}))walk(child,p+'/'+child.name);}
    walk(vfs.resolve(t,['workspace']),'/workspace');return out;
  }
  function changes(before,after) {
    const a=flatten(before),b=flatten(after),out=[];
    for(const p of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
      if(a[p]?.content===b[p]?.content&&a[p]?.encoding===b[p]?.encoding)continue;
      out.push({path:p,before:a[p]?.content??null,after:b[p]?.content??null,
        binary:a[p]?.encoding==='base64'||b[p]?.encoding==='base64',type:!a[p]?'add':!b[p]?'delete':'modify'});
    }return out;
  }
  function rollback(s) {
    pruneRollback(s);const snap=s.snapshots.pop();if(!snap)throw Error('没有可回退的回合');
    s.tree=copy(snap.tree);s.messages.length=snap.messageCount;s.events.length=snap.eventCount;
    s.round=snap.round;s.cache=copy(snap.cache);s.summaries.length=snap.summaryCount;s.status=snap.status;
    s.draft=snap.draft??s.activeRound?.action??'';
    s.contextFromRound=snap.contextFromRound;s.lastChanges=copy(snap.lastChanges);s.activeRound=null;s.error=null;
    const previous=s.snapshots.at(-1);
    if(previous&&!previous.tree){previous.tree=restoreTreeDelta(s.tree,previous.reverseDelta);delete previous.reverseDelta;}
    s.playerPath=validateTree(s.tree);s.updatedAt=Date.now();
  }
  const hiddenFlag = data.hiddenFlag;
  function filterVisible(x,items=false) {
    return data.visible(x,items);
  }
  function readJson(s,p,fallback) {
    const n=vfs.resolve(s.tree,vfs.normalize(path(p)));if(!n)return fallback;
    if(n.type!=='file'||n.encoding==='base64')throw Error(p+' 必须是文本 JSON');
    try{return JSON.parse(n.content.replace(/^\uFEFF/,''));}catch(_){throw Error(p+' 的 JSON 格式不正确，请在 DEBUG 中修正');}
  }
  function player(s,section) {
    const info=section==='items'?{}:data.displayPaths(s,filterVisible(readJson(s,s.playerPath+'/基础信息.json',{})));
    if(!object(info))throw Error('基础信息.json 必须是 JSON 对象');
    if(section==='info')return {info,name:data.get(info,'姓名')||s.playerPath.split('/').pop()};
    const bag=readJson(s,s.playerPath+'/背包.json',[]);
    if(!Array.isArray(bag)&&!object(bag))throw Error('背包.json 必须是数组或兼容的物品列表对象');
    let list=Array.isArray(bag)?bag:(bag.物品||bag.Items||bag.items||bag.背包||Object.values(bag));
    if(!Array.isArray(list))list=Object.values(list||{});
    const items=list.filter(i=>!object(i)||!hiddenFlag(i['.是否对玩家隐藏'])).map(i=>{
      if(typeof i!=='string')return filterVisible(i,true);
      let p=i.replace(/\\/g,'/').replace(/^\/?workspace\//,'').replace(/\/$/,'');
      if(!p.startsWith('存档-索引-物品/'))p='存档-索引-物品/'+p;
      if(!p.endsWith('.json'))p+='/物品基础信息.json';
      const detail=readJson(s,p,null);return detail&&hiddenFlag(detail['.是否对玩家隐藏'])?null:detail?filterVisible(detail,true):{名称:i};
    }).filter(i=>i!==null);
    return {info,items,name:data.get(info,'姓名')||s.playerPath.split('/').pop()};
  }
  const actorKey=v=>String(v||'').trim().toLowerCase().replace(/[\\s·._-]+/g,'');
  function dicePlayerRelated(s,a={}){
    const roller=actorKey(a.roller),p=player(s,'info'),name=actorKey(p.name),id=actorKey(s.playerPath.split('/').pop());
    if(!roller)return false;
    if(['玩家','玩家角色','主角','你','player','pc'].includes(roller))return true;
    if(roller===name||roller===id)return true;
    if(name.length>=2&&roller.includes(name))return true;
    return false;
  }
  const diceSecret=a=>a?.is_secret===true||String(a?.related_attr||'').trim()==='心理学';
  function diceEventPlayerRelated(s,e){
    if(typeof e?.playerRelated==='boolean')return e.playerRelated;
    return dicePlayerRelated(s,e?.diceArgs||e||{});
  }
  const visibleEvents=(s,mode)=>mode==='debug'?s.events:s.events.filter(e=>e.type==='dice'?diceEventPlayerRelated(s,e):!e.secret&&['player','story','round_end','note'].includes(e.type));
  function requireText(v,label){if(typeof v!=='string'||!v.trim())throw Error(label+' 不得为空');return v;}
  function finite(v,label){if(typeof v!=='number'||!Number.isFinite(v))throw Error(label+' 必须是有限数值');return v;}
  function modifiers(x){if(x==null)return 0;if(!object(x))throw Error('修正值必须是对象');return Object.values(x).reduce((n,v)=>n+finite(v,'修正值'),0);}
  function randInt(min,max,random=Math.random){if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||max<min||max-min>1e9)throw Error('随机范围无效');return min+Math.floor(random()*(max-min+1));}
  function dice(a,random=Math.random,fixedRolls=null){
    let fixedIndex=0;
    if(!object(a.dice_dict)||!Object.keys(a.dice_dict).length)throw Error('dice_dict 不得为空');
    const compare={gt:(x,y)=>x>y,ge:(x,y)=>x>=y,lt:(x,y)=>x<y,le:(x,y)=>x<=y,eq:(x,y)=>x===y,ne:(x,y)=>x!==y};
    if(!a.calculate_only&&(!compare[a.compare_mode]||!Number.isFinite(a.target_value)))throw Error('检定需要 target_value 与 compare_mode');
    const mode=a.dice_combine_mode||'sum';if(!['sum','max','min','independent'].includes(mode))throw Error('骰子组合方式无效');
    const left=modifiers(a.left_modifiers),right=modifiers(a.right_modifiers);
    const ranges={};for(const k of ['critical_success_range','critical_failure_range']){
      if(!a[k])continue;const r=typeof a[k]==='string'?JSON.parse(a[k]):a[k];
      if(!Array.isArray(r)||r.length!==2||!r.every(Number.isFinite)||r[0]>r[1])throw Error(k+' 必须是 [min,max]');ranges[k]=r;
    }
    const successRange=ranges.critical_success_range,failureRange=ranges.critical_failure_range;
    if(successRange&&failureRange&&Math.max(successRange[0],failureRange[0])<=Math.min(successRange[1],failureRange[1]))throw Error('大成功与大失败的闭区间不能重叠（包括共同端点），请修正后重新调用 roll_dice');
    const specs=Object.entries(a.dice_dict).map(([label,value])=>{
      const formula=String(value).trim(),m=formula.match(/^(-?)(\d+)d(\d+)$/i);
      if(m){const n=Number(m[2]),faces=Number(m[3]);if(n<1||n>1000||faces<1||faces>1e9)throw Error('骰子数量或面数超出范围');return {label,formula,n,faces,sign:m[1]?-1:1};}
      if(!/^-?\d+$/.test(formula)||!Number.isSafeInteger(Number(formula)))throw Error('骰子格式应为 NdM、-NdM 或整数');
      return {label,formula,constant:Number(formula)};
    });
    const rows=specs.map(r=>{const rolls=r.n?Array.from({length:r.n},()=>{
      if(Array.isArray(fixedRolls)){
        if(fixedIndex>=fixedRolls.length)throw Error('手动掷骰结果数量不足');
        const value=Number(fixedRolls[fixedIndex++]);if(!Number.isSafeInteger(value)||value<1||value>r.faces)throw Error('手动掷骰结果超出骰面范围');
        return value*r.sign;
      }
      return randInt(1,r.faces,random)*r.sign;
    }):[r.constant];return {label:r.label,formula:r.formula,rolls,total:rolls.reduce((x,y)=>x+y,0)};});
    if(Array.isArray(fixedRolls)&&fixedIndex!==fixedRolls.length)throw Error('手动掷骰结果数量不匹配');
    function judge(raw){const total=raw+left,target=(a.target_value||0)+right;const hints=[];
      if(ranges.critical_success_range&&raw>=ranges.critical_success_range[0]&&raw<=ranges.critical_success_range[1])hints.push('可能是大成功');
      if(ranges.critical_failure_range&&raw>=ranges.critical_failure_range[0]&&raw<=ranges.critical_failure_range[1])hints.push('可能是大失败');
      return {raw,total,target,success:a.calculate_only?null:compare[a.compare_mode](total,target),criticalHints:hints,critical:hints.join('，')||null,special:!a.calculate_only&&hints.length>0};}
    const raw=mode==='max'?Math.max(...rows.map(r=>r.total)):mode==='min'?Math.min(...rows.map(r=>r.total)):rows.reduce((n,r)=>n+r.total,0);
    const result={rows:mode==='independent'?rows.map(r=>({...r,...judge(r.total)})):rows,mode,left,right,compare_mode:a.compare_mode,...judge(raw)};
    const describe=r=>r.special?r.raw+' · '+r.critical+'（已忽略修正值，已省略比较）':r.total+(r.success===null?'':(' / '+r.target+' · '+(r.success?'通过':'未通过')));
    const resultText=mode==='independent'?result.rows.map(r=>r.label+': '+describe(r)).join('；'):describe(result);
    return {data:result,content:`${a.roller||'角色'} · ${a.description||a.related_attr||'掷骰'}\n${rows.map(r=>`${r.label} ${r.formula} [${r.rolls.join(', ')}]`).join('；')}\n${resultText}`};
  }
  function execute(s,name,a={},callId=uid(),options={}) {
    const round=s.activeRound;if(!round)return {ok:false,error:'尚未开始回合'};
    if(Object.hasOwn(round.receipts,callId))return copy(round.receipts[callId]);
    
    
    const before=copy({tree:s.tree,cache:s.cache,round:s.round,status:s.status,playerPath:s.playerPath,
      summaries:s.summaries,lastChanges:s.lastChanges,activeRound:round});
    const eventCount=s.events.length;
    let out;
    try{
      if(round.complete)throw Error('回合已经结束，不能继续执行工具');
      if(!object(a))throw Error('参数必须是对象');
      const p=path(a.path||'');
      const read=(input)=>{
        const fp=path(input.path),resource=options.resource?.(fp)??options.resource?.(String(input.path));
        const n=vfs.resolve(s.tree,vfs.normalize(fp));
        
        if(resource!==undefined){const offset=Math.max(0,Number(input.offset)||0),limit=Math.min(120000,Math.max(1,Number(input.limit)||32000));
          return {content:resource.slice(offset,offset+limit),offset,totalLength:resource.length,truncated:offset+limit<resource.length};}
        if(!n)throw Error('文件不存在: '+fp);
        const r=vfs.readFile(s.tree,fp,{offset:input.offset,limit:input.limit,cap:120000});round.readState[fp]=n.content;return r;
      };
      const writable=fp=>{if(fp==='/.reference'||fp.startsWith('/.reference/')||fp==='/prompts'||fp.startsWith('/prompts/')||options.resource?.(fp)!==undefined)throw Error('提示词为只读资源，请在设置中修改');};
      const readFirst=fp=>{writable(fp);const n=vfs.resolve(s.tree,vfs.normalize(fp));if(n?.type==='file'&&round.readState[fp]!==n.content)throw Error('修改前先 read_file 读取最新内容: '+fp);};
      const readSubtreeFirst=fp=>{readFirst(fp);const n=vfs.resolve(s.tree,vfs.normalize(fp));if(n?.type==='dir')for(const child of Object.values(n.children))readSubtreeFirst(fp+'/'+child.name);};
      let result;
      switch(name){
        case 'trigger_next_round':{
          const plan=jsonObject(a.phase_plan);if(typeof plan.Countdowns!=='string'||!plan.Countdowns.trim()||!Array.isArray(plan.Pending_Triggers)||typeof plan.Forced_Checks!=='string'||!plan.Forced_Checks.trim())throw Error('phase_plan 需要非空文本 Countdowns、Forced_Checks 和数组 Pending_Triggers');
          round.triggered=true;result={action:round.action,player:s.playerPath,phase_plan:plan,warnings:round.number>3?data.references(s,plan.Pending_Triggers):[]};break;
        }
        case 'append_story':{
          if(!round.triggered)throw Error('先调用 trigger_next_round 获取玩家行动');
          requireText(a.content,'content');requireText(a.one_line_summary_of_content,'one_line_summary_of_content');
          const content=a.content.trim();if(s.events.some(e=>e.type==='story'&&e.round===round.number&&e.content.trim()===content))throw Error('此内容已经输出成功，请勿重复发布；如需继续请追加不同的下一段');
          player(s);emit(s,'story',{content,worldTime:data.worldTime(s)});round.published++;round.summary.push(a.one_line_summary_of_content);
          result={status:'Story appended successfully; warnings are advisory, do not republish',warnings:data.validate(s)};break;
        }
        case 'end_the_round':{
          if(!round.published)throw Error('先成功调用 append_story 输出故事');
          const cache=jsonObject(a.NEXT_TURN_CACHE);if(!['游戏前准备','游戏循环','游戏结束'].includes(cache.Story_Phase))throw Error('NEXT_TURN_CACHE.Story_Phase 无效');
          s.playerPath=validateTree(s.tree);player(s);
          s.cache=copy(cache);s.round=round.number;s.status=cache.game_over===true?'ended':'waiting';round.complete=true;
          s.summaries.push({round:s.round,content:round.summary.join('；'),worldTime:data.worldTime(s),at:Date.now()});
          emit(s,'round_end',{content:'第 '+s.round+' 回合结束'});
          const roundStart=s.snapshots.at(-1)?.tree;
          let playerState;
          if(roundStart){
            const playerRel=s.playerPath.replace(/^\/workspace\//,'');
            const rawFile=(tree,rel)=>vfs.resolve(tree,vfs.normalize('/workspace/'+rel))?.content;
            const infoRel=playerRel+'/基础信息.json',bagRel=playerRel+'/背包.json';
            const filesChanged=rawFile(roundStart,infoRel)!==rawFile(s.tree,infoRel)||rawFile(roundStart,bagRel)!==rawFile(s.tree,bagRel);
            if(filesChanged){
              const afterPlayer=player(s);
              playerState={round:s.round,worldTime:data.worldTime(s),at:Date.now(),info:copy(afterPlayer.info),items:copy(afterPlayer.items)};
            }
          }
          history.archive(s,playerState);
          s.lastChanges=changes(s.snapshots.at(-1).tree,s.tree).filter(c=>!history.generated(c.path));
          result={status:'Round ended successfully',round:s.round,warnings:data.cacheWarnings(s,cache)};break;
        }
        case 'read_file':result=read(a);break;
        case 'read_multiple_files':{
          if(!Array.isArray(a.paths)||a.paths.length>20)throw Error('paths 应为最多 20 个文件路径');
          result=a.paths.map(fp=>{try{return {path:fp,...read({path:fp,limit:a.limit||16000})};}catch(e){return {path:fp,error:e.message};}});break;
        }
        case 'list_dir':{
          if(p==='/.reference'||p.startsWith('/.reference/')){
            const found=new Map();for(const fp of options.resourceList||[]){if(!fp.startsWith(p+'/'))continue;const rest=fp.slice(p.length+1),name=rest.split('/')[0];found.set(name,{name,type:rest.includes('/')?'dir':'file'});}
            if(!found.size)throw Error('提示词目录不存在: '+p);result=[...found.values()];
          }else result=vfs.listDir(s.tree,p);break;
        }
        case 'tree':{
          const depth=a.depth??3;if(!Number.isInteger(depth)||depth<0||depth>10)throw Error('depth 必须是 0 到 10 的整数');
          let root=vfs.resolve(s.tree,vfs.normalize(p));
          if(p==='/.reference'||p.startsWith('/.reference/')){
            const virtual=vfs.createTree();
            for(const fp of options.resourceList||[]){
              const parts=vfs.normalize(fp);vfs.mkdirp(virtual,parts.slice(0,-1));
              const parent=vfs.resolve(virtual,parts.slice(0,-1));parent.children[parts.at(-1)]={name:parts.at(-1),type:'file',content:''};
            }
            root=vfs.resolve(virtual,vfs.normalize(p));
          }
          if(!root||root.type!=='dir')throw Error('目录不存在: '+p);
          const lines=[p+'/'];let truncated=false,count=0;
          function walk(node,prefix,remaining){
            const entries=Object.values(node.children||{}).sort((x,y)=>(x.type==='dir'?0:1)-(y.type==='dir'?0:1)||x.name.localeCompare(y.name));
            if(!entries.length)return;
            if(remaining===0){lines.push(prefix+'└── …');truncated=true;return;}
            for(let i=0;i<entries.length;i++){
              if(count>=2000){lines.push(prefix+'└── …');truncated=true;return;}
              const item=entries[i],last=i===entries.length-1;count++;
              lines.push(prefix+(last?'└── ':'├── ')+item.name+(item.type==='dir'?'/':''));
              if(item.type==='dir')walk(item,prefix+(last?'    ':'│   '),remaining-1);
            }
          }
          walk(root,'',depth);result={path:p,tree:lines.join('\n'),depth,truncated};break;
        }
        case 'search':result=vfs.search(s.tree,{...a,path:p,pattern:requireText(a.pattern,'pattern')});break;
        case 'append_file':{
          readFirst(p);const node=vfs.resolve(s.tree,vfs.normalize(p));
          if(!node||node.type!=='file')throw Error('文件不存在: '+p);
          if(node.encoding==='base64')throw Error('该文件不能作为文本追加');
          if(typeof a.content!=='string'||!a.content.length)throw Error('content 必须是非空文本');
          const content=node.content+a.content;vfs.writeFile(s.tree,p,content,{cap:120000});
          result={path:p,appended:a.content.length,totalLength:content.length};break;
        }
        case 'write_file':readFirst(p);if(typeof a.content!=='string')throw Error('content 必须是文本');vfs.writeFile(s.tree,p,a.content,{cap:120000});result={path:p,written:a.content.length};break;
        case 'apply_patch':readFirst(p);if(typeof a.new_str!=='string')throw Error('new_str 必须是文本');result=vfs.applyPatch(s.tree,p,requireText(a.old_str,'old_str'),a.new_str,{cap:120000});break;
        case 'mkdir':writable(p);vfs.mkdir(s.tree,p);result={path:p};break;
        case 'delete':if(p===s.playerPath)throw Error('不能删除唯一玩家目录');readSubtreeFirst(p);vfs.deletePath(s.tree,p);result={path:p};break;
        case 'move':case 'copy':{
          const from=path(a.from),to=path(a.to);writable(to);if(name==='move'){writable(from);if(from===s.playerPath)throw Error('不能修改玩家目录 ID');}
          if(to==='/workspace'||to.startsWith(from+'/'))throw Error('无效目标路径');vfs[name](s.tree,from,to);result={from,to};break;
        }
        case 'roll_dice':{
          const d=dice(a,options.random,options.fixedDiceRolls),payload={...d,roller:a.roller,description:a.description||'',relatedAttr:a.related_attr||'',
            secret:diceSecret(a),playerRelated:dicePlayerRelated(s,a),diceArgs:copy(a),manual:!!options.manualDiceResolved,pending:false,callId};
          const pendingEvent=options.manualEventId&&s.events.find(e=>e.id===options.manualEventId);
          if(pendingEvent)Object.assign(pendingEvent,payload,{at:Date.now(),worldTime:data.worldTime(s)});
          else emit(s,'dice',payload);
          result=d;break;
        }
        case 'generate_random_number':result={value:randInt(a.min_val,a.max_val,options.random)};break;
        case 'random_select':{
          const choices=a.items||a.options||a.choices;if(!Array.isArray(choices)||!choices.length)throw Error('items 必须是非空数组');
          const weights=choices.map((x,i)=>a.weights?.[i]??(object(x)?x.weight??1:1));
          if(weights.some(w=>typeof w!=='number'||!Number.isFinite(w)||w<0)||!weights.some(w=>w>0))throw Error('权重必须为非负数，且至少一个大于零');
          let r=(options.random||Math.random)()*weights.reduce((x,y)=>x+y,0),i=0;while(i<weights.length-1&&r>=weights[i])r-=weights[i++];result={selected:choices[i],index:i,details:choices.map((item,j)=>({item,weight:weights[j],probability:weights[j]/weights.reduce((x,y)=>x+y,0)}))};break;
        }
        case 'calculate_difficulty_class':{
          const x=finite(a.subject_value,'subject_value'),y=finite(a.target_value,'target_value');
          const relative=(x-y)/Math.max(1,Math.min(Math.abs(x),Math.abs(y)));
          let cmp=1/(1+Math.exp(-Math.max(-100,Math.min(100,relative*Math.sqrt(Math.abs(relative))))));
          if(cmp>0.999999)cmp=1;if(cmp<0.000001)cmp=0;
          result={subject_value:x,target_value:y,calculated_dc:Math.trunc(cmp*40-10),raw_cmp_value:cmp};break;
        }
        default:throw Error('未知工具: '+name);
      }
      out={ok:true,result:result??{status:'ok'}};
    }catch(e){
      const {activeRound,...rest}=before;Object.assign(s,rest);Object.assign(round,activeRound);s.events.length=eventCount;
      out={ok:false,error:e.message};
    }
    round.receipts[callId]=copy(out);emit(s,'tool',{name,args:copy(a),result:out.ok?out.result:out.error,success:out.ok,callId,
      fileChanges:out.ok?changes(before.tree,s.tree):[]});
    if(!round.complete&&s.snapshots.length)s.lastChanges=changes(s.snapshots.at(-1).tree,s.tree);
    s.updatedAt=Date.now();return out;
  }
  function resolveManualDice(s,rolls){
    const pending=s.pendingManualDice;if(!pending)throw Error('没有待进行的手动检定');
    if(!s.activeRound||pending.round!==s.activeRound.number)throw Error('待检定状态与当前回合不一致');
    const out=execute(s,'roll_dice',copy(pending.args),pending.callId,{fixedDiceRolls:rolls,manualDiceResolved:true,manualEventId:pending.eventId});
    if(!out.ok)throw Error(out.error||'手动检定结算失败');
    s.messages.push({role:'tool',tool_call_id:pending.callId,content:JSON.stringify(out),round:s.activeRound.number});
    delete s.pendingManualDice;s.status='interrupted';s.error=null;s.updatedAt=Date.now();return out;
  }
  function estimate(messages){let n=0;for(const m of messages){const text=typeof m==='string'?m:JSON.stringify(m);let cjk=0;for(const c of text)if(/[\u3000-\u9fff]/.test(c))cjk++;n+=cjk+Math.ceil((text.length-cjk)/4)+5;}return n;}
  function context(s,system,cap=128000,opts={}) {
    const current=s.activeRound?.number||Math.max(1,s.round);
    let from=s.contextFromRound||1,compact=false;
    const rounds=[...new Set(s.messages.filter(m=>(m.round||1)>=from).map(m=>m.round||1))];
    function build(){
      const head=[{role:'system',content:system}];
      const recap=s.summaries.filter(r=>r.round<from).slice(-30);
      if(recap.length)head.push({role:'user',content:(opts.summariesPrompt||'[前情提要]')+'\n'+recap.map(r=>`第${r.round}回合：${r.content}`).join('\n')});
      if(Object.keys(s.cache||{}).length)head.push({role:'user',content:(opts.cachePrompt||'[NEXT_TURN_CACHE]')+'\n'+JSON.stringify(s.cache)});
      const msgs=s.messages.filter(m=>(m.round||1)>=from).map(m=>{
        const out={role:m.role,content:m.content||''};
        for(const k of ['tool_calls','tool_call_id','reasoning_content'])if(m[k]!==undefined)out[k]=copy(m[k]);return out;
      });const built=[...head,...msgs];return compact?history.compactReads(built,s.messages,current):built;
    }
    let sent=build();
    if(estimate(sent)>cap){compact=true;sent=build();}
    if(estimate(sent)>cap&&rounds.length>1){from=rounds[Math.floor(rounds.length/2)];sent=build();
      while(estimate(sent)>cap&&from<current){const next=rounds.find(r=>r>from);if(next===undefined)break;from=next;sent=build();}}
    if(estimate(sent)>cap)throw Error('系统提示词与当前回合已超过上下文上限，请调大上限或缩短提示词');
    s.contextFromRound=from;return sent;
  }
  async function run(s,transport,opts={}) {
    if(!s.activeRound)throw Error('尚未开始回合');
    const abort=()=>{if(opts.signal?.aborted)throw Object.assign(Error('已中止本回合'),{name:'AbortError'});};
    const step=async()=>{if(opts.onStep)await opts.onStep(s);};
    s.status='running';s.error=null;
    async function completeBatch(message){
      let storyInBatch=false;
      for(const tc of message.tool_calls||[]){
        if(s.messages.some(m=>m.role==='tool'&&m.round===s.activeRound.number&&m.tool_call_id===tc.id))continue;
        if(s.pendingManualDice){
          if(s.pendingManualDice.callId===tc.id)return true;
          return true;
        }
        abort();let a,out;
        try{
          a=JSON.parse(tc.function.arguments||'{}');
          if(tc.function.name==='roll_dice'&&opts.manualDice===true&&dicePlayerRelated(s,a)&&!diceSecret(a)){
            const e=emit(s,'dice',{roller:a.roller,description:a.description||'',relatedAttr:a.related_attr||'',secret:false,playerRelated:true,
              diceArgs:copy(a),manual:true,pending:true,callId:tc.id});
            s.pendingManualDice={callId:tc.id,eventId:e.id,round:s.activeRound.number,args:copy(a),createdAt:Date.now()};
            s.status='interrupted';s.error=null;await step();return true;
          }
          out=execute(s,tc.function.name,a,tc.id,opts);
        }
        catch(e){out={ok:false,error:'工具参数解析失败：'+e.message};emit(s,'tool',{name:tc.function.name,args:tc.function.arguments,result:out.error,success:false,callId:tc.id});}
        if(out.ok&&tc.function.name==='append_story')storyInBatch=true;
        s.messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(out),round:s.activeRound.number});await step();
      }
      if(storyInBatch&&!s.activeRound.complete&&opts.afterStory){s.messages.push({role:'user',content:opts.afterStory,round:s.activeRound.number});await step();}
      return false;
    }
    try{
      
      const pending=s.messages.filter(m=>m.role==='assistant'&&m.tool_calls&&m.round===s.activeRound.number);
      for(const m of pending)if(await completeBatch(m))return;
      if(s.activeRound.complete){s.status=s.cache.game_over===true?'ended':'waiting';await step();return;}
      if(opts.resumePrompt){s.messages.push({role:'user',content:opts.resumePrompt,round:s.activeRound.number});await step();}
      for(let loop=0;loop<(opts.maxToolLoops||60);loop++){
        abort();const messages=context(s,opts.system||'',opts.cap||128000,opts);
        if(opts.transformContext)for(const m of messages){m.content=opts.transformContext(m.content);if(m.tool_calls)for(const tc of m.tool_calls)tc.function.arguments=opts.transformContext(tc.function.arguments);}
        await step();
        const resp=await transport(messages);abort();
        const m={role:'assistant',content:resp.content||'',round:s.activeRound.number};
        if(resp.reasoning)m.reasoning_content=resp.reasoning;
        if(resp.tool_calls?.length)m.tool_calls=resp.tool_calls.map(tc=>({...tc,id:tc.id||uid()}));
        s.messages.push(m);emit(s,'assistant',{content:m.content,reasoning:m.reasoning_content||''});await step();
        if(m.tool_calls){if(await completeBatch(m))return;if(s.activeRound.complete){
          if(s.activeRound.starting&&opts.firstRecall){s.messages.push({role:'user',content:opts.firstRecall,round:s.activeRound.number});await step();}return;
        }}
        else{
          const reminder=opts.reminder?.(s)||(!s.activeRound.triggered?'调用 trigger_next_round 获取玩家行动。':!s.activeRound.published?'调用 append_story 输出本回合故事，然后 end_the_round。':'请保存 NEXT_TURN_CACHE 并调用 end_the_round。');
          s.messages.push({role:'user',content:reminder,round:s.activeRound.number});await step();
        }
      }
      throw Error('本回合已达到工具循环上限，可继续本回合或回退');
    }catch(e){s.status=s.activeRound.complete?(s.cache.game_over?'ended':'waiting'):'interrupted';s.error=e.message;emit(s,'error',{content:e.message});await step();throw e;}
  }
  return {uid,path,createSave,validateTree,beginRound,execute,run,context,estimate,player,filterVisible,visibleEvents,rollback,pruneRollback,ROLLBACK_LIMIT,changes,flatten,dice,dicePlayerRelated,diceSecret,resolveManualDice};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameCore;
