'use strict';
const GamePreSubmit=(()=>{
  const Inputs=typeof module!=='undefined'&&module.exports?require('./game-input-history'):GameInputs;
  const roundNumber=s=>s.active?.activeRound&&!s.active.activeRound.complete?s.active.activeRound.number:s.room?.round||s.active?.round+1;
  const identity=s=>s.active?.actorId?JSON.stringify([!!s.client,s.active.id,s.active.actorId,s.room?.epoch||s.active.multiplayer?.epoch||0]):null;
  function canPrepare(s,flags){
    if(s.active?.debrief)return false;
    if(s.room?.allowPreSubmit===false||!s.active?.actorId||!s.running||!flags.alive||!flags.enabled)return false;
    const round=roundNumber(s);
    return (s.active.events||[]).some(e=>e.type==='story'&&e.round===round&&
      (!Array.isArray(e.audience)||e.audience.includes(s.active.actorId))&&(!e.secret||Array.isArray(e.audience)));
  }
  function canSend(s,flags){
    return !!(s.active?.actorId&&!s.running&&s.active.status==='waiting'&&flags.alive&&flags.enabled&&
      s.room?.status==='collecting'&&!s.room.vote&&!Inputs.submission(s)&&
      (!s.network||s.network.status==='connected')&&(!s.client||s.room.online!==false));
  }
  function create({getState,getFlags,send,onChange=()=>{},onError=()=>{}}){
    let queued=null,lastNetwork;
    function current(){if(queued&&queued.identity!==identity(getState()))queued=null;return queued;}
    function prepare(draft){
      const s=getState();if(current()||!canPrepare(s,getFlags()))throw Error('当前不能预提交');
      const snapshot=Inputs.draftState(draft),action=Inputs.actionContent(snapshot);
      if(!action.content.trim()&&!action.privateContent.trim())throw Error('请先填写行动');
      queued={identity:identity(s),fromRound:roundNumber(s),snapshot,sending:false,error:null};
      onChange('prepared');return queued;
    }
    function cancel(){if(!current()||queued.sending)return false;queued=null;onChange('cancelled');return true;}
    async function tick(){
      const s=getState(),q=current();if(!q)return;
      const network=s.network?.status;
      if(lastNetwork!==network){q.lastAttempt=null;lastNetwork=network;}
      if(q.sending||s.active.round<q.fromRound)return;
      if(!canSend(s,getFlags())){q.lastAttempt=null;return;}
      const window=s.room.roundId||s.active.round;
      if(q.lastAttempt===window)return;
      q.lastAttempt=window;q.sending=true;q.error=null;onChange('sending');
      const action=Inputs.actionContent(q.snapshot);
      try{
        await send(action.content,action.privateContent,{...q.snapshot,draftState:{...q.snapshot},acceptOnly:true});
        if(current()===q){queued=null;onChange('sent');}
      }catch(error){
        if(current()===q){q.sending=false;q.error=error.message||String(error);onChange('failed');onError(error);}
      }
    }
    return {current,prepare,cancel,tick};
  }
  function createRemote({getState,getFlags,command,sync,storage,onChange=()=>{},onAccepted=()=>{},onCancelled=()=>{},onError=()=>{}}){
    let binding=null,ack=null,operation=null,timer=null,settled=null,saved=null;
    const scope=()=>{const s=getState();return s.active?.actorId&&s.room?JSON.stringify([s.active.id,s.active.actorId,s.room.memberId,s.room.roomId,s.room.epoch,s.room.bindingVersion]):null;};
    const storageKey=()=>{const s=getState();return 'game-prepared-input:'+JSON.stringify([s.active?.id,s.active?.actorId,s.room?.memberId]);};
    function resetScope(){
      const next=scope();if(next===binding)return;binding=next;ack=null;operation=null;settled=null;saved=null;clearTimeout(timer);timer=null;
      if(next&&storage)try{
        const value=JSON.parse(storage.getItem(storageKey())||'null');if(value?.binding===next)saved=value;
        const handled=JSON.parse(storage.getItem(storageKey()+':settled')||'null');if(handled?.binding===next)settled=handled.value;
      }catch(_){}
    }
    function record(){resetScope();const server=getState().room?.preparedAction;return ack&&(!server||ack.version>server.version)?ack:server;}
    function snapshot(q){return saved?.id===q.id?saved.snapshot:Inputs.draftState({draft:q.content||'',privateDraft:q.privateContent||'',hiddenSend:!!q.privateContent,disguiseSend:q.disguise===true});}
    function current(){resetScope();if(operation)return {snapshot:operation.snapshot,pending:true,cancelling:operation.cancel,error:operation.error,sending:false};const q=record();return q?.status==='queued'?{snapshot:snapshot(q),sending:false,remote:true}:null;}
    function reconcile(){
      const q=record();if(!q)return;
      if(q.status!=='queued'&&settled!==q.id+q.status){
        if(q.status==='submitted')onAccepted(q,snapshot(q));else if(q.status==='cancelled')onCancelled(q,snapshot(q));
        settled=q.id+q.status;
        // A reconnect must not restore an old cancelled draft or reinsert an expired history entry.
        try{storage?.setItem(storageKey()+':settled',JSON.stringify({binding,value:settled}));}catch(_){}
      }
      if(operation&&q.id===operation.id&&(!operation.cancel||q.status!=='queued')){operation=null;clearTimeout(timer);timer=null;onChange('confirmed');}
    }
    function retry(op){clearTimeout(timer);timer=setTimeout(()=>{timer=null;if(operation===op)attempt(op).catch(onError);},5000);timer?.unref?.();}
    async function attempt(op){
      resetScope();if(operation!==op||op.inflight)return false;
      const s=getState();if(s.network&&s.network.status!=='connected'){retry(op);return false;}
      op.inflight=true;op.error=null;
      try{
        const result=await command(op.cancel?'action.prepare.cancel':'action.prepare',op.payload,{requestId:op.requestId,room:op.room});
        resetScope();if(binding!==op.binding)return false;
        const q=result.preparedAction;if(!q)throw Object.assign(Error('房主未返回预提交状态，请更新房主页面'),{code:'UNSUPPORTED_PRE_SUBMIT'});
        if(!ack||q.version>=ack.version)ack=q;
        reconcile();onChange('confirmed');return !op.cancel||q.status==='cancelled';
      }catch(error){
        if(operation!==op)return false;
        if(error.code){operation=null;onChange('rejected');sync().catch(()=>{});throw error;}
        op.error='等待房主确认，连接恢复后会核对状态';onChange('uncertain');retry(op);sync().catch(()=>{});return false;
      }finally{op.inflight=false;}
    }
    function start(cancel,draft){
      resetScope();if(operation)throw Error('正在等待房主确认');
      const s=getState(),q=record();
      if(cancel&&q?.status!=='queued')return false;
      const state=cancel?snapshot(q):Inputs.draftState(draft);
      if(!cancel&&(q?.status==='queued'||!canPrepare(s,getFlags())))throw Error('当前不能预提交');
      const action=Inputs.actionContent(state);if(!cancel&&!action.content.trim()&&!action.privateContent.trim())throw Error('请先填写行动');
      const requestId=globalThis.crypto.randomUUID(),id=cancel?q.id:requestId;
      if(!cancel){saved={binding,id,snapshot:state};storage?.setItem(storageKey(),JSON.stringify(saved));}
      const op=operation={binding,id,requestId,cancel,snapshot:state,room:{...s.room},payload:cancel?{preparedId:id}:{content:action.content,privateContent:action.privateContent,...state.hiddenSend&&state.disguiseSend?{disguise:true}:{}},inflight:false};
      const work=attempt(op);onChange('pending');return work;
    }
    function tick(){reconcile();if(operation&&!operation.inflight&&!timer)attempt(operation).catch(onError);}
    return {current,prepare:draft=>start(false,draft),cancel:()=>{if(!current()||operation)return false;return start(true);},tick};
  }
  return {canPrepare,canSend,create,createRemote};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GamePreSubmit;
