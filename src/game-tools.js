'use strict';
const GameTools=(()=>{
  const args=typeof module!=='undefined'&&module.exports?require('./shared/tool-arguments.js'):ToolArguments;
  const filePath=args.pathSchema;
  const text={type:'string',minLength:1,pattern:'\\S'};
  const str={type:'string'},num={type:'number'},bool={type:'boolean'},obj={type:'object'},integer={type:'integer'};
  const definitions={
    trigger_next_round:{properties:{phase_plan:{anyOf:[{...text,description:'包含 Countdowns、Pending_Triggers、Forced_Checks 的 JSON 对象字符串；优先直接传对象。'},{type:'object',properties:{Countdowns:text,Pending_Triggers:{type:'array',items:obj},Forced_Checks:text},required:['Countdowns','Pending_Triggers','Forced_Checks']}]}},required:['phase_plan']},
    private_append_story:{properties:{entries:{type:'array',minItems:1,items:{type:'object',properties:{id:text,story:text},required:['id','story']}}},required:['entries']},
    append_story:{properties:{content:str,skip_output:bool,one_line_summary_of_content:text},required:['one_line_summary_of_content']},
    end_the_round:{properties:{NEXT_TURN_CACHE:{anyOf:[{...text,description:'含 Story_Phase 的 JSON 对象字符串；优先直接传对象。'},{type:'object',properties:{Story_Phase:{type:'string',enum:['游戏前准备','游戏循环','游戏结束']},game_over:bool},required:['Story_Phase']}]}},required:['NEXT_TURN_CACHE']},
    roll_dice:{properties:{description:text,roller:{...text,description:'实际角色的唯一 ID、目录或唯一姓名；支持 Player/AIPC/KPC/NPC，主持人用 <|GM|>。'},related_attr:text,is_secret:bool,is_private:{...bool,description:'仅向指定 Player 展示；暗骰仍只展示占位。'},target_player:{...str,description:'is_private:true 时指定有效 Player ID；省略时取 roller，非 Player 骰必须明确指定。'},dice_dict:{type:'object',minProperties:1,additionalProperties:{type:'string',pattern:'^\\s*(?:-?\\d+[dD]\\d+|[sS][eE][tT]-[fF][oO][rR][cC][eE]:-?\\d+|-?\\d+)\\s*$',description:'NdM、-NdM、set-force:N；裸整数只用于 calculate_only=true。'}},calculate_only:bool,
      target_value:{anyOf:[num,{type:'null'}]},compare_mode:{anyOf:[{type:'string',enum:['gt','lt','ge','le','ne','eq']},{type:'null'}]},
      critical_success_range:{anyOf:[{type:'array',items:num,minItems:2,maxItems:2},{type:'null'}]},critical_failure_range:{anyOf:[{type:'array',items:num,minItems:2,maxItems:2},{type:'null'}]},
      dice_combine_mode:{type:'string',enum:['sum','max','min','independent'],description:'independent 仅用于同骰式、同角色属性、同目标/修正/临界区间的同类检定。不同用途分别调用；SAN 检定与损失计算不能放在同一个 dice_dict。'},left_modifiers:{type:'object',additionalProperties:num},right_modifiers:{type:'object',additionalProperties:num}},required:['description','roller','related_attr','is_secret','dice_dict','calculate_only','target_value','compare_mode','critical_success_range','critical_failure_range','dice_combine_mode','left_modifiers','right_modifiers']},
    generate_random_number:{properties:{min_val:{...integer,minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},max_val:{...integer,minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER}},required:['min_val','max_val']},
    random_select:{properties:{items:{type:'array',minItems:1,items:{},description:'非空候选数组，可包含任意 JSON 值；对象可提供 weight。'},weights:{type:'array',items:{anyOf:[{type:'number',minimum:0},{type:'null'}]},description:'按候选项顺序指定非负权重；未提供或 null 项沿用候选对象的 weight，否则默认 1。至少一个实际权重大于 0。'}},required:['items']},
    calculate_difficulty_class:{properties:{subject_value:num,target_value:num},required:['subject_value','target_value']},
    read_file:{properties:{path:filePath,offset:{...integer,minimum:0},limit:{...integer,minimum:1}},required:['path']},
    read_multiple_files:{properties:{paths:{type:'array',items:filePath,minItems:1,maxItems:20},limit:{...integer,minimum:1}},required:['paths']},
    list_dir:{properties:{path:filePath},required:['path']},
    tree:{properties:{path:filePath,depth:{type:'integer',minimum:0,maximum:10,default:3}},required:['path']},
    search:{properties:{path:{...filePath,description:'搜索根目录；省略时搜索 /workspace。显式填写时必须是非空实际路径。'},pattern:{...str,minLength:1},target:{type:'string',enum:['both','name','content']},limit:{...integer,minimum:1}},required:['pattern']},
    write_file:{properties:{path:filePath,content:str},required:['path','content']},
    append_file:{properties:{path:filePath,content:{...str,minLength:1}},required:['path','content']},
    apply_patch:{properties:{path:filePath,old_str:{...str,minLength:1},new_str:str,patches:{type:'array',minItems:1,maxItems:50,items:{type:'object',properties:{old_str:{...str,minLength:1},new_str:str},required:['old_str','new_str']}}},required:['path'],oneOf:[{required:['old_str','new_str'],not:{required:['patches']}},{required:['patches'],not:{anyOf:[{required:['old_str']},{required:['new_str']}]}}]},
    mkdir:{properties:{path:filePath},required:['path']},delete:{properties:{path:filePath},required:['path']},
    move:{properties:{from:filePath,to:filePath},required:['from','to']},copy:{properties:{from:filePath,to:filePath},required:['from','to']}
  };
  function build(prompts,overrides={}){
    const read=overrides=>typeof prompts.get==='function'?JSON.parse(prompts.get('flow/tools.json',overrides)||'{}'):{};
    const base=read().parameter_descriptions||{};
    const custom=read(overrides).parameter_descriptions||{};
    const description=(source,name,key)=>Object.hasOwn(source,name)&&source[name]&&Object.hasOwn(source[name],key)&&typeof source[name][key]==='string'?source[name][key]:undefined;
    return Object.entries(definitions).map(([name,params])=>{
      const properties=Object.fromEntries(Object.entries(params.properties).map(([key,schema])=>{
        const text=description(custom,name,key)??description(base,name,key);
        return [key,text===undefined?schema:{...schema,description:text}];
      }));
      return {type:'function',function:{name,description:prompts.toolDescription(name,overrides),parameters:{type:'object',...params,properties}}};
    });
  }
  return {build};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameTools;
