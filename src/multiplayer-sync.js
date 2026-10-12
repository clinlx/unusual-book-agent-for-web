'use strict';
const MultiplayerSync=(()=>{
  const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const pick=(x,keys)=>Object.fromEntries(keys.filter(k=>x?.[k]!==undefined).map(k=>[k,clone(x[k])]));
  function canonical(x){
    if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
    if(object(x))return '{'+Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
    return JSON.stringify(x);
  }
  async function hash(x){const bytes=new TextEncoder().encode(canonical(x)),digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');}
  const members=room=>Array.isArray(room?.members)?room.members.map(m=>[m.memberId||m.id,m]):Object.entries(room?.members||{});
  function profile(save,actorId,{room=save.multiplayer,memberId='host'}={}){
    const people=members(room),viewer=people.find(([id])=>id===memberId)?.[1],slot=save.slots?.find(s=>s.id===actorId);
    if(!viewer?.actorId||!slot||!people.some(([,m])=>m.actorId===actorId))throw Object.assign(Error('角色资料不可访问'),{code:'PROFILE_UNAVAILABLE'});
    const Data=typeof module!=='undefined'&&module.exports?require('./game-data'):GameData,Core=typeof module!=='undefined'&&module.exports?require('./game-core'):GameCore;
    const raw=Data.read(save,slot.path+'/基础信息.json');
    if(Data.hiddenFlag(raw['.是否对玩家隐藏']))return {actorId,name:'角色',info:{}};
    const card=Core.player({...save,playerPath:slot.path},'info');return {actorId,name:card.name,info:clone(card.info)};
  }
  function inventory(save,actorId,options={}){
    const publicProfile=profile(save,actorId,options),slot=save.slots.find(s=>s.id===actorId);
    const Data=typeof module!=='undefined'&&module.exports?require('./game-data'):GameData,Core=typeof module!=='undefined'&&module.exports?require('./game-core'):GameCore;
    if(Data.hiddenFlag(Data.read(save,slot.path+'/基础信息.json')['.是否对玩家隐藏']))return {actorId,name:publicProfile.name,items:[]};
    const visibilityKeys=new Set(['可见性','visibility','visible','是否可见']);
    const items=Core.player({...save,playerPath:slot.path},'items').items.filter(item=>object(item)&&!Object.entries(item).some(([k,v])=>{
      if(!visibilityKeys.has(Data.normalize(k)))return false;
      return v===false||v===0||/^(false|否|no|0)$/i.test(String(v).trim())||/不可见|隐藏|hide|hidden|invisible/i.test(String(v));
    }));
    return {actorId,name:publicProfile.name,items:clone(items)};
  }
  const itemIdentities=new WeakMap();
  function itemKeys(save,slot,Data,keyMap){
    if(!keyMap&&!itemIdentities.has(save))itemIdentities.set(save,new Map());
    const identities=keyMap||itemIdentities.get(save),bag=Data.read(save,slot.path+'/背包.json');
    const list=Array.isArray(bag)?bag:(bag.物品||bag.Items||bag.items||bag.背包||Object.values(bag));
    const occurrences=new Map(),keys=[];
    for(const [index,item]of (Array.isArray(list)?list:Object.values(list||{})).entries()){
      if(object(item)&&Data.hiddenFlag(item['.是否对玩家隐藏']))continue;
      if(typeof item==='string'){try{if(Data.hiddenFlag(Data.read(save,Data.itemPath(item))['.是否对玩家隐藏']))continue;}catch(_){}}
      const identity=typeof item==='string'?Data.itemPath(item):slot.id+':inline:'+String(item?.id||item?.ID||index);
      const occurrence=occurrences.get(identity)||0;occurrences.set(identity,occurrence+1);
      const key=identity+':'+occurrence;if(!identities.has(key))identities.set(key,'item-'+globalThis.crypto.randomUUID());keys.push(identities.get(key));
    }
    return keys;
  }
  function allowed(event,actorId){
    const audience=event.audience;
    if(event.private===true&&!Array.isArray(audience))return false;
    if(audience===undefined)return !event.secret||event.type==='dice';
    if(audience==='public')return true;
    return Array.isArray(audience)&&audience.includes(actorId);
  }
  const diceFields=['mode','left','right','compare_mode','raw','total','target','success','criticalHints','critical','special'];
  function eventView(e,actorId,index,save,Core){
    if(!['player','story','round_end','note','dice'].includes(e.type))return null;
    const access=e.type==='dice'?Core.diceEventAccess(save,e,actorId):null;
    if(access?!access.visible:!allowed(e,actorId))return null;
    if(e.type==='player'&&e.actorId!==actorId&&!String(e.content||'').trim()&&String(e.privateContent||'').trim()&&!e.skip)return null;
    if(e.secret&&e.type!=='dice'&&!Array.isArray(e.audience))return null;
    const out={id:'event-'+index,...pick(e,['type','round','at','worldTime','actorId','name','skip'])};
    if(e.type==='dice'){
      Object.assign(out,pick(e,['roller','description','relatedAttr','manual','pending']),pick(access,['rollerId','rollerKind','private','targetPlayer','playerRelated','secret']));
      if(out.secret){delete out.description;delete out.relatedAttr;}
      if(!out.secret){
        if(typeof e.content==='string')out.content=e.content;
        if(e.data){out.data=pick(e.data,diceFields);out.data.rows=(e.data.rows||[]).map(r=>pick(r,[...diceFields,'label','formula','rolls','forced']));}
        if(e.diceArgs)out.diceArgs=pick(e.diceArgs,['description','roller','related_attr','is_secret','dice_dict','calculate_only','target_value','compare_mode','critical_success_range','critical_failure_range','dice_combine_mode','left_modifiers','right_modifiers']);
      }
    }else{
      if(e.private===true||Array.isArray(e.audience)||e.actorId===actorId&&String(e.privateContent||'').trim())out.private=true;
      if(typeof e.content==='string')out.content=e.content;
      if(e.actorId===actorId&&typeof e.privateContent==='string'){out.privateContent=e.privateContent;if(e.disguise===true)out.disguise=true;}
    }
    return out;
  }
  function collection(room,slots){
    const people=members(room),eligible=(slots||[]).filter(s=>!['ai','disabled','kpc'].includes(s.kind)&&s.alive!==false&&s.enabled!==false&&(s.occupied||people.some(([,m])=>m.actorId===s.id||m.invitationActorId===s.id)));
    const submitted=eligible.filter(s=>s.submitted??!!room?.submissions?.[s.id]).length;
    return {total:eligible.length,submitted,remaining:eligible.length-submitted};
  }
  function pendingActions(save,actorId,{room=save.multiplayer}={}){
    if(room?.status!=='collecting')return [];
    const actions=[];
    for(const [id,e]of Object.entries(room.submissions||{})){
      const content=String(e.content||'');
      if(id!==actorId&&!content.trim()&&String(e.privateContent||'').trim()&&!e.skip)continue;
      const slot=save.slots?.find(s=>s.id===id);if(!slot)continue;
      const action={id:'pending-'+id,type:'player',actorId:id,round:room.round||save.round+1,content,skip:!!e.skip,pending:true};
      if(id===actorId&&String(e.privateContent||'').trim()){action.private=true;action.privateContent=String(e.privateContent);if(e.disguise===true)action.disguise=true;}
      actions.push(action);
    }
    return actions;
  }
  function project(save,actorId,{memberId,room,keyMap,allowUnassigned=false}={}){
    // Only the host calls this entry point; the reducer below has no world dependencies.
    const Core=typeof module!=='undefined'&&module.exports?require('./game-core.js'):GameCore;
    const Data=typeof module!=='undefined'&&module.exports?require('./game-data.js'):GameData;
    const slots=Array.isArray(save.slots)?save.slots:[];
    const slot=slots.find(s=>s.id===actorId);
    if(!slot&&!(allowUnassigned&&actorId===null))throw Object.assign(Error('角色授权已失效'),{code:'SCOPE_INVALID'});
    const own=slot?Core.player({...save,playerPath:slot.path}):{info:{},items:[],name:''},people=members(room);
    const publicSlots=slots.map(s=>{
      const card=Core.player({...save,playerPath:s.path},'info');
      const binding=people.find(([,m])=>m.actorId===s.id);
      return {id:s.id,name:String(card.name||''),kind:s.kind,occupied:!!binding,connected:binding?.[1].connected===true||binding?.[1].online===true,...Data.actorState(card.info),submitted:!!room?.submissions?.[s.id]};
    });
    const roundStates=new Map();
    for(const dir of Object.values(Data.node(save,'过往回合历史记忆')?.children||{})){
      const match=dir.type==='dir'&&String(dir.name).match(/^Round_(\d+)_Time_/),file=dir.children?.['玩家结束状态.json'];
      if(!match||file?.type!=='file'||file.encoding==='base64')continue;
      try{
        const archived=JSON.parse(String(file.content).replace(/^\uFEFF/,''));
        const ownState=object(archived.actors)&&Object.hasOwn(archived.actors,actorId)?archived.actors[actorId]:archived.actorId===actorId?archived:!archived.actorId&&!archived.actors&&slots.length===1?archived:null;
        if(object(ownState))roundStates.set(Number(match[1]),{info:Data.visible(ownState.info||{}),items:Data.visible(ownState.items||[],true)});
      }catch(_){}
    }
    const events=[];for(const e of slot?save.events||[]:[]){const visible=eventView(e,actorId,events.length+1,save,Core);if(visible){if(e.type==='round_end'&&roundStates.has(e.round))visible.roundState=roundStates.get(e.round);events.push(visible);}}
    const ownMember=people.find(([id])=>id===memberId)?.[1];
    const roomView=room?{...pick(room,['roomId','epoch','roundId','round','status','online','autoAdvanceUnconscious']),memberId,actorId,bindingVersion:ownMember?.bindingVersion||0,submitted:!!room.submissions?.[actorId],members:people.map(([id,m])=>({memberId:id,actorId:m.actorId,connected:m.connected===true||m.online===true})),vote:room.vote?{...pick(room.vote,['id','requester','targetRound','targetRoundId','status','expiresAt']),eligible:(room.vote.eligible||[]).includes(memberId),voted:Object.hasOwn(room.vote.votes||{},memberId),yes:Object.values(room.vote.votes||{}).filter(Boolean).length,required:Math.ceil((room.vote.eligible||[]).length/2)}:null}:null;
    if(roomView)roomView.slotRequests=(room.slotRequests||[]).map(request=>pick(request,['id','memberId','actorId','at']));
    if(roomView)roomView.collection=collection(room,publicSlots);
    return {id:save.id,name:save.name,actorId,round:save.round||0,status:save.status,events,pendingActions:slot?pendingActions(save,actorId,{room}):[],rollbackCount:Math.min(10,save.snapshots?.length||0),rollbackTargetRound:save.snapshots?.at(-1)?.round??null,info:own.info,items:own.items,itemKeys:slot?itemKeys(save,slot,Data,keyMap):[],playerName:own.name,slots:publicSlots,room:roomView};
  }
  function meta(view){return pick(view,['id','name','actorId','round','status','playerName','slots','room','pendingActions','rollbackCount','rollbackTargetRound']);}
  async function hashes(view){const [history,info,items,state]=await Promise.all([hash(view.events),hash(view.info),hash({items:view.items,itemKeys:view.itemKeys}),hash(meta(view))]);return {history,info,items,state};}
  const same=(a,b)=>canonical(a)===canonical(b);
  function createHost({getSave,getRoom,pageSize=200}){
    const revisions=new Map(),snapshots=new Map(),identityScopes=new Map();let queue=Promise.resolve();
    pageSize=Math.max(1,Math.min(1000,Number.isSafeInteger(pageSize)?pageSize:200));
    function page(snapshot,offset){
      const packet=clone(snapshot.packet),events=packet.view.events;
      packet.type='snapshot_page';packet.snapshotId=snapshot.id;packet.offset=offset;packet.nextOffset=Math.min(events.length,offset+pageSize);
      packet.done=packet.nextOffset===events.length;packet.view.events=events.slice(offset,packet.nextOffset);packet.newVisibleEventIds=packet.view.events.map(e=>e.id);
      return packet;
    }
    async function build(memberId,request){
      const save=getSave(),room=getRoom(),member=members(room).find(([id])=>id===memberId)?.[1];
      if(!member)throw Object.assign(Error('当前成员没有房间授权'),{code:'SCOPE_INVALID'});
      const scope={gameId:save.id,roomId:room.roomId||room.id,memberId,actorId:member.actorId||null,bindingVersion:member.bindingVersion||0,epoch:room.epoch||0};
      const continuing=snapshots.get(memberId);
      if(request.snapshotId&&continuing?.id===request.snapshotId&&same(continuing.packet.scope,scope)&&Number.isSafeInteger(request.offset)&&request.offset>=0&&request.offset<continuing.packet.cursor)return page(continuing,request.offset);
      const identityScope=canonical({gameId:scope.gameId,roomId:scope.roomId,memberId,actorId:scope.actorId,bindingVersion:scope.bindingVersion});
      if(!identityScopes.has(identityScope))identityScopes.set(identityScope,new Map());
      const view=project(save,scope.actorId,{memberId,room,keyMap:identityScopes.get(identityScope),allowUnassigned:true});
      const currentHashes=await hashes(view),key=canonical(scope),last=revisions.get(key),signature=canonical(currentHashes);
      if(request.onlyIfChanged===true&&same(request.scope,scope)&&request.cursor===view.events.length&&same(request.hashes,currentHashes)&&request.revision===last?.revision)return null;
      const acknowledged=same(request.scope,scope)&&Number.isSafeInteger(request.revision)&&request.revision>=0&&request.revision<Number.MAX_SAFE_INTEGER?request.revision:0;
      const revision=last?Math.max(last.signature===signature?last.revision:last.revision+1,acknowledged+(same(request.hashes,currentHashes)?0:1)):Math.max(1,acknowledged+(same(request.hashes,currentHashes)?0:1));revisions.set(key,{signature,revision});
      const cursor=view.events.length,baseCursor=request.cursor;
      const baseline=same(request.scope,scope)&&Number.isSafeInteger(baseCursor)&&baseCursor>=0&&baseCursor<=cursor&&request.hashes?.history===await hash(view.events.slice(0,baseCursor));
      const packet={protocol:1,type:baseline?'incremental':'snapshot',scope,viewScope:await hash(scope),revision,cursor,hashes:currentHashes,round:save.round||0,roundId:room.roundId||null,infoChanged:request.hashes?.info!==currentHashes.info,itemsChanged:request.hashes?.items!==currentHashes.items};
      if(request.scope&&request.scope.epoch<scope.epoch)packet.rollbackTo=view.round;
      if(!baseline)packet.view=view;
      else{
        packet.baseCursor=baseCursor;packet.baseHistoryHash=request.hashes.history;packet.events=view.events.slice(baseCursor);packet.meta=meta(view);
        if(packet.infoChanged)packet.info=view.info;if(packet.itemsChanged){packet.items=view.items;packet.itemKeys=view.itemKeys;}
      }
      packet.newVisibleEventIds=(baseline?packet.events:view.events).map(e=>e.id);
      if(!baseline&&cursor>pageSize){const snapshot={id:await hash({scope,revision,currentHashes}),packet:clone(packet)};snapshots.set(memberId,snapshot);return page(snapshot,0);}
      snapshots.delete(memberId);
      return clone(packet);
    }
    return {sync(memberId,request={}){const result=queue.then(()=>build(memberId,clone(request)));queue=result.catch(()=>{});return result;}};
  }
  function differences(before,after,path=''){
    if(same(before,after))return [];
    if(object(before)&&object(after))return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(k=>differences(before[k],after[k],path?path+'.'+k:k));
    return [{path,type:before===undefined?'add':after===undefined?'delete':'modify',before:clone(before),after:clone(after)}];
  }
  function itemDifferences(before,after){
    const a=Object.fromEntries(before.itemKeys.map((key,i)=>[key,before.items[i]])),b=Object.fromEntries(after.itemKeys.map((key,i)=>[key,after.items[i]]));
    return differences(a,b);
  }
  function createClient(){
    let state=null,pending=null,queue=Promise.resolve();const retiredScopes=new Set();
    async function apply(packet){
      if(packet?.protocol!==1||!['snapshot','snapshot_page','incremental'].includes(packet.type)||!object(packet.scope)||!Number.isSafeInteger(packet.revision)||!Number.isSafeInteger(packet.cursor))return false;
      const scopeKey=canonical(packet.scope);
      if(retiredScopes.has(scopeKey)||await hash(packet.scope)!==packet.viewScope)return false;
      const old=state,scopeChanged=old&&!same(old.scope,packet.scope);
      if(old){
        if(old.scope.roomId===packet.scope.roomId&&(packet.scope.epoch<old.scope.epoch||packet.scope.bindingVersion<old.scope.bindingVersion))return false;
        if(!scopeChanged&&packet.revision<=old.revision)return false;
        if(scopeChanged&&packet.type!=='snapshot'&&packet.type!=='snapshot_page')return false;
      }
      if(pending&&pending.packet.scope.roomId===packet.scope.roomId&&(packet.scope.epoch<pending.packet.scope.epoch||packet.scope.bindingVersion<pending.packet.scope.bindingVersion))return false;
      if(pending&&same(pending.packet.scope,packet.scope)&&packet.revision<pending.packet.revision)return false;
      if(packet.type==='snapshot_page'){
        if(!packet.view||!Array.isArray(packet.view.events)||!Number.isSafeInteger(packet.offset)||packet.offset<0||packet.nextOffset!==packet.offset+packet.view.events.length||packet.nextOffset>packet.cursor)return false;
        if(packet.offset===0){
          if(pending?.packet.snapshotId===packet.snapshotId)return false;
          pending={packet:clone(packet),events:[]};
        }
        if(!pending||pending.packet.snapshotId!==packet.snapshotId||pending.events.length!==packet.offset||!same(pending.packet.scope,packet.scope)||!same(pending.packet.hashes,packet.hashes))return false;
        pending.events.push(...clone(packet.view.events));
        if(!packet.done)return false;
        if(packet.nextOffset!==packet.cursor){pending=null;return false;}
        packet={...pending.packet,type:'snapshot',view:{...pending.packet.view,events:pending.events}};pending=null;
      }
      let view;
      if(packet.type==='snapshot')view=clone(packet.view);
      else{
        if(!old||packet.baseCursor!==old.cursor||packet.baseHistoryHash!==old.hashes.history||!Array.isArray(packet.events))return false;
        view={...clone(old.view),...clone(packet.meta),events:old.view.events.concat(clone(packet.events))};
        if(packet.info!==undefined)view.info=clone(packet.info);if(packet.items!==undefined){view.items=clone(packet.items);view.itemKeys=clone(packet.itemKeys);}
      }
      if(!view||!Array.isArray(view.events)||view.events.length!==packet.cursor||view.actorId!==packet.scope.actorId||view.id!==packet.scope.gameId)return false;
      if(view.events.some((e,i)=>e.id!=='event-'+(i+1)))return false;
      if(!Array.isArray(view.items)||!Array.isArray(view.itemKeys)||view.items.length!==view.itemKeys.length||new Set(view.itemKeys).size!==view.itemKeys.length)return false;
      if(!same(await hashes(view),packet.hashes))return false;
      const reset=!old||scopeChanged||packet.rollbackTo!==undefined;
      const changes=reset?{info:[],items:[]}:{info:differences(old.view.info,view.info),items:itemDifferences(old.view,view)};
      if(scopeChanged)retiredScopes.add(canonical(old.scope));
      state={scope:clone(packet.scope),viewScope:packet.viewScope,revision:packet.revision,cursor:packet.cursor,hashes:clone(packet.hashes),view,changes,...(packet.rollbackTo!==undefined?{rollbackTo:packet.rollbackTo}:{})};
      pending=null;
      return true;
    }
    return {apply(packet){const result=queue.then(()=>apply(clone(packet))).catch(()=>false);queue=result.then(()=>{});return result;},getState:()=>clone(state),request:()=>({...state?pick(state,['scope','cursor','hashes','revision']):{},...pending?{snapshotId:pending.packet.snapshotId,offset:pending.events.length}:{}})};
  }
  function createMemoryTransport({autoFlush=true}={}){
    const host=new Set(),clients=new Map(),pending=[];
    async function flush(index=0){const entry=pending.splice(index,1)[0];if(!entry)return false;const handlers=entry.memberId===null?host:clients.get(entry.memberId)||[];for(const fn of handlers)await fn(...clone(entry.args));return true;}
    function enqueue(memberId,args){pending.push({memberId,args:clone(args)});if(autoFlush)return flush(pending.length-1);return Promise.resolve();}
    return {onHost(fn){host.add(fn);return ()=>host.delete(fn);},onClient(memberId,fn){if(!clients.has(memberId))clients.set(memberId,new Set());clients.get(memberId).add(fn);return ()=>clients.get(memberId)?.delete(fn);},sendToHost:(memberId,message)=>enqueue(null,[memberId,message]),sendToClient:(memberId,message)=>enqueue(memberId,[message]),flush,drop(index=0){return !!pending.splice(index,1).length;},pending:()=>clone(pending)};
  }
  return {project,profile,inventory,collection,pendingActions,hash,canonical,createHost,createClient,createMemoryTransport};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=MultiplayerSync;
