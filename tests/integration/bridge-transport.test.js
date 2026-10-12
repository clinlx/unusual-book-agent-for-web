'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const SDK=require('../../vendor/room-bridge'),Bridge=require('../../src/bridge-transport');
function fakeSDK(){
 const connections=[];let initial=[];
 class Connection{
  static async connect(url,role,roomId,hello,options){const c=new Connection();Object.assign(c,{url,role,roomId,hello,options,inbox:initial.splice(0),ready:{revision:0},messages:[],listeners:new Set(),errors:new Set(),revision:0});c.closed=new Promise(resolve=>c.resolveClosed=resolve);connections.push(c);return c;}
  onMessage(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  onError(fn){this.errors.add(fn);return()=>this.errors.delete(fn);}
  emit(message){for(const fn of this.listeners)fn(message);}
  async request(message){this.messages.push(message);return {type:'AuthorizationReplaced',revision:++this.revision};}
  async invoke(functionId,payload){this.messages.push({type:'Invoke',functionId,payload});}
  async invokeClient(clientId,functionId,payload){this.messages.push({type:'InvokeClient',clientId,functionId,payload});}
  close(){if(this.isClosed)return;this.isClosed=true;this.resolveClosed({error:null});}
  fail(code){const error=new SDK.BridgeError(code);for(const fn of this.errors)fn(error);this.isClosed=true;this.resolveClosed({error});}
 }
 return {sdk:{...SDK,BridgeConnection:Connection},connections,setInitial:messages=>{initial=messages;}};
}
const tick=()=>new Promise(r=>setTimeout(r,20));
async function flush(){for(let i=0;i<25;i++)await Promise.resolve();}

for(const role of ['host','client'])test(role+' retries silently with exponential backoff, resets after success and allows immediate manual retry',async t=>{
 const f=fakeSDK(),base=await Bridge.createHost({url:'ws://localhost',roomId:'retry',sdk:f.sdk});
 const invitation=await base.invite('guest');let session=base;
 if(role==='client'){session=await Bridge.createClient({invitation,sdk:f.sdk});base.close();}
 t.after(()=>session.close());t.mock.timers.enable({apis:['setTimeout']});
 const transport=session.transport,credentials=role==='host'?session.credentials():null;
 let failures=6,attempts=0;const connect=f.sdk.BridgeConnection.connect;
 f.sdk.BridgeConnection.connect=async(...args)=>{attempts++;if(failures-->0)throw new SDK.BridgeError(role==='host'?'RoomExists':'RoomNotFound');return connect(...args);};
 f.connections.at(-1).fail(role==='host'?'HeartbeatTimeout':'HostDisconnected');await flush();
 for(const delay of [5000,10000,20000,40000,80000,120000,120000]){
   const before=attempts;t.mock.timers.tick(delay-1);await flush();assert.equal(attempts,before);
   t.mock.timers.tick(1);await flush();assert.equal(attempts,before+1);
 }
 assert.equal(session.connected,true);assert.equal(session.transport,transport);
 if(role==='host'){assert.deepEqual(session.credentials(),credentials);assert.deepEqual(f.connections.at(-1).hello.players,[{id:'guest',token:invitation.token}]);}
 f.connections.at(-1).fail('ConnectionLost');await flush();const before=attempts;
 t.mock.timers.tick(4999);await flush();assert.equal(attempts,before);t.mock.timers.tick(1);await flush();assert.equal(attempts,before+1);
 f.connections.at(-1).fail('ConnectionLost');await flush();await session.reconnect();assert.equal(attempts,before+2);
 session.close();t.mock.timers.tick(120000);await flush();assert.equal(attempts,before+2);
});

test('a host reconnect keeps transport subscribers and restores command delivery',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk});t.after(()=>host.close());
 const invitation=await host.invite('guest'),client=await Bridge.createClient({invitation,sdk:f.sdk});t.after(()=>client.close());
 const got=[];host.transport.onHost((id,packet)=>got.push([id,packet]));await host.reconnect();
 await client.transport.sendToHost('guest',{type:'after'});
 for(const message of f.connections[1].messages)f.connections[2].emit({type:'ClientInvoke',clientId:'guest',functionId:1,payload:message.payload});
 await tick();assert.deepEqual(got,[['guest',{type:'after'}]]);
});

