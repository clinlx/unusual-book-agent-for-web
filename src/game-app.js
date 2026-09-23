'use strict';
const GameApp=(()=>{
  const defaults={baseUrl:'https://api.deepseek.com/v1',apiKey:'',model:'deepseek-flash',stream:true,temperature:0.7,maxContextK:128,maxOutputTokens:16384,
    reasoningEffort:'high',maxToolLoops:60,httpTimeoutSeconds:180,maxRetries:2,worldListSource:'',manualDice:false,promptOverrides:{}};
  const S={saves:[],active:null,settings:{...defaults},mode:'play',running:false,importing:null,stream:{content:'',reasoning:'',tools:[],story:'',storyPublished:0},error:null,storageWarning:null,usage:null};
  const db=GameStore.create();const listeners=new Set();let controller=null,initialized=false,storage=null,lease=null;
  try{storage=globalThis.localStorage;lease=Lease.create({storage,tabId:GameCore.uid()});}catch(_){}
  function emit(){for(const fn of listeners){try{fn(S);}catch(e){console.error(e);}}}
  const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  function idle(){if(S.importing)throw Error('请等待存档导入完成');if(S.running)throw Error('请先停止当前回合');}
  function active(){if(!S.active)throw Error('请先选择存档');return S.active;}
  function peerCheck(s){if(lease?.isHeldByOther(s.id))throw Error('该存档正在另一个页面运行，请等待其结束');}
  async function persist(){const s=active();s.updatedAt=Date.now();await db.putSave(s);S.saves=await db.list();}
  async function init(){if(initialized)return;await db.open();S.settings={...defaults,...await db.getSettings()};S.settings.promptOverrides||={};
    S.settings.promptOverrides=Prompts.migrateOverrides(S.settings.promptOverrides);delete S.settings.promptOverrides['flow/tools.json'];await db.putSettings(S.settings);
    S.saves=await db.list();if(db.memoryMode)S.storageWarning='浏览器存储不可用，当前内容仅临时保存，请在关闭页面前导出存档。';initialized=true;emit();}
  async function importSave(file){return runImport(()=>Promise.resolve(file));}
  async function importLink(link,name){GameCatalog.url(link);return runImport(async()=>{const file=await GameCatalog.download(link,{onProgress:p=>{S.importing={...p,phase:'download'};emit();}});if(name)file.name=name+'.zip';return file;});}
  async function runImport(source){
    idle();S.active=null;S.error=null;S.importing={phase:'prepare',received:0,total:null};emit();
    try{const file=await source();S.importing={...S.importing,phase:'extract'};emit();
      const s=await GameImport.importSave(file);await settleCompletedBatch(s);await db.putSave(s);S.saves=await db.list();S.active=s;restoreLastRequest(s);S.mode='play';return s;
    }catch(e){S.error=e.message||'导入失败';throw e;}finally{S.importing=null;emit();}
  }
  function restoreLastRequest(s){const last=s.requestHistory?.at(-1);S.lastRequest=last?.body?structuredClone(last.body):null;S.lastRequestSaveId=last?s.id:null;}
  const pendingBatch=s=>s.activeRound&&s.messages.some(m=>m.round===s.activeRound.number&&m.tool_calls?.some(tc=>!s.messages.some(r=>r.round===m.round&&r.role==='tool'&&r.tool_call_id===tc.id)));
  async function settleCompletedBatch(s){
    if(s.pendingManualDice||!s.activeRound?.complete||!pendingBatch(s))return;
    await GameCore.run(s,async()=>{throw Error('已结束的回合不能继续请求模型');});
    await db.putSave(s);
  }
  async function openSave(id){idle();const s=await db.getSave(id);if(!s)throw Error('存档不存在');
    peerCheck(s);if(GameHistory.backfill(s))await db.putSave(s);
    if(s.activeRound?.complete&&pendingBatch(s)){peerCheck(s);await settleCompletedBatch(s);}
    if(s.activeRound&&(!s.activeRound.complete||pendingBatch(s)))s.status='interrupted';S.active=s;restoreLastRequest(s);S.mode='play';S.error=s.error||null;emit();return s;}
  function closeSave(){idle();S.active=null;S.error=null;emit();}
  async function renameSave(id,name){idle();const s=id===S.active?.id?S.active:await db.getSave(id);if(!s)throw Error('存档不存在');peerCheck(s);s.name=String(name).trim()||s.name;await db.putSave(s);S.saves=await db.list();emit();}
  async function deleteSave(id){idle();peerCheck({id});await db.deleteSave(id);if(S.active?.id===id)S.active=null;S.saves=await db.list();emit();}
  function exportSave(){idle();return GameImport.exportSave(active());}
  function rawRead(p){const node=VFS.resolve(active().tree,VFS.normalize(GameCore.path(p)));if(!node||node.type!=='file')throw Error('文件不存在');if(node.encoding==='base64')throw Error('该文件不能作为文本打开');return node.content;}
  function readFile(p){const resource=Prompts.file(p,S.settings.promptOverrides);return resource===undefined?rawRead(p):resource;}
  async function writeFile(p,text){idle();const s=active();peerCheck(s);const fp=GameCore.path(p);if(fp.startsWith('/.reference/'))throw Error('请在设置中修改提示词');
    VFS.writeFile(s.tree,fp,String(text));await persist();emit();}
  async function fileOperation(op,args={}){idle();const s=active();peerCheck(s);const t=VFS.clone(s.tree),p=GameCore.path(args.path),from=GameCore.path(args.from),to=GameCore.path(args.to);
    if([p,from,to].some(x=>x.startsWith('/.reference/')))throw Error('提示词为只读资源');
    if(op==='mkdir')VFS.mkdir(t,p);else if(op==='create'){if(VFS.resolve(t,VFS.normalize(p)))throw Error('同名文件已存在');VFS.writeFile(t,p,args.content||'');}
    else if(op==='delete')VFS.deletePath(t,p);else if(op==='move'||op==='copy')VFS[op](t,from,to);else throw Error('未知文件操作');
    const pp=GameCore.validateTree(t);if(pp!==s.playerPath)throw Error('不能修改唯一玩家目录 ID');s.tree=t;await persist();emit();}
  const readInfo=GamePresentation.createReader(s=>GameCore.player(s,'info')),readItems=GamePresentation.createReader(s=>GameCore.player(s,'items'));
  const readPlayer={clear:s=>{readInfo.clear(s);readItems.clear(s);}};
  function player(){const s=active(),info=readInfo(s),items=readItems(s);return {info:info.info,name:info.name,items:items.items,stale:info.stale||items.stale,infoStale:info.stale,itemsStale:items.stale,error:[info.error,items.error].filter(Boolean).join('；')};}
  function setMode(mode){S.mode=mode==='debug'?'debug':'play';emit();}
  function system(overrides){let world='';try{world=rawRead('/workspace/system.md');}catch(_){}return Prompts.buildSystem(overrides,world);}
  function currentContext(){
    if(S.lastRequest&&S.lastRequestSaveId===active().id)return structuredClone(S.lastRequest.messages);
    const s=structuredClone(active()),frozen=!s.activeRound?.complete&&s.activeRound?.promptSnapshot;
    const overrides=frozen?.overrides||S.settings.promptOverrides,flows=Prompts.flows(overrides);
    const built=GameCore.context(s,frozen?.system||system(overrides),Math.max(1024,S.settings.maxContextK*1000-S.settings.maxOutputTokens),{cachePrompt:flows.flow_cache,summariesPrompt:flows.flow_summaries});
    for(const m of built){m.content=Prompts.migrateText(m.content);if(m.tool_calls)for(const tc of m.tool_calls)tc.function.arguments=Prompts.migrateText(tc.function.arguments);}
    return built;
  }
  async function executeRound(kind,text){
    idle();let s=active();if(!S.settings.apiKey.trim())throw Error('请先在设置中填写 API Key');peerCheck(s);
    if(lease?.available){const lock=lease.acquireForRun(s.id,s.id);if(!lock.ok)throw Error('该存档正在另一个页面运行');}
    S.running=true;S.error=null;controller=new AbortController();
    const settings=structuredClone(S.settings);const overrides=settings.promptOverrides;
    let timer;const clearStream=(keepStory=false)=>{const story=keepStory?S.stream.story||'':'',storyPublished=keepStory?S.stream.storyPublished||0:0;S.stream={content:'',reasoning:'',tools:[],story,storyPublished};};
    try{
      
      const latest=await db.getSave(s.id);if(latest&&latest.updatedAt>s.updatedAt){S.active=s=latest;}
      if(kind!=='resume'&&pendingBatch(s))throw Error('上一轮尚有工具记录需要恢复，请先继续本回合');
      if(kind!=='resume')GameCore.beginRound(s,text,kind==='start',Prompts.roundPrompt(kind==='start',overrides),{skip:kind==='skip'});
      else if(!s.activeRound)throw Error('没有可继续的回合');
      if(!s.activeRound.promptSnapshot)s.activeRound.promptSnapshot={overrides,system:system(overrides)};
      if(!Number.isFinite(s.activeRound.requestCount))s.activeRound.requestCount=s.messages.filter(m=>m.round===s.activeRound.number&&m.role==='assistant').length;
      s.activeRound.requestLimit??=settings.maxToolLoops;
      const snapshot=s.activeRound.promptSnapshot;
      snapshot.overrides=Prompts.migrateOverrides(snapshot.overrides);snapshot.system=Prompts.migrateText(snapshot.system);
      await persist();clearStream();emit();
      timer=setInterval(()=>{if(lease?.available){if(lease.lostWhileRunning(s.id))controller?.abort(Error('存档被另一个页面接管'));else lease.renewLease(s.id);}},4000);
      const defs=GameTools.build(Prompts,snapshot.overrides);
      let currentRequest;
      const raw=GameTransport.create(settings,defs,{signal:controller.signal,
        onRequest:async body=>{if(currentRequest?.status==='pending')currentRequest.status='retried';currentRequest={round:s.activeRound.number,roundId:s.activeRound.id,at:Date.now(),body:structuredClone(body),status:'pending',response:{content:'',reasoning:'',tools:[]}};(s.requestHistory||=[]).push(currentRequest);s.activeRound.requestCount++;S.lastRequest=structuredClone(body);S.lastRequestSaveId=s.id;await persist();emit();},onUsage:usage=>{S.usage=usage;},
        onDelta:t=>{S.stream.content+=t;if(currentRequest)currentRequest.response.content+=t;emit();},onReasoningDelta:t=>{S.stream.reasoning+=t;if(currentRequest)currentRequest.response.reasoning+=t;emit();},onToolDelta:t=>{S.stream.tools=t;
          const storyCalls=t.filter(tc=>tc?.function?.name==='append_story');
          if(storyCalls.length){
            const parts=storyCalls.map(tc=>SSE.partialJsonString(tc.function.arguments,'content')).filter(v=>v!==null);
            if(parts.length){if(!S.stream.story)S.stream.storyPublished=s.activeRound?.published||0;S.stream.story=parts.join('\n\n');}
          }
          if(currentRequest)currentRequest.response.tools=structuredClone(t);emit();}});
      const transport=async messages=>{clearStream();emit();try{const response=await raw(messages);if(currentRequest){currentRequest.status='completed';currentRequest.response=structuredClone(response);}return response;}catch(e){if(currentRequest){currentRequest.status='interrupted';currentRequest.error=e.message;}throw e;}};
      const flows=Prompts.flows(snapshot.overrides);
      await GameCore.run(s,transport,{signal:controller.signal,system:snapshot.system,manualDice:settings.manualDice===true,
        cap:Math.max(1024,settings.maxContextK*1000-settings.maxOutputTokens-GameCore.estimate(defs)),maxToolLoops:settings.maxToolLoops,
        
        
        resource:p=>Prompts.file(p,S.settings.promptOverrides),resourceList:Prompts.referencePaths(),afterStory:flows.flow_after_story,firstRecall:flows.flow_recall,
        resumePrompt:kind==='resume'?flows.flow_resume:'',cachePrompt:flows.flow_cache,summariesPrompt:flows.flow_summaries,transformContext:Prompts.migrateText,
        reminder:save=>!save.activeRound.triggered?flows.flow_need_trigger:!save.activeRound.published?flows.flow_no_story:flows.flow_need_end,
        onStep:async()=>{if(lease?.available&&lease.lostWhileRunning(s.id))throw Error('存档被另一个页面接管');await persist();const keepStory=!!S.stream.story&&(s.activeRound?.published||0)<=S.stream.storyPublished;clearStream(keepStory);emit();}});
    }catch(e){S.error=e.message||'回合未完成';if(s.activeRound&&!s.activeRound.complete){s.status='interrupted';s.error=S.error;}
      
      try{if(!lease?.lostWhileRunning(s.id))await persist();}catch(storageError){S.storageWarning='存档保存失败：'+storageError.message+'。请导出存档保留当前内容。';}throw e;
    }finally{
      try{await settleCompletedBatch(s);}catch(e){S.storageWarning='工具记录保存失败：'+e.message+'。请导出存档保留当前内容。';}
      clearInterval(timer);lease?.releaseLease(s.id);if(pendingBatch(s))s.status='interrupted';S.running=false;controller=null;clearStream();emit();
    }
  }
  const send=text=>{if(!String(text).trim())return Promise.resolve();const s=active();return executeRound(s.status==='new'?'start':'action',String(text));};
  const skip=()=>{if(active().status==='new')throw Error('请先开始故事');return executeRound('skip','');};
  const start=()=>{if(active().status!=='new')throw Error('已经开局，请提交行动');return executeRound('start','');};
  const resume=()=>executeRound('resume','');
  function abort(){controller?.abort(Object.assign(Error('已中止本回合，可继续或回退'),{name:'AbortError'}));}
  async function rollback(){idle();peerCheck(active());GameCore.rollback(active());GameHistory.backfill(active(),true);readPlayer.clear(active());S.error=null;S.lastRequest=null;await persist();emit();}
  async function updateSettings(values){
    const next={...S.settings};for(const k of Object.keys(defaults))if(k!=='promptOverrides'&&Object.hasOwn(values,k))next[k]=values[k];
    for(const [key,min,max]of [['maxContextK',4,4000],['maxOutputTokens',256,200000],['maxToolLoops',1,300],['httpTimeoutSeconds',10,3600],['maxRetries',0,10],['temperature',0,2]]){
      const n=Number(next[key]);if(!Number.isFinite(n)||n<min||n>max)throw Error(key+' 超出有效范围');next[key]=n;}
    for(const k of ['baseUrl','apiKey','model','worldListSource'])next[k]=String(next[k]||'').trim();
    if(next.worldListSource)GameCatalog.source(next.worldListSource);
    if(!['none','low','high','xhigh','max'].includes(next.reasoningEffort))throw Error('思考强度无效');
    next.stream=!!next.stream;next.manualDice=!!next.manualDice;await db.putSettings(next);S.settings=next;emit();
  }
  async function resolveManualDice(rolls){
    idle();const s=active();peerCheck(s);GameCore.resolveManualDice(s,rolls);await persist();emit();await executeRound('resume','');return s;
  }
  const promptList=()=>Prompts.list().filter(p=>p.id!=='flow/tools.json').map(p=>({...p,overridden:Object.hasOwn(S.settings.promptOverrides,p.id)}));
  const getPrompt=id=>Prompts.get(id,S.settings.promptOverrides);
  async function savePrompt(id,text){if(id==='flow/tools.json'||id==='tools.json')throw Error('工具说明不允许在网页中修改');Prompts.get(id);if(typeof text!=='string'||!text.trim())throw Error('提示词不得为空');
    if(id.endsWith('.json')){const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('提示词配置必须是 JSON 对象');
      for(const [k,v]of Object.entries(JSON.parse(Prompts.get(id))))if(typeof value[k]!==typeof v||!value[k])throw Error('缺少配置字段：'+k);}
    const settings={...S.settings,promptOverrides:{...S.settings.promptOverrides,[id]:text}};await db.putSettings(settings);S.settings=settings;emit();}
  async function resetPrompt(id){if(id==='flow/tools.json'||id==='tools.json')throw Error('工具说明不允许在网页中修改');const overrides={...S.settings.promptOverrides};if(id){Prompts.get(id);delete overrides[id];}else for(const k of Object.keys(overrides))delete overrides[k];
    const settings={...S.settings,promptOverrides:overrides};await db.putSettings(settings);S.settings=settings;emit();}
  async function saveDraft(text){if(!S.active)return;peerCheck(S.active);S.active.draft=String(text);await persist();}
  if(typeof window!=='undefined'){
    window.addEventListener('beforeunload',e=>{if(S.running||S.importing){e.preventDefault();e.returnValue='';}});
    window.addEventListener('storage',e=>{if(e.key?.startsWith('awl:lease:'))emit();});
  }
  return {getState:()=>S,subscribe,init,importSave,importLink,openSave,closeSave,renameSave,deleteSave,exportSave,send,skip,start,resume,abort,rollback,setMode,
    readFile,writeFile,fileOperation,player,currentContext,updateSettings,promptList,getPrompt,savePrompt,resetPrompt,saveDraft,resolveManualDice,
    testConnection:values=>GameTransport.testConnection({...S.settings,...values}),
    listModels:values=>GameTransport.listModels({...S.settings,...values})};
})();
