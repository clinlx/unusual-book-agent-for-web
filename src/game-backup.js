'use strict';
const GameBackup=(()=>{
  const common=typeof module!=='undefined'&&module.exports;
  const DB=common?require('./game-database'):GameDatabase,Library=common?require('./character-library'):CharacterLibrary;
  const stores=['saves','messages','events','config','characters','receipts','meta'];
  const preferences=['reverseSendNewline','roundNotifications','manualDice','openingPreload','autoAdvanceUnconscious','promptOverrides','worldListSource','bridgeUrl'];
  const allowedLocal=key=>['trpg-client-settings','trpg-vitals-collapsed','awl:settings-sections'].includes(key)||key.startsWith('game-local-inputs:v1:')||key.startsWith('game-prepared-input:');
  const read=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('备份事务未完成'));tx.onerror=()=>{};});
  async function records(tx){const out={};for(const name of stores){const s=tx.objectStore(name);if(name==='meta'){const [keys,values]=await Promise.all([read(s.getAllKeys()),read(s.getAll())]);out[name]=Object.fromEntries(keys.map((key,i)=>[key,values[i]]));}else out[name]=await read(s.getAll());}return out;}
  async function capture(){const db=await DB.open();try{const tx=db.transaction(stores,'readonly'),complete=done(tx),data=await records(tx);await complete;return data;}finally{db.close();}}
  const selectSettings=value=>Object.fromEntries(preferences.filter(k=>Object.hasOwn(value||{},k)).map(k=>[k,value[k]]));
  function sanitize(data){
    const out=structuredClone(data);
    out.config=out.config.filter(x=>x.id==='settings'||x.id.startsWith('room:')).map(x=>x.id==='settings'?{id:'settings',value:selectSettings(x.value)}:x);
    // Keep diagnostic replies and conversation history, excluding API request configuration.
    for(const save of out.saves)for(const request of save.requestHistory||[])if(request.body)request.body=Object.fromEntries(['messages','tools'].filter(k=>Object.hasOwn(request.body,k)).map(k=>[k,request.body[k]]));
    delete out.meta.pendingPreferences;return out;
  }
  function localPreferences(storage=globalThis.localStorage){const out={};for(let i=0;i<storage.length;i++){const key=storage.key(i);if(allowedLocal(key))out[key]=storage.getItem(key);}return out;}
  async function exportData(){return {format:'trpg-game-site',version:1,exportedAt:Date.now(),data:sanitize(await capture()),local:localPreferences()};}
  function validate(value){
    if(value?.format!=='trpg-game-site'||value.version!==1||!value.data||!value.local||typeof value.local!=='object')throw Error('请选择本网站的完整数据备份');
    const text=JSON.stringify(value);if(text.length>256*1024*1024)throw Error('备份数据过大');JSON.parse(text,(key,v)=>{if(['__proto__','prototype','constructor'].includes(key))throw Error('备份含不安全字段');return v;});
    const d=value.data;for(const name of stores)if(name==='meta'?!d[name]||Array.isArray(d[name])||typeof d[name]!=='object':!Array.isArray(d[name]))throw Error('备份缺少数据区：'+name);
    const ids=new Set();for(const s of d.saves){if(typeof s.id!=='string'||!s.id||ids.has(s.id)||s.tree?.type!=='dir'||!s.tree.children?.workspace||!Number.isSafeInteger(s.round)||s.round<0)throw Error('存档数据无效或重复');ids.add(s.id);}
    for(const name of ['messages','events']){const seen=new Set();for(const r of d[name]){const key=JSON.stringify([r.saveId,r.seq]);if(!ids.has(r.saveId)||!Number.isSafeInteger(r.seq)||r.seq<0||!r.value||seen.has(key))throw Error('存档历史数据无效');seen.add(key);}}
    Library.validateBackup({format:'trpg-character-vault',version:1,characters:d.characters,warehouse:d.meta.warehouse||[],receipts:d.receipts,unlocked:!!d.meta.unlocked});
    for(const [key,v]of Object.entries(value.local))if(!allowedLocal(key)||typeof v!=='string')throw Error('备份含不支持的偏好设置');
    for(const c of d.config)if(typeof c.id!=='string'||!(c.id==='settings'||c.id.startsWith('room:')))throw Error('备份含不支持的配置');
    return {...structuredClone(value),data:sanitize(d)};
  }
  async function restore(value,expected){
    const checked=validate(value),db=await DB.open();
    try{const tx=db.transaction(stores,'readwrite'),complete=done(tx);
      try{
        const current=await records(tx);if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('数据已在其他页面变化，请重新确认导入');
        const api=Object.fromEntries(Object.entries(current.config.find(x=>x.id==='settings')?.value||{}).filter(([k])=>!preferences.includes(k)));
        for(const name of stores)tx.objectStore(name).clear();
        for(const name of stores)if(name==='meta'){for(const [key,v]of Object.entries(checked.data.meta))tx.objectStore(name).put(v,key);}else for(const row of checked.data[name])tx.objectStore(name).put(row);
        const settings=checked.data.config.find(x=>x.id==='settings')?.value||{};tx.objectStore('config').put({id:'settings',value:{...settings,...api}});
        // Keep local spent receipts so importing an old backup cannot unlock another imprint.
        for(const receipt of current.receipts)tx.objectStore('receipts').put(receipt);
        if(current.meta.unlocked||checked.data.characters.length)tx.objectStore('meta').put(true,'unlocked');
        tx.objectStore('meta').put(checked.local,'pendingPreferences');tx.objectStore('meta').put(crypto.randomUUID(),'revision');await complete;
      }catch(error){try{tx.abort();}catch(_){}await complete.catch(()=>{});throw error;}
    }finally{db.close();}
    await applyPreferences();
  }
  async function applyPreferences(){const db=await DB.open();try{
    const pending=await read(db.transaction('meta').objectStore('meta').get('pendingPreferences'));if(!pending)return;
    const storage=globalThis.localStorage;
    for(const key of Object.keys(localPreferences(storage)))storage.removeItem(key);
    for(const [key,value]of Object.entries(pending))if(allowedLocal(key))storage.setItem(key,value);
    const tx=db.transaction('meta','readwrite'),complete=done(tx);tx.objectStore('meta').delete('pendingPreferences');await complete;
  }finally{db.close();}}
  return {capture,exportData,validate,restore,applyPreferences,preferences};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameBackup;
