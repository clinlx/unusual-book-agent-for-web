'use strict';
// File schemas and player-visible projections. This module never changes world files.
const GameData=(()=>{
  const V=typeof module!=='undefined'&&module.exports?require('./vfs.js'):VFS;
  const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const normalize=x=>String(x).replace(/[_\s-]/g,'').toLowerCase();
  const aliases={
    姓名:['姓名','名称','Name','昵称','Nickname'],性别:['性别','Gender','Sex'],外貌:['外貌','Appearance','Look'],
    穿戴:['穿戴','Wearing'],性格:['性格','Personality','Character'],职业:['职业','Occupation','Job'],身份:['身份','Identity','Role'],
    说话习惯:['说话习惯','SpeakingStyle','Tone'],原则:['原则','Principles'],
    '喜好/厌恶':['喜好/厌恶','Likes/Dislikes','likes_dislikes','Preferences','喜好','厌恶'],
    技能:['技能','Skill','Skills'],属性:['属性','Stats','Attributes'],衍生属性:['衍生属性','DerivedStats','DerivedAttributes'],
    主动技能:['主动技能','ActiveSkills'],状态:['状态','Status','CurrentState'],buff栏:['buff','Buff栏','Buffs','BuffList'],
    当前位置:['当前位置','所在位置','位置','Location','Pos'],
    HP:['HP','Health','生命值'],MAXHP:['MAXHP','MaxHealth','生命值上限','最大生命值'],
    MP:['MP','Mana','魔法值','魔力值'],MAXMP:['MAXMP','MaxMana','魔法值上限','最大魔法值','魔力值上限'],
    SAN:['SAN','Sanity','理智','理智值'],MAXSAN:['MAXSAN','MaxSanity','理智上限','理智值上限','最大理智值'],
    Enabled:['Enabled','Active'],Alive:['Alive','Living']
  };
  function get(o,keys){if(!object(o))return undefined;const names=Array.isArray(keys)?keys:aliases[keys]||[keys];for(const key of names)if(Object.hasOwn(o,key))return o[key];const wanted=new Set(names.map(normalize));const key=Object.keys(o).find(k=>wanted.has(normalize(k)));return key===undefined?undefined:o[key];}
  const hiddenKeys=new Set(['密码','password',...['喜好/厌恶','说话习惯','原则','当前位置'].flatMap(k=>aliases[k])].map(normalize));
  const itemKeys=new Set(['Action','Actions','Action字典','Actions字典','ActionList','触发器','Trigger','Triggers','剧情台本','StoryScript','台本','Script','脚本','场景台本','场景台本.json','发生权重','位置所属','Owner'].map(normalize));
  const hiddenFlag=x=>x===true||['隐藏','是','1','enable','true'].includes(String(x).trim().toLowerCase());
  function visible(x,items=false){
    if(Array.isArray(x))return x.filter(v=>!(object(v)&&hiddenFlag(v['.是否对玩家隐藏']))).map(v=>visible(v,items));
    if(!object(x))return x;
    const out={};for(const [k,v]of Object.entries(x))if(!k.startsWith('.')&&!hiddenKeys.has(normalize(k))&&!(items&&itemKeys.has(normalize(k))))out[k]=visible(v,items);return out;
  }
  function node(s,p){const parts=String(p).replace(/\\/g,'/').split('/').filter(Boolean);if(parts.includes('..'))return null;if(parts[0]!=='workspace')parts.unshift('workspace');return V.resolve(s.tree,parts);}
  function read(s,p){const n=node(s,p);if(!n||n.type!=='file'||n.encoding==='base64')throw Error(p+' 不是可读取的 JSON 文件');return JSON.parse(n.content.replace(/^\uFEFF/,''));}
  function itemPath(id){let p=String(id).replace(/\\/g,'/').replace(/^\/?workspace\//,'').replace(/\/$/,'');if(!p.startsWith('存档-索引-物品/'))p='存档-索引-物品/'+p;return p.endsWith('.json')?p:p+'/物品基础信息.json';}
  function timeValue(o){const v=get(o,['Game_World_Time','世界时间','WorldTime','world_time','GameTime','当前时间']);return typeof v==='string'||typeof v==='number'?String(v):'';}
  function consensusTime(s){try{return timeValue(read(s,'世界状态和世界规则/世界共识.json'));}catch(_){return '';}}
  function worldTime(s){const world=consensusTime(s),r=s.activeRound;if(r&&!r.complete&&r.initialWorldTime!==undefined&&world&&world!==r.initialWorldTime)return world;return timeValue(s.cache)||world;}
  function actorState(info){const groups=[get(info,'状态'),get(info,'属性'),get(info,'衍生属性'),info];const enabled=k=>{for(const g of groups){const v=get(g,k);if(v!==undefined)return ![false,0,'false','0'].includes(typeof v==='string'?v.toLowerCase().trim():v);}return true;};return {alive:enabled('Alive'),enabled:enabled('Enabled')};}
  function displayPaths(s,value){
    if(Array.isArray(value))return value.map(v=>displayPaths(s,v));
    if(object(value))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,displayPaths(s,v)]));
    if(typeof value!=='string')return value;
    const p=value.replace(/\\/g,'/').replace(/^\/?workspace\//,'');
    if(!/^(存档-索引-物品|存档-索引-NPC|存档-世界)\//.test(p))return value;
    const n=node(s,p);if(!n)return value;
    const file=n.type==='file'?p:p+'/'+(p.startsWith('存档-索引-物品/')?'物品基础信息.json':p.startsWith('存档-索引-NPC/')?'基础信息.json':'场景信息.json');
    try{const info=read(s,file);if(!hiddenFlag(info['.是否对玩家隐藏'])){const name=get(info,['名称','姓名','Name','name']);if(typeof name==='string'&&name.trim())return name;}}catch(_){}
    return n.type==='dir'?n.name:p.split('/').at(-2)||n.name;
  }
  function references(s,entries){const warnings=[];for(const entry of entries||[]){if(!object(entry))continue;const p=entry.所在文件,k=entry.剧情关键词||entry.事件关键词;if(typeof p!=='string'||!p.trim())continue;const n=node(s,p);if(!n){warnings.push('[引用错误] 文件或目录不存在: '+p);continue;}if(typeof k==='string'&&k.trim()){
      const contains=(n,depth=0)=>depth<=8&&(n.type==='file'?n.encoding!=='base64'&&n.content.includes(k):Object.values(n.children||{}).some(c=>contains(c,depth+1)));
      if(!contains(n))warnings.push('[关键词缺失] '+p+' 中不存在: '+k);
    }}return warnings;}
  function cacheWarnings(s,cache){if((s.activeRound?.number||s.round)<=3)return [];const required=['Game_World_Time','EraDate&LocalFestival&SeasonCustoms','Active_Scene','Next_Possible_Scene','Current_Story_Progress','Next_Story_Progress','Next_Possible_Relevant_Triggers_In_File','Triggers_Not_In_File','Story_Safety_State','In_Free_Exploration','Free_Exploration_Entry_Cond','Free_Exploration_Exit_Cond','Active_Flags','Global_Timers','NPC_Status_Snapshot'];
    const warnings=required.filter(k=>!Object.hasOwn(cache,k)).map(k=>'[缓存字段缺失] '+k);
    if(Array.isArray(cache.Next_Possible_Relevant_Triggers_In_File)&&!cache.Next_Possible_Relevant_Triggers_In_File.length)warnings.push('[缓存校验] Next_Possible_Relevant_Triggers_In_File 为空，请检查后续剧情引用');
    return warnings.concat(references(s,[cache.Current_Story_Progress,...Object.values(object(cache.Next_Story_Progress)?cache.Next_Story_Progress:{}),...(Array.isArray(cache.Next_Possible_Relevant_Triggers_In_File)?cache.Next_Possible_Relevant_Triggers_In_File:[])]));
  }
  function validate(s){
    const warnings=[];
    const need=(p,type='file')=>{const n=node(s,p);if(n?.type===type)return true;warnings.push('['+(type==='dir'?'目录':'文件')+'缺失] '+p);return false;};
    const json=(p,kind)=>{if(!need(p))return null;try{const x=read(s,p);if(kind==='object'&&!object(x)||kind==='array'&&!Array.isArray(x))throw Error('应为 '+kind);return x;}catch(e){warnings.push('[JSON格式错误] '+p+': '+e.message);return null;}};
    const fields=(o,schema,p)=>{for(const [label,keys]of Object.entries(schema))if(get(o,keys)===undefined)warnings.push('[字段缺失] '+p+': '+label);};
    const list=(p,index)=>{const xs=json(p,'array');if(!xs)return;for(const id of xs){if(typeof id!=='string'){warnings.push('[引用格式] '+p+' 应只保存索引 ID，内嵌资料仍可展示');continue;}const clean=id.replace(/\\/g,'/').replace(/^\/?workspace\//,'');const target=clean.startsWith(index+'/')?clean:index+'/'+clean;if(!node(s,target))warnings.push('[引用错误] '+p+': '+id+' 不存在于 '+index);}};
    const complex=(o,key,schema,p)=>{const xs=get(o,key);if(xs===undefined)return;if(!Array.isArray(xs)){warnings.push('[列表格式] '+p+': '+key);return;}xs.forEach((x,i)=>{if(!object(x))warnings.push('[对象格式] '+p+'/'+key+'/'+i);else fields(x,schema,p+'/'+key+'/'+i);});};
    const character=dir=>{
      for(const f of ['关系记忆.json','格式化记忆.json','日志.txt','关系图.json'])need(dir+'/'+f);
      if(!['.json','.txt',''].some(ext=>node(s,dir+'/待办与目标'+ext)?.type==='file'))warnings.push('[文件缺失] '+dir+'/待办与目标 (json/txt)');
      list(dir+'/背包.json','存档-索引-物品');const p=dir+'/基础信息.json',o=json(p,'object');if(!o)return;
      fields(o,Object.fromEntries(Object.entries(aliases).filter(([k])=>!['衍生属性','HP','MAXHP','MP','MAXMP','SAN','MAXSAN','Enabled','Alive'].includes(k))),p);
      const name=get(o,'姓名');if(typeof name==='string'&&/[<>:"/\\|?*.]/.test(name))warnings.push('[非法名称] '+p+': 姓名包含文件名禁用字符');
      for(const k of Object.keys(o))if(['背包','backpack','inventory','bag','items','itemlist'].includes(normalize(k)))warnings.push('[非法字段] '+p+': '+k+' 应移至背包文件');
      for(const k of ['HP','MAXHP','MP','MAXMP','Enabled','Alive'])if(!['状态','属性','衍生属性'].some(g=>get(get(o,g),k)!==undefined))warnings.push('[状态字段缺失] '+p+': '+k);
      complex(o,'buff栏',{名称:['名称','Name','BuffID'],描述:['描述','Desc','EffectText','description'],修正:['修正','Modifier','StatsMod'],剩余时间:['剩余时间','Duration','TurnsLeft'],'.隐藏效果':['.隐藏效果','.HiddenEffect'],'.当结束时':['.当结束时','.WhenEnd']},p);
      complex(o,'主动技能',{名称:['名称','SkillName','ActionID','Name','SkillID'],描述:['描述','FlavorText','Effect','description','Desc','EffectText'],修正:['修正','Modifier','CombatMod'],消耗:['消耗','Cost','Resources'],冷却:['冷却','Cooldown','CD'],当前冷却状态:['当前冷却状态','CooldownStatus'],范围:['范围','Range','Area'],前置条件:['前置条件','Requirements','Pre'],'.隐藏效果':['.隐藏效果','.HiddenEffect']},p);
      const attire=get(o,'穿戴');if(attire!==undefined&&!object(attire))warnings.push('[穿戴格式] '+p+' 应按部位保存物品引用');else if(attire){for(const [part,id]of Object.entries(attire)){if(['身体','全身','全体','整体','衣物','衣着','穿着','穿戴'].includes(part))warnings.push('[穿戴部位] '+p+': '+part+' 过于笼统');if(typeof id==='string'&&!node(s,itemPath(id)))warnings.push('[穿戴引用] '+p+': '+id+' 的物品资料不存在');}}
    };
    character(s.playerPath);
    if(need('剧情线与进度','dir')){need('剧情线与进度/主线剧情.md');for(const n of Object.values(node(s,'剧情线与进度').children))if(n.type==='dir')for(const f of ['剧情.md','目标.json','进度.json'])need('剧情线与进度/'+n.name+'/'+f);}
    if(need('世界状态和世界规则','dir')){need('世界状态和世界规则/世界规则.md');need('世界状态和世界规则/掷骰规则.md');const o=json('世界状态和世界规则/世界共识.json','object');if(o&&get(o,['世界时间','WorldTime'])===undefined)warnings.push('[字段缺失] 世界共识: 世界时间');}
    if(need('存档-索引-NPC','dir'))for(const n of Object.values(node(s,'存档-索引-NPC').children))if(n.type==='dir')character('存档-索引-NPC/'+n.name);
    if(need('存档-索引-物品','dir'))for(const n of Object.values(node(s,'存档-索引-物品').children))if(n.type==='dir'){const dir='存档-索引-物品/'+n.name;need(dir+'/物品日志.txt');const o=json(dir+'/物品基础信息.json','object');if(o)fields(o,{名称:['名称','Name'],信息:['信息','Description','Info'],位置所属:['位置所属','Location','Owner'],可见性:['可见性','Visibility'],余量:['余量','Amount'],Action字典:['Action字典','Actions','ActionList']},dir);}
    const scenes=(n,p)=>{if(node(s,p+'/场景信息.json')){json(p+'/场景信息.json','object');need(p+'/场景日志.txt');need(p+'/场景台本.json');list(p+'/NPC列表.json','存档-索引-NPC');list(p+'/场景物品列表.json','存档-索引-物品');}for(const c of Object.values(n.children||{}))if(c.type==='dir')scenes(c,p+'/'+c.name);};
    if(need('存档-世界','dir')){need('存档-世界/世界日志.txt');scenes(node(s,'存档-世界'),'存档-世界');}need('存档-旧','dir');return warnings;
  }
  return {aliases,get,normalize,visible,hiddenFlag,read,node,itemPath,worldTime,consensusTime,actorState,displayPaths,references,cacheWarnings,validate};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameData;
