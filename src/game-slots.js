'use strict';
const GameSlots=(()=>{
  const prefixes={player:'Player',ai:'AIPC',disabled:'DISABLE',kpc:'KPC'};
  const clone=value=>JSON.parse(JSON.stringify(value));
  const LOCK_MESSAGE='已锁定，关闭的角色槽位需要在第二回合开始前进行配置开启。';
  const HUMAN_PLAYER_MESSAGE='游戏必须至少有一名真人玩家。房主观战时，请至少将一个角色槽位开放给玩家，并等待客户端加入后开始游戏。';
  function assertHumanPlayer(save,{actorId=save.actorId,modes=controlModes(save)}={}){
    if(!ensure(save).some(slot=>slot.id===actorId||modes[slot.id]==='player'))throw Error(HUMAN_PLAYER_MESSAGE);
  }
  const INTERNAL_HEADER='[角色控制·内部指令]';
  const started=save=>(save.round||0)>1||(save.activeRound?.number||0)>1;
  const canConfigureNPCCards=save=>save?.status==='new'&&!(save.round>0)&&!save.activeRound;
  const npcRequirementKey=slot=>(slot.kind==='kpc'?'kpc:':'slot:')+slot.id;
  function npcRequirements(save){
    const value=save.npcCardInstructions;
    if(value&&typeof value==='object'&&!Array.isArray(value))return value;
    const npcs=scan(save.tree).filter(slot=>['ai','kpc'].includes(slot.kind));
    return typeof value==='string'&&value.trim()&&npcs.length===1?{[npcRequirementKey(npcs[0])]:value.trim()}:{};
  }
  function controlModes(save,openPlayerSlots=[]){
    const open=new Set(openPlayerSlots);
    return Object.fromEntries(ensure(save).map(slot=>[slot.id,open.has(slot.id)?'player':slot.kind]));
  }
  function initializeControlState(save,openPlayerSlots=[]){
    if(!started(save)||save.slotControlState)return;
    const modes=controlModes(save,openPlayerSlots);
    for(const m of Object.values(save.multiplayer?.members||{}))if(m.actorId||m.invitationActorId)modes[m.actorId||m.invitationActorId]='player';
    for(const m of save.multiplayer?.suspendedRoom?.bindings||[])modes[m.actorId]='player';
    save.slotControlState={initialModes:{...modes},lastModes:{...modes}};
  }
  function locked(save,id,{openPlayerSlots=[]}={}){
    if(!started(save))return false;
    if(save.slotControlState&&Object.hasOwn(save.slotControlState.initialModes,id))return save.slotControlState.initialModes[id]==='disabled';
    return controlModes(save,openPlayerSlots)[id]==='disabled';
  }
  function assertConfigure(save,id,kind,options){
    if(locked(save,id,options)||started(save)&&kind==='disabled')throw Error(LOCK_MESSAGE);
  }
  function roundInstruction(save,isStart,{openPlayerSlots=[],slotPrompts}={}){
    const templates=slotPrompts||(typeof module!=='undefined'&&module.exports?require('../assets/prompts/flow/slot_control.json'):Prompts.slotControl());
    const text=(key,values={})=>String(templates[key]||'').replace(/\{([a-z_]+)\}/g,(match,name)=>Object.hasOwn(values,name)?String(values[name]):match);
    const modes=controlModes(save,isStart?openPlayerSlots:[]),previous=save.slotControlState?.lastModes;
    const list=kind=>Object.entries(modes).filter(([,v])=>v===kind).map(([id])=>JSON.stringify(prefixes[kind]+'-'+id)).join('、')||'无';
    const kpcSlots=scan(save.tree).filter(slot=>slot.kind==='kpc'),kpcs=kpcSlots.map(slot=>JSON.stringify('KPC-'+slot.id));
    let lines=[];
    if(isStart&&!previous&&Object.keys(modes).length+kpcs.length>1){
      const requirements=npcRequirements(save),npcSlots=[...ensure(save).filter(slot=>modes[slot.id]==='ai'),...kpcSlots];
      lines=[text('opening_roster',{player_count:Object.values(modes).filter(v=>v==='player').length,player_slots:list('player'),ai_slots:list('ai'),kpc_slots:kpcs.join('、')||'无'}),text('npc_creation'),
        ...npcSlots.flatMap(slot=>{const requirement=requirements[npcRequirementKey(slot)];return typeof requirement==='string'&&requirement.trim()?[text('npc_requirement',{actor:JSON.stringify((slot.kind==='kpc'?'KPC':'AIPC')+'-'+slot.id),requirements:JSON.stringify(requirement.trim())})]:[];})];
    }else if(!isStart&&previous){
      for(const [id,mode]of Object.entries(modes))if(previous[id]!==mode){
        const key=previous[id]==='disabled'&&['player','ai'].includes(mode)?'activate_'+mode:
          mode==='disabled'&&['player','ai'].includes(previous[id])?'disable':
          ['player','ai'].includes(mode)&&['player','ai'].includes(previous[id])?(mode==='ai'?'to_ai':'to_player'):null;
        if(key)lines.push(text(key,{actor:JSON.stringify(prefixes[mode]+'-'+id)}));
      }
    }
    for(const [id,entry]of Object.entries(save.characterImports||{}))if(modes[id]==='player'&&entry.notifiedRevision!==entry.revision){
      lines.push(text('imported_character',{actor:JSON.stringify('Player-'+id)}));entry.notifiedRevision=entry.revision;
    }
    const openingConfiguration=!started(save)||save.activeRound?.number===2&&(save.round||0)<2;
    save.slotControlState={initialModes:openingConfiguration?controlModes(save,openPlayerSlots):save.slotControlState?.initialModes||{...modes},lastModes:{...modes}};
    return lines.length?[INTERNAL_HEADER,...lines,text('privacy')].join('\n'):'';
  }
  const playerContext=messages=>messages.filter(m=>![INTERNAL_HEADER,'[开局内部说明]','[预设开局·内部流程]'].some(header=>m.content?.startsWith(header)));
  function scan(tree){
    const root=tree?.children?.workspace,seen=new Set(),slots=[];
    for(const [name,node] of Object.entries(root?.children||{})){
      const match=/^(Player|AIPC|DISABLE|KPC)-(.*)$/.exec(name);if(!match)continue;
      const id=match[2],kind=Object.keys(prefixes).find(k=>prefixes[k]===match[1]);
      if(!id.trim()||id!==id.trim()||/[\\/:<>"|?*]/.test(id))throw new Error('角色 ID 必须非空且合法：'+name);
      if(node.type!=='dir')throw new Error('角色槽位必须为目录：'+name);
      if(kind!=='kpc'){if(seen.has(id))throw new Error('角色 ID 冲突：'+id);seen.add(id);}
      slots.push({id,path:'/workspace/'+name,kind});
    }
    return slots;
  }
  function ensure(save){
    const old=new Map((save.slots||[]).map(s=>[s.id,s]));
    save.slots=scan(save.tree).filter(s=>s.kind!=='kpc').map(s=>({...old.get(s.id),...s}));
    return save.slots;
  }
  function assertIdle(save){
    if(['running','executing','rolling_back'].includes(save.status)||save.activeRound&&!save.activeRound.complete||save.room?.vote||save.multiplayer?.vote)throw new Error('执行或投票期间不能修改角色槽位');
  }
  function rewrite(tree,from,to){
    const oldName=from.slice('/workspace/'.length),newName=to.slice('/workspace/'.length);
    const ownerKey=k=>['位置所属','location','owner','引用','路径','path','reference','ref'].includes(k.toLowerCase());
    const pathValue=value=>{
      const clean=value.replace(/\\/g,'/');
      for(const [a,b] of [[from,to],[oldName,newName],['workspace/'+oldName,'workspace/'+newName]])if(clean===a||clean.startsWith(a+'/'))return b+clean.slice(a.length);
      return value;
    };
    const walkJSON=(value,key='')=>{
      if(typeof value==='string'){const clean=value.replace(/\\/g,'/');return ownerKey(key)||clean.startsWith(from)||clean.startsWith(oldName+'/')||clean.startsWith('workspace/'+oldName+'/')?pathValue(value):value;}
      if(Array.isArray(value))return value.map(v=>walkJSON(v,key));
      if(value&&typeof value==='object'){
        const entries=Object.entries(value).map(([k,v])=>[k.startsWith(from)||k.startsWith(oldName+'/')?pathValue(k):k,walkJSON(v,k)]);
        if(new Set(entries.map(([k])=>k)).size!==entries.length)throw new Error('角色路径引用键冲突');
        return Object.fromEntries(entries);
      }
      return value;
    };
    const escaped=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(escaped+'(?=/|[\\s`"\'<>，。；：、)\\]]|$)','g');
    function walk(node){
      if(node.type==='dir'){Object.values(node.children||{}).forEach(walk);return;}
      if(node.encoding==='base64')return;
      if(/\.json$/i.test(node.name)){let parsed;try{parsed=JSON.parse(node.content.replace(/^\uFEFF/,''));}catch{throw new Error('槽位转换遇到无效 JSON：'+node.name);}const next=walkJSON(parsed);if(JSON.stringify(next)!==JSON.stringify(parsed))node.content=JSON.stringify(next,null,2);}
      else node.content=node.content.replace(pattern,to);
    }
    walk(tree.children.workspace);
  }
  function change(save,id,kind){
    if(!['player','ai','disabled'].includes(kind))throw new Error('无效槽位模式');
    const slot=ensure(save).find(s=>s.id===id);if(!slot)throw new Error('找不到可选槽位：'+id);
    if(slot.kind===kind)return slot;
    if(slot.memberId&&kind!=='player')throw new Error('真人占用的槽位不能关闭或转为 AIPC');
    const root=save.tree.children.workspace,name=prefixes[kind]+'-'+id,path='/workspace/'+name;
    if(root.children[name])throw new Error('角色 ID 目标冲突：'+id);
    const old=slot.path,oldName=old.slice('/workspace/'.length),node=root.children[oldName];
    rewrite(save.tree,old,path);delete root.children[oldName];node.name=name;root.children[name]=node;
    if(save.playerPath===old)save.playerPath=path;
    if(save.cache){const temp={children:{workspace:{type:'dir',children:{'cache.json':{type:'file',name:'cache.json',content:JSON.stringify(save.cache)}}}}};rewrite(temp,old,path);save.cache=JSON.parse(temp.children.workspace.children['cache.json'].content);}
    slot.path=path;slot.kind=kind;slot.bindingVersion=(slot.bindingVersion||0)+1;return slot;
  }
  function commit(save,next){for(const key of ['tree','slots','playerPath','actorId','slotsConfigured','cache'])if(Object.hasOwn(next,key))save[key]=next[key];}
  function setMode(save,id,kind){assertIdle(save);const next=clone(save);change(next,id,kind);commit(save,next);return save.slots.find(s=>s.id===id);}
  function select(save,id,modes={}){
    assertIdle(save);const next=clone(save),slots=ensure(next),selected=slots.find(s=>s.id===id);
    if(!selected)throw new Error('找不到可选槽位：'+id);
    if(selected.memberId&&selected.memberId!==save.memberId&&id!==save.actorId)throw new Error('该槽位已被其他真人占用');
    for(const slot of slots)if(slot.id===id)change(next,id,'player');else if(!slot.memberId)change(next,slot.id,modes[slot.id]==='ai'?'ai':'disabled');
    next.actorId=id;next.playerPath=next.slots.find(s=>s.id===id).path;next.slotsConfigured=true;commit(save,next);return save.slots;
  }
  return {scan,ensure,select,setMode,controlModes,initializeControlState,locked,assertConfigure,assertHumanPlayer,roundInstruction,playerContext,canConfigureNPCCards,npcRequirementKey,npcRequirements,configurationLocked:started,LOCK_MESSAGE,HUMAN_PLAYER_MESSAGE};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameSlots;
