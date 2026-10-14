'use strict';
// File access is injected: Node CLI and the browser VFS share these exact rules.
const WorldStructureValidator = { create({ fs, path, schema: S, referencePrefix = '', onIssue = () => {} }) {
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
  const root = path.resolve(world), errors = [], reported = new Set();
  const report = (message, file = root) => {
    if (reported.has(message)) return;
    reported.add(message);
    errors.push(message); onIssue({ message, path: file });
  };
  if (!kind(root,true)) { report(`[根目录错误] ${root} 不存在或不是目录`); return errors; }
  const rel = file => path.relative(root,file).split(path.sep).join('/');
  const need = (file, dir=false) => { if(kind(file,dir)) return true; report(`[${dir?'目录':'文件'}缺失] ${rel(file)}`, file); return false; };
  const parsed = new Map();
  for (const file of walk(root).filter(f=>/\.json$/i.test(f))) {
    try { parsed.set(file, readJSON(file)); } catch(e) { report(`[JSON格式错误] ${rel(file)}: ${e.message}`, file); }
  }
  // These files are optional; legacy opening samples never activate local round one.
  for(const name of ['开局内部说明.md','预设第一回合.md']){
    const file=path.join(root,name);
    if(kind(file)){const text=fs.readFileSync(file,'utf8');if(!text.trim()||text.length>120000)report(`[开局文件错误] ${name} 应为非空文本，最多 120000 字符`,file);}
    else if(kind(file,true))report(`[开局文件错误] ${name} 必须是文件`,file);
  }
  const openingConfig=path.join(root,'开局预读.json');
  if(kind(openingConfig,true))report('[开局预读错误] 开局预读.json 必须是文件',openingConfig);
  if(parsed.has(openingConfig)){
    const value=parsed.get(openingConfig);
    if(!object(value)||value.version!==1||!Array.isArray(value.files)||value.files.length>100)report('[开局预读错误] 需要 version: 1 和 files 路径数组（最多 100 个）',openingConfig);
    else for(const raw of value.files){
      const clean=typeof raw==='string'?raw.replace(/^\/?workspace\//,''):'';
      if(typeof raw!=='string'||!raw.trim()||raw!==raw.trim()||/[\\:\u0000-\u001f?#]/.test(raw)||clean.startsWith('/')||clean.split('/').some(p=>!p||['.','..','__proto__','prototype','constructor'].includes(p))){report(`[开局预读错误] 非法文件路径：${JSON.stringify(raw)}`,openingConfig);continue;}
      const target=path.join(root,clean);
      if(!kind(target))report(`[开局预读错误] 文件不存在：${raw}`,openingConfig);
      else {const actual=path.relative(fs.realpathSync(root),fs.realpathSync(target));if(actual.startsWith('..')||path.isAbsolute(actual))report(`[开局预读错误] 文件超出世界目录：${raw}`,openingConfig);}
    }
  }
  function json(file, type) {
    if (!need(file) || !parsed.has(file)) return undefined;
    const data = parsed.get(file);
    if (type === 'object' ? !object(data) : type === 'array' ? !Array.isArray(data) : false) {
      report(`[JSON结构错误] ${rel(file)} 应为 ${type}`, file); return undefined;
    }
    return data;
  }
  function fields(data,schema,context,file) {
    for(const [field,aliases] of Object.entries(schema)) if(get(data,aliases)===undefined) report(`[字段缺失] ${context}: ${field}`, file);
  }
  function reference(value,index) {
    let clean=value.replace(/\\/g,'/');
    if (referencePrefix && clean.startsWith(referencePrefix+'/')) clean=clean.slice(referencePrefix.length+1);
    clean=clean.replace(/^\/?workspace\//,'').replace(/\/$/,'');
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
    for(const value of values) if(typeof value!=='string'||!reference(value,index)) report(`[引用错误] ${rel(file)}: ${JSON.stringify(value)} 无法解析为 ${index} 内的资料文件`, file);
    return values;
  }
  const statusSchema={...S.STATUS_VARIANTS,...S.OPTIONAL_STATUS_VARIANTS};
  function stats(data,context,file) {
    const seen=new Map();
    for(const [group,aliases] of Object.entries({属性:S.CHARACTER_INFO_VARIANTS.属性,衍生属性:S.DERIVED_VARIANTS,状态:S.CHARACTER_INFO_VARIANTS.状态})) {
      const keys=Object.keys(data).filter(k=>aliases.some(a=>normalize(a)===normalize(k)));
      if(keys.length>1) report(`[重复分组] ${context}: ${keys.join(', ')}`, file);
      for(const key of keys) {
        if(!object(data[key])) {report(`[格式错误] ${context}/${key} 应为对象`, file);continue;}
        for(const [name,value] of Object.entries(data[key])) {
          if(name.startsWith('.')) continue;
          const stateField=Object.keys(statusSchema).find(f=>statusSchema[f].some(a=>normalize(a)===normalize(name)));
          const canonical=stateField||normalize(name);
          if(stateField&&group!=='状态') report(`[数值归属] ${context}/${key}/${name}: ${stateField} 只能保存在状态中`, file);
          if(value===null||typeof value!=='object') {
            if(seen.has(canonical)) report(`[重复数值] ${context}: ${seen.get(canonical)} 与 ${key}/${name}`, file);
            seen.set(canonical,`${key}/${name}`);
          }
        }
      }
    }
    fields(get(data,S.CHARACTER_INFO_VARIANTS.状态)||{},S.STATUS_VARIANTS,context+'/状态',file);
  }
  const locations=new Map();
  const owner=value=>String(value).trim().replace(/\\/g,'/').replace(/^\/?workspace\//,'').replace(/\/$/,'').toLowerCase().replace(/^(player|aipc|disable|kpc|npc)-/,'');
  function locate(value,owners,context,file) {
    const target=typeof value==='string'?reference(value,'存档-索引-物品'):null;
    if(!target) {report(`[引用错误] ${context}: 物品 ${JSON.stringify(value)} 不存在`,file);return;}
    if(!locations.has(target)) locations.set(target,new Set());
    owners.forEach(o=>locations.get(target).add(owner(o)));
  }
  function character(dir) {
    for(const name of ['关系记忆.json','格式化记忆.json','日志.txt','关系图.json']) need(path.join(dir,name));
    if(!['.json','.txt',''].some(ext=>kind(path.join(dir,'待办与目标'+ext)))) report(`[文件缺失] ${rel(dir)}/待办与目标 (json/txt)`,path.join(dir,'待办与目标.json'));
    const bag=path.join(dir,'背包.json');
    list(bag,'存档-索引-物品').forEach(value=>locate(value,[path.basename(dir),rel(dir),rel(bag)],rel(bag),bag));
    const file=path.join(dir,'基础信息.json'),data=json(file,'object');
    if(!data) return;
    fields(data,S.CHARACTER_INFO_VARIANTS,rel(file),file);stats(data,rel(file),file);
    const name=get(data,S.CHARACTER_INFO_VARIANTS.姓名);
    if(typeof name==='string'&&/[<>:"/\\|?*.]/.test(name)) report(`[非法名称] ${rel(file)}: ${name}`,file);
    for(const key of Object.keys(data)) if(S.FORBIDDEN_CHARACTER_INFO_KEYS.some(a=>normalize(a)===normalize(key))) report(`[非法字段] ${rel(file)}: ${key} 应移入背包文件`,file);
    for(const [field,schema] of [['buff栏',S.BUFF_VARIANTS],['主动技能',S.ACTIVE_SKILL_VARIANTS]]) {
      const values=get(data,S.CHARACTER_INFO_VARIANTS[field]);
      if(values===undefined) continue;
      if(!Array.isArray(values)) {report(`[列表格式] ${rel(file)}: ${field}`,file);continue;}
      values.forEach((v,i)=>{if(!object(v)) report(`[对象格式] ${rel(file)}/${field}/${i}`,file);else fields(v,schema,`${rel(file)}/${field}/${i}`,file);});
    }
    const attire=get(data,S.CHARACTER_INFO_VARIANTS.穿戴);
    if(attire!==undefined&&!object(attire)) report(`[穿戴格式] ${rel(file)} 应为对象`,file);
    else for(const [part,value] of Object.entries(attire||{})) {
      if(['身体','全身','全体','整体','衣物','衣着','穿着','穿戴'].includes(part)) report(`[穿戴部位] ${rel(file)}: ${part} 过于笼统`,file);
      locate(value,[path.basename(dir),rel(dir),rel(file)],rel(file),file);
    }
  }
  need(path.join(root,'模组.md'));
  for(const name of ['开场说明.md','开场白.md','样例开场.md']) if(kind(path.join(root,name))&&[...fs.readFileSync(path.join(root,name),'utf8').trim()].length<100) report(`[内容过短] ${name} 至少需 100 字符`,path.join(root,name));
  for(const name of ['剧情线与进度','世界状态和世界规则','存档-索引-NPC','存档-索引-物品','存档-世界','存档-旧']) need(path.join(root,name),true);
  need(path.join(root,'剧情线与进度/主线剧情.md'));
  for(const dir of children(path.join(root,'剧情线与进度'))) for(const name of ['剧情.md','目标.json','进度.json']) need(path.join(dir,name));
  for(const name of ['世界规则.md','掷骰规则.md','检定与触发器索引.md']) need(path.join(root,'世界状态和世界规则',name));
  const consensus=json(path.join(root,'世界状态和世界规则/世界共识.json'),'object');
  if(consensus) fields(consensus,{世界时间:['世界时间','WorldTime']},'世界共识',path.join(root,'世界状态和世界规则/世界共识.json'));
  const roles=children(root).filter(p=>/^(Player|AIPC|DISABLE|KPC)-/.test(path.basename(p)));
  const players=roles.filter(p=>!path.basename(p).startsWith('KPC-')),ids=new Set();
  if(!players.length) report('[玩家数量错误] 至少需要一个 Player-/AIPC-/DISABLE- 可选角色槽位');
  for(const dir of roles){
    const name=path.basename(dir),id=name.slice(name.indexOf('-')+1);
    if(!id.trim()||id!==id.trim()) report('[玩家ID错误] 角色目录后必须有非空且无首尾空白的 ID',dir);
    if(name.startsWith('KPC-'))continue;
    if(ids.has(id))report('[角色ID冲突] Player/AIPC/DISABLE 不可使用相同 ID：'+id,dir);
    ids.add(id);
  }
  [...roles,...children(path.join(root,'存档-索引-NPC'))].forEach(character);
  need(path.join(root,'存档-世界/世界日志.txt'));
  for(const file of parsed.keys()) if(rel(file).startsWith('存档-世界/')&&path.basename(file)==='场景信息.json') {
    const dir=path.dirname(file);json(file,'object');
    for(const name of ['场景日志.txt','场景台本.json']) need(path.join(dir,name));
    list(path.join(dir,'NPC列表.json'),'存档-索引-NPC');
    const listFile=path.join(dir,'场景物品列表.json');
    list(listFile,'存档-索引-物品').forEach(v=>locate(v,[path.basename(dir),rel(dir),rel(dir).replace(/^存档-世界\//,''),rel(listFile)],rel(listFile),listFile));
  }
  for(const dir of children(path.join(root,'存档-索引-物品'))) {
    need(path.join(dir,'物品日志.txt'));
    const file=path.join(dir,'物品基础信息.json'),data=json(file,'object');
    if(!data) continue;
    fields(data,{名称:['名称','Name'],信息:['信息','Description','Info'],位置所属:['位置所属','Location','Owner'],可见性:['可见性','Visibility'],余量:['余量','Amount'],Action字典:['Action字典','Actions','ActionList']},rel(file),file);
    const value=get(data,['位置所属','Location','Owner']);
    if(value==null||['','none','null','无','未知','unknown','undefined'].includes(owner(value))) continue;
    const allowed=locations.get(file);
    if(!allowed?.size) report(`[不可访问物品] ${rel(file)}: ${value}`,file);
    else if(!allowed.has(owner(value))) report(`[位置不一致] ${rel(file)}: ${value} 与 ${[...allowed].join(', ')} 不匹配`,file);
  }
  return [...new Set(errors)];
}
return { validateStructure };
} };

if (typeof module !== 'undefined' && module.exports) {
const { validateStructure } = WorldStructureValidator.create({
  fs: require('node:fs'), path: require('node:path'), schema: require('./world-schema.json'),
});
function runCLI(args=process.argv.slice(2)) {
  if(args.length===1&&['--help','-h'].includes(args[0])) {console.log('node validate_game_structure.js [世界目录]\n省略目录时检查工作目录；相对路径按工作目录解析。');return 0;}
  if(args.length>1||args.some(a=>a.startsWith('-'))) {console.error('用法：node validate_game_structure.js [世界目录]');return 2;}
  try {
    const errors=validateStructure(args[0]||'.');
    console.log(errors.length?'❌ 目录结构校验未通过：\n'+errors.join('\n'):'✅ 目录结构校验通过。仍需完成剧情与内容自查。');
    return errors.length?1:0;
  } catch(error) {console.error('验证无法完成：'+error.message);return 1;}
}
module.exports={...WorldStructureValidator,validateStructure,runCLI};
if(require.main===module) process.exitCode=runCLI();

}
