'use strict';
const GameApp=(()=>{
  const defaults={baseUrl:'https://api.deepseek.com/v1',apiKey:'',model:'deepseek-flash',stream:true,temperature:0.7,topP:'',frequencyPenalty:'',presencePenalty:'',seed:'',customRequestBody:'',maxContextK:240,maxOutputTokens:16384,
    reasoningEffort:'high',maxToolLoops:60,httpTimeoutSeconds:180,maxRetries:2,worldListSource:'',bridgeUrl:'wss://mc.birdry.cn:8443/',manualDice:false,autoAdvanceUnconscious:true,reverseSendNewline:false,promptOverrides:{}};
  const S={saves:[],active:null,home:false,switching:false,settings:{...defaults},mode:'play',running:false,importing:null,stream:{content:'',reasoning:'',tools:[],story:'',storyPublished:0},error:null,storageWarning:null,usage:null};
  const db=GameStore.create();const listeners=new Set();let controller=null,initialized=false,storage=null,lease=null;
  let hostSession=null,syncHost=null,roomTransport=null,transportStop=null,publishedSave=null,localInputOwner='',bridgeSession=null,bridgeGeneration=0,invitationQueue=Promise.resolve(),savedRoom=null,bridgeClosing=Promise.resolve();
  const invitationTask=fn=>{const job=invitationQueue.then(fn);invitationQueue=job.catch(()=>{});return job;};
  const inputScope=s=>({gameId:s.id,memberId:'host',actorId:s.actorId});
  const localInputs=()=>GameLocalInputs.create(storage);
  function saveLocalInputs(){const s=S.active;if(!s||!storage||localInputOwner!==JSON.stringify(inputScope(s)))return;try{
    const scope=inputScope(s),epoch=s.multiplayer?.epoch||0,old=localInputs().load(scope);
    if(epoch>old.epoch){Object.assign(s,localInputs().rollback(scope,{round:s.round,epoch}));return;}
    const records=(s.inputHistory||[]).map(r=>({...r,epoch:r.epoch??epoch,privateContent:r.privateContent||'',status:r.status||(r.rolledBack?'retracted':'accepted')}));
    localInputs().save(scope,{epoch,inputHistory:records,draft:s.draft||'',privateDraft:s.privateDraft||'',hiddenSend:s.hiddenSend??!!s.privateDraft,disguiseSend:s.disguiseSend??!!(s.privateDraft&&s.draft),draftRound:s.draftRound||s.round+1,draftVersion:s.draftVersion||0});
  }catch(error){S.storageWarning=error.message;}}
  function loadLocalInputs(s){localInputOwner=JSON.stringify(inputScope(s));if(!storage)return;try{
    const scope=inputScope(s),saved=localInputs().load(scope);
    if(saved.inputHistory.length||saved.draft||saved.privateDraft||saved.hiddenSend||saved.disguiseSend)Object.assign(s,saved);
    else saveLocalInputs();
  }catch(error){S.storageWarning=error.message;}}
  async function setupHost(s){
    await stopBridge();hostSession?.dispose();savedRoom=await db.getRoomConfig?.(s.id)||null;S.savedInvites=structuredClone(savedRoom?.invites||[]);S.openPlayerSlots=[...(savedRoom?.openSlots||S.savedInvites.map(i=>i.actorId))];GameSlots.ensure(s);GameSlots.initializeControlState(s,S.openPlayerSlots);s.actorId||=s.slots.find(x=>x.path===s.playerPath)?.id;
    loadLocalInputs(s);publishedSave=structuredClone(s);
    hostSession=MultiplayerHost.create({getSave:()=>s,getSettings:()=>S.settings,persist:async()=>{if(localInputOwner!==JSON.stringify(inputScope(s))){s.inputHistory=[];s.draft='';s.privateDraft='';s.hiddenSend=false;s.disguiseSend=false;s.draftVersion=0;loadLocalInputs(s);}await persist();saveLocalInputs();},
      execute:async(actions,options)=>{
        publishedSave=structuredClone(s);
        const own=actions.find(x=>x.memberId==='host');
        await executeRound(options.resume?'resume':options.starting?'start':'action',own?.content||'',{...options,actions,roundId:options.roundId});
        if(s.activeRound?.complete)publishedSave=structuredClone(s);
      },
      rollback:async({targetRound})=>{idle();while(s.round>targetRound||s.activeRound&&!s.activeRound.complete){GameCore.rollback(s);}GameHistory.backfill(s,true);readPlayer.clear(s);publishedSave=structuredClone(s);S.error=null;}
    });
    syncHost=MultiplayerSync.createHost({getSave:()=>{
      const stable=s.activeRound&&!s.activeRound.complete?publishedSave:s;
      return {...stable,events:s.events,status:s.status,slots:s.slots,round:s.round,snapshots:s.snapshots};
    },getRoom:()=>({...hostSession.state(),autoAdvanceUnconscious:S.settings.autoAdvanceUnconscious!==false})});
    hostSession.subscribe(()=>{emit();publishClients();});
    if(s.slotsConfigured!==false)await hostSession.initialize(s.actorId);
    S.room=hostSession.state();
  }
  async function publishClients(){
    if(!roomTransport||!hostSession?.state().online)return;
    for(const [id,m]of Object.entries(hostSession.state().members))if(id!=='host'&&m.actorId&&m.connected)scheduleClientSync(id);
  }
  const clientCursors=new Map();
  const profileRequests=new Map();
  const clientSyncJobs=new Map();
  function clearClientSyncJobs(){for(const job of clientSyncJobs.values())clearTimeout(job.timer);clientSyncJobs.clear();}
  function scheduleClientSync(id,force=false){
    if(!roomTransport||!hostSession?.state().online)return;
    let job=clientSyncJobs.get(id);if(!job){job={timer:null,busy:false,wanted:false,force:false,lastAt:0};clientSyncJobs.set(id,job);}
    job.wanted=true;job.force||=force;if(job.busy||job.timer!==null)return;
    const transport=roomTransport,domain=hostSession,sync=syncHost;
    job.timer=setTimeout(async()=>{
      job.timer=null;if(clientSyncJobs.get(id)!==job||transport!==roomTransport||domain!==hostSession)return;
      const member=domain.state().members[id];if(!domain.state().online||!member?.connected)return;
      const required=job.force;job.force=false;job.wanted=false;job.busy=true;job.lastAt=Date.now();
      try{
        const packet=await sync.sync(id,{...(clientCursors.get(id)||{}),onlyIfChanged:!required});
        if(packet&&clientSyncJobs.get(id)===job&&transport===roomTransport&&domain.state().online&&domain.state().members[id]?.connected)await transport.sendToClient(id,packet);
      }catch(_){}finally{
        job.busy=false;if(job.wanted&&clientSyncJobs.get(id)===job)scheduleClientSync(id);
      }
    },Math.max(force?0:75,job.lastAt+250-Date.now()));
  }
  async function attachMultiplayerTransport(transport){
    clearClientSyncJobs();transportStop?.();roomTransport=transport;
    transportStop=transport.onHost(async(memberId,command)=>{
      try{
        if(!hostSession?.state().online)throw Error('房间尚未开启');
        if(bridgeSession){const invited=S.network?.invites?.find(x=>x.memberId===memberId),bound=hostSession.state().members[memberId];if(!invited||bound?.actorId!==invited.actorId||!bound.connected||command.type==='slot.claim.request')throw Error('邀请仅允许使用指定角色');}
        if(command.type==='sync.ack'){clientCursors.set(memberId,command.payload||{});return;}
        if(command.type==='sync.request'){clientCursors.set(memberId,command.payload||{});scheduleClientSync(memberId,true);return;}
        if(['profile.request','inventory.request'].includes(command.type)){
          const r=hostSession.state(),m=r.members[memberId];
          if(typeof command.requestId!=='string'||command.requestId.length>160||command.roomId!==r.roomId||command.epoch!==r.epoch||command.bindingVersion!==m?.bindingVersion)throw Error('资料请求已失效');
          const kind=command.type==='inventory.request'?'inventory':'profile';
          const requestTimes=profileRequests.get(memberId)||{};
          if(Date.now()-(requestTimes[kind]||0)<250)throw Error('资料请求过于频繁');profileRequests.set(memberId,{...requestTimes,[kind]:Date.now()});
          await transport.sendToClient(memberId,{type:'command.result',requestId:command.requestId,ok:true,[kind]:MultiplayerSync[kind](active(),command.payload?.actorId,{room:r,memberId})});return;
        }
        const receipt=await hostSession.handle(memberId,command);await transport.sendToClient(memberId,{type:'command.result',...receipt});
      }catch(error){await transport.sendToClient(memberId,{type:'command.result',requestId:command.requestId,ok:false,error:error.code||'REQUEST_REJECTED',message:'请求未执行，请同步后重试或联系房主。'});}
    });return transportStop;
  }
  async function roomCommand(type,payload={},options={}){
    if(!hostSession)throw Error('请先选择存档');
    if(!S.settings.apiKey.trim()&&['action.submit','action.skip','round.start','round.resume','round.advance'].includes(type))throw Error('请先在设置中填写 API Key');
    if(S.active.slotsConfigured===false)throw Error('请先选择角色槽位');
    const r=hostSession.state(),m=r.members.host;
    const result=await hostSession.handle('host',{type,payload,requestId:GameCore.uid(),roomId:r.roomId,epoch:r.epoch,roundId:r.roundId,bindingVersion:m.bindingVersion});
    if(!options.acceptOnly)await hostSession.waitForIdle();emit();return result;
  }
  async function submitAction(content,privateContent='',options={}){
    const s=active();
    if(options.acceptOnly){
      const session=hostSession;await session.waitForIdle();
      if(session!==hostSession||S.active!==s)throw Error('预提交所属存档已切换');
    }
    if(!String(content).trim()&&!String(privateContent).trim())return;
    if(s.status==='new')return start();
    if(GameInputs.submission(S))throw Error('本回合已提交，请先撤回提交');
    const r=hostSession.state(),round=s.round+1;
    GameInputs.ensure(s);const hiddenSend=options.hiddenSend??!!privateContent,disguiseSend=options.disguiseSend??!!(content&&privateContent),draftState=GameInputs.draftState(options.draftState||{draft:String(content),privateDraft:String(privateContent),hiddenSend,disguiseSend}),entry={round,roundId:r.roundId,text:String(content),privateContent:String(privateContent),hiddenSend,disguiseSend,draftState,epoch:r.epoch,status:'pending'};s.inputHistory=s.inputHistory.filter(x=>x.roundId!==r.roundId).concat(entry).slice(-10);s.hiddenSend=hiddenSend;s.disguiseSend=disguiseSend;saveLocalInputs();
    s.draft='';s.privateDraft='';saveLocalInputs();
    const feedback=S.actionFeedback=GameInputs.feedback(S,{status:'pending',content:String(content),privateContent:String(privateContent),disguise:disguiseSend});emit();
    let result;
    try{result=await roomCommand('action.submit',{content:String(content),privateContent:String(privateContent),...hiddenSend&&disguiseSend?{disguise:true}:{}},{acceptOnly:options.acceptOnly===true});feedback.status='accepted';}
    catch(error){if(S.actionFeedback===feedback)S.actionFeedback=null;if(hostSession.state().roundId===r.roundId&&hostSession.state().status==='collecting'&&!s.draft&&!s.privateDraft)Object.assign(s,draftState);saveLocalInputs();emit();throw error;}
    const accepted=s.inputHistory.find(x=>x.roundId===r.roundId);if(accepted)accepted.status='accepted';
    saveLocalInputs();await persist();emit();return result;
  }
  async function configureSlots(actorId,modes={}){idle();const s=active();peerCheck(s);if(hostSession?.state().status!=='selecting')throw Error('房主只能在首次进入存档时选择角色，之后不能切换');saveLocalInputs();
    if(hostSession?.state().status==='selecting'){GameSlots.select(s,actorId,modes);s.inputHistory=[];s.draft='';s.privateDraft='';s.hiddenSend=false;s.disguiseSend=false;s.draftVersion=0;loadLocalInputs(s);await hostSession.initialize(actorId);}
    GameInputs.advance(s);saveLocalInputs();publishedSave=structuredClone(s);await persist();emit();
  }
  async function openRoom(){idle();if(!S.active.slotsConfigured)throw Error('请先选择角色槽位');return hostSession.open();}
  async function closeRoom(){const previous=hostSession.state();await hostSession.close();for(const id of Object.keys(previous.members))if(id!=='host')try{await roomTransport?.sendToClient(id,{type:'room.closed',roomId:previous.roomId});}catch(_){}await stopBridge();emit();}
  function stopBridge(){bridgeGeneration++;clearClientSyncJobs();profileRequests.clear();const previous=bridgeSession;bridgeSession=null;if(previous)bridgeClosing=Promise.resolve(previous.close()).catch(()=>{});transportStop?.();transportStop=null;roomTransport=null;clientCursors.clear();S.network=null;return bridgeClosing;}
  async function saveRoomRecord(value){
    const id=value?.saveId||active().id,next=value?{...value,openSlots:value.openSlots||value.invites.map(i=>i.actorId)}:null;
    await db.putRoomConfig?.(id,next);if(S.active?.id===id){savedRoom=structuredClone(next);S.savedInvites=structuredClone(next?.invites||[]);S.openPlayerSlots=[...(next?.openSlots||[])];}
  }
  async function forgetSavedInvite(memberId){if(savedRoom){const invite=savedRoom.invites.find(i=>i.memberId===memberId);await saveRoomRecord({...savedRoom,openSlots:(savedRoom.openSlots||[]).filter(id=>id!==invite?.actorId),invites:savedRoom.invites.filter(i=>i.memberId!==memberId)});}}
  async function configureInvitationSlot(actorId,kind){
    if(hostSession?.state().online)return setInvitationSlot(actorId,kind);
    return invitationTask(async()=>{
      idle();const s=active();peerCheck(s);const r=hostSession.state();
      if(!['player','ai','disabled'].includes(kind))throw Error('请选择玩家、NPC 或关闭');
      if(!s.slots.some(slot=>slot.id===actorId&&slot.kind!=='kpc'))throw Error('世界需要有空白角色槽位');
      GameSlots.assertConfigure(s,actorId,kind,{openPlayerSlots:S.openPlayerSlots});
      if(actorId===s.actorId)throw Error('房主角色已锁定，不能更改控制方式');
      if(r.status!=='collecting'||r.vote||Object.keys(r.submissions).length)throw Error('请在回合边界处理角色槽位');
      const before=savedRoom,openSlots=(S.openPlayerSlots||[]).filter(id=>id!==actorId);if(kind==='player')openSlots.push(actorId);
      const next={version:1,saveId:s.id,...savedRoom,openSlots,invites:(savedRoom?.invites||[]).filter(i=>i.actorId!==actorId||kind==='player')};
      await saveRoomRecord(next);
      try{if(kind!=='player')await roomCommand('slot.mode',{actorId,kind});}
      catch(error){await saveRoomRecord(before);throw error;}
      emit();return next.invites.find(i=>i.actorId===actorId)||null;
    });
  }
  async function connectRoom(){
    if(!S.openPlayerSlots?.length)throw Error('请先将至少一个角色槽位开放给玩家');
    return invitationTask(()=>openOnlineRoom());
  }
  async function openOnlineRoom(){
    idle();peerCheck(active());if(S.network?.status==='connecting')throw Error('正在连接联机服务');
    if(bridgeSession&&S.network?.status==='connected')return;
    if(!String(S.settings.bridgeUrl||'').trim())throw Error('请在高级选项填写多人游戏中转服务器地址');
    const url=BridgeTransport.validateServerUrl(S.settings.bridgeUrl),domain=hostSession,saveId=active().id;
    if(domain?.state().online)throw Error('请先关闭当前房间后重新开房');
    await bridgeClosing;
    if(savedRoom?.invites.length&&savedRoom.url!==url)throw Error('已有邀请使用另一联机服务，请切回原服务地址，或先将这些玩家槽位设为NPC，再重新开放。');
    const restored=savedRoom?.url===url&&savedRoom.roomId&&savedRoom.credentials?savedRoom:null;
    const generation=++bridgeGeneration;S.network={status:'connecting',message:'正在创建联机房间',invites:[]};emit();
    try{
      const room=restored?await domain.open({roomId:restored.roomId}):await openRoom();
      const wanted=[...(S.openPlayerSlots||[])],invites=(restored?.invites||[]).filter(i=>active().slots.some(slot=>slot.id===i.actorId&&slot.kind!=='kpc'&&slot.id!==active().actorId));
      const additions=wanted.filter(id=>!invites.some(i=>i.actorId===id)).map(actorId=>({actorId,memberId:'p_'+crypto.randomUUID().replaceAll('-','')}));
      let credentials=restored?.credentials;
      if(additions.length){
        const prepared=await BridgeTransport.prepareHostAuthorization({url,roomId:room.roomId,credentials,players:invites.map(i=>BridgeTransport.parseInvitation(i.key)),memberIds:additions.map(i=>i.memberId)});credentials=prepared.credentials;
        for(const item of additions){const key=BridgeTransport.encodeInvitation(prepared.players.find(i=>i.memberId===item.memberId)),link=new URL('client.html',location.href);link.search='';link.hash='join='+key;invites.push({...item,key,link:link.href});}
      }
      for(const invite of invites)if(!domain.state().members[invite.memberId])await domain.reserveInvitation(invite.memberId,invite.actorId);
      S.network.invites=structuredClone(invites);
      const session=await BridgeTransport.createHost({url,roomId:room.roomId,title:active().name,credentials,players:invites.map(i=>BridgeTransport.parseInvitation(i.key)),
        onMember:event=>invitationTask(async()=>{if(generation!==bridgeGeneration)return;const invited=S.network?.invites?.find(x=>x.memberId===event.memberId);if(!invited)return;if(event.type==='joined')await domain.joinInvitation(event.memberId);else if(domain.state().members[event.memberId])await domain.setConnected(event.memberId,false);}),
        onState:info=>{if(generation!==bridgeGeneration)return;S.network={...S.network,...info};if(info.status!=='connected')for(const [id,m]of Object.entries(domain.state().members))if(id!=='host'&&m.connected)domain.setConnected(id,false).catch(()=>{});emit();}
      });
      if(generation!==bridgeGeneration){session.close();throw Error('开房已取消');}
      bridgeSession=session;await saveRoomRecord({version:1,saveId,url,roomId:room.roomId,credentials:session.credentials?.(),invites});await attachMultiplayerTransport(session.transport);S.network={...S.network,status:'connected',message:'联机房间已开启'};emit();
    }catch(error){if(generation===bridgeGeneration){await stopBridge();try{if(domain.state().online)await domain.close();}catch(_){}S.network={status:'disconnected',message:error.message,code:error.code,invites:[]};emit();}throw error;}
  }
  function setInvitationSlot(actorId,kind){const domain=hostSession;return invitationTask(async()=>{
    idle();peerCheck(active());if(domain!==hostSession)throw Error('存档已经切换');if(!['player','ai','disabled'].includes(kind))throw Error('请选择玩家、AIPC 或关闭');
    const slot=active().slots.find(x=>x.id===actorId&&x.kind!=='kpc');if(!slot)throw Error('世界需要有空白角色槽位');
    GameSlots.assertConfigure(active(),actorId,kind,{openPlayerSlots:S.openPlayerSlots});
    const cached=savedRoom?.invites.find(i=>i.actorId===actorId),occupied=Object.entries(domain.state().members).find(([,m])=>m.actorId===actorId),existing=S.network?.invites?.find(x=>x.actorId===actorId);
    if(occupied){
      if(occupied[0]==='host')throw Error('房主角色已锁定，不能更改控制方式');
      if(kind==='player'&&existing)return structuredClone(existing);
      if(kind!=='ai')throw Error('已占用槽位可以由房主转为 NPC');
      const session=bridgeSession,id=occupied[0];if(!session)throw Error('请先连接房间');
      const beforeRecord=savedRoom;await forgetSavedInvite(id);
      try{await domain.release(id,'ai',{forget:true});}catch(error){try{await saveRoomRecord(beforeRecord);}catch(_){session.close();}throw error;}
      S.network.invites=S.network.invites.filter(x=>x.memberId!==id);clientCursors.delete(id);profileRequests.delete(id);
      const job=clientSyncJobs.get(id);if(job)clearTimeout(job.timer);clientSyncJobs.delete(id);
      try{await session.revoke(id);}catch(_){session.close();S.network={...S.network,status:'closed',message:'无法确认玩家权限撤销，房间连接已关闭'};emit();throw Error('角色已转为 NPC，但无法确认玩家权限撤销，房间连接已关闭');}
      emit();return null;
    }
    if(kind!=='player'){
      if(existing){const session=bridgeSession,generation=bridgeGeneration;if(!session)throw Error('房间已关闭');
        const beforeRecord=savedRoom;await forgetSavedInvite(existing.memberId);
        try{
          await domain.cancelInvitation(existing.memberId,kind);
          try{await session.revoke(existing.memberId);if(generation!==bridgeGeneration)throw Error('房间已经关闭');}
          catch(error){if(generation===bridgeGeneration)try{await domain.reserveInvitation(existing.memberId,actorId);}catch(_){session.close();S.network.invites=S.network.invites.filter(x=>x.memberId!==existing.memberId);}throw error;}
        }catch(error){try{await saveRoomRecord(beforeRecord);}catch(_){session.close();}throw error;}
        S.network.invites=S.network.invites.filter(x=>x.memberId!==existing.memberId);clientCursors.delete(existing.memberId);
      }
      else {const beforeRecord=savedRoom;if(cached)await forgetSavedInvite(cached.memberId);try{await roomCommand('slot.mode',{actorId,kind});}catch(error){if(cached)await saveRoomRecord(beforeRecord);throw error;}}emit();return null;
    }
    if(existing)return structuredClone(existing);
    await openOnlineRoom();if(domain!==hostSession)throw Error('存档已经切换');
    const resumed=S.network.invites.find(i=>i.actorId===actorId);if(resumed)return structuredClone(resumed);
    const session=bridgeSession,generation=bridgeGeneration,memberId='p_'+crypto.randomUUID().replaceAll('-',''),oldKind=slot.kind;
    await domain.reserveInvitation(memberId,actorId);
    try{
      const invitation=await session.invite(memberId);if(generation!==bridgeGeneration)throw Error('房间已经关闭');
      const key=BridgeTransport.encodeInvitation(invitation),url=new URL('client.html',location.href);url.search='';url.hash='join='+key;
      const result={actorId,memberId,key,link:url.href};await saveRoomRecord({...savedRoom,openSlots:[...new Set([...(savedRoom?.openSlots||[]),actorId])],invites:[...S.network.invites,result]});S.network.invites.push(result);emit();return structuredClone(result);
    }catch(error){try{await session.revoke(memberId);}catch(_){}if(generation===bridgeGeneration)try{await domain.cancelInvitation(memberId,oldKind==='ai'?'ai':'disabled');}catch(_){}throw error;}
  });}
  function rotateInvitation(actorId){return invitationTask(async()=>{
    idle();const s=active();peerCheck(s);const domain=hostSession,r=domain.state();
    if(actorId===s.actorId||r.status!=='collecting'||r.vote||Object.keys(r.submissions).length)throw Error('请在回合边界重新生成玩家密钥');
    const old=savedRoom?.invites.find(i=>i.actorId===actorId);if(!old)throw Error('请先连接服务器生成该槽位的邀请');
    const session=bridgeSession,generation=bridgeGeneration;let invitation;
    if(r.online){if(!session)throw Error('房间连接已关闭');invitation=await session.rotate(old.memberId);}
    else{
      const prepared=await BridgeTransport.prepareHostAuthorization({url:savedRoom.url,roomId:savedRoom.roomId,credentials:savedRoom.credentials,players:savedRoom.invites.filter(i=>i.memberId!==old.memberId).map(i=>BridgeTransport.parseInvitation(i.key)),memberIds:[old.memberId]});
      invitation=prepared.players.find(i=>i.memberId===old.memberId);
    }
    if(s!==S.active||domain!==hostSession||generation!==bridgeGeneration)throw Error('房间已经切换');
    const key=BridgeTransport.encodeInvitation(invitation),link=new URL('client.html',location.href);link.search='';link.hash='join='+key;
    const next={...old,key,link:link.href},invites=savedRoom.invites.map(i=>i.memberId===old.memberId?next:i);
    try{await saveRoomRecord({...savedRoom,invites});}
    catch(error){if(r.online){await stopBridge();await domain.close();S.network={status:'closed',message:'新密钥保存失败，房间已关闭，请重新生成密钥后连接'};emit();}throw error;}
    if(r.online){S.network.invites=structuredClone(invites);await domain.setConnected(old.memberId,false);clientCursors.delete(old.memberId);}
    emit();return structuredClone(next);
  });}
  async function createInvitation(actorId){
    if(!actorId){const occupied=new Set(Object.values(hostSession.state().members).map(m=>m.actorId));actorId=active().slots.find(s=>s.kind!=='kpc'&&!occupied.has(s.id)&&!S.network?.invites?.some(i=>i.actorId===s.id))?.id;}
    if(!actorId)throw Error('世界需要有空白角色槽位');return (await setInvitationSlot(actorId,'player')).link;
  }
  async function revokeInvitation(memberId){const invite=(S.network?.invites||S.savedInvites)?.find(x=>x.memberId===memberId);if(!invite)throw Error('邀请已失效');await setInvitationSlot(invite.actorId,'disabled');}
  const multiplayerState=()=>hostSession?.state();
  async function requestRollback(){const snap=active().snapshots.at(-1);if(!snap)throw Error('没有可回退的回合');return roomCommand('rollback.request',{targetRound:snap.round,targetRoundId:snap.inputRoundId});}
  async function decideHostRollback(decision){idle();peerCheck(active());const snap=active().snapshots.at(-1);if(!snap)throw Error('没有可回退的回合');const result=await roomCommand('rollback.host',{targetRound:snap.round,targetRoundId:snap.inputRoundId,decision});if(decision==='approve')S.lastRequest=null;emit();return result;}
  function exportView(){const s=active();return MultiplayerSync.project(s,s.actorId,{memberId:'host',room:hostSession?.state()});}
  try{storage=globalThis.localStorage;lease=Lease.create({storage,tabId:GameCore.uid()});}catch(_){}
  function emit(){if(S.active&&hostSession){S.room=hostSession.state();}for(const fn of listeners){try{fn(S);}catch(e){console.error(e);}}}
  const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  function idle(){if(S.importing)throw Error('请等待存档导入完成');if(S.running)throw Error('请先停止当前回合');}
  function active(){if(!S.active)throw Error('请先选择存档');return S.active;}
  function peerCheck(s){if(lease?.isHeldByOther(s.id))throw Error('该存档正在另一个页面运行，请等待其结束');}
  async function persist(){const s=active();s.updatedAt=Date.now();await db.putSave(s);S.saves=await db.list();}
  async function init(){if(initialized)return;await db.open();S.settings={...defaults,...await db.getSettings()};S.settings.promptOverrides||={};
    await db.putSettings(S.settings);
    S.saves=await db.list();if(db.memoryMode)S.storageWarning='浏览器存储不可用，当前内容仅临时保存，请在关闭页面前导出存档。';initialized=true;emit();}
  async function importSave(file){return runImport(()=>Promise.resolve(file));}
  async function importHandoff(id,onProgress=()=>{}){
    const target=WorldHandoff.saveId(id),bridge=WorldHandoff.create();
    if(S.active?.id===target){returnToGame();return S.active;}
    if(db.memoryMode)throw Error('存档数据库不可用，请导出 ZIP 后重试；世界尚未导入');
    await finishSession();
    S.importing={phase:'prepare',received:0,total:null};S.error=null;emit();
    try{
      onProgress('正在读取世界…');
      let existing=await db.getSave(target);
      if(!existing){
        const record=await bridge.get(id);
        if(!record?.blob)throw Error(record?.status==='complete'?'该世界曾导入，但对应存档已删除。请返回设计者重新试玩。':'未找到交接数据，可能已过期，或当前浏览器隔离了本地页面存储。请返回设计者导出 ZIP 后手动导入。');
        S.importing={phase:'extract'};emit();
        onProgress('正在解包世界…');
        const file=new File([record.blob],record.name.replace(/[\\/:*?"<>|]/g,'_')+'.zip',{type:'application/zip'});
        const save=await GameImport.importSave(file,{onProgress});
        save.id=target;
        save.name=record.name.trim()||save.name;
        onProgress('正在保存新的游玩存档…');
        await db.putSave(save,{ifAbsent:true});
      }
      S.saves=await db.list();
    }catch(error){S.error=error.message;throw error;}
    finally{S.importing=null;emit();}
    await openSave(target);
    // A committed save is authoritative, including after a crash before this cleanup.
    try{await bridge.complete(id);}catch(_){/* Retry can still recover the deterministic save. */}
    return S.active;
  }
  async function importLink(link,name){GameCatalog.url(link);return runImport(async()=>{const file=await GameCatalog.download(link,{onProgress:p=>{S.importing={...p,phase:'download'};emit();}});if(name)file.name=name+'.zip';return file;});}
  async function runImport(source){
    await finishSession();S.active=null;S.home=false;S.error=null;S.importing={phase:'prepare',received:0,total:null};emit();
    try{const file=await source();S.importing={...S.importing,phase:'extract'};emit();
      const s=await GameImport.importSave(file);GameCore.repairManualDiceEvents(s);await settleCompletedBatch(s);await db.putSave(s);S.saves=await db.list();S.active=s;restoreLastRequest(s);S.mode='play';await setupHost(s);return s;
    }catch(e){S.error=e.message||'导入失败';throw e;}finally{S.importing=null;emit();}
  }
  function restoreLastRequest(s){const last=s.requestHistory?.at(-1);S.lastRequest=last?.body?structuredClone(last.body):null;S.lastRequestSaveId=last?s.id:null;}
  const pendingBatch=s=>s.activeRound&&s.messages.some(m=>m.round===s.activeRound.number&&m.tool_calls?.some(tc=>!s.messages.some(r=>r.round===m.round&&r.role==='tool'&&r.tool_call_id===tc.id)));
  async function settleCompletedBatch(s){
    if(s.pendingManualDice||!s.activeRound?.complete||!pendingBatch(s))return;
    await GameCore.run(s,async()=>{throw Error('已结束的回合不能继续请求模型');});
    await db.putSave(s);
  }
  function returnHome(){S.home=true;emit();}
  function returnToGame(){if(S.active){S.home=false;emit();}}
  async function leaveForClient(){await finishSession();S.active=null;S.home=true;S.error=null;emit();}
  async function finishSession(){
    if(S.importing||S.switching)throw Error('请等待存档切换或导入完成');
    if(!S.active)return;
    S.switching=true;
    const session=hostSession,previous=session?.state(),transport=roomTransport;
    try{
      session?.dispose();abort();
      if(previous?.online)for(const id of Object.keys(previous.members))if(id!=='host')try{await transport?.sendToClient(id,{type:'room.closed',roomId:previous.roomId});}catch(_){}
      stopBridge();await session?.waitForIdle();
      if(S.active.multiplayer){S.active.multiplayer.online=false;S.active.multiplayer.roomId=null;for(const [id,m]of Object.entries(S.active.multiplayer.members||{}))m.connected=id==='host';}
      saveLocalInputs();await persist();hostSession=null;syncHost=null;S.room=null;
    }finally{S.switching=false;}
  }
  async function openSave(id){
    if(S.importing||S.switching)throw Error('请等待存档切换或导入完成');
    if(S.active?.id===id){returnToGame();return S.active;}
    const s=await db.getSave(id);if(!s)throw Error('存档不存在');
    peerCheck(s);
    const inputBindingMissing=!Array.isArray(s.inputHistory)||s.draftRound==null;
    GameInputs.ensure(s);s.draftRound??=GameInputs.targetRound(s);if(inputBindingMissing)await db.putSave(s);
    const repairedDice=GameCore.repairManualDiceEvents(s),backfilled=GameHistory.backfill(s);if(repairedDice||backfilled)await db.putSave(s);
    if(s.activeRound?.complete&&pendingBatch(s)){peerCheck(s);await settleCompletedBatch(s);}
    await finishSession();
    if(s.activeRound&&(!s.activeRound.complete||pendingBatch(s)))s.status='interrupted';S.active=s;S.home=false;restoreLastRequest(s);S.mode='play';S.error=s.error||null;await setupHost(s);emit();return s;}
  function closeSave(){idle();stopBridge();hostSession?.dispose();hostSession=null;S.room=null;S.active=null;S.home=false;S.error=null;emit();}
  async function renameSave(id,name){idle();const s=id===S.active?.id?S.active:await db.getSave(id);if(!s)throw Error('存档不存在');peerCheck(s);s.name=String(name).trim()||s.name;await db.putSave(s);S.saves=await db.list();emit();}
  async function deleteSave(id){idle();peerCheck({id});await db.deleteSave(id);if(S.active?.id===id){savedRoom=null;S.savedInvites=[];}if(S.active?.id===id){stopBridge();hostSession?.dispose();hostSession=null;S.active=null;}S.saves=await db.list();emit();}
  function exportSave(){idle();return GameImport.exportSave(active());}
  function rawRead(p){const node=VFS.resolve(active().tree,VFS.normalize(GameCore.path(p)));if(!node||node.type!=='file')throw Error('文件不存在');if(node.encoding==='base64')throw Error('该文件不能作为文本打开');return node.content;}
  function readFile(p){const resource=Prompts.file(p);return resource===undefined?rawRead(p):resource;}
  async function writeFile(p,text){idle();const s=active();peerCheck(s);const fp=GameCore.path(p);if(fp.startsWith('/.reference/'))throw Error('提示词为只读资源');
    VFS.writeFile(s.tree,fp,String(text));await persist();emit();}
  async function fileOperation(op,args={}){idle();const s=active();peerCheck(s);const t=VFS.clone(s.tree),p=GameCore.path(args.path),from=GameCore.path(args.from),to=GameCore.path(args.to);
    if([p,from,to].some(x=>x.startsWith('/.reference/')))throw Error('提示词为只读资源');
    if(op==='mkdir')VFS.mkdir(t,p);else if(op==='create'){if(VFS.resolve(t,VFS.normalize(p)))throw Error('同名文件已存在');VFS.writeFile(t,p,args.content||'');}
    else if(op==='delete')VFS.deletePath(t,p);else if(op==='move'||op==='copy')VFS[op](t,from,to);else throw Error('未知文件操作');
    const pp=GameCore.validateTree(t,s.playerPath);if(pp!==s.playerPath)throw Error('请通过角色槽位管理修改控制方式');s.tree=t;await persist();emit();}
  const readInfo=GamePresentation.createReader(s=>GameCore.player(s,'info')),readItems=GamePresentation.createReader(s=>GameCore.player(s,'items'));
  const readPlayer={clear:s=>{readInfo.clear(s);readItems.clear(s);}};
  function player(){const s=active(),info=readInfo(s),items=readItems(s);return {info:info.info,name:info.name,items:items.items,stale:info.stale||items.stale,infoStale:info.stale,itemsStale:items.stale,error:[info.error,items.error].filter(Boolean).join('；')};}
  function setMode(mode){S.mode=mode==='debug'?'debug':'play';emit();}
  function system(overrides){let world='';try{world=rawRead('/workspace/system.md');}catch(_){}return Prompts.buildSystem(overrides,world);}
  function currentContext(){
    if(S.lastRequest&&S.lastRequestSaveId===active().id)return GameSlots.playerContext(structuredClone(S.lastRequest.messages));
    const s=structuredClone(active()),frozen=!s.activeRound?.complete&&s.activeRound?.promptSnapshot;
    const overrides={},flows=Prompts.flows();
    const built=GameCore.context(s,(frozen?.system&&!Object.keys(frozen.overrides||{}).length?frozen.system:system()),GameTransport.inputBudget(S.settings,GameTools.build(Prompts,overrides)),{cachePrompt:flows.flow_cache,summariesPrompt:flows.flow_summaries,transformContext:Prompts.migrateText});
    return GameSlots.playerContext(built);
  }
  async function executeRound(kind,text,roundOptions={}){
    idle();let s=active();if(!S.settings.apiKey.trim())throw Error('请先在设置中填写 API Key');peerCheck(s);
    if(lease?.available){const lock=lease.acquireForRun(s.id,s.id);if(!lock.ok)throw Error('该存档正在另一个页面运行');}
    S.running=true;S.error=null;controller=new AbortController();
    const settings=structuredClone(S.settings);const overrides={};
    let timer;const clearStream=(keepStory=false)=>{const story=keepStory?S.stream.story||'':'',storyPublished=keepStory?S.stream.storyPublished||0:0;S.stream={content:'',reasoning:'',tools:[],story,storyPublished};};
    try{
      
      const latest=await db.getSave(s.id);if(latest&&latest.updatedAt>s.updatedAt)throw Error('存档已在其他页面更新，请重新打开后继续');
      if(kind!=='resume'&&pendingBatch(s))throw Error('上一轮尚有工具记录需要恢复，请先继续本回合');
      if(kind!=='resume')GameCore.beginRound(s,text,kind==='start',Prompts.roundPrompt(kind==='start',overrides),{skip:kind==='skip',openPlayerSlots:S.openPlayerSlots,slotPrompts:Prompts.slotControl(overrides),...roundOptions});
      else if(!s.activeRound)throw Error('没有可继续的回合');
      if(!s.activeRound.promptSnapshot||Object.keys(s.activeRound.promptSnapshot.overrides||{}).length)s.activeRound.promptSnapshot={overrides,system:system(overrides)};
      if(!Number.isFinite(s.activeRound.requestCount))s.activeRound.requestCount=s.messages.filter(m=>m.round===s.activeRound.number&&m.role==='assistant').length;
      s.activeRound.requestLimit??=settings.maxToolLoops;
      const snapshot=s.activeRound.promptSnapshot;
      snapshot.overrides=Prompts.migrateOverrides(snapshot.overrides);snapshot.system=Prompts.migrateText(snapshot.system);
      await persist();clearStream();emit();
      timer=setInterval(()=>{if(lease?.available){if(lease.lostWhileRunning(s.id))controller?.abort(Error('存档被另一个页面接管'));else lease.renewLease(s.id);}},lease?.HEARTBEAT||2000);
      const defs=GameTools.build(Prompts,snapshot.overrides);
      let currentRequest;
      const raw=GameTransport.create(settings,defs,{signal:controller.signal,
        onRequest:async body=>{if(currentRequest?.status==='pending')currentRequest.status='retried';currentRequest={round:s.activeRound.number,roundId:s.activeRound.id,at:Date.now(),body:structuredClone(body),status:'pending',response:{content:'',reasoning:'',tools:[]}};(s.requestHistory||=[]).push(currentRequest);s.activeRound.requestCount++;S.lastRequest=structuredClone(body);S.lastRequestSaveId=s.id;await persist();emit();},onUsage:usage=>{S.usage=usage;},
        onDelta:t=>{S.stream.content+=t;if(currentRequest)currentRequest.response.content+=t;emit();},onReasoningDelta:t=>{S.stream.reasoning+=t;if(currentRequest)currentRequest.response.reasoning+=t;emit();},onToolDelta:t=>{S.stream.tools=t;
          const storyCalls=t.filter(tc=>tc?.function?.name==='append_story');
          if(storyCalls.length){
            const parts=storyCalls.map(tc=>SSE.partialJsonString(tc.function.arguments,'content')).filter(v=>v!==null);
            if(parts.length){if(!S.stream.story)S.stream.storyPublished=s.activeRound?.published||0;S.stream.story=parts.join('\n\n');}
          }
          if(currentRequest)currentRequest.response.tools=structuredClone(t);emit();}});
      const transport=async messages=>{if(roundOptions.isCurrent&&!roundOptions.isCurrent())throw Error('回合已失效');clearStream();emit();try{const response=await raw(messages);if(roundOptions.isCurrent&&!roundOptions.isCurrent())throw Error('回合已失效');if(currentRequest){currentRequest.status='completed';currentRequest.response=structuredClone(response);}return response;}catch(e){if(currentRequest){currentRequest.status='interrupted';currentRequest.error=e.message;}throw e;}};
      const flows=Prompts.flows(snapshot.overrides);
      await GameCore.run(s,transport,{signal:controller.signal,system:snapshot.system,manualDice:settings.manualDice===true,
        cap:GameTransport.inputBudget(settings,defs),maxToolLoops:settings.maxToolLoops,multiplayerPrompts:Prompts.multiplayer(snapshot.overrides),
        
        
        resource:p=>Prompts.file(p),resourceList:Prompts.referencePaths(),afterStory:flows.flow_after_story,firstRecall:flows.flow_recall,
        resumePrompt:kind==='resume'?flows.flow_resume:'',cachePrompt:flows.flow_cache,summariesPrompt:flows.flow_summaries,transformContext:Prompts.migrateText,
        reminder:save=>!save.activeRound.triggered?flows.flow_need_trigger:!save.activeRound.published?flows.flow_no_story:flows.flow_need_end,
        onStep:async()=>{if(roundOptions.isCurrent&&!roundOptions.isCurrent())throw Error('回合已失效');if(lease?.available&&lease.lostWhileRunning(s.id))throw Error('存档被另一个页面接管');await persist();publishClients();const keepStory=!!S.stream.story&&(s.activeRound?.published||0)<=S.stream.storyPublished;clearStream(keepStory);emit();}});
    }catch(e){S.error=e.message||'回合未完成';if(s.activeRound&&!s.activeRound.complete){s.status='interrupted';s.error=S.error;}
      
      try{if(!lease?.lostWhileRunning(s.id))await persist();}catch(storageError){S.storageWarning='存档保存失败：'+storageError.message+'。请导出存档保留当前内容。';}throw e;
    }finally{
      try{await settleCompletedBatch(s);}catch(e){S.storageWarning='工具记录保存失败：'+e.message+'。请导出存档保留当前内容。';}
      clearInterval(timer);lease?.releaseLease(s.id);if(pendingBatch(s))s.status='interrupted';S.running=false;controller=null;clearStream();emit();
    }
  }
  const send=(text,privateContent='',options={})=>submitAction(text,privateContent,options);
  const skip=async(options={})=>{
    if(active().status==='new')throw Error('请先开始故事');
    if(GameInputs.submission(S))throw Error('本回合已提交，请先撤回提交');
    const flags=GameData.actorState(player().info);
    if(!flags.enabled)return roomCommand('round.advance');
    const s=active(),r=hostSession.state(),draftState=GameInputs.draftState(options.draftState||s);
    GameInputs.ensure(s);s.inputHistory=s.inputHistory.filter(x=>x.roundId!==r.roundId).concat({round:s.round+1,roundId:r.roundId,text:'',privateContent:'',hiddenSend:draftState.hiddenSend,disguiseSend:draftState.disguiseSend,draftState,epoch:r.epoch,status:'pending'}).slice(-10);saveLocalInputs();
    const feedback=S.actionFeedback=GameInputs.feedback(S,{status:'pending',content:'',privateContent:'',skip:true});emit();
    try{const result=await roomCommand('action.skip');feedback.status='accepted';const entry=s.inputHistory.find(x=>x.roundId===r.roundId);if(entry)entry.status='accepted';saveLocalInputs();emit();return result;}
    catch(error){if(S.actionFeedback===feedback)S.actionFeedback=null;emit();throw error;}
  };
  const start=async()=>{const members=Object.values(hostSession.state().members);if(S.openPlayerSlots?.some(id=>!members.some(m=>m.actorId===id)))throw Error('有开放给玩家的槽位但是没有玩家加入，请连接服务器并等待玩家加入后开始故事');return roomCommand('round.start');};
  async function configureNPCCards(actorKey,text){
    idle();const s=active();peerCheck(s);if(!GameSlots.canConfigureNPCCards(s))throw Error('NPC车卡要求需要在开始故事前填写');
    if(!GameSlots.scan(s.tree).some(slot=>GameSlots.npcRequirementKey(slot)===actorKey))throw Error('找不到对应角色');
    if(typeof text!=='string'||text.length>4000)throw Error('每名NPC的车卡要求最多4000字');
    s.npcCardInstructions={...GameSlots.npcRequirements(s),[actorKey]:text};await persist();emit();
  }
  const resume=()=>roomCommand('round.resume');
  function abort(){controller?.abort(Object.assign(Error('已中止本回合，可继续或回退'),{name:'AbortError'}));}
  async function rollback(){return decideHostRollback('approve');}
  async function updateSettings(values){
    const next={...S.settings};for(const k of Object.keys(defaults))if(k!=='promptOverrides'&&Object.hasOwn(values,k))next[k]=values[k];
    for(const [key,min,max]of [['maxContextK',4,4000],['maxOutputTokens',256,200000],['maxToolLoops',1,300],['httpTimeoutSeconds',10,3600],['maxRetries',0,10],['temperature',0,2]]){
      const n=Number(next[key]);if(!Number.isFinite(n)||n<min||n>max)throw Error(key+' 超出有效范围');next[key]=n;}
    for(const [key,min,max,integer]of [['topP',0,1,false],['frequencyPenalty',-2,2,false],['presencePenalty',-2,2,false],['seed',-2147483648,2147483647,true]]){
      const raw=String(next[key]??'').trim();if(!raw){next[key]='';continue;}const n=Number(raw);
      if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw Error(key+' 超出有效范围');next[key]=n;
    }
    for(const k of ['baseUrl','apiKey','model','worldListSource'])next[k]=String(next[k]||'').trim();
    next.customRequestBody=String(next.customRequestBody||'').trim();
    if(next.customRequestBody){let extra;try{extra=JSON.parse(next.customRequestBody);}catch(e){throw Error('自定义请求包体不是有效 JSON：'+e.message);}if(!extra||typeof extra!=='object'||Array.isArray(extra))throw Error('自定义请求包体必须是 JSON 对象');}
    if(next.worldListSource)GameCatalog.source(next.worldListSource);next.bridgeUrl=BridgeTransport.validateServerUrl(next.bridgeUrl);
    if(!['none','low','high','xhigh','max'].includes(next.reasoningEffort))throw Error('思考强度无效');
    next.stream=!!next.stream;next.manualDice=!!next.manualDice;next.autoAdvanceUnconscious=next.autoAdvanceUnconscious!==false;await db.putSettings(next);S.settings=next;emit();hostSession?.checkAutomatic().catch(()=>{});
  }
  async function resolveManualDice(rolls){
    idle();const s=active();peerCheck(s);GameCore.resolveManualDice(s,rolls);await persist();emit();return s;
  }
  function stageDraft(text,binding,options={}){if(!S.active)return false;peerCheck(S.active);if(!GameInputs.setDraft(S.active,options.private?'':text,binding))return false;S.active.privateDraft=options.private?String(text):String(options.privateContent||'');S.active.hiddenSend=options.hiddenSend??!!S.active.privateDraft;S.active.disguiseSend=options.disguiseSend??!!(S.active.privateDraft&&S.active.draft);saveLocalInputs();return true;}
  async function saveDraft(text,binding,options={}){if(stageDraft(text,binding,options))await persist();}
  async function cancelAction(){
    const s=active(),r=hostSession.state(),result=await roomCommand('action.cancel',{submissionRequestId:r.submissions?.[s.actorId]?.requestId});
    if(active()!==s||hostSession.state().roundId!==r.roundId||hostSession.state().epoch!==r.epoch)return result;
    S.actionFeedback=null;
    const entry=s.inputHistory?.find(x=>x.roundId===r.roundId);if(entry)entry.status='cancelled';
    if(GameInputs.shouldRestore(s))Object.assign(s,entry?.draftState||{draft:result.cancelled.content,privateDraft:result.cancelled.privateContent,hiddenSend:entry?.hiddenSend??!!result.cancelled.privateContent,disguiseSend:entry?.disguiseSend??!!(result.cancelled.privateContent&&result.cancelled.content)});
    GameInputs.advance(s);saveLocalInputs();await persist();emit();return result;
  }
  if(typeof window!=='undefined'){
    // Navigation inside the app is guarded by page-rendered UI, never a native unload dialog.
    window.addEventListener('storage',e=>{if(e.key?.startsWith('awl:lease:'))emit();});
  }
  return {getState:()=>S,subscribe,init,importSave,importHandoff,importLink,openSave,closeSave,returnHome,returnToGame,leaveForClient,renameSave,deleteSave,exportSave,send,skip,start,resume,abort,rollback,setMode,
    configureSlots,configureNPCCards,configureInvitationSlot,connectRoom,setInvitationSlot,openRoom,createInvitation,rotateInvitation,revokeInvitation,closeRoom,reconnectRoom:async()=>{if(!bridgeSession)throw Error('请先连接服务器建立房间');await bridgeSession.reconnect();},multiplayerState,roomCommand,requestRollback,decideHostRollback,exportView,attachMultiplayerTransport,
    addMember:id=>hostSession.addMember(id),setMemberConnected:(id,connected)=>hostSession.setConnected(id,connected),assignMember:(id,actor)=>hostSession.assign(id,actor),dispatchMember:(id,command)=>hostSession.handle(id,command),multiplayerSync:(id,request)=>syncHost.sync(id,request),
    readFile,writeFile,fileOperation,player,currentContext,updateSettings,stageDraft,saveDraft,resolveManualDice,cancelAction,
    profile:actorId=>MultiplayerSync.profile(active(),actorId,{room:hostSession?.state(),memberId:'host'}),
    inventory:actorId=>MultiplayerSync.inventory(active(),actorId,{room:hostSession?.state(),memberId:'host'}),
    testConnection:values=>GameTransport.testConnection({...S.settings,...values}),
    listModels:values=>GameTransport.listModels({...S.settings,...values})};
})();
