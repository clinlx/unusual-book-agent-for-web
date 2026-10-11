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
