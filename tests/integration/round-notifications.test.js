'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Notices=require('../../src/round-notifications');
function state(round=0,extra={}){return {settings:{roundNotifications:true},active:{id:'save',round,status:'waiting'},room:{epoch:0,status:'collecting'},running:false,...extra};}
test('notify only after a newly completed round, once, without replay on opening or enabling',()=>{
 const sent=[],n=Notices.create({send:x=>sent.push(x)});let s=state(4);n.update(s);assert.equal(sent.length,0);
 s=state(5,{running:true});n.update(s);assert.equal(sent.length,0);s.running=false;n.update(s);n.update(s);assert.equal(sent.length,1);assert.equal(sent[0].round,5);
 s=state(6,{settings:{roundNotifications:false}});n.update(s);s.settings.roundNotifications=true;n.update(s);assert.equal(sent.length,1);
 n.update(state(7));assert.equal(sent.length,2);
 n.update(state(7,{active:{id:'another-save',round:40,status:'waiting'}}));assert.equal(sent.length,2);
});
test('client reconnect, rollback, view changes and interrupted rounds do not announce old completions',()=>{
 const sent=[],n=Notices.create({send:x=>sent.push(x)});
 n.update(state(1,{client:true,network:{status:'connected'}}));
 n.update(state(1,{client:true,network:{status:'reconnecting'}}));
 n.update(state(3,{client:true,network:{status:'connected'}}));assert.equal(sent.length,0);
 n.update(state(4,{client:true,network:{status:'connected'}}));assert.equal(sent.length,1);
 n.update(state(2,{room:{epoch:1,status:'collecting'}}));assert.equal(sent.length,1);
 n.update(state(3,{active:{id:'save',round:3,status:'interrupted'},room:{epoch:1,status:'interrupted'}}));assert.equal(sent.length,1);
 n.update(state(3,{room:{epoch:1,status:'collecting'}}));assert.equal(sent.length,2);
 n.update(state(9,{room:{epoch:1,bindingVersion:2,status:'collecting'}}));assert.equal(sent.length,2);
});
test('permission is requested explicitly and denied permission never becomes enabled',async()=>{
 let prompts=0;const env={isSecureContext:true,Notification:{permission:'default',requestPermission:async()=>{prompts++;return 'denied';}}};
 assert.equal(prompts,0);assert.equal((await Notices.requestPermission(env)).enabled,false);assert.equal(prompts,1);
 env.Notification.permission='granted';assert.equal((await Notices.requestPermission(env)).enabled,true);assert.equal(prompts,1);
 assert.equal((await Notices.requestPermission({isSecureContext:false})).enabled,false);
});
test('notification failure is isolated and content contains no story or credentials',async()=>{
 const sent=[],env={isSecureContext:true,location:{href:'https://example.test/client.html#secret-key'},focus(){},console:{warn(){}},Notification:class{static permission='granted';constructor(title,options){sent.push({title,options});}}};
 assert.equal(await Notices.send({round:2,tag:'round-2'},env),true);assert.equal(sent.length,1);
 assert.ok(!JSON.stringify(sent).includes('secret-key'));
 env.Notification=class{static permission='granted';constructor(){throw Error('unavailable');}};
 assert.equal(await Notices.send({round:3,tag:'round-3'},env),false);
});
test('mobile fallback uses the bundled worker and strips the invitation from notification data',async()=>{
 const sent=[],registered=[],env={Notification:class{static permission='granted';constructor(){throw TypeError('use service worker');}},location:{href:'https://example.test/game/client.html?debug=1#invite-secret'},navigator:{serviceWorker:{register:async url=>{registered.push(url);return {active:{},showNotification:async(title,options)=>sent.push(options)};}}}};
 assert.equal(await Notices.send({round:3,tag:'r3'},env),true);
 assert.deepEqual(registered,['https://example.test/game/notification-sw.js']);
 assert.equal(sent[0].data.url,'https://example.test/game/client.html');
});
test('network connected event before a fresh snapshot does not replay a missed round',()=>{
 const sent=[],n=Notices.create({send:x=>sent.push(x)}),s=state(1,{client:true,network:{status:'connected'}});
 n.update(s);s.network.status='reconnecting';n.update(s);s.network.status='connected';n.update(s);
 s.active={...s.active,round:4};n.update(s);assert.equal(sent.length,0);
 s.active={...s.active,round:5};n.update(s);assert.equal(sent.length,1);
});
