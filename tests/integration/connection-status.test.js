const {test}=require('node:test'),assert=require('node:assert/strict');
const Status=require('../../src/connection-status');
test('offline pages are purple without treating deliberate offline play as an error',()=>{
  for(const client of [false,true]){const s=Status.describe({client});assert.equal(s.color,'purple');assert.equal(s.abnormal,false);}
});
test('ready host and bound client are green, initial synchronization and retries are yellow',()=>{
  assert.equal(Status.describe({room:{online:true},network:{status:'connected'}}).color,'green');
  assert.equal(Status.describe({client:true,room:{online:true},network:{status:'connected'}}).color,'green');
  for(const status of ['connecting','reconnecting'])assert.equal(Status.describe({network:{status}}).color,'yellow');
  assert.equal(Status.describe({client:true,network:{status:'connected'}}).color,'yellow');
});

test('connected lamp reflects collecting, submitted and thinking states without reporting a connection fault',()=>{
 const state={client:true,network:{status:'connected'},room:{online:true,status:'collecting',submitted:false,collection:{total:3,submitted:1,remaining:2}}};
 let info=Status.describe(state);assert.equal(info.color,'green');assert.equal(info.turnState,'waiting');assert.match(info.message,/还差 2 人/);assert.equal(info.abnormal,false);
 state.room.submitted=true;info=Status.describe(state);assert.equal(info.turnState,'submitted');assert.match(info.message,/已提交/);
 state.room.status='executing';info=Status.describe(state);assert.equal(info.turnState,'thinking');assert.match(info.message,/AI/);
});
test('transport failures are red; missing host, revoked invitations and protocol failures are purple',()=>{
  for(const code of ['ConnectionLost','ConnectFailed','HandshakeTimeout'])assert.equal(Status.describe({network:{status:'closed',code}}).color,'red');
  for(const code of ['HostDisconnected','RoomNotFound','Unauthorized','ContractMismatch'])assert.equal(Status.describe({network:{status:'disconnected',code}}).color,'purple');
  assert.equal(Status.describe({network:{status:'disconnected',message:'Failed to fetch'}}).color,'red');
});
test('failed operational notification is temporary while the persistent status remains accurate',()=>{
  const now={room:{online:true},network:{status:'connected'}};
  const bad=Status.describe(now,{message:'邀请已失效'});assert.equal(bad.color,'purple');assert.equal(bad.abnormal,true);
  assert.equal(Status.describe(now).color,'green');
});
