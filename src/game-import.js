'use strict';
const GameImport=(()=>{
  const vfs=typeof module!=='undefined'&&module.exports?require('./vfs.js'):VFS;
  const zip=typeof module!=='undefined'&&module.exports?require('./zip.js'):ZIP;
  const importer=typeof module!=='undefined'&&module.exports?require('./workspace-import.js'):WorkspaceImport;
  const core=typeof module!=='undefined'&&module.exports?require('./game-core.js'):GameCore;
  const history=typeof module!=='undefined'&&module.exports?require('./game-history.js'):GameHistory;
  const MANIFEST='.trpg-save.json';
  async function importSave(file){
    if(!/\.zip$/i.test(file.name))throw Error('请选择 ZIP 存档');
    const entries=await importer.prepare([file],{extractZip:true});
    const manifest=entries.find(e=>e.name===MANIFEST&&!e.isDir);
    const tree=vfs.createTree();vfs.mkdirp(tree,['workspace']);
    const seen=new Set();
    for(const e of entries){
      if(e.name===MANIFEST)continue;
      if(seen.has(e.name))throw Error('压缩包包含重名路径：'+e.name);seen.add(e.name);
      if(e.isDir)vfs.mkdirp(tree,core.path(e.name).split('/').filter(Boolean));
      else vfs.writeFile(tree,core.path(e.name),e.content,{encoding:e.encoding});
    }
    const s=core.createSave(file.name.replace(/\.zip$/i,''),tree);
    if(manifest){
      let m;try{m=JSON.parse(manifest.content);}catch(_){throw Error('完整存档的进度数据已损坏');}
      if(m.format!=='trpg-single-player'||m.version!==1||!m.state)throw Error('无法识别完整存档版本');
      const st=m.state;
      if(!Array.isArray(st.messages)||!Array.isArray(st.events)||!Number.isSafeInteger(st.round)||st.round<0)throw Error('存档历史格式不正确');
      const unsafeKey=(k,v)=>{if(['__proto__','prototype','constructor'].includes(k))throw Error('存档包含不安全字段');return v;};
      JSON.parse(JSON.stringify(st),unsafeKey);
      for(const key of ['name','round','cache','messages','events','summaries','status','snapshots','activeRound','contextFromRound','lastChanges','draft','error','requestHistory','historyArchiveVersion','importNotice'])
        if(st[key]!==undefined)s[key]=structuredClone(st[key]);
      if(s.activeRound&&!s.activeRound.complete)s.status='interrupted';
      s.playerPath=core.validateTree(s.tree);
    }else history.restoreReference(s);
    history.backfill(s);core.pruneRollback(s);return s;
  }
  function exportSave(s){
    core.pruneRollback(s);
    const entries=[];
    function walk(n,p){if(n.type==='file')entries.push({name:p,bytes:vfs.fileBytes(n)});else {if(p)entries.push({name:p+'/',bytes:new Uint8Array()});for(const c of Object.values(n.children))walk(c,p?p+'/'+c.name:c.name);}}
    walk(vfs.resolve(s.tree,['workspace']),'');
    if(entries.some(e=>e.name===MANIFEST))throw Error('工作目录使用了保留文件名 '+MANIFEST);
    const {tree,id,createdAt,updatedAt,...state}=s;
    entries.push({name:MANIFEST,text:JSON.stringify({format:'trpg-single-player',version:1,state})});
    return zip.makeZip(entries);
  }return {importSave,exportSave};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GameImport;
