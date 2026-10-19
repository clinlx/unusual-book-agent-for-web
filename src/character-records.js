'use strict';
const CharacterRecords=(()=>{
  const D=typeof module!=='undefined'&&module.exports?require('./game-data'):GameData;
  const META='.角色元数据.json';
  const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
  function unavailable(info){
    if(!D.actorState(info).alive)return '已死亡';
    for(const group of [D.get(info,'状态'),info]){const value=D.get(group,'Insane');if([true,1,'true','1'].includes(typeof value==='string'?value.trim().toLowerCase():value))return '已疯狂';}
    return '';
  }
  function metadata(raw={},moduleName,at=Date.now()){
    const base=object(raw)?structuredClone(raw):{};
    return {...base,version:1,updatedAt:at,modules:[...new Set([...(Array.isArray(base.modules)?base.modules.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()):[]),...(typeof moduleName==='string'&&moduleName.trim()?[moduleName.trim()]:[])])]};
  }
  function refresh(snapshot){
    const result=structuredClone(snapshot),raw=result.raw;
    if(!raw||!object(raw.info)||!Array.isArray(raw.items))throw Error('角色缺少完整数据');
    result.info=D.visible(raw.info);result.items=D.visible(raw.items,true);result.name=String(D.get(result.info,'姓名')||result.name||'角色');result.unavailableReason=unavailable(raw.info);
    return result;
  }
  function rewrite(value,replacements){
    if(typeof value==='string'){
      for(const [from,to]of [...replacements].sort((a,b)=>b[0].length-a[0].length))if(value===from||value.startsWith(from+'/'))return to+value.slice(from.length);
      return value;
    }
    return Array.isArray(value)?value.map(x=>rewrite(x,replacements)):object(value)?Object.fromEntries(Object.entries(value).map(([key,v])=>[rewrite(key,replacements),rewrite(v,replacements)])):value;
  }
  function rewriteFile(file,replacements){
    if(file.encoding==='base64')return {...file};
    let content=file.content;try{content=JSON.stringify(rewrite(JSON.parse(content),replacements),null,2);}catch(_){for(const [from,to]of [...replacements].sort((a,b)=>b[0].length-a[0].length))if(from.includes('/'))content=content.split(from).join(to);}
    return {...file,content};
  }
  function itemReferences(from,to){
    const pairs=new Map();if(typeof from!=='string')return pairs;
    pairs.set(from,to);const old=D.itemPath(from),next=D.itemPath(to);
    for(const prefix of ['','/workspace/']){pairs.set(prefix+old,prefix+next);if(old.endsWith('/物品基础信息.json'))pairs.set(prefix+old.replace(/\/[^/]+$/,''),prefix+next.replace(/\/[^/]+$/,''));}
    return pairs;
  }
  function validate(snapshot){
    if(!object(snapshot)||!object(snapshot.raw)||!object(snapshot.raw.info)||!Array.isArray(snapshot.raw.items)||snapshot.raw.items.length>5000)throw Error('角色数据格式无效');
    const encoded=JSON.stringify(snapshot);if(encoded.length>8*1024*1024)throw Error('角色数据过大');
    JSON.parse(encoded,(key,value)=>{if(['__proto__','constructor','prototype'].includes(key))throw Error('角色数据含不安全字段');return value;});
    if(snapshot.raw.itemFiles&&!Array.isArray(snapshot.raw.itemFiles)||snapshot.raw.files&&!Array.isArray(snapshot.raw.files))throw Error('角色附件格式无效');
    for(const file of [...snapshot.raw.files||[],...(snapshot.raw.itemFiles||[]).flat()]){if(!object(file)||typeof file.path!=='string'||file.path.startsWith('/')||/[\\:\u0000-\u001f]/.test(file.path)||file.path.split('/').some(p=>!p||p==='.'||p==='..')||typeof file.content!=='string'||file.encoding&& !['utf8','base64'].includes(file.encoding))throw Error('角色附件路径或内容无效');}
    return refresh(snapshot);
  }
  const category=entry=>unavailable(entry.snapshot.raw?.info||entry.snapshot.info)?'unavailable':entry.category==='retired'?'retired':'available';
  return {META,metadata,unavailable,refresh,validate,category,rewrite,rewriteFile,itemReferences};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=CharacterRecords;
