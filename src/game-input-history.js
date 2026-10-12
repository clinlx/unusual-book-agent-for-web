'use strict';
const GameInputs=(()=>{
  const LIMIT=10;
  const targetRound=s=>s.activeRound&&!s.activeRound.complete?s.activeRound.number:s.round+1;
  const owner=s=>({saveId:s.id,actorId:s.actorId,round:targetRound(s),epoch:s.multiplayer?.epoch||s.room?.epoch||0,version:s.draftVersion||0});
  function feedback(s,action){
    return {saveId:s.active.id,actorId:s.active.actorId,roomId:s.room.roomId,roundId:s.room.roundId,epoch:s.room.epoch,bindingVersion:s.room.bindingVersion,round:s.room.round||s.active.round+1,...action};
  }
  function currentFeedback(s){
    const f=s.actionFeedback,a=s.active,r=s.room;
    return f&&a&&r&&f.saveId===a.id&&f.actorId===a.actorId&&f.roomId===r.roomId&&f.roundId===r.roundId&&f.epoch===r.epoch&&f.bindingVersion===r.bindingVersion?f:null;
  }
  function submission(s){
    if(!s.active||s.room?.status!=='collecting')return null;
    const f=currentFeedback(s);
    if(f?.status==='cancelled')return null;
    if(s.client?s.room.submitted:s.room.submissions?.[s.active.actorId])return {status:'accepted'};
    return f&&['pending','accepted'].includes(f.status)?f:null;
  }
  function ensure(s){
    let records=Array.isArray(s.inputHistory)?s.inputHistory:[];
    if(!records.length)records=(s.events||[]).filter(e=>e.type==='player'&&!e.skip&&(!e.actorId||e.actorId===s.actorId)&&String(e.content||'').trim())
      .map(e=>({round:e.round,roundId:e.roundId||'legacy-'+e.round,text:String(e.content),at:e.at||0}));
    const byRound=new Map();
    for(const r of records)if(Number.isSafeInteger(r.round)&&r.round>0&&typeof r.text==='string'&&(r.text.trim()||String(r.privateContent||'').trim())){
      const key=s.multiplayer||s.room?r.roundId:r.round;byRound.delete(key);byRound.set(key,{...r});
    }
    s.inputHistory=[...byRound.values()].slice(-LIMIT);return s.inputHistory;
  }
  function record(s,round,roundId,text){
    ensure(s);s.inputHistory=s.inputHistory.filter(r=>s.multiplayer||s.room?r.roundId!==roundId:r.round!==round);
    s.inputHistory.push({round,roundId,text:String(text),at:Date.now(),rolledBack:false});s.inputHistory=s.inputHistory.slice(-LIMIT);
  }
  function get(s,round,roundId){return ensure(s).find(r=>r.round===round&&(!roundId||r.roundId===roundId));}
  function retract(s,round,roundId){const r=get(s,round,roundId);if(r)r.rolledBack=true;return r;}
  function advance(s){s.draftVersion=(s.draftVersion||0)+1;}
  function setDraft(s,text,binding=owner(s)){
    if(binding.saveId!==s.id||binding.actorId!==s.actorId||binding.epoch!==(s.multiplayer?.epoch||s.room?.epoch||0)||binding.round!==targetRound(s)||binding.version!==(s.draftVersion||0)||s.activeRound&&!s.activeRound.complete)return false;
    s.draft=String(text);s.draftRound=binding.round;return true;
  }
  return {LIMIT,targetRound,owner,feedback,currentFeedback,submission,ensure,record,get,retract,advance,setDraft};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameInputs;
