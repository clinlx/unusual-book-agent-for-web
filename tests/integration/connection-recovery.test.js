'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
function fixture(){
  const file=path.join(__dirname,'../../src/connection-recovery.js');
  assert.ok(fs.existsSync(file),'shared recovery watcher is available');
  const Recovery=require(file);let wall=100000,mono=0,tick,focused=true;const document=new EventTarget(),window=new EventTarget(),recoveries=[],diagnostics=[];
  document.visibilityState='visible';document.hasFocus=()=>focused;
  const environment={document,window,Date:{now:()=>wall},performance:{now:()=>mono},setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{tick=null;}};
  const stop=Recovery.watch({environment,onRecover:record=>recoveries.push(record),onDiagnostic:record=>diagnostics.push(record)});
  return {document,window,recoveries,diagnostics,stop,focus:value=>focused=value,jump:ms=>{wall+=ms;mono+=ms;},wallJump:ms=>wall+=ms,tick:()=>tick?.()};
}
test('a long pause is retained while hidden and recovered once on focus',async()=>{
  const f=fixture();f.document.visibilityState='hidden';f.focus(false);f.jump(60000);f.tick();assert.equal(f.recoveries.length,0);
  f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(f.recoveries.length,0);
  f.focus(true);f.window.dispatchEvent(new Event('focus'));f.document.dispatchEvent(new Event('resume'));f.tick();
  assert.equal(f.recoveries.length,1);assert.ok(f.recoveries[0].gapMs>=60000);f.stop();
});
test('focus before the delayed timer and a stalled foreground timer both recover',()=>{
  for(const event of ['focus','timer']){const f=fixture();f.jump(60000);if(event==='focus')f.window.dispatchEvent(new Event('focus'));else f.tick();assert.equal(f.recoveries.length,1);f.stop();}
});
test('ordinary focus changes and a foreground wall-clock correction do not reconnect',()=>{
  const f=fixture();f.jump(5000);f.tick();f.window.dispatchEvent(new Event('focus'));assert.equal(f.recoveries.length,0);
  f.wallJump(3600000);f.tick();assert.equal(f.recoveries.length,0);f.stop();
});
test('explicit lifecycle recovery coalesces and all listeners are removed on disposal',()=>{
  const f=fixture();f.document.dispatchEvent(new Event('freeze'));f.document.dispatchEvent(new Event('resume'));f.window.dispatchEvent(new Event('focus'));
  assert.equal(f.recoveries.length,1);f.stop();f.jump(60000);f.tick();f.document.dispatchEvent(new Event('resume'));f.window.dispatchEvent(new Event('focus'));assert.equal(f.recoveries.length,1);
});
