'use strict';
const fs = require('node:fs');
const path = require('node:path');
const S = require('./world-schema.json');
const normalize = value => String(value).replace(/[_\s-]/g, '').toLowerCase();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = (value, aliases) => aliases.find(k => Object.hasOwn(value, k)) ?? Object.keys(value).find(k => aliases.some(a => normalize(a) === normalize(k)));
const get = (value, aliases) => object(value) ? value[keyOf(value, aliases)] : undefined;
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const kind = (file, dir = false) => { try { const stat = fs.lstatSync(file); return dir ? stat.isDirectory() : stat.isFile(); } catch { return false; } };
const children = dir => kind(dir, true) ? fs.readdirSync(dir, {withFileTypes:true}).filter(e => e.isDirectory()).map(e => path.join(dir, e.name)) : [];
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : e.isFile() ? [path.join(dir,e.name)] : []);
}
function validateStructure(world) {
  const root = path.resolve(world), errors = [];
  if (!kind(root,true)) return [`[根目录错误] ${root} 不存在或不是目录`];
  const rel = file => path.relative(root,file).split(path.sep).join('/');
  const need = (file, dir=false) => { if(kind(file,dir)) return true; errors.push(`[${dir?'目录':'文件'}缺失] ${rel(file)}`); return false; };
  const parsed = new Map();
  for (const file of walk(root).filter(f=>/\.json$/i.test(f))) {
    try { parsed.set(file, readJSON(file)); } catch(e) { errors.push(`[JSON格式错误] ${rel(file)}: ${e.message}`); }
  }
  function json(file, type) {
    if (!need(file) || !parsed.has(file)) return undefined;
    const data = parsed.get(file);
    if (type === 'object' ? !object(data) : type === 'array' ? !Array.isArray(data) : false) {
      errors.push(`[JSON结构错误] ${rel(file)} 应为 ${type}`); return undefined;
    }
    return data;
  }
  function fields(data,schema,context) {
    for(const [field,aliases] of Object.entries(schema)) if(get(data,aliases)===undefined) errors.push(`[字段缺失] ${context}: ${field}`);
  }
  function reference(value,index) {
    let clean=value.replace(/\\/g,'/').replace(/^\/?workspace\//,'').replace(/\/$/,'');
    if (/^\//.test(clean) || /:/.test(clean) || clean.split('/').includes('..')) return null;
    if (!clean.startsWith(index+'/')) clean=index+'/'+clean;
    let target=path.resolve(root,clean);
    if(kind(target,true)) target=path.join(target,index==='存档-索引-物品'?'物品基础信息.json':'基础信息.json');
    if(!kind(target)||path.extname(target)!=='.json') return null;
    const actual=fs.realpathSync(target),base=fs.realpathSync(path.join(root,index));
    const relative=path.relative(base,actual);
    return relative.startsWith('..')||path.isAbsolute(relative)?null:target;
  }
  function list(file,index) {
    const values=json(file,'array');
    if(!values) return [];
    for(const value of values) if(typeof value!=='string'||!reference(value,index)) errors.push(`[引用错误] ${rel(file)}: ${JSON.stringify(value)} 无法解析为 ${index} 内的资料文件`);
    return values;
  }
  const statusSchema={...S.STATUS_VARIANTS,...S.OPTIONAL_STATUS_VARIANTS};
  function stats(data,context) {
    const seen=new Map();
    for(const [group,aliases] of Object.entries({属性:S.CHARACTER_INFO_VARIANTS.属性,衍生属性:S.DERIVED_VARIANTS,状态:S.CHARACTER_INFO_VARIANTS.状态})) {
      const keys=Object.keys(data).filter(k=>aliases.some(a=>normalize(a)===normalize(k)));
      if(keys.length>1) errors.push(`[重复分组] ${context}: ${keys.join(', ')}`);
      for(const key of keys) {
        if(!object(data[key])) {errors.push(`[格式错误] ${context}/${key} 应为对象`);continue;}
        for(const [name,value] of Object.entries(data[key])) {
          if(name.startsWith('.')) continue;
          const stateField=Object.keys(statusSchema).find(f=>statusSchema[f].some(a=>normalize(a)===normalize(name)));
          const canonical=stateField||normalize(name);
          if(stateField&&group!=='状态') errors.push(`[数值归属] ${context}/${key}/${name}: ${stateField} 只能保存在状态中`);
          if(value===null||typeof value!=='object') {
            if(seen.has(canonical)) errors.push(`[重复数值] ${context}: ${seen.get(canonical)} 与 ${key}/${name}`);
            seen.set(canonical,`${key}/${name}`);
          }
        }
      }
    }
    fields(get(data,S.CHARACTER_INFO_VARIANTS.状态)||{},S.STATUS_VARIANTS,context+'/状态');
  }
  const locations=new Map();
  const owner=value=>String(value).trim().replace(/\\/g,'/').replace(/^\/?workspace\//,'').replace(/\/$/,'').toLowerCase().replace(/^(player|kpc|npc)-/,'');
  function locate(value,owners,context) {
    const target=typeof value==='string'?reference(value,'存档-索引-物品'):null;
    if(!target) {errors.push(`[引用错误] ${context}: 物品 ${JSON.stringify(value)} 不存在`);return;}
    if(!locations.has(target)) locations.set(target,new Set());
    owners.forEach(o=>locations.get(target).add(owner(o)));
  }
  function character(dir) {
    for(const name of ['关系记忆.json','格式化记忆.json','日志.txt','关系图.json']) need(path.join(dir,name));
    if(!['.json','.txt',''].some(ext=>kind(path.join(dir,'待办与目标'+ext)))) errors.push(`[文件缺失] ${rel(dir)}/待办与目标 (json/txt)`);
    const bag=path.join(dir,'背包.json');
    list(bag,'存档-索引-物品').forEach(value=>locate(value,[path.basename(dir),rel(dir),rel(bag)],rel(bag)));
    const file=path.join(dir,'基础信息.json'),data=json(file,'object');
    if(!data) return;
    fields(data,S.CHARACTER_INFO_VARIANTS,rel(file));stats(data,rel(file));
    const name=get(data,S.CHARACTER_INFO_VARIANTS.姓名);
    if(typeof name==='string'&&/[<>:"/\\|?*.]/.test(name)) errors.push(`[非法名称] ${rel(file)}: ${name}`);
    for(const key of Object.keys(data)) if(S.FORBIDDEN_CHARACTER_INFO_KEYS.some(a=>normalize(a)===normalize(key))) errors.push(`[非法字段] ${rel(file)}: ${key} 应移入背包文件`);
    for(const [field,schema] of [['buff栏',S.BUFF_VARIANTS],['主动技能',S.ACTIVE_SKILL_VARIANTS]]) {
      const values=get(data,S.CHARACTER_INFO_VARIANTS[field]);
      if(values===undefined) continue;
      if(!Array.isArray(values)) {errors.push(`[列表格式] ${rel(file)}: ${field}`);continue;}
      values.forEach((v,i)=>{if(!object(v)) errors.push(`[对象格式] ${rel(file)}/${field}/${i}`);else fields(v,schema,`${rel(file)}/${field}/${i}`);});
    }
    const attire=get(data,S.CHARACTER_INFO_VARIANTS.穿戴);
    if(attire!==undefined&&!object(attire)) errors.push(`[穿戴格式] ${rel(file)} 应为对象`);
    else for(const [part,value] of Object.entries(attire||{})) {
      if(['身体','全身','全体','整体','衣物','衣着','穿着','穿戴'].includes(part)) errors.push(`[穿戴部位] ${rel(file)}: ${part} 过于笼统`);
      locate(value,[path.basename(dir),rel(dir),rel(file)],rel(file));
    }
  }
  for(const name of ['模组.md','开场白.md','样例开场.md']) need(path.join(root,name));
  for(const name of ['开场白.md','样例开场.md']) if(kind(path.join(root,name))&&[...fs.readFileSync(path.join(root,name),'utf8').trim()].length<100) errors.push(`[内容过短] ${name} 至少需 100 字符`);
  if(kind(path.join(root,'故事.txt'))) need(path.join(root,'开场剧情.txt'));
  for(const name of ['剧情线与进度','世界状态和世界规则','存档-索引-NPC','存档-索引-物品','存档-世界','存档-旧']) need(path.join(root,name),true);
  need(path.join(root,'剧情线与进度/主线剧情.md'));
  for(const dir of children(path.join(root,'剧情线与进度'))) for(const name of ['剧情.md','目标.json','进度.json']) need(path.join(dir,name));
  for(const name of ['世界规则.md','掷骰规则.md','检定与触发器索引.md']) need(path.join(root,'世界状态和世界规则',name));
  const consensus=json(path.join(root,'世界状态和世界规则/世界共识.json'),'object');
  if(consensus) fields(consensus,{世界时间:['世界时间','WorldTime']},'世界共识');
  const players=children(root).filter(p=>path.basename(p).startsWith('Player-'));
  if(players.length!==1) errors.push(`[玩家数量错误] 必须且只能包含一个 Player-* 玩家目录，当前 ${players.length} 个`);
  if(players.some(p=>path.basename(p)==='Player-')) errors.push('[玩家ID错误] Player- 后必须有非空 ID');
  [...players,...children(root).filter(p=>path.basename(p).startsWith('KPC-')),...children(path.join(root,'存档-索引-NPC'))].forEach(character);
  need(path.join(root,'存档-世界/世界日志.txt'));
  for(const file of parsed.keys()) if(rel(file).startsWith('存档-世界/')&&path.basename(file)==='场景信息.json') {
    const dir=path.dirname(file);json(file,'object');
    for(const name of ['场景日志.txt','场景台本.json']) need(path.join(dir,name));
    list(path.join(dir,'NPC列表.json'),'存档-索引-NPC');
    const listFile=path.join(dir,'场景物品列表.json');
    list(listFile,'存档-索引-物品').forEach(v=>locate(v,[path.basename(dir),rel(dir),rel(dir).replace(/^存档-世界\//,''),rel(listFile)],rel(listFile)));
  }
  for(const dir of children(path.join(root,'存档-索引-物品'))) {
    need(path.join(dir,'物品日志.txt'));
    const file=path.join(dir,'物品基础信息.json'),data=json(file,'object');
    if(!data) continue;
    fields(data,{名称:['名称','Name'],信息:['信息','Description','Info'],位置所属:['位置所属','Location','Owner'],可见性:['可见性','Visibility'],余量:['余量','Amount'],Action字典:['Action字典','Actions','ActionList']},rel(file));
    const value=get(data,['位置所属','Location','Owner']);
    if(value==null||['','none','null','无','未知','unknown','undefined'].includes(owner(value))) continue;
    const allowed=locations.get(file);
    if(!allowed?.size) errors.push(`[不可访问物品] ${rel(file)}: ${value}`);
    else if(!allowed.has(owner(value))) errors.push(`[位置不一致] ${rel(file)}: ${value} 与 ${[...allowed].join(', ')} 不匹配`);
  }
  return [...new Set(errors)];
}
function runCLI(args=process.argv.slice(2)) {
  if(args.length===1&&['--help','-h'].includes(args[0])) {console.log('node validate_game_structure.js [世界目录]\n省略目录时检查工作目录；相对路径按工作目录解析。');return 0;}
  if(args.length>1||args.some(a=>a.startsWith('-'))) {console.error('用法：node validate_game_structure.js [世界目录]');return 2;}
  try {
    const errors=validateStructure(args[0]||'.');
    console.log(errors.length?'❌ 目录结构校验未通过：\n'+errors.join('\n'):'✅ 目录结构校验通过。仍需完成剧情与内容自查。');
    return errors.length?1:0;
  } catch(error) {console.error('验证无法完成：'+error.message);return 1;}
}
module.exports={validateStructure,runCLI};
if(require.main===module) process.exitCode=runCLI();
