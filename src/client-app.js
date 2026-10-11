'use strict';
const GameApp=(()=>{
  const S={client:true,active:null,home:false,room:null,settings:{reverseSendNewline:false},mode:'play',running:false,saves:[],stream:{},error:null};
  const listeners=new Set(),pending=new Map(),recoveryRequests=new Set();let transport=null,memberId=null,stop=null,closedRoomId=null,bridgeSession=null,joinGeneration=0,cache=MultiplayerSync.createClient();
  const local=GameLocalInputs.create(localStorage);
  const emit=()=>{for(const fn of listeners)fn(S);};
  const scope=()=>S.active?.actorId?{gameId:S.active.id,memberId,actorId:S.active.actorId}:null;
  const sameScope=(a,b)=>a&&b&&a.gameId===b.gameId&&a.memberId===b.memberId&&a.actorId===b.actorId;
  function inputState(value){return {inputHistory:value.inputHistory.map(r=>({...r,rolledBack:r.status==='retracted'})),draft:value.draft,privateDraft:value.privateDraft,draftRound:value.draftRound,draftVersion:value.draftVersion};}
  function refreshInputs(identity){if(sameScope(identity,scope()))Object.assign(S.active,inputState(local.load(identity)));}
  function store(){if(!scope())return;const a=S.active;local.save(scope(),{epoch:S.room?.epoch||0,draft:a.draft||'',privateDraft:a.privateDraft||'',draftRound:a.draftRound,draftVersion:a.draftVersion||0});}
  async function sync(){if(transport)await transport.sendToHost(memberId,{type:'sync.request',payload:cache.request()});}
  async function receive(packet){
    if(packet.type==='room.closed'){
      if(packet.roomId!==S.room?.roomId)return;
      closedRoomId=packet.roomId;
      S.room={...S.room,online:false};if(S.active)S.active.room=S.room;S.running=false;S.error='房间已关闭';emit();return;
    }
    if(packet.type==='command.result'){const p=pending.get(packet.requestId);if(p){pending.delete(packet.requestId);clearTimeout(p.timer);packet.ok?p.resolve(packet):p.reject(Object.assign(Error(packet.message||'请求未执行'),{code:packet.error}));}return;}
    if(closedRoomId&&packet.scope?.roomId===closedRoomId)return;
    const receivingCache=cache,receivingTransport=transport,receivingMember=memberId;
    const before=receivingCache.getState(),applied=await receivingCache.apply(packet);
    if(cache!==receivingCache||transport!==receivingTransport||memberId!==receivingMember||closedRoomId&&packet.scope?.roomId===closedRoomId)return;
    if(!applied){
      if(cache.request().snapshotId){await sync();return;}
      const current=cache.getState(),sameRoom=!current||current.scope.roomId===packet.scope?.roomId;
      const newer=!current||packet.scope?.epoch>current.scope.epoch||packet.scope?.bindingVersion>current.scope.bindingVersion||packet.viewScope===current.viewScope&&packet.revision>current.revision;
      const recovery=packet.viewScope+':'+packet.revision;
      if(packet.protocol===1&&sameRoom&&newer&&!recoveryRequests.has(recovery)){
        recoveryRequests.add(recovery);if(recoveryRequests.size>64)recoveryRequests.delete(recoveryRequests.values().next().value);await sync();
      }
      return;
    }
    const next=cache.getState(),view=next.view,previous=S.active,same=previous?.id===view.id&&previous?.actorId===view.actorId;
    const identity={gameId:view.id,memberId,actorId:view.actorId};let inputs;
    try{
      inputs=view.actorId?local.load(identity):{epoch:next.scope.epoch,inputHistory:[],draft:'',privateDraft:'',draftRound:view.round+1,draftVersion:0};
      if(next.scope.epoch>inputs.epoch)inputs=local.rollback(identity,{round:view.round,epoch:next.scope.epoch});
      if(inputs.draftRound!==view.round+1&&!inputs.inputHistory.some(r=>r.status==='pending'&&r.round===inputs.draftRound))inputs=local.save(identity,{draft:'',privateDraft:'',draftRound:view.round+1,draftVersion:inputs.draftVersion+1});
    }catch(error){S.storageWarning=error.message;inputs=same?previous:{inputHistory:[],draft:'',privateDraft:'',draftRound:view.round+1,draftVersion:0};}
    S.active={...view,...inputState(inputs),cache:{Game_World_Time:view.events.at(-1)?.worldTime||''},snapshots:[],room:view.room};
    S.baseline=same&&before?.scope.epoch===next.scope.epoch?{info:before.view.info,items:before.view.items}:{info:view.info,items:view.items};
    S.room=view.room;S.running=view.room?.status==='executing';S.error=null;emit();
    if(transport)await transport.sendToHost(memberId,{type:'sync.ack',payload:cache.request()});
  }
  async function command(type,payload={},options={}){
    if(S.network&&S.network.status!=='connected')throw Error('连接已中断，请等待重连或重新连接');if(!transport||!S.room)throw Error('尚未连接房主');if(S.room.online===false)throw Error('房间已关闭');const r=options.room||S.room,requestId=options.requestId||crypto.randomUUID();
    const c={type,payload,requestId,roomId:r.roomId,epoch:r.epoch,roundId:r.roundId,bindingVersion:r.bindingVersion};
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('房主尚未确认，请同步状态后重试'));},15000);pending.set(requestId,{resolve,reject,timer});Promise.resolve(transport.sendToHost(memberId,c)).catch(e=>{clearTimeout(timer);pending.delete(requestId);reject(e);});});
  }
  async function send(text,privateContent=''){
    if(S.network&&S.network.status!=='connected')throw Error('连接已中断，请等待重连或重新连接');if(!S.active||!S.room)throw Error('尚未连接房主');if(S.room.online===false)throw Error('房间已关闭');if(!S.active.actorId)throw Error('请先申请角色槽位');text=String(text);privateContent=String(privateContent);
    if(!text.trim()&&!privateContent.trim())return;
    const identity=scope(),r={...S.room},round=S.active.round+1,previous=local.load(identity),old=previous.inputHistory.find(x=>x.roundId===r.roundId);
    const requestId=old?.status==='pending'&&old.text===text&&old.privateContent===privateContent?old.requestId:crypto.randomUUID();
    if(pending.has(requestId))throw Error('正在等待房主确认');
    local.record(identity,{round,roundId:r.roundId,epoch:r.epoch,text,privateContent,requestId,status:'pending'});
    local.save(identity,{draft:text,privateDraft:privateContent,draftRound:round,draftVersion:previous.draftVersion});refreshInputs(identity);emit();
    const result=await command('action.submit',{content:text,privateContent},{requestId,room:r});
    try{
      local.record(identity,{round,roundId:r.roundId,epoch:r.epoch,requestId,status:'accepted'});
      const current=local.load(identity);
      if(current.draftRound===round&&current.draft===text&&current.privateDraft===privateContent)local.save(identity,{draft:'',privateDraft:'',draftRound:sameScope(identity,scope())?S.active.round+1:round,draftVersion:current.draftVersion+1});
    }catch(error){if(error.code!=='LOCAL_INPUT_STALE')throw error;}
    refreshInputs(identity);emit();await sync();return result;
  }
  function disconnect(){stop?.();stop=null;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('连接已关闭，未确认的输入已保留'));}pending.clear();transport=null;}
  async function cancelAction(){
    const identity=scope(),r={...S.room},submittedRequestId=identity?local.load(identity).inputHistory.find(x=>x.roundId===r.roundId)?.requestId:undefined,result=await command('action.cancel',submittedRequestId?{submissionRequestId:submittedRequestId}:{});
    if(!sameScope(identity,scope())||S.room?.epoch!==r.epoch||S.room?.roundId!==r.roundId)return result;
    try{
      local.record(identity,{round:r.round,roundId:r.roundId,epoch:r.epoch,requestId:result.cancelledRequestId||submittedRequestId||'',text:result.cancelled.content,privateContent:result.cancelled.privateContent,status:'cancelled'});
      const current=local.load(identity),restore=!current.draft&&!current.privateDraft;
      local.save(identity,{draft:restore?result.cancelled.content:current.draft,privateDraft:restore?result.cancelled.privateContent:current.privateDraft,draftVersion:current.draftVersion+1});refreshInputs(identity);emit();
    }catch(error){if(error.code!=='LOCAL_INPUT_STALE')throw error;}
    return result;
  }
  async function attach(t,id){disconnect();transport=t;memberId=id;closedRoomId=null;cache=MultiplayerSync.createClient();const attachedCache=cache;recoveryRequests.clear();S.active=null;S.room=null;stop=t.onClient(id,packet=>{if(transport!==t||memberId!==id||cache!==attachedCache)return;return receive(packet);});await sync();}
  function stopNetwork(){joinGeneration++;const previous=bridgeSession;bridgeSession=null;previous?.close();disconnect();}
  async function joinRoom(value){
    const invitation=BridgeTransport.parseInvitation(value);stopNetwork();S.home=false;const generation=joinGeneration;
    S.network={status:'connecting',message:'正在连接房间'};S.error=null;emit();
    try{
      const session=await BridgeTransport.createClient({invitation,onState:async info=>{
        if(generation!==joinGeneration)return;
        S.network=info;
        if(info.status!=='connected')for(const [id,p]of pending){clearTimeout(p.timer);p.reject(Error('连接中断，未确认的输入已保留'));pending.delete(id);}
        if(info.status==='closed'&&S.room){S.room={...S.room,online:false};if(S.active)S.active.room=S.room;S.running=false;}
        emit();
        if(info.status==='connected'&&transport)await sync();
      }});
      if(generation!==joinGeneration){session.close();return;}
      bridgeSession=session;S.network={status:'connected',message:'已连接房间'};await attach(session.transport,session.memberId);emit();
    }catch(error){if(generation===joinGeneration){stopNetwork();S.network={status:'disconnected',message:error.message,code:error.code};S.error=error.message;emit();}throw error;}
  }
  async function reconnectRoom(){if(!bridgeSession)throw Error('请重新粘贴邀请链接加入房间');await bridgeSession.reconnect();}
  return {getState:()=>S,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},init:async()=>{try{S.settings=JSON.parse(localStorage.getItem('trpg-client-settings')||'{}');}catch(_){}},
    connect:async(t,id)=>{stopNetwork();S.network=null;await attach(t,id);},joinRoom,reconnectRoom,receive,sync,
    send,cancelAction,profile:async actorId=>(await command('profile.request',{actorId})).profile,skip:()=>command('action.skip'),requestRollback:()=>command('rollback.request',{targetRound:Math.max(0,S.active.round-1)}),roomCommand:command,
    player:()=>({info:S.active?.info||{},items:S.active?.items||[],name:S.active?.playerName}),exportView:()=>cache.getState()?.view,
    saveDraft:async(text,binding,options={})=>{if(S.active&&GameInputs.setDraft(S.active,options.private?'':text,binding)){S.active.privateDraft=options.private?String(text):String(options.privateContent||'');store();}},
    updateSettings:async values=>{S.settings={reverseSendNewline:values.reverseSendNewline===true};localStorage.setItem('trpg-client-settings',JSON.stringify(S.settings));emit();},
    setMode:()=>{},returnHome:()=>{S.home=true;emit();},returnToGame:()=>{if(S.active){S.home=false;emit();}},closeSave:()=>{stopNetwork();S.active=null;S.home=false;S.room=null;S.network=null;emit();}
  };
})();
