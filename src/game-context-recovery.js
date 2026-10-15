'use strict';
const GameContextRecovery=(()=>{
  const V=typeof module!=='undefined'&&module.exports?require('./vfs'):VFS;
  const ROOT='/workspace/过往回合历史记忆';
  const reads=new Set(['read_file','read_multiple_files','list_dir','tree','search']);
  const segment=x=>String(x||'current').replace(/[^\w-]/g,'_').slice(0,100);
  const uid=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
  function completedUnits(source,current){
    const units=[];
    for(let i=0;i<source.length;i++){
      const m=source[i];if((m.round||1)!==current||m.role!=='assistant')continue;
      const calls=m.tool_calls||[];let end=i+1;
      if(calls.length){
        while(end<source.length&&source[end].role==='tool'&&(source[end].round||1)===current)end++;
        const ids=source.slice(i+1,end).map(m=>m.tool_call_id);
        if(ids.length!==calls.length||new Set(ids).size!==ids.length||calls.some(c=>!ids.includes(c.id)))continue;
      }
      units.push({start:i,end,calls});i=end-1;
    }
    return units;
  }
  // Only the request copy is shortened. Original messages, receipts and events stay intact;
  // the caller expires file knowledge whose evidence is no longer present in that request.
  function fit(s,source,current,cap,project,estimate,protectedMessages=new WeakSet()){
    const units=completedUnits(source,current),planned=new Map();
    let root=ROOT+'/Context_Round_'+current+'_'+segment(s.activeRound?.id);
    while(V.resolve(s.tree,V.normalize(root))?.type==='file')root+='_'+uid();
    function archive(content,name){
      let path=root+'/'+name+'.json',node=V.resolve(s.tree,V.normalize(path));
      if(node&&node.content!==content){
        const existing=Object.values(V.resolve(s.tree,V.normalize(root))?.children||{}).find(n=>n.type==='file'&&n.encoding!=='base64'&&n.name.startsWith(name+'_')&&n.content===content);
        if(existing){path=root+'/'+existing.name;node=existing;}
      }
      while(node&&(node.type!=='file'||node.encoding==='base64'||node.content!==content)){
        path=root+'/'+name+'_'+uid()+'.json';node=V.resolve(s.tree,V.normalize(path));
      }
      planned.set(path,content);return path;
    }
    function commit(sent,paths){
      for(const path of new Set(paths)){
        const content=planned.get(path);
        if(V.resolve(s.tree,V.normalize(path))?.content!==content)V.writeFile(s.tree,path,content);
      }
      return sent;
    }
    let sent;
    function tryFit(candidate,paths=[]){
      sent=project(candidate);
      if(estimate(sent)<=cap)return commit(sent,paths);
      const groups=[];
      for(let start=0;start<sent.length;){
        if(sent[start].role!=='user'||typeof sent[start].content!=='string'||protectedMessages.has(sent[start])){start++;continue;}
        let end=start+1;
        while(end<sent.length&&sent[end].role==='user'&&typeof sent[end].content==='string'&&!protectedMessages.has(sent[end]))end++;
        groups.push({start,end,messages:sent.slice(start,end)});start=end;
      }
      const projected=sent,replacements=new Map(),inputPaths=[];
      groups.sort((a,b)=>estimate(b.messages)-estimate(a.messages));
      for(const group of groups){
        const content=JSON.stringify(group.messages),path=archive(content,'Inputs_'+group.start),r=s.activeRound||{};
        const index={round:current,triggered:!!r.triggered,published:r.published||0,privatePublished:r.privatePublished||0,
          archive_path:path,message_count:group.messages.length,total_characters:content.length,
          preview:content.slice(0,320),tail:content.length>640?content.slice(-320):'',
          instruction:'这是本次对话输入的资料索引，不是新的玩家行动。原文按消息顺序保存在 archive_path 的 JSON 数组中。用 read_file 按 offset/limit 分段读取，offset 从 0 开始，limit 建议 2000。执行前须读取相关的完整玩家行动、私密受众和流程约束；前情、缓存和本回合执行记录也以原文为准。沿用已经完成的进度，不得重复成功的修改、掷骰及正文。'};
        const message={role:'user',content:'[上下文资料索引]\n'+JSON.stringify(index)};
        if(estimate([message])>=estimate(group.messages))continue;
        replacements.set(group.start,{end:group.end,message});inputPaths.push(path);sent=[];
        for(let i=0;i<projected.length;){
          const replacement=replacements.get(i);
          if(replacement){sent.push(replacement.message);i=replacement.end;}
          else sent.push(projected[i++]);
        }
        if(estimate(sent)<=cap)return commit(sent,[...paths,...inputPaths]);
      }
      return null;
    }
    const shortened=source.slice(),readPaths=new Map();
    let fitted=tryFit(shortened);if(fitted)return fitted;
    for(const unit of units){
      for(let i=unit.start+1;i<unit.end;i++){
        const m=source[i],call=unit.calls.find(c=>c.id===m.tool_call_id);
        if(!reads.has(call?.function?.name)||String(m.content).length<2000)continue;
        let result;try{result=JSON.parse(m.content);}catch(_){continue;}if(result.ok!==true)continue;
        const path=archive(m.content,'Read_'+i),preview=m.content.slice(0,1000);
        shortened[i]={...m,content:JSON.stringify({ok:true,archived:true,tool:call.function.name,arguments:call.function.arguments,
          archive_path:path,preview,total_characters:m.content.length,next_offset:preview.length,
          note:'完整读取回执已保存为快照；用 read_file 读取 archive_path，offset 从 next_offset 继续，limit 建议 4000。不要把预览当作完整文件。'})};
        readPaths.set(i,path);fitted=tryFit(shortened,[...readPaths.values()]);
        if(fitted)return fitted;
      }
    }
    const removed=new Set(),entries=[],recentCalls=[],batchPaths=[];let phasePlan;
    for(const unit of units){
      const path=archive(JSON.stringify(source.slice(unit.start,unit.end)),'Batch_'+unit.start);
      batchPaths.push(path);entries.push({path,messages:unit.end-unit.start});
      for(let i=unit.start;i<unit.end;i++)removed.add(i);
      for(const call of unit.calls){
        let receipt;try{receipt=JSON.parse(source.slice(unit.start+1,unit.end).find(m=>m.tool_call_id===call.id)?.content);}catch(_){}
        const entry={id:call.id,tool:call.function.name,ok:receipt?.ok===true};
        if(entry.ok&&call.function.name==='trigger_next_round')phasePlan=receipt.result?.phase_plan;
        if(call.function.name==='roll_dice'){
          const d=receipt?.result?.data;
          if(d){
            const keys=['mode','compare_mode','raw','left','right','total','target','success','critical','special'];
            const brief=value=>Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
            entry.dice=brief(d);if(d.mode==='independent')entry.dice.rows=(d.rows||[]).map(row=>({label:row.label,...brief(row)}));
          }
        }
        recentCalls.push(entry);
      }
      const indexPath=archive(JSON.stringify(entries),'Index_'+unit.end),r=s.activeRound||{};
      const progress={round:current,triggered:!!r.triggered,published:r.published||0,privatePublished:r.privatePublished||0,
        action:r.action||'',actions:r.actions||[],phase_plan:phasePlan,summary:r.summary||[],completed_calls:recentCalls.length,
        recent_calls:recentCalls.slice(-8),archive_path:indexPath,
        instruction:'沿用本轮行动与受众，从已完成进度继续。成功的修改、掷骰及正文不得重复执行。完整思考与工具回执在 archive_path 列出的快照内；缺少细节时用 read_file 按 offset/limit 分段读取，limit 建议 4000。'};
      const checkpoint={role:'user',round:current,content:'[本回合执行记录]\n'+JSON.stringify(progress)};
      const kept=[];let inserted=false;const keptReads=[];
      for(let i=0;i<shortened.length;i++){
        if(removed.has(i)){if(!inserted){kept.push(checkpoint);inserted=true;}continue;}
        kept.push(shortened[i]);if(readPaths.has(i))keptReads.push(readPaths.get(i));
      }
      fitted=tryFit(kept,[...batchPaths,indexPath,...keptReads]);
      if(fitted)return fitted;
    }
    return sent;
  }
  return {fit};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameContextRecovery;
