'use strict';
const GameStore=(()=>{
  const core=typeof module!=='undefined'&&module.exports?require('./game-core.js'):GameCore;
  const lastRoundEnd=events=>events?.findLast(e=>e.type==='round_end')?.at??null;
  function create(factory=globalThis.indexedDB){
    let db=null,memory=!factory;const mem=new Map();let config={};
    const counts=new Map();
    async function open(){if(!factory)return;await new Promise((resolve,reject)=>{
      let req;try{req=factory.open('trpg-single-player',1);}catch(e){memory=true;resolve();return;}
      req.onupgradeneeded=()=>{const d=req.result;d.createObjectStore('saves',{keyPath:'id'});d.createObjectStore('config',{keyPath:'id'});
        for(const name of ['messages','events']){const os=d.createObjectStore(name,{keyPath:['saveId','seq']});os.createIndex('saveId','saveId');}};
      req.onsuccess=()=>{
        db=req.result;db.onversionchange=()=>db.close();
        
        
        const tx=db.transaction('saves','readwrite'),finish=done(tx),cursor=tx.objectStore('saves').openCursor();
        cursor.onsuccess=()=>{const item=cursor.result;if(!item)return;const save=item.value;if(core.pruneRollback(save))item.update(save);item.continue();};
        finish.then(resolve,reject);
      };
      req.onerror=()=>{memory=true;resolve();};req.onblocked=()=>reject(Error('存档数据库升级被其他页面占用，请关闭其他页面后重试'));
    });}
    const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('存档事务中断'));tx.onerror=()=>reject(tx.error);});
    async function putSave(save){
      core.pruneRollback(save);
      if(memory){mem.set(save.id,structuredClone({...save,lastRoundEndedAt:lastRoundEnd(save.events)}));return;}
      const {messages,events,...meta}=save;
      const tx=db.transaction(['saves','messages','events'],'readwrite');const finish=done(tx);
      tx.objectStore('saves').put({...meta,lastRoundEndedAt:lastRoundEnd(events)});
      const known=counts.get(save.id)||{messages:0,events:0};
      for(const [name,list]of Object.entries({messages,events})){
        const os=tx.objectStore(name),from=Math.min(known[name],list.length);
        
        if(list.length<known[name])os.delete(IDBKeyRange.bound([save.id,list.length],[save.id,Number.MAX_SAFE_INTEGER]));
        for(let i=from;i<list.length;i++)os.put({saveId:save.id,seq:i,value:list[i]});
      }
      await finish;counts.set(save.id,{messages:messages.length,events:events.length});
    }
    async function getSave(id){
      if(memory)return mem.has(id)?structuredClone(mem.get(id)):undefined;
      const tx=db.transaction(['saves','messages','events']);
      const [meta,messages,events]=await Promise.all([req(tx.objectStore('saves').get(id)),req(tx.objectStore('messages').index('saveId').getAll(id)),req(tx.objectStore('events').index('saveId').getAll(id))]);
      if(!meta)return;counts.set(id,{messages:messages.length,events:events.length});
      return {...meta,messages:messages.sort((a,b)=>a.seq-b.seq).map(r=>r.value),events:events.sort((a,b)=>a.seq-b.seq).map(r=>r.value)};
    }
    async function list(){const all=memory?[...mem.values()]:await req(db.transaction('saves').objectStore('saves').getAll());
      const summaries=await Promise.all(all.map(async s=>{
        const {id,name,round,status,createdAt,updatedAt,playerPath,cover}=s;
        let lastRoundEndedAt=s.lastRoundEndedAt;
        if(lastRoundEndedAt===undefined){
          const events=memory?s.events:(await req(db.transaction('events').objectStore('events').index('saveId').getAll(id))).sort((a,b)=>a.seq-b.seq).map(r=>r.value);
          lastRoundEndedAt=lastRoundEnd(events);
        }
        return {id,name,round,status,createdAt,updatedAt,playerPath,cover,lastRoundEndedAt,worldTime:s.cache?.Game_World_Time||s.summaries?.at(-1)?.worldTime||''};
      }));
      return summaries.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));}

    async function deleteSave(id){if(memory){mem.delete(id);return;}const tx=db.transaction(['saves','messages','events'],'readwrite');const finish=done(tx);tx.objectStore('saves').delete(id);
      for(const name of ['messages','events'])tx.objectStore(name).delete(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]));await finish;counts.delete(id);}
    async function getSettings(){return memory?structuredClone(config):(await req(db.transaction('config').objectStore('config').get('settings')))?.value||{};}
    async function putSettings(value){if(memory){config=structuredClone(value);return;}const tx=db.transaction('config','readwrite'),finish=done(tx);tx.objectStore('config').put({id:'settings',value});await finish;}
    return {open,putSave,getSave,list,deleteSave,getSettings,putSettings,get memoryMode(){return memory;}};
  }return {create};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameStore;
