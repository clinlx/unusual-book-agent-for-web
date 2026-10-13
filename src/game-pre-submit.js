'use strict';
const GamePreSubmit=(()=>{
  const Inputs=typeof module!=='undefined'&&module.exports?require('./game-input-history'):GameInputs;
  const roundNumber=s=>s.active?.activeRound&&!s.active.activeRound.complete?s.active.activeRound.number:s.room?.round||s.active?.round+1;
  const identity=s=>s.active?.actorId?JSON.stringify([!!s.client,s.active.id,s.active.actorId,s.room?.epoch||s.active.multiplayer?.epoch||0]):null;
  function canPrepare(s,flags){
    if(!s.active?.actorId||!s.running||!flags.alive||!flags.enabled)return false;
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
  return {canPrepare,canSend,create};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GamePreSubmit;