for(const role of ['host','client'])test(role+' manual retry during an automatic handshake does not duplicate sockets or backoff',async t=>{
 const f=fakeSDK(),base=await Bridge.createHost({url:'ws://localhost',roomId:'overlap',sdk:f.sdk}),invitation=await base.invite('guest');
 const session=role==='host'?base:await Bridge.createClient({invitation,sdk:f.sdk});if(role==='client')base.close();t.after(()=>session.close());t.mock.timers.enable({apis:['setTimeout']});
 let rejectHandshake,attempts=0;f.sdk.BridgeConnection.connect=async()=>{attempts++;return new Promise((_,reject)=>rejectHandshake=reject);};
 f.connections.at(-1).fail('ConnectionLost');await flush();t.mock.timers.tick(5000);await flush();
 const manual=session.reconnect();const rejected=assert.rejects(manual,{code:'ConnectionFailed'});rejectHandshake(new SDK.BridgeError('ConnectionFailed'));await rejected;await flush();
 assert.equal(attempts,1);t.mock.timers.tick(9999);await flush();assert.equal(attempts,1);t.mock.timers.tick(1);await flush();assert.equal(attempts,2);
});

test('restored host credentials recreate the same invitation and restore its authorized player list',async t=>{
 const f=fakeSDK(),first=await Bridge.createHost({url:'ws://localhost',roomId:'stable',sdk:f.sdk});
 const invite=await first.invite('guest'),credentials=first.credentials();first.close();
 const second=await Bridge.createHost({url:'ws://localhost',roomId:'stable',sdk:f.sdk,credentials,players:[invite]});t.after(()=>second.close());
 assert.equal(f.connections[1].hello.token,f.connections[0].hello.token);assert.equal(f.connections[1].hello.epoch,f.connections[0].hello.epoch);
 assert.deepEqual(await second.invite('guest'),invite);assert.deepEqual(f.connections[1].hello.players,[{id:'guest',token:invite.token}]);
 assert.deepEqual(Bridge.parseInvitation('http://localhost/client.html?join='+Bridge.encodeInvitation(invite)),invite);
});
test('invitation probing authenticates before returning and closes its temporary connection',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk});t.after(()=>host.close());const invitation=await host.invite('guest');
 const parsed=await Bridge.probeInvitation(Bridge.encodeInvitation(invitation),{sdk:f.sdk});assert.deepEqual(parsed,invitation);assert.equal(f.connections[1].isClosed,true);assert.equal(f.connections[1].listeners.size,0);
 const count=f.connections.length;await assert.rejects(Bridge.probeInvitation('invalid',{sdk:f.sdk}));assert.equal(f.connections.length,count);
 const rejected={...f.sdk,BridgeConnection:{connect:async()=>{throw new SDK.BridgeError('Unauthorized');}}};await assert.rejects(Bridge.probeInvitation(invitation,{sdk:rejected}),{code:'Unauthorized'});
});
test('invitations validate local-only plaintext endpoints and never carry host credentials',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://127.0.0.1:8080',roomId:'room',sdk:f.sdk});t.after(()=>host.close());
 const invitation=await host.invite('guest'),code=Bridge.encodeInvitation(invitation);
 assert.deepEqual(Bridge.parseInvitation('file:///C:/client.html#join='+code),invitation);assert.deepEqual(Bridge.parseInvitation(code),invitation);
 assert.ok(!JSON.stringify(invitation).includes(f.connections[0].hello.epoch));assert.ok(!JSON.stringify(invitation).includes(f.connections[0].hello.token));
 assert.equal(Bridge.validateServerUrl('wss://example.com'),'wss://example.com/');
 for(const url of ['ws://example.com','https://example.com','wss://user:pw@example.com','wss://example.com/?token=x','wss://example.com/base'])assert.throws(()=>Bridge.validateServerUrl(url));
 await assert.rejects(host.invite('host'));await host.revoke('guest');assert.deepEqual(f.connections[0].messages.at(-1).players,[]);
});
test('large Unicode packets are fragmented below 64KiB and reassembled with envelope identity',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost:8080',roomId:'room',sdk:f.sdk});t.after(()=>host.close());const invitation=await host.invite('guest');
 const client=await Bridge.createClient({invitation,sdk:f.sdk});t.after(()=>client.close());const own=f.connections[1],server=f.connections[0],got=[];
 client.transport.onClient('guest',async packet=>got.push(packet));const large={type:'snapshot',text:'甲🌙'.repeat(60000)};
 await host.transport.sendToClient('guest',large);const frames=server.messages.filter(m=>m.type==='InvokeClient');assert.ok(frames.length>2);
 for(const frame of frames){assert.ok(Buffer.byteLength(JSON.stringify(frame.payload))<=65536);own.emit({type:'Invoke',functionId:2,payload:frame.payload});}await tick();assert.deepEqual(got,[large]);
 const commands=[];host.transport.onHost((member,packet)=>commands.push({member,packet}));await client.transport.sendToHost('guest',{type:'action.submit',memberId:'host',payload:{content:'hi'}});
 for(const frame of own.messages)server.emit({type:'ClientInvoke',clientId:'guest',functionId:1,payload:frame.payload});await tick();assert.equal(commands[0].member,'guest');
 await assert.rejects(client.transport.sendToHost('host',{type:'action.submit'}));
});
test('initial SDK inbox and pre-listener packets are delivered once in async arrival order',async t=>{
 const f=fakeSDK();f.setInitial([{type:'ClientJoined',clientId:'guest'},{type:'ClientLeft',clientId:'guest'}]);const members=[],host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk,onMember:async event=>{await tick();members.push(event.type);}});t.after(()=>host.close());
 const invitation=await host.invite('guest'),client=await Bridge.createClient({invitation,sdk:f.sdk});t.after(()=>client.close());await client.transport.sendToHost('guest',{type:'first'});await client.transport.sendToHost('guest',{type:'second'});
 for(const frame of f.connections[1].messages)f.connections[0].emit({type:'ClientInvoke',clientId:'guest',functionId:1,payload:frame.payload});await new Promise(r=>setTimeout(r,70));
 const got=[];host.transport.onHost(async(id,packet)=>{await tick();got.push(packet.type);});await new Promise(r=>setTimeout(r,70));assert.deepEqual(members,['joined','left']);assert.deepEqual(got,['first','second']);
});
test('out-of-order and cross-identity fragments never produce a partial command',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk});t.after(()=>host.close());const invitation=await host.invite('guest'),client=await Bridge.createClient({invitation,sdk:f.sdk});t.after(()=>client.close());const got=[];host.transport.onHost((id,message)=>got.push(message));
 await client.transport.sendToHost('guest',{type:'action.submit',text:'x'.repeat(100000)});const frames=f.connections[1].messages;
 for(const frame of [...frames].reverse())f.connections[0].emit({type:'ClientInvoke',clientId:'guest',functionId:1,payload:frame.payload});await tick();assert.deepEqual(got,[]);
 f.connections[0].emit({type:'ClientInvoke',clientId:'host',functionId:1,payload:frames[0].payload});await tick();assert.deepEqual(got,[]);
 await assert.rejects(client.transport.sendToHost('guest',{text:'x'.repeat(2*1024*1024)}));
});
test('transient disconnect reconnects the same transport without replaying business data; revocation stops retries',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk});t.after(()=>host.close());const invitation=await host.invite('guest'),states=[];
 const client=await Bridge.createClient({invitation,sdk:f.sdk,reconnectDelays:[1,2],onState:s=>states.push(s.status)});t.after(()=>client.close());const transport=client.transport;
 await transport.sendToHost('guest',{type:'once'});f.connections[1].fail('ConnectionLost');await new Promise(r=>setTimeout(r,50));
 assert.equal(f.connections.length,3);assert.equal(client.transport,transport);assert.deepEqual(f.connections[2].messages,[]);assert.ok(states.includes('reconnecting'));
 f.connections[2].fail('AuthorizationRevoked');await new Promise(r=>setTimeout(r,30));assert.equal(f.connections.length,3);assert.equal(states.at(-1),'closed');await assert.rejects(transport.sendToHost('guest',{type:'later'}));
});
test('manual reconnect waits for old close, preserves listeners, and permanent close cancels retry',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk});t.after(()=>host.close());const invitation=await host.invite('guest'),states=[];
 const client=await Bridge.createClient({invitation,sdk:f.sdk,reconnectDelays:[100],onState:s=>states.push(s.status)});t.after(()=>client.close());const got=[];client.transport.onClient('guest',message=>got.push(message));
 const old=f.connections[1];await client.reconnect();assert.equal(old.isClosed,true);assert.equal(f.connections.length,3);assert.deepEqual(states.slice(-2),['reconnecting','connected']);
 await host.transport.sendToClient('guest',{type:'after-reconnect'});for(const frame of f.connections[0].messages.filter(m=>m.type==='InvokeClient'))f.connections[2].emit({type:'Invoke',functionId:2,payload:frame.payload});await tick();assert.deepEqual(got,[{type:'after-reconnect'}]);
 f.connections[2].fail('ConnectionLost');client.close();assert.equal(client.closed,true);await new Promise(r=>setTimeout(r,130));assert.equal(f.connections.length,3);await assert.rejects(client.reconnect());
});
test('concurrent invitation changes serialize expected revisions and revoking one member retains the others',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk});t.after(()=>host.close());
 const [a,b]=await Promise.all([host.invite('a'),host.invite('b')]);assert.notEqual(a.token,b.token);assert.deepEqual(f.connections[0].messages.map(m=>m.expectedRevision),[0,1]);
 const original=await host.invite('a');assert.equal(original.token,a.token);assert.equal(f.connections[0].messages.length,2);await host.revoke('a');assert.deepEqual(f.connections[0].messages.at(-1).players,[{id:'b',token:b.token}]);
});
test('contract hash follows original SDK wire schema and fragmented streams cannot borrow another member prefix',async t=>{
 const crypto=require('node:crypto'),expected=crypto.createHash('sha256').update(JSON.stringify([['host',1,'book-agent.command-fragment:v1',65536],['client',2,'book-agent.view-fragment:v1',65536]])).digest('hex');assert.equal(await SDK.contractHash(Bridge.MANIFEST),expected);
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk});t.after(()=>host.close());const invitation=await host.invite('a');await host.invite('b');const client=await Bridge.createClient({invitation,sdk:f.sdk});t.after(()=>client.close());const got=[];host.transport.onHost((id,message)=>got.push([id,message]));
 await client.transport.sendToHost('a',{type:'long',text:'x'.repeat(80000)});const frames=f.connections[1].messages;
 f.connections[0].emit({type:'ClientInvoke',clientId:'a',functionId:1,payload:frames[0].payload});f.connections[0].emit({type:'ClientInvoke',clientId:'b',functionId:1,payload:frames[1].payload});await tick();assert.deepEqual(got,[]);
 f.connections[0].emit({type:'ClientInvoke',clientId:'a',functionId:1,payload:frames[1].payload});await tick();assert.equal(got[0][0],'a');
});
test('unknown authorization outcome closes the room instead of reusing a possibly revoked token',async t=>{
 const f=fakeSDK(),states=[],host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk,onState:s=>states.push(s)});t.after(()=>host.close());await host.invite('a');
 f.connections[0].request=async()=>{throw new SDK.BridgeError('RequestTimeout',{fatal:false});};await assert.rejects(host.revoke('a'),{code:'RequestTimeout'});
 assert.equal(host.closed,true);assert.equal(f.connections[0].isClosed,true);await assert.rejects(host.invite('a'));
 assert.equal(states.at(-1).code,'RequestTimeout');assert.match(states.at(-1).message,/重新开房/);
});
test('closing while authorization acknowledgement is pending cannot return an invitation',async t=>{
 const f=fakeSDK(),host=await Bridge.createHost({url:'ws://localhost',roomId:'room',sdk:f.sdk});t.after(()=>host.close());let acknowledge;
 f.connections[0].request=()=>new Promise(resolve=>{acknowledge=resolve;});const issued=host.invite('a');await tick();host.close();acknowledge({revision:1});await assert.rejects(issued,{code:'ClientClosed'});
});
