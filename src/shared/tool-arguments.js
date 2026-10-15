'use strict';
const ToolArguments = (() => {
  const HINT = '工具参数格式异常，可能与模型输出或模型服务兼容性有关；也可能是响应传输、处理异常。';
  const NOTICE = HINT + '已隔离异常参数，正在尝试继续。若反复出现，请尝试更换模型或服务。';
  const PLACEHOLDER = '[历史参数异常] 此调用的参数无法解析为 JSON 对象，发送时已用 {} 占位；占位内容不代表真实参数。执行状态以原始回执为准，不要重复已成功的操作；失败的调用请重新生成合法参数。\n原始回执：\n';
  function parse(raw) {
    try {
      if (typeof raw !== 'string') throw new Error('参数必须是 JSON 字符串');
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象');
      return value;
    } catch (error) {
      error.code = 'INVALID_TOOL_ARGUMENTS';
      throw error;
    }
  }
  // Validate file-tool inputs before resolving paths; omission is not an empty value.
  const fileRequired = {
    read_file:['path'], read_multiple_files:['paths'], list_dir:['path'], tree:['path'], search:['pattern'],
    write_file:['path','content'], append_file:['path','content'], apply_patch:['path','old_str','new_str'],
    mkdir:['path'], delete:['path'], move:['from','to'], copy:['from','to'],
    view_image:['path'], parse_document:['path','format','output'], validate_game_structure:['path'],
    parse_tavern_card:['path'],
  };
  const pathSchema = {type:'string',minLength:1,pattern:'\\S',description:'明确填写实际路径，不可省略或留空。/workspace 是当前虚拟工作区根目录；文件操作需指向具体文件。'};
  const fileOptional = {
    read_file:['offset','limit'],read_multiple_files:['limit'],tree:['depth'],
    search:['path','target','limit'],view_image:['crop'],
    parse_document:['output_path','output_dir','start_page','end_page','offset','limit'],
    parse_tavern_card:['output_dir'],
  };
  function validateFiles(name, args) {
    const required=Object.hasOwn(fileRequired,name)?fileRequired[name]:null;if(!required)return null;
    if(!args||typeof args!=='object'||Array.isArray(args))return '参数必须是 JSON 对象。本次调用未执行。';
    const fail=(key,reason)=>'参数 '+key+' '+reason+'（工具 '+name+'）。本次调用未执行，请修正参数后重新调用。';
    const supplied=key=>(required.includes(key)||(Object.hasOwn(fileOptional,name)&&fileOptional[name].includes(key)))&&Object.hasOwn(args,key);
    for(const key of required)if(!Object.hasOwn(args,key)||args[key]===undefined)return '缺少必填参数 '+key+'（工具 '+name+'）。本次调用未执行，请显式填写后重新调用。';
    for(const key of ['path','from','to','output_path','output_dir'])if(supplied(key)){
      if(typeof args[key]!=='string')return fail(key,'需要字符串');
      if(!args[key].trim())return fail(key,'不能为空或纯空白；请填写实际路径');
    }
    if(name==='read_multiple_files'){
      if(!Array.isArray(args.paths)||!args.paths.length||args.paths.length>20)return fail('paths','需要包含 1 到 20 个文件路径的数组');
      for(let i=0;i<args.paths.length;i++)if(typeof args.paths[i]!=='string'||!args.paths[i].trim())return fail('paths['+i+']','需要非空文件路径字符串');
    }
    for(const key of ['content','old_str','new_str','pattern'])if(required.includes(key)){
      if(typeof args[key]!=='string')return fail(key,'需要字符串');
      if((key==='old_str'||key==='pattern'||name==='append_file'&&key==='content')&&!args[key].length)return fail(key,'不能为空字符串');
    }
    for(const [key,min] of Object.entries({offset:0,limit:1,depth:0,start_page:1,end_page:1}))if(supplied(key)){
      if(!Number.isSafeInteger(args[key])||args[key]<min)return fail(key,'需要不小于 '+min+' 的整数；使用默认值时请省略该参数');
    }
    if(supplied('target')&&!['both','name','content'].includes(args.target))return fail('target','需要 both、name 或 content');
    if(name==='parse_document'){
      if(!['text','images'].includes(args.format))return fail('format','需要 text 或 images');
      if(!['return','file'].includes(args.output))return fail('output','需要 return 或 file');
      if(args.output==='file'){
        const key=args.format==='text'?'output_path':'output_dir';
        if(!Object.hasOwn(args,key))return fail(key,'在 output=file 时必须填写');
      }
      if(args.end_page!==undefined&&args.end_page<(args.start_page??1))return fail('end_page','不能小于 start_page');
      if(args.limit>120000)return fail('limit','不能超过 120000');
      for(const key of ['offset','limit'])if(Object.hasOwn(args,key)&&(args.format!=='text'||args.output!=='return'))return fail(key,'仅支持 format=text 且 output=return');
    }
    if(name==='view_image'&&Object.hasOwn(args,'crop')){
      const c=args.crop;
      if(!c||typeof c!=='object'||Array.isArray(c))return fail('crop','需要包含 x、y、width、height 的对象；查看整图时省略');
      for(const [key,min] of Object.entries({x:0,y:0,width:1,height:1}))if(!Number.isSafeInteger(c[key])||c[key]<min)return fail('crop.'+key,'需要不小于 '+min+' 的像素整数');
    }
    return null;
  }
  function invalid(call) {
    try { parse(call?.function?.arguments); return false; } catch (_) { return true; }
  }
  const hasInvalid = messages => messages.some(m => m.role === 'assistant' && m.tool_calls?.some(invalid));
  // Repair only the wire copy. Execution must always parse the original arguments.
  function project(messages) {
    if (!Array.isArray(messages) || !hasInvalid(messages)) return messages;
    const changed = new Set();
    const out = messages.map(m => {
      if (m.role !== 'assistant' || !m.tool_calls?.length) return m;
      const tool_calls = m.tool_calls.map(call => {
        if (!invalid(call)) return call;
        changed.add(call.id);
        return { ...call, function: { ...call.function, arguments: '{}' } };
      });
      return tool_calls.every((call, i) => call === m.tool_calls[i]) ? m : { ...m, tool_calls };
    });
    return out.map(m => m.role === 'tool' && changed.has(m.tool_call_id)
      ? { ...m, content: PLACEHOLDER + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) } : m);
  }
  return { HINT, NOTICE, parse, invalid, hasInvalid, project, validateFiles, pathSchema };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ToolArguments;
