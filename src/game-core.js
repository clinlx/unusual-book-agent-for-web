'use strict';

const GameCore = (() => {
  const vfs = typeof module !== 'undefined' && module.exports ? require('./vfs.js') : VFS;
  const data = typeof module !== 'undefined' && module.exports ? require('./game-data.js') : GameData;
  const fileReads = typeof module !== 'undefined' && module.exports ? require('./shared/file-read.js') : FileRead;
  const history = typeof module !== 'undefined' && module.exports ? require('./game-history.js') : GameHistory;
  const recovery = typeof module !== 'undefined' && module.exports ? require('./game-context-recovery.js') : GameContextRecovery;
  const toolArguments = typeof module !== 'undefined' && module.exports ? require('./shared/tool-arguments.js') : ToolArguments;
  const fileKnowledge = typeof module !== 'undefined' && module.exports ? require('./shared/file-knowledge.js') : FileKnowledge;
  const inputs = typeof module !== 'undefined' && module.exports ? require('./game-input-history.js') : GameInputs;
  const slots = typeof module !== 'undefined' && module.exports ? require('./game-slots.js') : GameSlots;
  const worldTriggers = typeof module !== 'undefined' && module.exports ? require('./game-world-triggers.js') : GameWorldTriggers;
  const fileValidation = typeof module !== 'undefined' && module.exports ? require('./shared/file-write-validation.js') : FileWriteValidation;
  const writeOptions = {cap:120000,validateContent:fileValidation.validate};
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
  const jsonObject = (x,label) => { let o;try{o=typeof x==='string'?JSON.parse(x):x;}catch(_){throw Error(label+' 必须是合法 JSON 对象或其 JSON 字符串');}if(!object(o))throw Error(label+' 必须是 JSON 对象');return o; };
  function path(p='') {
    if(typeof p!=='string')throw Error('路径必须是字符串');
    let raw=p.replace(/\\/g,'/').replace(/^\.\//,'');
    if(raw.split('/').some(s=>['..','__proto__','prototype','constructor'].includes(s)) || /[\u0000-\u001f]/.test(raw))throw Error('非法文件路径');
    raw='/'+vfs.normalize(raw).join('/');
    if(raw==='/workspace'||raw==='workspace'||raw==='/'||raw==='')return '/workspace';
    if(raw==='/.reference'||raw.startsWith('/.reference/')||raw==='/prompts'||raw.startsWith('/prompts/'))return raw;
    return raw.startsWith('/workspace/')?raw:'/workspace/'+raw.replace(/^\//,'');
  }
  function validateTree(t,preferred) {
    const root=vfs.resolve(t,['workspace']);
    if(!root||root.type!=='dir')throw Error('ZIP 中没有有效的工作目录');
    const players=slots.scan(t).filter(n=>n.kind!=='kpc');
    if(!players.length)throw Error('存档必须包含至少一个 Player/AIPC/DISABLE 玩家槽位');
    return players.find(n=>n.path===preferred)?.path||players.find(n=>n.kind==='player')?.path||players[0].path;
  }
  function createSave(name,tree) {
    const playerPath=validateTree(tree),actors=slots.scan(tree).filter(n=>n.kind!=='kpc');
    return {id:uid(),name:String(name||'未命名存档'),createdAt:Date.now(),updatedAt:Date.now(),playerPath,
      actorId:actors.find(x=>x.path===playerPath).id,slots:actors,slotsConfigured:false,tree:copy(tree),requestHistory:[],messages:[],events:[],round:0,cache:{},summaries:[],status:'new',
      snapshots:[],lastChanges:[],activeRound:null,contextFromRound:1,draft:'',draftRound:1,draftVersion:0,inputHistory:[]};
  }
  function emit(s,type,payload={}) {
    const e={id:uid(),type,round:s.activeRound?.number||s.round,at:Date.now(),worldTime:data.worldTime(s),...payload};s.events.push(e);return e;
  }
  function openingFiles(s,options={}) {
    const read=name=>{
      const n=vfs.resolve(s.tree,['workspace',name]);if(!n)return '';
      if(n.type!=='file'||n.encoding==='base64'||typeof n.content!=='string')throw Error(name+' 必须为文本文件');
      if(n.content.length>120000)throw Error(name+' 超过 120000 字符');
      return n.content.replace(/^\uFEFF/,'').trim();
    };
    const internal=read('开局内部说明.md'),story=read('预设第一回合.md');let extra=[];
    if(options.openingPreload!==false){
      const configNode=vfs.resolve(s.tree,['workspace','开局预读.json']);
      if(configNode){const config=read('开局预读.json');fileValidation.validate('/workspace/开局预读.json',config);extra=fileValidation.openingFiles(JSON.parse(config));}
    }
    for(const p of extra){const n=vfs.resolve(s.tree,vfs.normalize(p));if(!n||n.type!=='file'||n.encoding==='base64')throw Error('开局预读.json 引用了不存在或非文本的文件：'+p);}
    return {internal,story,extra};
  }
  function localOpening(s) {
    if(!s)return false;
    if(s.activeRound&&!s.activeRound.complete)return !!s.activeRound.presetOpening;
    if(s.status!=='new'||s.round!==0)return false;
    const n=vfs.resolve(s.tree,['workspace','预设第一回合.md']);
    return n?.type==='file'&&n.encoding!=='base64'&&!!n.content?.trim();
  }
  function beginRound(s,text,isStart=false,prompt='',options={}) {
    if(s.activeRound&&!s.activeRound.complete)throw Error('当前回合尚未结束，请继续或回退本回合');
    if(s.status==='ended')throw Error('游戏已结束，可回退至上一回合');
    const opening=isStart&&s.round===0||s.openingPending?openingFiles(s,options):null;
    const flags=data.actorState(readJson(s,s.playerPath+'/基础信息.json',{}));
    if(!options.actions&&!isStart&&!flags.alive)throw Error('角色已死亡，无法提交行动；可以回溯或查看历史');
    if(!options.actions&&!isStart&&!flags.enabled&&!options.skip)throw Error('角色失去意识，无法主动行动；可以等待局势发展');
    const actionText=options.skip?(flags.enabled?'本回合不采取主动行动，等待局势发展。':'失去意识，无法主动行动，等待局势发展。'):String(text||'');
    const roundId=options.roundId||uid(),inputRound=s.round+1,boundDraft=s.draftRound==null||s.draftRound===inputRound?s.draft||'':'';
    const submittedDraft=inputs.get(s,inputRound,roundId)?.draftState;
    const keepDraft=options.actions?.some(a=>a.actorId===s.actorId)&&submittedDraft&&
      (String(s.draft||'')!==submittedDraft.draft||String(s.privateDraft||'')!==submittedDraft.privateDraft);
    s.snapshots.push({tree:copy(s.tree),slots:copy(s.slots||[]),actorId:s.actorId,playerPath:s.playerPath,messageCount:s.messages.length,eventCount:s.events.length,round:s.round,
      worldTime:data.worldTime(s),at:Date.now(),
      cache:copy(s.cache),worldTriggers:s.worldTriggers?copy(s.worldTriggers):null,openingPending:s.openingPending?copy(s.openingPending):null,slotControlState:s.slotControlState?copy(s.slotControlState):null,summaryCount:s.summaries.length,status:s.status,contextFromRound:s.contextFromRound,lastChanges:copy(s.lastChanges),
      draft:isStart||options.skip?boundDraft:String(text||''),draftRound:inputRound,inputRoundId:roundId});
    pruneRollback(s);
    if(!options.skip&&String(text||'').trim())inputs.record(s,inputRound,roundId,text);
    inputs.advance(s);
    s.activeRound={id:roundId,number:inputRound,actions:copy(options.actions||[]),action:actionText,...options.skip?{skip:true}:{},starting:isStart,triggered:isStart,published:0,initialWorldTime:data.consensusTime(s),
      participantIds:s.multiplayer?.members?Object.values(s.multiplayer.members).map(m=>m.actorId).filter(Boolean):null,
      requestCount:0,readState:s.activeRound?.fileKnowledge?.version===fileKnowledge.VERSION?copy(s.activeRound.readState||{}):{},
      fileKnowledge:s.activeRound?.fileKnowledge?.version===fileKnowledge.VERSION?copy(s.activeRound.fileKnowledge):fileKnowledge.create(inputRound),
      receipts:{},complete:false,summary:[]};
    fileKnowledge.setTurn(s.activeRound.fileKnowledge,inputRound);
    s.status='running';s.error=null;s.lastChanges=[];
    if(!keepDraft){s.draft='';s.privateDraft='';}s.draftRound=inputRound+1;
    if(!isStart){if(options.actions){for(const action of options.actions)emit(s,'player',{actorId:action.actorId,content:action.content||(action.skip?'等待局势发展。':''),privateContent:action.privateContent||'',...action.disguise?{disguise:true}:{},audience:'public',skip:!!action.skip,roundId});}else emit(s,'player',{actorId:s.actorId,content:actionText,name:'player_action',args:{action:actionText},skip:!!options.skip,roundId});}
    const round=s.activeRound,instruction=slots.roundInstruction(s,isStart,options);
    if(isStart&&opening?.internal)s.messages.push({role:'user',content:'[开局内部说明]\n'+opening.internal,internal:true,round:round.number});
    if(isStart&&opening?.story){
      round.presetOpening=opening.story;
      s.openingPending={prompt:String(prompt),instruction};
    }else{
      if(s.openingPending){
        for(const content of [s.openingPending.prompt,s.openingPending.instruction,options.presetFollowup])if(content)s.messages.push({role:'user',content,internal:true,round:round.number});
        round.deferredOpening=true;delete s.openingPending;
      }
      s.messages.push({role:'user',content:String(prompt),round:round.number});
      if(instruction)s.messages.push({role:'user',content:instruction,internal:true,round:round.number});
      if(opening)round.openingExtraReads=opening.extra;
    }
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

  function contextRebuildInfo(s) {
    if(s.pendingManualDice)throw Error('请先完成待结算的手动检定，再重建上下文');
    return {saveId:s.id,updatedAt:s.updatedAt,name:s.name,
      toolCalls:s.messages.reduce((n,m)=>n+(m.tool_calls?.length||0),0),
      messages:s.messages.length,requests:s.requestHistory?.length||0,snapshots:s.snapshots?.length||0,
      stories:s.events.filter(e=>e.type==='story').length,
      unfinished:!!s.activeRound&&!s.activeRound.complete};
  }
  function rebuildContext(s,opts={}) {
    const info=contextRebuildInfo(s),old=s.activeRound,current=old?.number||Math.max(1,s.round);
    // Rebuild from published game events, never from arbitrary assistant text or tool arguments.
    const common=['id','type','round','at','worldTime','content','audience','private','actorId','roundId','speaker','privateContent','disguise','skip',
      'secret','playerRelated','roller','rollerId','rollerKind','targetPlayer','description','relatedAttr','data','manual','pending','playerState','name'];
    const diceFields=['description','roller','related_attr','is_secret','is_private','target_player','dice_dict','calculate_only','target_value','compare_mode',
      'critical_success_range','critical_failure_range','dice_combine_mode','left_modifiers','right_modifiers'];
    const events=s.events.filter(e=>['player','story','dice','note','round_end'].includes(e.type)).map(e=>{
      const event=Object.fromEntries(common.filter(k=>Object.hasOwn(e,k)).map(k=>[k,copy(e[k])]));
      // Published roll rules are game facts used by the detail panel, including named modifiers.
      if(e.type==='dice'&&object(e.diceArgs))event.diceArgs=Object.fromEntries(diceFields.filter(k=>Object.hasOwn(e.diceArgs,k)).map(k=>[k,copy(e.diceArgs[k])]));
      return event;
    });
    const messages=[];
    for(const e of events) {
      const round=e.round||1,content=typeof e.content==='string'?e.content:'';
      if(e.type==='player')messages.push({role:'user',round,origin:'rebuilt-action',
        content:'[玩家行动'+(e.actorId?' · '+e.actorId:'')+']\n'+content+
          (e.privateContent?'\n[该玩家的私密行动，仅主持人可见]\n'+e.privateContent:'')});
      if(e.type==='story')messages.push({role:'assistant',round,origin:'rebuilt-story',
        content:(e.private||e.audience&&e.audience!=='public'?'[私密剧情，受众：'+JSON.stringify(e.audience||'host')+']\n':'')+content});
      if(e.type==='dice')messages.push({role:'user',round,origin:'rebuilt-dice',
        content:'[已发生的检定 · 沿用结果，不要重掷；保留原受众与暗骰限制]\n'+JSON.stringify(
          Object.fromEntries(['content','roller','description','relatedAttr','secret','audience','playerRelated','data','diceArgs'].filter(k=>Object.hasOwn(e,k)).map(k=>[k,e[k]])))});
    }
    const awaitingStart=s.status==='new'&&!old;
    const state={round:current,completed_round:s.round,complete:old?.complete??true,awaiting_start:awaitingStart,
      triggered:!!old?.triggered,published:old?.published||0,private_published:old?.privatePublished||0,
      actions:recovery.actions(s),NEXT_TURN_CACHE:copy(s.cache||{}),
      slots:(s.slots||[]).map(({id,path,kind})=>({id,path,kind}))};
    if(info.unfinished&&old.starting){
      const internal=vfs.resolve(s.tree,['workspace','开局内部说明.md']);
      if(internal?.type==='file'&&internal.encoding!=='base64'&&typeof internal.content==='string'&&internal.content.trim())
        messages.push({role:'user',round:current,internal:true,content:'[开局内部说明]\n'+internal.content});
    }
    if(info.unfinished&&opts.roundPrompt)messages.push({role:'user',round:current,content:opts.roundPrompt});
    if(s.summaries?.length)messages.unshift({role:'user',round:1,origin:'rebuilt-summaries',
      content:'[保留的前情摘要]\n'+s.summaries.slice(-30).map(e=>'第'+e.round+'回合：'+e.content).join('\n')});
    messages.push({role:'user',round:current,origin:'context-rebuild',contextCache:copy(s.cache||{}),
      content:'[上下文已重建]\n'+JSON.stringify(state)+'\n旧工具调用、回执、思考及文件读取依据已清除；此前未执行的调用已放弃。'+
        '存档文件和已发布剧情代表已经发生的事实；'+(awaitingStart?'尚未正式开局，之后按正常开局流程开始。':'按当前系统规则从上述进度继续，不得重新开局、重掷已有检定或重复发布已有正文。')+
        '已获取本轮行动时不要重复获取；已有公开正文时可继续必要的自查和回合收尾。操作文件前按需重新读取。'});
    // Replacing the round object also expires request-local small-read advice.
    let round=old?copy(old):null;
    if(round){
      round.readState={};round.fileKnowledge=fileKnowledge.create(current);round.receipts={};
      round.requestCount=0;delete round.requestLimit;delete round.promptSnapshot;
      if(opts.system!==undefined)round.promptSnapshot={overrides:{},system:opts.system};
      if(info.unfinished){
        round.contextRebuildBaseline=copy(s.tree);
        round.openingReadsPrepared=true;
        if(round.presetOpening&&round.published){delete round.presetOpening;delete round.presetPrepared;}
        else if(round.presetOpening)round.presetPrepared=false;
      }else delete round.contextRebuildBaseline;
    }
    if(s.openingPending&&opts.startPrompt)s.openingPending={...s.openingPending,prompt:opts.startPrompt};
    s.messages=messages;s.events=events;s.requestHistory=[];s.snapshots=[];s.activeRound=round;
    s.contextFromRound=1;s.lastChanges=[];s.error=null;s.updatedAt=Date.now();
    if(info.unfinished)s.status='interrupted';
    return info;
  }
  function rollback(s) {
    pruneRollback(s);const snap=s.snapshots.pop();if(!snap)throw Error('没有可回退的回合');
    const input=inputs.retract(s,snap.round+1,snap.inputRoundId);
    s.tree=copy(snap.tree);s.messages.length=snap.messageCount;s.events.length=snap.eventCount;
    s.round=snap.round;s.cache=copy(snap.cache);s.summaries.length=snap.summaryCount;s.status=snap.status;
    if(snap.worldTriggers)s.worldTriggers=copy(snap.worldTriggers);else delete s.worldTriggers;
    if(snap.openingPending)s.openingPending=copy(snap.openingPending);else delete s.openingPending;
    if(snap.slotControlState)s.slotControlState=copy(snap.slotControlState);else delete s.slotControlState;
    s.draft=input?.text??(snap.draftRound==null||snap.draftRound===snap.round+1?snap.draft||'':'');s.draftRound=snap.round+1;inputs.advance(s);
    if(input?.draftState)Object.assign(s,input.draftState);
    s.contextFromRound=snap.contextFromRound;s.lastChanges=copy(snap.lastChanges);s.activeRound=null;s.error=null;
    const previous=s.snapshots.at(-1);
    if(previous&&!previous.tree){previous.tree=restoreTreeDelta(s.tree,previous.reverseDelta);delete previous.reverseDelta;}
    s.slots=snap.slots||s.slots;s.actorId=snap.actorId||s.actorId;slots.ensure(s);s.playerPath=validateTree(s.tree,snap.playerPath||s.playerPath);s.updatedAt=Date.now();
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
  function player(s,section,{includeHidden=false}={}) {
    const info=section==='items'?{}:data.displayPaths(s,includeHidden?readJson(s,s.playerPath+'/基础信息.json',{}):filterVisible(readJson(s,s.playerPath+'/基础信息.json',{})),{includeHidden});
    if(!object(info))throw Error('基础信息.json 必须是 JSON 对象');
    if(section==='info')return {info,name:data.get(info,'姓名')||s.playerPath.split('/').pop()};
    const bag=readJson(s,s.playerPath+'/背包.json',[]);
    if(!Array.isArray(bag)&&!object(bag))throw Error('背包.json 必须是数组或兼容的物品列表对象');
    let list=Array.isArray(bag)?bag:(bag.物品||bag.Items||bag.items||bag.背包||Object.values(bag));
    if(!Array.isArray(list))list=Object.values(list||{});
    const items=list.filter(i=>includeHidden||!object(i)||!hiddenFlag(i['.是否对玩家隐藏'])).map(i=>{
      if(typeof i!=='string')return includeHidden?i:filterVisible(i,true);
      let p=i.replace(/\\/g,'/').replace(/^\/?workspace\//,'').replace(/\/$/,'');
      if(!p.startsWith('存档-索引-物品/'))p='存档-索引-物品/'+p;
      if(!p.endsWith('.json'))p+='/物品基础信息.json';
      const detail=readJson(s,p,null);return detail&&!includeHidden&&hiddenFlag(detail['.是否对玩家隐藏'])?null:detail?(includeHidden?detail:filterVisible(detail,true)):{名称:i};
    }).filter(i=>i!==null);
    return {info,items,name:data.get(info,'姓名')||s.playerPath.split('/').pop()};
  }
  const actorKey=v=>String(v||'').trim().toLowerCase().replace(/[\s·._-]+/g,'');
  function diceActors(s){
    const all=slots.scan(s.tree).filter(x=>x.kind!=='disabled');
    const npcs=vfs.resolve(s.tree,['workspace','存档-索引-NPC']);
    for(const node of Object.values(npcs?.children||{}))if(node.type==='dir')all.push({id:node.name,path:'/workspace/存档-索引-NPC/'+node.name,kind:'npc'});
    return all;
  }
  function resolveDiceActor(s,value,playersOnly=false){
    const raw=String(value||'').trim().replace(/\\/g,'/').replace(/\/$/,''),key=actorKey(raw),all=diceActors(s).filter(x=>!playersOnly||x.kind==='player');
    if(!playersOnly&&raw==='<|GM|>')return {id:'<|GM|>',kind:'gm'};
    let found=all.filter(x=>x.path===raw||x.path.replace('/workspace/','')===raw||x.path.split('/').pop()===raw);
    if(!found.length)found=all.filter(x=>x.id===raw);
    if(!found.length&&['玩家','玩家角色','主角','你','player','pc'].includes(key))found=all.filter(x=>x.kind==='player');
    if(!found.length)found=all.filter(x=>{try{return actorKey(data.get(readJson(s,x.path+'/基础信息.json',{}),'姓名'))===key;}catch(_){return false;}});
    if(found.length!==1)throw Error((playersOnly?'私密信息接收者必须是现有 Player，':'roller 角色')+'不存在或有歧义，请使用实际角色目录或唯一 ID');
    const info=readJson(s,found[0].path+'/基础信息.json',null);if(!object(info))throw Error('角色基础信息不存在或无效：'+found[0].path);
    return found[0];
  }
  function dicePlayerRelated(s,a={}){try{return resolveDiceActor(s,a.roller).kind==='player';}catch(_){return false;}}
  const diceSecret=a=>a?.is_secret===true||String(a?.related_attr||'').trim()==='心理学';
  const recipient=(s,id)=>resolveDiceActor(s,id,true);
  function diceIdentity(s,a){
    if(a.is_private!==undefined&&typeof a.is_private!=='boolean')throw Error('is_private 必须是 true 或 false');
    if(a.target_player!==undefined&&typeof a.target_player!=='string')throw Error('target_player 必须是 Player ID 字符串');
    const roller=resolveDiceActor(s,a.roller),isPrivate=a.is_private===true;
    if(!isPrivate&&String(a.target_player||'').trim())throw Error('target_player 仅在 is_private:true 时使用');
    const target=isPrivate&&(roller.kind!=='gm'||String(a.target_player||'').trim())?recipient(s,a.target_player||a.roller):null;
    return {rollerId:roller.id,rollerKind:roller.kind,private:isPrivate,targetPlayer:target?.id||null,
      audience:roller.kind==='gm'?[]:isPrivate?[target.id]:'public',secret:diceSecret(a),playerRelated:roller.kind!=='gm'&&(roller.kind==='player'||isPrivate)};
  }
  function diceEventAccess(s,e,actorId){
    const args=e.diceArgs||{},roller=e.roller||args.roller||'',isPrivate=e.private===true||args.is_private===true||Array.isArray(e.audience)&&e.audience.length>0;
    let kind=e.rollerKind,id=e.rollerId,target=e.targetPlayer;
    if(roller==='<|GM|>')kind='gm';
    if(!kind)try{const resolved=resolveDiceActor(s,roller);kind=resolved.kind;id=resolved.id;}catch(_){kind=e.playerRelated===true||!roller&&e.playerRelated!==false?'player':'unknown';}
    if(isPrivate&&!target)try{target=recipient(s,args.target_player||roller).id;}catch(_){if(Array.isArray(e.audience)&&e.audience.length===1)target=e.audience[0];}
    const audience=e.audience===undefined?(isPrivate?target?[target]:[]:'public'):e.audience;
    const granted=audience==='public'||Array.isArray(audience)&&audience.includes(actorId);
    const visible=kind!=='gm'&&granted&&(!isPrivate||target===actorId)&&(kind==='player'||isPrivate);
    return {visible,rollerId:id,rollerKind:kind,private:isPrivate,targetPlayer:target||null,audience,playerRelated:kind!=='gm'&&(kind==='player'||isPrivate),secret:e.secret===true||diceSecret(args)||String(e.relatedAttr||'').trim()==='心理学'};
  }
  const visibleEvents=(s,mode)=>mode==='debug'?s.events:s.events.filter(e=>{
    const id=s.actorId||s.playerPath?.split('/').pop().replace(/^Player-/,'');
    if(e.type==='dice')return diceEventAccess(s,e,id).visible;
    if(e.type==='player'&&e.actorId!==id&&e.privateContent&&!String(e.content||'').trim()&&!e.skip)return false;
    if(e.audience!==undefined&&e.audience!=='public'&&(!Array.isArray(e.audience)||!e.audience.includes(id)))return false;
    return !e.secret&&(['player','story','round_end','note'].includes(e.type)||e.type==='warning'&&e.code==='INVALID_TOOL_ARGUMENTS');
  }).map(e=>{const x=copy(e),id=s.actorId||s.playerPath?.split('/').pop().replace(/^Player-/,'');if(x.actorId!==id){delete x.privateContent;delete x.disguise;}
    if(x.type==='dice'){const {visible,...access}=diceEventAccess(s,e,id);Object.assign(x,access);if(x.secret){delete x.data;delete x.diceArgs;delete x.content;delete x.description;delete x.relatedAttr;}}return x;
  });
  function requireText(v,label){if(typeof v!=='string'||!v.trim())throw Error(label+' 不得为空');return v;}
  function finite(v,label){if(typeof v!=='number'||!Number.isFinite(v))throw Error(label+' 必须是有限数值');return v;}
  function modifiers(x){if(x==null)return 0;if(!object(x))throw Error('修正值必须是对象');return Object.values(x).reduce((n,v)=>n+finite(v,'修正值'),0);}
  function randInt(min,max,random=Math.random){if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||max<min||max-min>1e9)throw Error('随机范围无效');return min+Math.floor(random()*(max-min+1));}
  function toolFailureSuggestion(name,args,message){
    const m=String(message||'');
    if(name==='roll_dice'){
      if(/缺少必填参数/.test(m))return '请补齐 roll_dice 的全部字段。无修正填 {}；无大成功/大失败区间填 null；正式检定必须填写 target_value 和 compare_mode。';
      if(/正式检定禁止使用裸整数|骰子格式应为/.test(m))return '随机骰请把 dice_dict 写成 NdM，例如 {"d100":"1d100"}；若确实要固定结果，写 set-force:N，例如 {"d100":"set-force:1"}。不要用裸整数 "1" 代表骰子。';
      if(/critical_(success|failure)_range|闭区间/.test(m))return '大成功/大失败区间请使用 JSON 数组，例如 "critical_success_range":[1,14]、"critical_failure_range":[96,100]；不用时填 null。';
      if(/target_value|compare_mode/.test(m))return '正式检定请提供数值 target_value 和 compare_mode（gt/lt/ge/le/ne/eq）；仅 calculate_only:true 时可填 null。';
      if(/left_modifiers|right_modifiers|修正值/.test(m))return '修正请写成对象，例如 "left_modifiers":{"环境":-10}；没有修正时两个字段都填写 {}。';
      if(/roller 角色|接收者|target_player|角色基础信息/.test(m))return '请核对实际角色目录与基础信息，roller 使用唯一角色 ID；私密目标只能是有效 Player-ID。多人时不要使用含糊的主角或玩家。';
      if(/description|roller|related_attr|is_secret|calculate_only|dice_combine_mode/.test(m))return '请按完整 roll_dice 结构重试，所有字段都必须显式填写。';
    }
    if(/修改前先 read_file/.test(m))return '先用 read_file 读取该文件的最新内容，再进行修改。';
    if(/文件不存在/.test(m))return '先用 list_dir/tree/search 确认实际路径，再按存在的路径重试。';
    return '';
  }
  const DICE_REQUIRED=['description','roller','related_attr','is_secret','dice_dict','calculate_only','target_value','compare_mode','critical_success_range','critical_failure_range','dice_combine_mode','left_modifiers','right_modifiers'];
  function diceRange(value,key){
    if(value===null||value==='')return null;
    let r=value;
    if(typeof r==='string'){
      const text=r.trim();
      if(/^[-+]?\d+(?:\.\d+)?\s*,\s*[-+]?\d+(?:\.\d+)?$/.test(text))r=text.split(',').map(Number);
      else try{r=JSON.parse(text);}catch(_){throw Error(key+' 格式错误：请使用 JSON 数组 [min,max]，例如 [1,14]，不要写成 "1,14"');}
    }
    if(!Array.isArray(r)||r.length!==2||!r.every(Number.isFinite)||r[0]>r[1])throw Error(key+' 必须是两个数字组成的闭区间 [min,max]，不用时填写 null');
    return r;
  }
  function diceRequest(a){
    if(!object(a))throw Error('roll_dice 参数必须是对象');
    const missing=DICE_REQUIRED.filter(k=>!Object.hasOwn(a,k));if(missing.length)throw Error('roll_dice 缺少必填参数：'+missing.join('、'));
    requireText(a.description,'description');requireText(a.roller,'roller');requireText(a.related_attr,'related_attr');
    if(typeof a.is_secret!=='boolean')throw Error('is_secret 必须是 true 或 false');
    if(a.is_private!==undefined&&typeof a.is_private!=='boolean')throw Error('is_private 必须是 true 或 false');
    if(typeof a.calculate_only!=='boolean')throw Error('calculate_only 必须是 true 或 false');
    if(!object(a.dice_dict)||!Object.keys(a.dice_dict).length)throw Error('dice_dict 不得为空');
    const compare={gt:(x,y)=>x>y,ge:(x,y)=>x>=y,lt:(x,y)=>x<y,le:(x,y)=>x<=y,eq:(x,y)=>x===y,ne:(x,y)=>x!==y};
    if(!a.calculate_only&&(!Object.hasOwn(compare,a.compare_mode)||!Number.isFinite(a.target_value)))throw Error('正式检定需要数值 target_value 与有效 compare_mode；仅 calculate_only:true 时二者可填写 null');
    if(a.calculate_only&&a.target_value!==null&&!Number.isFinite(a.target_value))throw Error('target_value 必须是有限数值或 null');
    if(a.calculate_only&&a.compare_mode!==null&&!Object.hasOwn(compare,a.compare_mode))throw Error('compare_mode 必须是 gt/lt/ge/le/ne/eq 或 null');
    const mode=a.dice_combine_mode;if(!['sum','max','min','independent'].includes(mode))throw Error('dice_combine_mode 必须是 sum/max/min/independent');
    if(!object(a.left_modifiers)||!object(a.right_modifiers))throw Error('left_modifiers 与 right_modifiers 必须都是对象；没有修正时填写 {}');
    const left=modifiers(a.left_modifiers),right=modifiers(a.right_modifiers);
    const ranges={};for(const k of ['critical_success_range','critical_failure_range']){const r=diceRange(a[k],k);if(r)ranges[k]=r;}
    const successRange=ranges.critical_success_range,failureRange=ranges.critical_failure_range;
    if(successRange&&failureRange&&Math.max(successRange[0],failureRange[0])<=Math.min(successRange[1],failureRange[1]))throw Error('大成功与大失败的闭区间不能重叠（包括共同端点），请修正后重新调用 roll_dice');
    const specs=Object.entries(a.dice_dict).map(([label,value])=>{
      const formula=String(value).trim(),m=formula.match(/^(-?)(\d+)d(\d+)$/i),forced=formula.match(/^set-force:(-?\d+)$/i);
      if(m){const n=Number(m[2]),faces=Number(m[3]);if(n<1||n>1000||faces<1||faces>1e9)throw Error('骰子数量或面数超出范围');return {label,formula,n,faces,sign:m[1]?-1:1};}
      if(forced){const value=Number(forced[1]);if(!Number.isSafeInteger(value))throw Error('set-force 的值必须是安全整数');return {label,formula,forced:value};}
      if(!/^-?\d+$/.test(formula)||!Number.isSafeInteger(Number(formula)))throw Error('骰子格式应为 NdM、-NdM、set-force:N，或仅在 calculate_only:true 时使用整数');
      return {label,formula,constant:Number(formula)};
    });
    if(!a.calculate_only&&specs.some(r=>r.constant!==undefined))throw Error('正式检定禁止使用裸整数；随机骰使用 NdM / -NdM，明确固定结果使用 set-force:N，固定修正使用 left_modifiers / right_modifiers');
    if(mode==='independent'){
      const shape=r=>r.n!==undefined?`dice:${r.n}:${r.faces}:${r.sign}`:r.forced!==undefined?'forced':'constant';
      if(new Set(specs.map(shape)).size>1)throw Error('independent 只能批量处理同一骰式、同一套检定规则。不同用途或骰子规格请拆开，分别调用 roll_dice；例如先进行 SAN 检定，再用 calculate_only:true 计算损失。');
    }
    return {compare,mode,left,right,ranges,specs};
  }
  function dice(a,random=Math.random,fixedRolls=null){
    let fixedIndex=0;
    const {compare,mode,left,right,ranges,specs}=diceRequest(a);
    const rows=specs.map(r=>{const rolls=r.n?Array.from({length:r.n},()=>{
      if(Array.isArray(fixedRolls)){
        if(fixedIndex>=fixedRolls.length)throw Error('手动掷骰结果数量不足');
        const value=Number(fixedRolls[fixedIndex++]);if(!Number.isSafeInteger(value)||value<1||value>r.faces)throw Error('手动掷骰结果超出骰面范围');
        return value*r.sign;
      }
      return randInt(1,r.faces,random)*r.sign;
    }):[r.forced!==undefined?r.forced:r.constant];return {label:r.label,formula:r.formula,rolls,total:rolls.reduce((x,y)=>x+y,0),forced:r.forced!==undefined};});
    if(Array.isArray(fixedRolls)&&fixedIndex!==fixedRolls.length)throw Error('手动掷骰结果数量不匹配');
    function judge(raw){const total=raw+left,target=(a.target_value||0)+right;const hints=[];
      if(!a.calculate_only&&ranges.critical_success_range&&raw>=ranges.critical_success_range[0]&&raw<=ranges.critical_success_range[1])hints.push('可能是大成功');
      if(!a.calculate_only&&ranges.critical_failure_range&&raw>=ranges.critical_failure_range[0]&&raw<=ranges.critical_failure_range[1])hints.push('可能是大失败');
      return {raw,total,target,success:a.calculate_only?null:compare[a.compare_mode](total,target),criticalHints:hints,critical:hints.join('，')||null,special:!a.calculate_only&&hints.length>0};}
    const raw=mode==='max'?Math.max(...rows.map(r=>r.total)):mode==='min'?Math.min(...rows.map(r=>r.total)):rows.reduce((n,r)=>n+r.total,0);
    const summary=judge(raw);
    if(mode==='independent')Object.assign(summary,{success:null,criticalHints:[],critical:null,special:false});
    const result={rows:mode==='independent'?rows.map(r=>({...r,left,right,compare_mode:a.compare_mode,...judge(r.total)})):rows,mode,left,right,compare_mode:a.compare_mode,...summary};
    const describe=r=>r.special?r.raw+' · '+r.critical+'（已忽略修正值，已省略比较）':r.total+(r.success===null?'':(' '+({gt:'>',ge:'≥',lt:'<',le:'≤',eq:'=',ne:'≠'}[r.compare_mode||a.compare_mode])+' '+r.target+' · '+(r.success?'通过':'未通过')));
    const resultText=mode==='independent'?result.rows.map(r=>r.label+': '+describe(r)).join('；'):describe(result);
    return {data:result,content:`${a.roller||'角色'} · ${a.description||a.related_attr||'掷骰'}\n${rows.map(r=>`${r.label} ${r.formula} [${r.rolls.join(', ')}]`).join('；')}\n${resultText}`};
  }
  function execute(s,name,a={},callId=uid(),options={}) {
    const round=s.activeRound;if(!round)return {ok:false,error:'尚未开始回合'};
    if(Object.hasOwn(round.receipts,callId))return copy(round.receipts[callId]);
    const knowledge=round.fileKnowledge||(round.fileKnowledge=fileKnowledge.create(round.number));fileKnowledge.setTurn(knowledge,round.number);
    
    
    const before=copy({tree:s.tree,slots:s.slots,cache:s.cache,round:s.round,status:s.status,playerPath:s.playerPath,
      summaries:s.summaries,lastChanges:s.lastChanges,activeRound:round});
    const eventCount=s.events.length;
    let out;
    try{
      if(round.complete)throw Error('回合已经结束，不能继续执行工具');
      if(!object(a))throw Error('参数必须是对象');
      const invalidFileArgs=toolArguments.validateFiles(name,a);if(invalidFileArgs)throw Error(invalidFileArgs);
      const p=a.path===undefined?'/workspace':path(a.path);
      const record=(fp,kind='read')=>{const node=vfs.resolve(s.tree,vfs.normalize(fp));if(node?.type==='file'&&node.encoding!=='base64'){round.readState[fp]=node.content;fileKnowledge.record(knowledge,fp,callId,kind);}};
      const read=(input)=>{
        const fp=path(input.path),resource=options.resource?.(fp)??options.resource?.(String(input.path));
        const n=vfs.resolve(s.tree,vfs.normalize(fp));
        
        const finish=(content,result)=>{const hint=fileReads.hint(round,fp,content,result,round.number);return hint?{...result,read_hint:hint}:result;};
        if(resource!==undefined)return finish(resource,vfs.readText(resource,{...input,cap:120000,defaultLimit:32000}));
        if(!n&&fp.startsWith('/workspace/')&&['开场说明.md','开场白.md','样例开场.md','开场原文.txt','开场剧情.txt'].includes(fp.split('/').at(-1)))return {content:'',offset:0,totalLength:0,truncated:false,exists:false,optional:true};
        if(!n)throw Error('文件不存在: '+fp);
        const r=vfs.readFile(s.tree,fp,{offset:input.offset,limit:input.limit,tail_chars:input.tail_chars,cap:120000});record(fp);return finish(n.content,r);
      };
      const writable=fp=>{
        if(fp==='/.reference'||fp.startsWith('/.reference/')||fp==='/prompts'||fp.startsWith('/prompts/')||options.resource?.(fp)!==undefined)throw Error('提示词为只读资源');
        const role=/^\/workspace\/((Player|AIPC|DISABLE|KPC)-[^/]*)(?:\/|$)/.exec(fp);
        if(role&&(role[2]==='DISABLE'||!vfs.resolve(s.tree,['workspace',role[1]])))throw Error('角色槽位由宿主管理，不能新增槽位或修改关闭角色');
      };
      const readFirst=(fp,overwrite=false)=>{writable(fp);const n=vfs.resolve(s.tree,vfs.normalize(fp));if(n?.type==='file'){
        if(round.readState[fp]!==n.content||!fileKnowledge.fresh(knowledge,fp))throw Error('修改前先 read_file 读取最新内容（未读取、内容已变化或读取依据已离开上下文）: '+fp);
        if(overwrite&&!fileKnowledge.canOverwrite(knowledge,fp))throw Error('整份覆盖前请先 read_file：基础读取或完整写入须来自本回合或上一回合；局部替换、追加不会刷新覆盖期限: '+fp);
      }};
      const readSubtreeFirst=fp=>{readFirst(fp);const n=vfs.resolve(s.tree,vfs.normalize(fp));if(n?.type==='dir')for(const child of Object.values(n.children))readSubtreeFirst(fp+'/'+child.name);};
      let result;
      switch(name){
        case 'trigger_next_round':{
          const plan=jsonObject(a.phase_plan,'phase_plan');if(typeof plan.Countdowns!=='string'||!plan.Countdowns.trim()||!Array.isArray(plan.Pending_Triggers)||typeof plan.Forced_Checks!=='string'||!plan.Forced_Checks.trim())throw Error('phase_plan 需要非空文本 Countdowns、Forced_Checks 和数组 Pending_Triggers');
          plan.Pending_Triggers.forEach((entry,i)=>{if(!object(entry))throw Error('phase_plan.Pending_Triggers['+i+'] 必须是对象；没有触发器时填写 []');});
          round.triggered=true;
          const participantIds=round.participantIds??(s.multiplayer?.members?Object.values(s.multiplayer.members).map(m=>m.actorId).filter(Boolean):null),participants=participantIds?new Set(participantIds):null;
          const actors=slots.scan(s.tree).filter(x=>x.kind!=='disabled'&&(x.kind!=='player'||!participants||participants.has(x.id))).map(x=>({...x,...data.actorState(readJson(s,x.path+'/基础信息.json',{}))}));
          const living=actors.filter(x=>x.kind==='player'&&x.alive),unconsciousActors=living.length&&living.every(x=>!x.enabled)?living.map(x=>x.id):[];
          const warnings=round.number>3?data.references(s,plan.Pending_Triggers):[];
          const instruction=options.multiplayerPrompts?.ai_roles||'AIPC/KPC 由主持人依照人设代为行动；死亡者不能行动，无意识者只能等待。';
          result={actions:recovery.actions(s),...round.actions?.some(a=>a.disguise)?{disguiseInstruction:'disguise=true 的 content 是角色对外公开的伪装说辞，真实行动以 privateContent 为准。按角色感知与动机决定他人能发现什么；不在公开正文中泄露真实行动或伪装标记。'}:{},actors,
            instruction:instruction+(unconsciousActors.length?'\n'+(options.multiplayerPrompts?.all_unconscious||'所有存活玩家均失去意识。推进时间并描写苏醒，通过工具恢复这些存活角色的 Enabled，不恢复死亡角色。').replace('{actorIds}',unconsciousActors.join('、')):''),
            ...(unconsciousActors.length?{unconsciousActors}:{}),...(warnings.length?{warnings}:{})};break;
        }
        case 'private_append_story':{
          if(!round.triggered)throw Error('先调用 trigger_next_round 获取玩家行动');
          if(!Array.isArray(a.entries)||!a.entries.length)throw Error('entries 不得为空');
          const entries=a.entries.map((e,i)=>{const key='entries['+i+']';if(!object(e))throw Error(key+' 必须是包含 id 和 story 的对象');return {slot:recipient(s,requireText(e.id,key+'.id')),content:requireText(e.story,key+'.story').trim()};});
          for(const e of entries){if(s.events.some(x=>x.type==='story'&&x.round===round.number&&x.content===e.content&&Array.isArray(x.audience)&&x.audience.includes(e.slot.id)))continue;
            emit(s,'story',{content:e.content,audience:e.slot.kind==='player'?[e.slot.id]:'host',private:true});}
          round.privatePublished=(round.privatePublished||0)+entries.length;result={status:options.multiplayerPrompts?.private_story_follow_up||'Private story published; finish public output or use skip_output'};break;
        }
        case 'append_story':{
          if(!round.triggered)throw Error('先调用 trigger_next_round 获取玩家行动');
          requireText(a.one_line_summary_of_content,'one_line_summary_of_content');
          if(Object.hasOwn(a,'skip_output')&&typeof a.skip_output!=='boolean')throw Error('skip_output 必须是 true 或 false；默认行为请省略此参数');
          if(Object.hasOwn(a,'content')&&typeof a.content!=='string')throw Error('content 必须是字符串');
          if(a.skip_output===true){if(!round.privatePublished||String(a.content||'').trim())throw Error('skip_output 仅限本轮已有私密输出且公开正文为空');round.published++;round.summary.push(a.one_line_summary_of_content);result={status:'Public output skipped'};break;}
          requireText(a.content,'content');
          const content=a.content.trim();if(s.events.some(e=>e.type==='story'&&e.round===round.number&&e.content.trim()===content))throw Error('此内容已经输出成功，请勿重复发布；如需继续请追加不同的下一段');
          player(s);emit(s,'story',{content,worldTime:data.worldTime(s)});round.published++;round.summary.push(a.one_line_summary_of_content);
          result={status:'Story appended successfully; warnings are advisory, do not republish',warnings:data.validate(s)};break;
        }
        case 'end_the_round':{
          if(!round.published)throw Error('先成功调用 append_story 输出故事');
          const cache=jsonObject(a.NEXT_TURN_CACHE,'NEXT_TURN_CACHE');if(!['游戏前准备','游戏循环','游戏结束'].includes(cache.Story_Phase))throw Error('NEXT_TURN_CACHE.Story_Phase 无效');
          if(Object.hasOwn(cache,'game_over')&&typeof cache.game_over!=='boolean')throw Error('NEXT_TURN_CACHE.game_over 必须是 true 或 false');
          s.playerPath=validateTree(s.tree,s.playerPath);slots.ensure(s);for(const actor of slots.scan(s.tree).filter(x=>x.kind!=='disabled'))player({...s,playerPath:actor.path});
          s.cache=copy(cache);s.round=round.number;s.status=cache.game_over===true?'ended':'waiting';round.complete=true;
          s.summaries.push({round:s.round,content:round.summary.join('；'),worldTime:data.worldTime(s),at:Date.now()});
          emit(s,'round_end',{content:'第 '+s.round+' 回合结束'});
          const roundStart=s.snapshots.at(-1)?.tree||round.contextRebuildBaseline;
          let playerState;
          if(roundStart){
            const humans=slots.scan(s.tree).filter(actor=>actor.kind==='player');
            const filesChanged=JSON.stringify(player({...s,tree:roundStart}))!==JSON.stringify(player(s));
            if(filesChanged||humans.length>1){
              const afterPlayer=player(s);
              const actors=Object.fromEntries(humans.map(actor=>{const view=player({...s,playerPath:actor.path});return [actor.id,{info:copy(view.info),items:copy(view.items)}];}));
              playerState={round:s.round,worldTime:data.worldTime(s),at:Date.now(),actorId:s.actorId,info:copy(afterPlayer.info),items:copy(afterPlayer.items),actors};
            }
          }
          history.archive(s,playerState);
          s.lastChanges=roundStart?changes(roundStart,s.tree).filter(c=>!history.generated(c.path)):[];
          delete round.contextRebuildBaseline;
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
          const content=node.content+a.content;vfs.writeFile(s.tree,p,content,writeOptions);
          result={path:p,appended:a.content.length,totalLength:content.length};break;
        }
        case 'write_file':readFirst(p,true);if(typeof a.content!=='string')throw Error('content 必须是文本');vfs.writeFile(s.tree,p,a.content,writeOptions);result={path:p,written:a.content.length};break;
        case 'apply_patch':readFirst(p);vfs.applyPatches(s.tree,p,a.patches||[{old_str:a.old_str,new_str:a.new_str}],writeOptions);result={path:p,applied:a.patches?.length||1};break;
        case 'mkdir':writable(p);vfs.mkdir(s.tree,p);result={path:p};break;
        case 'delete':if(p==='/workspace'||slots.scan(s.tree).some(x=>x.path===p))throw Error('角色目录由槽位管理，不能删除');readSubtreeFirst(p);vfs.deletePath(s.tree,p);result={path:p};break;
        case 'move':case 'copy':{
          const from=path(a.from),to=path(a.to);if([from,to].some(x=>/^\/workspace\/(Player|AIPC|DISABLE|KPC)-[^/]+$/.test(x)))throw Error('角色控制方式请通过槽位管理修改');writable(to);if(name==='move'){writable(from);if(from===s.playerPath)throw Error('不能修改玩家目录 ID');}
          if(to==='/workspace'||to.startsWith(from+'/'))throw Error('无效目标路径');vfs[name](s.tree,from,to,writeOptions);result={from,to};break;
        }
        case 'roll_dice':{
          const identity=diceIdentity(s,a),d=dice(a,options.random,options.fixedDiceRolls),payload={...d,...identity,roller:a.roller,description:a.description||'',relatedAttr:a.related_attr||'',diceArgs:copy(a),manual:!!options.manualDiceResolved,pending:false,callId};
          const pendingEvent=options.manualEventId&&s.events.find(e=>e.id===options.manualEventId);
          if(pendingEvent)Object.assign(pendingEvent,payload,{at:Date.now(),worldTime:data.worldTime(s)});
          else emit(s,'dice',payload);
          result=d;break;
        }
        case 'generate_random_number':result={value:randInt(a.min_val,a.max_val,options.random)};break;
        case 'random_select':{
          const choices=a.items||a.options||a.choices;if(!Array.isArray(choices)||!choices.length)throw Error('items 必须是非空数组');
          if(Object.hasOwn(a,'weights')&&(!Array.isArray(a.weights)||a.weights.some(w=>w!==null&&(typeof w!=='number'||!Number.isFinite(w)||w<0))))throw Error('weights 必须是非负有限数值数组；null 项沿用该选项的 weight 或默认 1');
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
      if(['write_file','append_file','apply_patch','mkdir','delete','move','copy'].includes(name)){
        const roles=tree=>Object.entries(vfs.resolve(tree,['workspace'])?.children||{}).filter(([key])=>/^(Player|AIPC|DISABLE|KPC)-/.test(key));
        const old=roles(before.tree),next=roles(s.tree),shape=xs=>JSON.stringify(xs.map(([key,node])=>[key,node.type]).sort(([a],[b])=>a.localeCompare(b)));
        if(shape(old)!==shape(next))throw Error('角色根目录集合由槽位管理，文件工具不能改变');
        for(const [key,node]of old)if(key.startsWith('DISABLE-')&&JSON.stringify(node)!==JSON.stringify(vfs.resolve(s.tree,['workspace',key])))throw Error('关闭角色资料只允许通过槽位管理恢复后修改');
        if(['write_file','append_file','apply_patch'].includes(name))record(p,name==='write_file'?'read':'weak');
        if(name==='delete'||name==='move'){
          const removed=name==='delete'?p:path(a.from);
          for(const fp of Object.keys(round.readState))if(fp===removed||fp.startsWith(removed+'/')){delete round.readState[fp];delete knowledge.entries[fp];}
        }
        if(name==='move'||name==='copy'){
          const from=path(a.from),to=path(a.to);
          for(const [fp,content] of Object.entries(before.activeRound.readState))if(fp===from||fp.startsWith(from+'/')){
            const dest=to+fp.slice(from.length),node=vfs.resolve(s.tree,vfs.normalize(dest));
            if(node?.content===content&&before.activeRound.fileKnowledge&&fileKnowledge.transfer(knowledge,fp,dest,callId,before.activeRound.fileKnowledge))round.readState[dest]=node.content;
          }
        }
      }
      out={ok:true,result:result??{status:'ok'}};
    }catch(e){
      const {activeRound,...rest}=before;Object.assign(s,rest);Object.assign(round,activeRound);s.events.length=eventCount;
      const suggestion=toolFailureSuggestion(name,a,e.message);out={ok:false,error:e.message,...(suggestion?{suggestion}:{})};
    }
    round.receipts[callId]=copy(out);emit(s,'tool',{name,args:copy(a),result:out.ok?out.result:{error:out.error,...(out.suggestion?{suggestion:out.suggestion}:{})},success:out.ok,callId,
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
  function repairManualDiceEvents(s){
    const currentPending=s.pendingManualDice?.eventId||null,tools=new Map();
    for(const e of s.events||[])if(e?.type==='tool'&&e.name==='roll_dice'&&e.success!==false&&e.callId)tools.set(e.callId,e);
    let changed=false;
    for(const e of s.events||[]){
      if(e?.type!=='dice'||e.pending!==true||!e.callId||e.id===currentPending)continue;
      const tool=tools.get(e.callId),result=tool?.result;
      if(!result||typeof result!=='object'||!result.data)continue;
      const args=tool.args&&typeof tool.args==='object'?tool.args:(e.diceArgs||{});
      let identity;try{identity=diceIdentity(s,args);}catch(_){identity={audience:[],private:true,playerRelated:false,secret:diceSecret(args)};}
      Object.assign(e,copy(result),{...identity,
        roller:e.roller||args.roller||'',
        description:e.description||args.description||'',
        relatedAttr:e.relatedAttr||args.related_attr||'',
        secret:diceSecret(args),
        diceArgs:copy(args),manual:true,pending:false,callId:e.callId
      });
      changed=true;
    }
    if(changed)s.updatedAt=Date.now();
    return changed;
  }
  function estimate(messages){let n=0;for(const m of messages){const text=typeof m==='string'?m:JSON.stringify(m);let cjk=0;for(const c of text)if(/[\u3000-\u9fff]/.test(c))cjk++;n+=cjk+Math.ceil((text.length-cjk)/4)+5;}return n;}
  // Local startup batches are durable execution records, not model-generated tool calls.
  // Project them and their receipts as user data for Chat Completions (including existing saves).
  function startupContext(source){
    const local=m=>m.role==='assistant'&&['opening-preload','preset-opening'].includes(m.origin);
    const key=(m,id)=>(m.round||1)+':'+id,localCalls=new Set(),receipts=new Map();
    for(const m of source){
      if(local(m))for(const c of m.tool_calls||[])localCalls.add(key(m,c.id));
      if(m.role==='tool')receipts.set(key(m,m.tool_call_id),m);
    }
    const parse=value=>{try{return JSON.parse(value);}catch(_){return value;}};
    return source.flatMap(m=>{
      if(m.role==='tool'&&localCalls.has(key(m,m.tool_call_id)))return [];
      if(!local(m))return [m];
      const preload=m.origin==='opening-preload';
      const record={round:m.round||1,
        instruction:preload?'以下为程序预先读取的文件资料，不是新的玩家行动。沿用读取结果；保留并注意各文件的错误、截断标记和读取范围，需要时再分段读取。':
          '以下为程序执行的预设开场记录，不是新的玩家行动。预设第一回合.md 的内容在 append_story 成功后已作为 story 正文向玩家发布。以各项回执为准，成功发布的正文及已完成的回合不得重复执行；沿用记录中的状态继续。',
        operations:(m.tool_calls||[]).map(c=>{
          const receipt=receipts.get(key(m,c.id));
          return {call_id:c.id,name:c.function.name,arguments:parse(c.function.arguments),result:receipt?parse(receipt.content):{pending:true}};
        })};
      if(m.content)record.content=m.content;
      return [{role:'user',content:(preload?'[开局预读资料]':'[预设开场执行记录]')+'\n'+JSON.stringify(record)}];
    });
  }
  function context(s,system,cap=240000,opts={}) {
    const triggerMessage=worldTriggers.prepare(s,estimate),protectedMessages=new WeakSet();
    const current=s.activeRound?.number||Math.max(1,s.round);
    let from=s.contextFromRound||1,compact=false;
    const rounds=[...new Set(s.messages.filter(m=>(m.round||1)>=from).map(m=>m.round||1))];
    const parseCache=value=>{
      try{
        const args=typeof value==='string'?JSON.parse(value):value;
        let cache=args?.NEXT_TURN_CACHE;
        if(typeof cache==='string')cache=JSON.parse(cache);
        return object(cache)?copy(cache):null;
      }catch(_){return null;}
    };
    function boundaryCache(round){
      if(round<=1)return null;
      const target=round-1;
      for(let i=s.messages.length-1;i>=0;i--){
        const m=s.messages[i],mr=m.round||1;
        if(mr>target)continue;
        if(mr<target)break;
        if(m.origin==='context-rebuild'&&object(m.contextCache))return copy(m.contextCache);
        for(let j=(m.tool_calls||[]).length-1;j>=0;j--){
          const tc=m.tool_calls[j];
          if(tc?.function?.name!=='end_the_round')continue;
          const found=parseCache(tc.function.arguments);
          if(found)return found;
        }
      }
      for(let i=(s.snapshots||[]).length-1;i>=0;i--){
        const snap=s.snapshots[i];
        if(snap?.round===target&&object(snap.cache))return copy(snap.cache);
      }
      try{
        const root=vfs.resolve(s.tree,vfs.normalize('/workspace/过往回合历史记忆'));
        const prefix='Round_'+target+'_Time_';
        const dirs=Object.values(root?.children||{}).filter(n=>n?.type==='dir'&&n.name.startsWith(prefix));
        for(let i=dirs.length-1;i>=0;i--){
          const n=dirs[i]?.children?.['ROUND_CACHE.xml'];
          if(!n||n.type!=='file'||n.encoding==='base64')continue;
          const parsed=JSON.parse(n.content.replace(/^\uFEFF/,''));
          if(object(parsed))return copy(parsed);
        }
      }catch(_){}
      return null;
    }
    function build(sourceOverride){
      const head=[{role:'system',content:system}];
      // Older rebuilt saves stored the recap at the tail. Project it before history without requiring another destructive rebuild.
      const rebuiltRecap=s.messages.find(m=>m.origin==='rebuilt-summaries');
      if(from===1&&rebuiltRecap)head.push({role:'user',content:rebuiltRecap.content});
      // With complete history, end_the_round already carries NEXT_TURN_CACHE in-place.
      // Do not prepend a changing copy: keeping the prefix append-only is critical for provider prompt caching.
      // Only reconstruct summary/cache state when old rounds have actually been truncated.
      if(from>1){
        const recap=s.summaries.filter(r=>r.round<from).slice(-30);
        if(recap.length)head.push({role:'user',content:(opts.summariesPrompt||'[前情提要]')+'\n'+recap.map(r=>`第${r.round}回合：${r.content}`).join('\n')});
        const cache=boundaryCache(from);
        if(cache&&Object.keys(cache).length)head.push({role:'user',content:(opts.cachePrompt||'[NEXT_TURN_CACHE]')+'\n'+JSON.stringify(cache)});
      }
      // Once old rounds are cropped, the boundary recap above replaces the original all-history recap.
      const source=(sourceOverride||s.messages.filter(m=>(m.round||1)>=from)).filter(m=>m.origin!=='rebuilt-summaries');
      const msgs=startupContext(compact?history.compactReads(source,current):source).map(m=>{
        const out={role:m.role,content:m.content||''};
        for(const k of ['tool_calls','tool_call_id','reasoning_content'])if(m[k]!==undefined)out[k]=copy(m[k]);return out;
      });const sent=[...head,...msgs];
      if(triggerMessage){const message={...triggerMessage};protectedMessages.add(message);sent.push(message);}
      if(opts.transformContext)for(const m of sent){m.content=opts.transformContext(m.content);if(m.tool_calls)for(const tc of m.tool_calls)tc.function.arguments=opts.transformContext(tc.function.arguments);}
      return toolArguments.project(sent);
    }
    let sent=build();
    if(estimate(sent)>cap){compact=true;sent=build();}
    if(estimate(sent)>cap&&rounds.length>1){from=rounds[Math.floor(rounds.length/2)];sent=build();
      while(estimate(sent)>cap&&from<current){const next=rounds.find(r=>r>from);if(next===undefined)break;from=next;sent=build();}}
    if(estimate(sent)>cap)sent=recovery.fit(s,s.messages.filter(m=>(m.round||1)>=from),current,cap,build,estimate,protectedMessages);
    const used=estimate(sent);
    if(used>cap)throw Object.assign(Error('自动整理后仍超过上下文上限（估算消息 '+used+' / 可用消息 '+cap+' tokens）。固定提示词或必须保留的输入过大，请在设置中调大上下文上限或降低输出上限，再点击“继续本轮”。'),{code:'CONTEXT_LIMIT',used,cap});
    if(s.activeRound?.fileKnowledge){fileKnowledge.setTurn(s.activeRound.fileKnowledge,current);fileKnowledge.retain(s.activeRound.fileKnowledge,sent,fp=>delete s.activeRound.readState[fp]);}
    s.contextFromRound=from;return sent;
  }
  function prepareOpeningReads(s){
    const round=s.activeRound;
    // Only prepare a fresh opening. Persisted calls and receipts resume through the normal batch runner.
    if(round.presetOpening||!(round.starting&&round.number===1||round.deferredOpening)||round.openingReadsPrepared||round.requestCount>0||Object.keys(round.receipts).length||s.messages.some(m=>m.round===round.number&&['assistant','tool'].includes(m.role)))return false;
    const root=vfs.resolve(s.tree,['workspace']),paths=[];
    const moduleName=['模组.md','故事.txt'].find(name=>root?.children?.[name]?.type==='file');
    if(moduleName)paths.push('/workspace/'+moduleName);
    for(const slot of slots.scan(s.tree).filter(slot=>['player','ai'].includes(slot.kind))){
      paths.push(slot.path+'/基础信息.json',slot.path+'/背包.json');
    }
    for(const p of round.openingExtraReads||[])if(!fileValidation.retiredJournal(p)&&!paths.includes(p))paths.push(p);
    round.openingReadsPrepared=true;
    const limit=Math.min(16000,Math.max(1,Math.floor(64000/Math.max(1,paths.length)))),tool_calls=[
      {id:uid(),type:'function',function:{name:'tree',arguments:JSON.stringify({path:'/workspace',depth:4})}}
    ];
    for(let i=0;i<paths.length;i+=20)tool_calls.push({id:uid(),type:'function',function:{name:'read_multiple_files',arguments:JSON.stringify({paths:paths.slice(i,i+20),limit})}});
    s.messages.push({role:'assistant',content:'',tool_calls,round:round.number,internal:true,origin:'opening-preload'});
    return true;
  }
  function preparePresetOpening(s) {
    const round=s.activeRound;
    if(!round.presetOpening)return false;
    if(round.presetPrepared){
      const failed=new Set(s.messages.filter(m=>m.origin==='preset-opening'&&m.round===round.number).flatMap(m=>m.tool_calls||[]).filter(c=>round.receipts[c.id]?.ok===false).map(c=>c.id));
      for(const id of failed)delete round.receipts[id];
      s.messages=s.messages.filter(m=>m.role!=='tool'||!failed.has(m.tool_call_id));
      return failed.size>0;
    }
    round.presetPrepared=true;
    const call=(name,args)=>({id:uid(),type:'function',function:{name,arguments:JSON.stringify(args)}});
    s.messages.push({role:'assistant',content:'',round:round.number,origin:'preset-opening',tool_calls:[
      call('append_story',{content:round.presetOpening,one_line_summary_of_content:'预设开场已发布；待完成角色审核与开局准备。'}),
      call('end_the_round',{NEXT_TURN_CACHE:{Story_Phase:'游戏前准备',opening_preparation_pending:true}})
    ]});
    return true;
  }
  async function run(s,transport,opts={}) {
    if(!s.activeRound)throw Error('尚未开始回合');
    const abort=()=>{if(opts.signal?.aborted)throw Object.assign(Error('已中止本回合'),{name:'AbortError'});};
    const step=async()=>{if(opts.onStep)await opts.onStep(s);};
    s.status='running';s.error=null;
    const warnedArguments=new Set(s.events.filter(e=>e.code==='INVALID_TOOL_ARGUMENTS').flatMap(e=>e.callIds||[]));
    const warnArguments=()=>{
      const ids=s.messages.flatMap(m=>m.role==='assistant'?(m.tool_calls||[]).filter(toolArguments.invalid).map(c=>c.id):[]).filter(id=>!warnedArguments.has(id));
      if(!ids.length)return;
      ids.forEach(id=>warnedArguments.add(id));
      const previous=s.events.find(e=>e.round===s.activeRound.number&&e.code==='INVALID_TOOL_ARGUMENTS');
      if(previous){
        previous.callIds.push(...ids);
        if(previous.callIds.length>=3&&!s.events.some(e=>e.round===s.activeRound.number&&e.code==='INVALID_TOOL_ARGUMENTS'&&e.repeated))
          emit(s,'warning',{code:'INVALID_TOOL_ARGUMENTS',callIds:[],repeated:true,content:toolArguments.REPEATED_NOTICE});
      }else emit(s,'warning',{code:'INVALID_TOOL_ARGUMENTS',callIds:ids,repeated:ids.length>=3,content:toolArguments.warningNotice(ids.length)});
    };
    if(toolArguments.hasInvalid(s.messages))warnArguments();
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
          a=toolArguments.parse(tc.function?.arguments);
          if(tc.function.name==='roll_dice'&&opts.manualDice===true&&dicePlayerRelated(s,a)&&!diceSecret(a)){
            const identity=diceIdentity(s,a),request=diceRequest(a);
            if(request.specs.some(spec=>spec.n)){
              const e=emit(s,'dice',{roller:a.roller,description:a.description||'',relatedAttr:a.related_attr||'',...identity,
                diceArgs:copy(a),manual:true,pending:true,callId:tc.id});
              s.pendingManualDice={callId:tc.id,eventId:e.id,round:s.activeRound.number,args:copy(a),createdAt:Date.now()};
              s.status='interrupted';s.error=null;await step();return true;
            }
          }
          out=execute(s,tc.function.name,a,tc.id,opts);
        }
        catch(e){
          const rawError=e.message||String(e),name=tc.function?.name,suggestion=toolFailureSuggestion(name,a,rawError);
          const invalid=e.code==='INVALID_TOOL_ARGUMENTS';
          out={ok:false,error:(invalid?'工具参数解析失败：':'工具执行失败：')+rawError+(invalid?'。'+toolArguments.HINT+'本次调用未执行，请重新生成合法参数。':''),raw_error:rawError,...(suggestion?{suggestion}:{})};
          if(invalid)warnArguments();
          emit(s,'tool',{name,args:a??tc.function?.arguments,result:{error:out.error,raw_error:rawError,...(suggestion?{suggestion}:{})},success:false,callId:tc.id});
        }
        if(out.ok&&tc.function.name==='append_story')storyInBatch=true;
        s.messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(out),round:s.activeRound.number});await step();
        if(message.origin==='preset-opening'&&!out.ok)throw Error('预设开场执行失败：'+out.error);
      }
      if(storyInBatch&&!s.activeRound.complete&&opts.afterStory){s.messages.push({role:'user',content:opts.afterStory,round:s.activeRound.number});await step();}
      return false;
    }
    try{
      abort();if(preparePresetOpening(s)||(opts.openingPreload!==false&&prepareOpeningReads(s)))await step();
      const pending=s.messages.filter(m=>m.role==='assistant'&&m.tool_calls&&m.round===s.activeRound.number);
      for(const m of pending)if(await completeBatch(m))return;
      if(s.activeRound.complete){s.status=s.cache.game_over===true?'ended':'waiting';await step();return;}
      if(s.activeRound.presetOpening)throw Error('预设第一回合未能完成，请检查工具回执并修复世界文件后继续或回退');
      if(opts.resumePrompt&&!(s.messages.at(-1)?.role==='user'&&s.messages.at(-1).content===opts.resumePrompt)){s.messages.push({role:'user',content:opts.resumePrompt,round:s.activeRound.number});await step();}
      let requestCap=opts.cap??240000,recoveries=0;
      for(let loop=0;loop<(opts.maxToolLoops||60);loop++){
        let resp;
        for(;;){
          abort();const messages=context(s,opts.system||'',requestCap,opts);await step();
          try{resp=await transport(messages);break;}
          catch(e){
            if(e.code!=='CONTEXT_LIMIT'||e.contextSource!=='provider'||recoveries>=2)throw e;
            recoveries++;requestCap=Math.min(requestCap,Math.floor(estimate(messages)*.8));
          }
        }
        abort();
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
    }catch(e){s.status=s.activeRound.complete?(s.cache.game_over?'ended':'waiting'):'interrupted';s.error=e.message;
      const last=s.events.at(-1);if(last?.type!=='error'||last.round!==s.activeRound.number||last.content!==e.message)emit(s,'error',{content:e.message,...(e.code?{code:e.code}:{})});
      await step();throw e;}
  }
  return {uid,path,openingFiles,localOpening,createSave,validateTree,beginRound,execute,run,context,rebuildContext,contextRebuildInfo,estimate,player,filterVisible,visibleEvents,rollback,pruneRollback,ROLLBACK_LIMIT,changes,flatten,dice,dicePlayerRelated,diceSecret,diceEventAccess,resolveManualDice,repairManualDiceEvents};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameCore;
