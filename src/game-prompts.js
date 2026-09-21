'use strict';
const Prompts = (() => {
  const titles = Object.freeze({
  "system/host.md": "主持人系统规则",
  "system/runtime.md": "网页运行与工具协议",
  "flow/start_game.md": "首次开局",
  "flow/next_round.md": "每轮推进",
  "system/round.md": "回合流程与状态缓存",
  "reference/游戏前准备.md": "游戏前准备",
  "reference/游戏结束.md": "游戏结束",
  "reference/游戏循环.md": "游戏循环索引",
  "reference/游戏目录树属性规则.md": "世界目录与字段说明",
  "reference/安全性-A.md": "危险节奏 A",
  "reference/安全性-B.md": "危险节奏 B",
  "reference/安全性-C.md": "危险节奏 C",
  "reference/安全性-D.md": "危险节奏 D",
  "flow/tools.json": "工具说明",
  "flow/after_story.md": "正文发布后自查",
  "flow/need_end.md": "结束回合提醒",
  "flow/no_story.md": "尚未发布正文提醒",
  "flow/need_trigger.md": "获取玩家行动提醒",
  "flow/recall.md": "开局后规则回顾",
  "flow/resume.md": "中断恢复提醒",
  "flow/cache.md": "状态缓存说明",
  "flow/summaries.md": "裁剪摘要说明"
});
  const aliases = Object.freeze({
  "system.md": "system/host.md",
  "runtime.md": "system/runtime.md",
  "Prompt/Temp/回合提示词.md": "system/round.md",
  "start_game.md": "flow/start_game.md",
  "next_round.md": "flow/next_round.md",
  "tools.json": "flow/tools.json",
  "游戏目录树属性规则.md": "reference/游戏目录树属性规则.md",
  "reference/游戏前准备.md": "reference/游戏前准备.md",
  "reference/游戏循环.md": "reference/游戏循环.md",
  "reference/游戏结束.md": "reference/游戏结束.md",
  "Prompt/KeyWords/安全性-A.md": "reference/安全性-A.md",
  "Prompt/KeyWords/安全性-B.md": "reference/安全性-B.md",
  "Prompt/KeyWords/安全性-C.md": "reference/安全性-C.md",
    "Prompt/KeyWords/安全性-D.md": "reference/安全性-D.md"
});

  const groups={system:'固定系统提示词',flow:'流程自动注入',reference:'按需参考文件'};
  const own=(o,k)=>o!=null&&Object.hasOwn(o,k);
  const canonical=id=>aliases[id]||id;
  function migrateText(text){
    const replacements=[];
    for(const [old,id] of Object.entries(aliases))if(id.startsWith('reference/')){
      const to='/.reference/'+id.slice(10);
      replacements.push(['/prompts/'+old,to]);
      if(old.includes('/'))replacements.push([old,to]);
    }
    replacements.push(['/prompts/Prompt/KeyWords/安全性-*.md','/.reference/安全性-*.md'],['/prompts/Prompt/Temp/回合提示词.md','系统提示词中的回合协议']);
    const dict=new Map(replacements),escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    
    const keys=[...dict.keys()].sort((a,b)=>b.length-a.length);
    const pattern=new RegExp('(?<![\\w./])(?:'+keys.map(escape).join('|')+')','g');
    text=String(text).replace(pattern,match=>dict.get(match));
    return text.replace(/\/prompts\b/g,'/.reference');
  }
  function migrateOverrides(input={}){
    const out={};
    for(const [id,value] of Object.entries(input)){
      if(id==='flows.json'){
        try{for(const [key,text]of Object.entries(JSON.parse(value))){const next='flow/'+key.replace(/^flow_/,'')+'.md';if(own(titles,next)&&typeof text==='string')out[next]=migrateText(text);}}catch(_){}
      }else if(own(titles,canonical(id))&&typeof value==='string')out[canonical(id)]=migrateText(value);
    }
    for(const [id,value]of Object.entries(input))if(own(titles,id)&&typeof value==='string')out[id]=migrateText(value);
    return out;
  }
  function create(sources={},ruleBooks={}){
    const defaults=Object.freeze(migrateOverrides(sources));
    const books=Object.create(null),bookRoot='/.reference/trpg_rule_books/';
    for(const [relative,content]of Object.entries(ruleBooks)){
      if(typeof content!=='string'||relative.includes('\\')||relative.split('/').some(x=>!x||x==='.'||x==='..'))continue;
      books[bookRoot+relative]=content;
    }
    if(Object.keys(books).length&&!own(books,bookRoot+'index.md')){
      const entries=[...new Set(Object.keys(books).map(p=>p.slice(bookRoot.length).split('/')[0]))].sort();
      books[bookRoot+'index.md']='# 内置规则书\n\n'+entries.map(name=>'- '+bookRoot+name).join('\n')+'\n\n用 tree 或 list_dir 查看所选规则体系的目录，再用 read_file 读取相关章节。';
    }
    function get(id,overrides={}){
      id=canonical(id);if(!own(titles,id))throw Error('未知提示词：'+id);
      const custom=own(overrides,id)?overrides[id]:migrateOverrides(overrides)[id];
      return typeof custom==='string'?migrateText(custom):defaults[id]||'';
    }
    function flows(overrides={}){return Object.fromEntries(Object.keys(titles).filter(id=>id.startsWith('flow/')&&!['flow/start_game.md','flow/next_round.md','flow/tools.json'].includes(id)).map(id=>['flow_'+id.slice(5,-3),get(id,overrides)]));}
    function file(fp,overrides={}){
      if(typeof fp!=='string')return undefined;
      fp=migrateText(fp);
      if(own(books,fp))return books[fp];
      if(!fp.startsWith('/.reference/'))return undefined;
      const id='reference/'+fp.slice('/.reference/'.length);
      return own(titles,id)?get(id,overrides):undefined;
    }
    return {create,get,flows,file,migrateText,migrateOverrides,
      list:()=>Object.entries(titles).map(([id,title])=>({id,title,group:id.split('/')[0],groupTitle:groups[id.split('/')[0]]})),
      referencePaths:()=>Object.keys(titles).filter(id=>id.startsWith('reference/')).map(id=>'/.reference/'+id.slice(10)).concat(Object.keys(books)),
      buildSystem:(overrides={},world='')=>['system/host.md','system/round.md','system/runtime.md'].map(id=>get(id,overrides)).concat(world).filter(Boolean).join('\n\n'),
      roundPrompt:(start,overrides={})=>get(start?'flow/start_game.md':'flow/next_round.md',overrides),
      toolDescription:(name,overrides={})=>{const custom=JSON.parse(get('flow/tools.json',overrides)||'{}'),base=JSON.parse(get('flow/tools.json')||'{}');return own(custom,name)?custom[name]:own(base,name)?base[name]:'';}
    };
  }
  return create(typeof BUNDLED_PROMPTS!=='undefined'?BUNDLED_PROMPTS:{},typeof BUNDLED_RULE_BOOKS!=='undefined'?BUNDLED_RULE_BOOKS:{});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=Prompts;
