'use strict';
const GameTools=(()=>{
  const str={type:'string'},num={type:'number'},bool={type:'boolean'},obj={type:'object'},integer={type:'integer'};
  const definitions={
    trigger_next_round:{properties:{phase_plan:{anyOf:[{type:'string'},{type:'object',properties:{Countdowns:{type:'string',minLength:1},Pending_Triggers:{type:'array',items:obj},Forced_Checks:{type:'string',minLength:1}},required:['Countdowns','Pending_Triggers','Forced_Checks']}]}},required:['phase_plan']},
    append_story:{properties:{content:str,one_line_summary_of_content:str},required:['content','one_line_summary_of_content']},
    end_the_round:{properties:{NEXT_TURN_CACHE:{anyOf:[str,{type:'object',properties:{Story_Phase:{type:'string',enum:['游戏前准备','游戏循环','游戏结束']},game_over:bool},required:['Story_Phase']}]}},required:['NEXT_TURN_CACHE']},
    roll_dice:{properties:{description:str,roller:str,related_attr:str,is_secret:bool,dice_dict:{type:'object',additionalProperties:str},calculate_only:bool,target_value:num,
      compare_mode:{type:'string',enum:['gt','lt','ge','le','ne','eq']},critical_success_range:str,critical_failure_range:str,
      dice_combine_mode:{type:'string',enum:['sum','max','min','independent']},left_modifiers:{type:'object',additionalProperties:num},right_modifiers:{type:'object',additionalProperties:num}},required:['description','roller','dice_dict','is_secret']},
    generate_random_number:{properties:{min_val:integer,max_val:integer},required:['min_val','max_val']},
    random_select:{properties:{items:{type:'array',items:{}},weights:{type:'array',items:num}},required:['items']},
    calculate_difficulty_class:{properties:{subject_value:num,target_value:num},required:['subject_value','target_value']},
    read_file:{properties:{path:str,offset:integer,limit:integer},required:['path']},
    read_multiple_files:{properties:{paths:{type:'array',items:str},limit:integer},required:['paths']},
    list_dir:{properties:{path:str},required:['path']},
    tree:{properties:{path:str,depth:{type:'integer',minimum:0,maximum:10,default:3}},required:['path']},
    search:{properties:{path:str,pattern:str,target:{type:'string',enum:['both','name','content']},limit:integer},required:['pattern']},
    write_file:{properties:{path:str,content:str},required:['path','content']},
    append_file:{properties:{path:str,content:str},required:['path','content']},
    apply_patch:{properties:{path:str,old_str:str,new_str:str},required:['path','old_str','new_str']},
    mkdir:{properties:{path:str},required:['path']},delete:{properties:{path:str},required:['path']},
    move:{properties:{from:str,to:str},required:['from','to']},copy:{properties:{from:str,to:str},required:['from','to']}
  };
  function build(prompts,overrides={}){return Object.entries(definitions).map(([name,params])=>({type:'function',function:{name,description:prompts.toolDescription(name,overrides),parameters:{type:'object',...params}}}));}
  return {build};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameTools;
