'use strict';
const OutputLimit=(()=>{
  const DEFAULT_TOKENS=16384;
  function tokens(value){
    if(value==null||String(value).trim()==='')return DEFAULT_TOKENS;
    const n=Number(value);
    if(!Number.isSafeInteger(n)||n<=0)throw Error('最大输出必须为正整数（单位 tokens）');
    return n;
  }
  function assertComplete(reason,usage,limit){
    const used=Number(usage?.completion_tokens??usage?.output_tokens);
    if(reason==='length'||(Number.isFinite(used)&&limit>0&&used>=limit))
      throw Object.assign(Error('模型输出已达到最大输出上限（'+limit+' tokens），内容可能不完整。请在设置中提高“最大输出”后重试。'),
        {code:'OUTPUT_LIMIT',limit,...(Number.isFinite(used)?{used}:{})});
  }
  return {DEFAULT_TOKENS,tokens,assertComplete};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=OutputLimit;
