'use strict';
// A separate, shared-origin library: game and client pages use the same durable records.
const CharacterLibrary=(()=>{
  const schema=typeof module!=='undefined'&&module.exports?require('./game-database'):GameDatabase;
  const R=typeof module!=='undefined'&&module.exports?require('./character-records'):CharacterRecords;
  const sourceKey=s=>JSON.stringify([s.gameId,s.actorId]);
  const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
  function name(value){if(typeof value!=='string'||!value.trim()||value.trim().length>100)fail('INVALID_NAME','名称需要 1～100 个字符');return value.trim();}
  function defaultName(character,at=new Date()){
    const pad=n=>String(n).padStart(2,'0');
    return String(character||'角色').slice(0,65)+' '+at.getFullYear()+'-'+pad(at.getMonth()+1)+'-'+pad(at.getDate())+' '+pad(at.getHours())+':'+pad(at.getMinutes())+':'+pad(at.getSeconds());
  }
  function changes(before,after,path=''){
    if(JSON.stringify(before)===JSON.stringify(after))return [];
    if(before&&after&&typeof before==='object'&&typeof after==='object')return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key=>changes(before[key],after[key],path+(path?' / ':'')+key));
    return [{path:path||'内容',kind:before===undefined?'新增':after===undefined?'移除':'修改',before,after}];
  }
  function create(factory=globalThis.indexedDB){
    let opening;
    function open(){
      if(!factory)return Promise.reject(Error('浏览器未提供持久存储，无法铭刻角色'));
      return opening||(opening=new Promise((resolve,reject)=>{
        const request=factory.open(schema.NAME,schema.VERSION);
        request.onupgradeneeded=()=>schema.upgrade(request.result);
        request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
        request.onerror=()=>{opening=null;reject(request.error);};
        request.onblocked=()=>{opening=null;reject(Error('角色库正在其他页面升级，请关闭旧页面后重试'));};
      }));
    }
    const read=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    async function transaction(mode,run){
      const db=await open(),tx=db.transaction(['characters','receipts','meta'],mode);
      const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('角色保存未完成'));tx.onerror=()=>{};});
      try{const value=await run(tx.objectStore('characters'),tx.objectStore('receipts'),tx.objectStore('meta'));if(mode==='readwrite')tx.objectStore('meta').put(crypto.randomUUID(),'revision');await done;return value;}
      catch(error){try{tx.abort();}catch(_){}await done.catch(()=>{});throw error;}
    }
    return {
      state:()=>transaction('readonly',async(c,r,m)=>({characters:(await read(c.getAll())).sort((a,b)=>b.updatedAt-a.updatedAt),receipts:await read(r.getAll()),unlocked:!!await read(m.get('unlocked')),warehouse:await read(m.get('warehouse'))||[],revision:await read(m.get('revision'))||null})),
      save:({name:label,snapshot,expected=null})=>transaction('readwrite',async(c,r,m)=>{
        label=name(label);
        if(!snapshot?.gameId||!snapshot.actorId||!snapshot.imprintId||!snapshot.info||!Array.isArray(snapshot.items))fail('INVALID_SNAPSHOT','角色快照不完整');
        const key=sourceKey(snapshot);
        if(await read(r.get(key)))fail('ALREADY_IMPRINTED','这个存档的角色已经铭刻过');
        const old=await read(c.index('name').get(label));
        if(expected?old?.id!==expected.id||old?.revision!==expected.revision:!!old)fail('NAME_CONFLICT','同名角色已变化，请重新查看差异并确认');
        const now=Date.now(),entry={id:old?.id||crypto.randomUUID(),name:label,revision:crypto.randomUUID(),category:R.unavailable(snapshot.raw?.info||snapshot.info)?'unavailable':'available',createdAt:old?.createdAt||now,updatedAt:now,snapshot:structuredClone(snapshot)};
        c.put(entry);r.add({sourceKey:key,imprintId:snapshot.imprintId,characterId:entry.id});m.put(true,'unlocked');return entry;
      }),
      rename:(id,label,revision)=>transaction('readwrite',async c=>{
        label=name(label);const entry=await read(c.get(id));if(!entry||entry.revision!==revision)fail('STALE_CHARACTER','角色已在其他页面变更，请刷新后重试');
        const conflict=await read(c.index('name').get(label));if(conflict&&conflict.id!==id)fail('NAME_CONFLICT','已有同名角色，请换一个名称');
        c.put({...entry,name:label,revision:crypto.randomUUID(),updatedAt:Date.now()});
      }),
      remove:(id,revision)=>transaction('readwrite',async c=>{const entry=await read(c.get(id));if(!entry||entry.revision!==revision)fail('STALE_CHARACTER','角色已在其他页面变更，请刷新后重试');c.delete(id);}),
      category:(id,category,revision)=>transaction('readwrite',async c=>{
        const entry=await read(c.get(id));if(!entry||entry.revision!==revision)fail('STALE_CHARACTER','角色已变化，请刷新后重试');
        if(!['available','retired'].includes(category)||R.category(entry)==='unavailable')fail('UNAVAILABLE','不可用角色无法重新出山');
        c.put({...entry,category,revision:crypto.randomUUID(),updatedAt:Date.now()});
      }),
      transfer:({characterId,characterRevision,libraryRevision,direction,itemIndex,itemId})=>transaction('readwrite',async(c,r,m)=>{
        const entry=await read(c.get(characterId));if(!entry||entry.revision!==characterRevision||libraryRevision!==(await read(m.get('revision'))||null))fail('STALE_CHARACTER','仓库已变化，请刷新后重试');
        if(R.category(entry)!=='available')fail('UNAVAILABLE','只有可用角色能整理物品');
        const warehouse=await read(m.get('warehouse'))||[],items=entry.snapshot.raw.items,bag=entry.snapshot.raw.inventory;
        const inventory=Array.isArray(bag)?bag:bag?.物品||bag?.Items||bag?.items||bag?.背包||structuredClone(items);
        if(direction==='deposit'){
          if(!Number.isInteger(itemIndex)||itemIndex<0||itemIndex>=items.length)fail('INVALID_ITEM','物品不存在');
          const item=items.splice(itemIndex,1)[0],ref=inventory.splice(itemIndex,1)[0],files=entry.snapshot.raw.itemFiles?.splice(itemIndex,1)[0]||[];warehouse.push({id:crypto.randomUUID(),item,files,...typeof ref==='string'?{ref}:{}});
          const info=entry.snapshot.raw.info;for(const key of ['穿戴','Wearing'])if(info[key]&&typeof info[key]==='object')for(const [part,value]of Object.entries(info[key]))if(typeof ref==='string'&&(value===ref||typeof value==='string'&&value.includes('/'+ref+'/')))delete info[key][part];
        }else if(direction==='withdraw'){
          const index=warehouse.findIndex(i=>i.id===itemId);if(index<0)fail('INVALID_ITEM','物品已被取走');const stored=warehouse.splice(index,1)[0],ref='vault_'+crypto.randomUUID().replaceAll('-',''),replacements=R.itemReferences(stored.ref,ref);entry.snapshot.raw.itemFiles||=items.map(()=>[]);entry.snapshot.raw.itemFiles.push((stored.files||[]).map(file=>R.rewriteFile(file,replacements)));items.push(R.rewrite(stored.item,replacements));inventory.push(ref);
        }else fail('INVALID_ACTION','无效转移方向');
        entry.snapshot.raw.inventory=inventory;entry.snapshot=R.refresh(entry.snapshot);entry.snapshot.raw.metadata=R.metadata(entry.snapshot.raw.metadata);entry.updatedAt=Date.now();entry.revision=crypto.randomUUID();
        c.put(entry);m.put(warehouse,'warehouse');
      })
    };
  }
  function validateBackup(value){
    if(!value||value.format!=='trpg-character-vault'||value.version!==1||!Array.isArray(value.characters)||!Array.isArray(value.warehouse)||!Array.isArray(value.receipts)||value.characters.length>5000||value.warehouse.length>20000)throw Error('这不是有效的角色与物品仓库备份');
    const text=JSON.stringify(value);if(text.length>64*1024*1024)throw Error('仓库备份过大');JSON.parse(text,(key,v)=>{if(['__proto__','constructor','prototype'].includes(key))throw Error('仓库备份含不安全字段');return v;});
    const ids=new Set(),names=new Set();for(const entry of value.characters){if(typeof entry.id!=='string'||!entry.id||ids.has(entry.id)||names.has(name(entry.name)))throw Error('角色编号或名称重复');ids.add(entry.id);names.add(entry.name);entry.snapshot=R.validate(entry.snapshot);entry.category=R.category(entry);}
    const itemIds=new Set();for(const entry of value.warehouse){if(!entry||typeof entry.id!=='string'||!entry.id||itemIds.has(entry.id)||entry.item===undefined)throw Error('仓库物品编号无效');itemIds.add(entry.id);}
    for(const receipt of value.receipts)if(!receipt||typeof receipt.sourceKey!=='string'||typeof receipt.imprintId!=='string')throw Error('铭刻记录无效');
    return structuredClone(value);
  }
  return {create,sourceKey,name,defaultName,changes,validateBackup};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=CharacterLibrary;
