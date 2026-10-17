'use strict';
// 前端部署配置：修改后重新运行 node build.js，配置会内嵌到三端 HTML。
// 这里只定义默认值；浏览器中已保存的用户设置优先，不随构建被覆盖。
// 勿在这里填写真实 API Key；此文件会随网页公开发布。
const FrontendConfig=(()=>{
  const links={
    apiBase:'https://api.deepseek.com/v1',
    relay:'wss://mc.birdry.cn:8443/',
    github:'https://github.com/clinlx/unusual-book-agent-for-web',
    worldCatalog:'./modules.json',
  };
  const common={
    baseUrl:links.apiBase,apiKey:'',model:'deepseek-flash',
    stream:true,temperature:0.7,maxOutputTokens:16384,
    reasoningEffort:'high',reverseSendNewline:false,
  };
  const game={
    ...common,topP:'',frequencyPenalty:'',presencePenalty:'',seed:'',customRequestBody:'',
    maxContextK:240,maxToolLoops:60,httpTimeoutSeconds:180,maxRetries:2,
    // 留空使用 links.worldCatalog；用户可以在游戏设置中覆盖列表源。
    worldListSource:'',bridgeUrl:links.relay,
    manualDice:false,openingPreload:true,autoAdvanceUnconscious:true,promptOverrides:{},
  };
  const designer={
    ...common,imageSending:true,
    // disabled 拒绝超限；sliding 滑动窗口；truncate 截断；compress 模型摘要。
    contextOverflow:'disabled',
    maxContextK:256, // 预设 128 | 256 | 512 | 1024，或使用 custom 模式。
    contextLimitMode:'preset',
    editorPosition:'right', // right | center | left | float（窄屏忽略）。
    panes:null, // 桌面三栏宽度 [左, 右]（px），null 使用布局默认值。
    changeScope:'last', // last 最后一轮；accumulate 累积到手动接受。
    reasoningDisplay:'collapsed', // collapsed | alwaysCollapsed | expanded | hidden。
    systemPromptOverride:'', // 留空使用设计师配置中的系统提示词。
  };
  // 加入者只保留本地输入偏好；中转地址由邀请信息提供。
  const client={reverseSendNewline:common.reverseSendNewline};
  const profiles={game,designer,client};
  function freeze(value){
    for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);
    return Object.freeze(value);
  }
  function defaults(profile){
    if(!Object.hasOwn(profiles,profile))throw Error('未知前端配置: '+profile);
    return structuredClone(profiles[profile]);
  }
  return freeze({links,common,game,designer,client,defaults});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=FrontendConfig;
