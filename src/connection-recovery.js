'use strict';
const ConnectionRecovery=(()=>{
  function watch({environment=globalThis,onRecover,onDiagnostic,thresholdMs=45000}={}){
    const doc=environment.document,win=environment.window;
    if(!doc?.addEventListener||!win?.addEventListener)return ()=>{};
    const now=()=>environment.Date?.now?.()??Date.now();
    const monotonic=()=>environment.performance?.now?.()??null;
    let lastAt=now(),lastMono=monotonic(),wasHidden=doc.visibilityState==='hidden',pending=null,frozen=false,running=false,disposed=false;
    const active=()=>doc.visibilityState==='visible'&&doc.hasFocus();
    function diagnose(record){try{onDiagnostic?.(record);}catch(_){}}
    function check(source){
      if(disposed)return;
      const at=now(),mono=monotonic(),wallGap=Math.max(0,at-lastAt),monoGap=mono===null||lastMono===null?null:Math.max(0,mono-lastMono);
      const gapMs=monoGap??wallGap;
      if(gapMs>=thresholdMs||wallGap>=thresholdMs&&(wasHidden||source==='focus'||monoGap===null)){
        if(!pending){pending={source,gapMs:Math.max(gapMs,wallGap),wallGapMs:wallGap,monotonicGapMs:monoGap};diagnose({event:'page.pause-detected',...pending});}
      }
      lastAt=at;lastMono=mono;wasHidden=doc.visibilityState==='hidden';
      if(!pending||!active())return;
      if(running){pending=null;frozen=false;return;}
      const recovery=pending;pending=null;frozen=false;running=true;
      diagnose({event:'page.recovery',...recovery});
      try{Promise.resolve(onRecover?.(recovery)).catch(()=>{}).finally(()=>{running=false;});}catch(_){running=false;}
    }
    const tick=()=>check('timer'),focus=()=>check('focus'),visibility=()=>check('visibilitychange');
    const freeze=()=>{frozen=true;};
    const resume=()=>{if(frozen){pending||={source:'resume',gapMs:Math.max(0,now()-lastAt)};check('resume');}};
    const pageshow=event=>{if(event.persisted){pending||={source:'pageshow',gapMs:Math.max(0,now()-lastAt)};check('pageshow');}};
    const listeners=[[win,'focus',focus],[doc,'visibilitychange',visibility],[doc,'freeze',freeze],[doc,'resume',resume],[win,'pageshow',pageshow]];
    for(const [target,type,fn]of listeners)target.addEventListener(type,fn);
    const timer=environment.setInterval(tick,5000);
    return ()=>{disposed=true;pending=null;environment.clearInterval(timer);for(const [target,type,fn]of listeners)target.removeEventListener(type,fn);};
  }
  return {watch};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=ConnectionRecovery;
