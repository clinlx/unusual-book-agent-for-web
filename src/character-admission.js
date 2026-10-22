'use strict';
// Pending cards stay outside the world tree and player projections until admitted.
const CharacterAdmission=(()=>{
  const common=typeof module!=='undefined'&&module.exports;
  const D=common?require('./game-data'):GameData,R=common?require('./character-records'):CharacterRecords,S=common?require('./character-snapshot'):CharacterSnapshot;
  const copy=x=>structuredClone(x),fail=(code,message)=>{throw Object.assign(Error(message),{code});};
  const policy=s=>s.characterPolicy||'review';
  const hash=x=>(common?require('./multiplayer-sync'):MultiplayerSync).hash(x);
  const summary=q=>q?{id:q.id,hash:q.hash,actorId:q.actorId,status:q.status,name:q.snapshot?.name||'',reason:q.reason||''}:null;
  async function verified(q){const snapshot=copy(q.snapshot);if(!q.hash||await hash(snapshot)!==q.hash)fail('CHARACTER_HASH_MISMATCH','角色卡内容已变化，请让玩家重新提交审核');return snapshot;}
  function current(s,q){const m=s.multiplayer?.members[q.memberId];return m?.actorId===q.actorId&&m.bindingVersion===q.bindingVersion&&s.slots.some(x=>x.id===q.actorId&&x.kind==='player');}
  function reset(s,q){
    if(!q.applied)return;const slot=s.slots.find(x=>x.id===q.actorId);if(slot){const node=D.node(s,slot.path);if(node)node.children=copy(q.original);}
    for(const path of q.itemPaths||[]){const split=path.lastIndexOf('/'),parent=D.node(s,path.slice(0,split));if(parent?.children)delete parent.children[path.slice(split+1)];}
    if(s.characterImports)delete s.characterImports[q.actorId];q.applied=false;q.itemPaths=[];
  }
  async function approve(s,q){
    const snapshot=await verified(q),slot=s.slots.find(x=>x.id===q.actorId);S.inject(s,slot,snapshot);q.itemPaths=D.read(s,slot.path+'/背包.json').map(id=>D.itemPath(id).replace(/\/[^/]+$/,''));q.applied=true;q.status='approved';q.reason='';
    s.characterImports||={};s.characterImports[q.actorId]={revision:q.id,hash:q.hash,name:snapshot.name,at:Date.now()};
  }
  function pending(s){
    return Object.values(s.characterReviews||{}).filter(q=>q.status==='pending'&&current(s,q));
  }
  function assertReady(s){const waiting=pending(s);if(waiting.length)fail('PENDING_CHARACTER_REVIEW','还有 '+waiting.length+' 名玩家自备的铭刻角色待审核（'+waiting.map(q=>q.actorId).join('、')+'），请在多人游戏窗口查看并通过或退回后再开始游戏。');}
  async function submit(s,memberId,snapshot,id){
    if(policy(s)==='deny')fail('CHARACTER_IMPORT_DISABLED','房主已禁用玩家自备的铭刻角色，请使用默认角色车卡');
    const valid=R.validate(snapshot);if(valid.unavailableReason)fail('INVALID_CHARACTER','不可用的角色不能进入新故事');
    const member=s.multiplayer.members[memberId],actorId=member.actorId,slot=s.slots.find(x=>x.id===actorId),previous=s.characterReviews?.[actorId];
    if(previous)reset(s,previous);
    const q={id,hash:await hash(valid),actorId,memberId,bindingVersion:member.bindingVersion,status:'pending',snapshot:valid,original:copy(D.node(s,slot.path).children),applied:false,viewed:false};
    s.characterReviews||={};s.characterReviews[actorId]=q;
    if(memberId==='host'||policy(s)==='allow')await approve(s,q);
    return {characterReview:summary(q)};
  }
  function find(s,actorId,id){const q=s.characterReviews?.[actorId];if(!q||q.id!==id||q.status!=='pending'||!current(s,q))fail('STALE_CHARACTER_REVIEW','这份申请已更新、已处理或玩家身份已变化，请重新查看');return q;}
  async function preview(s,actorId,id){const q=find(s,actorId,id),snapshot=await verified(q);q.viewed=true;q.viewedHash=q.hash;return {character:snapshot,characterReview:summary(q)};}
  async function decide(s,actorId,id,decision,expectedHash){
    const q=find(s,actorId,id);if(!['approve','reject'].includes(decision))fail('INVALID_DECISION','请选择通过或退回');
    if(decision==='approve'){if(!q.viewed)fail('REVIEW_NOT_VIEWED','请先查看这份角色卡，再确认通过');if(!expectedHash||expectedHash!==q.hash||q.viewedHash!==q.hash)fail('CHARACTER_HASH_MISMATCH','审核内容已变化，请重新查看当前角色卡');await approve(s,q);}
    else{reset(s,q);q.status='rejected';q.reason='房主已退回，请重新选择角色卡或使用默认角色车卡';delete q.snapshot;delete q.original;}
    return {characterReview:summary(q)};
  }
  async function setPolicy(s,value){
    if(!['review','allow','deny'].includes(value))fail('INVALID_POLICY','请选择需审核、允许或禁用');
    if(policy(s)===value)return;s.characterPolicy=value;
    for(const q of Object.values(s.characterReviews||{})){
      if(!['approved','pending'].includes(q.status))continue;
      if(!current(s,q)){reset(s,q);q.status='rejected';q.reason='玩家身份已变化，请重新选择';delete q.snapshot;delete q.original;continue;}
      if(value==='deny'){reset(s,q);q.status='rejected';q.reason='房主已禁用玩家自备的铭刻角色，已恢复默认角色';delete q.snapshot;delete q.original;}
      else if(value==='allow'&&q.status==='pending')await approve(s,q);
      else if(value==='review'&&q.memberId!=='host'){reset(s,q);q.status='pending';q.id=crypto.randomUUID();q.viewed=false;delete q.viewedHash;}
    }
  }
  return {policy,summary,pending,assertReady,submit,preview,decide,setPolicy};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=CharacterAdmission;
