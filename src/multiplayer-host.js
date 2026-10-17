'use strict';

const MultiplayerHost=(()=>{
  const common=typeof module!=='undefined'&&module.exports;
  const data=common?require('./game-data.js'):GameData;
  const history=common?require('./game-history.js'):GameHistory;
  const slots=()=>common?require('./game-slots.js'):GameSlots;
  const clone=x=>structuredClone(x);
  const validId=x=>typeof x==='string'&&x.length>0&&x.length<=160&&!['__proto__','constructor','prototype'].includes(x);
  const fail=(code,message)=>{const e=Error(message);e.code=code;throw e;};
  const canonical=x=>JSON.stringify(sort(x));
  function sort(x){if(Array.isArray(x))return x.map(sort);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])]));return x;}
  const aliases={submit:'action.submit',skip:'action.skip',start:'round.start',resume:'round.resume',advance:'round.advance',hostSkip:'action.hostSkip',requestRollback:'rollback.request',decideRollback:'rollback.decide',voteRollback:'rollback.vote',setSlotMode:'slot.mode'};
  function create({getSave,execute,rollback,persist=async()=>{},rebuildContext,getSettings=()=>({}),now=()=>Date.now(),uid=()=>globalThis.crypto.randomUUID()}){
    if(typeof getSave!=='function'||typeof execute!=='function'||typeof rollback!=='function')throw Error('缺少房主执行接口');
    let queue=Promise.resolve(),execution=null,timer=null,disposed=false,transactionState=null,lastAutomaticDice=null;
    const listeners=new Set();
    const save=()=>getSave();
    function room(){
      const s=save();
      if(!s.multiplayer)s.multiplayer={version:1,roomId:null,online:false,epoch:0,roundId:uid(),round:(s.round||0)+1,status:'selecting',members:{},participants:[],submissions:{},receipts:[],vote:null,slotRequests:[]};
      s.multiplayer.slotRequests||=[];s.multiplayer.preparedActions||={};
      return s.multiplayer;
    }
    const first=room();
    // Reopening a save never resumes an abandoned model request or network room.
    first.online=false;first.roomId=null;
    for(const member of Object.values(first.members))member.connected=false;
    if(first.members.host)first.members.host.connected=true;
    if(['executing','rolling_back'].includes(first.status))first.status='interrupted';
    const serial=fn=>{const job=queue.then(()=>{if(disposed)fail('CLOSED','房主会话已关闭');return fn();});queue=job.catch(()=>{});return job;};
    const transaction=fn=>serial(async()=>{
      const current=save(),context={before:clone(current),attempted:null};transactionState=context;
      try{return await fn();}catch(e){
        const attempted=context.attempted||clone(current);
        for(const key of new Set([...Object.keys(context.before),...Object.keys(attempted)])){
          // A model may write to the world while an unrelated presence update awaits storage.
          if(canonical(current[key])!==canonical(attempted[key]))continue;
          if(Object.hasOwn(context.before,key))current[key]=clone(context.before[key]);else delete current[key];
        }
        scheduleExpiry();throw e;
      }finally{transactionState=null;}
    });
    function publish(type,extra={}){const r=room(),event={type,round:r.round,roundId:r.roundId,epoch:r.epoch,...extra};for(const fn of listeners){try{fn(clone(event));}catch(_){/* A subscriber cannot undo a committed world. */}}}
    async function commit(type,extra){if(transactionState)transactionState.attempted=clone(save());await persist(save());if(transactionState){transactionState.before=clone(save());transactionState.attempted=null;}publish(type,extra);}
    function member(id){if(!validId(id)||!Object.hasOwn(room().members,id))fail('UNAUTHORIZED','成员身份无效');return room().members[id];}
    function host(id){if(id!=='host')fail('FORBIDDEN','只有房主可以执行此操作');}
    function boundary(){if(!['selecting','collecting'].includes(room().status)||room().vote)fail('BUSY','请在回合边界处理角色槽位');if(Object.keys(room().submissions).length)fail('BUSY','本轮已有提交，不能变更角色槽位');}
    function participants(){
      const s=save();slots().ensure(s);
      return Object.entries(room().members).flatMap(([memberId,m])=>{
        const slot=s.slots.find(x=>x.id===m.actorId&&x.kind==='player');if(!slot)return [];
        const identity={actorId:slot.id,memberId,bindingVersion:m.bindingVersion};
        try{const info=data.read(s,slot.path+'/基础信息.json');if(!info||typeof info!=='object'||Array.isArray(info))throw Error('角色资料必须是 JSON 对象');const flags=data.actorState(info);return [{...identity,alive:flags.alive,enabled:flags.enabled}];}
        catch(_){return [{...identity,alive:false,enabled:false,invalid:true}];}
      });
    }
    function refresh(){const r=room();r.participants=participants();r.round=(save().round||0)+1;return r.participants;}
    function validateActors(){const entries=refresh();if(entries.some(p=>p.invalid))fail('INVALID_ACTOR_DATA','角色资料无效，请在 DEBUG 中修复基础信息后继续');return entries;}
    function resetRound(){const r=room();r.roundId=uid();r.submissions={};r.frozenActions=null;r.execution=null;r.status=save().status==='ended'?'ended':'collecting';refresh();}
    function actor(id){const slot=save().slots.find(x=>x.id===id);if(!slot||slot.kind==='kpc')fail('INVALID_ACTOR','角色槽位不可选择');return slot;}
    function assignRaw(memberId,actorId){
      const r=room(),m=member(memberId),slot=actor(actorId);
      if(m.role==='spectator')fail('SPECTATOR_READ_ONLY','观战身份不能控制角色');
      if(memberId==='host'&&m.actorId&&m.actorId!==actorId)fail('HOST_SLOT_LOCKED','房主只能在首次进入存档时选择角色，之后不能切换');
      if(m.invitationActorId&&m.invitationActorId!==actorId)fail('FORBIDDEN','邀请仅允许使用指定角色');
      if(Object.entries(r.members).some(([id,x])=>id!==memberId&&(x.actorId===actorId||x.invitationActorId===actorId)))fail('OCCUPIED','该角色已有玩家控制或已开放邀请');
      if(m.actorId===actorId)return;
      if(slots().locked(save(),actorId))fail('SLOT_LOCKED',slots().LOCK_MESSAGE);
      const before=clone(save().tree),oldSlots=clone(save().slots),oldPath=save().playerPath;
      try{if(m.actorId){const old=actor(m.actorId);delete old.memberId;slots().setMode(save(),old.id,'disabled');}if(actor(actorId).kind!=='player')slots().setMode(save(),actorId,'player');}
      catch(e){save().tree=before;save().slots=oldSlots;save().playerPath=oldPath;throw e;}
      m.actorId=slot.id;m.bindingVersion=(m.bindingVersion||0)+1;r.receipts=r.receipts.filter(x=>x.memberId!==memberId);r.slotRequests=r.slotRequests.filter(x=>x.memberId!==memberId);
      actor(actorId).memberId=memberId;
      if(memberId==='host'){save().actorId=actorId;save().selectedActorId=actorId;save().slotsConfigured=true;save().playerPath=actor(actorId).path;}
      refresh();
    }
    function suspendRemote(){
      const r=room(),bindings=Object.entries(r.members).filter(([id,m])=>id!=='host'&&m.actorId).map(([memberId,m])=>({memberId,actorId:m.actorId}));
      if(!bindings.length)return;
      r.suspendedRoom={bindings,submissions:clone(r.submissions),round:save().round};
      for(const {memberId,actorId}of bindings){const slot=save().slots.find(x=>x.id===actorId);if(slot?.kind==='player'){delete slot.memberId;slots().setMode(save(),actorId,'disabled');}const m=member(memberId);m.actorId=null;m.bindingVersion++;}
      const own=r.submissions[r.members.host?.actorId];if(own){save().draft=own.content||'';save().privateDraft=own.privateContent||'';save().draftRound=(save().round||0)+1;save().draftVersion=(save().draftVersion||0)+1;}
      r.submissions={};r.receipts=[];r.slotRequests=[];r.roundId=uid();refresh();
    }
    function restoreRemote(){
      const r=room(),suspended=r.suspendedRoom;if(!suspended)return;
      delete r.suspendedRoom;
      if(suspended.round!==save().round)return;
      for(const {memberId,actorId}of suspended.bindings){
        if(!r.members[memberId]||r.members[memberId].actorId||Object.values(r.members).some(m=>m.actorId===actorId))continue;
        const slot=save().slots.find(x=>x.id===actorId);if(slot?.kind==='disabled')assignRaw(memberId,actorId);
      }
      for(const action of Object.values(suspended.submissions))if(r.members[action.memberId]?.actorId===action.actorId)r.submissions[action.actorId]=clone(action);
      refresh();
    }
    function signature(){
      const files={};
      function walk(node,path){if(history.generated(path))return;if(node?.type==='dir'){for(const [name,child]of Object.entries(node.children||{}))walk(child,path+'/'+name);}else if(node?.type==='file')files[path]={content:node.content,encoding:node.encoding||'utf8'};}
      walk(save().tree,'');return canonical({files,worldTime:data.worldTime(save())});
    }
    function readyActions(){const r=room();return r.participants.filter(p=>p.alive).map(p=>p.enabled?r.submissions[p.actorId]:{actorId:p.actorId,memberId:p.memberId,content:'无意识，无法行动，等待剧情恢复。',privateContent:'',skip:true,automatic:true}).filter(Boolean);}
    function launch({automatic=false,starting=false,resume=false}={}){
      const r=room();if(execution||r.status==='executing')fail('BUSY','当前回合正在执行');
      const actions=resume?r.frozenActions||[]:readyActions();
      const token={epoch:r.epoch,roundId:r.roundId,id:uid(),before:signature(),automatic,starting};
      r.status='executing';r.execution=token;r.frozenActions=clone(actions);
      return ()=>{
        execution=Promise.resolve().then(()=>execute(clone(actions),{automatic,starting,resume,epoch:token.epoch,roundId:token.roundId,executionId:token.id,isCurrent:()=>!disposed&&room().epoch===token.epoch&&room().execution?.id===token.id})).then(
          ()=>serial(async()=>{
            const current=room();if(current.epoch!==token.epoch||current.execution?.id!==token.id)return;
            if(save().status==='interrupted'||(save().activeRound&&!save().activeRound.complete)){current.status='interrupted';await commit('round.interrupted');return;}
            const noProgress=automatic&&save().status!=='ended'&&signature()===token.before;
            resetRound();
            if(!room().online){delete room().suspendedRoom;suspendRemote();}
            if(noProgress){room().status='interrupted';room().error='自动推进后世界时间与状态没有变化，请房主检查后继续。';room().automaticStalled=true;}
            await commit(noProgress?'round.interrupted':'round.completed',{completedRound:save().round,completedRoundId:token.roundId});
          }),
          error=>serial(async()=>{if(room().epoch!==token.epoch||room().execution?.id!==token.id)return;room().status='interrupted';room().error='回合执行中断，请房主继续或回退。';await commit('round.interrupted');})
        ).catch(()=>{if(room().execution?.id===token.id)room().status='interrupted';}).finally(()=>{execution=null;if(!disposed)checkAutomatic().catch(()=>{});});
      };
    }
    function promotePrepared(){
      const r=room();if(r.status!=='collecting'||r.vote||save().status==='new')return false;
      refresh();let changed=false;
      for(const [actorId,q]of Object.entries(r.preparedActions)){
        if(q.status!=='queued')continue;
        const m=r.members[q.memberId],entry=r.participants.find(p=>p.actorId===actorId&&p.memberId===q.memberId);
        if(q.epoch!==r.epoch||m?.actorId!==actorId||m.bindingVersion!==q.bindingVersion){q.status='cancelled';q.version++;changed=true;continue;}
        if(save().round<q.fromRound||!entry?.alive||!entry.enabled||entry.invalid)continue;
        if(r.submissions[actorId])continue;
        r.submissions[actorId]={actorId,memberId:q.memberId,requestId:q.id,content:q.content,privateContent:q.privateContent,...q.disguise?{disguise:true}:{},skip:false,automatic:false,submissionVersion:1};
        q.status='submitted';q.round=r.round;q.roundId=r.roundId;q.version++;changed=true;
      }
      return changed;
    }
    function awaitingInvite(){return Object.values(room().members).some(m=>m.invitationActorId&&!m.actorId);}
    function skipManualDice(actorId){
      return !!actorId&&room().online===true&&save().slots.some(s=>s.id===actorId&&s.kind==='player')&&Object.entries(room().members).some(([id,m])=>id!=='host'&&m.role!=='spectator'&&m.actorId===actorId&&m.skipManualDice===true);
    }
    function shouldRun(){const r=room();if(r.status!=='collecting'||r.vote||save().status==='new'||awaitingInvite())return false;refresh();if(r.participants.some(p=>p.invalid))return false;const living=r.participants.filter(p=>p.alive),awake=living.filter(p=>p.enabled);return living.length>0&&(awake.length?awake.every(p=>r.submissions[p.actorId]):getSettings().autoAdvanceUnconscious!==false);}
    function scope(m,command){const r=room();if(command.epoch!==r.epoch||command.roundId!==r.roundId)fail('STALE_ROUND','回合已更新，请同步后重试');if(command.bindingVersion!==m.bindingVersion)fail('STALE_BINDING','角色绑定已更新，请重新同步');if(command.roomId!==undefined&&command.roomId!==r.roomId)fail('STALE_ROOM','房间已更新');}
    function target(payload){
      const snapshots=save().snapshots||[];
      const snap=payload.targetRoundId?snapshots.find(x=>x.inputRoundId===payload.targetRoundId):snapshots.find(x=>x.round===payload.targetRound);
      if(!snap)fail('INVALID_TARGET','目标回合已不在可回退范围');return {targetRound:snap.round,targetRoundId:snap.inputRoundId};
    }
    function cancelTimer(){if(timer!==null)clearTimeout(timer);timer=null;}
    function scheduleExpiry(){cancelTimer();const v=room().vote;if(v?.status!=='voting')return;timer=setTimeout(()=>{checkAutomatic().catch(()=>{});},Math.max(0,v.expiresAt-now()));timer?.unref?.();}
    function expire(){const r=room();if(r.vote?.status==='voting'&&r.vote.expiresAt<=now()){r.vote=null;cancelTimer();return true;}return false;}
    function beginVote(){const r=room(),v=r.vote,eligible=Object.entries(r.members).filter(([,m])=>m.actorId&&save().slots.some(s=>s.id===m.actorId&&s.kind==='player')).map(([id])=>id);
      if(!r.online||eligible.length<2)fail('NO_MULTIPLAYER_VOTE','至少两位真人玩家加入联机房间后才能发起投票');
      v.status='voting';v.eligible=eligible;v.votes={};v.expiresAt=now()+120000;scheduleExpiry();
    }
    function spectatorView(value){
      if(value!=='none'&&value!=='all'&&!save().slots.some(s=>s.id===value&&s.kind==='player'))fail('INVALID_VIEW','请选择观众视角、全知视角或有效玩家视角');
      return value;
    }
    async function performRollback(){
      const r=room(),v=r.vote,controlModes=new Map(save().slots.map(s=>[s.id,s.kind]));target(v);r.status='rolling_back';cancelTimer();
      await rollback({targetRound:v.targetRound,targetRoundId:v.targetRoundId});
      // Rollback adapters may restore a snapshot containing older room metadata.
      save().multiplayer=r;r.epoch++;r.preparedActions={};r.vote=null;r.receipts=[];r.slotRequests=[];r.error=null;r.automaticStalled=false;
      slots().ensure(save());
      for(const slot of [...save().slots]){
        delete slot.memberId;
        const kind=controlModes.get(slot.id);if(kind&&slot.kind!==kind)slots().setMode(save(),slot.id,kind);
      }
      for(const [id,m]of Object.entries(r.members)){
        const slot=save().slots.find(x=>x.id===m.actorId);
        if(!slot||slot.kind!=='player'||(slot.memberId&&slot.memberId!==id)){m.actorId=null;m.bindingVersion++;}
        else slot.memberId=id;
      }
      resetRound();return {targetRound:v.targetRound,targetRoundId:v.targetRoundId};
    }
    async function handle(memberId,command){return transaction(async()=>{
      const r=room(),m=member(memberId);if(memberId!=='host'&&!r.online)fail('ROOM_CLOSED','房间尚未开启');
      if(!command||!validId(command.requestId))fail('INVALID_COMMAND','缺少有效请求标识');
      const fingerprint=canonical(command),old=r.receipts.find(x=>x.memberId===memberId&&x.requestId===command.requestId);
      if(old){if(old.fingerprint!==fingerprint)fail('REQUEST_CONFLICT','同一请求标识不能用于不同内容');return clone(old.receipt);}
      scope(m,command);const type=aliases[command.type]||command.type,p=command.payload||command;let start=null,reset=null,cancelled=null,cancelledRequestId;
      if(m.role==='spectator'&&type!=='spectator.view'&&!(memberId==='host'&&['round.start','round.resume','round.advance','action.hostSkip','rollback.host','rollback.decide','slot.mode','slot.claim.decide'].includes(type)))fail('SPECTATOR_READ_ONLY','观战者只能接收信息，不能提交行动、投票或更改游戏');
      if(expire())await commit('rollback.expired');
      switch(type){
        case 'dice.preference':{
          if(memberId==='host'||!m.actorId||p.actorId!==undefined&&p.actorId!==m.actorId)fail('FORBIDDEN','只能设置自己角色的掷骰偏好');
          if(typeof p.skip!=='boolean')fail('INVALID_COMMAND','skip 必须是布尔值');
          m.skipManualDice=p.skip;break;
        }
        case 'spectator.view':{
          if(m.role!=='spectator'||m.permission!=='all')fail('FORBIDDEN','房主未授予切换观战视角的权限');
          m.view=spectatorView(p.view);m.bindingVersion++;break;
        }
        case 'action.prepare':{
          if(r.status!=='executing'||r.vote)fail('BUSY','当前不能预提交');
          validateActors();const entry=r.participants.find(x=>x.memberId===memberId&&x.actorId===m.actorId);
          if(!entry?.alive||!entry.enabled)fail('INACTIVE_ACTOR','当前角色无法主动行动');
          if(!(save().events||[]).some(e=>e.type==='story'&&e.round===r.round&&(!e.audience||e.audience==='public'||Array.isArray(e.audience)&&e.audience.includes(m.actorId))&&(!e.secret||Array.isArray(e.audience))))fail('NO_STORY','当前回合尚无可见故事');
          if(p.actorId!==undefined&&p.actorId!==m.actorId)fail('FORBIDDEN','不能预提交其他角色的行动');
          const content=p.content??'',privateContent=p.privateContent??'';
          if(typeof content!=='string'||typeof privateContent!=='string'||content.length+privateContent.length>120000||!content.trim()&&!privateContent.trim()||p.disguise!==undefined&&typeof p.disguise!=='boolean'||p.disguise&&!privateContent.trim())fail('INVALID_ACTION','预提交内容无效');
          const previous=r.preparedActions[m.actorId];if(previous?.status==='queued')fail('ALREADY_PREPARED','已有预提交，请先取消');
          r.preparedActions[m.actorId]={id:command.requestId,version:(previous?.version||0)+1,status:'queued',memberId,actorId:m.actorId,bindingVersion:m.bindingVersion,epoch:r.epoch,fromRound:r.round,content,privateContent,disguise:p.disguise===true};break;
        }
        case 'action.prepare.cancel':{
          const q=r.preparedActions[m.actorId];
          if(!q||q.id!==p.preparedId||q.memberId!==memberId)fail('STALE_ACTION','预提交已更新，请同步后重试');
          if(q.status!=='queued')fail('ALREADY_SUBMITTED','预提交已处理，请同步当前回合');
          q.status='cancelled';q.version++;break;
        }
        case 'action.cancel':{
          if(r.status!=='collecting'||r.vote)fail('BUSY','行动已开始结算或正在处理回退，不能取消');
          if(p.actorId!==undefined&&p.actorId!==m.actorId)fail('FORBIDDEN','不能取消其他角色的行动');
          const previous=r.submissions[m.actorId];if(!previous||previous.memberId!==memberId)fail('NOT_SUBMITTED','当前没有等待结算的行动');
          if(p.submissionRequestId!==undefined&&p.submissionRequestId!==previous.requestId)fail('STALE_ACTION','已提交的行动发生变化，请同步后重试');
          cancelled={content:previous.content||'',privateContent:previous.privateContent||'',...previous.disguise?{disguise:true}:{}};cancelledRequestId=previous.requestId;delete r.submissions[m.actorId];break;
        }
        case 'action.submit':case 'action.skip':case 'action.hostSkip':{
          if(r.status!=='collecting'||r.vote||save().status==='new')fail('BUSY','当前不能提交行动');
          validateActors();let owner=memberId;
          if(type==='action.hostSkip'){host(memberId);owner=p.memberId;member(owner);}
          const bound=member(owner),entry=r.participants.find(x=>x.actorId===bound.actorId&&x.memberId===owner);
          if(!entry?.alive||!entry.enabled)fail('INACTIVE_ACTOR','当前角色无法主动行动');
          if(p.actorId!==undefined&&p.actorId!==bound.actorId)fail('FORBIDDEN','不能提交其他角色的行动');
          const skip=type!=='action.submit',content=skip?'':p.content??'',privateContent=skip?'':p.privateContent??'';
          if(typeof content!=='string'||typeof privateContent!=='string'||content.length+privateContent.length>120000||(!skip&&!content.trim()&&!privateContent.trim()))fail('INVALID_ACTION','行动内容为空或过长');
          if(p.disguise!==undefined&&typeof p.disguise!=='boolean'||p.disguise===true&&(skip||!privateContent.trim()))fail('INVALID_ACTION','伪装需要真实的私密行动');
          const previous=r.submissions[entry.actorId];
          r.submissions[entry.actorId]={actorId:entry.actorId,memberId:owner,requestId:command.requestId,content,privateContent,...p.disguise===true?{disguise:true}:{},skip,automatic:false,submissionVersion:(previous?.submissionVersion||0)+1};
          const prepared=r.preparedActions[entry.actorId];if(prepared?.status==='queued'){prepared.status='cancelled';prepared.version++;}
          if(shouldRun())start=launch();break;
        }
        case 'round.start':host(memberId);if(save().status!=='new'||r.vote||r.status!=='collecting')fail('BUSY','不能重复开局');
          if(awaitingInvite())fail('WAITING_PLAYERS','有开放给玩家的槽位，但是没有玩家加入。请等待玩家加入，或将空槽位设为 NPC 或关闭角色。');
          if(r.online&&Object.entries(r.members).some(([id,m])=>id!=='host'&&m.actorId&&!m.connected))fail('WAITING_PLAYERS','有玩家已掉线，请等待所有玩家重连后再开始游戏。');
          validateActors();start=launch({starting:true});break;
        case 'round.resume':host(memberId);if(r.status!=='interrupted'||r.vote)fail('BUSY','当前没有中断的回合');
          validateActors();if(r.automaticStalled){r.automaticStalled=false;r.status='collecting';start=launch({automatic:true});}else start=launch({resume:true});break;
        case 'round.advance':host(memberId);if(r.status!=='collecting'||r.vote||save().status==='new')fail('BUSY','当前不能手动推进');validateActors();
          if(!r.participants.length&&!(save().hostSpectator&&save().slots.some(s=>s.kind==='ai')))fail('NO_PLAYERS','请先安排真人角色或 NPC');
          if(r.participants.some(p=>p.alive&&p.enabled))fail('ACTIVE_PLAYERS','仍有清醒玩家需要提交行动');start=launch({automatic:true});break;
        case 'rollback.host':{
          host(memberId);if(!m.actorId&&m.role!=='spectator')fail('FORBIDDEN','请选择角色后再回退');
          if(!['collecting','interrupted','ended'].includes(r.status)||r.vote)fail('BUSY','请先中断当前执行或完成现有回退决策');
          if(!['approve','vote'].includes(p.decision))fail('INVALID_DECISION','请选择直接回退或发起投票');
          r.vote={id:uid(),requester:memberId,...target(p),status:'requested',eligible:[],votes:{},expiresAt:null};
          if(p.decision==='approve')reset=await performRollback();else beginVote();break;
        }
        case 'rollback.request':{
          if(!m.actorId)fail('FORBIDDEN','请选择角色后再请求回退');
          if(!['collecting','interrupted','ended'].includes(r.status)||r.vote)fail('BUSY','请先中断当前执行或完成现有回退决策');
          const t=target(p);r.vote={id:uid(),requester:memberId,...t,status:'requested',eligible:[],votes:{},expiresAt:null};break;
        }
        case 'rollback.decide':{
          host(memberId);const v=r.vote;if(!v||v.id!==p.voteId||!['requested','voting'].includes(v.status)||v.status==='voting'&&m.role!=='spectator')fail('STALE_VOTE','回退请求已失效');
          if(p.decision==='reject')r.vote=null;
          else if(p.decision==='approve'){reset=await performRollback();}
          else if(p.decision==='vote'&&v.status==='requested')beginVote();
          else fail('INVALID_DECISION','无效的回退决策');break;
        }
        case 'rollback.vote':{
          const v=r.vote;if(!v||v.id!==p.voteId||v.status!=='voting')fail('STALE_VOTE','投票已结束');
          if(!v.eligible.includes(memberId))fail('FORBIDDEN','当前成员不在本次投票名单');
          if(typeof p.approve!=='boolean')fail('INVALID_VOTE','请选择同意或拒绝');
          if(Object.hasOwn(v.votes,memberId))fail('ALREADY_VOTED','本次投票已提交');
          v.votes[memberId]=p.approve;
          if(Object.values(v.votes).filter(Boolean).length>=Math.ceil(v.eligible.length/2))reset=await performRollback();
          else if(Object.keys(v.votes).length===v.eligible.length){r.vote=null;cancelTimer();}break;
        }
        case 'slot.mode':host(memberId);boundary();actor(p.actorId);
          slots().assertConfigure(save(),p.actorId,p.kind);
          if(Object.values(r.members).some(m=>m.actorId===p.actorId||m.invitationActorId===p.actorId))fail('OCCUPIED','该角色已有玩家或邀请，请先撤销未使用的邀请');
          if(!['ai','disabled'].includes(p.kind))fail('INVALID_MODE','无人槽位仅可设为关闭或 AIPC');slots().setMode(save(),p.actorId,p.kind);refresh();break;
        case 'slot.claim.request':{
          if(memberId==='host'&&m.actorId)fail('HOST_SLOT_LOCKED','房主只能在首次进入存档时选择角色，之后不能切换');
          if(m.invitationActorId)fail('FORBIDDEN','邀请仅允许使用指定角色');
          boundary();actor(p.actorId);if(Object.values(r.members).some(x=>x.actorId===p.actorId||x.invitationActorId===p.actorId))fail('OCCUPIED','该角色已有玩家控制或已开放邀请');
          if(slots().locked(save(),p.actorId))fail('SLOT_LOCKED',slots().LOCK_MESSAGE);
          r.slotRequests=r.slotRequests.filter(x=>x.memberId!==memberId);
          r.slotRequests.push({id:uid(),memberId,actorId:p.actorId,at:now(),bindingVersion:m.bindingVersion,epoch:r.epoch});break;
        }
        case 'slot.claim.decide':{
          host(memberId);boundary();const claim=r.slotRequests.find(x=>x.id===p.claimId);
          if(!claim||claim.epoch!==r.epoch||member(claim.memberId).bindingVersion!==claim.bindingVersion)fail('STALE_CLAIM','选槽申请已失效');
          if(p.decision==='approve')assignRaw(claim.memberId,claim.actorId);
          else if(p.decision!=='reject')fail('INVALID_DECISION','请选择批准或拒绝');
          r.slotRequests=r.slotRequests.filter(x=>x.id!==claim.id);break;
        }
        default:fail('UNKNOWN_COMMAND','不支持的房主命令');
      }
      const current=room(),receipt={ok:true,requestId:command.requestId,epoch:current.epoch,roundId:current.roundId,status:current.status,...type.startsWith('action.prepare')?{preparedAction:clone(current.preparedActions[m.actorId])}:{},...cancelled?{cancelled,cancelledRequestId}:{}};
      current.receipts.push({memberId,requestId:command.requestId,fingerprint,receipt});if(current.receipts.length>512)current.receipts.splice(0,current.receipts.length-512);
      await commit(reset?'timeline.reset':'room.changed',reset||{});
      if(start)start();else if(type==='dice.preference'||!current.vote&&current.status==='collecting')queueMicrotask(()=>checkAutomatic().catch(()=>{}));
      return clone(receipt);
    });}
    async function checkAutomatic(){return transaction(async()=>{
      if(expire())await commit('rollback.expired');
      const r=room(),pending=save().pendingManualDice,event=pending&&(save().events||[]).find(e=>e.id===pending.eventId&&e.callId===pending.callId&&e.type==='dice'&&e.pending);
      const key=pending?JSON.stringify([r.epoch,r.roundId,pending.callId,pending.eventId]):null;
      if(!execution&&r.status==='interrupted'&&!r.vote&&pending?.round===save().activeRound?.number&&event&&skipManualDice(event.rollerId)&&lastAutomaticDice!==key){
        // One attempt per check: an unrelated API/storage failure must not create a resume loop.
        lastAutomaticDice=key;const start=launch({resume:true});await commit('round.executing');start();return true;
      }
      if(!execution&&promotePrepared())await commit('action.prepared.submitted');
      if(!execution&&shouldRun()){const automatic=!room().participants.some(p=>p.alive&&p.enabled),start=launch({automatic});await commit('round.executing');start();return true;}return false;
    });}
    return {
      rebuildContext:expected=>transaction(async()=>{
        const r=room();
        if(execution||['executing','rolling_back'].includes(r.status))fail('BUSY','请先停止当前回合，再重建上下文');
        if(r.online)fail('BUSY','请先关闭联机房间，再重建上下文');
        if(r.vote)fail('BUSY','请先完成或取消回退决策；如需回退，请在重建前进行');
        if(typeof rebuildContext!=='function')fail('UNAVAILABLE','当前环境不支持重建上下文');
        const result=await rebuildContext(expected);
        r.error=null;
        if(save().activeRound&&!save().activeRound.complete)r.status='interrupted';
        else if(save().status==='ended')r.status='ended';
        else if(r.status!=='selecting')r.status='collecting';
        await commit('context.rebuilt');
        return result;
      }),
      initialize:actorId=>transaction(async()=>{slots().ensure(save());slots().initializeControlState(save());const r=room();if(!r.members.host)r.members.host={actorId:null,bindingVersion:0,connected:true};
        if(r.status==='selecting'&&(actorId==='$spectator'||save().hostSpectator)){
          if(!save().hostSpectator)for(const slot of [...save().slots])if(slot.kind==='player'&&!slot.memberId)slots().setMode(save(),slot.id,'disabled');
          Object.assign(r.members.host,{role:'spectator',permission:'all',view:'all',actorId:null,bindingVersion:1});save().hostSpectator=true;save().actorId=null;save().selectedActorId=null;save().slotsConfigured=true;r.status=save().status==='ended'?'ended':save().activeRound&&!save().activeRound.complete?'interrupted':'collecting';
        }else if(r.status==='selecting'){const chosen=actorId||save().selectedActorId||save().slots.find(x=>x.path===save().playerPath&&x.kind!=='kpc')?.id;actor(chosen);
          for(const slot of [...save().slots])if(slot.id!==chosen&&slot.kind==='player'&&!slot.memberId)slots().setMode(save(),slot.id,'disabled');assignRaw('host',chosen);r.status=save().status==='ended'?'ended':save().activeRound&&!save().activeRound.complete?'interrupted':'collecting';}
        else if(actorId&&actorId!=='$spectator'&&actorId!==r.members.host.actorId){boundary();assignRaw('host',actorId);}refresh();if(!r.online&&['collecting','ended'].includes(r.status)&&!r.vote&&!r.participants.some(p=>p.invalid)){
          suspendRemote();for(const [id,m]of Object.entries(r.members))if(m.invitationActorId&&!m.actorId){slots().setMode(save(),m.invitationActorId,'disabled');delete r.members[id];}
          if(r.suspendedRoom)r.suspendedRoom.bindings=r.suspendedRoom.bindings.filter(x=>r.members[x.memberId]);refresh();
        }await commit('room.initialized');return clone(r);}),
      open:({roomId}={})=>transaction(async()=>{const r=room();if(r.status==='selecting')fail('SELECT_ACTOR','请先选择角色');if(['executing','rolling_back'].includes(r.status))fail('BUSY','请等待当前回合结束');if(!r.online){if(!r.vote&&r.status==='collecting')restoreRemote();if(roomId!==undefined&&(typeof roomId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)))fail('INVALID_ROOM','房间标识无效');r.online=true;r.roomId=roomId||uid();r.roundId=r.status==='interrupted'?r.roundId:uid();r.receipts=[];r.slotRequests=[];await commit('room.opened');}return clone(r);}),
      close:()=>transaction(async()=>{const r=room();if(!['selecting','collecting','ended'].includes(r.status)||r.vote)fail('BUSY','请先完成当前回合或回退决策');const own=r.submissions[r.members.host?.actorId];if(own){save().draft=own.content||'';save().privateDraft=own.privateContent||'';save().draftRound=(save().round||0)+1;save().draftVersion=(save().draftVersion||0)+1;}
        for(const [id,m]of Object.entries(r.members))if(id!=='host'){const actorId=m.actorId||m.invitationActorId;if(actorId){delete actor(actorId).memberId;slots().setMode(save(),actorId,'disabled');}delete r.members[id];}
        r.online=false;r.roomId=null;r.roundId=uid();r.receipts=[];r.slotRequests=[];r.submissions={};r.preparedActions={};delete r.suspendedRoom;refresh();await commit('room.closed');}),
      addMember:memberId=>transaction(async()=>{if(!validId(memberId)||memberId==='host')fail('INVALID_MEMBER','无效成员标识');const r=room();if(!r.online)fail('ROOM_CLOSED','请先开房间');if(!Object.hasOwn(r.members,memberId))r.members[memberId]={actorId:null,bindingVersion:0,connected:true};await commit('member.joined');return clone(r.members[memberId]);}),
      reserveSpectator:(memberId,permission='none')=>transaction(async()=>{
        const r=room();if(!r.online)fail('ROOM_CLOSED','请先开房间');
        if(!validId(memberId)||memberId==='host'||Object.hasOwn(r.members,memberId))fail('INVALID_MEMBER','无效成员标识');
        if(Object.values(r.members).filter(m=>m.role==='spectator').length>=8)fail('SPECTATOR_LIMIT','最多 8 个观战槽位');
        spectatorView(permission);r.members[memberId]={role:'spectator',actorId:null,permission,view:permission,bindingVersion:1,connected:false,joined:false};await commit('spectator.added');
      }),
      configureSpectator:(memberId,permission)=>transaction(async()=>{
        const m=member(memberId);if(memberId==='host'||m.role!=='spectator')fail('FORBIDDEN','此成员不是可配置的观战者');spectatorView(permission);
        m.permission=permission;m.view=permission;m.bindingVersion++;room().receipts=room().receipts.filter(x=>x.memberId!==memberId);await commit('spectator.configured');
      }),
      removeSpectator:memberId=>transaction(async()=>{const m=member(memberId);if(memberId==='host'||m.role!=='spectator')fail('FORBIDDEN','不能删除此成员');delete room().members[memberId];room().receipts=room().receipts.filter(x=>x.memberId!==memberId);await commit('spectator.removed');}),
      reserveInvitation:(memberId,actorId)=>transaction(async()=>{boundary();const r=room();if(!r.online)fail('ROOM_CLOSED','请先开房间');if(!validId(memberId)||memberId==='host'||Object.hasOwn(r.members,memberId))fail('INVALID_MEMBER','无效成员标识');actor(actorId);
        slots().assertConfigure(save(),actorId,'player');
        if(Object.values(r.members).some(m=>m.actorId===actorId||m.invitationActorId===actorId))fail('OCCUPIED','该角色已有玩家控制或已开放邀请');
        slots().setMode(save(),actorId,'player');r.members[memberId]={actorId:null,invitationActorId:actorId,bindingVersion:0,connected:false};refresh();await commit('invitation.opened');return clone(r.members[memberId]);}),
      joinInvitation:memberId=>transaction(async()=>{if(!room().online)fail('ROOM_CLOSED','房间已关闭');const m=member(memberId);if(m.role!=='spectator'){if(!m.invitationActorId)fail('UNAUTHORIZED','邀请已失效');assignRaw(memberId,m.invitationActorId);}m.connected=true;m.joined=true;await commit('member.joined');return clone(m);}),
      cancelInvitation:(memberId,kind='disabled')=>transaction(async()=>{boundary();const m=member(memberId);if(m.actorId)fail('OCCUPIED','该槽位已有玩家加入，断线后仍保留占用');if(!m.invitationActorId||!['ai','disabled'].includes(kind))fail('INVALID_MODE','请选择关闭或 AIPC');slots().setMode(save(),m.invitationActorId,kind);delete room().members[memberId];room().receipts=room().receipts.filter(x=>x.memberId!==memberId);refresh();await commit('invitation.closed');}),
      assign:(memberId,actorId)=>transaction(async()=>{boundary();assignRaw(memberId,actorId);await commit('member.assigned');return clone(member(memberId));}),
      release:(memberId,kind='disabled',{forget=false}={})=>transaction(async()=>{boundary();if(memberId==='host')fail('FORBIDDEN','房主请通过切换槽位选择角色');if(!['ai','disabled'].includes(kind))fail('INVALID_MODE','无人槽位仅可设为关闭或 AIPC');const m=member(memberId);if(m.actorId){delete actor(m.actorId).memberId;slots().setMode(save(),m.actorId,kind);delete room().preparedActions[m.actorId];m.actorId=null;m.bindingVersion++;if(forget)delete room().members[memberId];room().receipts=room().receipts.filter(x=>x.memberId!==memberId);room().slotRequests=room().slotRequests.filter(x=>x.memberId!==memberId);refresh();await commit('member.released');}}),
      setConnected:(memberId,connected)=>transaction(async()=>{member(memberId).connected=!!connected;await commit('member.connection');}),
      handle,checkAutomatic,skipManualDice,state:()=>clone(room()),subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},
      waitForIdle:async()=>{await queue;while(execution){await execution;await queue;}},
      dispose:()=>{disposed=true;cancelTimer();listeners.clear();}
    };
  }
  return {create};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=MultiplayerHost;
