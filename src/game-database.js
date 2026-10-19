'use strict';
// One database allows site restores and character/item transfers to commit atomically.
const GameDatabase=(()=>{
  const NAME='trpg-single-player',VERSION=2;
  function upgrade(db){
    for(const name of ['saves','config'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});
    for(const name of ['messages','events'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:['saveId','seq']}).createIndex('saveId','saveId');
    if(!db.objectStoreNames.contains('characters'))db.createObjectStore('characters',{keyPath:'id'}).createIndex('name','name',{unique:true});
    if(!db.objectStoreNames.contains('receipts'))db.createObjectStore('receipts',{keyPath:'sourceKey'});
    if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta');
  }
  function open(factory=globalThis.indexedDB){return new Promise((resolve,reject)=>{
    if(!factory)return reject(Error('浏览器未提供持久存储'));
    const r=factory.open(NAME,VERSION);r.onupgradeneeded=()=>upgrade(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('数据库升级被旧页面占用，请关闭其他游玩页面后重试'));r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};
  });}
  return {NAME,VERSION,upgrade,open};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameDatabase;
