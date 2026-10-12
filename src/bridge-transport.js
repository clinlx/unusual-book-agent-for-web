'use strict';
const BridgeTransport=(()=>{
  const SDK=typeof module!=='undefined'&&module.exports?require('../vendor/room-bridge.js'):RoomBridgeSDK;
  const Recovery=typeof module!=='undefined'&&module.exports?require('./connection-recovery.js'):ConnectionRecovery;
  const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
  const CHUNK_BYTES=45000,FRAME_BYTES=65536,COMMAND_BYTES=2*1024*1024,VIEW_BYTES=32*1024*1024;
  const RECONNECT_DELAYS=[5000,10000,20000,40000,80000,120000];
  const retryable=(cause,host=false)=>cause?.retryable===true||(host?['RoomExists']:['AlreadyConnected','HostDisconnected','HostUnavailable','RoomNotFound']).includes(cause?.code);
  const MANIFEST=Object.freeze({hostFunctions:Object.freeze([Object.freeze({id:1,schema:'book-agent.command-fragment:v1',maxPayloadBytes:FRAME_BYTES})]),clientFunctions:Object.freeze([Object.freeze({id:2,schema:'book-agent.view-fragment:v1',maxPayloadBytes:FRAME_BYTES})])});
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
  const member=value=>validId(value)&&!['host','server'].includes(value.toLowerCase());
  const error=(code='InvalidConfiguration')=>new SDK.BridgeError(code,{fatal:false});
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function encode(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
  function decode(value){if(typeof value!=='string'||!value||!/^[A-Za-z0-9_-]+$/.test(value))throw error();const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));if(encode(bytes)!==value)throw error();return bytes;}
  function validateServerUrl(value){
    let url;try{url=new URL(value);}catch(_){throw error();}
    if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw error();
    if(url.protocol==='ws:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw error();
    url.pathname='/';return url.href;
  }
  function invitation(value){
    if(!object(value)||value.version!==1||!validId(value.roomId)||!member(value.memberId)||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value.token))throw error();
    for(const piece of value.token.split('.'))if(decode(piece).length!==32)throw error();
    return {version:1,url:validateServerUrl(value.url),roomId:value.roomId,memberId:value.memberId,token:value.token};
  }
  function encodeInvitation(value){return encode(encoder.encode(JSON.stringify(invitation(value))));}
  function invitationParameter(value){const url=new URL(value),hash=new URLSearchParams(url.hash.slice(1));return hash.has('join')?hash.get('join'):url.searchParams.get('join');}
  function parseInvitation(value){
    if(object(value))return invitation(value);
    if(typeof value!=='string'||value.length>8192)throw error();let code=value.trim();
    if(code.includes('#')||code.includes('?'))try{code=invitationParameter(code)||'';}catch(_){throw error();}
    try{return invitation(JSON.parse(decoder.decode(decode(code))));}catch(_){throw error();}
  }
  function serialize(packet,limit){if(!object(packet))throw error('InvalidMessage');const bytes=encoder.encode(JSON.stringify(packet));if(bytes.length>limit)throw error('PayloadTooLarge');return bytes;}
  function createFragments(limit){
    const partial=new Map();let totalBytes=0;
    function remove(key){const old=partial.get(key);if(old)totalBytes-=old.size;partial.delete(key);}
    function prune(){const now=Date.now();for(const [key,value]of partial)if(now-value.at>30000)remove(key);}
    return {clear(){partial.clear();totalBytes=0;},accept(identity,fragment){
      prune();if(!object(fragment)||!validId(fragment.id))throw error('InvalidMessage');const key=identity+':'+fragment.id;
      try{
        if(!Number.isSafeInteger(fragment.index)||!Number.isSafeInteger(fragment.total)||fragment.index<0||fragment.total<1||fragment.index>=fragment.total||fragment.total>Math.ceil(limit/CHUNK_BYTES)||!Number.isSafeInteger(fragment.bytes)||fragment.bytes<2||fragment.bytes>limit||encoder.encode(JSON.stringify(fragment)).length>FRAME_BYTES)throw error('PayloadTooLarge');
        const bytes=decode(fragment.data);if(bytes.length>CHUNK_BYTES)throw error('PayloadTooLarge');
        if(fragment.index===0){if(partial.has(key)||partial.size>=32)throw error('Backpressure');partial.set(key,{parts:[],size:0,total:fragment.total,bytes:fragment.bytes,at:Date.now()});}
        const record=partial.get(key);if(!record||record.parts.length!==fragment.index||record.total!==fragment.total||record.bytes!==fragment.bytes||record.size+bytes.length>record.bytes||totalBytes+bytes.length>VIEW_BYTES)throw error('InvalidMessage');
        record.parts.push(bytes);record.size+=bytes.length;totalBytes+=bytes.length;
        if(record.parts.length!==record.total)return null;
        if(record.size!==record.bytes)throw error('InvalidMessage');
        const joined=new Uint8Array(record.size);let offset=0;for(const part of record.parts){joined.set(part,offset);offset+=part.length;}remove(key);
        const packet=JSON.parse(decoder.decode(joined));if(!object(packet))throw error('InvalidMessage');return {packet,size:joined.length};
      }catch(cause){remove(key);throw cause;}
    }};
  }
  function deliveries(limit,allowed=()=>true){
    const listeners=new Set(),queue=[];let queuedBytes=0,chain=Promise.resolve(),closed=false;
    function drain(){if(closed||!listeners.size)return chain;chain=chain.then(async()=>{while(!closed&&listeners.size&&queue.length){const next=queue.shift();queuedBytes-=next.size;if(!allowed(next.identity))continue;for(const listener of [...listeners])await listener(next.identity,next.packet);}}).catch(()=>{});return chain;}
    return {add(fn){listeners.add(fn);drain();return()=>listeners.delete(fn);},put(identity,packet,size){if(closed)return;if(queue.length>=256||queuedBytes+size>limit)throw error('Backpressure');queue.push({identity,packet,size});queuedBytes+=size;return drain();},clear(){queue.length=0;queuedBytes=0;},close(){closed=true;queue.length=0;queuedBytes=0;listeners.clear();}};
  }
  function sender(getConnection,limit,invoke){
    let chain=Promise.resolve(),pendingBytes=0,lastSend=0;
    return function send(identity,packet){
      let bytes;try{bytes=serialize(packet,limit);}catch(cause){return Promise.reject(cause);}
      const expected=getConnection();if(!expected)return Promise.reject(error('ConnectionLost'));
      if(pendingBytes+bytes.length>VIEW_BYTES*2)return Promise.reject(error('Backpressure'));pendingBytes+=bytes.length;
      const operation=chain.then(async()=>{
        const id=crypto.randomUUID(),total=Math.ceil(bytes.length/CHUNK_BYTES);
        for(let index=0;index<total;index++){
          if(getConnection()!==expected)throw error('ConnectionLost');
          const fragment={id,index,total,bytes:bytes.length,data:encode(bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES))};
          const wait=lastSend+Math.max(3,Math.ceil(encoder.encode(JSON.stringify(fragment)).length/(4*1024*1024)*1000))-Date.now();if(wait>0)await sleep(wait);
          if(getConnection()!==expected)throw error('ConnectionLost');
          await invoke(expected,identity,fragment);lastSend=Date.now();
        }
      }).finally(()=>{pendingBytes-=bytes.length;});chain=operation.catch(()=>{});return operation;
    };
  }
  function attach(connection,handler,report){
    let chain=Promise.resolve(),queued=0,queuedBytes=0;const enqueue=message=>{
      const size=encoder.encode(JSON.stringify(message)).length;
      if(queued>=512||queuedBytes+size>8*1024*1024){report?.({event:'transport.receive-overflow',connectionId:connection.connectionId,queued,queuedBytes,incomingBytes:size});connection.close();return;}
      queued++;queuedBytes+=size;
      chain=chain.then(()=>handler(message)).catch(cause=>report?.({event:'transport.handler-failed',connectionId:connection.connectionId,error:SDK.diagnosticError(cause)})).finally(()=>{queued--;queuedBytes-=size;});
    };
    const stop=connection.onMessage(enqueue);for(const message of connection.inbox.splice(0))enqueue(message);return stop;
  }
  function notice(callback,status,cause,extra={}){if(!callback)return;const message=cause?.message||({connected:'已连接房间',reconnecting:'正在重新连接',disconnected:'连接已断开',closed:'房间连接已关闭'}[status]);try{Promise.resolve(callback({status,message,...cause?.code?{code:cause.code}:{},...extra})).catch(()=>{});}catch(_){}}
  function reporter(role,url,roomId,logger){
    const sessionId=crypto.randomUUID();
    return record=>{try{const method=['connection.ready','reconnect.start','page.recovery'].includes(record.event)?'info':'warn';logger?.[method]?.('[BookAgent WS]',{sessionId,role,endpoint:url,timestamp:new Date().toISOString(),roomId,...record});}catch(_){}};
  }
  async function waitForClose(connection,bounded,report){
    if(!bounded)return connection.closed;
    let timer;
    try{await Promise.race([connection.closed,new Promise(resolve=>{timer=setTimeout(()=>{report({event:'websocket.close-wait-timeout',connectionId:connection.connectionId,waitMs:1000});resolve();},1000);})]);}
    finally{clearTimeout(timer);}
  }
  async function createHost({url,roomId,title='',onMember,onState,sdk=SDK,credentials:saved,players:authorized=[],reconnectDelays=RECONNECT_DELAYS,environment=globalThis,logger=console}={}){
    url=validateServerUrl(url);if(!validId(roomId))throw error();
    const report=reporter('host',url,roomId,logger);
    const token=saved?.token??sdk.randomToken(),epoch=saved?.epoch??sdk.randomToken(),players=new Map(),fragments=createFragments(COMMAND_BYTES),incoming=deliveries(VIEW_BYTES,id=>players.has(id));
    if(decode(token).length!==32||decode(epoch).length!==32||!Array.isArray(authorized)||authorized.length>64)throw error();
    for(const value of authorized){const item=invitation(value);if(item.url!==url||item.roomId!==roomId||players.has(item.memberId))throw error();players.set(item.memberId,item.token);}
    let closed=false,revision=0,authorization=Promise.resolve(),connection=null,detach,retryTimer=null,attempt=0,opening=null,reconnecting=null,closing=Promise.resolve(),stopRecovery=()=>{};
    function retry(cause){
      if(closed)return;if(!retryable(cause,true)){close(cause);return;}
      notice(onState,'reconnecting',cause,{backgroundRetry:true});clearTimeout(retryTimer);
      const delay=reconnectDelays[Math.min(attempt++,reconnectDelays.length-1)]??120000;
      report({event:'reconnect.scheduled',retryAttempt:attempt,retryDelayMs:delay,error:SDK.diagnosticError(cause)});
      retryTimer=setTimeout(()=>{retryTimer=null;open().catch(retry);},Math.max(1,delay));
    }
    async function open(){
      if(closed)throw error('ClientClosed');if(opening)return opening;
      opening=(async()=>{
        report({event:'reconnect.start',retryAttempt:attempt});
        const current=await sdk.BridgeConnection.connect(url,'server',roomId,{token,epoch,version:'book-agent-v1',buildHash:'book-agent-fragments-v1',info:{title:String(title).slice(0,256)},manifest:MANIFEST,players:[...players].map(([id,token])=>({id,token}))},{maxBufferedBytes:8*1024*1024,maxQueueMessages:512,onDiagnostic:report});
        if(closed){current.close();throw error('ClientClosed');}
        connection=current;revision=current.ready.revision||0;attempt=0;fragments.clear();
        detach=attach(current,async message=>{
          if(closed||connection!==current)return;
          if(['ClientJoined','ClientLeft'].includes(message.type)){if(member(message.clientId))await onMember?.({type:message.type==='ClientJoined'?'joined':'left',memberId:message.clientId});return;}
          if(message.type!=='ClientInvoke'||message.functionId!==1||!member(message.clientId)||!players.has(message.clientId))return;
          const complete=fragments.accept(message.clientId,message.payload);if(complete)await incoming.put(message.clientId,complete.packet,complete.size);
        },report);
        current.closed.then(({error:cause}={})=>{if(closed||connection!==current)return;connection=null;detach?.();fragments.clear();incoming.clear();retry(cause||error('ConnectionLost'));});
        report({event:'connection.ready',connectionId:current.connectionId});notice(onState,'connected');return current;
      })();try{return await opening;}finally{opening=null;}
    }
    const send=sender(()=>closed?null:connection,VIEW_BYTES,(c,id,fragment)=>c.invokeClient(id,2,fragment));
    const transport={onHost:fn=>incoming.add(fn),sendToClient:(id,packet)=>players.has(id)&&member(id)?send(id,packet):Promise.reject(error('Unauthorized'))};
    function close(cause){if(closed)return closing;closed=true;stopRecovery();clearTimeout(retryTimer);retryTimer=null;const old=connection;connection=null;detach?.();incoming.close();fragments.clear();old?.close();closing=old?.closed||Promise.resolve();if(cause)report({event:'connection.stopped',error:SDK.diagnosticError(cause)});notice(onState,'closed',cause);return closing;}
    function reconnect({resetBackoff=false,background=false}={}){
      if(resetBackoff)attempt=0;
      if(closed)return Promise.reject(error('ClientClosed'));if(reconnecting)return reconnecting;if(opening)return opening;clearTimeout(retryTimer);retryTimer=null;
      reconnecting=(async()=>{notice(onState,'reconnecting',null,background?{backgroundRetry:true}:{});const old=connection;connection=null;detach?.();fragments.clear();incoming.clear();if(old){old.close();await waitForClose(old,resetBackoff,report);}return open();})().catch(cause=>{retry(cause);throw cause;}).finally(()=>{reconnecting=null;});return reconnecting;
    }
    function change(id,remove){
      const operation=authorization.then(async()=>{
        if(closed)throw error('ClientClosed');if(!connection)throw error('ConnectionLost');if(!member(id))throw error();
        if(remove&&!players.has(id))return;
        if(!remove&&players.has(id))return invitation({version:1,url,roomId,memberId:id,token:players.get(id)});
        const next=new Map(players);if(remove)next.delete(id);else next.set(id,await sdk.issueClientToken(token,roomId,epoch,id));
        if(closed)throw error('ClientClosed');
        let ack;
        const current=connection;if(!current)throw error('ConnectionLost');
        try{ack=await current.request({type:'ReplaceAuthorization',expectedRevision:revision,players:[...next].map(([id,token])=>({id,token}))},'AuthorizationReplaced');}
        catch(cause){if(['RequestTimeout','RevisionConflict'].includes(cause?.code)||retryable(cause,true))close({code:cause.code,message:'无法确认玩家授权是否更新。请关闭房间后重新开房，再开放槽位。'});throw cause;}
        if(closed)throw error('ClientClosed');if(connection!==current){close();throw error('ConnectionLost');}
        revision=ack.revision;players.clear();for(const [id,token]of next)players.set(id,token);
        if(!remove)return invitation({version:1,url,roomId,memberId:id,token:players.get(id)});
      });authorization=operation.catch(()=>{});return operation;
    }
    try{await open();}catch(cause){close(cause);notice(onState,'disconnected',cause);throw cause;}
    stopRecovery=Recovery.watch({environment,onDiagnostic:report,onRecover:()=>reconnect({resetBackoff:true,background:true})});
    return {transport,roomId,credentials:()=>({token,epoch}),invite:id=>change(id,false),revoke:id=>change(id,true),reconnect,close,get closed(){return closed;},get connected(){return !!connection&&!closed;}};
  }
  async function createClient({invitation:value,onState,sdk=SDK,reconnectDelays=RECONNECT_DELAYS,environment=globalThis,logger=console}={}){
    const invite=parseInvitation(value),fragments=createFragments(VIEW_BYTES),incoming=deliveries(VIEW_BYTES);let connection=null,detach=null,closed=false,retryTimer=null,attempt=0,opening=null,closing=Promise.resolve();
    const report=reporter('client',invite.url,invite.roomId,logger);let stopRecovery=()=>{};
    const hash=await sdk.contractHash(MANIFEST);
    function stop(cause){if(closed)return closing;closed=true;stopRecovery();clearTimeout(retryTimer);retryTimer=null;const old=connection;connection=null;detach?.();incoming.close();fragments.clear();old?.close();closing=old?.closed||Promise.resolve();if(cause)report({event:'connection.stopped',error:SDK.diagnosticError(cause)});notice(onState,'closed',cause);return closing;}
    function retry(cause){
      if(closed)return;if(!retryable(cause)){stop(cause);return;}
      notice(onState,'reconnecting',cause,{backgroundRetry:true});clearTimeout(retryTimer);
      const delay=reconnectDelays[Math.min(attempt++,reconnectDelays.length-1)]??120000;
      report({event:'reconnect.scheduled',retryAttempt:attempt,retryDelayMs:delay,error:SDK.diagnosticError(cause)});
      retryTimer=setTimeout(()=>{retryTimer=null;open().catch(retry);},Math.max(1,delay));
    }
    async function open(){
      if(closed)throw error('ClientClosed');if(opening)return opening;
      opening=(async()=>{
        report({event:'reconnect.start',retryAttempt:attempt});
        const current=await sdk.BridgeConnection.connect(invite.url,'client',invite.roomId,{token:invite.token,contractHash:hash},{maxBufferedBytes:8*1024*1024,maxQueueMessages:512,onDiagnostic:report});
        if(closed){current.close();throw error('ClientClosed');}
        connection=current;attempt=0;fragments.clear();
        detach=attach(current,async message=>{
          if(closed||connection!==current||message.type!=='Invoke'||message.functionId!==2)return;
          const complete=fragments.accept(invite.memberId,message.payload);if(complete)await incoming.put(invite.memberId,complete.packet,complete.size);
        },report);
        current.closed.then(({error:cause}={})=>{if(closed||connection!==current)return;connection=null;detach?.();fragments.clear();retry(cause||error('ConnectionLost'));});
        report({event:'connection.ready',connectionId:current.connectionId});notice(onState,'connected');return current;
      })();try{return await opening;}finally{opening=null;}
    }
    const send=sender(()=>closed?null:connection,COMMAND_BYTES,(c,id,fragment)=>c.invoke(1,fragment));
    const transport={onClient(id,fn){if(id!==invite.memberId)throw error('Unauthorized');return incoming.add((_,packet)=>fn(packet));},sendToHost:(id,packet)=>id===invite.memberId?send(id,packet):Promise.reject(error('IdentitySpoof'))};
    let reconnecting=null;
    function reconnect({resetBackoff=false,background=false}={}){
      if(resetBackoff)attempt=0;
      if(closed)return Promise.reject(error('ClientClosed'));if(reconnecting)return reconnecting;if(opening)return opening;clearTimeout(retryTimer);retryTimer=null;
      reconnecting=(async()=>{notice(onState,'reconnecting',null,background?{backgroundRetry:true}:{});const old=connection;connection=null;detach?.();fragments.clear();if(old){old.close();await waitForClose(old,resetBackoff,report);}return open();})().catch(cause=>{retry(cause);throw cause;}).finally(()=>{reconnecting=null;});return reconnecting;
    }
    try{await open();}catch(cause){stop(cause);throw cause;}
    stopRecovery=Recovery.watch({environment,onDiagnostic:report,onRecover:()=>reconnect({resetBackoff:true,background:true})});
    return {transport,memberId:invite.memberId,reconnect,close:()=>stop(),get closed(){return closed;},get connected(){return !!connection&&!closed;}};
  }
  async function probeInvitation(value,options={}){
    const invite=parseInvitation(value),session=await createClient({...options,invitation:invite});
    await session.close();return invite;
  }
  return {MANIFEST,validateServerUrl,encodeInvitation,parseInvitation,invitationParameter,probeInvitation,createHost,createClient};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=BridgeTransport;
