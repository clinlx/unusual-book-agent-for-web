'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Lease=require('../src/lease.js');

function storage(){
  const map=new Map();
  return {
    getItem:key=>map.has(key)?map.get(key):null,
    setItem:(key,value)=>map.set(key,String(value)),
    removeItem:key=>map.delete(key)
  };
}

test('lease uses short heartbeat and expiry window',()=>{
  assert.equal(Lease.HEARTBEAT,2000);
  assert.equal(Lease.EXPIRY,8000);
  assert.equal(Lease.RENEW_THROTTLE,750);
});

test('another tab can acquire only after shortened lease expires',()=>{
  const store=storage();let clock=1000;
  const a=Lease.create({storage:store,tabId:'a',now:()=>clock});
  const b=Lease.create({storage:store,tabId:'b',now:()=>clock});
  assert.equal(a.acquireForRun('save','session').ok,true);
  clock+=7999;
  assert.equal(b.acquireForRun('save','session').ok,false);
  clock+=2;
  assert.equal(b.acquireForRun('save','session').ok,true);
});

test('renewal extends the shortened lease',()=>{
  const store=storage();let clock=1000;
  const a=Lease.create({storage:store,tabId:'a',now:()=>clock});
  const b=Lease.create({storage:store,tabId:'b',now:()=>clock});
  a.acquireForRun('save','session');
  clock+=2000;
  assert.equal(a.renewLease('save'),true);
  clock+=7000;
  assert.equal(b.isHeldByOther('save'),true);
  clock+=1001;
  assert.equal(b.isHeldByOther('save'),false);
});
