'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
  const logs=[];
  class Socket extends EventTarget{
    static OPEN=1;static CLOSING=2;readyState=1;bufferedAmount=123;
    close(){this.readyState=2;}
    emit(type,fields={}){const event=new Event(type);Object.assign(event,fields);this.dispatchEvent(event);}
  }
  const context=vm.createContext({module:{exports:{}},console:{warn:(...args)=>logs.push(args),debug:(...args)=>logs.push(args)},WebSocket:Socket,crypto:globalThis.crypto,TextEncoder,TextDecoder,URL,ArrayBuffer,Uint8Array,DataView,setTimeout,clearTimeout,setInterval,clearInterval,Date});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../vendor/room-bridge.js'),'utf8'),context);
  const sdk=context.module.exports;
  const connection=new sdk.BridgeConnection(new URL('wss://user:password@server.example/server/room?join=invite-secret#token-secret'),{token:'root-secret'},{});
  return {logs,connection,sdk};
}
test('socket diagnostics preserve close details even after the opaque browser error fires first',async()=>{
  const {logs,connection}=fixture();
  connection.ws.emit('error');connection.ws.emit('close',{code:1008,reason:'RateLimited',wasClean:true});
  await connection.closed;
  const records=logs.map(args=>args[1]);
  assert.ok(records.some(r=>r.event==='websocket.error'&&r.browserErrorDetailsAvailable===false));
  const close=records.find(r=>r.event==='websocket.closed');assert.ok(close,'close frame must be logged');
  assert.equal(close.closeCode,1008);assert.equal(close.closeReason,'RateLimited');assert.equal(close.wasClean,true);
  assert.equal(close.role,'host');assert.equal(close.bufferedAmount,123);assert.ok(close.connectionId);
  assert.ok(records.every(r=>r.connectionId===close.connectionId));
  for(const secret of ['password','invite-secret','token-secret','root-secret'])assert.ok(!JSON.stringify(logs).includes(secret));
});
test('failure diagnostics retain heartbeat, queue and underlying exception details without parsed message contents',async()=>{
  const {logs,connection,sdk}=fixture();connection.phase='session';connection.lastReceived=Date.now()-60000;connection.pendingBytes=45000;connection.pendingReceiveBytes=200;
  const cause=new SyntaxError('Unexpected private-story-secret');cause.stack='SyntaxError: private-story-secret\n    at receive (https://server.example/client.html?join=invite-secret:12:3)';
  connection.fail(new sdk.BridgeError('InvalidMessage',{cause}));connection.ws.emit('close',{code:1006,reason:'private-story-secret',wasClean:false});await connection.closed;
  const failed=logs.map(args=>args[1]).find(r=>r.event==='connection.failed');assert.ok(failed);
  assert.equal(failed.error.code,'InvalidMessage');assert.equal(failed.error.cause.name,'SyntaxError');
  assert.ok(failed.lastReceivedAgoMs>=60000);assert.equal(failed.pendingBytes,45000);assert.equal(failed.pendingReceiveBytes,200);
  assert.ok(!JSON.stringify(logs).includes('private-story-secret'));assert.ok(!JSON.stringify(logs).includes('invite-secret'));
});
test('a failing diagnostics callback cannot prevent connection closure',async()=>{
  const {connection,sdk}=fixture();connection.onDiagnostic=()=>{throw Error('logger unavailable');};
  assert.doesNotThrow(()=>connection.fail(new sdk.BridgeError('HeartbeatTimeout')));
  connection.ws.emit('close',{code:1006,reason:'',wasClean:false});const closed=await connection.closed;
  assert.equal(closed.error.code,'HeartbeatTimeout');
});
test('unknown server error strings never print arbitrary credentials',async()=>{
  const {logs,connection,sdk}=fixture(),secret='CredentialValue'.repeat(3);
  connection.fail(new sdk.BridgeError(secret,{server:true}));connection.ws.emit('close',{code:1008,reason:secret,wasClean:false});await connection.closed;
  assert.ok(!JSON.stringify(logs).includes(secret));
});
