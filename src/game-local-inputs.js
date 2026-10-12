'use strict';
const GameLocalInputs=(()=>{
  const LIMIT=10,states=new Set(['pending','accepted','retracted','cancelled']);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const fail=(code,message)=>{const error=new Error(message);error.code=code;throw error;};
  const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
  function key(scope){
    const parts=['gameId','memberId','actorId'].map(k=>scope?.[k]);
    if(parts.some(v=>typeof v!=='string'||!v.trim()))fail('LOCAL_INPUT_SCOPE','本地输入缺少完整玩家身份');
    return 'game-local-inputs:v1:'+JSON.stringify(parts);
  }
  function empty(){return {version:1,epoch:0,inputHistory:[],draft:'',privateDraft:'',hiddenSend:false,disguiseSend:false,draftRound:1,draftVersion:0};}
  function entry(value){
    if(!value||!integer(value.round,1)||!integer(value.epoch)||typeof value.roundId!=='string'||!value.roundId)fail('LOCAL_INPUT_RECORD','本地输入回合标识无效');
    if(!states.has(value.status))fail('LOCAL_INPUT_RECORD','本地输入状态无效');
    if(typeof value.text!=='string'||typeof value.privateContent!=='string')fail('LOCAL_INPUT_RECORD','本地输入正文无效');
    if(value.requestId!==undefined&&typeof value.requestId!=='string')fail('LOCAL_INPUT_RECORD','本地输入请求标识无效');
    return {round:value.round,roundId:value.roundId,epoch:value.epoch,text:value.text,privateContent:value.privateContent,requestId:value.requestId||'',status:value.status,...value.hiddenSend!==undefined?{hiddenSend:value.hiddenSend===true,disguiseSend:value.hiddenSend===true&&value.disguiseSend===true}:{}};
  }
  function normalize(value){
    if(!value||value.version!==1||!Array.isArray(value.inputHistory)||!integer(value.epoch)||typeof value.draft!=='string'||typeof value.privateDraft!=='string'||!integer(value.draftRound,1)||!integer(value.draftVersion))fail('LOCAL_INPUT_RECORD','本地输入记录格式无效');
    const records=new Map();
    for(const item of value.inputHistory){const record=entry(item);records.delete(record.roundId);records.set(record.roundId,record);}
    const hiddenSend=value.hiddenSend??!!value.privateDraft;
    return {...empty(),epoch:value.epoch,inputHistory:[...records.values()].slice(-LIMIT),draft:value.draft,privateDraft:value.privateDraft,hiddenSend:hiddenSend===true,disguiseSend:hiddenSend===true&&(value.disguiseSend??!!value.draft)===true,draftRound:value.draftRound,draftVersion:value.draftVersion};
  }
  function create(storage){
    if(!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function')throw new Error('缺少本地输入存储接口');
    function load(scope){
      const name=key(scope);let raw;
      try{raw=storage.getItem(name);}catch{fail('LOCAL_INPUT_STORAGE','无法读取本地输入，请保留当前文本后重试');}
      if(raw===null||raw===undefined)return empty();
      try{return normalize(JSON.parse(raw));}catch{fail('LOCAL_INPUT_CORRUPT','本地输入记录损坏，已保留原始数据');}
    }
    function write(scope,state){
      const name=key(scope),next=normalize(state);
      try{storage.setItem(name,JSON.stringify(next));}catch{fail('LOCAL_INPUT_STORAGE','无法保存本地输入，请勿关闭页面并保留当前文本');}
      return clone(next);
    }
    function save(scope,patch){
      const previous=load(scope);
      if(patch.draftVersion!==undefined&&patch.draftVersion<previous.draftVersion||patch.epoch!==undefined&&patch.epoch<previous.epoch)fail('LOCAL_INPUT_STALE','草稿已过期，请重新读取当前回合');
      return write(scope,{...previous,...patch,version:1});
    }
    function record(scope,value){
      const previous=load(scope),old=previous.inputHistory.find(r=>r.roundId===value.roundId);
      const next=entry({text:'',privateContent:'',status:'pending',...old,...value});
      if(next.epoch<previous.epoch||old&&next.epoch!==old.epoch)fail('LOCAL_INPUT_STALE','输入回合已过期，保留本地文本供手动回填');
      if(old?.requestId&&next.requestId!==old.requestId&&next.status!=='pending')fail('LOCAL_INPUT_STALE','输入确认已过期，当前回合已有更新的提交');
      if(old?.status==='retracted'&&next.status!=='retracted')fail('LOCAL_INPUT_STALE','被撤回的输入已过期');
      if(old?.status==='cancelled'&&next.requestId===old.requestId&&next.status!=='cancelled')fail('LOCAL_INPUT_STALE','已取消的输入确认已过期');
      if(old?.status==='accepted'&&next.status==='pending'&&old.requestId===next.requestId)next.status='accepted';
      previous.inputHistory=previous.inputHistory.filter(r=>r.roundId!==next.roundId);previous.inputHistory.push(next);previous.epoch=Math.max(previous.epoch,next.epoch);
      return write(scope,previous);
    }
    function rollback(scope,{round,epoch}){
      if(!integer(round)||!integer(epoch))fail('LOCAL_INPUT_RECORD','回退回合或时间线无效');
      const previous=load(scope);
      if(epoch<previous.epoch)fail('LOCAL_INPUT_STALE','回退事件已过期');
      if(epoch===previous.epoch)return {...previous,restored:null};
      const candidates=previous.inputHistory.filter(r=>r.round===round+1&&r.epoch<epoch);
      const restored=candidates.at(-1)||null;
      for(const item of previous.inputHistory)if(item.epoch<epoch&&item.round>round)item.status='retracted';
      previous.epoch=epoch;previous.draft=restored?.text||'';previous.privateDraft=restored?.privateContent||'';previous.hiddenSend=restored?.hiddenSend??!!previous.privateDraft;previous.disguiseSend=previous.hiddenSend&&(restored?.disguiseSend??!!previous.draft);previous.draftRound=round+1;previous.draftVersion++;
      return {...write(scope,previous),restored:restored?clone(restored):null};
    }
    return {load,save,record,rollback};
  }
  return {LIMIT,create};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameLocalInputs;
