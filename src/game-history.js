'use strict';
// Durable round archives are ordinary world files, readable by the same tools as the world.
const GameHistory=(()=>{
  const V=typeof module!=='undefined'&&module.exports?require('./vfs'):VFS;
  const D=typeof module!=='undefined'&&module.exports?require('./game-data'):GameData;
  const ROOT='/workspace/过往回合历史记忆';
  const generated=p=>p.startsWith(ROOT+'/')||['/workspace/ROUND_CACHE.xml','/workspace/SummaryHistory.json','/workspace/OutputCopy.log'].includes(p);
  const segment=x=>String(x||'Unknown').trim().replace(/[<>:"/\\|?*\u0000-\u001f\s]/g,'_').replace(/_+/g,'_').replace(/[. ]+$/g,'').slice(0,120)||'Unknown';
  const archiveEvents=events=>events.filter(e=>['player','story','dice','note','round_end'].includes(e.type));
  function writeRound(s,round,cache,overwrite=true){
    const events=archiveEvents(s.events).filter(e=>e.round===round),summary=s.summaries.findLast(e=>e.round===round);
    if(!events.length&&!summary)return;
    const time=summary?.worldTime||events.findLast(e=>e.worldTime)?.worldTime||'';
    const dir=ROOT+'/Round_'+round+'_Time_'+segment(time);
    if(!overwrite&&V.resolve(s.tree,V.normalize(dir)))return;
    const write=(name,value)=>V.writeFile(s.tree,dir+'/'+name,value);
    write('玩家输入.json',JSON.stringify(events.filter(e=>e.type==='player'),null,2));
    write('回合情节.json',JSON.stringify(events,null,2));
    write('回合总结.txt',summary?.content||'');
    if(cache!==undefined)write('ROUND_CACHE.xml',JSON.stringify(cache,null,2));
  }
  function archive(s){
    writeRound(s,s.round,s.cache);
    V.writeFile(s.tree,'/workspace/ROUND_CACHE.xml',JSON.stringify(s.cache,null,2));
    V.writeFile(s.tree,'/workspace/SummaryHistory.json',JSON.stringify(s.summaries,null,2));
    V.writeFile(s.tree,'/workspace/OutputCopy.log',s.events.filter(e=>e.round===s.round&&e.type==='story').map(e=>e.content).join('\n\n'));
  }
  function backfill(s,force=false){
    if(s.historyArchiveVersion===1&&!force)return false;
    const rounds=new Set(archiveEvents(s.events).filter(e=>e.round<=s.round).map(e=>e.round));
    for(const round of rounds)writeRound(s,round,round===s.round?s.cache:undefined,false);
    s.historyArchiveVersion=1;return true;
  }
  // Reference exports do not contain resumable JS tool calls. Restore published progress only.
  function restoreReference(s){
    const exists=p=>D.node(s,p)?.type==='file';
    const read=(p,kind)=>{try{const x=D.read(s,p);if(kind==='array'?!Array.isArray(x):!x||typeof x!=='object'||Array.isArray(x))throw Error('结构不正确');return x;}catch(e){throw Error('参考存档 '+p+' 无法读取：'+e.message);}};
    const root=D.node(s,'过往回合历史记忆');
    const dirs=Object.values(root?.children||{}).filter(n=>n.type==='dir'&&/^Round_\d+_Time_/.test(n.name)).sort((a,b)=>Number(a.name.match(/^Round_(\d+)/)[1])-Number(b.name.match(/^Round_(\d+)/)[1]));
    if(!exists('OutputHistory.json')&&!exists('SummaryHistory.json')&&!exists('.round_count')&&!dirs.length)return false;
    const history=exists('OutputHistory.json')?read('OutputHistory.json','array'):dirs.flatMap(n=>{const p='过往回合历史记忆/'+n.name+'/回合情节.json';return exists(p)?read(p,'array'):[];});
    const playerId=s.playerPath.split('/').pop().replace(/^Player-/,'');
    const roundNumber=x=>Number.isSafeInteger(Number(x))&&Number(x)>=0?Number(x):0;
    s.events=history.filter(e=>e&&typeof e==='object').map((e,i)=>{
      const type=e.type==='main'?'story':e.type==='message'?'player':e.type;
      const hidden=e.is_private&&String(e.target_player||'').replace(/^Player-/,'')!==playerId;
      return {id:'reference-'+i,type:['story','player','dice','note','round_end'].includes(type)?type:'note',content:String(e.content||''),
        round:roundNumber(e.round_count??e.round),at:e.at??(e.timestamp>0?e.timestamp*1000:undefined),worldTime:e.world_time??e.worldTime??'',
        secret:!!(e.is_secret||e.secret||hidden),skip:!!(e.is_skip||e.skip),speaker:e.role,privateContent:e.private_content||'',
        data:e.dice_data||e.data};
    });
    const summaries=exists('SummaryHistory.json')?read('SummaryHistory.json','array'):dirs.map(n=>{const p='过往回合历史记忆/'+n.name+'/回合总结.txt';return {round:Number(n.name.match(/^Round_(\d+)/)[1]),content:D.node(s,p)?.content||''};});
    const byRound=new Map();for(const e of summaries){if(!e||typeof e!=='object')continue;const round=roundNumber(e.round_count??e.round);byRound.set(round,{round,content:String(e.content||''),worldTime:e.world_time??e.worldTime??'',at:e.at??(e.timestamp>0?e.timestamp*1000:undefined)});}s.summaries=[...byRound.values()].sort((a,b)=>a.round-b.round);
    const cachePath=exists('ROUND_CACHE.xml')?'ROUND_CACHE.xml':dirs.length?'过往回合历史记忆/'+dirs.at(-1).name+'/ROUND_CACHE.xml':null;
    if(cachePath&&exists(cachePath))s.cache=read(cachePath,'object');
    const stored=D.node(s,'.round_count')?.content;
    if(stored!==undefined&&!/^\s*\d+\s*$/.test(stored))throw Error('参考存档 .round_count 格式不正确');
    s.round=[...s.events,...s.summaries].reduce((n,e)=>Math.max(n,e.round),roundNumber(stored));
    s.status=s.cache.game_over===true?'ended':s.round||s.events.length?'waiting':'new';
    s.messages=s.events.filter(e=>['player','story','dice'].includes(e.type)).map(e=>({role:e.type==='player'?'user':'assistant',round:e.round||1,content:e.content+(e.privateContent?'\n'+e.privateContent:'')}));
    s.importNotice='已恢复参考版的已保存剧情、回合和缓存；服务器运行中的工具调用与旧回退点不在此存档格式中。';
    return true;
  }
  function compactReads(messages,source,currentRound){
    const calls=new Map();for(const m of source)if((m.round||1)<currentRound)for(const c of m.tool_calls||[])if(['read_file','read_multiple_files','list_dir','tree','search'].includes(c.function?.name))calls.set(c.id,c);
    return messages.map(m=>{const c=m.role==='tool'&&calls.get(m.tool_call_id);if(!c||String(m.content).length<2000)return m;
      let result;try{result=JSON.parse(m.content);}catch(_){return m;}if(result.ok!==true)return m;
      return {...m,content:JSON.stringify({ok:true,archived:true,tool:c.function.name,arguments:c.function.arguments,note:'旧回合读取结果已压缩；可按原参数重新读取，回合记录位于 /workspace/过往回合历史记忆。'})};
    });
  }
  return {archive,backfill,restoreReference,compactReads,generated};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameHistory;
