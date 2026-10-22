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
  function spectatorPerspective(save,member){
    const requested=member.permission==='all'?(member.view||'all'):member.permission;
    return ['none','all'].includes(requested)?requested:save.slots?.some(s=>s.id===requested&&s.kind==='player')?requested:'none';
  }
  const Data=typeof module!=='undefined'&&module.exports?require('./game-data'):typeof GameData!=='undefined'?GameData:null;
  const Core=typeof module!=='undefined'&&module.exports?require('./game-core'):typeof GameCore!=='undefined'?GameCore:null;
  const Presentation=typeof module!=='undefined'&&module.exports?require('./game-presentation'):typeof GamePresentation!=='undefined'?GamePresentation:null;
  const visibilityKeys=new Set(['可见性','visibility','visible','是否可见']);
  function visibleItem(item){return object(item)&&!Object.entries(item).some(([k,v])=>visibilityKeys.has(Data.normalize(k))&&(v===false||v===0||/^(false|否|no|0)$/i.test(String(v).trim())||/不可见|隐藏|hide|hidden|invisible/i.test(String(v))));}
  function roleCard(save,slot,omniscient=false,section){
    const raw=Data.read(save,slot.path+'/基础信息.json');
    if(!omniscient&&Data.hiddenFlag(raw['.是否对玩家隐藏']))return {name:'角色',info:{},items:[]};
    const card=Core.player({...save,playerPath:slot.path},section,{includeHidden:omniscient});
    return {...card,items:omniscient?card.items:(card.items||[]).filter(visibleItem)};
  }
  // Summaries use the same visibility rules as click-through details; no full cards go into the roster.
  function summary(save,slot,{omniscient=false}={}){
    const card=roleCard(save,slot,omniscient,'info'),flags=Data.actorState(card.info),vitals=Presentation.vitals(card.info);
    let itemCount=null;try{itemCount=roleCard(save,slot,omniscient,'items').items.length;}catch(_){}
    const state=Data.get(card.info,'状态'),status=typeof state==='string'?state:Object.entries(object(state)?state:{}).filter(([key,value])=>!/^(?:alive|enabled)$/i.test(key)&&value!==false&&value!==0).map(([key,value])=>key+' '+value).join(' ');
    const abnormal=!flags.enabled||vitals.hp?.value===0||/昏迷|失去意识|昏厥|中毒|麻痹|眩晕|疯狂|濒死|unconscious|incapacitated/i.test(status);
    return {name:String(card.name||slot.id),gender:String(Data.get(card.info,'性别')||''),...flags,condition:!flags.alive?'死亡':abnormal?'异常':vitals.hp&&vitals.hp.value<vitals.hp.max?'受伤':'正常',vitals,itemCount};
  }
  function roundChanges(save,slot,{omniscient=false,room}={}){
    const result={info:false,items:false},baseline=save.snapshots?.at(-1);
    if(!['waiting','ended'].includes(save.status)||save.activeRound&&!save.activeRound.complete||['executing','interrupted','rolling_back'].includes(room?.status)||!baseline?.tree||baseline.round!==save.round-1)return result;
    const oldSlot=baseline.slots?.find(s=>s.id===slot.id)||slot,previous={...save,tree:baseline.tree};
    // Compare only what this perspective may inspect, including dereferenced item files.
    for(const section of ['info','items'])try{result[section]=canonical(roleCard(previous,oldSlot,omniscient,section)[section])!==canonical(roleCard(save,slot,omniscient,section)[section]);}catch(_){}
    return result;
  }
  function detailAccess(save,actorId,{room=save.multiplayer,memberId='host'}={}){
    const viewer=members(room).find(([id])=>id===memberId)?.[1],slot=save.slots?.find(s=>s.id===actorId);
    if(!viewer||!(viewer.actorId||viewer.role==='spectator')||!slot||['ai','disabled','kpc'].includes(slot.kind)||viewer.role!=='spectator'&&!members(room).some(([,m])=>m.actorId===actorId))throw Object.assign(Error('角色资料不可访问'),{code:'PROFILE_UNAVAILABLE'});
    return {slot,omniscient:viewer.role==='spectator'&&spectatorPerspective(save,viewer)==='all'};
  }
  function profile(save,actorId,options={}){
    const {slot,omniscient}=detailAccess(save,actorId,options),card=roleCard(save,slot,omniscient,'info');
    return {actorId,name:card.name,info:clone(card.info),baseline:detailBaseline(save,slot,omniscient,'info',card.info),omniscient};
  }
  function inventory(save,actorId,options={}){
    const {slot,omniscient}=detailAccess(save,actorId,options),card=roleCard(save,slot,omniscient);
    return {actorId,name:card.name,items:clone(card.items),baseline:detailBaseline(save,slot,omniscient,'items',card.items),omniscient};
  }
  function detailBaseline(save,slot,omniscient,section,current){
    if(!omniscient&&Data.hiddenFlag(Data.read(save,slot.path+'/基础信息.json')['.是否对玩家隐藏']))return clone(current);
    const snapshot=save.snapshots?.at(-1),round=save.activeRound&&!save.activeRound.complete?save.round:save.round-1;
    if(snapshot?.tree&&snapshot.round===round)try{
      const previous=snapshot.slots?.find(s=>s.id===slot.id)||slot;
      return clone(roleCard({...save,tree:snapshot.tree},previous,omniscient,section)[section]);
    }catch(_){}
    return clone(current);
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
    if(!['player','story','map','round_end','note','dice'].includes(e.type))return null;
    const access=e.type==='dice'?Core.diceEventAccess(save,e,actorId):null;
    if(access?!access.visible:!allowed(e,actorId))return null;
    if(e.type==='player'&&e.actorId!==actorId&&!String(e.content||'').trim()&&String(e.privateContent||'').trim()&&!e.skip)return null;
    if(e.secret&&e.type!=='dice'&&!Array.isArray(e.audience))return null;
    const out={id:'event-'+index,...pick(e,['type','round','at','worldTime','actorId','name','skip'])};
    if(e.type==='map'){const maps=typeof module!=='undefined'&&module.exports?require('./node-map'):NodeMap;out.map=maps.publicSnapshot(e.map);return out;}
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
    const people=members(room),ownMember=people.find(([id])=>id===memberId)?.[1],spectator=ownMember?.role==='spectator',perspective=spectator?spectatorPerspective(save,ownMember):null;
    if(spectator)actorId=['none','all'].includes(perspective)?null:perspective;
    const slot=slots.find(s=>s.id===actorId);
    if(!slot&&!spectator&&!(allowUnassigned&&actorId===null))throw Object.assign(Error('角色授权已失效'),{code:'SCOPE_INVALID'});
    const own=slot?Core.player({...save,playerPath:slot.path}):{info:{},items:[],name:''};
    const publicSlots=slots.map(s=>{
      const card=summary(save,s,{omniscient:perspective==='all'});
      const binding=people.find(([,m])=>m.actorId===s.id);
      return {id:s.id,...card,...spectator?{changes:roundChanges(save,s,{omniscient:perspective==='all',room})}:{},kind:s.kind,occupied:!!binding,connected:binding?.[1].connected===true||binding?.[1].online===true,submitted:!!room?.submissions?.[s.id]};
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
    const events=[];for(const e of slot||spectator?save.events||[]:[]){
      const candidates=perspective==='all'?[e.actorId,...slots.filter(s=>s.kind!=='kpc').map(s=>s.id),null].filter((id,i,a)=>a.indexOf(id)===i):[actorId];
      const visible=candidates.map(id=>eventView(e,id,events.length+1,save,Core)).find(Boolean);
      if(visible){if(e.type==='round_end'&&slot&&roundStates.has(e.round))visible.roundState=roundStates.get(e.round);events.push(visible);}
    }
    const roomView=room?{...pick(room,['roomId','epoch','roundId','round','status','online','autoAdvanceUnconscious']),memberId,actorId,bindingVersion:ownMember?.bindingVersion||0,submitted:!!room.submissions?.[actorId],members:people.map(([id,m])=>({memberId:id,actorId:m.actorId,connected:m.connected===true||m.online===true})),vote:room.vote?{...pick(room.vote,['id','requester','targetRound','targetRoundId','status','expiresAt']),eligible:(room.vote.eligible||[]).includes(memberId),voted:Object.hasOwn(room.vote.votes||{},memberId),yes:Object.values(room.vote.votes||{}).filter(Boolean).length,required:Math.ceil((room.vote.eligible||[]).length/2)}:null}:null;
    if(roomView){roomView.manualDice=room.manualDice===true;roomView.manualDiceMode=room.manualDiceMode||'inherit';roomView.allowPreSubmit=room.allowPreSubmit!==false;roomView.skipManualDice=ownMember?.skipManualDice===true;roomView.slotRequests=(room.slotRequests||[]).map(request=>pick(request,['id','memberId','actorId','at']));}
    if(roomView){roomView.characterPolicy=save.characterPolicy||'review';const q=save.characterReviews?.[ownMember?.actorId];roomView.characterReview=q&&q.memberId===memberId&&q.bindingVersion===ownMember?.bindingVersion?pick(q,['id','hash','actorId','status','reason']):null;}
    if(roomView){const q=room.preparedActions?.[actorId];roomView.preparedAction=!spectator&&q&&q.memberId===memberId&&q.bindingVersion===ownMember?.bindingVersion&&q.epoch===room.epoch?pick(q,['id','version','status','epoch','fromRound','round','roundId','content','privateContent','disguise']):null;}
    if(roomView)roomView.collection=collection(room,publicSlots);
    if(spectator&&roomView){roomView.actorId=null;roomView.submitted=false;roomView.spectator=true;roomView.perspective=perspective;roomView.canChoosePerspective=ownMember.permission==='all';}
    const pending=slot||spectator?pendingActions(save,actorId,{room}):[];
    if(perspective==='all')for(const id of Object.keys(room.submissions||{})){const ownAction=pendingActions(save,id,{room}).find(e=>e.actorId===id);if(ownAction){const i=pending.findIndex(e=>e.actorId===id);if(i>=0)pending[i]=ownAction;else pending.push(ownAction);}}
    const baseline=spectator&&slot?{info:detailBaseline(save,slot,false,'info',own.info),items:detailBaseline(save,slot,false,'items',own.items)}:null;
    // Resolve on the host: deliver only a public node ID for this authorized actor,
    // never the raw location or another player's position. Null clears stale hints.
    let mapFocus=null;const lastMap=events.findLast(e=>e.type==='map');
    if(slot&&lastMap){try{
      const maps=typeof module!=='undefined'&&module.exports?require('./node-map.js'):NodeMap;
      const currentId=maps.matchLocation(lastMap.map,Data.get(Data.read(save,slot.path+'/基础信息.json'),'当前位置'));
      if(currentId)mapFocus={eventId:lastMap.id,currentId};
    }catch(_){} }
    return {...baseline?{baseline}:{},id:save.id,name:save.name,actorId:spectator?null:actorId,...spectator?{spectator:true,spectatedActorId:actorId,panelsLocked:!slot}:{},round:save.round||0,status:save.status,characterImprint:!spectator&&memberId&&save.characterImprints?.[actorId]?.memberId===memberId?save.characterImprints[actorId].snapshot.imprintId:null,events,mapFocus,pendingActions:pending,rollbackCount:Math.min(10,save.snapshots?.length||0),rollbackTargetRound:save.snapshots?.at(-1)?.round??null,info:own.info,items:own.items,itemKeys:slot?itemKeys(save,slot,Data,keyMap):[],playerName:own.name,slots:publicSlots,room:roomView};
  }
  function meta(view){return pick(view,['id','name','actorId','spectator','spectatedActorId','panelsLocked','baseline','round','status','playerName','slots','room','pendingActions','rollbackCount','rollbackTargetRound','mapFocus','characterImprint']);}
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
  return {project,profile,inventory,summary,collection,pendingActions,hash,canonical,createHost,createClient,createMemoryTransport};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=MultiplayerSync;
