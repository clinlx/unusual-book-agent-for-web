'use strict';
const CharacterSnapshot=(()=>{
  const common=typeof module!=='undefined'&&module.exports;
  const D=common?require('./game-data'):GameData,V=common?require('./vfs'):VFS;
  const R=common?require('./character-records'):CharacterRecords;
  function restore(info){
    const result=structuredClone(info),groups=['状态','衍生属性','属性'].map(k=>D.get(result,k)).concat(result);
    for(const [current,maximum]of [['HP','MAXHP'],['MP','MAXMP']]){
      let max;for(const group of groups){const value=D.get(group,maximum);if(value!==undefined){max=typeof value==='number'||typeof value==='string'&&value.trim()?Number(value):NaN;break;}}
      if(!Number.isFinite(max)||max<0)continue;
      const aliases=new Set(D.aliases[current].map(D.normalize));
      for(const group of groups){if(!group||typeof group!=='object'||Array.isArray(group))continue;for(const key of Object.keys(group))if(aliases.has(D.normalize(key)))group[key]=typeof group[key]==='string'?String(max):max;}
    }
    return result;
  }
  function capture(save,slot){
    const Core=common?require('./game-core'):GameCore;
    // Restore only the copy; preserve raw fields and item definitions for future reuse.
    const info=restore(D.read(save,slot.path+'/基础信息.json')),inventory=structuredClone(D.read(save,slot.path+'/背包.json'));
    const tree=structuredClone(save.tree);V.writeFile(tree,slot.path+'/基础信息.json',JSON.stringify(info));
    const copied={...save,tree,playerPath:slot.path},visible=Core.player(copied),full=Core.player(copied,undefined,{includeHidden:true});
    let previous={};try{previous=D.read(save,slot.path+'/'+R.META);}catch(_){}
    const metadata=R.metadata(previous,save.moduleName||save.name,previous.updatedAt||0),files=[];
    function walk(node,path='',target=files){for(const [name,child]of Object.entries(node?.children||{})){const p=path+name;if(child.type==='dir')walk(child,p+'/',target);else if(!['基础信息.json','背包.json',R.META].includes(p)&&!/(?:^|\/)(?:日志|物品日志)\.txt$/.test(p))target.push({path:p,content:child.content,encoding:child.encoding||'utf8'});}}
    walk(D.node(save,slot.path));
    const list=Array.isArray(inventory)?inventory:inventory?.物品||inventory?.Items||inventory?.items||inventory?.背包||Object.values(inventory||{});
    const itemFiles=list.map(item=>{const files=[];if(typeof item==='string'&&D.itemPath(item).endsWith('/物品基础信息.json'))walk(D.node(save,D.itemPath(item).replace(/\/[^/]+$/,'')),'',files);return files;});
    return {gameId:save.id,actorId:slot.id,gameName:save.name,round:save.round,name:visible.name,info:visible.info,items:visible.items,unavailableReason:R.unavailable(info),raw:{info,inventory,items:full.items,itemFiles,metadata,files}};
  }
  function inject(save,slot,snapshot){
    const valid=R.validate(snapshot);if(valid.unavailableReason)throw Error('不可用的角色不能进入新故事');
    const next=structuredClone(save.tree),base=slot.path,old='/workspace/Player-'+snapshot.actorId;
    // References in a portable character must follow its new slot and item instances.
    const replacements=new Map([[old,base],[old.replace('/workspace/',''),base.replace('/workspace/','')]]);
    const itemIds=valid.raw.items.map((_,i)=>'铭刻_'+crypto.randomUUID().replaceAll('-','')+'_'+i);
    const bag=valid.raw.inventory,list=Array.isArray(bag)?bag:bag?.物品||bag?.Items||bag?.items||bag?.背包||Object.values(bag||{});
    for(let i=0;i<list.length;i++)if(itemIds[i])for(const [from,to]of R.itemReferences(list[i],itemIds[i]))replacements.set(from,to);
    const rewrite=x=>R.rewrite(x,replacements);
    const write=(path,file)=>{const nextFile=R.rewriteFile(file,replacements);V.writeFile(next,path,nextFile.content,{encoding:nextFile.encoding});};
    D.node({tree:next},base).children={};
    for(const file of valid.raw.files||[])write(base+'/'+file.path,file);
    V.writeFile(next,base+'/基础信息.json',JSON.stringify(rewrite(valid.raw.info),null,2));
    valid.raw.items.forEach((item,i)=>{const path='/workspace/'+D.itemPath(itemIds[i]);for(const file of valid.raw.itemFiles?.[i]||[])write(path.replace(/\/[^/]+$/,'/')+file.path,file);V.writeFile(next,path,JSON.stringify(rewrite(item),null,2));});
    V.writeFile(next,base+'/背包.json',JSON.stringify(itemIds,null,2));
    V.writeFile(next,base+'/'+R.META,JSON.stringify(R.metadata(valid.raw.metadata),null,2));
    save.tree=next;
  }
  return {restore,capture,inject};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=CharacterSnapshot;
