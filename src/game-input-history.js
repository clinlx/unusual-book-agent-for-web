'use strict';
const GameInputs=(()=>{
  const LIMIT=10;
  const targetRound=s=>s.activeRound&&!s.activeRound.complete?s.activeRound.number:s.round+1;
  const owner=s=>({saveId:s.id,round:targetRound(s),version:s.draftVersion||0});
  function ensure(s){
    let records=Array.isArray(s.inputHistory)?s.inputHistory:[];
    if(!records.length)records=(s.events||[]).filter(e=>e.type==='player'&&!e.skip&&String(e.content||'').trim())
      .map(e=>({round:e.round,roundId:e.roundId||'legacy-'+e.round,text:String(e.content),at:e.at||0}));
    const byRound=new Map();
    for(const r of records)if(Number.isSafeInteger(r.round)&&r.round>0&&typeof r.text==='string'&&r.text.trim()){
      byRound.delete(r.round);byRound.set(r.round,{...r});
    }
    s.inputHistory=[...byRound.values()].slice(-LIMIT);return s.inputHistory;
  }
  function record(s,round,roundId,text){
    ensure(s);s.inputHistory=s.inputHistory.filter(r=>r.round!==round);
    s.inputHistory.push({round,roundId,text:String(text),at:Date.now(),rolledBack:false});s.inputHistory=s.inputHistory.slice(-LIMIT);
  }
  function get(s,round,roundId){return ensure(s).find(r=>r.round===round&&(!roundId||r.roundId===roundId));}
  function retract(s,round,roundId){const r=get(s,round,roundId);if(r)r.rolledBack=true;return r;}
  function advance(s){s.draftVersion=(s.draftVersion||0)+1;}
  function setDraft(s,text,binding=owner(s)){
    if(binding.saveId!==s.id||binding.round!==targetRound(s)||binding.version!==(s.draftVersion||0)||s.activeRound&&!s.activeRound.complete)return false;
    s.draft=String(text);s.draftRound=binding.round;return true;
  }
  return {LIMIT,targetRound,owner,ensure,record,get,retract,advance,setDraft};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameInputs;
